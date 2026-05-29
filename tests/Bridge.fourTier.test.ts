/**
 * Bridge four-tier macro contract — the tier-4 (predictive smooth-macro) wiring
 * that examples/hybrid-four-tier/ relies on (0.9.72).
 *
 * The four-tier demo is composition + content over shipped primitives; the one
 * genuinely new wire is tier 4: a control-rate Bridge<S> of SMOOTH macro fields
 * carried as order-2 trajectories (position + velocity), pulled each quantum
 * with pullPredictedLatest and led forward by the measured GPU-readback wall.
 *
 * This suite pins the exact contract the example depends on against the demo's
 * actual macro schema shape (scalar fields, sampleCount = 1, order 2):
 *
 *  - a cold PLL renders an OPEN (held) macro — the carrier is never starved of
 *    a sane control value (the demo seeds CUTOFF_MAX_HZ for exactly this);
 *  - a warm PLL leads a SWEEPING field (velocity ≠ 0) forward by the blend
 *    w·(p+v·dtEff)+(1−w)·p, off the hold;
 *  - a HELD field (velocity = 0) collapses to a pure hold even when predicting —
 *    the producer writing velocity = 0 for a held macro is correct, not a bug;
 *  - the readback-median lead source (recordReadbackLatency / lastReadbackMedianMs)
 *    actually drives a forward step end-to-end (handoff §3.3 plumbing).
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.fourTier.test.ts
 *
 * Pins (this suite opens its own list at 110, after connect's 109):
 *  110. testColdMacroHoldsOpen
 *  111. testWarmMacroLeadsSweepingField
 *  112. testHeldMacroFieldCollapsesToHold
 *  113. testReadbackMedianDrivesLead
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f64TrajectoryArray,
  u64,
} from "../src/schema.js";

function approx(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

/** The demo's tier-4 macro schema (examples/hybrid-four-tier/schema.js). Each
 *  smooth field is a scalar order-2 trajectory → raw field length 2 ([p, v]),
 *  evaluated field length 1 (the predicted position). */
function macroSchema() {
  return defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    cutoff: f64TrajectoryArray(1, { order: 2 }),
    azimuth: f64TrajectoryArray(1, { order: 2 }),
    morph: f64TrajectoryArray(1, { order: 2 }),
  }).withTimestamps({ macro: { field: "tMacroNs", unit: "ns", default: true } });
}

/** Push one macro frame: each field is [position, velocity]. */
function pushMacro(
  bridge: any,
  seq: bigint,
  tNs: number,
  cutoff: [number, number],
  azimuth: [number, number],
  morph: [number, number],
): void {
  const fr = bridge.scratchFrame();
  fr.seq = seq;
  fr.tMacroNs = BigInt(Math.round(tNs));
  fr.cutoff[0] = cutoff[0]; fr.cutoff[1] = cutoff[1];
  fr.azimuth[0] = azimuth[0]; fr.azimuth[1] = azimuth[1];
  fr.morph[0] = morph[0]; fr.morph[1] = morph[1];
  assert(bridge.push(fr), "push macro frame");
}

/** Warm the PLL to a locked, low-sigma state — same recipe as the 0.9.71
 *  predictLatest suite: push + predicted-pull several frames with tiny
 *  consistent jitter so the EWMA sigma settles well under the 2 ms floor.
 *  Returns the next consumer base. */
function warmPll(bridge: any, periodNs: number, count: number): number {
  const out = bridge.scratchEvaluatedFrame();
  let consumerNs = 1_000_000;
  for (let k = 0; k < count; k++) {
    pushMacro(bridge, BigInt(k + 1), consumerNs, [6000, 0], [0, 0], [0, 0]);
    const jitter = (k % 2 === 0 ? 1 : -1) * 500;
    bridge.pullPredictedLatest(out, { leadMs: 0, consumerNs: consumerNs + jitter });
    consumerNs += periodNs;
  }
  return consumerNs;
}

// ── 110. Cold PLL → macro is a plain held value (open filter in the demo) ─────
function testColdMacroHoldsOpen(): void {
  const schema = macroSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  // A sweeping cutoff (real velocity) but a COLD PLL (no consumerNs observed).
  pushMacro(bridge, 1n, 0, [6000, 50000], [0.5, 3.0], [0, 0]);
  const out = bridge.scratchEvaluatedFrame();
  const r = bridge.pullPredictedLatest(out, { leadMs: 10, maxLeadMs: 20 });
  assert(r.skipped >= 0, "fresh frame pulled");
  assertEq(r.predicted, false, "cold PLL → predicted=false");
  assertEq(r.confidenceWeight, 0, "cold PLL → w=0");
  // Output is the held positions, not extrapolated — the demo can trust the
  // value verbatim (or its seeded default if no frame had arrived).
  assertEq(out.cutoff[0]!, 6000, "cold cutoff held at position");
  assertEq(out.azimuth[0]!, 0.5, "cold azimuth held at position");
  ok("110 cold macro holds open");
}

// ── 111. Warm PLL leads a SWEEPING field (velocity ≠ 0) forward ───────────────
function testWarmMacroLeadsSweepingField(): void {
  const schema = macroSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  const periodNs = 16_000_000; // ~60 Hz, matches the demo's MACRO_HZ ballpark
  const nextConsumer = warmPll(bridge, periodNs, 12);

  // Sweeping cutoff: p=6000 Hz, v=50000 Hz/s; sweeping azimuth: p=0.2, v=2.0/s.
  const cP = 6000, cV = 50000, aP = 0.2, aV = 2.0;
  pushMacro(bridge, 99n, nextConsumer, [cP, cV], [aP, aV], [0, 0]);
  const out = bridge.scratchEvaluatedFrame();
  const leadMs = 8;
  const r = bridge.pullPredictedLatest(out, {
    leadMs,
    maxLeadMs: 20,
    trustedLeadMs: 20, // c_horizon = 1 across the whole lead
    consumerNs: nextConsumer,
  });
  assert(r.predicted, "warm PLL → predicted=true");
  assert(r.confidenceWeight > 0 && r.confidenceWeight <= 1, "0 < w <= 1");
  assert(
    approx(r.dtEffectiveSeconds, r.confidenceWeight * leadMs * 1e-3, 1e-15),
    "dtEff = w · leadSeconds",
  );
  const w = r.confidenceWeight;
  const dtEff = r.dtEffectiveSeconds;
  // Each field is the documented blend w·(p+v·dtEff) + (1−w)·p.
  assert(approx(out.cutoff[0]!, w * (cP + cV * dtEff) + (1 - w) * cP, 1e-9), "cutoff blend");
  assert(approx(out.azimuth[0]!, w * (aP + aV * dtEff) + (1 - w) * aP, 1e-12), "azimuth blend");
  // The sweeping cutoff must actually have moved forward off the hold.
  assert(out.cutoff[0]! > cP, "sweeping cutoff led forward off the hold");
  ok("111 warm macro leads sweeping field");
}

// ── 112. A HELD field (velocity = 0) collapses to a pure hold ─────────────────
//
// The demo's producer writes velocity = 0 for any held macro (e.g. morph, or
// cutoff with auto-sweep off). That MUST render as the held position even when
// the clock is warm and prediction is active for the OTHER (sweeping) fields —
// "prediction collapses to hold, which is correct" (handoff §3.2 / §5).
function testHeldMacroFieldCollapsesToHold(): void {
  const schema = macroSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  const periodNs = 16_000_000;
  const nextConsumer = warmPll(bridge, periodNs, 12);

  // cutoff sweeps (v≠0); morph is HELD (v=0) at 0.75.
  pushMacro(bridge, 5n, nextConsumer, [6000, 50000], [0, 0], [0.75, 0]);
  const out = bridge.scratchEvaluatedFrame();
  const r = bridge.pullPredictedLatest(out, {
    leadMs: 8,
    trustedLeadMs: 20,
    consumerNs: nextConsumer,
  });
  assert(r.predicted, "predicting (sweeping field present)");
  // The held field is exactly its position — zero velocity ⇒ zero forward step,
  // independent of the confidence weight.
  assertEq(out.morph[0]!, 0.75, "held morph collapses to its position");
  // The sweeping field still moved, proving prediction was genuinely active.
  assert(out.cutoff[0]! > 6000, "sweeping cutoff still led while morph held");
  ok("112 held macro field collapses to hold");
}

// ── 113. The readback median drives a real forward step (§3.3 plumbing) ───────
function testReadbackMedianDrivesLead(): void {
  const schema = macroSchema();
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  const periodNs = 16_000_000;
  const nextConsumer = warmPll(bridge, periodNs, 12);

  // No readback samples yet → median 0 → lead 0 → no forward step (pullLatest).
  assertEq(bridge.lastReadbackMedianMs(), 0, "no samples → median 0");
  const cP = 6000, cV = 50000;
  pushMacro(bridge, 7n, nextConsumer, [cP, cV], [0, 0], [0, 0]);
  const out0 = bridge.scratchEvaluatedFrame();
  const r0 = bridge.pullPredictedLatest(out0, {
    leadMs: bridge.lastReadbackMedianMs(),
    trustedLeadMs: 20,
    consumerNs: nextConsumer,
  });
  assertEq(r0.predicted, false, "zero lead → no prediction (≡ pullLatest)");
  assertEq(out0.cutoff[0]!, cP, "zero lead → cutoff held");

  // Feed the worker's measured readback wall (µs → ms is done in the worklet;
  // here we record ms directly). A ~10 ms median now drives a real lead.
  for (const ms of [9, 11, 10, 10, 12]) bridge.recordReadbackLatency(ms);
  const median = bridge.lastReadbackMedianMs();
  assertEq(median, 10, "median of {9,10,10,11,12} = 10");

  pushMacro(bridge, 8n, nextConsumer, [cP, cV], [0, 0], [0, 0]);
  const out1 = bridge.scratchEvaluatedFrame();
  const r1 = bridge.pullPredictedLatest(out1, {
    leadMs: median,
    maxLeadMs: 20,
    trustedLeadMs: 20,
    consumerNs: nextConsumer,
  });
  assert(r1.predicted, "median lead → prediction active");
  assert(approx(r1.dtEffectiveSeconds, r1.confidenceWeight * median * 1e-3, 1e-15), "dtEff from median lead");
  assert(out1.cutoff[0]! > cP, "median-driven lead steps the sweeping cutoff forward");
  ok("113 readback median drives lead");
}

function main(): void {
  testColdMacroHoldsOpen();
  testWarmMacroLeadsSweepingField();
  testHeldMacroFieldCollapsesToHold();
  testReadbackMedianDrivesLead();
  console.log("\nAll Bridge four-tier macro tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
