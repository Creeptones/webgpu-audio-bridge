/**
 * BridgeInputLane — pins for the 0.6.19 event-queue facade.
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/BridgeInputLane.test.ts
 *
 * Pins:
 *   1. Construction + scratchFrame / scratchEventBuffer shape.
 *   2. Empty pullAll returns 0 with no buffer mutation.
 *   3. Single push → pullAll drains 1; available() agrees pre/post.
 *   4. N pushes → pullAll drains all N in FIFO order; second pullAll
 *      returns 0.
 *   5. pullAll respects eventBuf.length cap — buffered overflow stays
 *      in the ring and surfaces on the next call.
 *   6. pullAll respects explicit maxCount cap independent of buffer length.
 *   7. Cross-facade interop: a BridgeProducer peer pushes; BridgeInputLane
 *      drains. The reverse: BridgeInputLane pushes, BridgeConsumer drains.
 *   8. scratchEventBuffer argument validation.
 *   9. pullAll argument validation (non-array, sparse-array slot).
 */

import { assert, assertEq, ok } from "./_assert.js";
import { SpscRing } from "../src/SpscRing.js";
import { BridgeInputLane } from "../src/BridgeInputLane.js";
import { BridgeProducer } from "../src/BridgeProducer.js";
import { BridgeConsumer } from "../src/BridgeConsumer.js";
import {
  defineSchema,
  f32,
  u32,
  u64,
  type FrameFor,
} from "../src/schema.js";

// Canonical MIDI-shaped event schema for the input-lane pattern. Mirror of
// the example in README.md §Achieving pro-audio tracking latency.
function makeInputEventSchema() {
  return defineSchema({
    seq:        u64(),
    tInputNs:   u64(),
    eventType:  u32(), // 0=note-on 1=note-off 2=cc 3=paramSet
    noteOrCc:   u32(),
    velocityI:  u32(),
    value:      f32(),
  });
}

type InputEventFrame = FrameFor<ReturnType<typeof makeInputEventSchema>>;

function makeEvent(
  seq: number,
  tInputNs: bigint,
  eventType: number,
  noteOrCc: number,
  velocityI: number,
  value: number,
): InputEventFrame {
  return {
    seq: BigInt(seq),
    tInputNs,
    eventType,
    noteOrCc,
    velocityI,
    value,
  };
}

function makeRing(capacity: number) {
  const schema = makeInputEventSchema();
  const { sab } = SpscRing.allocate(capacity, schema);
  return { ring: new SpscRing(sab, capacity, schema), schema, sab };
}

// ── 1. Construction + scratch shapes ──────────────────────────────────────
function testConstructionAndScratch(): void {
  const { ring, schema } = makeRing(8);
  const lane = new BridgeInputLane(ring);
  assertEq(lane.ring, ring, "lane exposes ring");
  assertEq(lane.schema, schema, "lane exposes schema");
  assertEq(lane.capacity, 8, "lane exposes capacity");

  const f = lane.scratchFrame();
  assertEq(typeof f.eventType, "number", "scratchFrame.eventType is number");
  assertEq(typeof f.value, "number", "scratchFrame.value is number");
  assertEq(f.seq, 0n, "scratchFrame.seq initialized to 0n");
  assertEq(f.tInputNs, 0n, "scratchFrame.tInputNs initialized to 0n");

  const buf = lane.scratchEventBuffer(4);
  assertEq(buf.length, 4, "scratchEventBuffer length matches");
  for (let i = 0; i < buf.length; i++) {
    assertEq(buf[i]!.seq, 0n, `eventBuf[${i}].seq initialized`);
    // Each slot must be a distinct object so writes to buf[0] don't alias buf[1].
    if (i > 0) {
      assert(buf[i] !== buf[i - 1], `eventBuf[${i}] is distinct from ${i - 1}`);
    }
  }

  ok("construction-and-scratch");
}

// ── 2. Empty pullAll returns 0 ────────────────────────────────────────────
function testEmptyPullAll(): void {
  const { ring } = makeRing(8);
  const lane = new BridgeInputLane(ring);
  const buf = lane.scratchEventBuffer(4);
  // Mutate one slot so we can confirm pullAll didn't touch it.
  buf[0]!.seq = 42n;
  buf[0]!.value = 3.14;

  assertEq(lane.pullAll(buf), 0, "empty pullAll returns 0");
  assertEq(buf[0]!.seq, 42n, "buf[0].seq untouched on empty pull");
  assertEq(buf[0]!.value, 3.14, "buf[0].value untouched on empty pull");
  assertEq(lane.available(), 0, "available() still 0");

  ok("empty-pullAll-returns-zero");
}

// ── 3. Single push → pullAll drains 1 ─────────────────────────────────────
function testSinglePushPullAll(): void {
  const { ring } = makeRing(8);
  const lane = new BridgeInputLane(ring);
  const buf = lane.scratchEventBuffer(4);

  const ok1 = lane.push(makeEvent(1, 12345n, 0, 60, 100, 0.787));
  assertEq(ok1, true, "single push returns true");
  assertEq(lane.available(), 1, "available() shows 1 buffered");

  const count = lane.pullAll(buf);
  assertEq(count, 1, "pullAll drains 1");
  assertEq(buf[0]!.seq, 1n, "buf[0].seq = 1");
  assertEq(buf[0]!.tInputNs, 12345n, "buf[0].tInputNs");
  assertEq(buf[0]!.eventType, 0, "buf[0].eventType");
  assertEq(buf[0]!.noteOrCc, 60, "buf[0].noteOrCc");
  assertEq(buf[0]!.velocityI, 100, "buf[0].velocityI");
  // f32 quantization: 0.787 is not exactly representable.
  assert(Math.abs(buf[0]!.value - 0.787) < 1e-4, "buf[0].value within f32 epsilon");

  assertEq(lane.available(), 0, "available() drains to 0");
  assertEq(lane.pullAll(buf), 0, "second pullAll returns 0");

  ok("single-push-pullAll-drains-one");
}

// ── 4. N pushes → pullAll drains N in FIFO order ──────────────────────────
function testManyPushFifo(): void {
  const { ring } = makeRing(16);
  const lane = new BridgeInputLane(ring);
  const buf = lane.scratchEventBuffer(16);

  const N = 7;
  for (let i = 0; i < N; i++) {
    assertEq(
      lane.push(makeEvent(i + 100, BigInt(i + 100) * 1_000_000n, i % 4, 60 + i, 100 - i, i * 0.125)),
      true,
      `push #${i}`,
    );
  }
  assertEq(lane.available(), N, `available() = ${N}`);

  const count = lane.pullAll(buf);
  assertEq(count, N, `pullAll drains ${N}`);
  for (let i = 0; i < N; i++) {
    assertEq(buf[i]!.seq, BigInt(i + 100), `FIFO order seq #${i}`);
    assertEq(buf[i]!.tInputNs, BigInt(i + 100) * 1_000_000n, `FIFO order tInputNs #${i}`);
    assertEq(buf[i]!.noteOrCc, 60 + i, `FIFO order noteOrCc #${i}`);
  }
  assertEq(lane.available(), 0, "drained empty");
  assertEq(lane.pullAll(buf), 0, "second drain returns 0");

  ok("many-push-pullAll-fifo");
}

// ── 5. pullAll respects eventBuf.length cap ───────────────────────────────
function testPullAllRespectsBufferCap(): void {
  const { ring } = makeRing(16);
  const lane = new BridgeInputLane(ring);

  // Push 10, drain into a 4-event buffer.
  for (let i = 0; i < 10; i++) lane.push(makeEvent(i + 1, BigInt(i + 1), 0, i, i, 0));
  assertEq(lane.available(), 10, "10 events buffered");

  const buf4 = lane.scratchEventBuffer(4);
  assertEq(lane.pullAll(buf4), 4, "first pullAll drains 4 (buffer cap)");
  for (let i = 0; i < 4; i++) {
    assertEq(buf4[i]!.seq, BigInt(i + 1), `first chunk seq[${i}]`);
  }
  assertEq(lane.available(), 6, "6 events remain after capped drain");

  assertEq(lane.pullAll(buf4), 4, "second pullAll drains 4 more");
  for (let i = 0; i < 4; i++) {
    assertEq(buf4[i]!.seq, BigInt(i + 5), `second chunk seq[${i}] (5..8)`);
  }
  assertEq(lane.available(), 2, "2 events remain");

  assertEq(lane.pullAll(buf4), 2, "third pullAll drains remaining 2");
  assertEq(buf4[0]!.seq, 9n, "third chunk seq[0] = 9");
  assertEq(buf4[1]!.seq, 10n, "third chunk seq[1] = 10");
  assertEq(lane.available(), 0, "fully drained");

  ok("pullAll-respects-buffer-cap");
}

// ── 6. pullAll respects explicit maxCount cap ─────────────────────────────
function testPullAllRespectsMaxCount(): void {
  const { ring } = makeRing(16);
  const lane = new BridgeInputLane(ring);

  for (let i = 0; i < 8; i++) lane.push(makeEvent(i + 1, BigInt(i + 1), 0, i, i, 0));

  const buf = lane.scratchEventBuffer(16);   // buffer is big enough for all
  assertEq(lane.pullAll(buf, 3), 3, "maxCount=3 caps the drain");
  for (let i = 0; i < 3; i++) {
    assertEq(buf[i]!.seq, BigInt(i + 1), `time-sliced chunk seq[${i}]`);
  }
  assertEq(lane.available(), 5, "remaining 5 events stay in ring");

  // maxCount=0 returns 0, no drain.
  assertEq(lane.pullAll(buf, 0), 0, "maxCount=0 is a no-op");
  assertEq(lane.available(), 5, "no-op leaves ring untouched");

  // maxCount larger than buffer is clamped to buffer length.
  const buf2 = lane.scratchEventBuffer(2);
  assertEq(lane.pullAll(buf2, 999), 2, "maxCount > buf.length is clamped");
  assertEq(buf2[0]!.seq, 4n, "post-clamp seq[0] = 4");
  assertEq(buf2[1]!.seq, 5n, "post-clamp seq[1] = 5");

  ok("pullAll-respects-maxCount");
}

// ── 7. Cross-facade interop with BridgeProducer / BridgeConsumer ──────────
function testCrossFacadeInterop(): void {
  const { ring } = makeRing(16);

  // Phase A: BridgeProducer pushes, BridgeInputLane drains.
  const producer = new BridgeProducer(ring);
  const laneA = new BridgeInputLane(ring);
  const pushFrame = producer.scratchFrame();
  for (let i = 0; i < 4; i++) {
    pushFrame.seq = BigInt(i + 50);
    pushFrame.tInputNs = BigInt(i + 50) * 1000n;
    pushFrame.eventType = 2; // cc
    pushFrame.noteOrCc = 10 + i;
    pushFrame.velocityI = 0;
    pushFrame.value = (i + 1) * 0.25;
    assertEq(producer.push(pushFrame), true, `producer.push #${i}`);
  }
  const bufA = laneA.scratchEventBuffer(8);
  assertEq(laneA.pullAll(bufA), 4, "lane.pullAll drains producer pushes");
  for (let i = 0; i < 4; i++) {
    assertEq(bufA[i]!.seq, BigInt(i + 50), `phase-A seq #${i}`);
    assertEq(bufA[i]!.noteOrCc, 10 + i, `phase-A noteOrCc #${i}`);
  }

  // Phase B: BridgeInputLane pushes, BridgeConsumer drains.
  // Same ring is fine — SPSC singularity is at the ring level; switching
  // which facade we use to call the SAME side is just a method-dispatch
  // change. pullAll already drained everything, so the ring is empty.
  const consumer = new BridgeConsumer(ring);
  for (let i = 0; i < 3; i++) {
    assertEq(
      laneA.push(makeEvent(i + 200, BigInt(i + 200) * 1000n, 3, 0, 0, i * 0.1)),
      true,
      `lane.push #${i}`,
    );
  }
  const outFrame = consumer.scratchFrame();
  for (let i = 0; i < 3; i++) {
    assertEq(consumer.pull(outFrame), true, `consumer.pull #${i}`);
    assertEq(outFrame.seq, BigInt(i + 200), `phase-B seq #${i}`);
  }

  ok("cross-facade-interop");
}

// ── 8. scratchEventBuffer argument validation ─────────────────────────────
function testScratchEventBufferValidation(): void {
  const { ring } = makeRing(8);
  const lane = new BridgeInputLane(ring);

  let threw = false;
  try { lane.scratchEventBuffer(0); } catch { threw = true; }
  assert(threw, "scratchEventBuffer(0) throws");

  threw = false;
  try { lane.scratchEventBuffer(-1); } catch { threw = true; }
  assert(threw, "scratchEventBuffer(-1) throws");

  threw = false;
  try { lane.scratchEventBuffer(1.5); } catch { threw = true; }
  assert(threw, "scratchEventBuffer(1.5) throws");

  threw = false;
  try { lane.scratchEventBuffer(NaN); } catch { threw = true; }
  assert(threw, "scratchEventBuffer(NaN) throws");

  ok("scratchEventBuffer-validation");
}

// ── 9. pullAll argument validation ────────────────────────────────────────
function testPullAllValidation(): void {
  const { ring } = makeRing(8);
  const lane = new BridgeInputLane(ring);

  let threw = false;
  try { lane.pullAll(null as unknown as InputEventFrame[]); } catch { threw = true; }
  assert(threw, "pullAll(null) throws");

  threw = false;
  try { lane.pullAll("not an array" as unknown as InputEventFrame[]); } catch { threw = true; }
  assert(threw, "pullAll('string') throws");

  // Sparse array: lane.push something so pullAll actually walks past index 0.
  lane.push(makeEvent(1, 0n, 0, 0, 0, 0));
  lane.push(makeEvent(2, 0n, 0, 0, 0, 0));
  const sparse: InputEventFrame[] = new Array(4); // all undefined slots
  sparse[0] = lane.scratchFrame();
  // sparse[1] is intentionally undefined.
  threw = false;
  try { lane.pullAll(sparse); } catch (e) {
    threw = true;
    assert(String(e).includes("undefined"), "sparse-slot error mentions undefined");
  }
  assert(threw, "pullAll on sparse array throws on first undefined slot");

  ok("pullAll-validation");
}

function main(): void {
  testConstructionAndScratch();
  testEmptyPullAll();
  testSinglePushPullAll();
  testManyPushFifo();
  testPullAllRespectsBufferCap();
  testPullAllRespectsMaxCount();
  testCrossFacadeInterop();
  testScratchEventBufferValidation();
  testPullAllValidation();
  console.log("\nBridgeInputLane: all pins passed.");
}

main();
