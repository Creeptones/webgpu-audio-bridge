/**
 * Trajectory evaluation — Taylor extrapolation of interleaved (p, v, [a])
 * streams produced by `f{32,64}TrajectoryArray(n, { order })`.
 *
 * The producer packs N samples of position (and velocity, and acceleration
 * if order=3) into a flat interleaved typed-array of `N * order` elements:
 *
 *     order=1:  [p0, p1, ..., p_{N-1}]
 *     order=2:  [p0, v0, p1, v1, ..., p_{N-1}, v_{N-1}]
 *     order=3:  [p0, v0, a0, p1, v1, a1, ..., p_{N-1}, v_{N-1}, a_{N-1}]
 *
 * The consumer calls `evaluateTrajectoryInto(flat, spec, dt, out)` to
 * compute the extrapolated scalar at elapsed time `dt` for each sample.
 *
 *     order=1:  out[i] = p_i                              (dt ignored)
 *     order=2:  out[i] = p_i + v_i · dt                   (linear Taylor)
 *     order=3:  out[i] = p_i + v_i · dt + ½ · a_i · dt²   (quadratic Taylor)
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
 * schema-construction time. Order=3 trajectories carry acceleration; this
 * first cut IGNORES it (standard cubic Hermite is C¹, not C²).
 *
 * The `interpolationMode` union is **closed at 1.0**, fixed to
 * `'taylor' | 'hermite'`. A quintic-Hermite path that consumes (p, v, a) at
 * both endpoints for full C² continuity is **deferred to 1.x** as a
 * separate `'quintic-hermite'` value — added via an additive minor bump
 * (e.g. 1.1.0), not by widening the closed 1.0 union in place. Closing the
 * union at 1.0 lets consumers `switch` on the mode without a default
 * branch; the additive-name path keeps that exhaustive-check shape valid
 * post-1.0 (a new arm is a deliberate compile error, not a silent fall-
 * through).
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

  // The per-sample stride is `order`; for order=2 it's (p, v), for order=3
  // it's (p, v, a). The acceleration lane is ignored on the cubic path; a
  // quintic-Hermite path that consumes acceleration at both endpoints is
  // deferred to 1.x as a separate `'quintic-hermite'` interpolationMode
  // value (additive minor bump, not a 1.0 union widening).
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
