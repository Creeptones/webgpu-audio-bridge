/**
 * Bridge.pullPredictedLatest + lastReadbackMedianMs — first-class "negative
 * latency" mode (0.9.71).
 *
 * Exercises the Bridge-level wiring of confidence-bounded predictive
 * extrapolation: a cold PLL degrades to a plain latest-frame hold, a warm PLL
 * leads each trajectory field forward by leadMs with the documented
 * w·taylor(dtEff)+(1−w)·hold blend, the confidence floor gates prediction off,
 * non-trajectory fields pass through verbatim, the cached frame keeps
 * predicting through a producer famine, and the readback-latency rolling
 * median tracks both explicit samples and auto-recorded frame staleness.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.predictLatest.test.ts
 *
 * Pins (this suite opens its own list at 91):
 *  91. testColdPllHoldsLikePullLatest
 *  92. testWarmPllLeadsForward
 *  93. testConfidenceFloorGatesAtBridge
 *  94. testNonTrajectoryPassthrough
 *  95. testFaminePredictsFromCache
 *  96. testReadbackMedianExplicit
 *  97. testReadbackMedianWindowSaturation
 *  98. testClampAndValidation
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f64,
  f64TrajectoryArray,
  u64,
  u8Array,
} from "../src/schema.js";

const N = 8;

function approx(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

/** Schema: a u64 timestamp (ns) + an order-2 trajectory field. */
function trajSchema() {
  return defineSchema({
    seq: u64(),
    t: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  }).withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });
}

/** Fill an order-2 [p,v] interleaved frame field: p_i = i·0.1, v_i = (i+1)·0.5. */
function fillTraj(): Float64Array {
  const f = new Float64Array(N * 2);
  for (let i = 0; i < N; i++) {
    f[i * 2] = i * 0.1;
    f[i * 2 + 1] = (i + 1) * 0.5;
  }
  return f;
}

/** Push one trajectory frame stamped at `tNs`. */
function pushFrame(bridge: any, seq: bigint, tNs: number): void {
  const fr = bridge.scratchFrame();
  fr.seq = seq;
  fr.t = BigInt(Math.round(tNs));
  fr.vEff.set(fillTraj());
  assert(bridge.push(fr), "push frame");
}

/** Warm the PLL to a locked, low-sigma state by pushing + predicted-pulling
 *  several frames with a tiny consistent jitter so the EWMA sigma settles
 *  small (well under the 2 ms floor). Returns the last consumer base used. */
function warmPll(bridge: any, periodNs: number, count: number): number {
  const evalFrame = bridge.scratchEvaluatedFrame();
  let consumerNs = 1_000_000;
  for (let k = 0; k < count; k++) {
    const tNs = consumerNs; // offset 0
    pushFrame(bridge, BigInt(k + 1), tNs);
    // Inject ~500 ns of jitter so sigma builds to a small positive value.
    const jitter = (k % 2 === 0 ? 1 : -1) * 500;
    bridge.pullPredictedLatest(evalFrame, { leadMs: 0, consumerNs: consumerNs + jitter });
    consumerNs += periodNs;
  }
  return consumerNs;
}

// ── 91. Cold PLL → pullPredictedLatest is a plain latest-frame hold ──────────
function testColdPllHoldsLikePullLatest(): void {
  const schema = trajSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  pushFrame(bridge, 1n, 0);
  const out = bridge.scratchEvaluatedFrame();
  // No consumerNs → PLL never observed → unlocked → w=0 even with a big lead.
  const r = bridge.pullPredictedLatest(out, { leadMs: 10, maxLeadMs: 20 });
  assert(r.skipped >= 0, "fresh frame pulled");
  assertEq(r.predicted, false, "cold PLL → predicted=false");
  assertEq(r.confidenceWeight, 0, "cold PLL → w=0");
  assertEq(r.dtEffectiveSeconds, 0, "cold PLL → dtEff=0");
  // Output is exactly the held positions (p_i), not extrapolated.
  for (let i = 0; i < N; i++) {
    assertEq(out.vEff[i]!, i * 0.1, `cold out[${i}] held position`);
  }
  ok("91 cold PLL holds like pullLatest");
}

// ── 92. Warm PLL leads each trajectory field forward by leadMs ───────────────
function testWarmPllLeadsForward(): void {
  const schema = trajSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  const periodNs = 16_000_000; // ~60 Hz
  const nextConsumer = warmPll(bridge, periodNs, 12);

  // Now a predicted pull with a real lead inside a fully-trusted horizon.
  pushFrame(bridge, 99n, nextConsumer);
  const out = bridge.scratchEvaluatedFrame();
  const leadMs = 5;
  const r = bridge.pullPredictedLatest(out, {
    leadMs,
    maxLeadMs: 20,
    trustedLeadMs: 20, // c_horizon = 1 across the whole lead
    consumerNs: nextConsumer,
  });
  assert(r.predicted, "warm PLL → predicted=true");
  assert(r.confidenceWeight > 0 && r.confidenceWeight <= 1, "0 < w <= 1");
  // dtEff = w · leadSeconds (the module's documented relationship).
  assert(
    approx(r.dtEffectiveSeconds, r.confidenceWeight * leadMs * 1e-3, 1e-15),
    "dtEff = w · leadSeconds",
  );
  // Output is the exact blend w·(p+v·dtEff) + (1−w)·p, recoverable from the
  // returned w + dtEff and the known field values.
  const w = r.confidenceWeight;
  const dtEff = r.dtEffectiveSeconds;
  for (let i = 0; i < N; i++) {
    const p = i * 0.1;
    const v = (i + 1) * 0.5;
    const expected = w * (p + v * dtEff) + (1 - w) * p;
    assert(approx(out.vEff[i]!, expected, 1e-12), `warm out[${i}] blend`);
  }
  // A nonzero-velocity sample must actually have moved off the hold.
  assert(out.vEff[7]! !== 7 * 0.1, "leading sample moved off the hold");
  ok("92 warm PLL leads forward");
}

// ── 93. confidenceFloor gates prediction off at the Bridge level ─────────────
function testConfidenceFloorGatesAtBridge(): void {
  const schema = trajSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  const periodNs = 16_000_000;
  const nextConsumer = warmPll(bridge, periodNs, 12);

  // No-floor pull to read the natural weight (no observe — uses warm state).
  pushFrame(bridge, 50n, nextConsumer);
  const out1 = bridge.scratchEvaluatedFrame();
  const rOpen = bridge.pullPredictedLatest(out1, {
    leadMs: 5,
    trustedLeadMs: 20,
  });
  assert(rOpen.predicted, "open floor → predicted");
  const w = rOpen.confidenceWeight;
  assert(w > 0 && w < 1, "natural weight strictly between 0 and 1");

  // Floor just above the natural weight → collapses to the hold.
  pushFrame(bridge, 51n, nextConsumer);
  const out2 = bridge.scratchEvaluatedFrame();
  const rGated = bridge.pullPredictedLatest(out2, {
    leadMs: 5,
    trustedLeadMs: 20,
    confidenceFloor: Math.min(1, w + 0.01),
  });
  assertEq(rGated.predicted, false, "floor above w → predicted=false");
  assertEq(rGated.confidenceWeight, 0, "gated → w=0");
  for (let i = 0; i < N; i++) {
    assertEq(out2.vEff[i]!, i * 0.1, `gated out[${i}] held`);
  }
  ok("93 confidenceFloor gates at bridge");
}

// ── 94. Non-trajectory fields pass through from the latest frame ─────────────
function testNonTrajectoryPassthrough(): void {
  const schema = defineSchema({
    seq: u64(),
    t: u64(),
    gain: f64(),
    label: u8Array(4),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  }).withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  const fr = bridge.scratchFrame();
  fr.seq = 7n;
  fr.t = 0n;
  fr.gain = 0.625;
  fr.label = new Uint8Array([1, 2, 3, 4]);
  fr.vEff.set(fillTraj());
  assert(bridge.push(fr), "push mixed frame");

  const out = bridge.scratchEvaluatedFrame();
  const r = bridge.pullPredictedLatest(out, { leadMs: 10 });
  assert(r.skipped >= 0, "pulled");
  // Scalars + non-trajectory arrays are the latest known state verbatim.
  assertEq(out.seq, 7n, "u64 scalar passthrough");
  assertEq(out.gain, 0.625, "f64 scalar passthrough");
  for (let i = 0; i < 4; i++) {
    assertEq(out.label[i]!, i + 1, `label[${i}] passthrough`);
  }
  ok("94 non-trajectory passthrough");
}

// ── 95. Producer famine: predicts off the cached frame when the ring empties ─
function testFaminePredictsFromCache(): void {
  const schema = trajSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  const out = bridge.scratchEvaluatedFrame();

  // Empty ring, nothing cached → predicted=false, skipped=-1, no throw.
  const rEmpty = bridge.pullPredictedLatest(out, { leadMs: 5 });
  assertEq(rEmpty.skipped, -1, "empty + no cache → skipped=-1");
  assertEq(rEmpty.predicted, false, "empty + no cache → predicted=false");

  // Warm + cache a frame, then drain dry; the next pull rides the cache.
  const periodNs = 16_000_000;
  const nextConsumer = warmPll(bridge, periodNs, 12);
  pushFrame(bridge, 200n, nextConsumer);
  bridge.pullPredictedLatest(out, { leadMs: 0, consumerNs: nextConsumer }); // drains, caches
  // Ring now empty; predict forward off the cached frame.
  const rFamine = bridge.pullPredictedLatest(out, { leadMs: 5, trustedLeadMs: 20 });
  assertEq(rFamine.skipped, -1, "famine → ring empty (skipped=-1)");
  assert(rFamine.predicted, "famine still predicts off cache");
  assert(rFamine.confidenceWeight > 0, "famine cache prediction has weight");
  ok("95 famine predicts from cache");
}

// ── 96. lastReadbackMedianMs over explicit recorded samples ─────────────────
function testReadbackMedianExplicit(): void {
  const schema = trajSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  assertEq(bridge.lastReadbackMedianMs(), 0, "no samples → 0");

  // Odd count → middle element.
  bridge.recordReadbackLatency(30);
  bridge.recordReadbackLatency(10);
  bridge.recordReadbackLatency(20);
  assertEq(bridge.lastReadbackMedianMs(), 20, "odd → middle (20)");

  // Even count → mean of the two central elements (10,20,30,40 → 25).
  bridge.recordReadbackLatency(40);
  assertEq(bridge.lastReadbackMedianMs(), 25, "even → mean of middles (25)");

  // Bad samples ignored — median unchanged.
  bridge.recordReadbackLatency(NaN);
  bridge.recordReadbackLatency(-5);
  bridge.recordReadbackLatency(Infinity);
  assertEq(bridge.lastReadbackMedianMs(), 25, "bad samples ignored");
  ok("96 readback median explicit");
}

// ── 97. lastReadbackMedianMs window saturates (circular overwrite) ───────────
//
// The window holds a fixed number of samples; once full, new samples evict the
// oldest. Recording many low samples then flooding with a higher value past
// the window length must move the median fully to the new value.
function testReadbackMedianWindowSaturation(): void {
  const schema = trajSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  // Fill well past the window with 5 ms, then a single 12 ms.
  for (let i = 0; i < 100; i++) bridge.recordReadbackLatency(5);
  bridge.recordReadbackLatency(12);
  // The window is now [5 × (W−1), 12]; median is still 5 (one outlier).
  assertEq(bridge.lastReadbackMedianMs(), 5, "single fresh outlier doesn't move median");

  // Now flood with 12 ms past the window length — the 5 ms samples are all
  // evicted and the median jumps to 12.
  for (let i = 0; i < 100; i++) bridge.recordReadbackLatency(12);
  assertEq(bridge.lastReadbackMedianMs(), 12, "window saturated → median follows recent");
  ok("97 readback median window saturation");
}

// ── 98. lead clamping + argument validation ─────────────────────────────────
function testClampAndValidation(): void {
  const schema = trajSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  const periodNs = 16_000_000;
  const nextConsumer = warmPll(bridge, periodNs, 12);
  const out = bridge.scratchEvaluatedFrame();

  // leadMs above maxLeadMs is clamped: leadSecondsRequested == maxLeadMs.
  pushFrame(bridge, 1n, nextConsumer);
  const r = bridge.pullPredictedLatest(out, { leadMs: 100, maxLeadMs: 20 });
  assert(approx(r.leadSecondsRequested, 0.02, 1e-15), "lead clamped to maxLeadMs");

  // Negative / non-finite lead throws.
  let threw = false;
  try { bridge.pullPredictedLatest(out, { leadMs: -1 }); } catch { threw = true; }
  assert(threw, "negative leadMs throws");
  threw = false;
  try { bridge.pullPredictedLatest(out, { leadMs: NaN }); } catch { threw = true; }
  assert(threw, "NaN leadMs throws");
  threw = false;
  try { bridge.pullPredictedLatest(out, { maxLeadMs: -5 }); } catch { threw = true; }
  assert(threw, "negative maxLeadMs throws");

  // Non-finite consumerNs on the warm path throws.
  threw = false;
  pushFrame(bridge, 2n, nextConsumer);
  try { bridge.pullPredictedLatest(out, { leadMs: 1, consumerNs: NaN }); } catch { threw = true; }
  assert(threw, "NaN consumerNs throws");
  ok("98 clamp + validation");
}

function main(): void {
  testColdPllHoldsLikePullLatest();
  testWarmPllLeadsForward();
  testConfidenceFloorGatesAtBridge();
  testNonTrajectoryPassthrough();
  testFaminePredictsFromCache();
  testReadbackMedianExplicit();
  testReadbackMedianWindowSaturation();
  testClampAndValidation();
  console.log("\nAll Bridge predictLatest tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
