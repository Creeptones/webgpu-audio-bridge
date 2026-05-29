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
 * ─── Drift estimator (0.6.15, opt-in) ────────────────────────────────────
 *
 * The 0.6.2 PLL is a 1st-order tracker: it estimates the offset `O(t)`
 * but assumes the offset is constant between observations. That's fine
 * when producer and consumer share a clock (`performance.now()` to
 * `performance.now()`) and any apparent change is jitter around a fixed
 * mean.
 *
 * It's less fine when producer + consumer live in different clock domains
 * — the canonical case being a producer Worker stamping
 * `performance.now()` while the consumer AudioWorklet reads
 * `AudioContext.currentTime`. These two clocks can drift relative to each
 * other at tens of ppm (parts per million) because they're sourced from
 * different platform timers with independent calibration. At 50 ppm, the
 * apparent offset changes by 50 ns per ms of real time — large enough to
 * walk the 1st-order PLL out of microsecond accuracy over seconds-scale
 * timescales.
 *
 * 0.6.15 adds an opt-in 2nd-order tracker that models the offset as a
 * linear function of consumer time:
 *
 *     predicted_offset(t) = O_lastObs + driftRate · (t − t_lastObs)
 *
 * where `driftRate` is the dimensionless slope of offset vs consumer
 * time (1 ns of offset drift per 1 ns of consumer time = 1e6 ppm).
 * `phaseLockedTime(consumerNs)` extrapolates using the current
 * `(offset, driftRate, lastObservationTime)` triple, so a quantum-rate
 * AudioWorklet still gets sub-μs accurate offsets between observations.
 *
 * The g-h alpha-beta filter is the standard 2nd-order PLL update:
 *
 *     dt        = consumerNs − lastConsumerNs
 *     predicted = offset + driftRate · dt
 *     residual  = (producerNs − consumerNs) − predicted
 *     offset    = predicted + KP · residual + KI · integral   (1st-order PI lives here)
 *     driftRate = driftRate + (driftGain / dt) · residual     (new in 0.6.15)
 *
 * The drift gain (default `0.005`) is the dimensionless g-h "β" parameter.
 * Smaller values track drift more slowly but smooth jitter harder; the
 * default settles a constant 50 ppm drift in a few hundred observations
 * (≈ a few seconds at 60 Hz).
 *
 * **Opt-in.** Pass `enableDriftEstimator: true` in the opts bag to
 * activate the 2nd-order path. Default is `false` — the 1st-order
 * 0.6.2..0.6.14 behavior is preserved bit-exact for any caller that
 * doesn't opt in. The two existing PLL pins (#42 convergence and #43
 * step response) continue to pass unchanged.
 *
 * **Telemetry.** `Bridge.telemetry().pllDriftPpm` exposes the current
 * drift estimate (always 0 in offset-only mode); useful for diagnosing
 * clock-domain mismatch in production.
 *
 * **When to enable.** Switch on `enableDriftEstimator` when:
 *   - Producer is on a Worker stamping `performance.now()` and the
 *     consumer is in an AudioWorklet reading
 *     `AudioContext.currentTime` (the canonical browser-audio case).
 *   - You see slow `pllOffsetNs` walk in `telemetry()` over minute-
 *     plus runs that the 1st-order PLL can't fully cancel.
 *   - The producer-consumer clock pair has documented drift specs
 *     (e.g., ASIO sample-clock vs system clock for pro-audio devices).
 *
 * **When NOT to enable.** When producer and consumer share a clock
 * source (both in the same Worker, both reading
 * `performance.now()`), the drift estimator adds variance without
 * tracking anything real — the offset doesn't drift, so the drift
 * estimator's β-term injects jitter onto the offset estimate. The
 * 1st-order path is a strict improvement when there's nothing to
 * track.
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
 * Heap-only — THIS class never touches the SAB; the PI loop + offset state
 * live entirely on the JS heap. Bridge exposes `pllLocked` / `pllOffsetNs` /
 * `pllOutliersRejected` in `telemetry()` from that heap state via this
 * class's getters. Separately, for CROSS-process observability, Bridge
 * publishes this PLL's offset/drift/status to ring-header lanes 4–7 (0.6.16,
 * via SpscRing.publishPllState on every observeConsumerTime / resetPll); a
 * peer over the same SAB reads them through readPublishedPllState().
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

// Drift estimator defaults (0.6.15). See file header. Default-off; when
// opted in, the g-h β gain converges a constant 50 ppm drift in ~few
// dozen observations at the canonical 60 Hz observation cadence (β =
// 0.05 ≈ 20-observation time constant). The 0.6.2 PI integral is
// turned OFF in drift mode — the drift estimator IS the integrator and
// a redundant integral term fights it.
const PLL_DRIFT_GAIN_DEFAULT = 0.05;

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
  /** Enable the 2nd-order drift estimator (0.6.15). When `true`, the
   *  PLL models offset as a linear function of consumer time and
   *  tracks both `offsetNs` and `driftPpm`. Default `false` — preserves
   *  pre-0.6.15 offset-only behavior bit-exact. Switch on when
   *  producer and consumer live in different clock domains (e.g.,
   *  Worker `performance.now()` vs AudioWorklet
   *  `AudioContext.currentTime`). See class header "Drift estimator". */
  readonly enableDriftEstimator?: boolean;
  /** Drift gain (the dimensionless `β` parameter in the g-h
   *  alpha-beta filter formulation). Default `0.005`. Only meaningful
   *  when `enableDriftEstimator` is true. Smaller values track drift
   *  more slowly but smooth jitter harder. */
  readonly driftGain?: number;
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
  /** Cumulative stall recoveries (0.7.3). One increment per transition
   *  of the outlier gate from "currently rejecting outliers"
   *  (`_consecutiveOutliers > 0`) back to clean observation. Distinct
   *  from `_outliersRejected` (per-observation reject count); this is
   *  per-event. Inspector visualises stall onset/recovery via a
   *  monotonic counter rather than an edge-callback because callbacks
   *  across the consumer thread → main thread boundary are awkward.
   *  Heap-only — survives across `reset()`. */
  private _stallRecoveries: number = 0;

  // Gate tuning, captured at construction; immutable for the lifetime of
  // the instance. See file header for the per-field semantics.
  private readonly _outlierSigmaMultiplier: number;
  private readonly _outlierWarmupObservations: number;
  private readonly _outlierEwmaAlpha: number;
  private readonly _outlierConsecutiveLimit: number;

  // Drift estimator state (0.6.15). Only meaningful when
  // `_enableDriftEstimator` is true. Reset alongside the offset on
  // `reset()` calls.
  /** Dimensionless drift slope (1 ns of offset shift per 1 ns of
   *  consumer time). Multiply by 1e6 for parts-per-million. */
  private _driftRate: number = 0;
  /** Consumer time at the moment of the most recent admitted
   *  observation. Used to compute the `dt` for both the predicted-
   *  offset extrapolation and the g-h velocity update. Equal to the
   *  seed consumer time on the very first observation after lock. */
  private _lastConsumerNs: number = 0;
  private readonly _enableDriftEstimator: boolean;
  private readonly _driftGain: number;

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
  /** Default g-h `β` drift gain when drift estimator is opted in.
   *  (0.6.15) */
  static readonly DRIFT_GAIN_DEFAULT = PLL_DRIFT_GAIN_DEFAULT;

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

    // Drift estimator opts (0.6.15). Default-off; opt in to enable
    // 2nd-order tracking. Validation: driftGain must be positive
    // finite. (β = 0 is a no-op that wastes a multiply per observation
    // — disallowed; pass enableDriftEstimator: false to actually
    // disable.) NaN / negative driftGain rejected.
    this._enableDriftEstimator = opts.enableDriftEstimator === true;
    const driftGain = opts.driftGain ?? PLL_DRIFT_GAIN_DEFAULT;
    if (!Number.isFinite(driftGain) || driftGain <= 0) {
      throw new Error(
        `ConsumerClockRecovery: driftGain must be a positive finite number (got ${driftGain})`,
      );
    }
    this._driftGain = driftGain;
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
      this._driftRate = 0;
      this._lastConsumerNs = consumerNs;
      this._locked = true;
      return;
    }
    // Drift estimator (0.6.15). When enabled, the offset is extrapolated
    // forward by `driftRate · dt` before the residual is computed. The
    // residual is then "actual offset minus predicted offset at the
    // observation time," which is what the PI math and the g-h velocity
    // update both want.
    const dt = consumerNs - this._lastConsumerNs;
    const predicted = this._enableDriftEstimator
      ? this._offsetNs + this._driftRate * dt
      : this._offsetNs;
    const residual = (producerNs - consumerNs) - predicted;
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
          // 0.7.3 — sustained-step recovery. We had `> limit` outliers
          // in a row and are now admitting the step into the loop; this
          // is unambiguously a stall→normal transition. Count once.
          this._stallRecoveries = (this._stallRecoveries + 1) | 0;
          // Fall through to normal-path update below.
        } else {
          // Single spike. Skip PI + EWMA update; just count it.
          this._outliersRejected = (this._outliersRejected + 1) | 0;
          return;
        }
      } else {
        // Clean observation — reset the consecutive-outlier streak.
        // 0.7.3 — single-spike recovery. If we had at least one
        // outlier counted in the streak and now a clean observation
        // arrived, count the streak-break as a recovery transition.
        // No increment if `_consecutiveOutliers === 0` already (just
        // normal steady-state observations; nothing to recover from).
        if (this._consecutiveOutliers > 0) {
          this._stallRecoveries = (this._stallRecoveries + 1) | 0;
        }
        this._consecutiveOutliers = 0;
      }
    }

    // Offset + drift update. Two shapes:
    //
    // Offset-only mode (0.6.2..0.6.14, default): a 1st-order PI loop
    //   integral  = clamp(integral + residual, ±PLL_INT_LIMIT_NS)
    //   offsetNs += KP·residual + KI·integral
    // The integral term cancels steady-state offset bias from the KP
    // term's incomplete tracking; it's an inner integrator inside a
    // 1st-order loop.
    //
    // Drift mode (0.6.15, opt-in): a 2nd-order g-h alpha-beta filter
    //   offsetNs   = predicted + KP·residual            (α step)
    //   driftRate += (driftGain / dt) · residual        (β step)
    // The drift estimator IS the integrator at the 2nd-order level —
    // it accumulates the steady-state offset bias as a drift rate. A
    // redundant KI integral here would fight the drift estimator
    // (both trying to absorb the residual), so it's intentionally
    // omitted in drift mode. The integral state stays at 0.
    //
    // `predicted === this._offsetNs` in offset-only mode (driftRate = 0
    // throughout that branch), so `offsetNs = predicted + KP·residual
    // + KI·integral` collapses to `offsetNs += KP·residual + KI·integral`
    // bit-exact and the pre-0.6.15 PI math is preserved.
    if (this._enableDriftEstimator) {
      this._offsetNs = predicted + PLL_KP * residual;
      // Drift (g-h velocity) update — only when dt is positive.
      // dt ≤ 0 happens if two observations arrive at the same
      // consumer time (rare; possible from clock-quantization races) or
      // if consumer time went backward (clock skew, suspend/resume).
      // Skip the drift update; the offset update above absorbs the
      // observation.
      if (dt > 0) {
        this._driftRate += (this._driftGain / dt) * residual;
      }
    } else {
      let integral = this._integral + residual;
      if (integral > PLL_INT_LIMIT_NS) integral = PLL_INT_LIMIT_NS;
      else if (integral < -PLL_INT_LIMIT_NS) integral = -PLL_INT_LIMIT_NS;
      this._integral = integral;
      this._offsetNs = predicted + PLL_KP * residual + PLL_KI * integral;
    }
    // Always update the last-observation timestamp so the next
    // observation's dt is computed against a current reference. Even
    // in offset-only mode — harmless (we never read lastConsumerNs
    // there) but keeps the state coherent for callers that flip the
    // drift estimator on/off across resets.
    this._lastConsumerNs = consumerNs;

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
    // Offset-only mode: return consumerNs + offset directly.
    // Drift mode (0.6.15): extrapolate the offset from the last
    // observation to consumerNs using the current drift estimate.
    // Between observations, this gives sub-μs accurate offsets even
    // when producer and consumer clocks drift at tens of ppm.
    if (!this._enableDriftEstimator) {
      return consumerNs + this._offsetNs;
    }
    const dt = consumerNs - this._lastConsumerNs;
    return consumerNs + this._offsetNs + this._driftRate * dt;
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
    this._driftRate = 0;
    this._lastConsumerNs = 0;
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

  /** Number of stall→normal transitions the outlier gate has observed
   *  since construction (0.7.3). One increment per recovery event:
   *  either a sustained step that exceeded `outlierConsecutiveLimit`
   *  consecutive outliers and was admitted, or a transient spike
   *  streak that ended with a clean observation. Cumulative across
   *  `reset()` calls (the counter is not cleared on reset — it's a
   *  diagnostic). Disjoint from `outliersRejected` (per-observation
   *  reject count) — this is per-event. Read via
   *  `Bridge.telemetry().stallRecoveries`. */
  get stallRecoveries(): number {
    return this._stallRecoveries;
  }

  /** Current EWMA estimate of |residual| in ns. Zero before any observe
   *  call (or pre-warmup, when the gate is inactive). Exposed mainly
   *  for tests / debugging; production callers should rely on
   *  `outliersRejected` and `offsetNs`. (0.6.14) */
  get sigmaEstimateNs(): number {
    return this._sigmaEwma;
  }

  /** True if the drift estimator was enabled at construction. Read
   *  this to know whether `driftPpm` is tracking real drift or stuck
   *  at 0 because the 2nd-order path is off. (0.6.15) */
  get driftEstimatorEnabled(): boolean {
    return this._enableDriftEstimator;
  }

  /** Current drift estimate in parts-per-million (ns of offset shift
   *  per second of consumer time). Always 0 when the drift estimator
   *  is opt-out (default). Read via
   *  `Bridge.telemetry().pllDriftPpm` for dashboards. (0.6.15) */
  get driftPpm(): number {
    // _driftRate is dimensionless (ns/ns). Multiply by 1e6 for ppm
    // (the conventional "parts per million" unit clocks use).
    return this._driftRate * 1e6;
  }
}
