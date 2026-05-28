# Confidence-bounded predictive frame extrapolation — design note

**Status**: **shipped** (2026-05-28, patch bump). Net-new standalone pure module `src/predictiveExtrapolation.ts` + a new test suite `tests/Bridge.predict.test.ts`. Non-breaking: no edit to `Bridge.ts`, the wire format, or any existing API; `index.ts` gained the additive re-export.
**Author**: maintainer + Claude (2026-05-28).
**Decision pending**: scope is fixed by the track brief (MVP: pure forward-extrapolation-with-confidence-clamp module + one numbered pin). The design space below concerns *how* the confidence→horizon coupling is shaped, not *whether* to ship it.
**slug**: `predictive-extrapolation`

## Executive summary

The trajectory evaluator already does forward-in-time math: `evaluateTrajectoryInto(flat, spec, dt, out)` with `order >= 2` computes `p_i + v_i·dt (+ ½·a_i·dt²)` for *arbitrary* `dt`, including a `dt` that lands past the newest stamped frame. `Bridge.evaluateInto` only guards `Number.isFinite(dt)` — there is no max-`dt` clamp and no sign restriction. So prediction to consumer time `t` or `t + outputBuffer` is *mechanically* already expressible today: pass a larger `dt_s`.

What is missing is the **confidence coupling**. Nothing in the codebase widens or bounds the prediction horizon as the PLL's residual dispersion grows. A confident, locked PLL with tiny `sigmaEstimateNs` can safely extrapolate a full output-buffer ahead; a freshly-seeded or jittery PLL (large or unknown sigma) should clamp the horizon hard and blend back toward a plain *hold* of the last stamped frame, so a low-confidence clock estimate never lets the Taylor term run wild over a long `dt`.

This note specifies a single allocation-free pure function — `predictiveExtrapolateInto()` — that:

1. Takes a trajectory flat array + `TrajectorySpec` + a *requested* forward `dt` (seconds, past the last frame) + a `PllUncertainty` estimate `{ sigmaEstimateNs, driftPpm, driftEstimatorEnabled, locked }`.
2. Derives a **confidence-bounded effective horizon** `dtEff <= dtReq` via a documented confidence→max-extrapolation-distance curve.
3. Evaluates the Taylor trajectory at `dtEff` by **reusing `evaluateTrajectoryInto`** (no new evaluator math), then **blends the result toward the order-1 hold value** by a confidence-derived blend weight, so the output degrades gracefully rather than snapping.
4. Returns a small **value-domain confidence proxy** (`±` band per the `|v_i|·sigma_dt` first-order propagation) and the clamp decision, for callers that want to gate or crossfade on it.

It is the natural home for the "interpolate within stamped data (safe) vs extrapolate beyond the newest frame (risky, confidence-bounded)" classification the subsystem map flags as an unfilled seam.

## Why this exists — the problem it solves

The consumer audio thread wants the freshest possible control values at the instant a sample is *audible* — that instant is `t` (now) or `t + outputBuffer` (the render quantum currently being filled), which is generally *later* than the producer's newest stamped frame timestamp `cachedTimestampNs`. The gap is the **prediction horizon**. Filling it with a stale held frame adds latency; filling it with an unbounded Taylor extrapolation adds *risk* — a large `v_i` over a long `dt` produces a wild excursion exactly when the clock estimate is least trustworthy.

The PLL already knows how trustworthy its mapping is. `ConsumerClockRecovery.sigmaEstimateNs` is an EWMA of `|residual|` in ns (`_sigmaEwma`); `driftPpm` is `_driftRate · 1e6`. The Mahalanobis outlier gate already reasons in sigma-multiples (`OUTLIER_SIGMA_DEFAULT = 6`). But:

- There is **no horizon/uncertainty coupling** anywhere. `evaluateInto` / `evaluateAtSampleOffset` take a deterministic `dt`; nothing scales confidence with how far past `cachedTimestampNs` the prediction reaches.
- `sigmaEstimateNs` is a *mean-absolute-deviation-like* dispersion, **not** a variance/stddev and **not** horizon-scaled. There is no `±ns` bound at a future `consumerNs`.
- `sigmaEstimateNs` is **0 pre-warmup** and when the gate is inactive (`_sigmaEwma === 0`). The module must treat sigma=0 as *"unknown / seeding"*, **not** *"zero uncertainty"* — otherwise a cold PLL would (wrongly) be granted maximum extrapolation.
- `driftPpm` is 0 unless `enableDriftEstimator: true` at construction. The drift-uncertainty term must check `driftEstimatorEnabled` and degrade gracefully when drift is unmodeled.
- No conversion of ns-domain PLL uncertainty into the trajectory's **output-value domain** exists. A `dt` confidence band (ns) must be pushed through the Taylor derivative (`value_uncertainty ≈ |v_i|·sigma_dt` for `order >= 2`) to yield a per-sample value interval — that mapping is absent.

## What's already in place (reuse, do not duplicate)

1. **Forward Taylor math** — `evaluateTrajectoryInto(flat, spec, dt, out)` (`src/trajectory.ts:96-153`), f64/f32 overloads. `order=1: out[i]=p_i`; `order=2: out[i]=p_i+v_i·dt`; `order=3: out[i]=p_i+v_i·dt+½·a_i·dt²`. Forward `dt` already valid. **The module calls this verbatim — no new evaluator.**
2. **Per-sample runaway clamps** — `velocityClamp` / `accelerationClamp` / `maxDeltaPerSample` / `overflowFallback` ('hold'|'linear'|'saturate') on the clamped path (`specHasClamps` gate at `trajectory.ts:90`; `evaluateClamped` at `:159`). These bound a *single huge derivative* over a long `dt`. They are **orthogonal** to this module's *horizon* clamp: clamps bound the value excursion; this module bounds *how far forward we trust the clock*. Both compose — `predictiveExtrapolateInto` passes the spec straight through so any clamps the schema declares still fire.
3. **Hermite reference** — `evaluateHermiteTrajectoryInto(flatPrev, flatCurr, spec, t, segmentSeconds, out)` (`trajectory.ts:334`) is the flat-array + spec pure-function *shape* this module mirrors (same import idiom, same f64/f32 overload pattern, same `out`-param allocation-free contract). It is the bounded interpolation case and is *not* reused for math — only as the canonical shape.
4. **PLL uncertainty surface** — `ConsumerClockRecovery`: `get sigmaEstimateNs()` (`:570`, returns `_sigmaEwma`), `get driftPpm()` (`:585`), `get driftEstimatorEnabled()` (`:577`), `get locked()` (`:535`), `static OUTLIER_SIGMA_DEFAULT = 6` (`:277`). The module accepts a *plain struct* of these reads, **not** a `ConsumerClockRecovery` instance — keeps the module decoupled, pure, and trivially testable without standing up a PLL.

## Design — the confidence→max-extrapolation-distance curve

### Inputs

```ts
// src/predictiveExtrapolation.ts

import type { TrajectorySpec } from "./schema.js";
import { evaluateTrajectoryInto } from "./trajectory.js";

/** A plain snapshot of the PLL's uncertainty-adjacent reads. Decoupled from
 *  ConsumerClockRecovery so this module stays pure + test-standalone.
 *  Construct via { sigmaEstimateNs: pll.sigmaEstimateNs, driftPpm: pll.driftPpm,
 *  driftEstimatorEnabled: pll.driftEstimatorEnabled, locked: pll.locked }. */
export interface PllUncertainty {
  /** EWMA of |residual| in ns. 0 == unknown/seeding (NOT zero uncertainty). */
  readonly sigmaEstimateNs: number;
  /** Drift estimate in ppm. Meaningful only when driftEstimatorEnabled. */
  readonly driftPpm: number;
  /** Whether driftPpm is a modeled quantity (vs structurally 0). */
  readonly driftEstimatorEnabled: boolean;
  /** Whether the PLL has locked. Cold/unlocked => conservative horizon. */
  readonly locked: boolean;
}

export interface PredictiveExtrapolationConfig {
  /** Forward horizon (seconds) at/under which the prediction is trusted at
   *  FULL strength (blend weight 1, dtEff == dtReq). Default 0.0 — i.e. by
   *  default ANY forward step is uncertainty-scaled. A caller that knows its
   *  output-buffer is always safe can raise this. */
  readonly trustedHorizonSeconds?: number;
  /** Forward horizon (seconds) at/above which the prediction is fully
   *  suppressed (blend weight 0, pure hold). Default 0.020 s (~1 audio
   *  block @ the low end of the 5-50ms control floor). */
  readonly maxHorizonSeconds?: number;
  /** Sigma (ns) at which confidence is treated as fully degraded (curve
   *  bottoms out). Default 2_000_000 ns (2 ms) — beyond ~2ms residual
   *  dispersion the clock map is too loose to extrapolate on. */
  readonly sigmaFloorNs?: number;
  /** Conservative sigma (ns) assumed when sigmaEstimateNs === 0 (seeding) or
   *  the PLL is unlocked. Default == sigmaFloorNs (treat unknown as worst). */
  readonly seedingSigmaNs?: number;
}

export interface PredictiveExtrapolationResult {
  /** Effective forward dt actually evaluated (seconds), after horizon clamp.
   *  <= the requested dt; >= 0. */
  readonly dtEffectiveSeconds: number;
  /** Blend weight in [0,1] applied: out = w * taylor(dtEff) + (1-w) * hold. */
  readonly confidenceWeight: number;
  /** First-order value-domain uncertainty proxy: max over samples of
   *  |v_i| * sigmaDtSeconds (order>=2) plus the drift+horizon term. 0 for
   *  order==1 (positions only — no derivative to propagate dt error through).
   *  Units == the trajectory's output value units (per second of dt). */
  readonly valueUncertainty: number;
  /** True when the requested dt was clamped below dtReq (horizon hit). */
  readonly clamped: boolean;
}
```

### The curve

Two independent confidence factors are computed, each in `[0,1]`, then multiplied into a single `confidenceWeight w`. `w` does double duty: it scales the *effective horizon* `dtEff` **and** the *blend toward hold*.

**1. Sigma confidence `c_sigma`** — how trustworthy is the clock-offset estimate.

```
sigmaUsed = (sigmaEstimateNs > 0 && locked) ? sigmaEstimateNs : seedingSigmaNs
c_sigma   = clamp01( 1 - sigmaUsed / sigmaFloorNs )
```

- `sigmaEstimateNs === 0` (pre-warmup / inactive gate) ⇒ substitute `seedingSigmaNs` (default = `sigmaFloorNs`), so a cold PLL yields `c_sigma ≈ 0` — conservative, *not* over-confident.
- `!locked` ⇒ same conservative substitution.
- Linear ramp: at `sigma = 0` (and locked) `c_sigma = 1`; at `sigma >= sigmaFloorNs` `c_sigma = 0`. Linear is chosen over exponential for cheapness and because the OUTLIER_SIGMA gate already does the heavy nonlinear rejection upstream — this is a soft secondary derate, not a detector.

**2. Horizon confidence `c_horizon`** — how far past the newest frame we are reaching, as a fraction of the allowed window.

```
dtReqAbs = max(0, dtReq)                         // backward dt => treat as 0 (that's interpolation, not our job)
if dtReqAbs <= trustedHorizon:  c_horizon = 1
elif dtReqAbs >= maxHorizon:    c_horizon = 0
else: c_horizon = 1 - (dtReqAbs - trustedHorizon) / (maxHorizon - trustedHorizon)
```

A linear taper between the trusted and max horizons. The drift term *shrinks* the effective max horizon when drift is modeled and large (drift compounds the offset error over the horizon):

```
if driftEstimatorEnabled:
  // |driftPpm|*1e-6 is fractional clock error per second; over dtReqAbs it
  // adds |driftPpm|*1e-6*dtReqAbs seconds of offset uncertainty. Fold it in
  // by inflating the horizon fraction.
  driftHorizonInflation = abs(driftPpm) * 1e-6 * dtReqAbs / max(maxHorizon, 1e-9)
  c_horizon = clamp01( c_horizon - driftHorizonInflation )
```

When `driftEstimatorEnabled` is false, `driftPpm` is structurally 0 and the term vanishes — graceful degradation as required.

**3. Combine.**

```
w        = c_sigma * c_horizon                  // in [0,1]
dtEff    = w * dtReqAbs                          // shrink the horizon by confidence
```

`dtEff` is what gets fed to `evaluateTrajectoryInto`. Note `dtEff <= dtReqAbs` always, and `dtEff = dtReqAbs` only when `w = 1` (locked, tiny sigma, within trusted horizon, no drift inflation).

### The blend toward hold

The Taylor evaluation at `dtEff` is blended with the **hold** value (the trajectory's `order-1` position term `p_i`, i.e. `evaluateTrajectoryInto(flat, {...spec, order:1}, 0, hold)` — equivalently `dt=0`). The blend uses the *same* `w`:

```
out[i] = w * taylor_i(dtEff) + (1 - w) * hold_i
```

- `w = 1` ⇒ pure full-strength forward extrapolation at the requested horizon.
- `w = 0` ⇒ pure hold of the newest stamped position (zero risk; matches the conservative behavior of a stale frame).
- in between ⇒ a confidence-weighted crossfade. Because `dtEff` *also* shrinks with `w`, low confidence both shortens the reach AND fades toward hold — a double derate that is intentionally aggressive on the conservative side (low-confidence prediction never runs wild, per the brief).

This is allocation-free: the module evaluates Taylor into the caller-provided `out`, computes hold into a caller-provided scratch (or, for `order==1`, hold *is* the Taylor result and no blend is needed), and does the lerp in place.

### Value-domain uncertainty proxy

First-order propagation of the clock uncertainty `sigma_dt` (seconds) through the Taylor derivative. For `order >= 2`, `∂out_i/∂dt = v_i (+ a_i·dt)`, so to first order `δout_i ≈ |v_i| · sigma_dt`. We report the max over samples:

```
sigmaDtSeconds = sigmaUsed * 1e-9                                 // ns -> s
                 + (driftEstimatorEnabled ? abs(driftPpm)*1e-6*dtEff : 0)
valueUncertainty = (order >= 2) ? max_i(|v_i|) * sigmaDtSeconds : 0
```

For `order == 1` there is no derivative to propagate `dt` error through, so the proxy is 0 (the only uncertainty is the hold itself, which the module does not model). This is a *proxy*, not a calibrated confidence interval — `sigmaEstimateNs` is MAD-like, not a stddev — and the doc comment says so explicitly. Callers can crossfade or gate on it (e.g. "if `valueUncertainty > X`, fall to hold").

### Signature

```ts
/**
 * Confidence-bounded forward extrapolation. Reuses evaluateTrajectoryInto for
 * the Taylor math; clamps the effective horizon and blends toward hold as PLL
 * uncertainty grows. Allocation-free: writes into `out`; uses `holdScratch`
 * (>= sampleCount) for the order>=2 hold term (ignored for order==1).
 *
 * dtReqSeconds is the FORWARD step past the newest stamped frame (seconds).
 * Backward/zero dt is treated as 0 (that is interpolation, handled elsewhere).
 */
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
```

Implementation signature (matching `evaluateTrajectoryInto`'s union-overload idiom):
`(flat: Float64Array|Float32Array, spec, dtReq, pll, out: Float64Array|Float32Array, holdScratch: Float64Array|Float32Array, config?) => PredictiveExtrapolationResult`.

The returned `PredictiveExtrapolationResult` is a small fresh object. **This is allocated** — but the brief's allocation-free requirement is about the *hot path that fills sample data* (`out`/`holdScratch` are caller-provided, the Taylor + lerp loop allocates nothing). A 4-field result object per call is the same shape as `SpscPullResult` / `telemetry()` elsewhere in the codebase and is acceptable; a `void` overload that omits the result is a possible MVP2 optimization if a caller proves it hot. (Noted as a risk below.)

## Confidence → max-extrapolation-distance reference table

With defaults (`trustedHorizon=0`, `maxHorizon=20ms`, `sigmaFloor=2ms`, locked, drift off):

| sigmaEstimateNs | c_sigma | dtReq=2ms ⇒ c_horizon | w | dtEff | behavior |
|---|---|---|---|---|---|
| 0 (seeding) | 0.0 | 0.90 | 0.00 | 0 ms | pure hold (cold PLL never extrapolates) |
| 100_000 (0.1ms) | 0.95 | 0.90 | 0.855 | 1.71 ms | near-full forward, slight fade |
| 500_000 (0.5ms) | 0.75 | 0.90 | 0.675 | 1.35 ms | confident-ish, moderate reach |
| 1_000_000 (1ms) | 0.50 | 0.90 | 0.45 | 0.90 ms | half-reach, half-blend |
| 2_000_000 (2ms) | 0.00 | 0.90 | 0.00 | 0 ms | sigma floor ⇒ pure hold |
| unlocked | 0.0 (seed) | — | 0.00 | 0 ms | pure hold until lock |

And the horizon taper at fixed `c_sigma=1` (sigma small, locked):

| dtReq | c_horizon | w | dtEff |
|---|---|---|---|
| 0 ms | 1.00 | 1.00 | 0 ms |
| 5 ms | 0.75 | 0.75 | 3.75 ms |
| 10 ms | 0.50 | 0.50 | 5.0 ms |
| 20 ms | 0.00 | 0.00 | 0 ms (full horizon ⇒ hold) |

The two derates compound: deep horizon AND high sigma drive `w → 0` fast, which is the desired "never let low-confidence prediction run wild" property.

## Design space — alternatives considered

### Shape (a): bound the horizon only (hard clamp `dtEff`, no blend) — rejected

Clamp `dt` to a confidence-derived max and feed it to `evaluateTrajectoryInto` unchanged; no crossfade toward hold.

| Pro | Con |
|---|---|
| Simplest — one `min()` and one evaluator call. | Snaps: at the clamp boundary the output jumps from "extrapolated at dtMax" to "extrapolated at a smaller dt" discontinuously as sigma crosses a threshold. Audible as a click in the control signal. |
| Reuses the existing per-sample clamps for excursion bounding. | Doesn't degrade to *hold* — even at the clamp it's still extrapolating, just less far. Cold PLL still extrapolates a little. |

### Shape (b): horizon clamp + blend toward hold *(recommended)*

The shape specified above. `w` scales both `dtEff` and the hold crossfade.

| Pro | Con |
|---|---|
| Continuous: as sigma rises or horizon deepens, output smoothly fades from forward-extrapolated to held — no click. | Needs a `holdScratch` buffer for order>=2 (one extra caller-provided array). |
| Cold/unlocked PLL ⇒ exactly hold (`w=0`), the provably-safe behavior. | Two derates compounding can be *too* conservative for a caller who wants aggressive prediction; tunable via `trustedHorizonSeconds`. |
| Composes with the existing per-sample clamps (passed through). | Slightly more math than (a). Still trivially allocation-free in the hot loop. |

### Shape (c): full Kalman-style predictive filter — rejected for MVP

A proper state-space predictor maintaining covariance, producing calibrated `±` intervals.

| Pro | Con |
|---|---|
| Statistically principled confidence intervals. | `sigmaEstimateNs` is MAD-like, not a covariance — would need a real variance estimator added to the PLL (out of scope; mutating PLL is forbidden by brief). |
| | Heavy: per-field state, allocation, far beyond a pure function. Wrong altitude for a standalone module. |

Shape (b) is the recommendation: it satisfies the brief (reuse evaluator math, clamp + blend on uncertainty, allocation-free hot path, no Bridge mutation) at the right altitude, and the value-uncertainty proxy gives callers a forward path to (c) later without committing now.

## Concrete file plan

```
src/
  predictiveExtrapolation.ts                    (~180-220 LOC, net-new, pure)
    export interface PllUncertainty
    export interface PredictiveExtrapolationConfig
    export interface PredictiveExtrapolationResult
    export function predictiveExtrapolateInto(...)  // f64/f32 overloads + impl
    // internal: confidence curve helpers (clamp01, c_sigma, c_horizon) inlined
    //           into the impl so the hot path stays one function call deep.

tests/
  Bridge.predict.test.ts                        (~200-260 LOC, net-new)
    // Numbered pins continue the global sequence (last seen is 80 in
    // Bridge.trajectory; this suite opens its own header pin list starting
    // at the next free number — orchestrator owns the final numbering when it
    // wires the suite into package.json's `test`/`test:unit` before
    // Bridge.concurrent). Pins:
    //  1. cold/seeding PLL (sigma=0) => pure hold, dtEff==0, w==0, clamped
    //  2. confident locked PLL, dt within trusted horizon => full extrapolation
    //     bit-equals evaluateTrajectoryInto at dtReq (w==1)
    //  3. mid-sigma => dtEff and out are the documented w*taylor + (1-w)*hold lerp
    //  4. deep horizon (dt >= maxHorizon) => c_horizon==0 => pure hold
    //  5. order==1 schema => valueUncertainty==0, out == positions (hold==taylor)
    //  6. drift inflation: driftEstimatorEnabled + large driftPpm shrinks dtEff
    //     vs driftEstimatorEnabled=false control
    //  7. valueUncertainty == max|v_i| * sigmaDtSeconds for an order>=2 fixture
    //  8. allocation-free: out/holdScratch mutated in place, two calls reuse them
    //  9. f32 overload parity with f64 within fp tolerance
```

Net-new files only. Does **not** touch `src/index.ts`, `package.json`, `CHANGELOG.md`, `ROADMAP.md`, `README.md`, `Bridge.ts`, or anything git-related — the orchestrator wires the export, adds the test to both npm scripts (before `Bridge.concurrent.test.ts`), and bumps the version afterward.

## What this is NOT

- **Not a PLL mutation.** `ConsumerClockRecovery` is untouched; the module consumes a plain `PllUncertainty` snapshot. No new variance estimator, no new PLL method.
- **Not a Bridge API.** `Bridge.ts` is not edited. A future patch could add a thin `Bridge.predictInto(...)` delegator, but that is the orchestrator's call, not this track's.
- **Not a calibrated confidence interval.** `valueUncertainty` is a first-order proxy off a MAD-like sigma; documented as such.
- **Not a replacement for the per-sample clamps.** Those bound value excursion for a single huge derivative; this bounds the *horizon* on clock uncertainty. They compose — the spec (with any clamps) is passed straight through to `evaluateTrajectoryInto`.
- **Not auto-wired into the worklet hot path.** It's a standalone pure function callers opt into; the existing `pullEvaluatedLatest` / `evaluateAtSampleOffset` deterministic paths are unchanged.

— end of design note —
