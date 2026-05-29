/**
 * Bridge.pushRaw — zero-decode raw-byte push.
 *
 * Covers `Bridge.pushRaw(src, srcOffset?)` (and its SpscRing core): a single
 * native memcpy of one frame's bytes into the next free slot, publishing with
 * the exact release-store + notify protocol as `push`. Proves the slot bytes
 * are byte-identical to a `push` of the same frame, that all backpressure
 * policies behave identically, that an invariant schema recomputes the lane
 * from the payload (not the source bytes), that source views/offsets slice
 * correctly, and that short sources throw.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.pushRaw.test.ts
 *
 * Pins:
 *  1. testRawBytesIdenticalToPush  — pushRaw slot bytes === push slot bytes;
 *                                     decoded frame round-trips
 *  2. testSourceViewsAndOffset     — ArrayBuffer / typed-array view / DataView
 *                                     inputs + non-zero srcOffset all land equal
 *  3. testShortSourceThrows        — < frameByteSize at offset → RangeError
 *  4. testPolicyParityWithPush     — reject / drop-newest / drop-oldest produce
 *                                     identical results, dropped counts, and
 *                                     surviving frames vs the push path
 *  5. testBlockTimeoutReturnsFalse — 'block' + 0ms timeout on full → false
 *  6. testInvariantRecomputed      — invariant lane recomputed from payload even
 *                                     when the source lane is corrupted; payload
 *                                     bytes are an exact memcpy
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  emptyPhysFrame,
  framesEqual,
  makePhysFrame,
  makeInvariantSchema,
  makeInvFrame,
  emptyInvFrame,
} from "./_bridgeHelpers.js";
import { Bridge, RING_HEADER_BYTES } from "../src/Bridge.js";
import { describeSchemaLayout, type Schema, type FieldsObject } from "../src/schema.js";
import { physicsControlFrameSchema } from "../src/schemas/physics.js";

type BackpressurePolicy = "reject" | "drop-newest" | "drop-oldest" | "block";

/** Encode one frame to a standalone ArrayBuffer by pushing it into a throwaway
 *  bridge and copying the resulting slot bytes — the same byte layout a
 *  GPU-readback buffer would carry. */
function encodeFrameBytes<S extends Schema<FieldsObject, any>>(
  schema: S,
  frame: Parameters<Bridge<S>["push"]>[0],
): ArrayBuffer {
  const alloc = Bridge.allocate(2, schema);
  const b = new Bridge(alloc.sab, alloc.capacity, alloc.schema);
  assert(b.push(frame), "encodeFrameBytes: source push fits");
  const fb = schema.frameByteSize;
  const out = new ArrayBuffer(fb);
  new Uint8Array(out).set(new Uint8Array(alloc.sab, RING_HEADER_BYTES, fb));
  return out;
}

/** Read slot `slot`'s raw bytes out of a bridge allocation. */
function slotBytes(sab: SharedArrayBuffer, slot: number, fb: number): Uint8Array {
  const start = RING_HEADER_BYTES + slot * fb;
  return new Uint8Array(sab.slice(start, start + fb));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── 1. Raw bytes identical to a push of the same frame ─────────────────────
function testRawBytesIdenticalToPush(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const fb = schema.frameByteSize;
  const F = makePhysFrame(7, n);
  const bytes = encodeFrameBytes(schema, F);

  // push path
  const refAlloc = Bridge.allocate(2, schema);
  const ref = new Bridge(refAlloc.sab, refAlloc.capacity, refAlloc.schema);
  assert(ref.push(F), "ref push fits");

  // pushRaw path
  const tgtAlloc = Bridge.allocate(2, schema);
  const tgt = new Bridge(tgtAlloc.sab, tgtAlloc.capacity, tgtAlloc.schema);
  assertEq(tgt.pushRaw(bytes), true, "pushRaw returns true into a free ring");

  assert(
    bytesEqual(slotBytes(tgtAlloc.sab, 0, fb), slotBytes(refAlloc.sab, 0, fb)),
    "pushRaw slot bytes are byte-identical to push slot bytes",
  );
  // The encoded source equals the push encoding (deterministic), and pushRaw
  // copied it verbatim.
  assert(
    bytesEqual(slotBytes(tgtAlloc.sab, 0, fb), new Uint8Array(bytes)),
    "pushRaw is a verbatim memcpy of the source bytes",
  );

  const out = emptyPhysFrame(n);
  assert(tgt.pull(out), "pull after pushRaw succeeds");
  assert(framesEqual(F, out), "decoded pushRaw frame round-trips bit-exactly");
  ok("1 pushRaw lands slot bytes byte-identical to push; decode round-trips");
}

// ── 2. Source views + non-zero srcOffset ──────────────────────────────────
function testSourceViewsAndOffset(): void {
  const n = 3;
  const schema = physicsControlFrameSchema(n);
  const fb = schema.frameByteSize;
  const F = makePhysFrame(11, n);
  const bytes = encodeFrameBytes(schema, F);

  const variants: Array<{ label: string; src: ArrayBuffer | ArrayBufferView; off: number }> = [
    { label: "ArrayBuffer", src: bytes, off: 0 },
    { label: "Uint8Array view", src: new Uint8Array(bytes), off: 0 },
    { label: "DataView", src: new DataView(bytes), off: 0 },
  ];
  // Embed the frame at a non-zero byte offset inside a larger buffer (offset
  // chosen 8-aligned so a Float64 view is constructible too).
  const padded = new ArrayBuffer(fb + 16);
  new Uint8Array(padded).set(new Uint8Array(bytes), 16);
  variants.push({ label: "offset ArrayBuffer", src: padded, off: 16 });
  variants.push({ label: "offset Uint8Array", src: new Uint8Array(padded), off: 16 });

  for (const v of variants) {
    const alloc = Bridge.allocate(2, schema);
    const b = new Bridge(alloc.sab, alloc.capacity, alloc.schema);
    assertEq(b.pushRaw(v.src, v.off), true, `${v.label}: pushRaw returns true`);
    assert(
      bytesEqual(slotBytes(alloc.sab, 0, fb), new Uint8Array(bytes)),
      `${v.label}: slot bytes match the frame`,
    );
    const out = emptyPhysFrame(n);
    assert(b.pull(out), `${v.label}: pull succeeds`);
    assert(framesEqual(F, out), `${v.label}: round-trips`);
  }
  ok("2 ArrayBuffer / typed-array view / DataView + non-zero srcOffset all land equal");
}

// ── 3. Short source throws RangeError ──────────────────────────────────────
function testShortSourceThrows(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const fb = schema.frameByteSize;
  const alloc = Bridge.allocate(2, schema);
  const b = new Bridge(alloc.sab, alloc.capacity, alloc.schema);

  let threw = 0;
  try {
    b.pushRaw(new ArrayBuffer(fb - 1));
  } catch (e) {
    if (e instanceof RangeError) threw++;
  }
  try {
    // Full-size buffer but offset pushes the frame past the end.
    b.pushRaw(new ArrayBuffer(fb), 1);
  } catch (e) {
    if (e instanceof RangeError) threw++;
  }
  try {
    b.pushRaw(new ArrayBuffer(fb), -1);
  } catch (e) {
    if (e instanceof RangeError) threw++;
  }
  assertEq(threw, 3, "all three short/under-offset sources throw RangeError");
  ok("3 source shorter than frameByteSize at offset throws RangeError");
}

// ── 4. Backpressure policy parity with push ────────────────────────────────
function testPolicyParityWithPush(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const cap = 2;
  const frames = [makePhysFrame(0, n), makePhysFrame(1, n), makePhysFrame(2, n)];
  const bytes = frames.map((f) => encodeFrameBytes(schema, f));

  // Run the same 3-frame overflow sequence two ways and compare outcomes.
  function run(policy: BackpressurePolicy, raw: boolean) {
    const alloc = Bridge.allocate(cap, schema);
    const b = new Bridge(alloc.sab, alloc.capacity, alloc.schema, { policy });
    const results: boolean[] = [];
    for (let i = 0; i < frames.length; i++) {
      results.push(raw ? b.pushRaw(bytes[i]!) : b.push(frames[i]!));
    }
    const dropped = b.telemetry().droppedFrames;
    const pulled: number[] = [];
    const out = emptyPhysFrame(n);
    while (b.pull(out)) pulled.push(Number(out.seq));
    return { results, dropped, pulled };
  }

  for (const policy of ["reject", "drop-newest", "drop-oldest"] as BackpressurePolicy[]) {
    const viaPush = run(policy, false);
    const viaRaw = run(policy, true);
    assertEq(
      JSON.stringify(viaRaw.results),
      JSON.stringify(viaPush.results),
      `${policy}: pushRaw return values match push`,
    );
    assertEq(viaRaw.dropped, viaPush.dropped, `${policy}: droppedFrames match`);
    assertEq(
      JSON.stringify(viaRaw.pulled),
      JSON.stringify(viaPush.pulled),
      `${policy}: surviving frame sequence matches`,
    );
  }
  ok("4 reject / drop-newest / drop-oldest behave identically for pushRaw and push");
}

// ── 5. Block policy + 0ms timeout returns false on full ────────────────────
function testBlockTimeoutReturnsFalse(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(2, schema);
  const b = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "block",
    blockTimeoutMs: 0,
  });
  const bytes = encodeFrameBytes(schema, makePhysFrame(0, n));
  assertEq(b.pushRaw(bytes), true, "block: first pushRaw fits");
  assertEq(b.pushRaw(bytes), true, "block: second pushRaw fills the ring");
  assertEq(b.pushRaw(bytes), false, "block: full pushRaw times out → false");
  ok("5 'block' policy with 0ms timeout returns false on a full ring");
}

// ── 6. Invariant lane recomputed from payload, not source bytes ────────────
function testInvariantRecomputed(): void {
  const schema = makeInvariantSchema();
  const fb = schema.frameByteSize;
  const invOff = describeSchemaLayout(schema).invariantByteOffset!;
  assert(invOff !== null, "invariant schema exposes invariantByteOffset");

  const F = makeInvFrame(3, [1, 2, 3, 4]); // Σ v² = 1+4+9+16 = 30
  const expected = 30;
  const bytes = encodeFrameBytes(schema, F);

  // Corrupt the SOURCE invariant lane — pushRaw must ignore it and recompute.
  new DataView(bytes).setFloat64(invOff, -999.5, true);

  const alloc = Bridge.allocate(2, schema);
  const b = new Bridge(alloc.sab, alloc.capacity, alloc.schema);
  assertEq(b.pushRaw(bytes), true, "invariant schema pushRaw returns true");

  // Target invariant lane equals the recomputed value, not the corrupted source.
  const laneByte = RING_HEADER_BYTES + 0 * fb + invOff;
  const lane = new DataView(alloc.sab).getFloat64(laneByte, true);
  assertEq(lane, expected, "pushRaw recomputed the invariant from the payload");

  // Payload region (everything before the invariant lane) is a verbatim memcpy.
  const tgtPayload = new Uint8Array(alloc.sab.slice(RING_HEADER_BYTES, RING_HEADER_BYTES + invOff));
  const srcPayload = new Uint8Array(bytes, 0, invOff);
  assert(bytesEqual(tgtPayload, srcPayload), "payload bytes are an exact memcpy");

  // And it matches what push would have stored.
  const refAlloc = Bridge.allocate(2, schema);
  const ref = new Bridge(refAlloc.sab, refAlloc.capacity, refAlloc.schema);
  assert(ref.push(F), "ref push fits");
  const refLane = new DataView(refAlloc.sab).getFloat64(RING_HEADER_BYTES + invOff, true);
  assertEq(lane, refLane, "pushRaw invariant lane equals push invariant lane");

  // A normal pull classifies it as a clean (non-torn) frame.
  const tornBefore = b.telemetry().tornFrames;
  const out = emptyInvFrame();
  assert(b.pull(out), "pull after invariant pushRaw succeeds");
  assertEq(b.telemetry().tornFrames, tornBefore, "clean frame does not increment tornFrames");
  ok("6 invariant lane recomputed from payload (source lane corruption ignored)");
}

function main(): void {
  testRawBytesIdenticalToPush();
  testSourceViewsAndOffset();
  testShortSourceThrows();
  testPolicyParityWithPush();
  testBlockTimeoutReturnsFalse();
  testInvariantRecomputed();
  console.log("\nAll Bridge.pushRaw tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
