/**
 * Confidence-bounded predictive frame extrapolation.
 *
 * The trajectory evaluator (`evaluateTrajectoryInto`, src/trajectory.ts) is
 * already FORWARD-IN-TIME capable: for order≥2 it computes
 *
 *     out[i] = p_i + v_i·dt (+ ½·a_i·dt²)
 *
 * for ARBITRARY dt, including a dt that lands PAST the newest stamped frame.
 * That makes raw forward extrapolation mechanically expressible today — but
 * it is unbounded: a stale or cold PLL plus a large dt drives the audio block
 * to wild excursions. This module wraps the evaluator with a documented
 * confidence→horizon curve so prediction degrades gracefully as the consumer
 * clock's uncertainty grows: low confidence shrinks the effective horizon AND
 * crossfades the result back toward an order-1 hold, and a cold/unlocked PLL
 * collapses to pure hold (no extrapolation at all).
 *
 * ─── What this is, and is NOT ─────────────────────────────────────────────
 *
 *   - This is NOT new Taylor math. It calls `evaluateTrajectoryInto`
 *     unchanged, so any per-sample safety clamp on the spec
 *     (`velocityClamp` / `accelerationClamp` / `maxDeltaPerSample` /
 *     `overflowFallback`) still fires on the clamped path. The horizon clamp
 *     here is ORTHOGONAL to those per-sample clamps — both can act on the
 *     same call. A caller may see a per-sample-clamped excursion AND a faded
 *     horizon stack; that is intentional and documented.
 *
 *   - This is NOT a Kalman filter or a calibrated confidence interval. The
 *     PLL exposes `sigmaEstimateNs`, an EWMA of |residual| (a mean-absolute-
 *     deviation-like dispersion proxy), NOT a variance/stddev. The returned
 *     `valueUncertainty` is therefore an order-of-magnitude proxy, not a
 *     statistically calibrated ± band. A true covariance estimator would
 *     require mutating ConsumerClockRecovery, which is out of scope.
 *
 *   - This module is PURE and DECOUPLED. It consumes a plain `PllUncertainty`
 *     snapshot struct, NOT a `ConsumerClockRecovery` instance. Callers build
 *     the snapshot from `pll.sigmaEstimateNs` / `.driftPpm` /
 *     `.driftEstimatorEnabled` / `.locked`. No imports beyond `TrajectorySpec`
 *     (type) and `evaluateTrajectoryInto`.
 *
 * ─── Confidence → max-extrapolation-distance curve ───────────────────────
 *
 * Two confidence factors, each in [0, 1], multiply to a single weight `w`:
 *
 *   c_sigma  — clock-jitter confidence:
 *
 *       sigmaUsed = (sigmaEstimateNs > 0 && locked) ? sigmaEstimateNs
 *                                                   : seedingSigmaNs
 *       c_sigma   = clamp01(1 − sigmaUsed / sigmaFloorNs)
 *
 *     sigma = 0 (pre-warmup, gate inactive) OR an unlocked PLL is treated as
 *     UNKNOWN uncertainty — we substitute a conservative `seedingSigmaNs`
 *     (default = sigmaFloorNs ⇒ c_sigma = 0 ⇒ pure hold), NEVER as "zero
 *     uncertainty". This is the key safety property: a cold PLL never lets
 *     prediction run.
 *
 *   c_horizon — distance confidence (linear taper):
 *
 *       below trustedHorizon → 1 (the producer-stamped region is trusted)
 *       between trusted/max   → linear taper 1 → 0
 *       above maxHorizon      → 0 (no extrapolation past the max)
 *
 *     Shrunk further by a drift-inflation term, but only when the drift
 *     estimator is enabled (driftPpm is 0 / meaningless otherwise):
 *
 *       driftInflation = |driftPpm|·1e−6 · dtReqAbs / max(maxHorizon, 1e−9)
 *       c_horizon      = clamp01(c_horizon − driftInflation)
 *
 *   w = c_sigma · c_horizon                       (∈ [0, 1])
 *
 * An optional `confidenceFloor` then gates `w` with a hard cliff: if
 * `w < confidenceFloor` it is forced to 0 (pure hold), so a marginally-
 * confident clock leads nothing rather than injecting low-confidence wobble.
 * Default 0 (no gate; bit-exact with every prior release).
 *
 * The weight is applied TWICE, deliberately conservative:
 *
 *   1. It shrinks the EFFECTIVE horizon:  dtEff = w · dtReqAbs.
 *      So lower confidence not only fades the output but also evaluates the
 *      Taylor series closer in (less derivative leverage to begin with).
 *
 *   2. It crossfades the Taylor result toward the order-1 hold:
 *      out[i] = w·taylor(dtEff)[i] + (1 − w)·hold[i].
 *      At w=0 the output is exactly the hold (positions at dt=0); at w=1 it
 *      is exactly `evaluateTrajectoryInto(flat, spec, dtReqAbs, out)` —
 *      bit-equal to the bare evaluator (dtEff = dtReqAbs, no blend).
 *
 * For order==1 there is no velocity, so taylor(dt) ≡ hold for all dt; the
 * blend is a no-op and we skip computing the hold buffer entirely.
 *
 * ─── Value-domain uncertainty proxy ──────────────────────────────────────
 *
 * The ns-domain clock uncertainty is pushed through the first Taylor
 * derivative to a value-domain proxy (order≥2 only; order==1 returns 0):
 *
 *       sigmaDtSeconds = sigmaUsed·1e−9 + (driftEnabled ? |driftPpm|·1e−6·dtEff : 0)
 *       valueUncertainty = max_i(|v_i|) · sigmaDtSeconds
 *
 * i.e. "if the consumer clock is off by sigmaDt seconds, the fastest-moving
 * sample's value is off by ≈ |v|·sigmaDt". It is a coarse upper-bound-ish
 * proxy, not a calibrated interval — see the NOT list above.
 *
 * ─── Reference table (defaults: trusted=0, max=0.020s, floor=2e6 ns) ─────
 *
 *   sigma (ns) | locked | dtReq (s) | c_sigma | c_horizon | w     | dtEff (s)
 *   -----------|--------|-----------|---------|-----------|-------|----------
 *   0          |  any   |  0.005    |  0.00*  |   0.75    | 0.00  | 0.000  (hold; seeding)
 *   500_000    |  true  |  0.005    |  0.75   |   0.75    | 0.56  | 0.0028
 *   500_000    |  true  |  0.000    |  0.75   |   1.00    | 0.75  | 0.000  (hold at dt=0)
 *   1_000_000  |  true  |  0.010    |  0.50   |   0.50    | 0.25  | 0.0025
 *   2_000_000  |  true  |  0.005    |  0.00   |   0.75    | 0.00  | 0.000  (hold; sigma≥floor)
 *   500_000    |  true  |  0.030    |  0.75   |   0.00    | 0.00  | 0.000  (hold; past maxHorizon)
 *   *sigma=0 substitutes seedingSigmaNs (= floor by default) ⇒ c_sigma = 0.
 *
 * ─── Performance ─────────────────────────────────────────────────────────
 *
 * Allocation-free hot loop: the caller owns `out` and `holdScratch`; the
 * Taylor evaluation, the hold fill, and the in-place blend allocate nothing.
 * (The 4-field `PredictiveExtrapolationResult` is a fresh small object per
 * call, matching the `SpscPullResult` / `telemetry()` idiom — the brief's
 * allocation-free requirement targets the sample-filling loop, which this
 * satisfies. A void overload omitting the result is a possible MVP2
 * optimization if a caller proves the per-call object hot.) f32/f64 overloads
 * mirror `evaluateTrajectoryInto` / `evaluateHermiteTrajectoryInto`.
 */

import type { TrajectorySpec } from "./schema.js";
import { evaluateTrajectoryInto } from "./trajectory.js";

/** Plain snapshot of the consumer clock's uncertainty signals, decoupled from
 *  `ConsumerClockRecovery`. Callers build it from the PLL getters:
 *
 *      { sigmaEstimateNs: pll.sigmaEstimateNs,
 *        driftPpm: pll.driftPpm,
 *        driftEstimatorEnabled: pll.driftEstimatorEnabled,
 *        locked: pll.locked }
 *
 *  Keeping it a struct (rather than the PLL instance) makes this module pure
 *  and testable without constructing a PLL. */
export interface PllUncertainty {
  /** EWMA of |residual| in ns (the PLL's only dispersion signal). 0 means
   *  pre-warmup / gate inactive — treated as UNKNOWN (seeding), not zero
   *  uncertainty. */
  readonly sigmaEstimateNs: number;
  /** Drift estimate in parts-per-million. Meaningless (0) unless
   *  `driftEstimatorEnabled`. */
  readonly driftPpm: number;
  /** Whether the drift estimator is active; gates the drift-inflation term. */
  readonly driftEstimatorEnabled: boolean;
  /** Whether the PLL has locked. An unlocked PLL is treated as UNKNOWN
   *  uncertainty (seeding), regardless of sigmaEstimateNs. */
  readonly locked: boolean;
}

/** Tunables for the confidence→horizon curve. Defaults are intentionally
 *  cautious; raise `trustedHorizonSeconds` / `maxHorizonSeconds` for more
 *  aggressive prediction. */
export interface PredictiveExtrapolationConfig {
  /** Forward distance (seconds) below which c_horizon = 1 — the region the
   *  producer-stamped derivatives are trusted to cover. Default 0 (every
   *  forward step is in the taper). */
  readonly trustedHorizonSeconds?: number;
  /** Forward distance (seconds) at and beyond which c_horizon = 0 — no
   *  extrapolation past here. Default 0.020 (20 ms). */
  readonly maxHorizonSeconds?: number;
  /** sigma (ns) at and beyond which c_sigma = 0 — the dispersion above which
   *  the clock is considered untrustworthy. Default 2_000_000 (2 ms). */
  readonly sigmaFloorNs?: number;
  /** Conservative sigma (ns) substituted when the real sigma is unknown
   *  (sigma=0 or unlocked). Default = sigmaFloorNs ⇒ c_sigma = 0 ⇒ hold. */
  readonly seedingSigmaNs?: number;
  /** Hard confidence gate in [0, 1]. After the weight `w = c_sigma·c_horizon`
   *  is formed, if `w < confidenceFloor` the weight is forced to **0** —
   *  prediction collapses to the pure order-1 hold (dtEff = 0). This is a
   *  cliff, not a rescale: below the floor we do not predict at all; at or
   *  above it `w` is used unchanged. Default `0` (no gate — every prior
   *  release's behavior is preserved bit-exact). Use it to say "only lead the
   *  signal when the clock is at least this trustworthy," so a marginally-
   *  locked PLL doesn't inject low-confidence wobble into a macro field. */
  readonly confidenceFloor?: number;
}

/** Diagnostics returned alongside the filled `out` buffer. */
export interface PredictiveExtrapolationResult {
  /** The horizon actually evaluated (= w · |dtReq|), ≤ |dtReq|. */
  readonly dtEffectiveSeconds: number;
  /** The confidence weight w ∈ [0, 1] (= c_sigma · c_horizon). */
  readonly confidenceWeight: number;
  /** Value-domain uncertainty proxy (max|v_i|·sigmaDt). 0 for order==1. */
  readonly valueUncertainty: number;
  /** True iff the requested horizon was shrunk (dtEff < |dtReq|). */
  readonly clamped: boolean;
}

const DEFAULT_MAX_HORIZON_SECONDS = 0.02;
const DEFAULT_SIGMA_FLOOR_NS = 2_000_000;

function clamp01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

export function predictiveExtrapolateInto(
  flat: Float64Array,
  spec: TrajectorySpec,
  dtReqSeconds: number,
  pll: PllUncertainty,
  out: Float64Array,
  holdScratch: Float64Array,
  config?: PredictiveExtrapolationConfig,
): PredictiveExtrapolationResult;
export function predictiveExtrapolateInto(
  flat: Float32Array,
  spec: TrajectorySpec,
  dtReqSeconds: number,
  pll: PllUncertainty,
  out: Float32Array,
  holdScratch: Float32Array,
  config?: PredictiveExtrapolationConfig,
): PredictiveExtrapolationResult;
export function predictiveExtrapolateInto(
  flat: Float64Array | Float32Array,
  spec: TrajectorySpec,
  dtReqSeconds: number,
  pll: PllUncertainty,
  out: Float64Array | Float32Array,
  holdScratch: Float64Array | Float32Array,
  config?: PredictiveExtrapolationConfig,
): PredictiveExtrapolationResult {
  const { order, sampleCount } = spec;
  if (!Number.isFinite(dtReqSeconds)) {
    throw new Error(
      `predictiveExtrapolateInto: dtReqSeconds must be finite, got ${dtReqSeconds}`,
    );
  }
  if (out.length < sampleCount) {
    throw new Error(
      `predictiveExtrapolateInto: out length ${out.length} < sampleCount ${sampleCount}`,
    );
  }
  if (holdScratch.length < sampleCount) {
    throw new Error(
      `predictiveExtrapolateInto: holdScratch length ${holdScratch.length} < sampleCount ${sampleCount}`,
    );
  }

  // Resolve tunables. seedingSigmaNs defaults to the floor so an unknown
  // clock yields c_sigma = 0 (pure hold) without extra config.
  const trustedHorizon = config?.trustedHorizonSeconds ?? 0;
  const maxHorizon = config?.maxHorizonSeconds ?? DEFAULT_MAX_HORIZON_SECONDS;
  const sigmaFloorNs = config?.sigmaFloorNs ?? DEFAULT_SIGMA_FLOOR_NS;
  const seedingSigmaNs = config?.seedingSigmaNs ?? sigmaFloorNs;

  // Horizon arithmetic is symmetric in time direction; reason about the
  // magnitude. (A backward dt — interpolation into stamped history — would be
  // safe, but this module's contract is forward prediction; clamping by
  // magnitude is the conservative choice either way.)
  const dtReqAbs = Math.abs(dtReqSeconds);

  // c_sigma: jitter confidence. sigma=0 (pre-warmup / gate inactive) OR an
  // unlocked PLL is UNKNOWN uncertainty → substitute the conservative seeding
  // sigma, NEVER zero. Guard a zero/negative floor to avoid div-by-zero.
  const sigmaUsed =
    pll.sigmaEstimateNs > 0 && pll.locked
      ? pll.sigmaEstimateNs
      : seedingSigmaNs;
  const cSigma =
    sigmaFloorNs > 0 ? clamp01(1 - sigmaUsed / sigmaFloorNs) : 0;

  // c_horizon: linear taper of dtReqAbs between trustedHorizon and maxHorizon.
  let cHorizon: number;
  if (dtReqAbs <= trustedHorizon) {
    cHorizon = 1;
  } else if (dtReqAbs >= maxHorizon) {
    cHorizon = 0;
  } else {
    const span = maxHorizon - trustedHorizon;
    cHorizon = span > 0 ? clamp01(1 - (dtReqAbs - trustedHorizon) / span) : 0;
  }
  // Drift-inflation: only when the drift estimator is modeling drift. Widens
  // the effective uncertainty proportional to accumulated drift over the
  // horizon, shrinking c_horizon further.
  if (pll.driftEstimatorEnabled) {
    const driftInflation =
      (Math.abs(pll.driftPpm) * 1e-6 * dtReqAbs) / Math.max(maxHorizon, 1e-9);
    cHorizon = clamp01(cHorizon - driftInflation);
  }

  // Confidence floor (a hard cliff, not a rescale): below it we do not
  // predict at all. Computed from the un-floored product so the gate
  // compares the TRUE confidence against the threshold; a 0 floor (default)
  // leaves every prior release's weight bit-exact.
  const confidenceFloor = config?.confidenceFloor ?? 0;
  const wRaw = cSigma * cHorizon;
  const w = wRaw < confidenceFloor ? 0 : wRaw;
  const dtEff = w * dtReqAbs;

  // Evaluate the Taylor series at the SHRUNK horizon. spec passes through
  // unchanged so any per-sample clamp still fires (orthogonal to the horizon
  // clamp here).
  evaluateTrajectoryInto(flat as Float64Array, spec, dtEff, out as Float64Array);

  let valueUncertainty = 0;
  if (order >= 2) {
    // Hold = order-1 positions (taylor at dt=0); the crossfade target.
    // Compute it directly from the position lane (stride = order) — cheaper
    // and clearer than a second evaluateTrajectoryInto(dt=0) call, and it
    // lets us scan |v_i| for the value-uncertainty proxy in the same pass.
    const sigmaDtSeconds =
      sigmaUsed * 1e-9 +
      (pll.driftEstimatorEnabled
        ? Math.abs(pll.driftPpm) * 1e-6 * dtEff
        : 0);
    let maxAbsV = 0;
    for (let i = 0; i < sampleCount; i++) {
      const j = i * order;
      holdScratch[i] = flat[j]!; // position = hold value
      const av = Math.abs(flat[j + 1]!); // velocity lane
      if (av > maxAbsV) maxAbsV = av;
    }
    valueUncertainty = maxAbsV * sigmaDtSeconds;
    // In-place crossfade toward the hold. At w=1 this is exactly out[i]
    // (bit-equal to the bare evaluator); at w=0 it is exactly the hold.
    if (w < 1) {
      const oneMinusW = 1 - w;
      for (let i = 0; i < sampleCount; i++) {
        out[i] = w * out[i]! + oneMinusW * holdScratch[i]!;
      }
    }
  }
  // order==1: taylor(dt) ≡ hold for all dt, so the blend is a no-op and the
  // value-uncertainty proxy is 0 (no velocity to propagate). `out` is already
  // correct from evaluateTrajectoryInto.

  return {
    dtEffectiveSeconds: dtEff,
    confidenceWeight: w,
    valueUncertainty,
    clamped: dtEff < dtReqAbs,
  };
}
