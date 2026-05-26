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
