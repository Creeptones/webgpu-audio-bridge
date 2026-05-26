/**
 * ConsumerClockRecovery — extracted PLL heap state machine (0.6.9).
 *
 * Public composable primitive as of 0.6.10. Promoted from internal-only
 * after the 0.6.9 extract seam settled.
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
 * ─── Mahalanobis outlier gate (0.6.14) ───────────────────────────────────
 *
 * Single-frame residual spikes — a 30 ms `mapAsync` stall, a frame whose
 * producer-stamped time is corrupted by an unrelated GC pause, etc. — can
 * poison the offset estimate by injecting a huge transient into the PI
 * loop. Each observation that runs the full PI update against a 30 ms
 * residual moves the offset by `KP · 30 ms = 6 ms`, and the integral
 * absorbs the full residual into anti-windup. Without a gate, recovering
 * to the true offset takes ~`KP^-1 · ln(target / spike_size)` ≈ 30+
 * observations even after the spike clears.
 *
 * 0.6.14 adds an EWMA-based scale estimator + Mahalanobis-distance gate:
 *
 *   sigmaEwma_{n+1} = (1 - α_σ) · sigmaEwma_n + α_σ · |residual|
 *   mahalanobis = |residual| / sigmaEwma
 *   gated if mahalanobis > outlierSigmaMultiplier
 *
 * Gated observations skip the PI update + the EWMA update — they don't
 * move the offset estimate and they don't inflate σ̂. The outlier counter
 * (read via `outliersRejected`) increments so the failure surfaces in
 * `Bridge.telemetry().pllOutliersRejected`.
 *
 * Warmup. The gate is disabled for the first `outlierWarmupObservations`
 * (default 5) observations after the lock seeds, while σ̂ is still
 * building. Without this, the very-first-observation post-seed has σ̂ = 0
 * and any non-zero residual would gate as ∞-sigma.
 *
 * Step-detection escape. A genuine offset epoch change (e.g. the consumer
 * is briefly suspended and resumes with `AudioContext.currentTime` having
 * jumped) looks like a sustained sequence of large residuals, not a
 * single spike. If the gate fires `outlierConsecutiveLimit` (default 3)
 * times in a row, the loop concludes a step occurred and:
 *   1. Resets σ̂ to `|residual| / outlierSigmaMultiplier` so the next
 *      observation is at the gate boundary.
 *   2. Resets the consecutive-outlier streak.
 *   3. Passes this observation through to the normal PI update.
 *
 * The step-recovery delay is therefore `outlierConsecutiveLimit + 1`
 * observations — at 60 Hz that's ~67 ms, which is well inside any human-
 * perceivable latency budget for an offset epoch change.
 *
 * Defaults (`outlierSigmaMultiplier=6`, `outlierWarmupObservations=5`,
 * `outlierEwmaAlpha=0.05`, `outlierConsecutiveLimit=3`) are tuned for
 * the canonical 60 Hz observation cadence + ~100 μs jitter floor. Pass
 * `outlierSigmaMultiplier: Infinity` to opt out entirely (e.g. when
 * pinning legacy pre-0.6.14 behavior in tests); pass smaller values for
 * stricter gating. Pass `outlierConsecutiveLimit: Infinity` to make the
 * gate never give up — useful if you'd rather mask a step change
 * indefinitely and rely on `resetPll()` to recover.
 *
 * ─── ──────────────────────────────────────────────────────────────────
 *
 * Heap-only — the PLL never touches the SAB. Lanes 4–7 of the ring header
 * remain reserved; cross-process PLL observability is a follow-up. Bridge
 * exposes `pllLocked` / `pllOffsetNs` / `pllOutliersRejected` in
 * `telemetry()` from heap state via this class's getters.
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

// Mahalanobis outlier gate defaults (0.6.14). See file header for the
// derivation. Six-sigma + 5-observation warmup + α_σ = 0.05 (effective
// window ~20 samples) + 3-consecutive step-recovery threshold.
const PLL_OUTLIER_SIGMA_DEFAULT = 6;
const PLL_OUTLIER_WARMUP_DEFAULT = 5;
const PLL_OUTLIER_EWMA_ALPHA_DEFAULT = 0.05;
const PLL_OUTLIER_CONSECUTIVE_DEFAULT = 3;

/** Constructor options for `ConsumerClockRecovery` (0.6.14). All fields
 *  optional; omitted fields take the documented per-field defaults. */
export interface ConsumerClockRecoveryOptions {
  /** Mahalanobis multiplier above which a residual gates as an outlier.
   *  Default `6` (six-sigma). Pass `Infinity` to disable the gate
   *  entirely (preserves pre-0.6.14 behavior bit-exact for tests
   *  pinning the unconditional PI math). */
  readonly outlierSigmaMultiplier?: number;
  /** Number of post-lock observations during which the gate is disabled
   *  so the EWMA scale estimate can build up. Default `5`. Set to `0`
   *  to gate from the very first post-seed observation (only safe if
   *  you also pass a non-zero initial σ̂ — out of scope for 0.6.14). */
  readonly outlierWarmupObservations?: number;
  /** EWMA update rate for the |residual| scale estimate. Range (0, 1].
   *  Default `0.05` ≈ 20-sample effective window. Larger values track
   *  noise-scale shifts faster but admit more outliers. */
  readonly outlierEwmaAlpha?: number;
  /** Number of consecutive gated observations after which the gate
   *  concludes a step occurred and admits the latest residual. Default
   *  `3` — at 60 Hz that's ~50 ms before a step is acknowledged. Pass
   *  `Infinity` to make the gate never give up. */
  readonly outlierConsecutiveLimit?: number;
}

/**
 * ConsumerClockRecovery — consumer-side PLL tracking producer↔consumer
 * clock offset. Public composable primitive (0.6.10+).
 */
export class ConsumerClockRecovery {
  private _offsetNs: number = 0;
  private _integral: number = 0;
  private _locked: boolean = false;

  // Mahalanobis outlier gate state (0.6.14). All four fields are reset
  // by `reset()` so a re-seeded loop starts cleanly.
  private _sigmaEwma: number = 0;
  private _observationsSinceLock: number = 0;
  private _consecutiveOutliers: number = 0;
  private _outliersRejected: number = 0;

  // Gate tuning, captured at construction; immutable for the lifetime of
  // the instance. See file header for the per-field semantics.
  private readonly _outlierSigmaMultiplier: number;
  private readonly _outlierWarmupObservations: number;
  private readonly _outlierEwmaAlpha: number;
  private readonly _outlierConsecutiveLimit: number;

  /** Proportional gain (frozen for the lifetime of the instance). */
  static readonly KP = PLL_KP;
  /** Integral gain. */
  static readonly KI = PLL_KI;
  /** Anti-windup bound on |integral| (ns in residual units). */
  static readonly INT_LIMIT_NS = PLL_INT_LIMIT_NS;
  /** Default Mahalanobis multiplier above which a residual gates as an
   *  outlier. (0.6.14) */
  static readonly OUTLIER_SIGMA_DEFAULT = PLL_OUTLIER_SIGMA_DEFAULT;
  /** Default observations-since-lock during which the gate is disabled
   *  while σ̂ builds up. (0.6.14) */
  static readonly OUTLIER_WARMUP_DEFAULT = PLL_OUTLIER_WARMUP_DEFAULT;
  /** Default EWMA update rate for the |residual| scale estimate. (0.6.14) */
  static readonly OUTLIER_EWMA_ALPHA_DEFAULT = PLL_OUTLIER_EWMA_ALPHA_DEFAULT;
  /** Default consecutive-gated count before the loop concludes a step
   *  occurred and admits the residual. (0.6.14) */
  static readonly OUTLIER_CONSECUTIVE_DEFAULT = PLL_OUTLIER_CONSECUTIVE_DEFAULT;

  /** Default-construct with all gate parameters at their documented
   *  defaults, or pass an options bag to tune the gate per-instance.
   *  (0.6.14 — adds the opts bag; pre-0.6.14 the constructor took no
   *  arguments and the gate did not exist.) */
  constructor(opts: ConsumerClockRecoveryOptions = {}) {
    const sigma = opts.outlierSigmaMultiplier ?? PLL_OUTLIER_SIGMA_DEFAULT;
    if (!(sigma > 0)) {
      throw new Error(
        `ConsumerClockRecovery: outlierSigmaMultiplier must be > 0 (got ${sigma}); pass Infinity to disable gate`,
      );
    }
    const warmup = opts.outlierWarmupObservations ?? PLL_OUTLIER_WARMUP_DEFAULT;
    if (!Number.isFinite(warmup) || warmup < 0 || warmup !== Math.floor(warmup)) {
      throw new Error(
        `ConsumerClockRecovery: outlierWarmupObservations must be a non-negative integer (got ${warmup})`,
      );
    }
    const alpha = opts.outlierEwmaAlpha ?? PLL_OUTLIER_EWMA_ALPHA_DEFAULT;
    if (!(alpha > 0 && alpha <= 1)) {
      throw new Error(
        `ConsumerClockRecovery: outlierEwmaAlpha must be in (0, 1] (got ${alpha})`,
      );
    }
    const consec = opts.outlierConsecutiveLimit ?? PLL_OUTLIER_CONSECUTIVE_DEFAULT;
    if (!(consec >= 0)) {
      throw new Error(
        `ConsumerClockRecovery: outlierConsecutiveLimit must be ≥ 0 (got ${consec}); pass Infinity to disable step-recovery`,
      );
    }
    this._outlierSigmaMultiplier = sigma;
    this._outlierWarmupObservations = warmup;
    this._outlierEwmaAlpha = alpha;
    this._outlierConsecutiveLimit = consec;
  }

  /**
   * Run one PI observation. Pair the producer-stamped timestamp from a
   * recently-pulled frame (`producerNs`) with the consumer's wall-clock at
   * the moment that frame was pulled / evaluated (`consumerNs`).
   *
   * The first call seeds the offset estimate exactly (`offsetNs =
   * producerNs − consumerNs`) and flips `locked=true`. Subsequent calls
   * run one PI cycle, gated by the Mahalanobis outlier classifier
   * (0.6.14 — see class header). Gated observations skip the PI + EWMA
   * updates and bump the outlier counter.
   *
   * Cost on the non-gated path: ~5 arithmetic ops + 2 compares + the
   * EWMA update (3 ops). On the gated path: ~3 ops + 1 compare to
   * decide. Allocation-free. Safe to call from an AudioWorklet's
   * `process()` loop.
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
      this._sigmaEwma = 0;
      this._observationsSinceLock = 0;
      this._consecutiveOutliers = 0;
      this._locked = true;
      return;
    }
    const residual = (producerNs - consumerNs) - this._offsetNs;
    const absRes = residual < 0 ? -residual : residual;

    // Outlier gate (0.6.14). Active only after the warmup observations
    // have built up a usable σ̂. Pre-warmup observations all bypass the
    // gate so a fresh-seeded loop converges through its first real
    // residuals without being clipped.
    const gateActive =
      this._observationsSinceLock >= this._outlierWarmupObservations &&
      this._sigmaEwma > 0 &&
      Number.isFinite(this._outlierSigmaMultiplier);
    if (gateActive) {
      const threshold = this._outlierSigmaMultiplier * this._sigmaEwma;
      if (absRes > threshold) {
        // Outlier. Either skip (single spike) or admit (sustained step).
        this._consecutiveOutliers = (this._consecutiveOutliers + 1) | 0;
        if (this._consecutiveOutliers > this._outlierConsecutiveLimit) {
          // Step detected. Reset σ̂ to bring the next observation back
          // inside the gate, then fall through to the normal PI + EWMA
          // path so this observation is incorporated.
          this._sigmaEwma = absRes / this._outlierSigmaMultiplier;
          this._consecutiveOutliers = 0;
          // Fall through to normal-path update below.
        } else {
          // Single spike. Skip PI + EWMA update; just count it.
          this._outliersRejected = (this._outliersRejected + 1) | 0;
          return;
        }
      } else {
        // Clean observation — reset the consecutive-outlier streak.
        this._consecutiveOutliers = 0;
      }
    }

    // Normal PI path. Same math as 0.6.13; the outlier gate above gates
    // entry but never changes the math when allowed through.
    let integral = this._integral + residual;
    if (integral > PLL_INT_LIMIT_NS) integral = PLL_INT_LIMIT_NS;
    else if (integral < -PLL_INT_LIMIT_NS) integral = -PLL_INT_LIMIT_NS;
    this._integral = integral;
    this._offsetNs += PLL_KP * residual + PLL_KI * integral;

    // EWMA update of σ̂ — done after PI math so the absRes reflects the
    // observation we just processed. Sticky-up bias is acceptable; the
    // 5-observation warmup gives σ̂ time to track the actual noise floor.
    if (this._sigmaEwma === 0) {
      this._sigmaEwma = absRes;
    } else {
      this._sigmaEwma =
        (1 - this._outlierEwmaAlpha) * this._sigmaEwma +
        this._outlierEwmaAlpha * absRes;
    }
    // Cap the observations counter at warmup + 1 so it doesn't grow
    // unboundedly across hours of operation. The post-warmup behavior
    // depends only on `_observationsSinceLock >= warmup` so any value
    // past warmup is equivalent.
    if (this._observationsSinceLock <= this._outlierWarmupObservations) {
      this._observationsSinceLock = (this._observationsSinceLock + 1) | 0;
    }
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
   * from scratch and clears all outlier-gate state. Use after
   * suspend/resume, an AudioContext epoch change, or when the producer
   * reconnects with a different `tMacroNs` epoch.
   */
  reset(): void {
    this._locked = false;
    this._offsetNs = 0;
    this._integral = 0;
    this._sigmaEwma = 0;
    this._observationsSinceLock = 0;
    this._consecutiveOutliers = 0;
    // Note: _outliersRejected is intentionally NOT reset — it's a
    // cumulative diagnostic counter, like `tornFrames`. Callers that
    // want a fresh count should construct a new instance.
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

  /** Number of single-frame residual spikes the Mahalanobis gate has
   *  rejected since construction. Cumulative across `reset()` calls
   *  (the counter is not cleared on reset — it's a diagnostic). Read
   *  via `Bridge.telemetry().pllOutliersRejected`. (0.6.14) */
  get outliersRejected(): number {
    return this._outliersRejected;
  }

  /** Current EWMA estimate of |residual| in ns. Zero before any observe
   *  call (or pre-warmup, when the gate is inactive). Exposed mainly
   *  for tests / debugging; production callers should rely on
   *  `outliersRejected` and `offsetNs`. (0.6.14) */
  get sigmaEstimateNs(): number {
    return this._sigmaEwma;
  }
}
