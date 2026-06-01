/**
 * BridgeGPUSource "raw" decoder mode (0.9.63).
 *
 * The `"raw"` decoder sentinel makes `BridgeGPUSource` skip the
 * beginPush → decoder → commitPush dance and instead memcpy each completed
 * readback straight into the SAB via `bridge.pushRaw(mappedRange)`. This pairs
 * with an `emitWgslStruct(schema)`-generated producer struct so the GPU bytes
 * already match the SAB frame layout exactly.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/BridgeGPUSource.raw.test.ts
 *
 * Pins:
 *  1. testRawDispatchPushesFrame   — raw readback lands a frame via pushRaw
 *                                     (no decoder closure); decoderMode==='raw';
 *                                     decoded payload matches the mapped bytes
 *  2. testRawRingFullDrops         — bridge full → pushRaw false → droppedCount++
 *                                     and the slot recycles to idle
 *  3. testRawReleaseMapThrowRecovers — unmap throwing after a successful pushRaw
 *                                     keeps the frame, recycles the slot, fires
 *                                     onError; next readback succeeds
 *  4. testRawSizeMismatchThrows    — stagingBufferSize !== frameByteSize throws
 *                                     at construction with no buffers leaked
 *  5. testClosureModeUnaffected    — closure decoder still works; decoderMode
 *                                     reports 'closure' (regression guard)
 *
 * No GPU is required; the tests use tiny mock `GpuDeviceLike`s.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  Bridge,
  BridgeGPUSource,
  RING_HEADER_BYTES,
  defineSchema,
  f32,
  f64Array,
  u8,
  u64,
  type GpuBufferLike,
  type GpuCommandEncoderLike,
  type GpuDeviceLike,
  type FrameFor,
} from "../src/index.js";

const schema = defineSchema({
  seq: u64(),
  payload: f64Array(2),
});
type Frame = FrameFor<typeof schema>;
const FRAME_BYTES = schema.frameByteSize; // 8 + 16 = 24

function makeBridge(capacity = 4, policy?: "reject" | "drop-newest" | "drop-oldest" | "block") {
  const { sab, capacity: cap } = Bridge.allocate(capacity, schema);
  return new Bridge(sab, cap, schema, policy ? { policy } : {});
}

/** Encode one frame to a standalone ArrayBuffer via a throwaway bridge push —
 *  the same byte layout a GPU readback buffer carries. */
function encodeFrame(frame: Frame): ArrayBuffer {
  const { sab, capacity } = Bridge.allocate(2, schema);
  const b = new Bridge(sab, capacity, schema);
  assert(b.push(frame), "encodeFrame: source push fits");
  const out = new ArrayBuffer(FRAME_BYTES);
  new Uint8Array(out).set(new Uint8Array(sab, RING_HEADER_BYTES, FRAME_BYTES));
  return out;
}

const dummySrcBuffer: GpuBufferLike = {
  size: 0,
  mapAsync: () => Promise.resolve(undefined),
  getMappedRange: () => new ArrayBuffer(0),
  unmap: () => {},
  destroy: () => {},
};

const noopEncoder: GpuCommandEncoderLike = {
  copyBufferToBuffer(_s, _so, _d, _do, _size) { /* no-op */ },
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Resolving mock whose getMappedRange hands back a fresh copy of `frameBytes`
 *  (so pushRaw memcpys real frame content). `onUnmap` lets a test observe / fail
 *  the release step. */
function makeRawMockDevice(
  frameBytes: ArrayBuffer,
  onUnmap?: () => void,
): GpuDeviceLike {
  return {
    createBuffer(desc) {
      const buf: GpuBufferLike = {
        size: desc.size,
        mapAsync: () => Promise.resolve(undefined),
        getMappedRange: (_offset, _size) => frameBytes.slice(0),
        unmap: () => { if (onUnmap) onUnmap(); },
        destroy: () => {},
      };
      return buf;
    },
  };
}

// ── 1. Raw dispatch pushes a frame via pushRaw (no decoder closure) ─────────
async function testRawDispatchPushesFrame(): Promise<void> {
  const F: Frame = { seq: 99n, payload: new Float64Array([1.5, -2.5]) };
  const bytes = encodeFrame(F);
  const device = makeRawMockDevice(bytes);
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, "raw", { stagingBufferCount: 2 });

  assertEq(src.decoderMode(), "raw", "decoderMode reports 'raw'");

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();
  const pushed = src.pollCompleted();

  assertEq(pushed, 1, "raw readback pushes one frame");
  assertEq(src.pushedCount(), 1, "pushedCount advanced");
  assertEq(src.droppedCount(), 0, "nothing dropped");
  assertEq(src.inFlight(), 0, "slot recycled to idle");

  const out: Frame = { seq: 0n, payload: new Float64Array(2) };
  assert(bridge.pull(out), "frame readable after raw push");
  assertEq(out.seq, 99n, "seq round-trips through pushRaw");
  assertEq(out.payload[0], 1.5, "payload[0] round-trips");
  assertEq(out.payload[1], -2.5, "payload[1] round-trips");

  src.destroy();
  ok("1. raw dispatch lands a frame via pushRaw with no decoder closure");
}

// ── 2. Bridge full → pushRaw false → drop + recycle ─────────────────────────
async function testRawRingFullDrops(): Promise<void> {
  const F: Frame = { seq: 1n, payload: new Float64Array([0, 0]) };
  const bytes = encodeFrame(F);
  const device = makeRawMockDevice(bytes);
  const bridge = makeBridge(2, "reject");
  // Pre-fill the ring so the next pushRaw is rejected.
  assert(bridge.push({ seq: 10n, payload: new Float64Array([0, 0]) }), "prefill 1 fits");
  assert(bridge.push({ seq: 11n, payload: new Float64Array([0, 0]) }), "prefill 2 fits");

  const src = new BridgeGPUSource(device, bridge, "raw", { stagingBufferCount: 2 });
  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();
  const pushed = src.pollCompleted();

  assertEq(pushed, 0, "full bridge accepts nothing");
  assertEq(src.pushedCount(), 0, "pushedCount unchanged");
  assertEq(src.droppedCount(), 1, "drop counter ticked on full ring");
  assertEq(src.inFlight(), 0, "slot recycled despite the drop");

  src.destroy();
  ok("2. raw mode drops + recycles when the bridge is full");
}

// ── 3. Throwing releaseMap after a successful pushRaw still recycles ─────────
async function testRawReleaseMapThrowRecovers(): Promise<void> {
  const F: Frame = { seq: 7n, payload: new Float64Array([3.25, 4.5]) };
  const bytes = encodeFrame(F);
  let throwOnUnmap = true;
  const device = makeRawMockDevice(bytes, () => {
    if (throwOnUnmap) throw new Error("unmap blew up (e.g. buffer already destroyed)");
  });
  const bridge = makeBridge();
  const captured: Array<{ err: unknown; kind: string }> = [];
  const src = new BridgeGPUSource(device, bridge, "raw", {
    stagingBufferCount: 2,
    onError: (err, kind) => captured.push({ err, kind }),
  });

  // Frame 1 — pushRaw succeeds, but unmap throws.
  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();
  const pushed1 = src.pollCompleted();

  assertEq(pushed1, 1, "frame committed before unmap threw (pushRaw is atomic)");
  assertEq(src.pushedCount(), 1, "pushedCount reflects the committed frame");
  assertEq(src.inFlight(), 0, "slot recycled to idle despite the unmap throw (finally ran)");
  assertEq(captured.length, 1, "onError fired once for the unmap failure");
  assertEq(captured[0]!.kind, "transient", "unmap failure classified 'transient'");
  const out: Frame = { seq: 0n, payload: new Float64Array(2) };
  assert(bridge.pull(out), "the committed frame is readable");
  assertEq(out.seq, 7n, "the committed frame carries the mapped payload");

  // Frame 2 — unmap now succeeds; recycled slot accepts the next readback.
  throwOnUnmap = false;
  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();
  const pushed2 = src.pollCompleted();
  assertEq(pushed2, 1, "recycled slot accepts the next raw readback");
  assertEq(src.pushedCount(), 2, "second frame committed");

  src.destroy();
  ok("3. raw mode: throwing releaseMap recycles the slot in finally (frame kept)");
}

// ── 4. stagingBufferSize !== frameByteSize throws (no buffers leaked) ────────
function testRawSizeMismatchThrows(): void {
  let createCount = 0;
  const device: GpuDeviceLike = {
    createBuffer(desc) {
      createCount++;
      return {
        size: desc.size,
        mapAsync: () => Promise.resolve(undefined),
        getMappedRange: (_o, s) => new ArrayBuffer(s ?? desc.size),
        unmap: () => {},
        destroy: () => {},
      };
    },
  };
  const bridge = makeBridge();
  let threw = false;
  let msg = "";
  try {
    new BridgeGPUSource(device, bridge, "raw", { stagingBufferSize: FRAME_BYTES + 8 });
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, "raw mode with a mismatched stagingBufferSize throws");
  assert(/stagingBufferSize/.test(msg), "error names stagingBufferSize");
  assert(/frameByteSize/.test(msg), "error names frameByteSize");
  assertEq(createCount, 0, "no staging buffers created on the rejected construction");

  // Sanity: the matching size constructs cleanly.
  const okSrc = new BridgeGPUSource(device, bridge, "raw", { stagingBufferSize: FRAME_BYTES });
  assertEq(okSrc.decoderMode(), "raw", "matching size constructs in raw mode");
  okSrc.destroy();
  ok("4. raw mode rejects stagingBufferSize !== frameByteSize with no leaks");
}

// ── 5. Closure mode unaffected (regression) ─────────────────────────────────
async function testClosureModeUnaffected(): Promise<void> {
  const device = makeRawMockDevice(encodeFrame({ seq: 0n, payload: new Float64Array([0, 0]) }));
  const bridge = makeBridge();
  let decodeCalls = 0;
  const decoder = (_range: ArrayBuffer, frame: Frame): void => {
    decodeCalls++;
    frame.seq = 555n;
    frame.payload[0] = 9.5;
    frame.payload[1] = 8.5;
  };
  const src = new BridgeGPUSource(device, bridge, decoder, { stagingBufferCount: 2 });
  assertEq(src.decoderMode(), "closure", "decoderMode reports 'closure' for a closure decoder");

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();
  const pushed = src.pollCompleted();

  assertEq(pushed, 1, "closure readback pushes one frame");
  assertEq(decodeCalls, 1, "the decoder closure ran");
  const out: Frame = { seq: 0n, payload: new Float64Array(2) };
  assert(bridge.pull(out), "closure frame readable");
  assertEq(out.seq, 555n, "closure decoder payload landed");
  assertEq(out.payload[0], 9.5, "closure payload[0] landed");

  src.destroy();
  ok("5. closure decoder mode is unaffected by the raw-mode branch");
}

function testRawCompatibilityFactory(): void {
  const compatible = BridgeGPUSource.rawCompatibility(schema);
  assertEq(compatible.compatible, true, "main raw schema is WGSL-compatible");
  assertEq(compatible.reason, "compatible", "compatible report reason");
  assertEq(compatible.frameByteSize, FRAME_BYTES, "report carries frameByteSize");
  assertEq(compatible.structSize, FRAME_BYTES, "report carries matching structSize");

  const compatibleBridge = makeBridge();
  const compatibleSrc = BridgeGPUSource.rawIfCompatible(
    makeRawMockDevice(encodeFrame({ seq: 1n, payload: new Float64Array([0, 0]) })),
    compatibleBridge,
    () => {
      throw new Error("fallback decoder must not run for a raw-compatible schema");
    },
    { stagingBufferCount: 2 },
  );
  assertEq(compatibleSrc.decoderMode(), "raw", "factory selects raw for compatible schema");
  compatibleSrc.destroy();

  const tinySchema = defineSchema({ byte: u8() });
  const incompatible = BridgeGPUSource.rawCompatibility(tinySchema);
  assertEq(incompatible.compatible, false, "sub-32-bit schema is not raw-compatible");
  assertEq(incompatible.reason, "wgsl-layout-error", "sub-32-bit schema reports WGSL layout error");

  const { sab, capacity } = Bridge.allocate(2, tinySchema);
  const tinyBridge = new Bridge(sab, capacity, tinySchema);
  const fallbackSrc = BridgeGPUSource.rawIfCompatible(
    makeRawMockDevice(new ArrayBuffer(tinySchema.frameByteSize)),
    tinyBridge,
    (_range, frame) => { frame.byte = 7; },
    { stagingBufferCount: 2 },
  );
  assertEq(fallbackSrc.decoderMode(), "closure", "factory falls back to closure for incompatible schema");
  fallbackSrc.destroy();

  const invariantSchema = defineSchema({ x: f32() }).withInvariant((frame) => frame.x);
  const invariant = BridgeGPUSource.rawCompatibility(invariantSchema);
  assertEq(invariant.compatible, false, "invariant schema is not auto-raw by default");
  assertEq(invariant.reason, "invariant-lane", "invariant lane reports explicit safety reason");
  const invariantAllowed = BridgeGPUSource.rawCompatibility(invariantSchema, { allowInvariantLane: true });
  assertEq(invariantAllowed.compatible, true, "allowInvariantLane permits explicit raw compatibility");

  ok("6. rawCompatibility + rawIfCompatible select raw only when byte-safe");
}

async function testPartialRawReadbackMergesDirtyRegion(): Promise<void> {
  const initial: Frame = { seq: 10n, payload: new Float64Array([1, 2]) };
  const update: Frame = { seq: 99n, payload: new Float64Array([7, 8]) };
  const device = makeRawMockDevice(encodeFrame(update));
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, "raw", {
    stagingBufferCount: 2,
    initialFrameBytes: encodeFrame(initial),
  });

  assert(src.scheduleReadback(dummySrcBuffer, noopEncoder, 8, 16, 8), "partial payload schedule succeeds");
  src.flushPending();
  await flushMicrotasks();
  const pushed = src.pollCompleted();

  assertEq(pushed, 1, "partial raw readback pushes one merged frame");
  assertEq(src.partialReadbackCount(), 1, "partial counter increments");
  assertEq(src.partialBytesCopied(), 16, "partial byte counter tracks dirty bytes");

  const out: Frame = { seq: 0n, payload: new Float64Array(2) };
  assert(bridge.pull(out), "merged partial frame is readable");
  assertEq(out.seq, 10n, "unchanged seq remains from initial frame image");
  assertEq(out.payload[0], 7, "dirty payload[0] updates from readback");
  assertEq(out.payload[1], 8, "dirty payload[1] updates from readback");

  src.destroy();
  ok("7. partial raw readback merges dirty bytes into a retained full-frame image");
}

async function testPartialClosureReadbackReceivesMergedFrame(): Promise<void> {
  const initial: Frame = { seq: 20n, payload: new Float64Array([3, 4]) };
  const update: Frame = { seq: 88n, payload: new Float64Array([11, 12]) };
  const device = makeRawMockDevice(encodeFrame(update));
  const bridge = makeBridge();
  const decoder = (range: ArrayBuffer, frame: Frame): void => {
    const view = new DataView(range);
    frame.seq = view.getBigUint64(0, true);
    frame.payload[0] = view.getFloat64(8, true);
    frame.payload[1] = view.getFloat64(16, true);
  };
  const src = new BridgeGPUSource(device, bridge, decoder, {
    stagingBufferCount: 2,
    initialFrameBytes: encodeFrame(initial),
  });

  assert(src.scheduleReadback(dummySrcBuffer, noopEncoder, 8, 16, 8), "partial payload schedule succeeds");
  src.flushPending();
  await flushMicrotasks();
  const pushed = src.pollCompleted();

  assertEq(pushed, 1, "partial closure readback pushes one decoded merged frame");
  assertEq(src.partialReadbackCount(), 1, "partial counter increments in closure mode");

  const out: Frame = { seq: 0n, payload: new Float64Array(2) };
  assert(bridge.pull(out), "merged decoded frame is readable");
  assertEq(out.seq, 20n, "decoder saw retained seq from initial frame image");
  assertEq(out.payload[0], 11, "decoder saw dirty payload[0]");
  assertEq(out.payload[1], 12, "decoder saw dirty payload[1]");

  src.destroy();
  ok("8. partial closure readback passes merged full-frame bytes to the decoder");
}

async function testFieldReadbackHelpers(): Promise<void> {
  const initial: Frame = { seq: 30n, payload: new Float64Array([5, 6]) };
  const update: Frame = { seq: 77n, payload: new Float64Array([13, 14]) };
  const device = makeRawMockDevice(encodeFrame(update));
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, "raw", {
    stagingBufferCount: 2,
    initialFrameBytes: encodeFrame(initial),
  });

  const payloadRange = src.fieldReadbackRange(["payload"]);
  assertEq(payloadRange.dstOffset, 8, "payload field offset is derived from schema layout");
  assertEq(payloadRange.byteLength, 16, "payload field byte length is derived from schema layout");

  const fullRange = src.fieldReadbackRange(["seq", "payload"]);
  assertEq(fullRange.dstOffset, 0, "multi-field range starts at the first field");
  assertEq(fullRange.byteLength, FRAME_BYTES, "multi-field range spans both requested fields");

  assert(src.scheduleFieldReadback("payload", dummySrcBuffer, noopEncoder), "field readback schedule succeeds");
  src.flushPending();
  await flushMicrotasks();
  const pushed = src.pollCompleted();
  assertEq(pushed, 1, "field readback publishes one merged frame");

  const out: Frame = { seq: 0n, payload: new Float64Array(2) };
  assert(bridge.pull(out), "field-readback frame is readable");
  assertEq(out.seq, 30n, "field helper retained unchanged seq");
  assertEq(out.payload[0], 13, "field helper updated payload[0]");
  assertEq(out.payload[1], 14, "field helper updated payload[1]");
  src.destroy();

  const copies: Array<{ srcOffset: number; dstOffset: number; byteLength: number }> = [];
  const captureEncoder: GpuCommandEncoderLike = {
    copyBufferToBuffer(_s, sourceOffset, _d, destinationOffset, size) {
      copies.push({ srcOffset: sourceOffset, dstOffset: destinationOffset, byteLength: size });
    },
  };
  const offsetSource = new BridgeGPUSource(
    makeRawMockDevice(encodeFrame(update)),
    makeBridge(),
    "raw",
    { stagingBufferCount: 2 },
  );
  assert(
    offsetSource.scheduleFieldReadback("payload", dummySrcBuffer, captureEncoder, { srcOffset: 0 }),
    "field readback with source offset override schedules",
  );
  assertEq(copies.length, 1, "one WebGPU copy was encoded");
  assertEq(copies[0]!.srcOffset, 0, "source offset override is passed through");
  assertEq(copies[0]!.dstOffset, 8, "destination offset remains the schema field offset");
  assertEq(copies[0]!.byteLength, 16, "copy size remains the field byte length");
  offsetSource.destroy();

  ok("9. field-level dirty readback helpers derive layout offsets and support source-offset override");
}

async function main(): Promise<void> {
  await testRawDispatchPushesFrame();
  await testRawRingFullDrops();
  await testRawReleaseMapThrowRecovers();
  testRawSizeMismatchThrows();
  await testClosureModeUnaffected();
  testRawCompatibilityFactory();
  await testPartialRawReadbackMergesDirtyRegion();
  await testPartialClosureReadbackReceivesMergedFrame();
  await testFieldReadbackHelpers();
  console.log("\nAll BridgeGPUSource.raw.test.ts pins passed.");
}

main().catch((err) => {
  console.error("BridgeGPUSource.raw.test.ts FAILED:", err);
  process.exit(1);
});
