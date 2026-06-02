/**
 * BridgeGPUSource decoder-path benchmark.
 *
 * Compares the full local publish path for:
 *   1. JS closure decoder
 *   2. BridgeGPUSource.wasmDecoder with an actual emitWasmDecoder export
 *   3. raw pushRaw mode
 *
 * This is not a real GPU benchmark. The mock device resolves mapAsync
 * immediately and returns stable frame bytes, so the measured cost is the
 * bridge-side scheduling, map-completion drain, push, and decode overhead.
 */

import { hrtime } from "node:process";
import wabtInit from "wabt";
import {
  Bridge,
  BridgeGPUSource,
  RING_HEADER_BYTES,
  defineSchema,
  emitWasmDecoder,
  f64Array,
  planWasmDecoder,
  u64,
  type FrameFor,
  type GpuBufferLike,
  type GpuCommandEncoderLike,
  type GpuDeviceLike,
  type GpuReadbackDecoder,
} from "../src/index.js";

const schema = defineSchema({
  seq: u64(),
  payload: f64Array(2),
});
type Frame = FrameFor<typeof schema>;

const WARMUP = 1_000;
const ITERATIONS = 10_000;

const dummySrcBuffer: GpuBufferLike = {
  size: 0,
  mapAsync: () => Promise.resolve(undefined),
  getMappedRange: () => new ArrayBuffer(0),
  unmap: () => {},
  destroy: () => {},
};

const noopEncoder: GpuCommandEncoderLike = {
  copyBufferToBuffer() {},
};

function encodeFrame(frame: Frame): ArrayBuffer {
  const { sab, capacity } = Bridge.allocate(2, schema);
  const bridge = new Bridge(sab, capacity, schema);
  if (!bridge.push(frame)) throw new Error("encodeFrame: source push failed");
  const out = new ArrayBuffer(schema.frameByteSize);
  new Uint8Array(out).set(new Uint8Array(sab, RING_HEADER_BYTES, schema.frameByteSize));
  return out;
}

function makeImmediateMapDevice(frameBytes: ArrayBuffer): GpuDeviceLike {
  return {
    createBuffer(desc) {
      return {
        size: desc.size,
        mapAsync: () => Promise.resolve(undefined),
        getMappedRange: () => frameBytes.slice(0),
        unmap: () => {},
        destroy: () => {},
      };
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function publishOne(source: BridgeGPUSource<typeof schema>): Promise<void> {
  if (!source.scheduleReadback(dummySrcBuffer, noopEncoder)) {
    throw new Error("scheduleReadback rejected unexpectedly");
  }
  source.flushPending();
  await flushMicrotasks();
  if (source.pollCompleted() !== 1) {
    throw new Error("pollCompleted did not publish one frame");
  }
}

function makeBridge(totalPushes: number): Bridge<typeof schema> {
  let requested = 1;
  while (requested < totalPushes + 16) requested <<= 1;
  const { sab, capacity } = Bridge.allocate(requested, schema);
  return new Bridge(sab, capacity, schema);
}

function makeJsDecoder(): GpuReadbackDecoder<typeof schema> {
  return (range, frame) => {
    const view = new DataView(range);
    frame.seq = view.getBigUint64(0, true);
    frame.payload[0] = view.getFloat64(8, true);
    frame.payload[1] = view.getFloat64(16, true);
  };
}

async function makeWasmDecoder(): Promise<GpuReadbackDecoder<typeof schema>> {
  const wabt = await wabtInit();
  const mod = wabt.parseWat("gpu-readback-decoder-path.wat", emitWasmDecoder(schema), {
    bulk_memory: true,
  });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();

  const wasmBytes = new Uint8Array(buffer.byteLength);
  wasmBytes.set(buffer);

  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes.buffer), {
    env: { memory },
  });
  return BridgeGPUSource.wasmDecoder(schema, {
    memory,
    decodeFrame: instance.exports.decode_frame as (srcBase: number, dstBase: number) => void,
    plan: planWasmDecoder(schema),
    srcByteOffset: 0,
    dstByteOffset: 256,
  });
}

function fmtOps(opsPerSec: number): string {
  if (opsPerSec >= 1_000_000) return `${(opsPerSec / 1_000_000).toFixed(2)}M ops/sec`;
  if (opsPerSec >= 1_000) return `${(opsPerSec / 1_000).toFixed(2)}K ops/sec`;
  return `${opsPerSec.toFixed(0)} ops/sec`;
}

async function bench(
  label: string,
  decoder: GpuReadbackDecoder<typeof schema> | "raw",
  frameBytes: ArrayBuffer,
): Promise<{ label: string; elapsedMs: number; opsPerSec: number; pushed: number; mode: string }> {
  const bridge = makeBridge(WARMUP + ITERATIONS);
  const source = new BridgeGPUSource(
    makeImmediateMapDevice(frameBytes),
    bridge,
    decoder,
    { stagingBufferCount: 2 },
  );

  for (let i = 0; i < WARMUP; i++) await publishOne(source);

  const t0 = hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) await publishOne(source);
  const t1 = hrtime.bigint();

  const elapsedMs = Number(t1 - t0) / 1_000_000;
  const opsPerSec = ITERATIONS / (elapsedMs / 1000);
  const result = {
    label,
    elapsedMs,
    opsPerSec,
    pushed: source.pushedCount(),
    mode: source.decoderMode(),
  };
  source.destroy();
  return result;
}

async function main(): Promise<void> {
  const frameBytes = encodeFrame({
    seq: 123n,
    payload: new Float64Array([4.25, -5.5]),
  });
  const wasmDecoder = await makeWasmDecoder();
  const rows = [
    await bench("js closure decoder", makeJsDecoder(), frameBytes),
    await bench("wasmDecoder adapter", wasmDecoder, frameBytes),
    await bench("raw pushRaw", "raw", frameBytes),
  ];

  console.log("BridgeGPUSource decoder-path bench");
  console.log(`schema.frameByteSize=${schema.frameByteSize} B, iterations=${ITERATIONS}, warmup=${WARMUP}`);
  console.table(rows.map((row) => ({
    label: row.label,
    mode: row.mode,
    pushed: row.pushed,
    elapsedMs: Number(row.elapsedMs.toFixed(3)),
    opsPerSec: Math.round(row.opsPerSec),
    rate: fmtOps(row.opsPerSec),
  })));
  console.log(
    "\nNote: this benchmark uses immediate mock mapAsync. Real browser GPU readback is dominated by mapAsync latency.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
