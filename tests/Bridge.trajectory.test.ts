/**
 * Bridge trajectory — split out of tests/Bridge.test.ts in 0.8.5.
 *
 * evaluateInto round-trip, validation, clamps (velocity / acceleration / hold / saturate), clamp-free bit-exact, forEachSampleInQuantum.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.trajectory.test.ts
 *
 * Pins (file-header pin numbers; see tests/Bridge.test.ts in 0.8.4 for the
 * original combined docstring with full per-pin descriptions):
 *  44. testEvaluateIntoMixedSchema
 *  45. testEvaluateIntoNoTrajectorySchema
 *  46. testEvaluateIntoValidation
 *  56. testTrajectoryVelocityClamp
 *  57. testTrajectoryAccelerationClamp
 *  58. testTrajectoryHoldFallback
 *  59. testTrajectoryDeltaSaturate
 *  60. testTrajectoryClampFreeBitExact
 *  80. testForEachSampleInQuantum
 *  81. testTrajectoryOrder4Taylor               (0.9.80 — cubic Taylor + clamp guard)
 *  82. testTrajectoryQuinticBitExact            (0.9.80 — quintic Hermite closed-form)
 *  83. testTrajectoryQuinticEndpoints           (0.9.80 — C² continuity at the seam)
 *  84. testTrajectoryQuinticFloat32Truncation   (0.9.80 — f32 within-ULP grid sweep)
 *  85. testHermiteInterpolationModeDispatch      (0.9.80 — evaluateHermiteInto mode routing)
 */

import {
  assert,
  assertEq,
  ok,
} from "./_assert.js";
import {
  makePhysFrame,
  mulberry32,
} from "./_bridgeHelpers.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f32TrajectoryArray,
  f64,
  f64TrajectoryArray,
  type TrajectorySpec,
  u64,
  u8Array,
} from "../src/schema.js";
import { physicsControlFrameSchema } from "../src/schemas/physics.js";
import {
  evaluateQuinticHermiteTrajectoryInto,
  evaluateTrajectoryInto,
} from "../src/trajectory.js";


// ── 44. evaluateInto round-trip on a mixed-field schema (0.6.3, Pillar 3) ──
//
// A schema with both trajectory and non-trajectory fields exercises the
// full field-walk dispatch. Trajectory fields run evaluateTrajectoryInto;
// non-trajectory arrays copy via .set(); scalars copy verbatim. The
// scratchEvaluatedFrame() helper sizes trajectory fields to sampleCount
// (the post-evaluation length) rather than sampleCount * order.
function testEvaluateIntoMixedSchema(): void {
  const N = 8;
  const schema = defineSchema({
    seq: u64(),                                  // BigInt scalar
    tMacroNs: u64(),                             // BigInt scalar
    vMax: f64(),                                 // number scalar
    label: u8Array(4),                           // non-trajectory array
    vEff: f64TrajectoryArray(N, { order: 2 }),   // f64 order=2 (interleaved p,v)
    aEff: f32TrajectoryArray(N, { order: 3 }),   // f32 order=3 (interleaved p,v,a)
  });
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  // Build src: each sample i has position=10*i, velocity=1, acceleration=2
  // (for the f32 order=3 field). The f64 order=2 field uses position=100*i,
  // velocity=-5 so we can distinguish them.
  const src = ring.scratchFrame();
  src.seq = 42n;
  src.tMacroNs = 1_234_567_890n;
  src.vMax = 0.5;
  src.label.set([0xAA, 0xBB, 0xCC, 0xDD]);
  for (let i = 0; i < N; i++) {
    src.vEff[i * 2]     = 100 * i;   // p
    src.vEff[i * 2 + 1] = -5;        // v
    src.aEff[i * 3]     = 10 * i;    // p
    src.aEff[i * 3 + 1] = 1;         // v
    src.aEff[i * 3 + 2] = 2;         // a
  }

  // scratchEvaluatedFrame sizes trajectory fields to sampleCount.
  const out = ring.scratchEvaluatedFrame();
  assertEq(out.vEff.length, N, "scratchEvaluatedFrame: vEff length = sampleCount");
  assertEq(out.aEff.length, N, "scratchEvaluatedFrame: aEff length = sampleCount");
  assertEq(out.label.length, 4, "scratchEvaluatedFrame: non-trajectory array length matches");
  assert(out.vEff instanceof Float64Array, "scratchEvaluatedFrame: f64 trajectory → Float64Array");
  assert(out.aEff instanceof Float32Array, "scratchEvaluatedFrame: f32 trajectory → Float32Array");
  assertEq(typeof out.seq, "bigint", "scratchEvaluatedFrame: BigInt scalar zero-init");
  assertEq(out.seq, 0n, "scratchEvaluatedFrame: BigInt scalar = 0n");
  assertEq(out.vMax, 0, "scratchEvaluatedFrame: number scalar = 0");

  // Evaluate at dt = 0.5 (unit-agnostic; matches whatever the producer's
  // velocity units are — here we treat them as samples-per-dt-unit for
  // ease of computing closed-form expectations).
  const dt = 0.5;
  ring.evaluateInto(src, dt, out);

  // Scalars copied verbatim.
  assertEq(out.seq, 42n, "scalar BigInt copied verbatim");
  assertEq(out.tMacroNs, 1_234_567_890n, "scalar BigInt copied verbatim (tMacroNs)");
  assertEq(out.vMax, 0.5, "scalar number copied verbatim");

  // Non-trajectory array copied verbatim via .set().
  assertEq(out.label[0], 0xAA, "non-trajectory array: byte 0 copied");
  assertEq(out.label[1], 0xBB, "non-trajectory array: byte 1 copied");
  assertEq(out.label[2], 0xCC, "non-trajectory array: byte 2 copied");
  assertEq(out.label[3], 0xDD, "non-trajectory array: byte 3 copied");

  // f64 order=2 trajectory: out[i] = 100*i + -5 * 0.5 = 100*i - 2.5.
  for (let i = 0; i < N; i++) {
    assertEq(
      out.vEff[i],
      100 * i + -5 * dt,
      `vEff[${i}] = p + v·dt = ${100 * i + -5 * dt}`,
    );
  }

  // f32 order=3 trajectory: out[i] = 10*i + 1 * 0.5 + 0.5 * 2 * 0.25
  //                                = 10*i + 0.5 + 0.25 = 10*i + 0.75.
  // f32 precision: 10*i + 0.75 is exact for small i (≤ 2^24/10 ≈ 1.6M).
  for (let i = 0; i < N; i++) {
    const expected = 10 * i + 1 * dt + 0.5 * 2 * dt * dt;
    assertEq(out.aEff[i], expected, `aEff[${i}] = p + v·dt + ½·a·dt² = ${expected}`);
  }

  // dt=0 with order≥2 returns positions exactly (sanity).
  ring.evaluateInto(src, 0, out);
  for (let i = 0; i < N; i++) {
    assertEq(out.vEff[i], 100 * i, `dt=0: vEff[${i}] = p exactly`);
    assertEq(out.aEff[i], 10 * i, `dt=0: aEff[${i}] = p exactly`);
  }

  // Round-trippable: call again with same src, get same result. No hidden
  // state mutation between calls.
  ring.evaluateInto(src, dt, out);
  assertEq(out.vEff[3], 300 - 2.5, "round-tripped: vEff[3] still matches");
  assertEq(out.aEff[2], 20 + 0.75, "round-tripped: aEff[2] still matches");

  ok("evaluate-into-mixed-schema");
}


// ── 45. evaluateInto on a no-trajectory schema is a pure copy ──────────────
//
// Degenerate case — no trajectory fields means evaluateInto reduces to a
// memcpy of every field from src to out. Pins the "non-trajectory fields
// pass through" contract for schemas that don't (yet) use trajectories.
// Useful primitive for snapshotting frames without forcing trajectory
// migration.
function testEvaluateIntoNoTrajectorySchema(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const src = makePhysFrame(7, n);
  const out = ring.scratchEvaluatedFrame();
  // scratchEvaluatedFrame on a no-trajectory schema is identical to
  // scratchFrame: arrays at full length, scalars zero-init.
  assertEq(out.vEff.length, n, "scratchEvaluatedFrame: vEff length = n");
  assertEq(out.jEff.length, n, "scratchEvaluatedFrame: jEff length = n");

  // dt is irrelevant when no trajectory fields are present. Pick a
  // recognizable value to confirm it does NOT leak into the output.
  ring.evaluateInto(src, 999.9, out);

  assertEq(out.seq, src.seq, "no-trajectory: seq copied verbatim");
  assertEq(out.tMacroNs, src.tMacroNs, "no-trajectory: tMacroNs copied verbatim");
  assertEq(out.vMax, src.vMax, "no-trajectory: vMax copied verbatim");
  assertEq(out.jMax, src.jMax, "no-trajectory: jMax copied verbatim");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], src.vEff[k], `no-trajectory: vEff[${k}] copied verbatim`);
    assertEq(out.jEff[k], src.jEff[k], `no-trajectory: jEff[${k}] copied verbatim`);
  }

  ok("evaluate-into-no-trajectory-schema");
}


// ── 46. evaluateInto validation ────────────────────────────────────────────
//
// Non-finite dt throws cleanly. An out-frame's trajectory field too small
// to hold the evaluated positions surfaces evaluateTrajectoryInto's
// error message (we explicitly do NOT pre-validate to avoid double-checking
// the same contract).
function testEvaluateIntoValidation(): void {
  const N = 4;
  const schema = defineSchema({
    vEff: f64TrajectoryArray(N, { order: 2 }),
  });
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const src = ring.scratchFrame();
  const out = ring.scratchEvaluatedFrame();

  // Non-finite dt rejected.
  let threw = false;
  try { ring.evaluateInto(src, NaN, out); } catch { threw = true; }
  assert(threw, "evaluateInto: NaN dt throws");
  threw = false;
  try { ring.evaluateInto(src, Infinity, out); } catch { threw = true; }
  assert(threw, "evaluateInto: Infinity dt throws");
  threw = false;
  try { ring.evaluateInto(src, -Infinity, out); } catch { threw = true; }
  assert(threw, "evaluateInto: -Infinity dt throws");

  // Out-frame trajectory field too small: evaluateTrajectoryInto throws.
  const undersized = ring.scratchEvaluatedFrame();
  // Replace the vEff buffer with one that's too small.
  (undersized as unknown as { vEff: Float64Array }).vEff = new Float64Array(N - 1);
  threw = false;
  try { ring.evaluateInto(src, 0.1, undersized); } catch { threw = true; }
  assert(threw, "evaluateInto: undersized out trajectory throws");

  ok("evaluate-into-validation");
}


// ── 56. Trajectory velocity clamp (0.6.7) ──────────────────────────────────
//
// order=2: producer ships a huge velocity sample; with `velocityClamp` set
// the evaluator clamps |v| pre-multiply so the output excursion is bounded
// by `velocityClamp · dt`. Symmetric on negative velocities; v inside the
// band passes through untouched.
function testTrajectoryVelocityClamp(): void {
  const N = 4;
  const spec: TrajectorySpec = {
    order: 2,
    sampleCount: N,
    velocityClamp: 2.0,
  };
  const flat = new Float64Array([
    1.0,   10.0, // sample 0: p=1,  v=10  (clamped to +2)
    2.0, -100.0, // sample 1: p=2,  v=-100 (clamped to -2)
    3.0,    1.5, // sample 2: p=3,  v=1.5 (within band, untouched)
    4.0,   -2.0, // sample 3: p=4,  v=-2  (exactly at band edge, untouched)
  ]);
  const out = new Float64Array(N);
  const dt = 0.5;
  evaluateTrajectoryInto(flat, spec, dt, out);

  assertEq(out[0], 1.0 + 2.0 * dt, "v-clamp: positive overshoot caps at +velocityClamp");
  assertEq(out[1], 2.0 + -2.0 * dt, "v-clamp: negative overshoot caps at -velocityClamp");
  assertEq(out[2], 3.0 + 1.5 * dt, "v-clamp: in-band velocity passes through");
  assertEq(out[3], 4.0 + -2.0 * dt, "v-clamp: boundary value passes through");

  // dt = 0: clamping is dormant in effect (multiplied by 0) but path still
  // engages without throwing or producing NaN.
  const out0 = new Float64Array(N);
  evaluateTrajectoryInto(flat, spec, 0, out0);
  assertEq(out0[0], 1.0, "v-clamp: dt=0 returns position regardless of clamp");
  assertEq(out0[1], 2.0, "v-clamp: dt=0 returns position regardless of clamp");

  ok("trajectory-velocity-clamp");
}


// ── 57. Trajectory acceleration clamp (0.6.7) ──────────────────────────────
//
// order=3: producer ships a huge acceleration sample; with
// `accelerationClamp` set the evaluator clamps |a| pre-multiply so the
// quadratic term is bounded by `½ · accelerationClamp · dt²`. Velocity
// unchanged (no velocityClamp), so the velocity contribution is full
// fidelity.
function testTrajectoryAccelerationClamp(): void {
  const N = 3;
  const spec: TrajectorySpec = {
    order: 3,
    sampleCount: N,
    accelerationClamp: 4.0,
  };
  const flat = new Float64Array([
    0.0, 1.0,   100.0,  // sample 0: p=0, v=1, a=100 (clamped to +4)
    1.0, 0.5, -1000.0,  // sample 1: p=1, v=0.5, a=-1000 (clamped to -4)
    2.0, 0.0,     2.0,  // sample 2: p=2, v=0, a=2 (in-band, untouched)
  ]);
  const out = new Float64Array(N);
  const dt = 0.5;
  const halfDt2 = 0.5 * dt * dt;
  evaluateTrajectoryInto(flat, spec, dt, out);

  assertEq(
    out[0],
    0.0 + 1.0 * dt + 4.0 * halfDt2,
    "a-clamp: huge positive a clamps to +accelerationClamp",
  );
  assertEq(
    out[1],
    1.0 + 0.5 * dt + -4.0 * halfDt2,
    "a-clamp: huge negative a clamps to -accelerationClamp",
  );
  assertEq(
    out[2],
    2.0 + 0.0 * dt + 2.0 * halfDt2,
    "a-clamp: in-band a passes through",
  );

  ok("trajectory-acceleration-clamp");
}


// ── 58. Trajectory 'hold' fallback (0.6.7) ─────────────────────────────────
//
// order=2 with `maxDeltaPerSample` + `overflowFallback: 'hold'`. A sample
// whose Taylor output would land further than `maxDelta` from the previous
// output freezes the signal at the previous value. Successive holds keep
// the same level until the raw signal returns within band.
function testTrajectoryHoldFallback(): void {
  const N = 5;
  const spec: TrajectorySpec = {
    order: 2,
    sampleCount: N,
    maxDeltaPerSample: 0.1,
    overflowFallback: "hold",
  };
  // Velocities zero everywhere so out[i] = p_i exactly (no clamp on v).
  // Positions step like a square wave: 1.0, 1.05, 99.0, 99.5, 1.0.
  const flat = new Float64Array([
    1.0,  0.0, // sample 0: 1.0 (no prev — passes through)
    1.05, 0.0, // sample 1: 1.05 (delta 0.05 < 0.1 → passes through)
    99.0, 0.0, // sample 2: 99.0 (delta 97.95 > 0.1 → hold prev = 1.05)
    99.5, 0.0, // sample 3: 99.5 (delta 98.45 > 0.1 → hold prev = 1.05)
    1.10, 0.0, // sample 4: 1.10 (delta 0.05 < 0.1 vs held 1.05 → passes through)
  ]);
  const out = new Float64Array(N);
  evaluateTrajectoryInto(flat, spec, 1.0, out);

  assertEq(out[0], 1.0, "hold: sample 0 passes through (no prev)");
  assertEq(out[1], 1.05, "hold: sample 1 in-band, passes through");
  assertEq(out[2], 1.05, "hold: sample 2 out-of-band, freezes at prev (1.05)");
  assertEq(out[3], 1.05, "hold: sample 3 still out-of-band, stays frozen");
  assertEq(out[4], 1.10, "hold: sample 4 returns within band, passes through");

  // Bounded excursion across the whole run.
  let maxAbs = 0;
  for (let i = 0; i < N; i++) {
    const v = Math.abs(out[i]!);
    if (v > maxAbs) maxAbs = v;
  }
  assert(maxAbs < 2.0, `hold: max |out| ${maxAbs} stays bounded (< 2.0) despite raw 99-spike`);

  ok("trajectory-hold-fallback");
}


// ── 59. Trajectory per-sample delta clamp 'saturate' (0.6.7) ───────────────
//
// Default `overflowFallback` is 'saturate': the would-be output is clamped
// into `[prev - maxDelta, prev + maxDelta]`. This bounds the per-sample
// excursion across the entire run by maxDelta — useful as a click /
// glitch guard.
function testTrajectoryDeltaSaturate(): void {
  const N = 10;
  const maxDelta = 0.05;
  const spec: TrajectorySpec = {
    order: 2,
    sampleCount: N,
    maxDeltaPerSample: maxDelta,
    // no overflowFallback set → defaults to 'saturate' in the evaluator
  };
  // Square-wave-style transient: starting at 0, jumping to 100 every other
  // sample. Velocities zero (so out[i] = p_i with no clamping path active).
  const flat = new Float64Array(N * 2);
  for (let i = 0; i < N; i++) {
    flat[i * 2] = i % 2 === 0 ? 0 : 100;
    flat[i * 2 + 1] = 0;
  }
  const out = new Float64Array(N);
  evaluateTrajectoryInto(flat, spec, 1.0, out);

  // sample 0 is always allowed (no prev) → passes through as 0.
  assertEq(out[0], 0, "saturate: sample 0 passes through");
  // Every subsequent step is clamped to ±maxDelta.
  for (let i = 1; i < N; i++) {
    const diff = Math.abs(out[i]! - out[i - 1]!);
    assert(
      diff <= maxDelta + 1e-12,
      `saturate: |out[${i}] - out[${i - 1}]| = ${diff} <= maxDelta (${maxDelta})`,
    );
  }
  // The series climbs by maxDelta per step toward 100 (never reaches it).
  assertEq(out[1], maxDelta, "saturate: sample 1 = prev + maxDelta toward target");
  assertEq(out[2], 0, "saturate: sample 2 saturates downward by maxDelta");
  assertEq(out[3], maxDelta, "saturate: sample 3 climbs back by maxDelta");

  ok("trajectory-delta-saturate");
}


// ── 60. Trajectory clamp-free fast path bit-exact equal to 0.6.6 (0.6.7) ──
//
// With no clamp field set the evaluator must produce bit-identical output
// to the inlined Taylor formula across orders 1 / 2 / 3 (f64 + f32 spot
// check). This is the regression pin proving 0.6.7's split keeps the fast
// path byte-for-byte equivalent — any future refactor that quietly engages
// the clamped path on a clamp-free spec flips this red.
function testTrajectoryClampFreeBitExact(): void {
  // Deterministic pseudo-random fixtures.
  const rng = mulberry32(0xC0FFEE);
  const N = 128;
  const dt = 0.314159;

  // ── order=1 ──────────────────────────────────────────────────────────
  {
    const flat = new Float64Array(N);
    for (let i = 0; i < N; i++) flat[i] = (rng() - 0.5) * 1000;
    const spec: TrajectorySpec = { order: 1, sampleCount: N };
    const out = new Float64Array(N);
    evaluateTrajectoryInto(flat, spec, dt, out);
    for (let i = 0; i < N; i++) {
      assertEq(out[i], flat[i]!, `clamp-free order=1 sample ${i} bit-exact`);
    }
  }

  // ── order=2 ──────────────────────────────────────────────────────────
  {
    const flat = new Float64Array(N * 2);
    for (let k = 0; k < flat.length; k++) flat[k] = (rng() - 0.5) * 1000;
    const spec: TrajectorySpec = { order: 2, sampleCount: N };
    const out = new Float64Array(N);
    evaluateTrajectoryInto(flat, spec, dt, out);
    for (let i = 0; i < N; i++) {
      const j = i * 2;
      const want = flat[j]! + flat[j + 1]! * dt;
      assertEq(out[i], want, `clamp-free order=2 sample ${i} bit-exact`);
    }
  }

  // ── order=3 ──────────────────────────────────────────────────────────
  {
    const flat = new Float64Array(N * 3);
    for (let k = 0; k < flat.length; k++) flat[k] = (rng() - 0.5) * 1000;
    const spec: TrajectorySpec = { order: 3, sampleCount: N };
    const out = new Float64Array(N);
    const halfDt2 = 0.5 * dt * dt;
    evaluateTrajectoryInto(flat, spec, dt, out);
    for (let i = 0; i < N; i++) {
      const j = i * 3;
      const want = flat[j]! + flat[j + 1]! * dt + flat[j + 2]! * halfDt2;
      assertEq(out[i], want, `clamp-free order=3 sample ${i} bit-exact`);
    }
  }

  // ── f32 spot check, order=2 ─────────────────────────────────────────
  // f32 element-write truncates to float32 precision; the bit-exact
  // assertion is against the inlined formula computed with the same
  // truncation contract.
  {
    const flat = new Float32Array(N * 2);
    for (let k = 0; k < flat.length; k++) flat[k] = Math.fround((rng() - 0.5) * 100);
    const spec: TrajectorySpec = { order: 2, sampleCount: N };
    const out = new Float32Array(N);
    const ref = new Float32Array(N);
    evaluateTrajectoryInto(flat, spec, dt, out);
    for (let i = 0; i < N; i++) {
      const j = i * 2;
      ref[i] = flat[j]! + flat[j + 1]! * dt;
    }
    for (let i = 0; i < N; i++) {
      assertEq(out[i], ref[i]!, `clamp-free f32 order=2 sample ${i} bit-exact`);
    }
  }

  // ── Sanity: the clamped path (any clamp field set) is NOT engaged on a
  // spec that omits all clamp fields — proved by the above bit-exactness.
  // A spec with one clamp set produces output that may differ; just verify
  // that the path is reachable and the bounded behavior pin (#58/#59)
  // covers correctness.
  {
    const flat = new Float64Array([10, 1000]); // huge v
    const out = new Float64Array(1);
    evaluateTrajectoryInto(flat, { order: 2, sampleCount: 1 }, 1.0, out);
    assertEq(out[0], 10 + 1000 * 1.0, "no-clamp control: huge v passes through");
    evaluateTrajectoryInto(
      flat,
      { order: 2, sampleCount: 1, velocityClamp: 5 },
      1.0,
      out,
    );
    assertEq(out[0], 10 + 5 * 1.0, "with-clamp control: huge v clamped");
  }

  ok("trajectory-clamp-free-bit-exact");
}


// ── 80. forEachSampleInQuantum batch eval (0.6.17) ───────────────────────
function testForEachSampleInQuantum(): void {
  // Trajectory schema so the per-sample dt arithmetic actually varies
  // the output (a non-trajectory schema would degenerate to all
  // samples reading the same raw frame).
  const schema = defineSchema({
    seq: u64(),
    t: u64(),
    vEff: f64TrajectoryArray(8, { order: 2 }),
  }).withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });
  const { sab, capacity } = Bridge.allocate(4, schema);
  const bridge = new Bridge(sab, capacity, schema);
  bridge.setSampleRate(48000);

  // Push a frame with a non-trivial trajectory so dt actually matters.
  const push = bridge.scratchFrame();
  push.seq = 1n;
  push.t = 0n;
  // Order-2 trajectory: positions at even indices, velocities at odd.
  // 8 samples × 2 lanes = 16 elements.
  push.vEff = new Float64Array(16);
  for (let i = 0; i < 8; i++) {
    push.vEff[i * 2] = i * 0.1;     // position
    push.vEff[i * 2 + 1] = i * 0.01; // velocity
  }
  assert(bridge.push(push), "push trajectory frame");

  // Pull + observe + set up cache.
  const evalFrame = bridge.scratchEvaluatedFrame();
  const baseConsumerNs = 1_000_000;
  const skipped = bridge.pullEvaluatedLatest(evalFrame, baseConsumerNs);
  assert(skipped >= 0, "pullEvaluatedLatest succeeds");

  // Hand-rolled reference: evaluateAtSampleOffset per sample.
  const SAMPLE_COUNT = 32;
  const reference: number[][] = new Array(SAMPLE_COUNT);
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    bridge.evaluateAtSampleOffset(evalFrame, i);
    reference[i] = Array.from(evalFrame.vEff);
  }

  // Re-arm by calling pullEvaluatedLatest again on a NEW base time —
  // would invalidate any state machine that was advancing during the
  // reference loop. (None should — both methods are pure heap
  // computations.) Actually no: pullEvaluatedLatest does pullLatest
  // internally which would empty the ring. Need to push again.
  const push2 = bridge.scratchFrame();
  push2.seq = 2n;
  push2.t = 0n;
  push2.vEff = new Float64Array(16);
  for (let i = 0; i < 8; i++) {
    push2.vEff[i * 2] = i * 0.1;
    push2.vEff[i * 2 + 1] = i * 0.01;
  }
  bridge.push(push2);
  const skipped2 = bridge.pullEvaluatedLatest(evalFrame, baseConsumerNs);
  assert(skipped2 >= 0, "pullEvaluatedLatest second call succeeds");

  // Batch run via forEachSampleInQuantum.
  const observed: number[][] = new Array(SAMPLE_COUNT);
  bridge.forEachSampleInQuantum(evalFrame, SAMPLE_COUNT, (sampleIdx, frame) => {
    observed[sampleIdx] = Array.from(frame.vEff);
  });

  // Compare bit-exact.
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const ref = reference[i]!;
    const obs = observed[i]!;
    assertEq(obs.length, ref.length, `sample ${i} length matches`);
    for (let k = 0; k < ref.length; k++) {
      assertEq(
        obs[k],
        ref[k],
        `sample ${i} lane ${k}: hand-rolled=${ref[k]}, batch=${obs[k]}`,
      );
    }
  }

  // Validation: throws on bad sampleCount.
  let threw = false;
  try { bridge.forEachSampleInQuantum(evalFrame, -1, () => {}); } catch { threw = true; }
  assert(threw, "negative sampleCount throws");
  threw = false;
  try { bridge.forEachSampleInQuantum(evalFrame, 1.5, () => {}); } catch { threw = true; }
  assert(threw, "fractional sampleCount throws");
  threw = false;
  try { bridge.forEachSampleInQuantum(evalFrame, NaN, () => {}); } catch { threw = true; }
  assert(threw, "NaN sampleCount throws");

  // sampleCount = 0: legal, no-op, callback never invoked.
  let callbackInvoked = false;
  bridge.forEachSampleInQuantum(evalFrame, 0, () => {
    callbackInvoked = true;
  });
  assertEq(callbackInvoked, false, "sampleCount=0 invokes callback zero times");

  // No prior pullEvaluatedLatest → throws.
  const { sab: sab2, capacity: cap2 } = Bridge.allocate(4, schema);
  const bridge2 = new Bridge(sab2, cap2, schema);
  bridge2.setSampleRate(48000);
  threw = false;
  try { bridge2.forEachSampleInQuantum(evalFrame, 4, () => {}); } catch { threw = true; }
  assert(threw, "no cached frame → throws");

  ok("for-each-sample-in-quantum");
}

// ── Quintic basis reference (mirrors src/trajectory.ts accumulation order
// exactly so f64 comparisons are bit-exact, not within-tolerance). ──────────
function quinticRef(
  p0: number, v0: number, a0: number,
  p1: number, v1: number, a1: number,
  t: number, T: number,
): number {
  const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
  const h0 = 1 - 10 * t3 + 15 * t4 - 6 * t5;
  const h1 = t - 6 * t3 + 8 * t4 - 3 * t5;
  const h2 = 0.5 * t2 - 1.5 * t3 + 1.5 * t4 - 0.5 * t5;
  const h3 = 10 * t3 - 15 * t4 + 6 * t5;
  const h4 = -4 * t3 + 7 * t4 - 3 * t5;
  const h5 = 0.5 * t3 - t4 + 0.5 * t5;
  const T2 = T * T;
  return h0 * p0 + (h1 * T) * v0 + (h2 * T2) * a0 + h3 * p1 + (h4 * T) * v1 + (h5 * T2) * a1;
}

// ── 81. order-4 cubic Taylor + clamp guard (0.9.80) ──────────────────────
//
// The new order-4 wire lane (p, v, a, j) must evaluate the cubic Taylor
// p + v·dt + ½a·dt² + ⅙j·dt³ on the clamp-free fast path, and reject clamps
// (deferred) with a throw rather than silently dropping the jerk term.
function testTrajectoryOrder4Taylor(): void {
  const rng = mulberry32(0x4A3B);
  const N = 96;
  const dt = 0.2718;

  // f64 bit-exact closed form.
  {
    const flat = new Float64Array(N * 4);
    for (let k = 0; k < flat.length; k++) flat[k] = (rng() - 0.5) * 1000;
    const spec: TrajectorySpec = { order: 4, sampleCount: N };
    const out = new Float64Array(N);
    const halfDt2 = 0.5 * dt * dt;
    const sixthDt3 = (1 / 6) * dt * dt * dt;
    evaluateTrajectoryInto(flat, spec, dt, out);
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      const want =
        flat[j]! + flat[j + 1]! * dt + flat[j + 2]! * halfDt2 + flat[j + 3]! * sixthDt3;
      assertEq(out[i], want, `order=4 cubic Taylor sample ${i} bit-exact`);
    }
  }

  // dt=0 collapses to position regardless of v/a/j.
  {
    const flat = new Float64Array([5, 99, -7, 42, -3, 1, 1, 1]);
    const out = new Float64Array(2);
    evaluateTrajectoryInto(flat, { order: 4, sampleCount: 2 }, 0, out);
    assertEq(out[0], 5, "order=4 dt=0 → p0");
    assertEq(out[1], -3, "order=4 dt=0 → p1");
  }

  // Schema rejects clamps on order=4 at construction; the evaluator's clamped
  // path also guards directly (mirrors the schema guard for raw-spec callers).
  {
    let threw = false;
    try {
      evaluateTrajectoryInto(
        new Float64Array(8),
        { order: 4, sampleCount: 2, velocityClamp: 5 },
        1.0,
        new Float64Array(2),
      );
    } catch {
      threw = true;
    }
    assert(threw, "order=4 + clamp throws (clamps deferred)");
  }

  ok("trajectory-order4-taylor");
}

// ── 82. quintic Hermite closed-form bit-exact (0.9.80) ───────────────────
//
// f64 quintic Hermite must equal the hand-computed degree-5 basis sum, and a
// quintic evaluated over an order-4 array (jerk lane present) must equal the
// same evaluated over the order-3 projection — the jerk lane is ignored on
// the C² path.
function testTrajectoryQuinticBitExact(): void {
  const rng = mulberry32(0x517E);
  const N = 100;
  const t = 0.41237;
  const T = 1.5;

  // ── order=3 (stride 3) ───────────────────────────────────────────────
  {
    const prev = new Float64Array(N * 3);
    const curr = new Float64Array(N * 3);
    for (let k = 0; k < prev.length; k++) prev[k] = (rng() - 0.5) * 200;
    for (let k = 0; k < curr.length; k++) curr[k] = (rng() - 0.5) * 200;
    const spec: TrajectorySpec = { order: 3, sampleCount: N };
    const out = new Float64Array(N);
    evaluateQuinticHermiteTrajectoryInto(prev, curr, spec, t, T, out);
    for (let i = 0; i < N; i++) {
      const j = i * 3;
      const want = quinticRef(
        prev[j]!, prev[j + 1]!, prev[j + 2]!,
        curr[j]!, curr[j + 1]!, curr[j + 2]!,
        t, T,
      );
      assertEq(out[i], want, `quintic order=3 sample ${i} bit-exact`);
    }
  }

  // ── order=4 (stride 4) ignores the jerk lane → same as order-3 slice ──
  {
    const prev4 = new Float64Array(N * 4);
    const curr4 = new Float64Array(N * 4);
    for (let k = 0; k < prev4.length; k++) prev4[k] = (rng() - 0.5) * 200;
    for (let k = 0; k < curr4.length; k++) curr4[k] = (rng() - 0.5) * 200;
    const out = new Float64Array(N);
    evaluateQuinticHermiteTrajectoryInto(prev4, curr4, { order: 4, sampleCount: N }, t, T, out);
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      const want = quinticRef(
        prev4[j]!, prev4[j + 1]!, prev4[j + 2]!,
        curr4[j]!, curr4[j + 1]!, curr4[j + 2]!,
        t, T,
      );
      assertEq(out[i], want, `quintic order=4 (jerk ignored) sample ${i} bit-exact`);
    }
  }

  // ── order < 3 rejected ────────────────────────────────────────────────
  {
    let threw = false;
    try {
      evaluateQuinticHermiteTrajectoryInto(
        new Float64Array(4), new Float64Array(4),
        { order: 2, sampleCount: 2 }, t, T, new Float64Array(2),
      );
    } catch {
      threw = true;
    }
    assert(threw, "quintic rejects order < 3");
  }

  ok("trajectory-quintic-bit-exact");
}

// ── 83. quintic C² continuity at the seam (0.9.80) ───────────────────────
//
// The headline claim, tested not asserted: at t=0 the reconstruction equals
// the prev-frame position EXACTLY (basis is (1,0,0,0,0,0)); at t=1 the
// curr-frame position EXACTLY. The reconstructed first/second derivatives at
// each seam match the stamped endpoint velocity/acceleration (finite-diff,
// scaled out of local-t space by T / T²) → C² across the boundary.
function testTrajectoryQuinticEndpoints(): void {
  const T = 1.25;
  // Single sample, distinct (p, v, a) at each endpoint.
  const p0 = 0.4, v0 = 1.1, a0 = -0.7;
  const p1 = -0.3, v1 = 0.5, a1 = 1.2;
  const prev = new Float64Array([p0, v0, a0]);
  const curr = new Float64Array([p1, v1, a1]);
  const spec: TrajectorySpec = { order: 3, sampleCount: 1 };
  const out = new Float64Array(1);

  // Endpoint value reproduction is EXACT (no rounding — basis is 0/1 there).
  evaluateQuinticHermiteTrajectoryInto(prev, curr, spec, 0, T, out);
  assertEq(out[0], p0, "quintic t=0 → p0 exactly");
  evaluateQuinticHermiteTrajectoryInto(prev, curr, spec, 1, T, out);
  assertEq(out[0], p1, "quintic t=1 → p1 exactly");

  // Sample p(t) on a tiny stencil and finite-difference the derivatives.
  const P = (t: number): number => {
    const o = new Float64Array(1);
    evaluateQuinticHermiteTrajectoryInto(prev, curr, spec, t, T, o);
    return o[0]!;
  };
  const e = 1e-4;
  // d/dτ = (1/T)·d/dt. central 1st & 2nd differences.
  const dP_dt0 = (P(e) - P(-e)) / (2 * e);
  const d2P_dt0 = (P(e) - 2 * P(0) + P(-e)) / (e * e);
  const dP_dt1 = (P(1 + e) - P(1 - e)) / (2 * e);
  const d2P_dt1 = (P(1 + e) - 2 * P(1) + P(1 - e)) / (e * e);
  const reconV0 = dP_dt0 / T, reconA0 = d2P_dt0 / (T * T);
  const reconV1 = dP_dt1 / T, reconA1 = d2P_dt1 / (T * T);
  const VTOL = 1e-5, ATOL = 1e-3; // finite-diff error budget (2nd diff is O(e²·scale))
  assert(Math.abs(reconV0 - v0) < VTOL, `quintic v(0)=${reconV0} ≈ ${v0}`);
  assert(Math.abs(reconV1 - v1) < VTOL, `quintic v(1)=${reconV1} ≈ ${v1}`);
  assert(Math.abs(reconA0 - a0) < ATOL, `quintic a(0)=${reconA0} ≈ ${a0}`);
  assert(Math.abs(reconA1 - a1) < ATOL, `quintic a(1)=${reconA1} ≈ ${a1}`);

  ok("trajectory-quintic-endpoints-C2");
}

// ── 84. quintic f32 within-ULP over a dense t-grid (0.9.80) ──────────────
//
// JS computes the basis in f64; f32 only enters at input-read and the out
// store. So the f32 path is bit-exact to a reference that computes the same
// f64 expression from the f32-widened inputs and frounds the result. Swept
// over a dense t-grid and a wide dynamic range to exercise the cancellation-
// prone region near t→1.
function testTrajectoryQuinticFloat32Truncation(): void {
  const rng = mulberry32(0xF32C);
  const N = 64;
  const T = 2.0;
  const prev = new Float32Array(N * 3);
  const curr = new Float32Array(N * 3);
  for (let k = 0; k < prev.length; k++) prev[k] = Math.fround((rng() - 0.5) * 1e4);
  for (let k = 0; k < curr.length; k++) curr[k] = Math.fround((rng() - 0.5) * 1e4);
  const spec: TrajectorySpec = { order: 3, sampleCount: N };
  const out = new Float32Array(N);

  const grid = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999, 1];
  for (const t of grid) {
    evaluateQuinticHermiteTrajectoryInto(prev, curr, spec, t, T, out);
    for (let i = 0; i < N; i++) {
      const j = i * 3;
      // Reference: same f64 expression on f32-widened inputs, frounded once.
      const ref = Math.fround(
        quinticRef(prev[j]!, prev[j + 1]!, prev[j + 2]!, curr[j]!, curr[j + 1]!, curr[j + 2]!, t, T),
      );
      assertEq(out[i], ref, `quintic f32 t=${t} sample ${i} bit-exact vs frounded f64`);
    }
  }

  ok("trajectory-quintic-f32-truncation");
}

// ── 85. evaluateHermiteInto interpolationMode dispatch (0.9.80) ───────────
//
// A 'quintic-hermite' field must route through the quintic evaluator (output
// matches the standalone `evaluateQuinticHermiteTrajectoryInto`); a default
// (cubic) field still routes through the cubic evaluator; a 'septic-hermite'
// field throws the staged "lands in 0.9.81" error.
function testHermiteInterpolationModeDispatch(): void {
  const N = 6;
  const t = 0.37, segSec = 1.0;
  const schema = defineSchema({
    seq: u64(),
    qEff: f64TrajectoryArray(N, { order: 3, interpolationMode: "quintic-hermite" }),
    cEff: f64TrajectoryArray(N, { order: 3, interpolationMode: "hermite" }),
  });
  const { sab, capacity } = Bridge.allocate(4, schema);
  const bridge = new Bridge(sab, capacity, schema);

  const prev = bridge.scratchFrame();
  const curr = bridge.scratchFrame();
  const rng = mulberry32(0x9D17);
  prev.seq = 1n; curr.seq = 2n;
  prev.qEff = new Float64Array(N * 3);
  curr.qEff = new Float64Array(N * 3);
  prev.cEff = new Float64Array(N * 3);
  curr.cEff = new Float64Array(N * 3);
  for (let k = 0; k < N * 3; k++) {
    prev.qEff[k] = (rng() - 0.5) * 50; curr.qEff[k] = (rng() - 0.5) * 50;
    prev.cEff[k] = prev.qEff[k]!; curr.cEff[k] = curr.qEff[k]!;
  }

  const outFrame = bridge.scratchEvaluatedFrame();
  bridge.evaluateHermiteInto(prev, curr, t, segSec, outFrame);

  // qEff must match the standalone quintic evaluator; cEff the cubic one.
  const refQ = new Float64Array(N);
  evaluateQuinticHermiteTrajectoryInto(
    prev.qEff, curr.qEff, { order: 3, sampleCount: N }, t, segSec, refQ,
  );
  for (let i = 0; i < N; i++) {
    assertEq(outFrame.qEff[i], refQ[i]!, `evaluateHermiteInto quintic dispatch sample ${i}`);
  }
  // cEff (cubic) ignores acceleration → differs from quintic on the same data.
  let anyDiff = false;
  for (let i = 0; i < N; i++) if (outFrame.cEff[i] !== outFrame.qEff[i]) anyDiff = true;
  assert(anyDiff, "cubic and quintic produce different output on identical (p,v,a) data");

  // 'septic-hermite' (order=4) throws the staged error.
  const septicSchema = defineSchema({
    seq: u64(),
    sEff: f64TrajectoryArray(N, { order: 4, interpolationMode: "septic-hermite" }),
  });
  const { sab: sab2, capacity: cap2 } = Bridge.allocate(4, septicSchema);
  const b2 = new Bridge(sab2, cap2, septicSchema);
  const p2 = b2.scratchFrame(); const c2 = b2.scratchFrame();
  p2.seq = 1n; c2.seq = 2n;
  p2.sEff = new Float64Array(N * 4); c2.sEff = new Float64Array(N * 4);
  const of2 = b2.scratchEvaluatedFrame();
  let threw = false;
  try { b2.evaluateHermiteInto(p2, c2, t, segSec, of2); } catch { threw = true; }
  assert(threw, "evaluateHermiteInto 'septic-hermite' throws (lands in 0.9.81)");

  ok("hermite-interpolation-mode-dispatch");
}

function main(): void {
  testEvaluateIntoMixedSchema();
  testEvaluateIntoNoTrajectorySchema();
  testEvaluateIntoValidation();
  testTrajectoryVelocityClamp();
  testTrajectoryAccelerationClamp();
  testTrajectoryHoldFallback();
  testTrajectoryDeltaSaturate();
  testTrajectoryClampFreeBitExact();
  testForEachSampleInQuantum();
  testTrajectoryOrder4Taylor();
  testTrajectoryQuinticBitExact();
  testTrajectoryQuinticEndpoints();
  testTrajectoryQuinticFloat32Truncation();
  testHermiteInterpolationModeDispatch();
  console.log("\nAll Bridge trajectory tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
