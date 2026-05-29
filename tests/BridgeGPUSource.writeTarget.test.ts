/**
 * BridgeGPUSource WriteTarget — pins for the 0.7.15 zero-copy scaffold.
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/BridgeGPUSource.writeTarget.test.ts
 *
 * The 0.7.15 patch refactors `BridgeGPUSource`'s internal mapAsync path
 * into a `WriteTarget` strategy and adds a `writeTarget: 'auto' |
 * 'map-async' | 'shared'` constructor option. Today only `'map-async'`
 * is implemented; `'shared'` throws and `'auto'` deterministically
 * resolves to `'map-async'` because no `SharedMemoryWriteTarget` has
 * shipped yet. The existing mapAsync lifecycle is preserved exactly —
 * `tests/Bridge.test.ts`'s pin #81 (`bridge-gpu-source-orchestration`)
 * covers the end-to-end state machine with a mock device; this file
 * focuses on the new `WriteTarget` selection logic + the capability
 * sniff.
 *
 * Pins:
 *   1.  Default constructor option (no `writeTarget` passed) selects
 *       'map-async': the staging buffers are created via
 *       `device.createBuffer`, the resolved kind reports as
 *       `'map-async'`.
 *   2.  Explicit `writeTarget: 'auto'` resolves the same as default.
 *   3.  Explicit `writeTarget: 'map-async'` constructs cleanly and
 *       reports `'map-async'`; behavior is identical to the
 *       0.7.14 baseline.
 *   4.  Explicit `writeTarget: 'shared'` throws on construction with a
 *       descriptive error message naming the unavailable interface.
 *       No staging buffers leaked.
 *   5.  Validation runs BEFORE WriteTarget construction:
 *       `stagingBufferCount: 1` and `stagingBufferSize: 0` both throw
 *       without creating any GPU buffers (zero leaked staging buffers).
 *   6.  `getEnvironmentReport().webgpuZeroCopy === false` in current
 *       Node — the canonical "platform doesn't expose zero-copy
 *       readback yet" signal callers should consult before passing
 *       `writeTarget: 'shared'`.
 *   7.  (0.9.32) `onError` callback fires with `kind: 'transient'`
 *       when `mapAsync` rejects on a device whose `lost` promise
 *       hasn't resolved. The slot routes to drop-and-recycle without
 *       calling `getMappedRange` / `unmap` on the never-mapped buffer
 *       (asserted by mock methods that throw if called).
 *   8.  (0.9.32) `onError` callback fires with `kind: 'fatal'` when
 *       `mapAsync` rejects on a device whose `lost` promise has
 *       resolved before the rejection lands. Classification is
 *       observed at rejection time.
 *   9.  (0.9.32) Omitting `onError` keeps the helper silent — the
 *       rejection still cleans up the slot and ticks `droppedCount`
 *       without crashing.
 *   10. (0.9.32) A user `onError` handler that itself throws does not
 *       crash the helper — the callback exception is swallowed and
 *       the slot still recycles.
 *   11. (0.9.54) A decoder that throws AFTER beginPush() does not strand
 *       the staging slot: pollCompleted aborts the begun push (write_index
 *       does not advance), unmaps the buffer, recycles the slot to idle,
 *       ticks droppedCount, and fires onError('transient'). The next
 *       readback succeeds on the recycled slot (no permanent starvation).
 *
 * No GPU is required; the test uses a tiny mock `GpuDeviceLike`.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  Bridge,
  BridgeGPUSource,
  defineSchema,
  f64Array,
  getEnvironmentReport,
  u64,
  type GpuBufferLike,
  type GpuCommandEncoderLike,
  type GpuDeviceLike,
  type FrameFor,
} from "../src/index.js";

// ── Mock device ──────────────────────────────────────────────────────────
//
// A minimal `GpuDeviceLike` that records every `createBuffer` call so
// pins can assert "0 buffers leaked when construction throws" and "N
// buffers created when construction succeeds." No mapAsync resolution
// machinery — the validation + selection paths under test don't need
// to round-trip a readback; pin #81 in Bridge.test.ts already covers
// that with a more elaborate mock.

interface MockBuffer extends GpuBufferLike {
  destroyed: boolean;
}

interface MockDevice extends GpuDeviceLike {
  readonly createdBuffers: ReadonlyArray<MockBuffer>;
  readonly createCallCount: number;
}

function makeMockDevice(): MockDevice {
  const createdBuffers: MockBuffer[] = [];
  let createCallCount = 0;
  const device: GpuDeviceLike = {
    createBuffer(desc) {
      createCallCount++;
      const buf: MockBuffer = {
        size: desc.size,
        destroyed: false,
        mapAsync(_mode) {
          // Never resolves; the selection-path tests don't await it.
          return new Promise<undefined>(() => {});
        },
        getMappedRange(_offset, size) {
          return new ArrayBuffer(size ?? desc.size);
        },
        unmap() { /* no-op */ },
        destroy() { this.destroyed = true; },
      };
      createdBuffers.push(buf);
      return buf;
    },
  };
  // Splice in the count + buffers as read-only mirrors. Cast through
  // `unknown` because the GpuDeviceLike interface doesn't include them.
  Object.defineProperty(device, "createdBuffers", {
    get: () => createdBuffers,
    enumerable: true,
  });
  Object.defineProperty(device, "createCallCount", {
    get: () => createCallCount,
    enumerable: true,
  });
  return device as MockDevice;
}

const schema = defineSchema({
  seq: u64(),
  payload: f64Array(2),
});

function makeBridge(): Bridge<typeof schema> {
  const { sab, capacity } = Bridge.allocate(4, schema);
  return new Bridge(sab, capacity, schema);
}

const noopDecoder = (_range: ArrayBuffer, _frame: FrameFor<typeof schema>): void => {
  /* no-op — the selection-path tests never run the decoder. */
};

// ── 1. Default → 'map-async' ────────────────────────────────────────────
function testDefaultResolvesToMapAsync(): void {
  const device = makeMockDevice();
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, noopDecoder);
  assertEq(src.writeTargetKind(), "map-async", "default kind is 'map-async'");
  assertEq(device.createCallCount, 3, "default constructs 3 staging buffers");
  src.destroy();
  ok("1. default writeTarget resolves to 'map-async'");
}

// ── 2. Explicit 'auto' resolves the same as default ─────────────────────
function testAutoResolvesToMapAsync(): void {
  const device = makeMockDevice();
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, noopDecoder, {
    writeTarget: "auto",
    stagingBufferCount: 4,
  });
  assertEq(src.writeTargetKind(), "map-async", "'auto' resolves to 'map-async'");
  assertEq(device.createCallCount, 4, "'auto' honors stagingBufferCount");
  src.destroy();
  ok("2. 'auto' resolves to 'map-async'");
}

// ── 3. Explicit 'map-async' constructs cleanly ──────────────────────────
function testExplicitMapAsync(): void {
  const device = makeMockDevice();
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, noopDecoder, {
    writeTarget: "map-async",
    stagingBufferCount: 2,
    bufferLabelPrefix: "test-mapasync",
  });
  assertEq(src.writeTargetKind(), "map-async", "explicit 'map-async' reports 'map-async'");
  assertEq(device.createCallCount, 2, "explicit 'map-async' builds 2 staging buffers");
  // The buffers should still be alive (not yet destroyed).
  for (const buf of device.createdBuffers) {
    assertEq(buf.destroyed, false, "buffer not destroyed before destroy()");
  }
  src.destroy();
  for (const buf of device.createdBuffers) {
    assertEq(buf.destroyed, true, "buffer destroyed after destroy()");
  }
  ok("3. explicit 'map-async' constructs and destroys cleanly");
}

// ── 4. Explicit 'shared' throws with a descriptive error ────────────────
function testExplicitSharedThrows(): void {
  const device = makeMockDevice();
  const bridge = makeBridge();
  let threw = false;
  let errMsg = "";
  try {
    new BridgeGPUSource(device, bridge, noopDecoder, {
      writeTarget: "shared",
    });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "writeTarget: 'shared' throws");
  assert(
    errMsg.includes("shared"),
    `error mentions 'shared': "${errMsg}"`,
  );
  assert(
    errMsg.includes("webgpuZeroCopy") || errMsg.includes("getEnvironmentReport"),
    `error points at the capability sniff: "${errMsg}"`,
  );
  assertEq(
    device.createCallCount,
    0,
    "no staging buffers leaked when 'shared' throws",
  );
  ok("4. writeTarget: 'shared' throws cleanly with no leaked buffers");
}

// ── 5. Validation runs before WriteTarget construction ──────────────────
function testValidationBeforeWriteTargetBuild(): void {
  const bridge = makeBridge();

  // stagingBufferCount: 1 (must be ≥ 2)
  {
    const device = makeMockDevice();
    let threw = false;
    try {
      new BridgeGPUSource(device, bridge, noopDecoder, {
        stagingBufferCount: 1,
      });
    } catch {
      threw = true;
    }
    assert(threw, "stagingBufferCount: 1 throws");
    assertEq(
      device.createCallCount,
      0,
      "no staging buffers leaked for stagingBufferCount: 1",
    );
  }

  // stagingBufferSize: 0
  {
    const device = makeMockDevice();
    let threw = false;
    try {
      new BridgeGPUSource(device, bridge, noopDecoder, {
        stagingBufferSize: 0,
      });
    } catch {
      threw = true;
    }
    assert(threw, "stagingBufferSize: 0 throws");
    assertEq(
      device.createCallCount,
      0,
      "no staging buffers leaked for stagingBufferSize: 0",
    );
  }

  // Even with writeTarget: 'shared', validation throws first (count is
  // checked before the strategy is built).
  {
    const device = makeMockDevice();
    let threw = false;
    let errMsg = "";
    try {
      new BridgeGPUSource(device, bridge, noopDecoder, {
        stagingBufferCount: 1,
        writeTarget: "shared",
      });
    } catch (e) {
      threw = true;
      errMsg = (e as Error).message;
    }
    assert(threw, "validation+shared still throws");
    // The error should be about stagingBufferCount (validation), not
    // about 'shared' (WriteTarget construction).
    assert(
      errMsg.includes("stagingBufferCount"),
      `error is the validation one, not the WriteTarget one: "${errMsg}"`,
    );
    assertEq(
      device.createCallCount,
      0,
      "no leaks even when both validation + WriteTarget would fail",
    );
  }

  ok("5. validation runs before WriteTarget construction");
}

// ── 6. getEnvironmentReport().webgpuZeroCopy is false in Node ───────────
function testEnvReportWebgpuZeroCopyFalse(): void {
  const r = getEnvironmentReport();
  assertEq(
    r.webgpuZeroCopy,
    false,
    "current Node environment: webgpuZeroCopy false",
  );
  ok("6. getEnvironmentReport().webgpuZeroCopy is false on current Node");
}

// ── 0.9.32 onError pins ─────────────────────────────────────────────────
//
// A rejecting mock: every staging buffer's `mapAsync` returns a rejected
// promise. The `getMappedRange` / `unmap` methods throw if called — this
// is the assertion that `pollCompleted` skips the doomed read/release
// path on the error branch. The device also optionally exposes a `lost`
// promise that resolves on `loseDevice()` to drive the 'fatal' path.

interface RejectingMockDevice extends GpuDeviceLike {
  readonly createdBuffers: ReadonlyArray<GpuBufferLike & { destroyed: boolean }>;
  readonly createCallCount: number;
  /** Resolve the `lost` promise (transitions subsequent rejections to
   *  the 'fatal' classification). No-op if `withLost: false`. */
  loseDevice(): void;
}

function makeRejectingMockDevice(
  rejectionError: unknown,
  opts: { withLost?: boolean } = {},
): RejectingMockDevice {
  const createdBuffers: Array<GpuBufferLike & { destroyed: boolean }> = [];
  let createCallCount = 0;
  const withLost = opts.withLost ?? true;
  let resolveLost: () => void = () => {};
  const lostPromise = withLost
    ? new Promise<unknown>((resolve) => {
        resolveLost = () => resolve({ reason: "destroyed", message: "test" });
      })
    : undefined;

  const device: GpuDeviceLike = {
    createBuffer(desc) {
      createCallCount++;
      const buf: GpuBufferLike & { destroyed: boolean } = {
        size: desc.size,
        destroyed: false,
        mapAsync(_mode) {
          // Rejected synchronously — the helper still routes the rejection
          // through its `.then(onFulfilled, onRejected)` handler on the
          // microtask queue.
          return Promise.reject(rejectionError);
        },
        getMappedRange(_offset, _size) {
          throw new Error(
            "RejectingMockDevice.getMappedRange: helper must NOT call this on the error path",
          );
        },
        unmap() {
          throw new Error(
            "RejectingMockDevice.unmap: helper must NOT call this on the error path",
          );
        },
        destroy() { this.destroyed = true; },
      };
      createdBuffers.push(buf);
      return buf;
    },
    ...(lostPromise ? { lost: lostPromise } : {}),
  };
  Object.defineProperty(device, "createdBuffers", {
    get: () => createdBuffers,
    enumerable: true,
  });
  Object.defineProperty(device, "createCallCount", {
    get: () => createCallCount,
    enumerable: true,
  });
  Object.defineProperty(device, "loseDevice", {
    value: () => resolveLost(),
    enumerable: true,
  });
  return device as RejectingMockDevice;
}

// Dummy "source" buffer to pass to scheduleReadback. The mock encoder's
// `copyBufferToBuffer` is a no-op; this buffer is never read from.
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

/** Drain pending microtasks. `await Promise.resolve()` once per hop;
 *  three hops cover the rejection handler chain (`p.then(...)` → user
 *  callback) plus a small safety margin. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ── 7. onError fires with 'transient' on generic rejection ──────────────
async function testOnErrorTransient(): Promise<void> {
  const rejectError = new Error("mapAsync test rejection");
  const device = makeRejectingMockDevice(rejectError, { withLost: true });
  const bridge = makeBridge();
  const captured: Array<{ err: unknown; kind: string }> = [];
  const src = new BridgeGPUSource(device, bridge, noopDecoder, {
    stagingBufferCount: 2,
    onError: (err, kind) => {
      captured.push({ err, kind });
    },
  });

  const scheduled = src.scheduleReadback(dummySrcBuffer, noopEncoder);
  assert(scheduled, "schedule succeeded");
  src.flushPending();
  await flushMicrotasks();

  assertEq(captured.length, 1, "onError fired exactly once");
  assertEq(captured[0]!.kind, "transient", "kind is 'transient' (device not lost)");
  assertEq(captured[0]!.err, rejectError, "err is the original rejection value");

  // The slot routes to drop-and-recycle on pollCompleted. If the helper
  // incorrectly called readMapped/unmap on the never-mapped buffer, the
  // mock would throw and this call would propagate the error.
  const pushed = src.pollCompleted();
  assertEq(pushed, 0, "no frames pushed on error path");
  assertEq(src.droppedCount(), 1, "drop counter ticked");
  assertEq(src.inFlight(), 0, "slot recycled to idle after error path");

  src.destroy();
  ok("7. onError fires with 'transient' kind on generic rejection");
}

// ── 8. onError fires with 'fatal' after device.lost resolves ────────────
async function testOnErrorFatal(): Promise<void> {
  const rejectError = new Error("post-device-lost rejection");
  const device = makeRejectingMockDevice(rejectError, { withLost: true });
  const bridge = makeBridge();
  const captured: Array<{ err: unknown; kind: string }> = [];
  const src = new BridgeGPUSource(device, bridge, noopDecoder, {
    stagingBufferCount: 2,
    onError: (err, kind) => {
      captured.push({ err, kind });
    },
  });

  // Resolve `device.lost` BEFORE flushing the rejection so the helper's
  // `_deviceLost` flag has flipped by the time the rejection handler runs.
  device.loseDevice();
  await flushMicrotasks();

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();

  assertEq(captured.length, 1, "onError fired exactly once");
  assertEq(captured[0]!.kind, "fatal", "kind is 'fatal' after device.lost resolved");
  assertEq(captured[0]!.err, rejectError, "err is the original rejection value");

  src.pollCompleted();
  src.destroy();
  ok("8. onError fires with 'fatal' kind after device.lost resolves");
}

// ── 9. Omitted onError: helper stays silent, slot recycles ──────────────
async function testNoOnErrorSilent(): Promise<void> {
  const device = makeRejectingMockDevice(new Error("silent"), { withLost: false });
  const bridge = makeBridge();
  // No `onError` option passed.
  const src = new BridgeGPUSource(device, bridge, noopDecoder, {
    stagingBufferCount: 2,
  });

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();

  // pollCompleted should NOT call readMapped/unmap on the unmapped slot.
  // If the helper's error routing is broken, this propagates the throw
  // from the rejecting mock's getMappedRange/unmap.
  const pushed = src.pollCompleted();
  assertEq(pushed, 0, "no frames pushed");
  assertEq(src.droppedCount(), 1, "drop counter ticked despite no onError");
  assertEq(src.inFlight(), 0, "slot recycled");

  src.destroy();
  ok("9. omitted onError: helper stays silent, slot recycles cleanly");
}

// ── 10. A throwing user onError handler does not crash the helper ───────
async function testOnErrorUserThrowSwallowed(): Promise<void> {
  const device = makeRejectingMockDevice(new Error("rej"), { withLost: false });
  const bridge = makeBridge();
  let fired = false;
  const src = new BridgeGPUSource(device, bridge, noopDecoder, {
    stagingBufferCount: 2,
    onError: (_e, _k) => {
      fired = true;
      throw new Error("simulated user-handler bug");
    },
  });

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();

  assert(fired, "user onError handler fired");
  // The helper swallowed the user-handler exception; pollCompleted
  // still observes the slot's error state and recycles it.
  src.pollCompleted();
  assertEq(src.droppedCount(), 1, "drop counter ticked despite user-handler throw");
  assertEq(src.inFlight(), 0, "slot recycled despite user-handler throw");

  src.destroy();
  ok("10. user onError throwing is swallowed");
}

// ── 0.9.54 decoder-throw containment ────────────────────────────────────
//
// A RESOLVING mock: every staging buffer's `mapAsync` resolves, so the slot
// reaches the decode path in `pollCompleted`. `getMappedRange` hands back a
// real ArrayBuffer; `unmap` ticks a counter so the test can assert the buffer
// is released even when the decoder throws.
function makeResolvingMockDevice(onUnmap: () => void): GpuDeviceLike {
  return {
    createBuffer(desc) {
      const buf: GpuBufferLike = {
        size: desc.size,
        mapAsync: () => Promise.resolve(undefined),
        getMappedRange: (_offset, size) => new ArrayBuffer(size ?? desc.size),
        unmap: () => { onUnmap(); },
        destroy: () => {},
      };
      return buf;
    },
  };
}

// ── 11. (0.9.54) A throwing decoder does not strand the staging slot ────────
// When the decoder throws AFTER beginPush(), pollCompleted must: abort the
// begun push (write_index does NOT advance), unmap the staging buffer, recycle
// the slot to idle, tick the drop counter, and surface onError. The next
// readback then succeeds on the recycled slot — proving the pipeline isn't
// permanently starved, which is the pre-0.9.54 leak this fix closes.
async function testDecoderThrowRecovers(): Promise<void> {
  let unmapCount = 0;
  const device = makeResolvingMockDevice(() => { unmapCount++; });
  const bridge = makeBridge();
  const captured: Array<{ err: unknown; kind: string }> = [];

  let decodeCall = 0;
  const decoder = (_range: ArrayBuffer, frame: FrameFor<typeof schema>): void => {
    decodeCall++;
    if (decodeCall === 1) throw new Error("decoder blew up on the first frame");
    frame.seq = 42n;
  };

  const src = new BridgeGPUSource(device, bridge, decoder, {
    stagingBufferCount: 2,
    onError: (err, kind) => captured.push({ err, kind }),
  });

  // Frame 1 — decoder throws.
  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();
  const pushed1 = src.pollCompleted();

  assertEq(pushed1, 0, "throwing decoder pushes nothing");
  assertEq(src.pushedCount(), 0, "pushedCount unchanged after decoder throw");
  assertEq(src.droppedCount(), 1, "drop counter ticked on decoder throw");
  assertEq(src.inFlight(), 0, "slot recycled to idle after decoder throw");
  assertEq(unmapCount, 1, "staging buffer unmapped even though the decoder threw");
  assertEq(captured.length, 1, "onError fired once on decoder throw");
  assertEq(captured[0]!.kind, "transient", "decoder throw classified 'transient' (device not lost)");
  // abortPush() means write_index never advanced — nothing is readable.
  assert(!bridge.pull(bridge.scratchFrame()), "no frame committed after the aborted push");

  // Frame 2 — same pool recycled, decoder succeeds.
  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();
  const pushed2 = src.pollCompleted();

  assertEq(pushed2, 1, "recycled slot accepts the next readback");
  assertEq(src.pushedCount(), 1, "pushedCount advanced on the successful frame");
  assertEq(unmapCount, 2, "second readback unmapped its buffer too");
  const out = bridge.scratchFrame();
  assert(bridge.pull(out), "the successful frame is now readable");
  assertEq(out.seq, 42n, "the committed frame carries the decoder's payload");

  src.destroy();
  ok("11. (0.9.54) decoder throw aborts the push, unmaps, recycles, and recovers");
}

async function main(): Promise<void> {
  testDefaultResolvesToMapAsync();
  testAutoResolvesToMapAsync();
  testExplicitMapAsync();
  testExplicitSharedThrows();
  testValidationBeforeWriteTargetBuild();
  testEnvReportWebgpuZeroCopyFalse();
  await testOnErrorTransient();
  await testOnErrorFatal();
  await testNoOnErrorSilent();
  await testOnErrorUserThrowSwallowed();
  await testDecoderThrowRecovers();
  console.log("\nAll BridgeGPUSource.writeTarget.test.ts pins passed.");
}

main().catch((err) => {
  console.error("BridgeGPUSource.writeTarget.test.ts FAILED:", err);
  process.exit(1);
});
