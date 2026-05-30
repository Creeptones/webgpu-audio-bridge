/**
 * Bridge.pullKalmanPredictedLatest — history-aware classical predictive pull
 * (Apollo Frontier 2, 0.9.902). Node/tsx, assert-helper convention.
 *
 * Exercises the Bridge-level wiring of the per-field `StatePredictor`:
 *   - a cold / single-frame filter degrades to a plain latest-frame hold
 *     (variance ≥ seed ⇒ weight 0), the never-worse-than-`pullLatest` guarantee;
 *   - a warmed filter leads each trajectory field forward, near-exactly for a
 *     constant-velocity (CV, order-2) or constant-acceleration (CA, order-3)
 *     ground truth, and estimates velocity for a position-only (order-1) field
 *     that single-frame Taylor could only hold;
 *   - the horizon ceiling (`leadMs ≥ maxLeadMs`) and the `confidenceFloor` cliff
 *     both collapse to the hold;
 *   - non-trajectory fields pass through; the cached frame rides a producer
 *     famine; `.withTimestamps(...)` is required.
 *
 *   npx tsx tests/Bridge.kalmanPredict.test.ts
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f64,
  f64Array,
  f64TrajectoryArray,
  u64,
} from "../src/schema.js";

const N = 8;
const PERIOD_NS = 16_666_667; // ~60 Hz

function trajSchema(order: 1 | 2 | 3) {
  return defineSchema({
    seq: u64(),
    t: u64(),
    vEff: f64TrajectoryArray(N, { order }),
  }).withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });
}

// Ground-truth motion per lane i (seconds → value). CV uses base+v·s; CA adds
// ½a·s². v_i and a_i grow with the lane so the lanes are distinguishable.
const base = (i: number) => i * 0.1;
const vel = (i: number) => 0.5 * (i + 1);
const acc = (i: number) => 0.2 * (i + 1);
function truthPos(order: number, i: number, s: number): number {
  if (order >= 3) return base(i) + vel(i) * s + 0.5 * acc(i) * s * s;
  return base(i) + vel(i) * s;
}

/** Fill an interleaved trajectory frame for the given order at time s seconds. */
function fillTraj(order: number, s: number): Float64Array {
  const f = new Float64Array(N * order);
  for (let i = 0; i < N; i++) {
    const j = i * order;
    f[j] = truthPos(order, i, s);
    if (order >= 2) f[j + 1] = order >= 3 ? vel(i) + acc(i) * s : vel(i);
    if (order >= 3) f[j + 2] = acc(i);
  }
  return f;
}

function pushFrame(bridge: any, order: number, seq: number, tNs: number): void {
  const fr = bridge.scratchFrame();
  fr.seq = BigInt(seq);
  fr.t = BigInt(Math.round(tNs));
  fr.vEff.set(fillTraj(order, tNs * 1e-9));
  assert(bridge.push(fr), "push frame");
}

/** Push + kalman-pull `count` frames at lead 0 to converge the filters. Returns
 *  the last frame's time in ns. */
function warm(bridge: any, order: number, count: number, opts: any = {}): number {
  const evalFrame = bridge.scratchEvaluatedFrame();
  let tNs = 1_000_000;
  for (let k = 0; k < count; k++) {
    pushFrame(bridge, order, k + 1, tNs);
    bridge.pullKalmanPredictedLatest(evalFrame, { leadMs: 0, ...opts });
    if (k < count - 1) tNs += PERIOD_NS;
  }
  return tNs;
}

function makeBridge(order: 1 | 2 | 3) {
  const schema = trajSchema(order);
  const { sab, capacity } = Bridge.allocate(16, schema);
  return new Bridge(sab, capacity, schema);
}

function main(): void {
  // ── 1: requires .withTimestamps(...) ─────────────────────────────────────
  {
    const schema = defineSchema({ seq: u64(), vEff: f64TrajectoryArray(N, { order: 2 }) });
    const { sab, capacity } = Bridge.allocate(16, schema);
    const bridge = new Bridge(sab, capacity, schema);
    const out = bridge.scratchEvaluatedFrame();
    let threw = false;
    try { bridge.pullKalmanPredictedLatest(out, { leadMs: 5 }); } catch { threw = true; }
    assert(threw, "pullKalmanPredictedLatest throws without timestamps");
    ok("kalman-requires-timestamps");
  }

  // ── 2: cold / single frame → latest-frame hold (w=0) ─────────────────────
  {
    const bridge = makeBridge(2);
    const out = bridge.scratchEvaluatedFrame();
    pushFrame(bridge, 2, 1, 1_000_000);
    const r = bridge.pullKalmanPredictedLatest(out, { leadMs: 5, trustedLeadMs: 5 });
    assertEq(r.predicted, false, "cold: predicted false");
    assertEq(r.confidenceWeight, 0, "cold: weight 0");
    assert(r.maxVariance >= 1e6, `cold: variance ≥ seed (got ${r.maxVariance})`);
    // Output equals the freshest frame's position lane (the hold).
    for (let i = 0; i < N; i++) {
      assertEq(out.vEff[i], truthPos(2, i, 1_000_000 * 1e-9), `cold hold lane ${i}`);
    }
    ok("kalman-cold-hold");
  }

  // ── 3: warmed CV (order-2) leads forward near-exactly ────────────────────
  {
    const bridge = makeBridge(2);
    const tLast = warm(bridge, 2, 30);
    const sLast = tLast * 1e-9;
    const leadMs = 8;
    const out = bridge.scratchEvaluatedFrame();
    // Famine pull (ring drained by warm) → predict off cache at tLast + lead.
    const r = bridge.pullKalmanPredictedLatest(out, { leadMs, trustedLeadMs: leadMs });
    assert(r.predicted, "warm CV: predicted true");
    assert(r.confidenceWeight > 0.99, `warm CV: weight≈1 (got ${r.confidenceWeight})`);
    const sFuture = sLast + leadMs * 1e-3;
    const i = N - 1; // fastest lane
    const predErr = Math.abs(out.vEff[i]! - truthPos(2, i, sFuture));
    const holdErr = Math.abs(truthPos(2, i, sLast) - truthPos(2, i, sFuture));
    assert(predErr < holdErr * 0.02, `warm CV beats hold (pred ${predErr.toExponential(2)} ≪ hold ${holdErr.toExponential(2)})`);
    ok("kalman-warm-cv-leads-forward");
  }

  // ── 4: position-only (order-1) estimates velocity, beats a hold ──────────
  {
    const bridge = makeBridge(1);
    const tLast = warm(bridge, 1, 40);
    const sLast = tLast * 1e-9;
    const leadMs = 8;
    const out = bridge.scratchEvaluatedFrame();
    const r = bridge.pullKalmanPredictedLatest(out, { leadMs, trustedLeadMs: leadMs });
    assert(r.predicted, "order-1: predicted true");
    const sFuture = sLast + leadMs * 1e-3;
    const i = N - 1;
    const predErr = Math.abs(out.vEff[i]! - truthPos(1, i, sFuture));
    const holdErr = Math.abs(truthPos(1, i, sLast) - truthPos(1, i, sFuture));
    assert(predErr < holdErr * 0.3, `order-1 predict (err ${predErr.toExponential(2)}) beats hold (err ${holdErr.toExponential(2)})`);
    ok("kalman-position-only-velocity");
  }

  // ── 5: warmed CA (order-3) leads a curved trajectory near-exactly ────────
  {
    const bridge = makeBridge(3);
    const tLast = warm(bridge, 3, 30);
    const sLast = tLast * 1e-9;
    const leadMs = 8;
    const out = bridge.scratchEvaluatedFrame();
    const r = bridge.pullKalmanPredictedLatest(out, { leadMs, trustedLeadMs: leadMs });
    assert(r.predicted, "warm CA: predicted true");
    const sFuture = sLast + leadMs * 1e-3;
    const i = N - 1;
    const predErr = Math.abs(out.vEff[i]! - truthPos(3, i, sFuture));
    const holdErr = Math.abs(truthPos(3, i, sLast) - truthPos(3, i, sFuture));
    assert(predErr < holdErr * 0.05, `warm CA beats hold (pred ${predErr.toExponential(2)} ≪ hold ${holdErr.toExponential(2)})`);
    ok("kalman-warm-ca-leads-forward");
  }

  // ── 6: lead ≥ maxLeadMs → full hold ──────────────────────────────────────
  {
    const bridge = makeBridge(2);
    warm(bridge, 2, 30);
    const out = bridge.scratchEvaluatedFrame();
    const r = bridge.pullKalmanPredictedLatest(out, { leadMs: 20, maxLeadMs: 20 });
    assertEq(r.predicted, false, "lead=maxLead: predicted false");
    assertEq(r.confidenceWeight, 0, "lead=maxLead: weight 0");
    ok("kalman-maxlead-ceiling-holds");
  }

  // ── 7: confidenceFloor cliff collapses a marginal weight to hold ─────────
  {
    const bridge = makeBridge(2);
    const tLast = warm(bridge, 2, 30);
    const sLast = tLast * 1e-9;
    const out = bridge.scratchEvaluatedFrame();
    // leadMs=10, maxLeadMs=20, trusted=0 → cHorizon=0.5 → w≈0.5 < floor 0.9 ⇒ hold.
    const r = bridge.pullKalmanPredictedLatest(out, { leadMs: 10, maxLeadMs: 20, confidenceFloor: 0.9 });
    assertEq(r.confidenceWeight, 0, "confidenceFloor: weight cliffed to 0");
    for (let i = 0; i < N; i++) {
      assertEq(out.vEff[i], truthPos(2, i, sLast), `confidenceFloor hold lane ${i}`);
    }
    ok("kalman-confidence-floor-cliff");
  }

  // ── 8: non-trajectory fields pass through verbatim ───────────────────────
  {
    const schema = defineSchema({
      seq: u64(),
      t: u64(),
      gain: f64(),
      spectrum: f64Array(4),
      vEff: f64TrajectoryArray(N, { order: 2 }),
    }).withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });
    const { sab, capacity } = Bridge.allocate(16, schema);
    const bridge = new Bridge(sab, capacity, schema);
    const fr = bridge.scratchFrame();
    fr.seq = 1n; fr.t = 1_000_000n; fr.gain = 0.42;
    fr.spectrum.set([1, 2, 3, 4]);
    fr.vEff.set(fillTraj(2, 1_000_000 * 1e-9));
    assert(bridge.push(fr), "push");
    const out = bridge.scratchEvaluatedFrame();
    bridge.pullKalmanPredictedLatest(out, { leadMs: 5 });
    assertEq(out.gain, 0.42, "scalar passthrough");
    for (let i = 0; i < 4; i++) assertEq(out.spectrum[i], i + 1, `array passthrough ${i}`);
    ok("kalman-non-trajectory-passthrough");
  }

  // ── 9: producer famine rides the cache ───────────────────────────────────
  {
    const bridge = makeBridge(2);
    warm(bridge, 2, 30);
    const out = bridge.scratchEvaluatedFrame();
    let lastVal = 0;
    for (let k = 0; k < 5; k++) {
      const r = bridge.pullKalmanPredictedLatest(out, { leadMs: 5, trustedLeadMs: 5 });
      assertEq(r.skipped, -1, `famine pull ${k}: ring empty`);
      assert(Number.isFinite(out.vEff[N - 1]!), "famine output finite");
      if (k > 0) assert(Math.abs(out.vEff[N - 1]! - lastVal) < 1e-9, "famine prediction stable off frozen cache");
      lastVal = out.vEff[N - 1]!;
    }
    ok("kalman-famine-rides-cache");
  }

  // ── 10: empty ring, never pulled → predicted false, untouched ────────────
  {
    const bridge = makeBridge(2);
    const out = bridge.scratchEvaluatedFrame();
    out.vEff.fill(7.5);
    const r = bridge.pullKalmanPredictedLatest(out, { leadMs: 5 });
    assertEq(r.skipped, -1, "empty: skipped -1");
    assertEq(r.predicted, false, "empty: predicted false");
    assertEq(out.vEff[0], 7.5, "empty: out untouched");
    ok("kalman-empty-untouched");
  }

  // ── 11: validation guards ────────────────────────────────────────────────
  {
    const bridge = makeBridge(2);
    const out = bridge.scratchEvaluatedFrame();
    const bad = (fn: () => void, label: string) => {
      let threw = false; try { fn(); } catch { threw = true; }
      assert(threw, `${label} should throw`);
    };
    bad(() => bridge.pullKalmanPredictedLatest(out, { leadMs: -1 }), "negative leadMs");
    bad(() => bridge.pullKalmanPredictedLatest(out, { maxLeadMs: -1 }), "negative maxLeadMs");
    pushFrame(bridge, 2, 1, 1_000_000);
    bad(() => bridge.pullKalmanPredictedLatest(out, { leadMs: 5, consumerNs: NaN }), "non-finite consumerNs");
    ok("kalman-validation");
  }

  console.log("\nAll Bridge.pullKalmanPredictedLatest pins passed.");
}

main();
