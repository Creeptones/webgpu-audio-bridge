import { Bridge, BridgeGPUSource, defineSchema, u32 } from "../src/index.js";
import type { GpuBufferLike, GpuCommandEncoderLike, GpuDeviceLike } from "../src/index.js";

const schema = defineSchema({ seq: u32() });
const ITERATIONS = 200_000;

interface MockBuffer extends GpuBufferLike {
  destroyed: boolean;
}

function makeDevice(): GpuDeviceLike {
  return {
    createBuffer(desc) {
      const buffer: MockBuffer = {
        size: desc.size,
        destroyed: false,
        mapAsync: () => new Promise<undefined>(() => {}),
        getMappedRange: (_offset, size) => new ArrayBuffer(size ?? desc.size),
        unmap: () => {},
        destroy() { this.destroyed = true; },
      };
      return buffer;
    },
  };
}

const sourceBuffer: GpuBufferLike = {
  size: 4,
  mapAsync: () => Promise.resolve(undefined),
  getMappedRange: () => new ArrayBuffer(4),
  unmap: () => {},
  destroy: () => {},
};

const encoder: GpuCommandEncoderLike = {
  copyBufferToBuffer() {},
};

function makeBridge() {
  const { sab, capacity } = Bridge.allocate(8, schema);
  return new Bridge(sab, capacity, schema);
}

function run(label: string, opts: { pacing?: "manual" | "adaptive" }) {
  const bridge = makeBridge();
  const gpu = new BridgeGPUSource(makeDevice(), bridge, () => {}, {
    stagingBufferCount: 8,
    pacing: opts.pacing ?? "manual",
  });
  let accepted = 0;
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    if (gpu.scheduleReadback(sourceBuffer, encoder)) accepted++;
  }
  const elapsedMs = performance.now() - start;
  const rejected = ITERATIONS - accepted;
  const pressure = gpu.readbackPressure();
  gpu.destroy();
  return {
    label,
    iterations: ITERATIONS,
    accepted,
    rejected,
    pacingDeclined: pressure.pacingDeclined,
    inFlight: pressure.inFlight,
    capacity: pressure.capacity,
    elapsedMs,
    opsPerSec: Math.round((ITERATIONS / elapsedMs) * 1000),
  };
}

function main(): void {
  const manual = run("manual", { pacing: "manual" });
  const adaptive = run("adaptive", { pacing: "adaptive" });
  console.table([manual, adaptive]);
}

main();
