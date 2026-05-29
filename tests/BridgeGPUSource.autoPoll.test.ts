/**
 * BridgeGPUSource autoPollCompleted: "microtask" — auto-drain on mapAsync
 * resolution (0.9.67).
 *
 * By default a resolved `mapAsync` only flips a slot's `mapped` flag; the
 * decode + push waits for the caller's next `pollCompleted()`. If that poll
 * runs once per ~60 Hz tick, a completed readback can sit idle for up to a full
 * frame — a cadence tax on top of the unavoidable `mapAsync` floor. With
 * `autoPollCompleted: "microtask"` the slot drains itself in the resolving
 * microtask, so the frame reaches the SAB immediately and the slot recycles
 * sooner. This does NOT make `mapAsync` faster; it removes the helper's own
 * scheduling delay.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/BridgeGPUSource.autoPoll.test.ts
 *
 * Pins:
 *  1. testAutoDrainPushesWithoutPoll  — frame lands after microtasks WITHOUT
 *                                       any pollCompleted() call; autoPollMode()
 *                                       reports 'microtask'; slot recycled
 *  2. testManualDefaultStillWaits     — default mode does NOT auto-drain; the
 *                                       frame only lands on pollCompleted()
 *  3. testPollAfterAutoIsNoop         — pollCompleted() after an auto-drain is a
 *                                       redundant no-op (no double push)
 *  4. testAutoDrainErrorRecycles      — a rejected beginMap auto-recycles the
 *                                       slot + ticks droppedCount + fires onError
 *  5. testDestroyGuardsLateMicrotask  — destroy() before the resolving microtask
 *                                       runs makes the drain bail (no throw, no
 *                                       push against a destroyed buffer)
 *  6. testInvalidModeThrows           — bad autoPollCompleted value throws at
 *                                       construction with no buffers leaked
 *  7. testClosureAutoDrain            — auto-drain works in closure mode too
 *
 * No GPU is required; the tests use tiny mock `GpuDeviceLike`s with controllable
 * mapAsync resolution.
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

/** Encode one frame to a standalone ArrayBuffer matching the SAB byte layout. */
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

/** Mock device whose mapAsync resolution is either immediate (default) or
 *  externally gated via a returned `resolveAll` trigger, and whose
 *  getMappedRange hands back a fresh copy of `frameBytes`. */
function makeGatedMockDevice(frameBytes: ArrayBuffer, opts: {
  gated?: boolean;
  reject?: boolean;
  onUnmap?: () => void;
} = {}): { device: GpuDeviceLike; resolveAll: () => void } {
  const pendingResolvers: Array<() => void> = [];
  const device: GpuDeviceLike = {
    createBuffer(desc) {
      const buf: GpuBufferLike = {
        size: desc.size,
        mapAsync: () => {
          if (opts.reject) return Promise.reject(new Error("mapAsync rejected"));
          if (!opts.gated) return Promise.resolve(undefined);
          return new Promise<undefined>((res) => {
            pendingResolvers.push(() => res(undefined));
          });
        },
        getMappedRange: () => frameBytes.slice(0),
        unmap: () => { if (opts.onUnmap) opts.onUnmap(); },
        destroy: () => {},
      };
      return buf;
    },
  };
  return {
    device,
    resolveAll: () => {
      const rs = pendingResolvers.splice(0);
      for (const r of rs) r();
    },
  };
}

// ── 1. Auto-drain pushes the frame with no pollCompleted() call ─────────────
async function testAutoDrainPushesWithoutPoll(): Promise<void> {
  const F: Frame = { seq: 42n, payload: new Float64Array([9.5, -8.25]) };
  const { device } = makeGatedMockDevice(encodeFrame(F));
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, "raw", {
    stagingBufferCount: 2,
    autoPollCompleted: "microtask",
  });

  assertEq(src.autoPollMode(), "microtask", "autoPollMode reports 'microtask'");

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  // Deliberately DO NOT call pollCompleted — the microtask must drain it.
  await flushMicrotasks();

  assertEq(src.pushedCount(), 1, "frame pushed by the resolution microtask alone");
  assertEq(src.droppedCount(), 0, "nothing dropped");
  assertEq(src.inFlight(), 0, "slot recycled to idle by the microtask");

  const out: Frame = { seq: 0n, payload: new Float64Array(2) };
  assert(bridge.pull(out), "frame readable after auto-drain");
  assertEq(out.seq, 42n, "seq round-trips");
  assertEq(out.payload[0], 9.5, "payload[0] round-trips");

  src.destroy();
  ok("1. microtask mode drains a readback with no pollCompleted() call");
}

// ── 2. Manual (default) mode does NOT auto-drain ────────────────────────────
async function testManualDefaultStillWaits(): Promise<void> {
  const F: Frame = { seq: 1n, payload: new Float64Array([1, 2]) };
  const { device } = makeGatedMockDevice(encodeFrame(F));
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, "raw", { stagingBufferCount: 2 });

  assertEq(src.autoPollMode(), "manual", "default autoPollMode is 'manual'");

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();

  // Without auto-drain, the microtask only flips the flag — nothing pushed yet.
  assertEq(src.pushedCount(), 0, "manual mode does not push until pollCompleted()");
  assertEq(src.inFlight(), 1, "slot still in-flight (mapped, awaiting poll)");

  const pushed = src.pollCompleted();
  assertEq(pushed, 1, "pollCompleted() drains the ready slot");
  assertEq(src.pushedCount(), 1, "frame pushed on explicit poll");
  assertEq(src.inFlight(), 0, "slot recycled after poll");

  src.destroy();
  ok("2. default 'manual' mode waits for pollCompleted() (regression guard)");
}

// ── 3. pollCompleted() after an auto-drain is a no-op (no double push) ──────
async function testPollAfterAutoIsNoop(): Promise<void> {
  const F: Frame = { seq: 5n, payload: new Float64Array([0, 0]) };
  const { device } = makeGatedMockDevice(encodeFrame(F));
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, "raw", {
    stagingBufferCount: 2,
    autoPollCompleted: "microtask",
  });

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();
  assertEq(src.pushedCount(), 1, "auto-drained once");

  // A belt-and-braces poll must not push the same readback again.
  const extra = src.pollCompleted();
  assertEq(extra, 0, "pollCompleted after auto-drain pushes nothing");
  assertEq(src.pushedCount(), 1, "pushedCount unchanged by the redundant poll");

  src.destroy();
  ok("3. pollCompleted() after auto-drain is a safe no-op (no double push)");
}

// ── 4. A rejected beginMap auto-recycles + ticks droppedCount + onError ─────
async function testAutoDrainErrorRecycles(): Promise<void> {
  const F: Frame = { seq: 0n, payload: new Float64Array([0, 0]) };
  const { device } = makeGatedMockDevice(encodeFrame(F), { reject: true });
  const bridge = makeBridge();
  const captured: Array<{ kind: string }> = [];
  const src = new BridgeGPUSource(device, bridge, "raw", {
    stagingBufferCount: 2,
    autoPollCompleted: "microtask",
    onError: (_err, kind) => captured.push({ kind }),
  });

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();

  assertEq(src.pushedCount(), 0, "rejected readback pushes nothing");
  assertEq(src.droppedCount(), 1, "drop counter ticked on rejection");
  assertEq(src.inFlight(), 0, "slot auto-recycled despite the rejection");
  assert(captured.length >= 1, "onError fired for the rejection");
  assertEq(captured[0]!.kind, "transient", "rejection classified transient (device not lost)");

  src.destroy();
  ok("4. microtask mode auto-recycles a rejected readback + fires onError");
}

// ── 5. destroy() before the resolving microtask makes the drain bail ────────
async function testDestroyGuardsLateMicrotask(): Promise<void> {
  const F: Frame = { seq: 7n, payload: new Float64Array([3, 4]) };
  let unmapCalls = 0;
  const { device, resolveAll } = makeGatedMockDevice(encodeFrame(F), {
    gated: true,
    onUnmap: () => { unmapCalls++; },
  });
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, "raw", {
    stagingBufferCount: 2,
    autoPollCompleted: "microtask",
  });

  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  // mapAsync is gated — not resolved yet. Destroy first, THEN resolve so the
  // drain microtask fires after destroy() and must bail.
  src.destroy();
  resolveAll();
  await flushMicrotasks();

  assertEq(src.pushedCount(), 0, "no push after destroy()");
  assertEq(unmapCalls, 0, "destroyed source never unmaps in the late microtask");

  ok("5. destroy() guard makes a late auto-drain microtask bail cleanly");
}

// ── 6. Invalid autoPollCompleted throws at construction ─────────────────────
function testInvalidModeThrows(): void {
  const { device } = makeGatedMockDevice(new ArrayBuffer(FRAME_BYTES));
  const bridge = makeBridge();
  let created = 0;
  const countingDevice: GpuDeviceLike = {
    createBuffer(desc) { created++; return device.createBuffer(desc); },
  };
  let threw: unknown;
  try {
    new BridgeGPUSource(countingDevice, bridge, "raw", {
      // @ts-expect-error — deliberately invalid value
      autoPollCompleted: "eager",
    });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error, "invalid autoPollCompleted throws");
  assert(
    String((threw as Error).message).includes("autoPollCompleted"),
    "error names the offending option",
  );
  assertEq(created, 0, "no staging buffers allocated before the validation throw");
  ok("6. invalid autoPollCompleted throws at construction with no leaks");
}

// ── 7. Auto-drain works in closure mode too ─────────────────────────────────
async function testClosureAutoDrain(): Promise<void> {
  const F: Frame = { seq: 11n, payload: new Float64Array([6.5, 7.5]) };
  const { device } = makeGatedMockDevice(encodeFrame(F));
  const bridge = makeBridge();
  let decoderCalls = 0;
  const src = new BridgeGPUSource(
    device,
    bridge,
    (range, frame) => {
      decoderCalls++;
      const dv = new DataView(range);
      frame.seq = dv.getBigUint64(0, true);
      frame.payload[0] = dv.getFloat64(8, true);
      frame.payload[1] = dv.getFloat64(16, true);
    },
    { stagingBufferCount: 2, autoPollCompleted: "microtask" },
  );

  assertEq(src.decoderMode(), "closure", "closure decoder mode");
  src.scheduleReadback(dummySrcBuffer, noopEncoder);
  src.flushPending();
  await flushMicrotasks();

  assertEq(decoderCalls, 1, "decoder ran in the resolution microtask");
  assertEq(src.pushedCount(), 1, "closure-decoded frame auto-pushed");
  const out: Frame = { seq: 0n, payload: new Float64Array(2) };
  assert(bridge.pull(out), "closure frame readable");
  assertEq(out.seq, 11n, "closure seq round-trips");
  assertEq(out.payload[1], 7.5, "closure payload round-trips");

  src.destroy();
  ok("7. auto-drain runs the user decoder in closure mode too");
}

async function main(): Promise<void> {
  await testAutoDrainPushesWithoutPoll();
  await testManualDefaultStillWaits();
  await testPollAfterAutoIsNoop();
  await testAutoDrainErrorRecycles();
  await testDestroyGuardsLateMicrotask();
  testInvalidModeThrows();
  await testClosureAutoDrain();
  console.log("\nAll BridgeGPUSource.autoPoll tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
