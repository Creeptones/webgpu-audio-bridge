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
  f64Array,
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

async function main(): Promise<void> {
  await testRawDispatchPushesFrame();
  await testRawRingFullDrops();
  await testRawReleaseMapThrowRecovers();
  testRawSizeMismatchThrows();
  await testClosureModeUnaffected();
  console.log("\nAll BridgeGPUSource.raw.test.ts pins passed.");
}

main().catch((err) => {
  console.error("BridgeGPUSource.raw.test.ts FAILED:", err);
  process.exit(1);
});
