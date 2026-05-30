/**
 * Bridge.pullHermiteLatest — one-call two-frame Hermite reconstruction (0.9.84).
 *
 * The high-level consumer entry point that `evaluateHermiteInto` was missing:
 * it retains the prev+curr frame pair, derives t∈[0,1] + segmentSeconds from
 * the PLL-mapped consumer clock vs the two frames' timestamps, and reconstructs
 * each trajectory field via the schema's interpolationMode. These pins prove the
 * wiring: hold-before-second-frame, interior interpolation (against the
 * evaluateHermiteInto / evaluateQuinticHermiteTrajectoryInto oracles), boundary
 * clamping, famine ride-through, and validation. The PLL is used as its own
 * oracle (phaseLockedTime is public) so the test is robust to lock dynamics.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.hermiteLatest.test.ts
 *
 * Pins (this suite opens its own list at 120):
 *  120. testHoldsBeforeSecondFrame
 *  121. testInterpolatesBetweenTwoFrames   (quintic dispatch + oracle)
 *  122. testClampsAtBoundaries
 *  123. testFamineRidesCachedPair
 *  124. testValidationAndEmpty
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f64TrajectoryArray,
  u64,
  type TrajectorySpec,
} from "../src/schema.js";
import {
  evaluateHermiteTrajectoryInto,
  evaluateQuinticHermiteTrajectoryInto,
} from "../src/trajectory.js";

const N = 4;

/** Schema: u64 ns timestamp + an order-3 quintic-Hermite (C²) trajectory. */
function quinticSchema() {
  return defineSchema({
    seq: u64(),
    t: u64(),
    q: f64TrajectoryArray(N, { order: 3, interpolationMode: "quintic-hermite" }),
  }).withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });
}
const SPEC: TrajectorySpec = { order: 3, sampleCount: N, interpolationMode: "quintic-hermite" };

/** Distinct (p, v, a) per sample, parameterized by a phase so prev ≠ curr. */
function fillQ(phase: number): Float64Array {
  const f = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    f[i * 3] = Math.sin(i * 0.5 + phase);
    f[i * 3 + 1] = Math.cos(i * 0.5 + phase) * 3;
    f[i * 3 + 2] = -Math.sin(i * 0.5 + phase) * 7;
  }
  return f;
}

function makeBridge() {
  const schema = quinticSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  bridge.setSampleRate(48000);
  return bridge;
}

function pushFrame(bridge: ReturnType<typeof makeBridge>, seq: bigint, tNs: number, q: Float64Array): void {
  const f = bridge.scratchFrame();
  f.seq = seq;
  f.t = BigInt(tNs);
  f.q = q;
  assert(bridge.push(f), `push seq=${seq}`);
}

// ── 120. Before a second distinct frame, holds the current frame's positions ──
function testHoldsBeforeSecondFrame(): void {
  const bridge = makeBridge();
  const q1 = fillQ(0.3);
  pushFrame(bridge, 1n, 1_000_000, q1);
  const out = bridge.scratchEvaluatedFrame();
  const skipped = bridge.pullHermiteLatest(out, 1_000_000);
  assert(skipped >= 0, "first pull is fresh");
  for (let i = 0; i < N; i++) {
    assertEq(out.q[i], q1[i * 3]!, `hold: sample ${i} == prev position`);
  }
  ok("hermite-latest-holds-before-second-frame");
}

// ── 121. Interior interpolation routes through quintic + matches the oracle ──
function testInterpolatesBetweenTwoFrames(): void {
  const bridge = makeBridge();
  const q1 = fillQ(0.3);
  const q2 = fillQ(1.1);
  // Feed consumer==producer so the PLL maps cleanly and t lands interior.
  pushFrame(bridge, 1n, 1_000_000, q1);
  const hold = bridge.scratchEvaluatedFrame();
  bridge.pullHermiteLatest(hold, 1_000_000); // curr=frame1, prev=null
  pushFrame(bridge, 2n, 2_000_000, q2);
  const out = bridge.scratchEvaluatedFrame();
  const skipped = bridge.pullHermiteLatest(out, 1_500_000); // rotate: prev=f1, curr=f2
  assertEq(skipped, 0, "second pull skipped exactly 0 (one new frame)");

  // Oracle: replicate the method's t using the bridge's own (public) PLL map.
  const seg = 2_000_000 - 1_000_000;
  const producerNs = bridge.phaseLockedTime(1_500_000);
  let t = (producerNs - 1_000_000) / seg;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  assert(t > 0 && t < 1, `t is interior (got ${t})`);

  // (a) matches evaluateHermiteInto on the same pair (confirms wiring).
  const refFrame = bridge.scratchEvaluatedFrame();
  bridge.evaluateHermiteInto(
    { seq: 1n, t: 1_000_000n, q: q1 } as never,
    { seq: 2n, t: 2_000_000n, q: q2 } as never,
    t, seg * 1e-9, refFrame,
  );
  for (let i = 0; i < N; i++) {
    assertEq(out.q[i], refFrame.q[i]!, `interp: sample ${i} matches evaluateHermiteInto`);
  }
  // (b) matches the QUINTIC evaluator directly (confirms mode dispatch),
  //     and DIFFERS from cubic on the same data (confirms it isn't falling back).
  const refQuintic = new Float64Array(N);
  evaluateQuinticHermiteTrajectoryInto(q1, q2, SPEC, t, seg * 1e-9, refQuintic);
  const refCubic = new Float64Array(N);
  evaluateHermiteTrajectoryInto(q1, q2, SPEC, t, seg * 1e-9, refCubic);
  let anyDiff = false;
  for (let i = 0; i < N; i++) {
    assertEq(out.q[i], refQuintic[i]!, `interp: sample ${i} == quintic evaluator`);
    if (refQuintic[i] !== refCubic[i]) anyDiff = true;
  }
  assert(anyDiff, "quintic and cubic differ on this data (dispatch is real, not cubic fallback)");
  ok("hermite-latest-interpolates-quintic");
}

// ── 122. t clamps to [0,1] — interpolator holds at the boundaries ──
function testClampsAtBoundaries(): void {
  const bridge = makeBridge();
  const q1 = fillQ(0.3);
  const q2 = fillQ(1.1);
  pushFrame(bridge, 1n, 1_000_000, q1);
  bridge.pullHermiteLatest(bridge.scratchEvaluatedFrame(), 1_000_000);
  pushFrame(bridge, 2n, 2_000_000, q2);
  bridge.pullHermiteLatest(bridge.scratchEvaluatedFrame(), 2_000_000); // rotate

  // Far before prev → producerNs < prevTs → t clamps to 0 → prev positions.
  const lo = bridge.scratchEvaluatedFrame();
  bridge.pullHermiteLatest(lo, -5_000_000); // famine ride (no new frame), extreme baseNs
  const pLo = bridge.phaseLockedTime(-5_000_000);
  assert((pLo - 1_000_000) / 1_000_000 < 0, "lo case raw t < 0 (clamp engages)");
  for (let i = 0; i < N; i++) {
    assertEq(lo.q[i], q1[i * 3]!, `clamp-lo: sample ${i} == prev position`);
  }

  // Far past curr → producerNs > currTs → t clamps to 1 → curr positions.
  const hi = bridge.scratchEvaluatedFrame();
  bridge.pullHermiteLatest(hi, 50_000_000);
  const pHi = bridge.phaseLockedTime(50_000_000);
  assert((pHi - 1_000_000) / 1_000_000 > 1, "hi case raw t > 1 (clamp engages)");
  for (let i = 0; i < N; i++) {
    assertEq(hi.q[i], q2[i * 3]!, `clamp-hi: sample ${i} == curr position`);
  }
  ok("hermite-latest-clamps-at-boundaries");
}

// ── 123. Producer famine: rides the cached pair, returns -1, still reconstructs ──
function testFamineRidesCachedPair(): void {
  const bridge = makeBridge();
  const q1 = fillQ(0.3);
  const q2 = fillQ(1.1);
  pushFrame(bridge, 1n, 1_000_000, q1);
  bridge.pullHermiteLatest(bridge.scratchEvaluatedFrame(), 1_000_000);
  pushFrame(bridge, 2n, 2_000_000, q2);
  bridge.pullHermiteLatest(bridge.scratchEvaluatedFrame(), 1_500_000);

  // No new frame. Same baseConsumerNs → must reproduce the same interior result.
  const a = bridge.scratchEvaluatedFrame();
  const skipped = bridge.pullHermiteLatest(a, 1_500_000);
  assertEq(skipped, -1, "famine pull returns -1 (no fresh frame)");
  const producerNs = bridge.phaseLockedTime(1_500_000);
  let t = (producerNs - 1_000_000) / 1_000_000;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const ref = new Float64Array(N);
  evaluateQuinticHermiteTrajectoryInto(q1, q2, SPEC, t, 1_000_000 * 1e-9, ref);
  for (let i = 0; i < N; i++) {
    assertEq(a.q[i], ref[i]!, `famine: sample ${i} reconstructs from cached pair`);
  }
  ok("hermite-latest-famine-rides-cached-pair");
}

// ── 124. Validation + empty ring ──
function testValidationAndEmpty(): void {
  const bridge = makeBridge();
  const out = bridge.scratchEvaluatedFrame();

  // Empty ring, never pulled → -1.
  assertEq(bridge.pullHermiteLatest(out, 1_000_000), -1, "empty ring → -1");

  // Non-finite baseConsumerNs throws.
  let threw = false;
  try { bridge.pullHermiteLatest(out, Number.NaN); } catch { threw = true; }
  assert(threw, "non-finite baseConsumerNs throws");

  // Schema without timestamps throws.
  const noTs = defineSchema({ seq: u64(), q: f64TrajectoryArray(N, { order: 3 }) });
  const { sab, capacity } = Bridge.allocate(4, noTs);
  const b2 = new Bridge(sab, capacity, noTs);
  threw = false;
  try { b2.pullHermiteLatest(b2.scratchEvaluatedFrame() as never, 1_000_000); } catch { threw = true; }
  assert(threw, "schema without .withTimestamps throws");

  ok("hermite-latest-validation-and-empty");
}

function main(): void {
  testHoldsBeforeSecondFrame();
  testInterpolatesBetweenTwoFrames();
  testClampsAtBoundaries();
  testFamineRidesCachedPair();
  testValidationAndEmpty();
  console.log("\nAll Bridge.pullHermiteLatest tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
