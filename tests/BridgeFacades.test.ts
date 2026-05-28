/**
 * BridgeFacades — pins for the 0.6.10 composable consumer/producer surface.
 *
 * Standalone tsx script — same convention as tests/Bridge.test.ts. Run with:
 *   npx tsx tests/BridgeFacades.test.ts
 *
 * Pins:
 *   1. Construction + defaults + opt-out semantics. BridgeConsumer built with
 *      no options has a non-null FrameSmoother + ConsumerClockRecovery wired
 *      to the ring's schema; `{smoother:null, pll:null}` opts them out and
 *      makes pullSmoothed / observeConsumerTime / phaseLockedTime throw with
 *      a clear message. BridgeProducer mirrors push / beginPush / abortPush /
 *      flowScaleHint without the consumer-state machinery.
 *   2. Producer↔consumer round-trip on a no-invariant physics schema. Frames
 *      pushed by BridgeProducer are pulled bit-exact by BridgeConsumer over
 *      the SAME SpscRing; pullLatest reports the correct skipped count.
 *      scratchFrame on both facades returns a usable view.
 *   3. Symmetry with Bridge<S>. On two SABs of identical (capacity, schema)
 *      driven by the same producer pattern, `BridgeConsumer.pull` and
 *      `BridgeConsumer.pullLatestSmoothed` produce bit-identical output to
 *      `Bridge<S>.pull` / `Bridge<S>.pullLatestSmoothed`. Catches drift in
 *      the duplicated invariant classifier and the smoother dispatch.
 *   4. Invariant failure-policy table under `.withInvariant`. Default
 *      `'fallback-to-previous'` matches Bridge<S> bit-for-bit (last-known-
 *      good frame returned on hard error, tornFrames increments). `'throw'`
 *      raises an Error from the pull call. `'pass-through'` lets the corrupt
 *      payload through unchanged but still increments tornFrames. A custom
 *      callback receives `(out, computed, stored)` and may mutate `out`.
 *   5. (0.9.35) `BridgeConsumer.telemetry()` symmetry with `Bridge<S>.telemetry()`.
 *      Two SABs of identical (capacity, schema), both driven through the
 *      same producer→consumer→PLL→smoother pattern, must produce field-
 *      for-field identical `TelemetrySnapshot`s. Catches drift in the new
 *      `BridgeConsumer.telemetry()` (0.9.35) against the reference
 *      `Bridge<S>.telemetry()` implementation. Includes a soft-invariant
 *      sub-pin verifying the new `BridgeConsumer._softFrames` counter
 *      ticks in lock-step with `Bridge._softFrames`.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge, RING_HEADER_BYTES } from "../src/Bridge.js";
import { SpscRing } from "../src/SpscRing.js";
import { BridgeConsumer } from "../src/BridgeConsumer.js";
import { BridgeProducer } from "../src/BridgeProducer.js";
import { FrameSmoother } from "../src/FrameSmoother.js";
import { ConsumerClockRecovery } from "../src/ConsumerClockRecovery.js";
import {
  defineSchema,
  f64Array,
  u64,
  type FrameFor,
} from "../src/schema.js";
import {
  physicsControlFrameSchema,
  type PhysicsControlFrameSchema,
} from "../src/schemas/physics.js";

type PhysFrame = FrameFor<PhysicsControlFrameSchema>;

function makePhysFrame(seq: number, n: number): PhysFrame {
  const vEff = new Float64Array(n);
  const jEff = new Float64Array(n);
  let vMax = 0;
  let jMax = 0;
  for (let k = 0; k < n; k++) {
    vEff[k] = seq + k * 0.001;
    jEff[k] = -seq + k * 0.001;
    if (Math.abs(vEff[k]!) > vMax) vMax = Math.abs(vEff[k]!);
    if (Math.abs(jEff[k]!) > jMax) jMax = Math.abs(jEff[k]!);
  }
  return {
    seq: BigInt(seq),
    tMacroNs: BigInt(seq) * 16_666_667n,
    vMax,
    jMax,
    vEff,
    jEff,
  };
}

function emptyPhysFrame(n: number): PhysFrame {
  return {
    seq: 0n,
    tMacroNs: 0n,
    vMax: 0,
    jMax: 0,
    vEff: new Float64Array(n),
    jEff: new Float64Array(n),
  };
}

function makeInvariantSchema() {
  return defineSchema({
    seq: u64(),
    vEff: f64Array(4),
  }).withInvariant((frame) => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += frame.vEff[k]! * frame.vEff[k]!;
    return s;
  });
}

type InvFrame = FrameFor<ReturnType<typeof makeInvariantSchema>>;

function makeInvFrame(seq: number, vEff: number[]): InvFrame {
  return { seq: BigInt(seq), vEff: new Float64Array(vEff) };
}

function emptyInvFrame(): InvFrame {
  return { seq: 0n, vEff: new Float64Array(4) };
}

// ── 1. Construction + defaults + opt-out ─────────────────────────────────
function testFacadeConstructionDefaults(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = SpscRing.allocate(8, schema);
  const ring = new SpscRing(sab, capacity, schema);

  // Defaults: smoother + pll constructed.
  const consumer = new BridgeConsumer(ring);
  assert(consumer.smoother !== null, "default smoother is non-null");
  assert(consumer.pll !== null, "default pll is non-null");
  assert(consumer.smoother instanceof FrameSmoother, "default smoother is FrameSmoother");
  assert(consumer.pll instanceof ConsumerClockRecovery, "default pll is ConsumerClockRecovery");
  assertEq(consumer.schema, schema, "consumer surfaces schema");
  assertEq(consumer.capacity, capacity, "consumer surfaces capacity");

  // scratchFrame returns a usable view (fields present, arrays sized).
  const sf = consumer.scratchFrame();
  assert(sf.vEff instanceof Float64Array && sf.vEff.length === n, "scratchFrame.vEff sized");
  assertEq(typeof sf.vMax, "number", "scratchFrame.vMax is number");

  // BridgeProducer construction.
  const producer = new BridgeProducer(ring);
  assertEq(producer.schema, schema, "producer surfaces schema");
  assertEq(producer.capacity, capacity, "producer surfaces capacity");
  const ps = producer.scratchFrame();
  assert(ps.jEff instanceof Float64Array && ps.jEff.length === n, "producer scratchFrame.jEff sized");

  // Opt-out: null disables smoother + pll. Use a SEPARATE ring so the
  // smoother/pll-disabled consumer doesn't share the ring with the default
  // consumer above (SPSC: one consumer per ring).
  const { sab: sab2, capacity: cap2 } = SpscRing.allocate(8, schema);
  const ring2 = new SpscRing(sab2, cap2, schema);
  const bare = new BridgeConsumer(ring2, { smoother: null, pll: null });
  assertEq(bare.smoother, null, "smoother: null opts out");
  assertEq(bare.pll, null, "pll: null opts out");
  let threw = false;
  try {
    bare.pullSmoothed(bare.scratchFrame(), 0.5);
  } catch (e) {
    threw = true;
    assert(String(e).includes("smoother"), "pullSmoothed error mentions smoother");
  }
  assert(threw, "pullSmoothed throws when smoother: null");
  threw = false;
  try { bare.observeConsumerTime(0, 0); } catch { threw = true; }
  assert(threw, "observeConsumerTime throws when pll: null");
  threw = false;
  try { bare.phaseLockedTime(0); } catch { threw = true; }
  assert(threw, "phaseLockedTime throws when pll: null");
  // resetSmoother / resetPll are no-ops when opted out (don't throw).
  bare.resetSmoother();
  bare.resetPll();

  // Raw pull still works on a smoother-less consumer (empty ring → false).
  assertEq(bare.pull(bare.scratchFrame()), false, "raw pull on empty smoother-less consumer returns false");

  ok("facade-construction-defaults");
}

// ── 2. Producer ↔ Consumer round-trip (no invariant) ─────────────────────
function testFacadeRoundTrip(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = SpscRing.allocate(8, schema);
  const ring = new SpscRing(sab, capacity, schema);
  const producer = new BridgeProducer(ring);
  const consumer = new BridgeConsumer(ring);

  // Push three frames, drain one by one.
  for (let i = 0; i < 3; i++) {
    assertEq(producer.push(makePhysFrame(i + 10, n)), true, `push ${i}`);
  }
  const out = emptyPhysFrame(n);
  assertEq(consumer.pull(out), true, "pull #1 ok");
  assertEq(out.seq, 10n, "pull #1 seq = 10");
  assertEq(consumer.pull(out), true, "pull #2 ok");
  assertEq(out.seq, 11n, "pull #2 seq = 11");

  // pullLatest skips remaining; skipped=0 because there's exactly one frame
  // left waiting (the producer pushed 3, consumer drained 2).
  const skipped = consumer.pullLatest(out);
  assertEq(skipped, 0, "pullLatest skipped=0 with 1 frame waiting");
  assertEq(out.seq, 12n, "pullLatest returns newest (seq=12)");

  // Push 3 more, pullLatest drains them all and reports skipped=2.
  for (let i = 0; i < 3; i++) {
    producer.push(makePhysFrame(i + 100, n));
  }
  const skipped2 = consumer.pullLatest(out);
  assertEq(skipped2, 2, "pullLatest skipped=2 with 3 frames buffered");
  assertEq(out.seq, 102n, "pullLatest returns newest (seq=102)");

  // beginPush / commitPush works through the producer facade.
  const view = producer.beginPush();
  assert(view !== null, "beginPush returns view");
  view!.seq = 999n;
  view!.tMacroNs = 999n * 16_666_667n;
  view!.vMax = 1.0;
  view!.jMax = 1.0;
  view!.vEff.fill(0.5);
  view!.jEff.fill(-0.5);
  producer.commitPush();
  assertEq(consumer.pull(out), true, "pull after commitPush ok");
  assertEq(out.seq, 999n, "begin/commit round-trip seq");
  assertEq(out.vEff[0]!, 0.5, "begin/commit round-trip array");

  // available / flowScaleHint observable through both facades.
  assertEq(producer.flowScaleHint(), consumer.flowScaleHint(), "flowScaleHint symmetric");
  assertEq(consumer.available(), 0, "ring drained");

  ok("facade-round-trip");
}

// ── 3. Symmetry with Bridge<S> on the same producer pattern ───────────────
function testFacadeSymmetryWithBridge(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  // Two independent SABs of identical shape so a Bridge<S> instance and a
  // BridgeConsumer / BridgeProducer pair run in parallel and we can compare
  // their pull outputs frame-by-frame.
  const cap = 8;
  const sabA = new SharedArrayBuffer(SpscRing.byteLength(cap, schema));
  const sabB = new SharedArrayBuffer(SpscRing.byteLength(cap, schema));
  const refBridge = new Bridge(sabA, cap, schema);
  const ringB = new SpscRing(sabB, cap, schema);
  const facadeProducer = new BridgeProducer(ringB);
  const facadeConsumer = new BridgeConsumer(ringB);

  const outRef = emptyPhysFrame(n);
  const outFac = emptyPhysFrame(n);

  // Phase 1 — raw pull symmetry: push the same 5 frames into both rings,
  // pull one-by-one from each, compare bit-exact.
  for (let i = 0; i < 5; i++) {
    const f = makePhysFrame(i + 1, n);
    refBridge.push(f);
    facadeProducer.push(makePhysFrame(i + 1, n));
  }
  for (let i = 0; i < 5; i++) {
    refBridge.pull(outRef);
    facadeConsumer.pull(outFac);
    assertEq(outFac.seq, outRef.seq, `raw pull symmetry seq #${i}`);
    assertEq(outFac.vMax, outRef.vMax, `raw pull symmetry vMax #${i}`);
    for (let k = 0; k < n; k++) {
      assertEq(outFac.vEff[k], outRef.vEff[k], `raw pull symmetry vEff[${k}] #${i}`);
      assertEq(outFac.jEff[k], outRef.jEff[k], `raw pull symmetry jEff[${k}] #${i}`);
    }
  }

  // Phase 2 — pullLatestSmoothed symmetry under default 'stall-smooth' policy.
  // Push N frames into both rings between drains so skipped > 0 on some
  // pulls and we exercise the α_eff = α_base · 2^(-skipped) path.
  const alphaBase = 0.25;
  for (let cycle = 0; cycle < 8; cycle++) {
    const fillCount = (cycle % 3) + 1; // 1, 2, 3 frames per cycle
    for (let i = 0; i < fillCount; i++) {
      const f = makePhysFrame(cycle * 10 + i + 1, n);
      refBridge.push(f);
      facadeProducer.push(makePhysFrame(cycle * 10 + i + 1, n));
    }
    const skipRef = refBridge.pullLatestSmoothed(outRef, alphaBase);
    const skipFac = facadeConsumer.pullLatestSmoothed(outFac, alphaBase);
    assertEq(skipFac, skipRef, `smoothed skipped match cycle ${cycle}`);
    // BigInt scalars pass through verbatim — must be exact.
    assertEq(outFac.seq, outRef.seq, `smoothed seq match cycle ${cycle}`);
    assertEq(outFac.tMacroNs, outRef.tMacroNs, `smoothed tMacroNs match cycle ${cycle}`);
    // Float scalars / arrays: blend should produce bit-identical output
    // because both sides ran the same float ops in the same order.
    assertEq(outFac.vMax, outRef.vMax, `smoothed vMax match cycle ${cycle}`);
    assertEq(outFac.jMax, outRef.jMax, `smoothed jMax match cycle ${cycle}`);
    for (let k = 0; k < n; k++) {
      assertEq(outFac.vEff[k], outRef.vEff[k], `smoothed vEff[${k}] cycle ${cycle}`);
      assertEq(outFac.jEff[k], outRef.jEff[k], `smoothed jEff[${k}] cycle ${cycle}`);
    }
  }

  // Phase 3 — 'catch-up' skipPolicy symmetry.
  refBridge.resetSmoother();
  facadeConsumer.resetSmoother();
  for (let cycle = 0; cycle < 4; cycle++) {
    const fillCount = 3;
    for (let i = 0; i < fillCount; i++) {
      refBridge.push(makePhysFrame(cycle * 10 + i + 1, n));
      facadeProducer.push(makePhysFrame(cycle * 10 + i + 1, n));
    }
    const skipRef = refBridge.pullLatestSmoothed(outRef, alphaBase, { skipPolicy: "catch-up" });
    const skipFac = facadeConsumer.pullLatestSmoothed(outFac, alphaBase, { skipPolicy: "catch-up" });
    assertEq(skipFac, skipRef, `catch-up skipped cycle ${cycle}`);
    assertEq(outFac.seq, outRef.seq, `catch-up seq cycle ${cycle}`);
    for (let k = 0; k < n; k++) {
      assertEq(outFac.vEff[k], outRef.vEff[k], `catch-up vEff[${k}] cycle ${cycle}`);
    }
  }

  ok("facade-symmetry-with-bridge");
}

// ── 4. Invariant failure-policy table ─────────────────────────────────────
//
// Mirrors the corruption pattern from tests/Bridge.test.ts#testInvariantHard
// ErrorFallback: push A (ok pull seeds prev), push B + mutate B's vEff[0]
// directly in the SAB so computed deviates from stored past the soft
// threshold (hard error). Exercise each policy in turn against the same
// pattern.
function testFacadeInvariantPolicies(): void {
  // ── Default 'fallback-to-previous' — must match Bridge<S>. ──────────────
  {
    const schema = makeInvariantSchema();
    const { sab, capacity } = SpscRing.allocate(16, schema);
    const ring = new SpscRing(sab, capacity, schema);
    const producer = new BridgeProducer(ring);
    const consumer = new BridgeConsumer(ring); // default policy
    const out = emptyInvFrame();

    const A = makeInvFrame(1, [1, 2, 3, 4]);
    producer.push(A);
    assertEq(consumer.pull(out), true, "default policy: ok pull A");
    assertEq(consumer.tornFrameCount(), 0, "no tornFrames after ok pull");

    const B = makeInvFrame(2, [10, 20, 30, 40]);
    producer.push(B);
    // Corrupt slot 1's vEff[0]. Same SAB byte layout as Bridge.test#testInvariantHardErrorFallback.
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
    f64View[1 * 6 + 1] = 99999;
    assertEq(consumer.pull(out), true, "default policy: pull on corrupt B");
    assertEq(consumer.tornFrameCount(), 1, "default policy: hard error increments tornFrames");
    assertEq(out.seq, A.seq, "default policy: fallback returns A's seq");
    for (let k = 0; k < 4; k++) {
      assertEq(out.vEff[k], A.vEff[k]!, `default policy: fallback returns A's vEff[${k}]`);
    }
  }

  // ── 'throw' policy — pull throws on hard error. ─────────────────────────
  {
    const schema = makeInvariantSchema();
    const { sab, capacity } = SpscRing.allocate(16, schema);
    const ring = new SpscRing(sab, capacity, schema);
    const producer = new BridgeProducer(ring);
    const consumer = new BridgeConsumer(ring, { onInvariantFailure: "throw" });
    const out = emptyInvFrame();

    producer.push(makeInvFrame(1, [1, 2, 3, 4]));
    assertEq(consumer.pull(out), true, "throw policy: ok pull seeds prev");

    producer.push(makeInvFrame(2, [10, 20, 30, 40]));
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
    f64View[1 * 6 + 1] = 99999;
    let threw = false;
    try {
      consumer.pull(out);
    } catch (e) {
      threw = true;
      assert(String(e).includes("invariant"), "throw policy: error mentions invariant");
    }
    assert(threw, "throw policy: pull throws on hard error");
    // tornFrames still increments — the failure surfaces in telemetry even
    // when the policy escalates it to an exception.
    assertEq(consumer.tornFrameCount(), 1, "throw policy: tornFrames still increments");
  }

  // ── 'pass-through' policy — corrupt payload returned unchanged. ─────────
  {
    const schema = makeInvariantSchema();
    const { sab, capacity } = SpscRing.allocate(16, schema);
    const ring = new SpscRing(sab, capacity, schema);
    const producer = new BridgeProducer(ring);
    const consumer = new BridgeConsumer(ring, { onInvariantFailure: "pass-through" });
    const out = emptyInvFrame();

    producer.push(makeInvFrame(1, [1, 2, 3, 4]));
    assertEq(consumer.pull(out), true, "pass-through: ok pull A");

    producer.push(makeInvFrame(2, [10, 20, 30, 40]));
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
    f64View[1 * 6 + 1] = 99999;
    assertEq(consumer.pull(out), true, "pass-through: pull on corrupt B");
    assertEq(consumer.tornFrameCount(), 1, "pass-through: tornFrames increments");
    // Out should be the corrupt payload — vEff[0] = 99999, NOT A's [1].
    assertEq(out.vEff[0], 99999, "pass-through: corrupt vEff[0] passes through");
    assertEq(out.seq, 2n, "pass-through: corrupt B's seq passes through");
  }

  // ── Custom callback — receives (out, computed, stored), can mutate. ─────
  {
    const schema = makeInvariantSchema();
    const { sab, capacity } = SpscRing.allocate(16, schema);
    const ring = new SpscRing(sab, capacity, schema);
    const producer = new BridgeProducer(ring);
    let callbackCount = 0;
    let lastComputed = 0;
    let lastStored = 0;
    const consumer = new BridgeConsumer(ring, {
      onInvariantFailure: (out, computed, stored) => {
        callbackCount++;
        lastComputed = computed;
        lastStored = stored;
        // Sentinel: callback writes a marker into out so we can confirm it ran.
        (out as { seq: bigint }).seq = 9999n;
      },
    });
    const out = emptyInvFrame();

    producer.push(makeInvFrame(1, [1, 2, 3, 4]));
    assertEq(consumer.pull(out), true, "callback policy: ok pull A");
    assertEq(callbackCount, 0, "callback not invoked on ok pull");

    producer.push(makeInvFrame(2, [10, 20, 30, 40]));
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
    f64View[1 * 6 + 1] = 99999;
    assertEq(consumer.pull(out), true, "callback policy: pull on corrupt B");
    assertEq(callbackCount, 1, "callback invoked exactly once on hard error");
    assert(lastComputed !== lastStored, "callback receives differing computed/stored");
    assertEq(out.seq, 9999n, "callback's mutation of out is visible");
    assertEq(consumer.tornFrameCount(), 1, "callback policy: tornFrames still increments");
  }

  ok("facade-invariant-policies");
}

// ── 5. BridgeConsumer.telemetry() symmetry with Bridge<S>.telemetry() ────
//
// 0.9.35 patch. The new `BridgeConsumer.telemetry()` mirrors
// `Bridge<S>.telemetry()`'s field-for-field shape. Driven through the
// same producer/consumer/PLL/smoother sequence, both snapshots must
// be identical — that's the regression backstop against future drift
// in either implementation. Includes a soft-invariant sub-pin
// verifying the new `BridgeConsumer._softFrames` counter ticks in
// lock-step with `Bridge._softFrames`.
function testTelemetrySnapshotSymmetry(): void {
  // ── Phase A — no-invariant schema, healthy traffic ──────────────────────
  {
    const n = 4;
    const schema = physicsControlFrameSchema(n);
    const cap = 8;
    const sabRef = new SharedArrayBuffer(SpscRing.byteLength(cap, schema));
    const sabFac = new SharedArrayBuffer(SpscRing.byteLength(cap, schema));
    const refBridge = new Bridge(sabRef, cap, schema);
    const facRing = new SpscRing(sabFac, cap, schema);
    const facProducer = new BridgeProducer(facRing);
    const facConsumer = new BridgeConsumer(facRing);

    const outRef = emptyPhysFrame(n);
    const outFac = emptyPhysFrame(n);

    // Identical traffic on both sides:
    //   - 6 pushes
    //   - 2 raw pulls
    //   - fill again with 4 pushes (one will be dropped under default reject)
    //   - 3 smoothed pulls (some with skipped > 0)
    //   - 5 PLL observations
    for (let i = 1; i <= 6; i++) {
      refBridge.push(makePhysFrame(i, n));
      facProducer.push(makePhysFrame(i, n));
    }
    for (let i = 0; i < 2; i++) {
      refBridge.pull(outRef);
      facConsumer.pull(outFac);
    }
    for (let i = 7; i <= 10; i++) {
      refBridge.push(makePhysFrame(i, n));
      facProducer.push(makePhysFrame(i, n));
    }
    for (let i = 0; i < 3; i++) {
      refBridge.pullLatestSmoothed(outRef, 0.5);
      facConsumer.pullLatestSmoothed(outFac, 0.5);
    }
    for (let i = 0; i < 5; i++) {
      const cNs = 1_000_000_000 + i * 16_666_667;
      const pNs = cNs + 1_500_000_000;
      refBridge.observeConsumerTime(cNs, pNs);
      facConsumer.observeConsumerTime(cNs, pNs);
    }

    const refSnap = refBridge.telemetry();
    const facSnap = facConsumer.telemetry();

    // Field-for-field equality. Iterating the keys means a future
    // additive TelemetrySnapshot field automatically gets compared
    // without touching this pin.
    const fields = Object.keys(refSnap) as Array<keyof typeof refSnap>;
    for (const k of fields) {
      assertEq(
        facSnap[k],
        refSnap[k],
        `Phase A: telemetry().${String(k)} matches`,
      );
    }
    // Sanity floor — the test would still pass with both at default
    // zeros if the snapshot constructors were both broken. The pull
    // count is 2 raw + 1 smoothed = 3: the 2nd and 3rd
    // pullLatestSmoothed find the ring empty after the 1st drained it
    // to the newest (skipped=N), so they return -1 and don't increment
    // pulledFrames.
    assertEq(refSnap.pushedFrames, 10, "Phase A: 10 successful pushes");
    assertEq(refSnap.pulledFrames, 3, "Phase A: 3 successful pulls (2 raw + 1 smoothed)");
    assertEq(refSnap.pllLocked, true, "Phase A: PLL locked after observations");
  }

  // ── Phase B — invariant schema, exercise soft + hard branches ───────────
  //
  // Verifies the new BridgeConsumer._softFrames counter (added in 0.9.35
  // alongside telemetry()) ticks in lock-step with Bridge<S>._softFrames.
  // Pre-0.9.35, BridgeConsumer didn't track softFrames at all; this pin
  // would catch any regression that drops the counter or miscounts the
  // soft branch's invocations.
  {
    const schema = makeInvariantSchema();
    const cap = 16;
    const sabRef = new SharedArrayBuffer(SpscRing.byteLength(cap, schema));
    const sabFac = new SharedArrayBuffer(SpscRing.byteLength(cap, schema));
    const refBridge = new Bridge(sabRef, cap, schema);
    const facRing = new SpscRing(sabFac, cap, schema);
    const facProducer = new BridgeProducer(facRing);
    const facConsumer = new BridgeConsumer(facRing);

    const outRef = emptyInvFrame();
    const outFac = emptyInvFrame();

    // Seed with an OK frame on both rings.
    const A = makeInvFrame(1, [10, 20, 30, 40]); // sum_sq = 100+400+900+1600 = 3000
    refBridge.push(A);
    facProducer.push(A);
    refBridge.pull(outRef);
    facConsumer.pull(outFac);
    // Both sides: softFrames=0, tornFrames=0.

    // Push frame B, then corrupt vEff[0]: 10 → 11. New sum_sq = 121+400+900+1600 = 3021.
    // absErr = 21, delta = 21/3000 = 0.007.
    //   ok threshold: 1e-3 * 3000 = 3 → 21 > 3 (not ok)
    //   soft threshold: 1.0 * 3000 = 3000 → 21 < 3000 (soft, not hard)
    // Both Bridge<S> and BridgeConsumer must classify identically and
    // tick their respective softFrames counters by 1.
    const B = makeInvFrame(2, [10, 20, 30, 40]);
    refBridge.push(B);
    facProducer.push(B);
    // Corrupt slot 1's vEff[0] in both SABs identically. Schema layout:
    // seq:u64 + vEff:f64Array(4) + __invariant:f64; stride8 = 6 elements;
    // vEff[0] is f64-off 1.
    const refView = new Float64Array(sabRef, RING_HEADER_BYTES, cap * 6);
    const facView = new Float64Array(sabFac, RING_HEADER_BYTES, cap * 6);
    refView[1 * 6 + 1] = 11;
    facView[1 * 6 + 1] = 11;

    assertEq(refBridge.pull(outRef), true, "Phase B: ref pull on soft-corrupt B");
    assertEq(facConsumer.pull(outFac), true, "Phase B: fac pull on soft-corrupt B");

    // softFrames must have ticked by exactly 1 on both sides. tornFrames
    // must stay at 0 (soft, not hard).
    assertEq(refBridge.telemetry().softFrames, 1, "Phase B: ref softFrames=1");
    assertEq(facConsumer.telemetry().softFrames, 1, "Phase B: fac softFrames=1 (parity)");
    assertEq(refBridge.telemetry().tornFrames, 0, "Phase B: ref tornFrames stays 0 on soft");
    assertEq(facConsumer.telemetry().tornFrames, 0, "Phase B: fac tornFrames stays 0 on soft");

    // Now push frame C, corrupt vEff[0] to a huge value — hard branch.
    // tornFrames ticks; softFrames stays where it was.
    const C = makeInvFrame(3, [10, 20, 30, 40]);
    refBridge.push(C);
    facProducer.push(C);
    refView[2 * 6 + 1] = 99999;
    facView[2 * 6 + 1] = 99999;

    refBridge.pull(outRef);
    facConsumer.pull(outFac);

    assertEq(refBridge.telemetry().tornFrames, 1, "Phase B: ref tornFrames=1 after hard");
    assertEq(facConsumer.telemetry().tornFrames, 1, "Phase B: fac tornFrames=1 (parity)");
    assertEq(refBridge.telemetry().softFrames, 1, "Phase B: ref softFrames stays 1 on hard");
    assertEq(facConsumer.telemetry().softFrames, 1, "Phase B: fac softFrames stays 1 on hard");

    // Final field-for-field cross-check.
    const refSnap = refBridge.telemetry();
    const facSnap = facConsumer.telemetry();
    const fields = Object.keys(refSnap) as Array<keyof typeof refSnap>;
    for (const k of fields) {
      assertEq(
        facSnap[k],
        refSnap[k],
        `Phase B: telemetry().${String(k)} matches`,
      );
    }
  }

  // ── Phase C — opted-out PLL (pll: null) returns zero PLL fields ────────
  //
  // The 0.9.35 telemetry() implementation must handle the pll: null
  // case explicitly — returning false / 0 for the four PLL fields plus
  // stallRecoveries. Verify by constructing a consumer with no PLL and
  // confirming the snapshot is well-formed (no NaN / undefined leaks
  // through the union narrowing).
  {
    const n = 4;
    const schema = physicsControlFrameSchema(n);
    const cap = 8;
    const sab = new SharedArrayBuffer(SpscRing.byteLength(cap, schema));
    const ring = new SpscRing(sab, cap, schema);
    const consumer = new BridgeConsumer(ring, { pll: null });
    const snap = consumer.telemetry();
    assertEq(snap.pllLocked, false, "pll:null → pllLocked false");
    assertEq(snap.pllOffsetNs, 0, "pll:null → pllOffsetNs 0");
    assertEq(snap.pllOutliersRejected, 0, "pll:null → pllOutliersRejected 0");
    assertEq(snap.pllDriftPpm, 0, "pll:null → pllDriftPpm 0");
    assertEq(snap.stallRecoveries, 0, "pll:null → stallRecoveries 0");
    // Ring-side fields still populate normally.
    assertEq(snap.capacity, cap, "pll:null → capacity still reported");
  }

  ok("facade-telemetry-symmetry");
}

function main(): void {
  testFacadeConstructionDefaults();
  testFacadeRoundTrip();
  testFacadeSymmetryWithBridge();
  testFacadeInvariantPolicies();
  testTelemetrySnapshotSymmetry();
  console.log("\nAll BridgeFacades tests passed.");
}

main();
