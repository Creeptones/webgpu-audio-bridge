/**
 * MessageChannelBridge — pins for the 0.9.40 Standard-mode MVP1.
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/MessageChannelBridge.test.ts
 *
 * MVP1 pins (transport-only parity with Bridge<S>):
 *
 *   1. Construction validation: capacity must be a positive integer;
 *      schemas with `.withInvariant(...)` are rejected at construction.
 *
 *   2. Allocate static factory returns two ports + capacity; the ports
 *      are MessagePort instances; capacity round-trips.
 *
 *   3. scratchFrame produces a fresh frame of the expected shape
 *      (scalar fields zero-initialized, array fields as typed arrays
 *      of the right kind and length).
 *
 *   4. describeLayout returns the same shape as Bridge<S>.describeLayout
 *      for the same schema (field offsets, kinds, lengths, trajectory
 *      metadata all field-for-field equal).
 *
 *   5. push/pull round-trip across the channel for a scalar-only schema:
 *      every scalar kind (u64/i64/u32/i32/u16/i16/u8/i8/f64/f32)
 *      round-trips bit-exact.
 *
 *   6. push/pull round-trip for a schema with array fields: typed-array
 *      contents round-trip bit-exact via the transferable ArrayBuffer.
 *
 *   7. Capacity respect under burst: producer pushes N > capacity frames
 *      back-to-back; consumer-side queue caps at capacity and drops the
 *      oldest excess; droppedCount() reflects the drop count;
 *      survived frames are the freshest ones.
 *
 *   8. Pull-from-empty returns false; available() reports queue depth
 *      accurately as pulls drain it.
 *
 *   9. close() is idempotent; subsequent push returns false; subsequent
 *      pull returns false; queue is cleared.
 *
 * The cross-Worker pin from the design note's playbook is folded into
 * the existing pin 5/6 by using paired ports on the same thread — same
 * MessagePort transport contract, no actual Worker required. A future
 * pin can add a real Worker test if cross-thread regressions surface.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { MessageChannelBridge } from "../src/MessageChannelBridge.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f32,
  f32Array,
  f64,
  f64Array,
  i8,
  i16,
  i32,
  i64,
  u8,
  u16,
  u32,
  u64,
} from "../src/schema.js";

// ─── Schemas used across pins ────────────────────────────────────────────

const everyScalarSchema = defineSchema({
  myU64: u64(),
  myI64: i64(),
  myU32: u32(),
  myI32: i32(),
  myU16: u16(),
  myI16: i16(),
  myU8: u8(),
  myI8: i8(),
  myF64: f64(),
  myF32: f32(),
});

const arraySchema = defineSchema({
  seq: u64(),
  vMax: f64(),
  vEff: f64Array(8),
  jEff: f32Array(8),
  flags: u32(),
});

const tinySchema = defineSchema({
  seq: u64(),
  value: f64(),
});

const tinyWithInvariant = defineSchema({
  seq: u64(),
  value: f64(),
}).withInvariant((frame) => {
  return Number(frame.seq) + frame.value;
});

// ─── Pin 1: construction validation ─────────────────────────────────────

function testConstructionValidation() {
  const ch = new MessageChannel();

  // Capacity must be a positive integer.
  let threw = false;
  try {
    new MessageChannelBridge(ch.port1, 0, tinySchema);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, "capacity=0 must throw RangeError");

  threw = false;
  try {
    new MessageChannelBridge(ch.port1, -1, tinySchema);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, "capacity=-1 must throw RangeError");

  threw = false;
  try {
    new MessageChannelBridge(ch.port1, 1.5, tinySchema);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, "capacity=1.5 must throw RangeError");

  // Schemas with .withInvariant are rejected.
  const ch2 = new MessageChannel();
  threw = false;
  try {
    new MessageChannelBridge(ch2.port1, 4, tinyWithInvariant);
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assert(threw, "schema with .withInvariant must throw TypeError");

  // Static allocate: same validation.
  threw = false;
  try {
    MessageChannelBridge.allocate(0);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, "allocate(0) must throw RangeError");

  ok("1. construction validation: capacity + invariant rejection");
}

// ─── Pin 2: static allocate ─────────────────────────────────────────────

function testAllocate() {
  const alloc = MessageChannelBridge.allocate(16);
  assert(
    typeof alloc.port1.postMessage === "function",
    "allocate().port1 has postMessage",
  );
  assert(
    typeof alloc.port2.postMessage === "function",
    "allocate().port2 has postMessage",
  );
  assertEq(alloc.capacity, 16, "allocate() round-trips capacity");
  assert(Object.isFrozen(alloc), "allocation is frozen");

  ok("2. allocate() returns two MessagePort instances + capacity");
}

// ─── Pin 3: scratchFrame ────────────────────────────────────────────────

function testScratchFrame() {
  const ch = new MessageChannel();
  const bridge = new MessageChannelBridge(ch.port1, 4, arraySchema);
  const frame = bridge.scratchFrame();

  assertEq(frame.seq, 0n, "scratchFrame: u64 → 0n");
  assertEq(frame.vMax, 0, "scratchFrame: f64 → 0");
  assertEq(frame.flags, 0, "scratchFrame: u32 → 0");
  assert(frame.vEff instanceof Float64Array, "scratchFrame: f64Array typed");
  assertEq(frame.vEff.length, 8, "scratchFrame: f64Array length");
  assert(frame.jEff instanceof Float32Array, "scratchFrame: f32Array typed");
  assertEq(frame.jEff.length, 8, "scratchFrame: f32Array length");

  // Each call returns a fresh frame.
  const frame2 = bridge.scratchFrame();
  assert(frame.vEff !== frame2.vEff, "scratchFrame returns independent arrays");

  bridge.close();
  ok("3. scratchFrame: scalar/array shape + per-call freshness");
}

// ─── Pin 4: describeLayout symmetry with Bridge<S> ──────────────────────

function testDescribeLayoutSymmetry() {
  // Build a MessageChannelBridge and a Turbo-mode Bridge over the SAME
  // schema. describeLayout() from each must be field-for-field equal.
  const ch = new MessageChannel();
  const mcBridge = new MessageChannelBridge(ch.port1, 4, arraySchema);

  const alloc = Bridge.allocate(4, arraySchema);
  const turboBridge = new Bridge(alloc.sab, alloc.capacity, arraySchema);

  const mcLayout = mcBridge.describeLayout();
  const turboLayout = turboBridge.describeLayout();

  assertEq(mcLayout.headerBytes, turboLayout.headerBytes, "headerBytes match");
  assertEq(
    mcLayout.frameByteSize,
    turboLayout.frameByteSize,
    "frameByteSize match",
  );
  assertEq(
    Object.keys(mcLayout.fields).length,
    Object.keys(turboLayout.fields).length,
    "field count matches",
  );
  for (const name of Object.keys(mcLayout.fields) as (keyof typeof mcLayout.fields)[]) {
    const a = mcLayout.fields[name];
    const b = turboLayout.fields[name];
    assert(a !== undefined && b !== undefined, `field ${String(name)} exists in both`);
    assertEq(a.kind, b.kind, `field ${String(name)} kind matches`);
    assertEq(a.byteOffset, b.byteOffset, `field ${String(name)} byteOffset matches`);
    const aLen = "length" in a ? a.length : undefined;
    const bLen = "length" in b ? b.length : undefined;
    assertEq(aLen, bLen, `field ${String(name)} length matches`);
  }

  mcBridge.close();
  ok("4. describeLayout symmetry MessageChannelBridge vs Bridge");
}

// ─── Helpers for async push/pull pins ───────────────────────────────────

async function flushMicrotasks(): Promise<void> {
  // MessageChannel delivery happens on the event loop turn. setImmediate
  // chained twice handles edge cases where the first tick races the
  // message-delivery scheduling, especially under tsx + node20 on
  // Windows. setTimeout(0) is the universal fallback.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Pin 5: all-scalar round-trip ───────────────────────────────────────

async function testAllScalarRoundTrip() {
  const { port1, port2, capacity } = MessageChannelBridge.allocate(4);
  const producer = new MessageChannelBridge(port1, capacity, everyScalarSchema);
  const consumer = new MessageChannelBridge(port2, capacity, everyScalarSchema);

  const src = producer.scratchFrame();
  src.myU64 = 0x0123456789abcdefn;
  src.myI64 = -0x0123456789abcdefn;
  src.myU32 = 0xfedcba98;
  src.myI32 = -0x7fedcba9;
  src.myU16 = 0xbeef;
  src.myI16 = -0x7eed;
  src.myU8 = 0xa5;
  src.myI8 = -0x42;
  src.myF64 = Math.PI;
  src.myF32 = Math.fround(Math.E);

  assert(producer.push(src), "push returns true");
  assertEq(producer.pushedCount(), 1, "pushedCount tick");

  await flushMicrotasks();

  const dst = consumer.scratchFrame();
  assert(consumer.pull(dst), "pull returns true");
  assertEq(consumer.pulledCount(), 1, "pulledCount tick");

  assertEq(dst.myU64, src.myU64, "u64 round-trip");
  assertEq(dst.myI64, src.myI64, "i64 round-trip");
  assertEq(dst.myU32, src.myU32, "u32 round-trip");
  assertEq(dst.myI32, src.myI32, "i32 round-trip");
  assertEq(dst.myU16, src.myU16, "u16 round-trip");
  assertEq(dst.myI16, src.myI16, "i16 round-trip");
  assertEq(dst.myU8, src.myU8, "u8 round-trip");
  assertEq(dst.myI8, src.myI8, "i8 round-trip");
  assertEq(dst.myF64, src.myF64, "f64 round-trip");
  assertEq(dst.myF32, src.myF32, "f32 round-trip");

  producer.close();
  consumer.close();
  ok("5. all-scalar push/pull round-trip bit-exact");
}

// ─── Pin 6: array-field round-trip ──────────────────────────────────────

async function testArrayFieldRoundTrip() {
  const { port1, port2, capacity } = MessageChannelBridge.allocate(4);
  const producer = new MessageChannelBridge(port1, capacity, arraySchema);
  const consumer = new MessageChannelBridge(port2, capacity, arraySchema);

  const src = producer.scratchFrame();
  src.seq = 42n;
  src.vMax = 3.14;
  src.flags = 0xdeadbeef;
  for (let i = 0; i < 8; i++) {
    src.vEff[i] = i * 0.5;
    src.jEff[i] = Math.fround(i * 0.25);
  }

  assert(producer.push(src), "push returns true");

  await flushMicrotasks();

  const dst = consumer.scratchFrame();
  assert(consumer.pull(dst), "pull returns true");

  assertEq(dst.seq, src.seq, "u64 seq round-trip");
  assertEq(dst.vMax, src.vMax, "f64 vMax round-trip");
  assertEq(dst.flags, src.flags, "u32 flags round-trip");
  for (let i = 0; i < 8; i++) {
    assertEq(dst.vEff[i], src.vEff[i], `vEff[${i}] round-trip`);
    assertEq(dst.jEff[i], src.jEff[i], `jEff[${i}] round-trip`);
  }

  producer.close();
  consumer.close();
  ok("6. array-field push/pull round-trip bit-exact");
}

// ─── Pin 7: capacity respect under burst ────────────────────────────────

async function testCapacityRespect() {
  const capacity = 4;
  const { port1, port2 } = MessageChannelBridge.allocate(capacity);
  const producer = new MessageChannelBridge(port1, capacity, tinySchema);
  const consumer = new MessageChannelBridge(port2, capacity, tinySchema);

  const src = producer.scratchFrame();
  for (let i = 0; i < 10; i++) {
    src.seq = BigInt(i);
    src.value = i * 1.0;
    assert(producer.push(src), `push #${i} returns true`);
  }
  assertEq(producer.pushedCount(), 10, "pushedCount = 10");

  await flushMicrotasks();

  assertEq(
    consumer.available(),
    capacity,
    `consumer queue capped at capacity=${capacity}`,
  );
  assertEq(
    consumer.droppedCount(),
    10 - capacity,
    `droppedCount = 10 - capacity = ${10 - capacity}`,
  );

  // Surviving frames must be the LATEST capacity frames.
  // First push had seq=0, last had seq=9. Drop-oldest keeps seq=6..9.
  const out = consumer.scratchFrame();
  const seqsRead: bigint[] = [];
  while (consumer.pull(out)) {
    seqsRead.push(out.seq);
  }
  assertEq(seqsRead.length, capacity, `drained ${capacity} survivors`);
  for (let i = 0; i < capacity; i++) {
    const expectedSeq = BigInt(10 - capacity + i);
    assertEq(seqsRead[i], expectedSeq, `survivor #${i} seq = ${expectedSeq}`);
  }

  producer.close();
  consumer.close();
  ok("7. capacity respect: drop-oldest under burst keeps freshest frames");
}

// ─── Pin 8: empty-pull semantics + available() accuracy ─────────────────

async function testEmptyAndAvailable() {
  const { port1, port2, capacity } = MessageChannelBridge.allocate(4);
  const producer = new MessageChannelBridge(port1, capacity, tinySchema);
  const consumer = new MessageChannelBridge(port2, capacity, tinySchema);

  const out = consumer.scratchFrame();
  assertEq(consumer.pull(out), false, "empty pull returns false");
  assertEq(consumer.available(), 0, "empty available = 0");

  const src = producer.scratchFrame();
  for (let i = 0; i < 3; i++) {
    src.seq = BigInt(i);
    src.value = i * 1.0;
    producer.push(src);
  }
  await flushMicrotasks();
  assertEq(consumer.available(), 3, "available = 3 after burst");

  assert(consumer.pull(out), "pull 1 returns true");
  assertEq(consumer.available(), 2, "available = 2 after one pull");
  assert(consumer.pull(out), "pull 2 returns true");
  assertEq(consumer.available(), 1, "available = 1 after two pulls");
  assert(consumer.pull(out), "pull 3 returns true");
  assertEq(consumer.available(), 0, "available = 0 after draining");
  assertEq(consumer.pull(out), false, "next pull returns false");

  producer.close();
  consumer.close();
  ok("8. empty-pull + available() accuracy across drain");
}

// ─── Pin 9: close() lifecycle ───────────────────────────────────────────

async function testCloseLifecycle() {
  const { port1, port2, capacity } = MessageChannelBridge.allocate(4);
  const producer = new MessageChannelBridge(port1, capacity, tinySchema);
  const consumer = new MessageChannelBridge(port2, capacity, tinySchema);

  const src = producer.scratchFrame();
  src.seq = 1n;
  src.value = 1.0;
  producer.push(src);
  await flushMicrotasks();

  assertEq(consumer.available(), 1, "frame queued pre-close");

  consumer.close();
  assertEq(consumer.available(), 0, "queue cleared on close");
  const out = consumer.scratchFrame();
  assertEq(consumer.pull(out), false, "post-close pull returns false");

  producer.close();
  src.seq = 2n;
  assertEq(producer.push(src), false, "post-close push returns false");

  // Idempotent close
  producer.close();
  consumer.close();

  ok("9. close() lifecycle: idempotent, push/pull return false after close");
}

// ─── Test runner ─────────────────────────────────────────────────────────

async function main() {
  testConstructionValidation();
  testAllocate();
  testScratchFrame();
  testDescribeLayoutSymmetry();
  await testAllScalarRoundTrip();
  await testArrayFieldRoundTrip();
  await testCapacityRespect();
  await testEmptyAndAvailable();
  await testCloseLifecycle();
  console.log("\nAll MessageChannelBridge tests passed.");
}

main().catch((e) => {
  console.error("MessageChannelBridge tests failed:", e);
  process.exitCode = 1;
});
