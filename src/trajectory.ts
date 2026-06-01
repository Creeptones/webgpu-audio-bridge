/**
 * Trajectory evaluation — Taylor extrapolation of interleaved (p, v, [a])
 * streams produced by `f{32,64}TrajectoryArray(n, { order })`.
 *
 * The producer packs N samples of position (and velocity, acceleration if
 * order>=3, jerk if order=4) into a flat interleaved typed-array of
 * `N * order` elements:
 *
 *     order=1:  [p0, p1, ..., p_{N-1}]
 *     order=2:  [p0, v0, p1, v1, ..., p_{N-1}, v_{N-1}]
 *     order=3:  [p0, v0, a0, p1, v1, a1, ..., p_{N-1}, v_{N-1}, a_{N-1}]
 *     order=4:  [p0, v0, a0, j0, p1, v1, a1, j1, ...]   (jerk lane, 0.9.80)
 *
 * The consumer calls `evaluateTrajectoryInto(flat, spec, dt, out)` to
 * compute the extrapolated scalar at elapsed time `dt` for each sample.
 *
 *     order=1:  out[i] = p_i                                       (dt ignored)
 *     order=2:  out[i] = p_i + v_i · dt                            (linear Taylor)
 *     order=3:  out[i] = p_i + v_i · dt + ½ · a_i · dt²            (quadratic Taylor)
 *     order=4:  out[i] = p_i + v_i · dt + ½ · a_i · dt² + ⅙ · j_i · dt³  (cubic Taylor)
 *
 * ─── Units ────────────────────────────────────────────────────────────────
 *
 * `dt` is unit-agnostic. The producer chose the units of the velocity and
 * acceleration components when it packed the trajectory; the consumer
 * supplies a matching `dt`. Examples:
 *   - velocity in units/second  → dt in seconds
 *   - velocity in units/nanosecond → dt in ns
 *
 * The evaluator does not convert or check units. Mismatched units produce
 * mathematically wrong but silently-accepted output.
 *
 * ─── Clock recovery ──────────────────────────────────────────────────────
 *
 * The consumer also owns clock recovery. Typical pattern at the top of an
 * AudioWorklet's `process()`:
 *
 *     const consumerNowNs = currentTime * 1e9;       // AudioContext seconds → ns
 *     const dtNs = consumerNowNs - Number(frame.tMacroNs - this.epochNs);
 *     // ...evaluate at dt = dtNs * 1e-9 if velocity is in units/sec
 *     evaluateTrajectoryInto(frame.vEff, spec, dtNs * 1e-9, out);
 *
 * Pillar 2 of the Phase-Locked Extrapolation plan replaces this hand-rolled
 * clock arithmetic with a nanosecond PLL inside the Bridge; Pillar 3 wraps
 * pull + PLL + evaluateInto into a single `bridge.pullEvaluated(out, i)`
 * hot-path call. Until those land, the consumer wires the dt by hand and
 * uses this helper directly.
 *
 * ─── Safety clamps (0.6.7) ───────────────────────────────────────────────
 *
 * Long extrapolation distances on order=2 / order=3 are sensitive to
 * transient producer values: a single huge velocity sample drives the
 * audio block to wild excursions. `TrajectorySpec` accepts four optional
 * clamp fields (`velocityClamp`, `accelerationClamp`, `maxDeltaPerSample`,
 * `overflowFallback`) that the evaluator honors on a separate clamped
 * path. Behavior:
 *
 *   - No clamp set → fast path; bit-exact equal to the 0.6.6 evaluator
 *     across all orders.
 *   - Any clamp set → clamped path. The spec is resolved once at call
 *     entry into a small per-call config so the inner loop stays
 *     branch-free per-spec (no per-sample `if` on metadata).
 *
 *   `velocityClamp` / `accelerationClamp` clamp the loaded derivative
 *   into `[-clamp, +clamp]` before the Taylor multiply.
 *   `maxDeltaPerSample` is consulted after the Taylor sum: if the
 *   would-be output is more than `maxDelta` away from the previous
 *   output, the configured fallback runs (`'hold'` freezes; `'linear'`
 *   drops the acceleration term; `'saturate'` (default) clamps the
 *   would-be output into the per-sample band).
 *
 * ─── Performance ─────────────────────────────────────────────────────────
 *
 * Allocation-free: the caller owns the output buffer; we walk the flat
 * input once with no boxing, no closures, no temporary arrays. The switch
 * on `order` happens once per call (out of the loop); the inner loops are
 * branch-free. f32 vs f64 dispatch is via TS overload — runtime is a
 * single set of arithmetic ops; the typed-array element-write does the
 * f32 truncation automatically when `out` is a Float32Array.
 *
 * Expected per-call cost (N=1000, order=2): ~5–10 μs on a modern x86.
 * Expected per-sample cost: ~5–10 ns. Target is ≤ 50 ns/sample (plan's
 * pin #10 budget) so we have comfortable headroom; the hot loop is six
 * ALU ops (two loads, one multiply, one add, one store, one index).
 */

import type { TrajectorySpec } from "./schema.js";
import { wrapSymmetric, shortestArcDelta, TWO_PI } from "./circular.js";

/** Does this spec carry any per-sample safety clamp? Used to select the
 *  fast path (no clamps, 0.6.6 bit-exact) vs the clamped path. */
function specHasClamps(spec: TrajectorySpec): boolean {
  return (
    spec.velocityClamp !== undefined ||
    spec.accelerationClamp !== undefined ||
    spec.maxDeltaPerSample !== undefined
  );
}

export function evaluateTrajectoryInto(
  flat: Float64Array,
  spec: TrajectorySpec,
  dt: number,
  out: Float64Array,
): void;
export function evaluateTrajectoryInto(
  flat: Float32Array,
  spec: TrajectorySpec,
  dt: number,
  out: Float32Array,
): void;
export function evaluateTrajectoryInto(
  flat: Float64Array | Float32Array,
  spec: TrajectorySpec,
  dt: number,
  out: Float64Array | Float32Array,
): void {
  const { order, sampleCount } = spec;
  if (out.length < sampleCount) {
    throw new Error(
      `evaluateTrajectoryInto: out length ${out.length} < sampleCount ${sampleCount}`,
    );
  }
  const required = sampleCount * order;
  if (flat.length < required) {
    throw new Error(
      `evaluateTrajectoryInto: flat length ${flat.length} < sampleCount * order (${required})`,
    );
  }
  if (specHasClamps(spec)) {
    evaluateClamped(flat, spec, dt, out);
    return;
  }
  switch (order) {
    case 1: {
      for (let i = 0; i < sampleCount; i++) {
        out[i] = flat[i]!;
      }
      return;
    }
    case 2: {
      for (let i = 0; i < sampleCount; i++) {
        const j = i * 2;
        out[i] = flat[j]! + flat[j + 1]! * dt;
      }
      return;
    }
    case 3: {
      const halfDt2 = 0.5 * dt * dt;
      for (let i = 0; i < sampleCount; i++) {
        const j = i * 3;
        out[i] = flat[j]! + flat[j + 1]! * dt + flat[j + 2]! * halfDt2;
      }
      return;
    }
    case 4: {
      // Cubic Taylor (0.9.80): p + v·dt + ½a·dt² + ⅙j·dt³. Coefficients
      // resolved once; same left-to-right (no implicit FMA) accumulation as
      // the lower orders so the WASM scalar/SIMD ports stay bit-exact.
      const halfDt2 = 0.5 * dt * dt;
      const sixthDt3 = (1 / 6) * dt * dt * dt;
      for (let i = 0; i < sampleCount; i++) {
        const j = i * 4;
        out[i] =
          flat[j]! +
          flat[j + 1]! * dt +
          flat[j + 2]! * halfDt2 +
          flat[j + 3]! * sixthDt3;
      }
      return;
    }
  }
}

/** Clamped trajectory evaluator (0.6.7). Engaged whenever any clamp field
 *  is set on `spec`. The order switch and the per-spec config (which
 *  clamps are active, fallback id) are resolved once at function entry so
 *  the inner loop stays branch-free per call. */
function evaluateClamped(
  flat: Float64Array | Float32Array,
  spec: TrajectorySpec,
  dt: number,
  out: Float64Array | Float32Array,
): void {
  const { order, sampleCount } = spec;
  // Resolve clamps into local primitives. Use +Infinity when no clamp is
  // set so `Math.max(-INF, Math.min(INF, x)) === x` becomes a no-op — keeps
  // the inner loop straight-line without per-sample branching.
  const vClamp = spec.velocityClamp ?? Infinity;
  const aClamp = spec.accelerationClamp ?? Infinity;
  const hasDelta = spec.maxDeltaPerSample !== undefined;
  const maxDelta = spec.maxDeltaPerSample ?? Infinity;
  // Fallback id encoded as a small int so the inner-loop branch reduces to
  // an integer compare. Only consulted when hasDelta && violation; the
  // hot per-sample path is the unclamped Taylor.
  //   0 = saturate (default), 1 = hold, 2 = linear.
  let fallbackId = 0;
  if (spec.overflowFallback === "hold") fallbackId = 1;
  else if (spec.overflowFallback === "linear") fallbackId = 2;

  // Order-4 (jerk) clamps are deferred (0.9.80): no producer-overflow incident
  // has driven the need, and the linear/saturate fallback semantics for a cubic
  // Taylor term want their own design pass. Throw rather than silently dropping
  // the jerk term, mirroring the schema-time guards.
  if (order === 4) {
    throw new Error(
      "evaluateTrajectoryInto: safety clamps are not supported for order=4 trajectories yet (0.9.80); evaluate the order-4 cubic Taylor on the clamp-free fast path",
    );
  }

  switch (order) {
    case 1: {
      // Order-1 is positions only — clamps on derivatives are dormant.
      // maxDeltaPerSample still applies (positions can carry transients).
      let prev = 0;
      for (let i = 0; i < sampleCount; i++) {
        const p = flat[i]!;
        if (hasDelta && i > 0) {
          const d = p - prev;
          if (d > maxDelta || d < -maxDelta) {
            if (fallbackId === 1) {
              out[i] = prev;
              continue;
            }
            // 'linear' has nothing extra to drop on order-1 (no acceleration);
            // fall through to saturate so order-1 + linear ≡ saturate.
            const saturated = d > maxDelta ? prev + maxDelta : prev - maxDelta;
            out[i] = saturated;
            prev = saturated;
            continue;
          }
        }
        out[i] = p;
        prev = p;
      }
      return;
    }
    case 2: {
      let prev = 0;
      for (let i = 0; i < sampleCount; i++) {
        const j = i * 2;
        const p = flat[j]!;
        let v = flat[j + 1]!;
        if (v > vClamp) v = vClamp;
        else if (v < -vClamp) v = -vClamp;
        let y = p + v * dt;
        if (hasDelta && i > 0) {
          const d = y - prev;
          if (d > maxDelta || d < -maxDelta) {
            if (fallbackId === 1) {
              y = prev; // hold
            } else if (fallbackId === 2) {
              // 'linear' on order=2 collapses to the same y (no acceleration
              // term to drop); fall through to saturate so behavior is
              // documented and stable.
              y = d > maxDelta ? prev + maxDelta : prev - maxDelta;
            } else {
              y = d > maxDelta ? prev + maxDelta : prev - maxDelta; // saturate
            }
          }
        }
        out[i] = y;
        prev = y;
      }
      return;
    }
    case 3: {
      const halfDt2 = 0.5 * dt * dt;
      let prev = 0;
      for (let i = 0; i < sampleCount; i++) {
        const j = i * 3;
        const p = flat[j]!;
        let v = flat[j + 1]!;
        let a = flat[j + 2]!;
        if (v > vClamp) v = vClamp;
        else if (v < -vClamp) v = -vClamp;
        if (a > aClamp) a = aClamp;
        else if (a < -aClamp) a = -aClamp;
        let y = p + v * dt + a * halfDt2;
        if (hasDelta && i > 0) {
          const d = y - prev;
          if (d > maxDelta || d < -maxDelta) {
            if (fallbackId === 1) {
              y = prev; // hold
            } else if (fallbackId === 2) {
              // 'linear' = drop acceleration term, then re-check vs band.
              const yLin = p + v * dt;
              const dLin = yLin - prev;
              if (dLin > maxDelta) y = prev + maxDelta;
              else if (dLin < -maxDelta) y = prev - maxDelta;
              else y = yLin;
            } else {
              y = d > maxDelta ? prev + maxDelta : prev - maxDelta; // saturate
            }
          }
        }
        out[i] = y;
        prev = y;
      }
      return;
    }
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * Hermite cubic interpolation (0.7.3 — Track 1 of the King roadmap)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The Taylor path above reconstructs a sample value from ONE frame's
 * derivatives. At frame boundaries that gives a C⁰-continuous signal — the
 * value matches but the slope can step, which manifests as 60 Hz harmonic
 * energy on slowly-varying envelopes (the "zipper" sound).
 *
 * Cubic Hermite interpolation between two consecutive frames matches BOTH
 * position and velocity at each endpoint, so the reconstructed signal is
 * C¹-continuous across frame boundaries. The first-derivative step is
 * eliminated; the harmonic energy drops by ~the ratio of sinc² (linear) to
 * sinc⁴ (cubic) per harmonic — measurable, audible, and worth the price
 * of holding the previous frame's flat array.
 *
 * Standard cubic-Hermite basis on local parameter t ∈ [0, 1]:
 *
 *     h00(t) =  2t³ − 3t² + 1     (1 at t=0, 0 at t=1; deriv 0 at both)
 *     h10(t) =       t³ − 2t² + t (0 at endpoints; deriv 1 at t=0, 0 at t=1)
 *     h01(t) = −2t³ + 3t²         (0 at t=0, 1 at t=1; deriv 0 at both)
 *     h11(t) =       t³ − t²      (0 at endpoints; deriv 0 at t=0, 1 at t=1)
 *
 *     p(t) = h00·P0 + h10·M0 + h01·P1 + h11·M1
 *
 * P0, P1 = position at the two endpoints (sample at frame N, frame N+1).
 * M0, M1 = TANGENT in local-t space at the endpoints. The tangent in
 *          producer units (e.g. units/second) equals the producer-stamped
 *          velocity; to use it as a local-t tangent we scale by the
 *          segment's wall-clock duration `segmentSeconds`. That's the only
 *          place the time unit enters the math — once velocity is
 *          re-expressed as "change per unit of t", the basis polynomials
 *          are unit-free.
 *
 * Order=1 trajectories carry no velocity, so 'hermite' is rejected at
 * schema-construction time. This cubic path IGNORES the acceleration lane on
 * order>=3 (standard cubic Hermite is C¹, not C²); consume it via the
 * 'quintic-hermite' mode (`evaluateQuinticHermiteTrajectoryInto`, 0.9.80)
 * below for full C² continuity, or 'septic-hermite' (order-4 jerk lane) for C³.
 *
 * Allocation-free: the caller owns prev/curr/out buffers. No clamp path
 * yet — clamps land in a follow-up when there's a use case (the linear
 * Taylor clamps were driven by real producer overflow incidents; we don't
 * have those for hermite yet, so we don't pay the dispatch cost). */

/** Cubic Hermite reconstruction between two consecutive trajectory frames.
 *  Required `spec.order >= 2` (velocities at endpoints). `t` is the
 *  normalized position in `[0, 1]` from `flatPrev` (the older frame) to
 *  `flatCurr`; `segmentSeconds` is the wall-clock duration of the segment
 *  in the producer's velocity units (typically seconds, matching
 *  velocity-in-units-per-second). 0.7.3. */
export function evaluateHermiteTrajectoryInto(
  flatPrev: Float64Array,
  flatCurr: Float64Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float64Array,
): void;
export function evaluateHermiteTrajectoryInto(
  flatPrev: Float32Array,
  flatCurr: Float32Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float32Array,
): void;
export function evaluateHermiteTrajectoryInto(
  flatPrev: Float64Array | Float32Array,
  flatCurr: Float64Array | Float32Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float64Array | Float32Array,
): void {
  const { order, sampleCount } = spec;
  if (order < 2) {
    // Mirrors the schema-construction guard so direct callers that bypass
    // the DSL get the same error.
    throw new Error(
      `evaluateHermiteTrajectoryInto: spec.order must be >= 2 (hermite needs endpoint velocities), got order=${order}`,
    );
  }
  if (!Number.isFinite(t)) {
    throw new Error(`evaluateHermiteTrajectoryInto: t must be finite, got ${t}`);
  }
  if (!Number.isFinite(segmentSeconds)) {
    throw new Error(
      `evaluateHermiteTrajectoryInto: segmentSeconds must be finite, got ${segmentSeconds}`,
    );
  }
  if (out.length < sampleCount) {
    throw new Error(
      `evaluateHermiteTrajectoryInto: out length ${out.length} < sampleCount ${sampleCount}`,
    );
  }
  const required = sampleCount * order;
  if (flatPrev.length < required) {
    throw new Error(
      `evaluateHermiteTrajectoryInto: flatPrev length ${flatPrev.length} < sampleCount * order (${required})`,
    );
  }
  if (flatCurr.length < required) {
    throw new Error(
      `evaluateHermiteTrajectoryInto: flatCurr length ${flatCurr.length} < sampleCount * order (${required})`,
    );
  }

  // Resolve the basis once per call; the inner loop reuses these coefficients
  // across every sample (the basis is signal-independent).
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  // Velocity → local-t tangent: multiply once per coefficient so the hot
  // loop is six multiplies + three adds per sample regardless of order.
  const h10s = h10 * segmentSeconds;
  const h11s = h11 * segmentSeconds;

  // The per-sample stride is `order`; for order=2 it's (p, v), for order>=3
  // it's (p, v, a, …). The acceleration (and jerk) lanes are ignored on the
  // cubic path; consume acceleration via 'quintic-hermite'
  // (`evaluateQuinticHermiteTrajectoryInto`) for C², and jerk via
  // 'septic-hermite' for C³ (both 0.9.80).
  const stride = order;
  for (let i = 0; i < sampleCount; i++) {
    const j = i * stride;
    const p0 = flatPrev[j]!;
    const m0 = flatPrev[j + 1]!;
    const p1 = flatCurr[j]!;
    const m1 = flatCurr[j + 1]!;
    out[i] = h00 * p0 + h10s * m0 + h01 * p1 + h11s * m1;
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * Quintic Hermite interpolation (0.9.80 — Apollo Mission Phase I, C²)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Cubic Hermite (above) matches endpoint position + velocity → C¹. The second
 * derivative still STEPS at the frame seam, leaving a residual click on
 * aggressive FM/LFO modulation. Quintic Hermite additionally matches endpoint
 * ACCELERATION, giving a C²-continuous reconstruction (continuous curvature
 * across boundaries → the second-derivative step is gone).
 *
 * Degree-5 basis on local parameter t ∈ [0, 1] (see docs/quintic-septic-
 * hermite-design.md for the derivation + endpoint/partition verification):
 *
 *     H0(t) =  1 − 10t³ + 15t⁴ −  6t⁵    → p0
 *     H1(t) =  t −  6t³ +  8t⁴ −  3t⁵    → m0 = T·v0   (tangent in local-t)
 *     H2(t) = ½t² − 3⁄2 t³ + 3⁄2 t⁴ − ½t⁵ → c0 = T²·a0  (curvature in local-t)
 *     H3(t) =      10t³ − 15t⁴ +  6t⁵    → p1
 *     H4(t) =     − 4t³ +  7t⁴ −  3t⁵    → m1 = T·v1
 *     H5(t) =     ½t³ −     t⁴ + ½t⁵     → c1 = T²·a1
 *
 *     p(t) = H0·p0 + H1·(T·v0) + H2·(T²·a0) + H3·p1 + H4·(T·v1) + H5·(T²·a1)
 *
 * T = segmentSeconds. Velocity terms scale by T, acceleration by T² — the only
 * place the time unit enters (endpoint derivatives in producer units → t-space
 * derivatives). The scaling is folded into the basis coefficients once per
 * call, so the per-sample loop is a flat sum just like the cubic path.
 *
 * Requires order >= 3 (acceleration lane at both endpoints). The order-3 wire
 * already carries acceleration, so this is a pure consumer-side reconstruction
 * change — no SAB byte change. On order=4 the jerk lane is present but unused
 * by this evaluator (use 'septic-hermite' to consume it for C³). Allocation-
 * free; no clamp path yet (same rationale as the cubic path). */

/** Quintic Hermite (C²) reconstruction between two consecutive trajectory
 *  frames. Requires `spec.order >= 3` (endpoint accelerations). `t` is the
 *  normalized position in `[0, 1]` from `flatPrev` (older frame) to `flatCurr`;
 *  `segmentSeconds` is the wall-clock segment duration in the producer's
 *  velocity-time units. 0.9.80. */
export function evaluateQuinticHermiteTrajectoryInto(
  flatPrev: Float64Array,
  flatCurr: Float64Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float64Array,
): void;
export function evaluateQuinticHermiteTrajectoryInto(
  flatPrev: Float32Array,
  flatCurr: Float32Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float32Array,
): void;
export function evaluateQuinticHermiteTrajectoryInto(
  flatPrev: Float64Array | Float32Array,
  flatCurr: Float64Array | Float32Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float64Array | Float32Array,
): void {
  const { order, sampleCount } = spec;
  if (order < 3) {
    throw new Error(
      `evaluateQuinticHermiteTrajectoryInto: spec.order must be >= 3 (quintic Hermite needs endpoint accelerations for C²), got order=${order}`,
    );
  }
  if (!Number.isFinite(t)) {
    throw new Error(`evaluateQuinticHermiteTrajectoryInto: t must be finite, got ${t}`);
  }
  if (!Number.isFinite(segmentSeconds)) {
    throw new Error(
      `evaluateQuinticHermiteTrajectoryInto: segmentSeconds must be finite, got ${segmentSeconds}`,
    );
  }
  if (out.length < sampleCount) {
    throw new Error(
      `evaluateQuinticHermiteTrajectoryInto: out length ${out.length} < sampleCount ${sampleCount}`,
    );
  }
  const required = sampleCount * order;
  if (flatPrev.length < required) {
    throw new Error(
      `evaluateQuinticHermiteTrajectoryInto: flatPrev length ${flatPrev.length} < sampleCount * order (${required})`,
    );
  }
  if (flatCurr.length < required) {
    throw new Error(
      `evaluateQuinticHermiteTrajectoryInto: flatCurr length ${flatCurr.length} < sampleCount * order (${required})`,
    );
  }

  // Resolve the degree-5 basis once per call (signal-independent).
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  const h0 = 1 - 10 * t3 + 15 * t4 - 6 * t5;
  const h1 = t - 6 * t3 + 8 * t4 - 3 * t5;
  const h2 = 0.5 * t2 - 1.5 * t3 + 1.5 * t4 - 0.5 * t5;
  const h3 = 10 * t3 - 15 * t4 + 6 * t5;
  const h4 = -4 * t3 + 7 * t4 - 3 * t5;
  const h5 = 0.5 * t3 - t4 + 0.5 * t5;
  // Velocity → local-t tangent (× T); acceleration → local-t curvature (× T²).
  const T = segmentSeconds;
  const T2 = T * T;
  const h1s = h1 * T;
  const h4s = h4 * T;
  const h2s = h2 * T2;
  const h5s = h5 * T2;

  // stride = order (3 or 4). The jerk lane (order=4) is skipped here.
  const stride = order;
  for (let i = 0; i < sampleCount; i++) {
    const j = i * stride;
    const p0 = flatPrev[j]!;
    const v0 = flatPrev[j + 1]!;
    const a0 = flatPrev[j + 2]!;
    const p1 = flatCurr[j]!;
    const v1 = flatCurr[j + 1]!;
    const a1 = flatCurr[j + 2]!;
    out[i] = h0 * p0 + h1s * v0 + h2s * a0 + h3 * p1 + h4s * v1 + h5s * a1;
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * Septic Hermite interpolation (0.9.81 — Apollo Mission Phase I, C³)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Quintic Hermite matches endpoint (p, v, a) → C². Septic Hermite additionally
 * matches endpoint JERK → C³ (continuous third derivative across boundaries),
 * removing the last derivative step a degree-7 reconstruction can. Consumes the
 * order-4 jerk lane stamped at flat[i*4 + 3].
 *
 * Degree-7 basis on local parameter t ∈ [0, 1]. Left-endpoint functions carry
 * (p0, m0, c0, k0), right-endpoint (p1, m1, c1, k1). The right-end coefficients
 * below are the verified expansions of the mirror H_right,k(t) = (−1)ᵏ·H_left,k(1−t);
 * the f32 SIMD port (Stage 4) should evaluate them from powers of u = 1−t for
 * symmetric conditioning, but the f64 scalar path computes the basis in f64
 * regardless, so the expanded monomial form is used here (and in the bit-exact
 * test reference). See docs/quintic-septic-hermite-design.md for the derivation
 * and the end-to-end C³ finite-difference verification.
 *
 *     H0(t) = 1 − 35t⁴ + 84t⁵ − 70t⁶ + 20t⁷          → p0
 *     H1(t) = t − 20t⁴ + 45t⁵ − 36t⁶ + 10t⁷          → m0 = T·v0
 *     H2(t) = ½t² − 5t⁴ + 10t⁵ − 7.5t⁶ + 2t⁷         → c0 = T²·a0
 *     H3(t) = ⅙t³ − ⅔t⁴ + t⁵ − ⅔t⁶ + ⅙t⁷            → k0 = T³·j0
 *     H4(t) = 35t⁴ − 84t⁵ + 70t⁶ − 20t⁷              → p1
 *     H5(t) = −15t⁴ + 39t⁵ − 34t⁶ + 10t⁷             → m1 = T·v1
 *     H6(t) = 2.5t⁴ − 7t⁵ + 6.5t⁶ − 2t⁷              → c1 = T²·a1
 *     H7(t) = −⅙t⁴ + ½t⁵ − ½t⁶ + ⅙t⁷                → k1 = T³·j1
 *
 *     p(t) = H0·p0 + H1·(T·v0) + H2·(T²·a0) + H3·(T³·j0)
 *          + H4·p1 + H5·(T·v1) + H6·(T²·a1) + H7·(T³·j1)
 *
 * Velocity terms scale by T, acceleration by T², jerk by T³ — folded into the
 * basis coefficients once per call. Requires order == 4. Allocation-free; no
 * clamp path (same rationale as the cubic/quintic paths). */

/** Septic Hermite (C³) reconstruction between two consecutive trajectory
 *  frames. Requires `spec.order == 4` (endpoint jerk). `t` ∈ [0, 1] runs from
 *  `flatPrev` (older frame) to `flatCurr`; `segmentSeconds` is the wall-clock
 *  segment duration in the producer's velocity-time units. 0.9.81. */
export function evaluateSepticHermiteTrajectoryInto(
  flatPrev: Float64Array,
  flatCurr: Float64Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float64Array,
): void;
export function evaluateSepticHermiteTrajectoryInto(
  flatPrev: Float32Array,
  flatCurr: Float32Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float32Array,
): void;
export function evaluateSepticHermiteTrajectoryInto(
  flatPrev: Float64Array | Float32Array,
  flatCurr: Float64Array | Float32Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float64Array | Float32Array,
): void {
  const { order, sampleCount } = spec;
  if (order !== 4) {
    throw new Error(
      `evaluateSepticHermiteTrajectoryInto: spec.order must be == 4 (septic Hermite needs endpoint jerk for C³), got order=${order}`,
    );
  }
  if (!Number.isFinite(t)) {
    throw new Error(`evaluateSepticHermiteTrajectoryInto: t must be finite, got ${t}`);
  }
  if (!Number.isFinite(segmentSeconds)) {
    throw new Error(
      `evaluateSepticHermiteTrajectoryInto: segmentSeconds must be finite, got ${segmentSeconds}`,
    );
  }
  if (out.length < sampleCount) {
    throw new Error(
      `evaluateSepticHermiteTrajectoryInto: out length ${out.length} < sampleCount ${sampleCount}`,
    );
  }
  const required = sampleCount * order;
  if (flatPrev.length < required) {
    throw new Error(
      `evaluateSepticHermiteTrajectoryInto: flatPrev length ${flatPrev.length} < sampleCount * order (${required})`,
    );
  }
  if (flatCurr.length < required) {
    throw new Error(
      `evaluateSepticHermiteTrajectoryInto: flatCurr length ${flatCurr.length} < sampleCount * order (${required})`,
    );
  }

  // Resolve the degree-7 basis once per call (signal-independent).
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  const t6 = t5 * t;
  const t7 = t6 * t;
  const h0 = 1 - 35 * t4 + 84 * t5 - 70 * t6 + 20 * t7;
  const h1 = t - 20 * t4 + 45 * t5 - 36 * t6 + 10 * t7;
  const h2 = 0.5 * t2 - 5 * t4 + 10 * t5 - 7.5 * t6 + 2 * t7;
  const h3 = (1 / 6) * t3 - (2 / 3) * t4 + t5 - (2 / 3) * t6 + (1 / 6) * t7;
  const h4 = 35 * t4 - 84 * t5 + 70 * t6 - 20 * t7;
  const h5 = -15 * t4 + 39 * t5 - 34 * t6 + 10 * t7;
  const h6 = 2.5 * t4 - 7 * t5 + 6.5 * t6 - 2 * t7;
  const h7 = -(1 / 6) * t4 + 0.5 * t5 - 0.5 * t6 + (1 / 6) * t7;
  // Velocity → ×T, acceleration → ×T², jerk → ×T³.
  const T = segmentSeconds;
  const T2 = T * T;
  const T3 = T2 * T;
  const h1s = h1 * T;
  const h5s = h5 * T;
  const h2s = h2 * T2;
  const h6s = h6 * T2;
  const h3s = h3 * T3;
  const h7s = h7 * T3;

  // stride = 4 (p, v, a, j).
  for (let i = 0; i < sampleCount; i++) {
    const j = i * 4;
    const p0 = flatPrev[j]!;
    const v0 = flatPrev[j + 1]!;
    const a0 = flatPrev[j + 2]!;
    const j0 = flatPrev[j + 3]!;
    const p1 = flatCurr[j]!;
    const v1 = flatCurr[j + 1]!;
    const a1 = flatCurr[j + 2]!;
    const j1 = flatCurr[j + 3]!;
    out[i] =
      h0 * p0 + h1s * v0 + h2s * a0 + h3s * j0 +
      h4 * p1 + h5s * v1 + h6s * a1 + h7s * j1;
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * Circular (angular) trajectory evaluation (0.9.935 — Topological Lanes)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The evaluators above all operate in flat ℝ: a position lane is just a real
 * number, extrapolated as `p + v·dt + …` and interpolated as a Hermite blend
 * of endpoint positions. For an ANGULAR position lane (a `f64Phase` /
 * `f64CircularArray` field — value lives on the circle ℝ/periodℤ) that is
 * WRONG across the ±period/2 branch cut: linearly blending p0 ≈ +π with
 * p1 ≈ −π interpolates the long way through 0, a full-amplitude swing exactly
 * at the frame seam. The fix mirrors the Riemann-surface move — lift to the
 * covering space, operate there, project back:
 *
 *   - Circular TAYLOR. Position is angular, but the derivative lanes
 *     (velocity, acceleration, jerk) are ordinary RATES (radians per unit
 *     time), and the increment `v·dt + ½a·dt² + …` is a genuine real
 *     displacement on the cover. So the body is the SAME Taylor sum as the
 *     flat path; only the final result is projected back with
 *     `wrapSymmetric(·, period)`. (For order=1 the "extrapolation" is a hold,
 *     so circular order-1 just wraps the stored position.)
 *
 *   - Circular HERMITE. The two endpoint positions p0, p1 are angular. We
 *     UNWRAP p1 relative to p0 — replace it with `p0 + shortestArcDelta(p0,p1)`
 *     so the pair is adjacent on the cover (never more than half a period
 *     apart) — run the ordinary Hermite basis on the unwrapped endpoints
 *     (endpoint velocities are rates, used as-is), and `wrapSymmetric` the
 *     output. The C¹ continuity of the underlying basis is preserved on the
 *     cover, and wrapping is a (locally) isometry, so the reconstructed phase
 *     is C¹ across the seam AND takes the short way around.
 *
 * `period` defaults to 2π (audio phase). Both evaluators are allocation-free
 * and bit-exact-equal to their flat counterparts whenever the signal never
 * approaches the branch cut (the wrap is then a no-op and the unwrap delta
 * equals the raw difference). f64/f32 dispatch via the same typed-array
 * element-write truncation as the flat paths. */

/** Circular Taylor extrapolation: like `evaluateTrajectoryInto` but the
 *  position lanes are angular — the Taylor sum is computed in flat ℝ (the
 *  derivative lanes are ordinary rates) and the result is wrapped into
 *  `[−period/2, +period/2)`. `period` defaults to 2π. Safety clamps are not
 *  consulted on this path (they target unbounded linear excursion; a wrapped
 *  angle is bounded by construction) — pass a clamp-free spec. */
export function evaluateCircularTrajectoryInto(
  flat: Float64Array,
  spec: TrajectorySpec,
  dt: number,
  out: Float64Array,
  period?: number,
): void;
export function evaluateCircularTrajectoryInto(
  flat: Float32Array,
  spec: TrajectorySpec,
  dt: number,
  out: Float32Array,
  period?: number,
): void;
export function evaluateCircularTrajectoryInto(
  flat: Float64Array | Float32Array,
  spec: TrajectorySpec,
  dt: number,
  out: Float64Array | Float32Array,
  period: number = TWO_PI,
): void {
  const { order, sampleCount } = spec;
  if (!Number.isFinite(period) || period <= 0) {
    throw new Error(`evaluateCircularTrajectoryInto: period must be finite positive, got ${period}`);
  }
  if (out.length < sampleCount) {
    throw new Error(
      `evaluateCircularTrajectoryInto: out length ${out.length} < sampleCount ${sampleCount}`,
    );
  }
  const required = sampleCount * order;
  if (flat.length < required) {
    throw new Error(
      `evaluateCircularTrajectoryInto: flat length ${flat.length} < sampleCount * order (${required})`,
    );
  }
  switch (order) {
    case 1: {
      for (let i = 0; i < sampleCount; i++) out[i] = wrapSymmetric(flat[i]!, period);
      return;
    }
    case 2: {
      for (let i = 0; i < sampleCount; i++) {
        const j = i * 2;
        out[i] = wrapSymmetric(flat[j]! + flat[j + 1]! * dt, period);
      }
      return;
    }
    case 3: {
      const halfDt2 = 0.5 * dt * dt;
      for (let i = 0; i < sampleCount; i++) {
        const j = i * 3;
        out[i] = wrapSymmetric(flat[j]! + flat[j + 1]! * dt + flat[j + 2]! * halfDt2, period);
      }
      return;
    }
    case 4: {
      const halfDt2 = 0.5 * dt * dt;
      const sixthDt3 = (1 / 6) * dt * dt * dt;
      for (let i = 0; i < sampleCount; i++) {
        const j = i * 4;
        out[i] = wrapSymmetric(
          flat[j]! + flat[j + 1]! * dt + flat[j + 2]! * halfDt2 + flat[j + 3]! * sixthDt3,
          period,
        );
      }
      return;
    }
  }
}

/** Circular cubic Hermite (C¹) reconstruction between two consecutive angular
 *  trajectory frames. Like `evaluateHermiteTrajectoryInto` but each sample's
 *  endpoint positions are UNWRAPPED relative to each other (shorter arc)
 *  before the cubic blend, and the result is wrapped into
 *  `[−period/2, +period/2)`. Requires `spec.order >= 2`. `period` defaults to
 *  2π. The endpoint velocities are ordinary rates (radians per
 *  `segmentSeconds`-unit), used as the spline tangents exactly as in the flat
 *  path. */
export function evaluateCircularHermiteTrajectoryInto(
  flatPrev: Float64Array,
  flatCurr: Float64Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float64Array,
  period?: number,
): void;
export function evaluateCircularHermiteTrajectoryInto(
  flatPrev: Float32Array,
  flatCurr: Float32Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float32Array,
  period?: number,
): void;
export function evaluateCircularHermiteTrajectoryInto(
  flatPrev: Float64Array | Float32Array,
  flatCurr: Float64Array | Float32Array,
  spec: TrajectorySpec,
  t: number,
  segmentSeconds: number,
  out: Float64Array | Float32Array,
  period: number = TWO_PI,
): void {
  const { order, sampleCount } = spec;
  if (order < 2) {
    throw new Error(
      `evaluateCircularHermiteTrajectoryInto: spec.order must be >= 2 (need endpoint velocities), got order=${order}`,
    );
  }
  if (!Number.isFinite(period) || period <= 0) {
    throw new Error(`evaluateCircularHermiteTrajectoryInto: period must be finite positive, got ${period}`);
  }
  if (!Number.isFinite(t)) {
    throw new Error(`evaluateCircularHermiteTrajectoryInto: t must be finite, got ${t}`);
  }
  if (!Number.isFinite(segmentSeconds)) {
    throw new Error(
      `evaluateCircularHermiteTrajectoryInto: segmentSeconds must be finite, got ${segmentSeconds}`,
    );
  }
  if (out.length < sampleCount) {
    throw new Error(
      `evaluateCircularHermiteTrajectoryInto: out length ${out.length} < sampleCount ${sampleCount}`,
    );
  }
  const required = sampleCount * order;
  if (flatPrev.length < required || flatCurr.length < required) {
    throw new Error(
      `evaluateCircularHermiteTrajectoryInto: flat length < sampleCount * order (${required})`,
    );
  }

  // Resolve the cubic basis once per call (signal-independent), matching the
  // flat path exactly.
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const h10s = h10 * segmentSeconds;
  const h11s = h11 * segmentSeconds;

  const stride = order;
  for (let i = 0; i < sampleCount; i++) {
    const j = i * stride;
    const p0 = flatPrev[j]!;
    const m0 = flatPrev[j + 1]!;
    // Unwrap p1 onto the same sheet as p0 (shorter arc), so the cubic blend
    // never traverses the long way around the circle.
    const p1 = p0 + shortestArcDelta(p0, flatCurr[j]!, period);
    const m1 = flatCurr[j + 1]!;
    out[i] = wrapSymmetric(h00 * p0 + h10s * m0 + h01 * p1 + h11s * m1, period);
  }
}
