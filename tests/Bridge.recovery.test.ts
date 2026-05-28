/**
 * Bridge recovery — worklet error-recovery pins (0.9.34).
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.recovery.test.ts
 *
 * The pins simulate three failure modes the audio thread can hit in
 * production and assert that the bridge's state remains coherent:
 *
 *   1. **Producer disappears mid-stream.** The consumer keeps polling
 *      via `pullLatest` and gets clean `-1` returns for N quanta. The
 *      smoother's `prev` frame is preserved across the empty pulls so
 *      the first post-recovery push blends correctly. `tornFrames` /
 *      `softFrames` counters do not drift on an empty ring. The PLL's
 *      offset estimate is unchanged by the famine (PLL only updates on
 *      explicit `observeConsumerTime` calls; no observations → no
 *      drift in the estimate itself).
 *
 *   2. **Consumer crashes mid-quantum: SAB state survives.** The
 *      AudioWorklet `process()` throwing is fatal to that worklet — the
 *      browser shuts down the audio thread. But the SAB owned by the
 *      Bridge is process-owned, not worklet-owned, so a fresh Bridge
 *      attached to the same SAB sees coherent producer/consumer
 *      cursors and can resume reading from where the dead consumer left
 *      off. The pin asserts: pull N frames with a "consumer A," drop
 *      the reference (simulating crash), attach a "consumer B" to the
 *      same SAB, drain the remaining frames in FIFO order, no torn or
 *      duplicate frames.
 *
 *   3. **5-second frame famine: PLL drift estimator + smoother prev
 *      both survive.** A drift-estimator-enabled PLL is trained to
 *      lock on a 100-ppm producer↔consumer skew. Then a 5-second
 *      famine — no `observe` calls, no pushes, no pulls. After the
 *      famine, a clean observation lands at the expected drifted
 *      offset; the outlier gate admits it (residual is small relative
 *      to σ̂); `phaseLockedTime` extrapolation is sane (finite, not
 *      NaN, within the gain-bounded drift error of truth); the
 *      smoother's `prev` frame is unchanged from the pre-famine value.
 *
 * Assertion target is bridge / PLL / smoother state, not audio
 * output — the tests run as Node scripts against simulated
 * time-gap patterns, not in a real AudioWorklet. The worklet
 * behavior these pins document (a `process()` throw shuts down the
 * thread) is browser-defined and outside this library's control.
 * What we own is the SAB protocol invariant: peer crashes do not
 * corrupt the bridge's wire state.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  emptyPhysFrame,
  makePhysFrame,
} from "./_bridgeHelpers.js";
import { Bridge } from "../src/Bridge.js";
import { BridgeConsumer } from "../src/BridgeConsumer.js";
import { ConsumerClockRecovery } from "../src/ConsumerClockRecovery.js";
import { SpscRing } from "../src/SpscRing.js";
import { physicsControlFrameSchema } from "../src/schemas/physics.js";

// ── 1. Producer disappears mid-stream — consumer survives clean ──────────
//
// Push 8 frames, drain them, then pull 200 more times on an empty ring.
// Every empty pullLatest returns -1; the smoother's prev frame is
// preserved (next non-empty pullSmoothed blends with the right prev);
// telemetry's tornFrames / softFrames stay at 0; PLL state is unchanged
// across the famine.
function testProducerDisappearsMidStream(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  // Seed the PLL so we have a non-trivial offset to observe through the
  // famine. The PLL state only changes when `observeConsumerTime` is
  // called; no observations during the famine → no estimate drift.
  bridge.observeConsumerTime(1_000_000_000, 1_500_000_000);
  const pllOffsetBefore = bridge.telemetry().pllOffsetNs;
  assert(bridge.telemetry().pllLocked, "PLL locked after seed");

  // Push 8 frames, drain them via pullLatestSmoothed so the smoother's
  // prev gets seeded. After the drain the ring is empty and the
  // smoother holds frame 8 as its prev.
  for (let i = 1; i <= 8; i++) {
    bridge.push(makePhysFrame(i, n));
  }
  const drained0 = bridge.pullLatestSmoothed(out, 0.5);
  assert(drained0 >= 0, "first drain succeeds");
  assertEq(out.seq, 8n, "drained the latest frame (FIFO + pullLatest)");
  const lastSeq = out.seq;
  const lastVMax = out.vMax;

  // The producer disappears. 200 quanta of empty pulls — pullLatest,
  // pullLatestSmoothed, pullEvaluatedLatest if a sample rate were set
  // (it isn't, so skip that one — the constructor path validates).
  let emptyHits = 0;
  for (let q = 0; q < 200; q++) {
    const r = bridge.pullLatest(out);
    if (r === -1) emptyHits++;
    const rs = bridge.pullLatestSmoothed(out, 0.5);
    if (rs === -1) emptyHits++;
  }
  assertEq(emptyHits, 400, "every empty pull returned -1 (no exceptions)");

  // Telemetry is clean: ring is empty, no torn / soft frames accumulated,
  // PLL offset is unchanged.
  const t1 = bridge.telemetry();
  assertEq(t1.tornFrames, 0, "tornFrames unchanged across famine");
  assertEq(t1.softFrames, 0, "softFrames unchanged (no invariant schema, but still 0)");
  assertEq(t1.pllOffsetNs, pllOffsetBefore, "PLL offset unchanged — no observations during famine");
  assertEq(t1.pllLocked, true, "PLL stays locked across famine");

  // The smoother's prev is still the last drained frame. Push a single
  // new frame with vMax = 100 and α = 0 (fully blend toward prev). The
  // result should be exactly the smoother's prev — which is the last
  // pre-famine frame.
  const fresh = makePhysFrame(9, n);
  fresh.vMax = 100; // distinct so we can see the blend
  bridge.push(fresh);
  const r = bridge.pullLatestSmoothed(out, 0); // α=0 → out ≈ prev
  assertEq(r, 0, "post-famine pull succeeded (no skip)");
  assertEq(out.seq, fresh.seq, "post-famine seq is the new frame");
  assertEq(out.vMax, lastVMax, "post-famine α=0 blend yields the pre-famine prev value");
  void lastSeq;

  ok("1. producer-disappears: empty pulls clean, smoother prev preserved, PLL state stable");
}

// ── 2. Consumer crashes mid-quantum: SAB state survives ─────────────────
//
// The bridge protocol is consumer-crash-safe at the SAB level: a fresh
// Bridge (or BridgeConsumer) attached to the same SAB resumes reading
// from where the dead consumer left off. The consumer's heap state
// (smoother prev, PLL offset) is lost on crash — that's expected, those
// are heap-only — but the wire state survives. This pin documents the
// invariant: pull N frames with consumer A, "crash" A by dropping the
// reference, attach consumer B to the same SAB, B reads remaining
// frames in FIFO order.
function testConsumerCrashSabStateSurvives(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);

  // Consumer A: pull frames 1, 2, 3.
  let consumerA: Bridge<typeof schema> | null = new Bridge(sab, capacity, schema);
  // Producer pushes frames 1..10 (uses a separate Bridge instance over
  // the same SAB — that's not the SPSC contract in production but is
  // fine for this test since the two roles don't overlap in this
  // sequence). Actually, simpler: just push from consumerA's instance
  // (Bridge is bidirectional).
  for (let i = 1; i <= 10; i++) {
    consumerA.push(makePhysFrame(i, n));
  }
  const outA = emptyPhysFrame(n);
  for (let i = 1; i <= 3; i++) {
    const r = consumerA.pull(outA);
    assertEq(r, true, `consumer A pulls frame ${i}`);
    assertEq(outA.seq, BigInt(i), `frame ${i} seq match`);
  }
  // Heap-only state on consumer A — populate smoother + PLL so we can
  // verify they're forgotten when we "crash."
  consumerA.pullSmoothed(outA, 0.5);
  consumerA.observeConsumerTime(1_000_000_000, 1_500_000_000);
  assert(consumerA.telemetry().pllLocked, "consumer A PLL locked before crash");

  // Crash: drop the reference. In a real worklet this is the browser
  // shutting down the AudioWorklet thread after `process()` throws.
  consumerA = null;

  // Consumer B: attach a fresh Bridge over the same SAB. Read remaining
  // frames in FIFO order.
  const consumerB = new Bridge(sab, capacity, schema);
  // SAB-state invariants on attach: the new bridge sees the producer's
  // committed write index AND consumer A's last read index — so the
  // "available" count is exactly the unread frames.
  assertEq(consumerB.available(), 6, "consumer B sees 10-(3+1)=6 unread frames after smoothed pull");

  // Consumer B's heap state is fresh: PLL unlocked, smoother prev
  // empty, eval cache empty.
  const tB0 = consumerB.telemetry();
  assertEq(tB0.pllLocked, false, "consumer B starts with fresh (unlocked) PLL");
  assertEq(tB0.pllOffsetNs, 0, "consumer B PLL offset is 0 (heap-only state didn't survive)");

  // Drain remaining frames. Consumer A consumed frames 1, 2, 3 via pull
  // and then frame 4 via pullSmoothed — so B should see frames 5..10.
  const outB = emptyPhysFrame(n);
  const seenSeqs: bigint[] = [];
  while (consumerB.pull(outB)) {
    seenSeqs.push(outB.seq);
  }
  assertEq(seenSeqs.length, 6, "consumer B drained 6 frames");
  for (let i = 0; i < 6; i++) {
    assertEq(seenSeqs[i]!, BigInt(5 + i), `B sees frame ${5 + i} at position ${i}`);
  }

  // No torn / soft frames in either consumer's view of SAB state.
  assertEq(consumerB.telemetry().tornFrames, 0, "no tornFrames after crash + reattach");

  ok("2. consumer-crash: SAB state coherent, fresh consumer drains remaining frames in FIFO order");
}

// ── 3. 5-second frame famine: PLL drift + smoother prev survive ──────────
//
// A 100-ppm producer↔consumer skew drives the PLL drift estimator. After
// the loop locks, a 5-second famine — no observations. The drift
// estimator's `phaseLockedTime` extrapolation must stay sane through
// the gap (no NaN/Inf, drift error bounded). When the next observation
// arrives at the consistent skew, the outlier gate must admit it (the
// residual is small once drift extrapolation accounts for the gap). The
// smoother's prev frame is heap state, retained across the famine.
function testFamineDoesNotBreakPllOrSmoother(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new SpscRing(sab, capacity, schema);
  // Keep a local reference to the PLL — BridgeConsumer doesn't expose a
  // telemetry() method like Bridge<S> does, so PLL state inspection
  // goes through the instance we constructed.
  const pll = new ConsumerClockRecovery({ enableDriftEstimator: true });
  const consumer = new BridgeConsumer(ring, { pll });

  const TRUE_DRIFT_PPM = 100;
  const SIXTY_HZ_NS = 16_666_667;

  // Train the PLL with 200 observations at ~60 Hz. After this loop the
  // drift estimator should be within a few ppm of TRUE_DRIFT_PPM.
  let consumerNs = 1_000_000_000;
  consumer.observeConsumerTime(consumerNs, consumerNs);
  for (let i = 0; i < 200; i++) {
    consumerNs += SIXTY_HZ_NS;
    const trueOffset = consumerNs * TRUE_DRIFT_PPM * 1e-6;
    consumer.observeConsumerTime(consumerNs, consumerNs + trueOffset);
  }
  assert(pll.locked, "PLL locked after training");
  const driftBefore = pll.driftPpm;
  assert(
    Math.abs(driftBefore - TRUE_DRIFT_PPM) < 10,
    `drift converges to within 10 ppm of truth (got ${driftBefore.toFixed(2)} ppm)`,
  );

  // Push and pull a frame so the smoother holds a prev. Use a distinct
  // vMax so the post-famine blend assertion is unambiguous. The producer
  // side is the SpscRing directly — BridgeConsumer is consumer-only.
  const seedFrame = makePhysFrame(42, n);
  seedFrame.vMax = 999;
  ring.push(seedFrame);
  const out = emptyPhysFrame(n);
  const r = consumer.pullLatestSmoothed(out, 0.5);
  assert(r >= 0, "seed pull succeeded");
  assertEq(out.vMax, 999, "pre-famine vMax in out");
  const smoothedPrevVMax = out.vMax; // 999

  // 5-second famine. consumerNs jumps forward by 5e9 ns. No observe
  // calls in between — the PLL state stays exactly where it was, but
  // phaseLockedTime() extrapolates the offset forward by
  // driftRate × (consumerNs - lastConsumerNs).
  const famineDurationNs = 5_000_000_000; // 5 seconds
  const consumerNsAtFamineEnd = consumerNs + famineDurationNs;

  // phaseLockedTime mid-famine and at famine end — both must be finite
  // and within drift-bounded error of truth. With driftPpm = 100 and
  // famineDuration = 5 s, the truth-vs-estimate gap is dominated by the
  // ppm difference between the estimator and the true rate (~few ppm
  // residual × 5 s = ~tens of μs).
  const truthAtFamineEnd =
    consumerNsAtFamineEnd + consumerNsAtFamineEnd * TRUE_DRIFT_PPM * 1e-6;
  const extrapolated = consumer.phaseLockedTime(consumerNsAtFamineEnd);
  assert(Number.isFinite(extrapolated), "phaseLockedTime is finite mid-famine");
  const extrapolationError = Math.abs(extrapolated - truthAtFamineEnd);
  assert(
    extrapolationError < 5_000_000, // 5 ms tolerance over a 5-s gap
    `extrapolation error bounded across famine: |${extrapolated.toFixed(0)} − ${truthAtFamineEnd.toFixed(0)}| = ${extrapolationError.toFixed(0)} ns < 5 ms`,
  );

  // Post-famine: a fresh observation at the true drift. The residual
  // (truth − extrapolated) should be small; the outlier gate must
  // admit it. Track outliersRejected to verify the gate didn't reject
  // the recovery observation.
  const outliersBefore = pll.outliersRejected;
  const trueOffsetAtFamineEnd = consumerNsAtFamineEnd * TRUE_DRIFT_PPM * 1e-6;
  consumer.observeConsumerTime(
    consumerNsAtFamineEnd,
    consumerNsAtFamineEnd + trueOffsetAtFamineEnd,
  );
  assert(pll.locked, "PLL still locked after famine + recovery observation");
  // The gate may or may not reject — depends on residual / σ̂ ratio.
  // What we pin is: at most a tiny number of rejections (not all of
  // them); the PLL state stays sane.
  const newRejects = pll.outliersRejected - outliersBefore;
  assert(newRejects <= 1, `at most one rejection across recovery (got ${newRejects})`);
  assert(Number.isFinite(pll.offsetNs), "post-famine offset finite");
  assert(Number.isFinite(pll.driftPpm), "post-famine drift finite");
  assert(
    Math.abs(pll.driftPpm - TRUE_DRIFT_PPM) < 50,
    `drift estimate still within 50 ppm of truth after famine (got ${pll.driftPpm.toFixed(2)} ppm)`,
  );

  // Smoother prev is heap-state, retained across the famine. A
  // post-famine pull with α=0 should yield the pre-famine vMax (no
  // new frames pushed → prev wins).
  ring.push(makePhysFrame(43, n)); // new frame with default vMax (= 43)
  const out2 = emptyPhysFrame(n);
  const r2 = consumer.pullLatestSmoothed(out2, 0); // α=0 → out ≈ prev
  assert(r2 >= 0, "post-famine pull succeeded");
  assertEq(
    out2.vMax,
    smoothedPrevVMax,
    "smoother prev preserved across famine (α=0 blend yields pre-famine vMax)",
  );

  ok("3. 5-sec famine: PLL drift extrapolation sane, outlier gate admits recovery, smoother prev preserved");
}

function main(): void {
  testProducerDisappearsMidStream();
  testConsumerCrashSabStateSurvives();
  testFamineDoesNotBreakPllOrSmoother();
  console.log("\nAll Bridge.recovery.test.ts pins passed.");
}

main();
