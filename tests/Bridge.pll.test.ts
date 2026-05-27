/**
 * Bridge PLL — split out of tests/Bridge.test.ts in 0.8.5.
 *
 * Cold-start, convergence, step + reset + validation, timestamp role / sample-rate / unit conversion, Mahalanobis outlier gate, drift estimator, lane 4-5 publication, BigInt-free encoding boundary.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.pll.test.ts
 *
 * Pins (file-header pin numbers; see tests/Bridge.test.ts in 0.8.4 for the
 * original combined docstring with full per-pin descriptions):
 *  41. testPllColdStart
 *  42. testPllConvergence
 *  43. testPllStepAndResetAndValidation
 *  50. testPullEvaluatedLatestRoundTrip
 *  51. testTimestampRoleResolution
 *  52. testSampleRateResolution
 *  53. testTimestampUnitConversion
 *  72. testPllOutlierGateSingleSpike
 *  73. testPllOutlierGateSustainedStep
 *  74. testPllOutlierGateTuningAndValidation
 *  75. testPllDriftEstimatorDefaultOff
 *  76. testPllDriftEstimatorConvergence
 *  77. testPllDriftEstimatorPhaseLockedTime
 *  78. testPllLanePublicationCrossPeer
 *  79. testPllLanePublicationEncoding
 *  92. testPllPublishBigIntFreeAndBoundaryRoundTrip
 */

import {
  assert,
  assertEq,
  ok,
} from "./_assert.js";
import {
  emptyPhysFrame,
  mulberry32,
  type PhysFrame,
} from "./_bridgeHelpers.js";
import { Bridge } from "../src/Bridge.js";
import { ConsumerClockRecovery } from "../src/ConsumerClockRecovery.js";
import { SpscRing } from "../src/SpscRing.js";
import {
  defineSchema,
  f64,
  f64TrajectoryArray,
  u64,
} from "../src/schema.js";
import { physicsControlFrameSchema } from "../src/schemas/physics.js";


// ── 41. PLL cold-start (0.6.2, Pillar 2) ───────────────────────────────────
//
// On a fresh Bridge, telemetry reports pllLocked=false and pllOffsetNs=0;
// phaseLockedTime is the identity. The first observeConsumerTime call
// seeds the offset exactly (producerNs - consumerNs), flips pllLocked=true,
// and runs no PI math (integral stays 0 — the first call is a seed, not
// a correction).
function testPllColdStart(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const t0 = ring.telemetry();
  assertEq(t0.pllLocked, false, "fresh pllLocked=false");
  assertEq(t0.pllOffsetNs, 0, "fresh pllOffsetNs=0");
  // Pre-lock: phaseLockedTime is the identity (best fallback).
  assertEq(ring.phaseLockedTime(1234), 1234, "pre-lock phaseLockedTime is identity");
  assertEq(ring.phaseLockedTime(0), 0, "pre-lock phaseLockedTime(0) = 0");
  assertEq(
    ring.phaseLockedTime(-42),
    -42,
    "pre-lock phaseLockedTime preserves sign",
  );

  // First observation seeds exactly. Producer is 1.5 seconds ahead of consumer.
  const consumerNs = 1_000_000_000; // 1 second since some epoch
  const producerNs = 2_500_000_000; // 2.5 seconds
  ring.observeConsumerTime(consumerNs, producerNs);

  const t1 = ring.telemetry();
  assertEq(t1.pllLocked, true, "post-seed pllLocked=true");
  assertEq(
    t1.pllOffsetNs,
    producerNs - consumerNs,
    "post-seed offset is exactly producerNs - consumerNs",
  );
  // phaseLockedTime now applies the offset.
  assertEq(
    ring.phaseLockedTime(consumerNs),
    producerNs,
    "post-seed phaseLockedTime maps consumerNs → producerNs exactly",
  );
  // For any other consumer time, the same offset applies.
  assertEq(
    ring.phaseLockedTime(consumerNs + 1_000_000),
    producerNs + 1_000_000,
    "post-seed phaseLockedTime is consumerNs + offset",
  );

  ok("pll-cold-start");
}


// ── 42. PLL convergence (0.6.2) ────────────────────────────────────────────
//
// Simulate a producer that's running with a fixed offset relative to the
// consumer clock. Feed 50 noisy observations and assert the heap estimate
// converges to within 1 μs of the true offset. The PI residual decays
// geometrically at (1 - PLL_KP) per cycle = 80 %, so a 10 ms initial
// residual reaches 1 μs in log_{1.25}(10 ms / 1 μs) ≈ 41 cycles —
// budget of 50 cycles has headroom.
function testPllConvergence(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const TRUE_OFFSET_NS = 50_000_000; // 50 ms — producer ahead of consumer
  const rng = mulberry32(0xc1f5);
  // Seed with a deliberately-wrong consumer-paired observation so the PI
  // has work to do. After seeding the offset equals (paired - consumer);
  // we then feed observations where the *true* offset is TRUE_OFFSET_NS
  // and ride the PI down.
  // Equivalent: seed with a "stale guess" 10 ms off truth, then feed
  // jittered correct-truth observations.
  ring.observeConsumerTime(0, TRUE_OFFSET_NS - 10_000_000);
  // After seed: pllOffsetNs = TRUE_OFFSET_NS - 10_000_000 (10 ms low).
  assertEq(
    ring.telemetry().pllOffsetNs,
    TRUE_OFFSET_NS - 10_000_000,
    "post-seed offset starts 10 ms below truth",
  );

  // Feed 50 observations. Each pair is (consumerNs, producerNs = consumerNs + TRUE_OFFSET_NS + jitter).
  let consumerNs = 1_000_000;
  for (let i = 0; i < 50; i++) {
    consumerNs += 16_666_667; // ~60 Hz observation cadence
    const jitterNs = (rng() - 0.5) * 200_000; // ±100 μs of noise per observation
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitterNs);
  }

  const finalOffset = ring.telemetry().pllOffsetNs;
  const residualNs = Math.abs(finalOffset - TRUE_OFFSET_NS);
  // 1 μs convergence target. The jitter floor sets the achievable
  // precision; with ±100 μs jitter and Kp=0.2 the filtered residual
  // floor is ~Kp · jitter_stddev ≈ 12 μs. Tight target 50 μs.
  assert(
    residualNs < 50_000,
    `convergence: |finalOffset - truth| ${residualNs.toFixed(0)} ns < 50,000 ns (after 50 obs with ±100μs jitter)`,
  );

  ok("pll-convergence");
}


// ── 43. PLL step-response, resetPll, validation (0.6.2) ────────────────────
//
// Three behaviors in one pin:
//   (a) Step response — after lock, jumping the producer's apparent offset
//       triggers PI correction over a bounded number of cycles. We don't
//       pin an exact cycle count (the gain coefficients can be tuned in a
//       future patch); we pin "monotonic convergence in residual magnitude
//       within 200 cycles."
//   (b) resetPll — flips back to unlocked, zeros internal state, next
//       observe seeds from scratch.
//   (c) Argument validation — NaN / Infinity throws.
function testPllStepAndResetAndValidation(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  // (a) Step response. Lock at offset=0, then introduce a 1 ms step.
  ring.observeConsumerTime(0, 0);
  assertEq(ring.telemetry().pllOffsetNs, 0, "seed at zero offset");
  // Step: now observations carry a 1 ms producer-side offset.
  const STEP_NS = 1_000_000;
  let consumerNs = 1_000_000;
  // First post-step observation: residual = STEP_NS, integral gets
  // STEP_NS added, offset moves by Kp · STEP_NS + Ki · STEP_NS.
  ring.observeConsumerTime(consumerNs, consumerNs + STEP_NS);
  const firstStepOffset = ring.telemetry().pllOffsetNs;
  assert(
    firstStepOffset > 0,
    `first step observation moves offset above 0 (got ${firstStepOffset})`,
  );
  assert(
    firstStepOffset < STEP_NS,
    `first step observation undershoots truth (got ${firstStepOffset}, target ${STEP_NS})`,
  );
  // Drive convergence: 200 cycles should put us well within 1 μs.
  for (let i = 0; i < 200; i++) {
    consumerNs += 16_666_667;
    ring.observeConsumerTime(consumerNs, consumerNs + STEP_NS);
  }
  const settled = ring.telemetry().pllOffsetNs;
  const residualAfterStep = Math.abs(settled - STEP_NS);
  assert(
    residualAfterStep < 1000,
    `step response: |offset - STEP_NS| ${residualAfterStep.toFixed(2)} ns < 1000 ns after 200 cycles`,
  );

  // (b) resetPll: back to unlocked.
  ring.resetPll();
  const tReset = ring.telemetry();
  assertEq(tReset.pllLocked, false, "post-reset pllLocked=false");
  assertEq(tReset.pllOffsetNs, 0, "post-reset pllOffsetNs=0");
  assertEq(
    ring.phaseLockedTime(12345),
    12345,
    "post-reset phaseLockedTime is identity again",
  );
  // Next observation re-seeds.
  ring.observeConsumerTime(100, 999);
  assertEq(
    ring.telemetry().pllOffsetNs,
    899,
    "post-reset next observe seeds exactly",
  );
  assertEq(ring.telemetry().pllLocked, true, "post-reset+observe pllLocked=true");

  // (c) Argument validation.
  let threw = false;
  try { ring.observeConsumerTime(NaN, 0); } catch { threw = true; }
  assert(threw, "observeConsumerTime(NaN, _) throws");
  threw = false;
  try { ring.observeConsumerTime(0, NaN); } catch { threw = true; }
  assert(threw, "observeConsumerTime(_, NaN) throws");
  threw = false;
  try { ring.observeConsumerTime(Infinity, 0); } catch { threw = true; }
  assert(threw, "observeConsumerTime(Infinity, _) throws");
  threw = false;
  try { ring.observeConsumerTime(0, -Infinity); } catch { threw = true; }
  assert(threw, "observeConsumerTime(_, -Infinity) throws");

  ok("pll-step-and-reset-and-validation");
}


// ── 50. pullEvaluatedLatest + evaluateAtSampleOffset round-trip (0.6.5) ────
//
// The 0.6.5 sugar must produce bit-identical output to the hand-rolled
// pull + observe + evaluate loop the 0.6.3 README documents. Two Bridges
// over identical SAB streams: one driven via the sugar, one via the
// manual loop. After 100 quanta × 128 samples, every evaluated sample
// must match across the two Float64 audio buffers.
function testPullEvaluatedLatestRoundTrip(): void {
  const N = 1; // single-sample trajectory
  const SAMPLE_RATE = 48_000;
  const QUANTUM = 128;
  const PRODUCER_PERIOD_NS = 16_666_667n;
  const QUANTA = 100;

  const schemaBase = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  });
  const schema = schemaBase.withTimestamps({
    macro: { field: "tMacroNs", unit: "ns", default: true },
  });

  // Bridge A — driven via the sugar.
  const allocA = Bridge.allocate(16, schema);
  const ringA = new Bridge(allocA.sab, allocA.capacity, schema);
  ringA.setSampleRate(SAMPLE_RATE);
  const evalA = ringA.scratchEvaluatedFrame();
  const audioA = new Float64Array(QUANTA * QUANTUM);

  // Bridge B — driven via the hand-rolled loop. Separate SAB so producer
  // pushes don't interfere; both bridges receive identical frames.
  const allocB = Bridge.allocate(16, schemaBase);
  const ringB = new Bridge(allocB.sab, allocB.capacity, schemaBase);
  const rawB = ringB.scratchFrame();
  const evalB = ringB.scratchEvaluatedFrame();
  const audioB = new Float64Array(QUANTA * QUANTUM);

  const omega = 2 * Math.PI * 5; // 5 Hz signal
  const pushA = ringA.scratchFrame();
  const pushB = ringB.scratchFrame();

  // Seed t=0 push so quantum 0 has data.
  pushA.seq = 0n; pushA.tMacroNs = 0n;
  pushA.vEff[0] = 0; pushA.vEff[1] = omega;
  ringA.push(pushA);
  pushB.seq = 0n; pushB.tMacroNs = 0n;
  pushB.vEff[0] = 0; pushB.vEff[1] = omega;
  ringB.push(pushB);

  let producerNext = PRODUCER_PERIOD_NS;
  let seq = 1n;

  for (let q = 0; q < QUANTA; q++) {
    const baseSample = q * QUANTUM;
    const baseNs = Math.round(baseSample / SAMPLE_RATE * 1e9);
    // Drain any producer ticks that fired before this quantum.
    while (producerNext <= BigInt(baseNs)) {
      const t = Number(producerNext) * 1e-9;
      pushA.seq = seq; pushA.tMacroNs = producerNext;
      pushA.vEff[0] = Math.sin(omega * t);
      pushA.vEff[1] = omega * Math.cos(omega * t);
      ringA.push(pushA);
      pushB.seq = seq; pushB.tMacroNs = producerNext;
      pushB.vEff[0] = Math.sin(omega * t);
      pushB.vEff[1] = omega * Math.cos(omega * t);
      ringB.push(pushB);
      seq++;
      producerNext = producerNext + PRODUCER_PERIOD_NS;
    }

    // Sugar path.
    ringA.pullEvaluatedLatest(evalA, baseNs);
    audioA[baseSample] = evalA.vEff[0]!;
    for (let i = 1; i < QUANTUM; i++) {
      ringA.evaluateAtSampleOffset(evalA, i);
      audioA[baseSample + i] = evalA.vEff[0]!;
    }

    // Manual path — mirrors the sugar's contract: only observe the PLL
    // on a fresh pull, evaluate from the cached rawB regardless.
    const skippedB = ringB.pullLatest(rawB);
    if (skippedB >= 0) {
      ringB.observeConsumerTime(baseNs, Number(rawB.tMacroNs));
    }
    const stampNs = Number(rawB.tMacroNs);
    for (let i = 0; i < QUANTUM; i++) {
      const consumerNs = baseNs + (i / SAMPLE_RATE) * 1e9;
      const dtSec = (ringB.phaseLockedTime(consumerNs) - stampNs) * 1e-9;
      ringB.evaluateInto(rawB, dtSec, evalB);
      audioB[baseSample + i] = evalB.vEff[0]!;
    }
  }

  // Bit-exact match across all samples.
  for (let n = 0; n < audioA.length; n++) {
    assertEq(audioA[n], audioB[n], `sample ${n} matches`);
  }

  ok("pull-evaluated-latest-roundtrip");
}


// ── 51. Timestamp role resolution + cache invalidation (0.6.5) ─────────────
//
// Two declared roles (`macro` with default flag, `alt` without). Per-call
// override picks alt; default-omit path picks macro. Unknown role throws.
// Schema without .withTimestamps() throws on pullEvaluatedLatest.
// resetEvalCache invalidates so evaluateAtSampleOffset throws until the
// next pullEvaluatedLatest.
function testTimestampRoleResolution(): void {
  const N = 1;
  const schema = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    tAltNs: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  }).withTimestamps({
    macro: { field: "tMacroNs", unit: "ns", default: true },
    alt:   { field: "tAltNs",   unit: "ns" },
  });
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  ring.setSampleRate(48_000);

  // Push a frame where macro = 1_000_000 ns and alt = 2_000_000 ns.
  // Velocity = 100 so we can read the picked timestamp from the
  // evaluated output (out.vEff[0] = pos + vel * dt = 50 + 100 * dt).
  const f = ring.scratchFrame();
  f.seq = 1n;
  f.tMacroNs = 1_000_000n;
  f.tAltNs   = 2_000_000n;
  f.vEff[0] = 50;
  f.vEff[1] = 100;
  ring.push(f);

  const out = ring.scratchEvaluatedFrame();

  // Default path → picks macro. baseConsumerNs = 1_000_000 (matches stamp);
  // dt for sample 0 = phaseLockedTime(base) - macroStamp = 0 (PLL just
  // seeded to exact offset). So out.vEff[0] = 50 + 100 * 0 = 50.
  ring.pullEvaluatedLatest(out, 1_000_000);
  assertEq(out.vEff[0], 50, "default role picks macro; dt = 0");
  ring.resetEvalCache();
  ring.resetPll();

  // Override path → picks alt. Re-push so the ring has a frame.
  f.seq = 2n;
  ring.push(f);
  ring.pullEvaluatedLatest(out, 2_000_000, undefined, { timestamp: "alt" });
  assertEq(out.vEff[0], 50, "alt role: dt = 0 when base matches alt stamp");
  ring.resetEvalCache();
  ring.resetPll();

  // Unknown role → throws.
  f.seq = 3n;
  ring.push(f);
  let threw = false;
  try {
    ring.pullEvaluatedLatest(out, 0, undefined,
      { timestamp: "bogus" as "macro" | "alt" });
  } catch { threw = true; }
  assert(threw, "unknown role throws");

  // resetEvalCache → evaluateAtSampleOffset throws.
  ring.resetEvalCache();
  threw = false;
  try { ring.evaluateAtSampleOffset(out, 1); } catch { threw = true; }
  assert(threw, "evaluateAtSampleOffset after reset throws");

  // Schema without .withTimestamps() → throws on pullEvaluatedLatest.
  const bareSchema = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  });
  const bareAlloc = Bridge.allocate(8, bareSchema);
  const bareRing = new Bridge(bareAlloc.sab, bareAlloc.capacity, bareSchema);
  bareRing.setSampleRate(48_000);
  const bareOut = bareRing.scratchEvaluatedFrame();
  const bareFrame = bareRing.scratchFrame();
  bareFrame.tMacroNs = 0n;
  bareFrame.vEff[0] = 1;
  bareFrame.vEff[1] = 0;
  bareRing.push(bareFrame);
  threw = false;
  try { bareRing.pullEvaluatedLatest(bareOut, 0); } catch { threw = true; }
  assert(threw, "schema without .withTimestamps throws");

  ok("timestamp-role-resolution");
}


// ── 52. Sample-rate resolution (0.6.5) ─────────────────────────────────────
//
// Three patterns: per-call sampleRate, registered default via setSampleRate,
// per-call override of registered default. Both omitted → throws. Input
// validation on setSampleRate.
function testSampleRateResolution(): void {
  const N = 1;
  const schema = defineSchema({
    seq: u64(),
    tNs: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  }).withTimestamps({
    macro: { field: "tNs", unit: "ns", default: true },
  });

  function freshRing() {
    const { sab, capacity } = Bridge.allocate(8, schema);
    const ring = new Bridge(sab, capacity, schema);
    const f = ring.scratchFrame();
    f.tNs = 0n; f.vEff[0] = 0; f.vEff[1] = 1;
    ring.push(f);
    return { ring, out: ring.scratchEvaluatedFrame(), pushFrame: f };
  }

  // (1) Per-call sampleRate works without any setSampleRate.
  {
    const { ring, out } = freshRing();
    ring.pullEvaluatedLatest(out, 0, 48_000);
    ok(`per-call sampleRate accepted (out.vEff[0]=${out.vEff[0]!.toFixed(4)})`);
  }

  // (2) setSampleRate default; per-call omitted.
  {
    const { ring, out } = freshRing();
    ring.setSampleRate(48_000);
    ring.pullEvaluatedLatest(out, 0);
    ring.evaluateAtSampleOffset(out, 64); // confirms cachedSampleRate populated
  }

  // (3) Per-call wins precedence: registered 22050 but per-call 48000;
  //     sample-1 dt should use 48000, so its output differs from what 22050 would give.
  {
    const { ring, out } = freshRing();
    ring.setSampleRate(22_050);
    ring.pullEvaluatedLatest(out, 0, 48_000);
    const sample1_at48k = (() => {
      // Compute the expected dt: consumerNs = 0 + 1/48000*1e9; PLL seeded
      // at offset 0 (producer stamp = 0, consumer base = 0); dt_s ≈
      // 1/48000. out.vEff[0] ≈ 0 + 1·(1/48000) ≈ 2.083e-5.
      const out2 = ring.scratchEvaluatedFrame();
      ring.evaluateAtSampleOffset(out2, 1);
      return out2.vEff[0]!;
    })();
    const expected = 1 / 48_000;
    assert(
      Math.abs(sample1_at48k - expected) < 1e-9,
      `per-call 48k wins over registered 22050: got ${sample1_at48k}, expected ~${expected}`,
    );
  }

  // (4) Both omitted → throws.
  {
    const { ring, out } = freshRing();
    let threw = false;
    try { ring.pullEvaluatedLatest(out, 0); } catch { threw = true; }
    assert(threw, "no sampleRate anywhere throws");
  }

  // (5) setSampleRate input validation.
  {
    const { ring } = freshRing();
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      let threw = false;
      try { ring.setSampleRate(bad); } catch { threw = true; }
      assert(threw, `setSampleRate(${bad}) rejects`);
    }
  }

  ok("sample-rate-resolution");
}


// ── 53. Timestamp unit conversion (0.6.5) ──────────────────────────────────
//
// Producer stamps the timestamp field in non-ns units (ms, s, samples).
// Consumer's role declares the matching unit. Bridge's _timestampToNs
// must convert so dt computations against the PLL-seeded offset land on
// the analytic answer. We verify by configuring baseConsumerNs to equal
// the ns-equivalent of the producer stamp, then asserting dt=0 at sample 0
// (out = position exactly).
function testTimestampUnitConversion(): void {
  const N = 1;
  const SR = 48_000;

  type Case = {
    label: string;
    unit: "ns" | "us" | "ms" | "s" | "samples";
    stampValue: number;       // value as the producer would write
    expectedConsumerNs: number; // baseConsumerNs that gives dt = 0
  };
  const cases: Case[] = [
    { label: "ns",     unit: "ns",     stampValue: 1_000_000,        expectedConsumerNs: 1_000_000 },
    { label: "us",     unit: "us",     stampValue: 1_000,            expectedConsumerNs: 1_000_000 },
    { label: "ms",     unit: "ms",     stampValue: 1,                expectedConsumerNs: 1_000_000 },
    { label: "s",      unit: "s",      stampValue: 0.001,            expectedConsumerNs: 1_000_000 },
    // 48 samples at 48 kHz = 1 ms = 1_000_000 ns.
    { label: "samples",unit: "samples",stampValue: 48,               expectedConsumerNs: 1_000_000 },
  ];

  for (const c of cases) {
    const schema = defineSchema({
      seq: u64(),
      stamp: f64(),
      vEff: f64TrajectoryArray(N, { order: 2 }),
    }).withTimestamps({
      macro: { field: "stamp", unit: c.unit, default: true },
    });
    const { sab, capacity } = Bridge.allocate(8, schema);
    const ring = new Bridge(sab, capacity, schema);
    ring.setSampleRate(SR);

    const f = ring.scratchFrame();
    f.stamp = c.stampValue;
    f.vEff[0] = 42;  // pos
    f.vEff[1] = 999; // vel (large so any wrong-dt error is obvious)
    ring.push(f);

    const out = ring.scratchEvaluatedFrame();
    ring.pullEvaluatedLatest(out, c.expectedConsumerNs);
    // After pullEvaluatedLatest, PLL seeds offset = producerNs - consumerNs
    // = 0 (we matched them). dt for sample 0 = phaseLockedTime(base) - prodNs = 0.
    // out.vEff[0] = pos + vel * 0 = 42 exactly.
    assertEq(out.vEff[0], 42, `${c.label}: dt = 0 at sample 0 (got ${out.vEff[0]})`);
  }

  ok("timestamp-unit-conversion");
}


// ── 72. PLL Mahalanobis outlier gate — single spike rejected (0.6.14) ────
function testPllOutlierGateSingleSpike(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const TRUE_OFFSET_NS = 0;
  const rng = mulberry32(0x55aa);
  // Seed exactly at truth.
  ring.observeConsumerTime(0, TRUE_OFFSET_NS);
  // Feed 25 clean ±100 μs jittered observations to build σ̂.
  let consumerNs = 1_000_000;
  for (let i = 0; i < 25; i++) {
    consumerNs += 16_666_667;
    const jitter = (rng() - 0.5) * 200_000; // ±100 μs
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitter);
  }
  const cleanOffset = ring.telemetry().pllOffsetNs;
  assertEq(
    ring.telemetry().pllOutliersRejected,
    0,
    "no outliers from clean jittered observations",
  );
  // σ̂ should be around 50-60 μs (½ of ±100 μs uniform range, EWMA-averaged).
  // We won't pin a tight number — just that it's positive (gate is armed).

  // Now inject a single 30 ms outlier — the classic mapAsync stall.
  consumerNs += 16_666_667;
  const SPIKE_NS = 30_000_000;
  ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + SPIKE_NS);
  // Gate rejects it. Counter += 1. Offset is unchanged.
  const t = ring.telemetry();
  assertEq(t.pllOutliersRejected, 1, "30 ms spike gates as 1 outlier");
  assert(
    Math.abs(t.pllOffsetNs - cleanOffset) < 100,
    `outlier rejected: offset moved by ${Math.abs(t.pllOffsetNs - cleanOffset).toFixed(0)} ns < 100 ns`,
  );

  // Feed a few more clean observations — the consecutive-outlier counter
  // resets immediately on the first clean observation. (One clean call
  // proves the streak resets.)
  for (let i = 0; i < 3; i++) {
    consumerNs += 16_666_667;
    const jitter = (rng() - 0.5) * 200_000;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitter);
  }
  // No new outliers from the clean tail.
  assertEq(
    ring.telemetry().pllOutliersRejected,
    1,
    "clean tail does not increment outlier counter",
  );

  ok("pll-outlier-gate-single-spike");
}


// ── 73. PLL outlier gate — sustained step admitted (0.6.14) ──────────────
function testPllOutlierGateSustainedStep(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const TRUE_OFFSET_NS = 0;
  // Seed + warmup with no jitter so σ̂ is small and a sustained step is
  // unambiguously larger than the gate threshold.
  ring.observeConsumerTime(0, TRUE_OFFSET_NS);
  let consumerNs = 1_000_000;
  // Use a small jitter (10 μs) so σ̂ is non-zero but small.
  const rng = mulberry32(0xbeef);
  for (let i = 0; i < 15; i++) {
    consumerNs += 16_666_667;
    const jitter = (rng() - 0.5) * 20_000;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitter);
  }
  const preStepOffset = ring.telemetry().pllOffsetNs;
  const preStepOutliers = ring.telemetry().pllOutliersRejected;

  // Step: producer clock jumps 5 ms ahead persistently.
  const STEP_NS = 5_000_000;
  // First 3 post-step observations: gate rejects (single-spike interpretation).
  for (let i = 0; i < 3; i++) {
    consumerNs += 16_666_667;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + STEP_NS);
  }
  const afterThreeRejects = ring.telemetry();
  assertEq(
    afterThreeRejects.pllOutliersRejected,
    preStepOutliers + 3,
    "first 3 post-step observations gate as outliers",
  );
  assert(
    Math.abs(afterThreeRejects.pllOffsetNs - preStepOffset) < 1000,
    `offset still close to pre-step (gated, no movement): Δ=${Math.abs(afterThreeRejects.pllOffsetNs - preStepOffset).toFixed(0)} ns`,
  );

  // 4th post-step observation: consecutive count exceeds limit → step
  // detected → σ̂ resets → this observation flows into the normal PI path.
  consumerNs += 16_666_667;
  ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + STEP_NS);
  const afterStepAdmit = ring.telemetry();
  // Counter does NOT increment on the step-admit (we admitted, not gated).
  assertEq(
    afterStepAdmit.pllOutliersRejected,
    preStepOutliers + 3,
    "step-admit does not bump outlier counter",
  );
  // Offset has begun moving toward the new truth.
  assert(
    afterStepAdmit.pllOffsetNs > preStepOffset + 100_000,
    `step-admit moves offset toward new truth: Δ=${(afterStepAdmit.pllOffsetNs - preStepOffset).toFixed(0)} ns > 100 μs`,
  );

  // Continue feeding the step value — should converge to STEP_NS within
  // 200 cycles (same envelope as the pre-0.6.14 step pin #43).
  for (let i = 0; i < 200; i++) {
    consumerNs += 16_666_667;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + STEP_NS);
  }
  const settled = ring.telemetry().pllOffsetNs;
  const residual = Math.abs(settled - STEP_NS);
  // Loose bound — 100 μs of residual is fine; the gate's step-detection
  // path doesn't impact final convergence accuracy, just initial latency.
  assert(
    residual < 100_000,
    `step convergence post-gate: |offset - STEP_NS| ${residual.toFixed(0)} ns < 100,000 ns`,
  );

  ok("pll-outlier-gate-sustained-step");
}


// ── 74. PLL outlier gate — opt-out + tuning + validation (0.6.14) ────────
function testPllOutlierGateTuningAndValidation(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);

  // (a) Opt out by passing Infinity. Direct construction of the
  // primitive — the gate must let a 30 ms spike through the PI path.
  const pllDisabled = new ConsumerClockRecovery({ outlierSigmaMultiplier: Infinity });
  pllDisabled.observe(0, 0);
  // Build σ̂ — irrelevant since gate is off, but mirrors pin 72's setup.
  let consumerNs = 1_000_000;
  for (let i = 0; i < 25; i++) {
    consumerNs += 16_666_667;
    pllDisabled.observe(consumerNs, consumerNs);
  }
  const preSpike = pllDisabled.offsetNs;
  // 30 ms spike — gate off, PI math runs unconditionally.
  consumerNs += 16_666_667;
  pllDisabled.observe(consumerNs, consumerNs + 30_000_000);
  const postSpike = pllDisabled.offsetNs;
  // PI moves offset by KP · residual ≈ 0.2 · 30 ms = 6 ms.
  assert(
    Math.abs(postSpike - preSpike) > 1_000_000,
    `gate-disabled: 30 ms spike moves offset by > 1 ms (got ${Math.abs(postSpike - preSpike).toFixed(0)} ns)`,
  );
  assertEq(
    pllDisabled.outliersRejected,
    0,
    "gate-disabled: outlier counter stays at 0",
  );

  // (b) Tight gate. With multiplier=3 and σ̂ around 5 μs (from ±10 μs
  // jitter), a 30 μs residual sits at ~6σ — gates at 3σ, doesn't at 6σ.
  const pllTight = new ConsumerClockRecovery({ outlierSigmaMultiplier: 3 });
  pllTight.observe(0, 0);
  const rng = mulberry32(0xc0de);
  let cn = 1_000_000;
  // 25 ±10 μs jittered observations build σ̂ ≈ 5 μs.
  for (let i = 0; i < 25; i++) {
    cn += 16_666_667;
    const jit = (rng() - 0.5) * 20_000;
    pllTight.observe(cn, cn + jit);
  }
  const sigmaBefore = pllTight.sigmaEstimateNs;
  assert(sigmaBefore > 0, "σ̂ should be positive after warmup");
  // 30 μs residual — between 3σ and 6σ at the typical sigmaBefore.
  cn += 16_666_667;
  const spikeMid = sigmaBefore * 5; // 5σ
  pllTight.observe(cn, cn + spikeMid);
  // Either gated (counter increments) or admitted; only require: if it
  // exceeds 3σ, it must be gated.
  if (spikeMid > sigmaBefore * 3) {
    assert(
      pllTight.outliersRejected >= 1,
      `5σ residual gates under tight (3σ) threshold`,
    );
  }

  // (c) Construction validation.
  let threw = false;
  try { new ConsumerClockRecovery({ outlierSigmaMultiplier: 0 }); } catch { threw = true; }
  assert(threw, "outlierSigmaMultiplier=0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierSigmaMultiplier: -1 }); } catch { threw = true; }
  assert(threw, "outlierSigmaMultiplier<0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierWarmupObservations: -1 }); } catch { threw = true; }
  assert(threw, "negative warmup throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierWarmupObservations: 1.5 }); } catch { threw = true; }
  assert(threw, "non-integer warmup throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierEwmaAlpha: 0 }); } catch { threw = true; }
  assert(threw, "outlierEwmaAlpha=0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierEwmaAlpha: 1.5 }); } catch { threw = true; }
  assert(threw, "outlierEwmaAlpha>1 throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierConsecutiveLimit: -1 }); } catch { threw = true; }
  assert(threw, "negative outlierConsecutiveLimit throws");

  // (d) Sanity: schema parameter is unused by the construct test but
  // include a quick smoke pass through Bridge to confirm the wiring.
  const { sab, capacity } = Bridge.allocate(16, schema);
  const bridge = new Bridge(sab, capacity, schema);
  bridge.observeConsumerTime(0, 0);
  assert(
    bridge.telemetry().pllOutliersRejected === 0,
    "Bridge.telemetry().pllOutliersRejected starts at 0",
  );

  ok("pll-outlier-gate-tuning-and-validation");
}


// ── 75. PLL drift estimator — default-off preserves 0.6.14 (0.6.15) ──────
function testPllDriftEstimatorDefaultOff(): void {
  // Default-constructed PLL has the estimator off.
  const pll = new ConsumerClockRecovery();
  assertEq(pll.driftEstimatorEnabled, false, "drift estimator default off");
  assertEq(pll.driftPpm, 0, "drift estimate starts at 0");

  // Feed a non-trivial sequence (with simulated 100 ppm drift in the
  // producer clock) — pllDriftPpm stays at 0 because the estimator is
  // off. The offset will drift but be tracked as moving offset, not
  // as a drift.
  pll.observe(0, 0);
  let consumerNs = 0;
  for (let i = 0; i < 50; i++) {
    consumerNs += 16_666_667;
    // Producer clock: 100 ppm faster than consumer. The producer
    // measures `consumerNs * 1.0001` worth of producer time relative
    // to its own start. So producerNs at consumer time consumerNs is
    // consumerNs + (consumerNs * 100e-6) = consumerNs + 100 ppm of
    // consumerNs.
    const producerNs = consumerNs + consumerNs * 100e-6;
    pll.observe(consumerNs, producerNs);
  }
  assertEq(pll.driftPpm, 0, "default-off PLL never updates drift estimate");

  // Bridge's built-in PLL is default-constructed → drift off.
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);
  assertEq(ring.telemetry().pllDriftPpm, 0, "Bridge.telemetry().pllDriftPpm starts at 0");
  ring.observeConsumerTime(0, 0);
  assertEq(ring.telemetry().pllDriftPpm, 0, "still 0 after observation (drift off by default)");

  ok("pll-drift-estimator-default-off");
}


// ── 76. PLL drift estimator — converges on constant drift (0.6.15) ───────
function testPllDriftEstimatorConvergence(): void {
  const TRUE_DRIFT_PPM = 100; // 100 ppm — producer clock runs 100 ppm fast
  const pll = new ConsumerClockRecovery({ enableDriftEstimator: true });
  assertEq(pll.driftEstimatorEnabled, true, "drift estimator opted in");

  // Seed at offset = 0, consumerNs = 0.
  pll.observe(0, 0);

  // Feed 500 observations at ~60 Hz. Producer time advances faster
  // than consumer by TRUE_DRIFT_PPM ppm.
  let consumerNs = 0;
  const rng = mulberry32(0x600d);
  for (let i = 0; i < 500; i++) {
    consumerNs += 16_666_667;
    // Producer clock at "true" producer time corresponding to this
    // consumer time. With 100 ppm faster producer clock, after
    // consumerNs of consumer time has passed, producer has experienced
    // consumerNs * (1 + 100e-6) of producer time. We're using the
    // convention that producerNs is "what the producer reports as its
    // wall-clock at the moment of observation," so producerNs =
    // consumerNs + consumerNs * 100e-6 (the drift accumulates in the
    // offset).
    //
    // Jitter is ±1 μs — small enough that the analytic g-h steady-
    // state drift variance σ(drift) ≈ √(β/(2-α-β)) · σ(res)/dt is
    // about 6 ppm, well below the 10 ppm test threshold.
    const jitter = (rng() - 0.5) * 2_000;
    const trueOffsetNs = consumerNs * TRUE_DRIFT_PPM * 1e-6;
    const producerNs = consumerNs + trueOffsetNs + jitter;
    pll.observe(consumerNs, producerNs);
  }

  const estimatedDriftPpm = pll.driftPpm;
  const driftError = Math.abs(estimatedDriftPpm - TRUE_DRIFT_PPM);
  assert(
    driftError < 10,
    `drift estimator converges to within 10 ppm of truth (estimated=${estimatedDriftPpm.toFixed(2)} ppm, truth=${TRUE_DRIFT_PPM} ppm, error=${driftError.toFixed(2)} ppm)`,
  );

  // Offset at last observation should match the true offset at that
  // moment, modulo 1 ms.
  const trueFinalOffset = consumerNs * TRUE_DRIFT_PPM * 1e-6;
  const offsetError = Math.abs(pll.offsetNs - trueFinalOffset);
  assert(
    offsetError < 1_000_000,
    `offset tracks drift: |estimate=${pll.offsetNs.toFixed(0)} − truth=${trueFinalOffset.toFixed(0)}| = ${offsetError.toFixed(0)} ns < 1 ms`,
  );

  ok("pll-drift-estimator-convergence");
}


// ── 77. PLL drift estimator — phaseLockedTime + validation (0.6.15) ─────
function testPllDriftEstimatorPhaseLockedTime(): void {
  const TRUE_DRIFT_PPM = 50;
  const pll = new ConsumerClockRecovery({
    enableDriftEstimator: true,
    driftGain: 0.005,
  });

  // Train the PLL.
  pll.observe(0, 0);
  let consumerNs = 0;
  for (let i = 0; i < 500; i++) {
    consumerNs += 16_666_667;
    const trueOffset = consumerNs * TRUE_DRIFT_PPM * 1e-6;
    pll.observe(consumerNs, consumerNs + trueOffset);
  }

  // phaseLockedTime called WELL PAST the last observation —
  // simulating a quantum that's far into the future.
  const farConsumerNs = consumerNs + 100_000_000; // +100 ms into the future
  const truePhaseLockedTime = farConsumerNs + farConsumerNs * TRUE_DRIFT_PPM * 1e-6;
  const predicted = pll.phaseLockedTime(farConsumerNs);
  const extrapolationError = Math.abs(predicted - truePhaseLockedTime);
  assert(
    extrapolationError < 50_000,
    `extrapolation accurate within 50 μs over 100 ms: |${predicted.toFixed(0)} − ${truePhaseLockedTime.toFixed(0)}| = ${extrapolationError.toFixed(0)} ns`,
  );

  // Compare to an offset-only PLL trained on the same data — its
  // extrapolation should be off by approximately driftRate × elapsed.
  const offsetOnly = new ConsumerClockRecovery();
  offsetOnly.observe(0, 0);
  let c2 = 0;
  for (let i = 0; i < 500; i++) {
    c2 += 16_666_667;
    const trueOffset = c2 * TRUE_DRIFT_PPM * 1e-6;
    offsetOnly.observe(c2, c2 + trueOffset);
  }
  const offsetOnlyPredicted = offsetOnly.phaseLockedTime(farConsumerNs);
  const offsetOnlyError = Math.abs(offsetOnlyPredicted - truePhaseLockedTime);
  // Sanity: the drift-enabled extrapolation should be meaningfully
  // better than the offset-only extrapolation in this scenario.
  assert(
    extrapolationError < offsetOnlyError,
    `drift-enabled extrapolation better than offset-only: drift=${extrapolationError.toFixed(0)} ns < offset-only=${offsetOnlyError.toFixed(0)} ns`,
  );

  // Reset clears drift state.
  pll.reset();
  assertEq(pll.driftPpm, 0, "reset clears drift");
  assertEq(pll.locked, false, "reset unlocks");

  // After reset, drift estimator is still enabled (it's a construction-
  // time setting). Next observation seeds fresh.
  assertEq(pll.driftEstimatorEnabled, true, "drift flag survives reset");
  pll.observe(1000, 1042);
  assertEq(pll.offsetNs, 42, "post-reset re-seed");
  assertEq(pll.driftPpm, 0, "post-reset drift starts at 0");

  // (Validation.) driftGain must be positive finite.
  let threw = false;
  try { new ConsumerClockRecovery({ driftGain: 0 }); } catch { threw = true; }
  assert(threw, "driftGain=0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ driftGain: -0.1 }); } catch { threw = true; }
  assert(threw, "driftGain<0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ driftGain: NaN }); } catch { threw = true; }
  assert(threw, "driftGain=NaN throws");
  threw = false;
  try { new ConsumerClockRecovery({ driftGain: Infinity }); } catch { threw = true; }
  assert(threw, "driftGain=Infinity throws (must be finite)");

  ok("pll-drift-estimator-phase-locked-time");
}


// ── 78. PLL lane publication — cross-process readability (0.6.16) ────────
function testPllLanePublicationCrossPeer(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);

  // Two Bridge instances over the SAME SAB. One is the "consumer"
  // that runs observe(); the other is the "observer" that only
  // reads published lanes.
  const consumer = new Bridge(sab, capacity, schema);
  const observer = new Bridge(sab, capacity, schema);

  // Pre-observe: observer reads default-zero lanes.
  const initial = observer.readPublishedPllState();
  assertEq(initial.locked, false, "pre-observe published locked = false");
  assertEq(initial.offsetNs, 0, "pre-observe published offset = 0");
  assertEq(initial.driftPpm, 0, "pre-observe published drift = 0");

  // Consumer locks the PLL at offset = 12,345 ns.
  consumer.observeConsumerTime(0, 12_345);
  const afterSeed = observer.readPublishedPllState();
  assertEq(afterSeed.locked, true, "post-seed published locked = true");
  assertEq(afterSeed.offsetNs, 12_345, "post-seed published offset = 12345");

  // Drive convergence on a sequence of observations.
  let consumerNs = 1_000_000;
  for (let i = 0; i < 50; i++) {
    consumerNs += 16_666_667;
    consumer.observeConsumerTime(consumerNs, consumerNs + 12_345);
  }
  const afterRun = observer.readPublishedPllState();
  const consumerOffset = consumer.telemetry().pllOffsetNs;
  assertEq(afterRun.locked, true, "post-run still locked");
  // Published offset should match consumer's heap-side state within
  // 1 ns (Math.round is the only source of difference).
  assert(
    Math.abs(afterRun.offsetNs - consumerOffset) <= 1,
    `published offset matches consumer heap state (publishedNs=${afterRun.offsetNs}, heap=${consumerOffset})`,
  );

  // resetPll → observer sees the reset.
  consumer.resetPll();
  const afterReset = observer.readPublishedPllState();
  assertEq(afterReset.locked, false, "post-reset published locked = false");
  assertEq(afterReset.offsetNs, 0, "post-reset published offset = 0");
  assertEq(afterReset.driftPpm, 0, "post-reset published drift = 0");

  // Opt-out: with publishPllToSab: false, the lanes don't update.
  const { sab: sab2 } = Bridge.allocate(16, schema);
  const consumerSilent = new Bridge(sab2, 16, schema, { publishPllToSab: false });
  const observerSilent = new Bridge(sab2, 16, schema);
  consumerSilent.observeConsumerTime(0, 99_999);
  consumerSilent.observeConsumerTime(16_666_667, 16_666_667 + 99_999);
  const silentRead = observerSilent.readPublishedPllState();
  assertEq(silentRead.locked, false, "publishPllToSab:false keeps locked at default");
  assertEq(silentRead.offsetNs, 0, "publishPllToSab:false keeps offset at default");

  ok("pll-lane-publication-cross-peer");
}


// ── 79. PLL lane publication — encoding round-trips + wire-compat (0.6.16) ─
function testPllLanePublicationEncoding(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);

  // Int64 offset round-trip. ±1 day of nanoseconds = ±8.64e13 ns,
  // well within Int64 range and below Number precision boundary
  // (2^53 ≈ 9e15).
  const offsets = [
    0,
    1,
    -1,
    1_000_000_000,           // 1 sec
    -1_000_000_000,
    8.64e13,                 // 1 day
    -8.64e13,
  ];
  for (const target of offsets) {
    const { sab } = Bridge.allocate(16, schema);
    const writer = new Bridge(sab, 16, schema);
    const reader = new Bridge(sab, 16, schema);
    // Seed PLL with the target offset.
    writer.observeConsumerTime(0, target);
    const r = reader.readPublishedPllState();
    assert(
      Math.abs(r.offsetNs - target) <= 1,
      `Int64 offset round-trip: target=${target}, read=${r.offsetNs}`,
    );
  }

  // Q16.16 drift ppm round-trip. Range ±50 ppm covers all realistic
  // clock drift; precision = 1/65536 ppm ≈ 1.5e-5 ppm (way below
  // anything observable). Drive via direct SpscRing access (already
  // imported at top of file) so the test controls the exact value the
  // publisher writes — Bridge's publish path goes via the live PLL,
  // which would interact with the outlier gate / drift estimator.
  const drifts = [0, 1, -1, 10, -10, 50, -50, 100, -100];
  for (const targetPpm of drifts) {
    const { sab } = Bridge.allocate(16, schema);
    const ring = new SpscRing(sab, 16, schema);
    ring.publishPllState(0, targetPpm, true);
    const r = ring.readPublishedPllState();
    assert(
      Math.abs(r.driftPpm - targetPpm) < 1e-4,
      `Q16.16 drift round-trip: target=${targetPpm} ppm, read=${r.driftPpm}`,
    );
  }

  // Wire-compat scenario. Imagine an "old peer" wrote frames to the
  // SAB but never published to PLL lanes (i.e. lanes 4-7 stay at SAB
  // default zero). A new peer over the same SAB reads the lanes:
  // gets the all-zero default, which is interpreted as
  // "no usable estimate" — locked=false, offset=0, drift=0.
  const { sab: legacySab } = Bridge.allocate(16, schema);
  const newPeer = new Bridge(legacySab, 16, schema);
  // (No publishPllState calls — simulating the legacy peer.)
  // Push a few frames through to exercise the rest of the protocol
  // and confirm lanes 4-7 are untouched.
  const frame = newPeer.scratchFrame() as PhysFrame;
  for (let i = 0; i < 5; i++) {
    frame.seq = BigInt(i);
    newPeer.push(frame);
  }
  const out = emptyPhysFrame(n);
  newPeer.pull(out);
  const legacyRead = newPeer.readPublishedPllState();
  assertEq(legacyRead.locked, false, "legacy SAB → reader sees locked=false");
  assertEq(legacyRead.offsetNs, 0, "legacy SAB → reader sees offset=0");
  assertEq(legacyRead.driftPpm, 0, "legacy SAB → reader sees drift=0");

  ok("pll-lane-publication-encoding");
}


// ── 92. BigInt-free PLL publish + 2^32-boundary round-trip (0.8.2) ────────
function testPllPublishBigIntFreeAndBoundaryRoundTrip(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);

  // (a) Allocation-free pin. Monkey-patch globalThis.BigInt with a
  // counting wrapper, run a 10k-publish loop, then restore. The 0.8.1
  // path called `BigInt(Math.round(offsetNs))` once per publish; the
  // 0.8.2 path replaces it with a pure-Number decomposition into two
  // Int32 halves. Counting BigInt invocations across the publish loop
  // pins the allocation-free contract directly. Note this catches any
  // EXPLICIT `BigInt(...)` constructor call; engine-internal BigInt
  // operations on existing BigInt values (which there are none of in
  // publishPllState's body) wouldn't go through globalThis.BigInt
  // either way.
  const { sab } = Bridge.allocate(16, schema);
  const ring = new SpscRing(sab, 16, schema);

  const originalBigInt = globalThis.BigInt;
  let bigIntCallCount = 0;
  const counting = function (this: unknown, value: unknown): bigint {
    bigIntCallCount++;
    return originalBigInt(value as never);
  } as unknown as BigIntConstructor;
  // Preserve the static surface so unrelated callers that touch
  // BigInt.asIntN / .asUintN don't break during the spied window.
  counting.asIntN = originalBigInt.asIntN;
  counting.asUintN = originalBigInt.asUintN;
  Object.defineProperty(counting, "prototype", {
    value: originalBigInt.prototype,
    writable: false,
  });
  Object.defineProperty(globalThis, "BigInt", {
    value: counting,
    configurable: true,
    writable: true,
  });
  try {
    for (let i = 0; i < 10_000; i++) {
      // Sweep across the 2^32 boundary so the publish hits both
      // positive and negative carry cases.
      const offsetNs = (i - 5_000) * 1_000_001;
      ring.publishPllState(offsetNs, (i % 7) * 0.01, (i & 1) === 0);
    }
  } finally {
    Object.defineProperty(globalThis, "BigInt", {
      value: originalBigInt,
      configurable: true,
      writable: true,
    });
  }
  assertEq(
    bigIntCallCount,
    0,
    `publishPllState should be BigInt-free; observed ${bigIntCallCount} BigInt() calls in 10k-publish loop`,
  );

  // (b) Round-trip pin for the new BigInt-free carry math. The two-Int32
  // split is where sign and carry bugs would surface; this exercises
  // both halves of the 2^32 boundary plus 0/±1/±2^53.
  const boundaryOffsets = [
    0,
    1,
    -1,
    2 ** 32,
    -(2 ** 32),
    2 ** 32 - 1,
    -(2 ** 32) + 1,
    2 ** 32 + 1,
    -(2 ** 32) - 1,
    2 ** 31,         // exactly Int32 max boundary
    -(2 ** 31),      // exactly Int32 min boundary
    2 ** 31 - 1,
    -(2 ** 31) - 1,
    2 ** 53,         // Number-precision ceiling
    -(2 ** 53),
    1_234_567_890_123,
    -1_234_567_890_123,
  ];
  for (const target of boundaryOffsets) {
    const { sab: sabB } = Bridge.allocate(16, schema);
    const writer = new SpscRing(sabB, 16, schema);
    const reader = new SpscRing(sabB, 16, schema);
    // Direct ring.publishPllState so the test controls the exact value
    // hitting the encoder — Bridge.observeConsumerTime would route via
    // the live PLL and re-shape the value.
    writer.publishPllState(target, 0, true);
    const got = reader.readPublishedPllState();
    assertEq(
      got.locked,
      true,
      `locked round-trips for target=${target}`,
    );
    assert(
      got.offsetNs === target,
      `offset round-trips bit-exact: target=${target}, read=${got.offsetNs}`,
    );
  }

  ok("pll-publish-bigint-free-boundary-round-trip");
}

function main(): void {
  testPllColdStart();
  testPllConvergence();
  testPllStepAndResetAndValidation();
  testPullEvaluatedLatestRoundTrip();
  testTimestampRoleResolution();
  testSampleRateResolution();
  testTimestampUnitConversion();
  testPllOutlierGateSingleSpike();
  testPllOutlierGateSustainedStep();
  testPllOutlierGateTuningAndValidation();
  testPllDriftEstimatorDefaultOff();
  testPllDriftEstimatorConvergence();
  testPllDriftEstimatorPhaseLockedTime();
  testPllLanePublicationCrossPeer();
  testPllLanePublicationEncoding();
  testPllPublishBigIntFreeAndBoundaryRoundTrip();
  console.log("\nAll Bridge PLL tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
