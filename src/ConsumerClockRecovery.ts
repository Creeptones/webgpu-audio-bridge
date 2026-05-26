/**
 * ConsumerClockRecovery — extracted PLL heap state machine (0.6.9).
 *
 * This file is **internal-only** as of 0.6.9. It is not exported from
 * `src/index.ts`; only `Bridge.ts` consumes it. The 0.6.10 patch will widen
 * the surface and promote `ConsumerClockRecovery` (alongside `SpscRing` /
 * `FrameSmoother` / `AdaptiveFlowController`) to the public composable API.
 * This patch is a seam-only step — every public Bridge<S> method continues
 * to work bit-identically and no exported symbol is added.
 *
 * What it does. Tracks the offset between two clocks the consumer sees:
 *   - the producer's `tMacroNs` (the timestamp the producer writes into
 *     each frame), and
 *   - the consumer's wall-clock at the moment a frame is observed
 *     (typically `AudioContext.currentTime * 1e9`).
 *
 * Same PI controller shape as the ring's flow-scale controller, tuned for
 * the offset signal. The first `observe(consumerNs, producerNs)` call
 * seeds the offset exactly (`offsetNs = producerNs − consumerNs`) and
 * flips `locked=true`; subsequent calls run one PI cycle each:
 *
 *     residual = (producerNs − consumerNs) − offsetNs
 *     integral = clamp(integral + residual, ±PLL_INT_LIMIT_NS)
 *     offsetNs += PLL_KP · residual + PLL_KI · integral
 *
 * `phaseLockedTime(consumerNs)` then returns `consumerNs + offsetNs` once
 * locked, else `consumerNs` unchanged.
 *
 * Convergence: with `PLL_KP = 0.2`, a fresh constant offset converges to
 * within 1 μs in ~30 observations. With `PLL_KI = 0.01`, a constant drift
 * (e.g. 50 ppm) settles within a few seconds.
 *
 * Anti-windup: `integral` is clamped to ±`PLL_INT_LIMIT_NS` (1 ms in
 * residual units).
 *
 * Heap-only — the PLL never touches the SAB. Lanes 4–7 of the ring header
 * remain reserved; cross-process PLL observability is a follow-up. Bridge
 * exposes `pllLocked` / `pllOffsetNs` in `telemetry()` from heap state via
 * this class's getters.
 *
 * See Bridge.ts file header "Phase-locked loop" for the caller-side
 * contract and the lineage notes.
 */

// PLL controller gains. See file header for the derivation; same anti-
// windup shape as the ring's flow-scale controller but tuned for the
// offset signal.
const PLL_KP = 0.2;
const PLL_KI = 0.01;
// Anti-windup: cap |integral| at 1 ms (= 1e6 ns) in residual-units.
const PLL_INT_LIMIT_NS = 1e6;

/**
 * ConsumerClockRecovery — consumer-side PLL tracking producer↔consumer
 * clock offset. Internal as of 0.6.9 — not exported from index.ts.
 */
export class ConsumerClockRecovery {
  private _offsetNs: number = 0;
  private _integral: number = 0;
  private _locked: boolean = false;

  /** Proportional gain (frozen for the lifetime of the instance). */
  static readonly KP = PLL_KP;
  /** Integral gain. */
  static readonly KI = PLL_KI;
  /** Anti-windup bound on |integral| (ns in residual units). */
  static readonly INT_LIMIT_NS = PLL_INT_LIMIT_NS;

  /**
   * Run one PI observation. Pair the producer-stamped timestamp from a
   * recently-pulled frame (`producerNs`) with the consumer's wall-clock at
   * the moment that frame was pulled / evaluated (`consumerNs`).
   *
   * The first call seeds the offset estimate exactly (`offsetNs =
   * producerNs − consumerNs`) and flips `locked=true`. Subsequent calls run
   * one PI cycle.
   *
   * Cost: ~5 arithmetic ops + 2 compares. Allocation-free. Safe to call
   * from an AudioWorklet's `process()` loop.
   */
  observe(consumerNs: number, producerNs: number): void {
    if (!Number.isFinite(consumerNs) || !Number.isFinite(producerNs)) {
      throw new Error(
        `ConsumerClockRecovery.observe: arguments must be finite (consumerNs=${consumerNs}, producerNs=${producerNs})`,
      );
    }
    if (!this._locked) {
      this._offsetNs = producerNs - consumerNs;
      this._integral = 0;
      this._locked = true;
      return;
    }
    const residual = (producerNs - consumerNs) - this._offsetNs;
    let integral = this._integral + residual;
    if (integral > PLL_INT_LIMIT_NS) integral = PLL_INT_LIMIT_NS;
    else if (integral < -PLL_INT_LIMIT_NS) integral = -PLL_INT_LIMIT_NS;
    this._integral = integral;
    this._offsetNs += PLL_KP * residual + PLL_KI * integral;
  }

  /**
   * Map a consumer-clock reading to the producer-clock frame of reference
   * using the current offset estimate. Returns `consumerNs + offsetNs` once
   * `observe` has been called at least once; before that, returns
   * `consumerNs` unchanged.
   */
  phaseLockedTime(consumerNs: number): number {
    if (!this._locked) return consumerNs;
    return consumerNs + this._offsetNs;
  }

  /**
   * Reset to the unlocked state. The next `observe` call seeds the offset
   * from scratch. Use after suspend/resume, an AudioContext epoch change,
   * or when the producer reconnects with a different `tMacroNs` epoch.
   */
  reset(): void {
    this._locked = false;
    this._offsetNs = 0;
    this._integral = 0;
  }

  /** True once `observe` has been called at least once since construction
   *  or the most recent `reset`. */
  get locked(): boolean {
    return this._locked;
  }

  /** Current offset estimate in ns. Meaningful only when `locked` is true;
   *  returns 0 in the unlocked state. */
  get offsetNs(): number {
    return this._offsetNs;
  }
}
