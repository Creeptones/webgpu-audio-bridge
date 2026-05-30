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
 *   - famine-aware advancing horizon (0.9.905, pins 12–15): default-off is
 *     bit-exact with the fixed-lead 0.9.902 path; an opt-in stall with an
 *     advancing `consumerNs` grows the covariance so the weight fades monotone
 *     → an exact hold; normal streaming stays ≈ invisible; an unlocked PLL /
 *     missing `consumerNs` falls back to the fixed lead.
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

  // ── 12: famineAwareHorizon default-off is bit-exact with 0.9.902 ──────────
  // Famine pulls don't ingest (the filter state is frozen), so repeated pulls on
  // the same warmed bridge are idempotent — omitted / explicit-false / true-but-
  // no-consumerNs must all yield the IDENTICAL fixed-lead output.
  {
    const bridge = makeBridge(2);
    warm(bridge, 2, 30);
    const a = bridge.scratchEvaluatedFrame();
    const b = bridge.scratchEvaluatedFrame();
    const c = bridge.scratchEvaluatedFrame();
    const base = { leadMs: 6, trustedLeadMs: 6 };
    const ra = bridge.pullKalmanPredictedLatest(a, { ...base }); // omitted
    const rb = bridge.pullKalmanPredictedLatest(b, { ...base, famineAwareHorizon: false });
    // true but no consumerNs → must fall back to the fixed lead.
    const rc = bridge.pullKalmanPredictedLatest(c, { ...base, famineAwareHorizon: true });
    for (let i = 0; i < N; i++) {
      assertEq(b.vEff[i], a.vEff[i], `false ≡ omitted lane ${i}`);
      assertEq(c.vEff[i], a.vEff[i], `true-no-consumerNs ≡ omitted lane ${i}`);
    }
    assertEq(rb.confidenceWeight, ra.confidenceWeight, "false ≡ omitted weight");
    assertEq(rc.confidenceWeight, ra.confidenceWeight, "true-no-consumerNs ≡ omitted weight");
    assertEq(ra.forwardDistanceSeconds, base.leadMs * 1e-3, "fixed-lead forwardDistance == requested lead");
    ok("kalman-famine-aware-default-off-bit-exact");
  }

  // ── 13: famineAwareHorizon — fade is monotone → exact hold ────────────────
  // Warm with consumerNs == producer time so the PLL locks (offset ≈ 0). Then a
  // stall with an ADVANCING consumerNs grows the predict horizon (and thus the
  // covariance) → the variance gate fades the weight monotonically to 0 ⇒ an
  // EXACT latest-frame hold. The predictor's headline benefit, realized.
  {
    const bridge = makeBridge(2);
    const evalFrame = bridge.scratchEvaluatedFrame();
    let tNs = 1_000_000;
    const COUNT = 30;
    for (let k = 0; k < COUNT; k++) {
      pushFrame(bridge, 2, k + 1, tNs);
      bridge.pullKalmanPredictedLatest(evalFrame, { leadMs: 0, consumerNs: tNs });
      if (k < COUNT - 1) tNs += PERIOD_NS;
    }
    const tLast = tNs;
    const out = bridge.scratchEvaluatedFrame();
    const opts = { leadMs: 2, trustedLeadMs: 2, varianceFloor: 10, famineAwareHorizon: true };
    let prevW = Infinity, prevVar = -Infinity, prevFwd = -Infinity;
    let reachedHold = false;
    let consumerNs = tLast;
    for (let k = 0; k < 120; k++) {
      consumerNs += PERIOD_NS; // advance the consumer clock through the famine
      const r = bridge.pullKalmanPredictedLatest(out, { ...opts, consumerNs });
      assertEq(r.skipped, -1, `famine pull ${k}: ring empty`);
      assert(r.confidenceWeight <= prevW + 1e-12, `weight monotone-nonincreasing at ${k} (${r.confidenceWeight} > ${prevW})`);
      assert(r.maxVariance >= prevVar - 1e-9, `variance monotone-nondecreasing at ${k}`);
      assert(r.forwardDistanceSeconds > prevFwd, `forward distance grows at ${k}`);
      prevW = r.confidenceWeight; prevVar = r.maxVariance; prevFwd = r.forwardDistanceSeconds;
      if (r.confidenceWeight === 0) {
        assertEq(r.predicted, false, "w=0 ⇒ predicted false");
        for (let i = 0; i < N; i++) {
          assertEq(out.vEff[i], truthPos(2, i, tLast * 1e-9), `exact hold lane ${i}`);
        }
        reachedHold = true;
        break;
      }
    }
    assert(reachedHold, "famine fade reached the exact hold (w=0) within the stall window");
    ok("kalman-famine-aware-fade-to-hold");
  }

  // ── 14: normal operation — famineAwareHorizon is ≈ invisible ──────────────
  // A fresh frame every quantum with a correctly-advancing consumerNs: the PLL
  // maps the consumer clock back onto ~the freshest stamp, so the advancing
  // target ≈ the fixed lead. Not bit-exact (the PLL offset adds a sub-µs delta);
  // approx tolerance.
  {
    const off = makeBridge(2);
    const on = makeBridge(2);
    const oOff = off.scratchEvaluatedFrame();
    const oOn = on.scratchEvaluatedFrame();
    const SKEW = 250_000; // 0.25 ms consumer/producer skew → PLL learns the offset
    let tNs = 1_000_000;
    const COUNT = 40;
    let last: { off: Float64Array; on: Float64Array } | null = null;
    for (let k = 0; k < COUNT; k++) {
      pushFrame(off, 2, k + 1, tNs);
      pushFrame(on, 2, k + 1, tNs);
      const base = { leadMs: 5, trustedLeadMs: 5, consumerNs: tNs + SKEW };
      off.pullKalmanPredictedLatest(oOff, { ...base });
      on.pullKalmanPredictedLatest(oOn, { ...base, famineAwareHorizon: true });
      last = { off: Float64Array.from(oOff.vEff), on: Float64Array.from(oOn.vEff) };
      if (k < COUNT - 1) tNs += PERIOD_NS;
    }
    for (let i = 0; i < N; i++) {
      assert(Math.abs(last!.on[i]! - last!.off[i]!) < 1e-3, `normal-op parity lane ${i} (${last!.on[i]} vs ${last!.off[i]})`);
    }
    ok("kalman-famine-aware-normal-op-parity");
  }

  // ── 15: unlocked PLL → famineAwareHorizon falls back to the fixed lead ─────
  // Warmed WITHOUT consumerNs (PLL stays cold). A famine pull with
  // famineAwareHorizon:true AND a consumerNs must still take the fixed-lead path
  // because the `this.pll.locked` guard is false → bit-exact with off.
  {
    const bridge = makeBridge(2);
    warm(bridge, 2, 30); // no consumerNs ⇒ PLL never observes ⇒ unlocked
    const a = bridge.scratchEvaluatedFrame();
    const b = bridge.scratchEvaluatedFrame();
    const base = { leadMs: 6, trustedLeadMs: 6 };
    bridge.pullKalmanPredictedLatest(a, { ...base }); // off, no consumerNs
    bridge.pullKalmanPredictedLatest(b, { ...base, famineAwareHorizon: true, consumerNs: 999_999_999 });
    for (let i = 0; i < N; i++) {
      assertEq(b.vEff[i], a.vEff[i], `unlocked fallback lane ${i}`);
    }
    ok("kalman-famine-aware-unlocked-fallback");
  }

  console.log("\nAll Bridge.pullKalmanPredictedLatest pins passed.");
}

main();
