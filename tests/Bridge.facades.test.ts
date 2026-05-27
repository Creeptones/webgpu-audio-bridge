/**
 * Bridge facades — split out of tests/Bridge.test.ts in 0.8.5.
 *
 * FrameSmoother / ConsumerClockRecovery / AdaptiveFlowController unit construction, BridgeGPUSource orchestration.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.facades.test.ts
 *
 * Pins (file-header pin numbers; see tests/Bridge.test.ts in 0.8.4 for the
 * original combined docstring with full per-pin descriptions):
 *  61. testFrameSmootherUnit
 *  62. testConsumerClockRecoveryUnit
 *  63. testAdaptiveFlowControllerUnit
 *  81. testBridgeGpuSourceOrchestration
 */

import {
  assert,
  assertEq,
  ok,
} from "./_assert.js";
import { AdaptiveFlowController } from "../src/AdaptiveFlowController.js";
import { Bridge } from "../src/Bridge.js";
import {
  BridgeGPUSource,
  type GpuBufferLike,
  type GpuCommandEncoderLike,
  type GpuDeviceLike,
} from "../src/BridgeGPUSource.js";
import { ConsumerClockRecovery } from "../src/ConsumerClockRecovery.js";
import { FrameSmoother } from "../src/FrameSmoother.js";
import {
  defineSchema,
  f64,
  f64Array,
  type FrameFor,
  u32,
  u64,
} from "../src/schema.js";


// ── 61. FrameSmoother unit (0.6.9) ─────────────────────────────────────────
function testFrameSmootherUnit(): void {
  // Tiny schema: 1 f64 scalar + 1 u32 scalar + 1 f64 array (length 3) so
  // the smoother walks both scalar and array paths, with integer-round
  // and float-blend dispatches both active.
  const schema = defineSchema({
    x: f64(),
    n: u32(),
    arr: f64Array(3),
  });
  type Frame = FrameFor<typeof schema>;
  const alloc = (): Frame => ({
    x: 0,
    n: 0,
    arr: new Float64Array(3),
  });
  const smoother = new FrameSmoother(schema, alloc);

  // First observe seeds prev — no blend.
  const a: Frame = { x: 10.0, n: 100, arr: new Float64Array([1, 2, 3]) };
  assertEq(smoother.currentPrevValid(), false, "smoother starts with no prev");
  smoother.observe(a as unknown as Record<string, unknown>, 0.5);
  assertEq(smoother.currentPrevValid(), true, "first observe seeds prev");
  assertEq(a.x, 10.0, "first observe leaves out untouched (float)");
  assertEq(a.n, 100, "first observe leaves out untouched (int)");
  assertEq(a.arr[0], 1, "first observe leaves out untouched (array)");

  // Second observe blends per α·curr + (1-α)·prev. α = 0.25.
  const b: Frame = { x: 20.0, n: 200, arr: new Float64Array([10, 20, 30]) };
  smoother.observe(b as unknown as Record<string, unknown>, 0.25);
  assertEq(b.x, 0.25 * 20.0 + 0.75 * 10.0, "blend float scalar");
  // Integer round: 0.25 * 200 + 0.75 * 100 = 125 → Math.round(125) = 125
  assertEq(b.n, Math.round(0.25 * 200 + 0.75 * 100), "blend integer scalar (rounded)");
  assertEq(b.arr[0], 0.25 * 10 + 0.75 * 1, "blend array[0]");
  assertEq(b.arr[1], 0.25 * 20 + 0.75 * 2, "blend array[1]");
  assertEq(b.arr[2], 0.25 * 30 + 0.75 * 3, "blend array[2]");

  // seedFrom replaces prev verbatim. Subsequent observe should blend
  // against the new prev, not the previously-blended one.
  const seed: Frame = { x: 999.0, n: 999, arr: new Float64Array([7, 8, 9]) };
  smoother.seedFrom(seed as unknown as Record<string, unknown>);
  const c: Frame = { x: 0.0, n: 0, arr: new Float64Array([0, 0, 0]) };
  smoother.observe(c as unknown as Record<string, unknown>, 0.5);
  assertEq(c.x, 0.5 * 0.0 + 0.5 * 999.0, "blend after seedFrom uses new prev");

  // fallbackInto copies prev into out + returns true.
  const out: Frame = { x: -1, n: 99, arr: new Float64Array([0, 0, 0]) };
  const ok1 = smoother.fallbackInto(out as unknown as Record<string, unknown>);
  assertEq(ok1, true, "fallbackInto returns true when prev valid");
  // After last observe, prev = (0.5 * 0 + 0.5 * 999) = 499.5 for x.
  assertEq(out.x, 499.5, "fallbackInto copies prev into out");

  // reset invalidates without freeing the buffer; next observe is a fresh seed.
  smoother.reset();
  assertEq(smoother.currentPrevValid(), false, "reset invalidates prev");
  const out2: Frame = { x: -1, n: 99, arr: new Float64Array([0, 0, 0]) };
  const ok2 = smoother.fallbackInto(out2 as unknown as Record<string, unknown>);
  assertEq(ok2, false, "fallbackInto returns false when prev invalid");
  assertEq(out2.x, -1, "fallbackInto leaves out untouched when invalid");

  const d: Frame = { x: 5.0, n: 50, arr: new Float64Array([4, 5, 6]) };
  smoother.observe(d as unknown as Record<string, unknown>, 0.5);
  assertEq(d.x, 5.0, "observe after reset seeds verbatim (no blend)");
  assertEq(smoother.currentPrevValid(), true, "observe re-seeds prev");

  ok("frame-smoother-unit");
}


// ── 62. ConsumerClockRecovery unit (0.6.9) ─────────────────────────────────
function testConsumerClockRecoveryUnit(): void {
  const pll = new ConsumerClockRecovery();
  // Cold start.
  assertEq(pll.locked, false, "pll cold start unlocked");
  assertEq(pll.offsetNs, 0, "pll cold start offset 0");
  assertEq(pll.phaseLockedTime(12345), 12345, "phaseLockedTime returns x unlocked");

  // First observe seeds exact offset, flips locked, integral=0.
  pll.observe(1000, 5000);
  assertEq(pll.locked, true, "first observe locks");
  assertEq(pll.offsetNs, 4000, "first observe seeds exact offset");
  assertEq(pll.phaseLockedTime(0), 4000, "phaseLockedTime adds offset");

  // Second observe runs PI: residual = (producer - consumer) - offset.
  // With producer=5200, consumer=1000 → residual = 4200 - 4000 = 200.
  // integral = 0 + 200 = 200. offset += KP·200 + KI·200 = 0.2*200 + 0.01*200 = 42.
  pll.observe(1000, 5200);
  // Floating-point — assert within epsilon. KP=0.2, KI=0.01 from
  // ConsumerClockRecovery static constants.
  const expectedOffset = 4000 + ConsumerClockRecovery.KP * 200 + ConsumerClockRecovery.KI * 200;
  assert(Math.abs(pll.offsetNs - expectedOffset) < 1e-9, `PI math: got ${pll.offsetNs}, want ${expectedOffset}`);

  // reset returns to cold state.
  pll.reset();
  assertEq(pll.locked, false, "reset unlocks");
  assertEq(pll.offsetNs, 0, "reset zeros offset");
  assertEq(pll.phaseLockedTime(12345), 12345, "reset restores identity");

  // Non-finite arguments throw.
  let threw = false;
  try { pll.observe(NaN, 0); } catch { threw = true; }
  assert(threw, "non-finite consumerNs throws");
  threw = false;
  try { pll.observe(0, Infinity); } catch { threw = true; }
  assert(threw, "non-finite producerNs throws");

  ok("consumer-clock-recovery-unit");
}


// ── 63. AdaptiveFlowController unit (0.6.9) ────────────────────────────────
function testAdaptiveFlowControllerUnit(): void {
  // Q16.16 encoding sanity.
  assertEq(AdaptiveFlowController.Q, 65536, "Q quantum is 65536");
  assertEq(AdaptiveFlowController.DEFAULT_Q, 65536, "default Q = 1.0 * 65536");
  assertEq(AdaptiveFlowController.MIN, 0.5, "MIN clamp = 0.5");
  assertEq(AdaptiveFlowController.MAX, 2.0, "MAX clamp = 2.0");

  // First tick on an empty ring (buffered=0, capacity=16) → occupancy=0,
  // err=-0.5, integral=-0.5; scale = 1 - KP·(-0.5) - KI·(-0.5)
  //                           = 1 + 0.5·0.5 + 0.05·0.5 = 1 + 0.25 + 0.025 = 1.275.
  const ctrl = new AdaptiveFlowController();
  const first = ctrl.tick(0, 16);
  const expectedScale = 1 + AdaptiveFlowController.KP * 0.5 + AdaptiveFlowController.KI * 0.5;
  assertEq(first, Math.floor(expectedScale * AdaptiveFlowController.Q), "first tick Q16.16 matches formula");

  // Full ring sustained — controller saturates to MIN.
  const fresh = new AdaptiveFlowController();
  let lastScale = 0;
  for (let i = 0; i < 100; i++) {
    lastScale = fresh.tick(16, 16);
  }
  assertEq(lastScale, Math.floor(AdaptiveFlowController.MIN * AdaptiveFlowController.Q),
    "sustained full-ring saturates at MIN clamp");

  // Reset zeros integrator; first tick after reset matches the very-first
  // tick of a brand-new controller.
  const r = new AdaptiveFlowController();
  for (let i = 0; i < 50; i++) r.tick(16, 16); // drive into saturation
  r.reset();
  const afterReset = r.tick(0, 16);
  assertEq(afterReset, first, "tick after reset matches fresh first tick");

  ok("adaptive-flow-controller-unit");
}


// ── 81. BridgeGPUSource orchestration (0.6.18) ───────────────────────────
async function testBridgeGpuSourceOrchestration(): Promise<void> {
  // Mock WebGPU device. Each buffer holds its own ArrayBuffer; the
  // map promises are user-controlled via a deferred-resolve handle so
  // the test can simulate "in-flight" cleanly.
  interface MockBuffer extends GpuBufferLike {
    backing: ArrayBuffer;
    mapped: boolean;
    destroyed: boolean;
    pendingResolve: (() => void) | null;
  }
  let bufferCounter = 0;
  const allBuffers: MockBuffer[] = [];
  const mockDevice: GpuDeviceLike = {
    createBuffer(desc) {
      const backing = new ArrayBuffer(desc.size);
      const buf: MockBuffer = {
        size: desc.size,
        backing,
        mapped: false,
        destroyed: false,
        pendingResolve: null,
        mapAsync(_mode) {
          if (this.destroyed) {
            return Promise.reject(new Error("destroyed"));
          }
          return new Promise<undefined>((resolve) => {
            // Don't resolve immediately — let the test trigger it.
            this.pendingResolve = () => {
              this.mapped = true;
              resolve(undefined);
            };
          });
        },
        getMappedRange(offset, size) {
          assert(this.mapped, `getMappedRange called on unmapped buffer`);
          return this.backing.slice(
            offset ?? 0,
            (offset ?? 0) + (size ?? this.backing.byteLength),
          );
        },
        unmap() {
          this.mapped = false;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      bufferCounter++;
      allBuffers.push(buf);
      return buf;
    },
  };
  let copyCallCount = 0;
  const mockEncoder: GpuCommandEncoderLike = {
    copyBufferToBuffer(_src, _so, dst, _do, _size) {
      // Write a deterministic pattern into the staging buffer so the
      // decoder can read it back.
      const bytes = new Uint8Array((dst as MockBuffer).backing);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = (copyCallCount + i) & 0xff;
      }
      copyCallCount++;
    },
  };

  // Tiny schema for a clean round-trip.
  const schema = defineSchema({
    seq: u64(),
    payload: f64Array(2),
  });
  const { sab, capacity } = Bridge.allocate(4, schema);
  const bridge = new Bridge(sab, capacity, schema);

  // The decoder reads the first u64 as `seq` and the next 16 bytes as
  // two f64 doubles. Since the mock encoder fills with a pattern based
  // on copyCallCount, every readback is unique.
  const decoder = (mappedRange: ArrayBuffer, frame: FrameFor<typeof schema>) => {
    const view = new DataView(mappedRange);
    frame.seq = view.getBigUint64(0, true);
    frame.payload.set(new Float64Array(mappedRange, 8, 2));
  };

  // (a) Construction sanity.
  const src = new BridgeGPUSource(mockDevice, bridge, decoder, {
    stagingBufferCount: 3,
    bufferLabelPrefix: "test",
  });
  assertEq(bufferCounter, 3, "constructor builds 3 staging buffers");
  assertEq(src.capacity(), 3, "src.capacity() = 3");
  assertEq(src.inFlight(), 0, "initially no buffers in flight");

  // (b) Validation: stagingBufferCount < 2 throws.
  let threw = false;
  try {
    new BridgeGPUSource(mockDevice, bridge, decoder, { stagingBufferCount: 1 });
  } catch {
    threw = true;
  }
  assert(threw, "stagingBufferCount=1 throws");
  threw = false;
  try {
    new BridgeGPUSource(mockDevice, bridge, decoder, { stagingBufferSize: 0 });
  } catch {
    threw = true;
  }
  assert(threw, "stagingBufferSize=0 throws");

  // (c) Schedule 2 readbacks — both should succeed.
  const fakeSrcBuffer = mockDevice.createBuffer({ size: schema.frameByteSize, usage: 0 });
  const r1 = src.scheduleReadback(fakeSrcBuffer, mockEncoder);
  const r2 = src.scheduleReadback(fakeSrcBuffer, mockEncoder);
  assertEq(r1, true, "1st scheduleReadback returns true");
  assertEq(r2, true, "2nd scheduleReadback returns true");
  assertEq(src.inFlight(), 2, "2 buffers scheduled");

  // (d) Schedule 2 more — first succeeds (3rd available), second fails
  // (all 3 in flight).
  const r3 = src.scheduleReadback(fakeSrcBuffer, mockEncoder);
  const r4 = src.scheduleReadback(fakeSrcBuffer, mockEncoder);
  assertEq(r3, true, "3rd scheduleReadback returns true");
  assertEq(r4, false, "4th scheduleReadback returns false (full)");
  assertEq(src.inFlight(), 3, "all 3 buffers in flight");

  // (e) flushPending starts mapAsync. Nothing should be 'mapped' yet
  // (the mock holds pending resolves).
  src.flushPending();
  // The mock buffers should now each have a pendingResolve.
  // (allBuffers[0..2] are the staging buffers; allBuffers[3] is fakeSrcBuffer.)
  for (let i = 0; i < 3; i++) {
    assert(
      (allBuffers[i] as MockBuffer).pendingResolve !== null,
      `staging buffer ${i} has pending mapAsync`,
    );
  }

  // (f) pollCompleted before any mapAsync resolves — nothing pushed.
  const polled0 = src.pollCompleted();
  assertEq(polled0, 0, "no polls completed before resolves");
  assertEq(src.pushedCount(), 0, "no pushes yet");

  // (g) Resolve all three mapAsyncs in order; yield to microtasks.
  for (let i = 0; i < 3; i++) {
    (allBuffers[i] as MockBuffer).pendingResolve!();
  }
  // Yield twice — the .then handlers need to run to flip slot.mapped.
  await Promise.resolve();
  await Promise.resolve();
  const polled1 = src.pollCompleted();
  assertEq(polled1, 3, "all 3 readbacks completed");
  assertEq(src.pushedCount(), 3, "pushedCount = 3 after poll");
  assertEq(src.droppedCount(), 0, "no drops");
  assertEq(src.inFlight(), 0, "all buffers back to idle");
  // Bridge should have 3 frames buffered.
  const tel = bridge.telemetry();
  assertEq(tel.available, 3, "3 frames in bridge");
  // Verify the decoder ran — pull and check seq.
  const out = bridge.scratchFrame();
  let pullCount = 0;
  while (bridge.pull(out)) pullCount++;
  assertEq(pullCount, 3, "drained 3 frames from bridge");

  // (h) destroy — buffers marked destroyed.
  src.destroy();
  for (let i = 0; i < 3; i++) {
    assertEq(
      (allBuffers[i] as MockBuffer).destroyed,
      true,
      `staging buffer ${i} destroyed`,
    );
  }

  ok("bridge-gpu-source-orchestration");
}

async function main(): Promise<void> {
  testFrameSmootherUnit();
  testConsumerClockRecoveryUnit();
  testAdaptiveFlowControllerUnit();
  await testBridgeGpuSourceOrchestration();
  console.log("\nAll Bridge facades tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
