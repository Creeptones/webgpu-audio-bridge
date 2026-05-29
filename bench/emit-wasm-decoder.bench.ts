/**
 * emit-wasm-decoder microbenchmark — generic vs monomorphized whole-frame decode.
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/emit-wasm-decoder.bench.ts   (or `npm run bench:emit-wasm-decoder`)
 *
 * ─── What this measures ─────────────────────────────────────────────────────
 *
 * The packaged `decode_frame` (0.9.74) is GENERIC: one binary decodes any
 * schema by looping a runtime `(srcRel, dstAbs, byteCount)` descriptor table —
 * one loop iteration + three `i32.load`s + one `memory.copy` per field.
 *
 * `emitWasmDecoder(schema)` (0.9.78) is MONOMORPHIZED: offsets are baked to
 * literals and contiguous fields coalesce, so a typical frame decodes in a
 * SINGLE `memory.copy`. The single-arg form additionally bakes the frame
 * stride + scratch base, so the call site passes only the slot index.
 *
 * This bench quantifies the decode-only cost (SPSC atomics excluded — identical
 * across strategies) for a realistic ~1.6 KB macro frame:
 *
 *   G   generic decode_frame      — descriptor-loop, (slotBase, descPtr, n).
 *   M1  generated (slotBase,dst)  — coalesced copies, two params.
 *   M2  generated single-arg      — decode_frame(slot); stride + dst baked.
 *
 * Timing harness mirrors bench/decode-path.bench.ts (hrtime.bigint, warmup +
 * measure, p50/p99/mean). Each cell decodes the SAME fixed slot repeatedly.
 */

import { hrtime } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import wabtInit from "wabt";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  describeSchemaLayout,
  f64, u64, u32, i32,
  f64Array, f32Array, f64TrajectoryArray,
} from "../src/schema.js";
import {
  allocateWorkletMemory,
  instantiateConsumer,
  buildFrameDescriptors,
  slotByteBase,
  hasWasmConsumerSupport,
} from "../src/worklet/index.js";
import { emitWasmDecoder, planWasmDecoder } from "../src/emitWasmDecoder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, "..", "dist", "worklet", "decoder.wasm");

const ARRAY_N = 64;
const TRAJ_N = 64;
// Large macro frame (~1.8 KB) — payload is memcpy-dominated, so the descriptor-
// loop overhead is a small fraction; the monomorphization win is conservative.
const macroSchema = defineSchema({
  seq: u64(),
  tMacroNs: u64(),
  vMax: f64(),
  jMax: f64(),
  flags: u32(),
  mode: i32(),
  vEff: f64Array(ARRAY_N),
  gEff: f32Array(ARRAY_N),
  traj: f64TrajectoryArray(TRAJ_N, { order: 2 }),
});
// Tiny control frame (24 B) — almost no bytes to move, so the per-field loop
// overhead DOMINATES; this is where monomorphization pays off most.
const controlSchema = defineSchema({
  seq: u64(),
  tNs: u64(),
  value: f64(),
});

const CAPACITY = 16;
const WARMUP_ITERS = 20_000;
// Batched timing: each sample brackets BATCH decodes and divides, so the
// per-op cost resolves below the host hrtime tick (~100 ns on Windows).
const BATCH = 256;
const MEASURE_SAMPLES = 2_000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx]!;
}
function mean(arr: number[]): number {
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}
function fmt(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  return `${(ns / 1000).toFixed(2)} μs`;
}
/** Batched per-op timing: each of `samples` measurements brackets `batch`
 *  calls and divides, so resolution drops below the host hrtime tick. */
function time(samples: number, batch: number, fn: (i: number) => void): number[] {
  const out = new Array<number>(samples);
  let i = 0;
  for (let s = 0; s < samples; s++) {
    const t0 = hrtime.bigint();
    for (let b = 0; b < batch; b++) fn(i++);
    const t1 = hrtime.bigint();
    out[s] = Number(t1 - t0) / batch;
  }
  return out;
}
function summarize(name: string, note: string, samples: number[]) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    name, note,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    mean: mean(samples),
  };
}

type AnySchema = typeof macroSchema | typeof controlSchema;
type Compile = (wat: string) => Uint8Array<ArrayBuffer>;
const pad = (s: string, n: number) => s.padEnd(n);

/** Bench one schema: generic descriptor-loop decode vs the two generated
 *  monomorphic forms, decode-only against a stable slot 0. Each gets its OWN
 *  WASM memory + Bridge so the schemas don't share a SAB. */
function runBench(
  label: string,
  schema: AnySchema,
  fill: (frame: Record<string, unknown>) => void,
  compile: Compile,
  packaged: Uint8Array<ArrayBuffer>,
): void {
  const layout = describeSchemaLayout(schema);
  const frameBytes = schema.frameByteSize;
  const sabBytes = Bridge.byteLength(CAPACITY, schema);
  const plan0 = planWasmDecoder(layout);
  const probe = buildFrameDescriptors(layout, 0);
  const descBytes = probe.descCount * 12;

  const alloc = allocateWorkletMemory({
    sabBytes,
    scratchBytes: descBytes + probe.totalDstBytes + 64,
  });
  const descPtr = alloc.scratchByteOffset!;
  const decodedBase = (descPtr + descBytes + 7) & ~7;
  const plan = buildFrameDescriptors(layout, decodedBase);
  new Int32Array(alloc.sab, descPtr, plan.words.length).set(plan.words);

  const bridge = new Bridge(alloc.sab, CAPACITY, schema);
  const consumer = instantiateConsumer(packaged, alloc.memory);

  const m1 = new WebAssembly.Instance(
    new WebAssembly.Module(compile(emitWasmDecoder(layout))),
    { env: { memory: alloc.memory } },
  );
  const decodeM1 = m1.exports.decode_frame as (slotBase: number, dstBase: number) => void;
  const m2 = new WebAssembly.Instance(
    new WebAssembly.Module(compile(emitWasmDecoder(layout, { slotInput: "slotIndex", dstBase: decodedBase }))),
    { env: { memory: alloc.memory } },
  );
  const decodeM2 = m2.exports.decode_frame as (slot: number) => void;

  const frame = bridge.scratchFrame() as unknown as Record<string, unknown>;
  fill(frame);
  for (let s = 0; s < CAPACITY; s++) { frame.seq = BigInt(s); bridge.push(frame as never); }
  const slot0Base = slotByteBase(0, frameBytes);

  for (let i = 0; i < WARMUP_ITERS; i++) {
    consumer.decodeFrame(slot0Base, descPtr, plan.descCount);
    decodeM1(slot0Base, decodedBase);
    decodeM2(0);
  }

  const results = [
    summarize("G  generic decode_frame", `${probe.descCount}-field descriptor loop`,
      time(MEASURE_SAMPLES, BATCH, () => consumer.decodeFrame(slot0Base, descPtr, plan.descCount))),
    summarize("M1 generated (slotBase,dst)", `${plan0.copies.length} memory.copy`,
      time(MEASURE_SAMPLES, BATCH, () => decodeM1(slot0Base, decodedBase))),
    summarize("M2 generated single-arg", `${plan0.copies.length} copy, stride+dst baked`,
      time(MEASURE_SAMPLES, BATCH, () => decodeM2(0))),
  ];

  console.log(
    `\n── ${label} — ${probe.descCount} fields, frameByteSize=${frameBytes} ` +
      `(${frameBytes >= 1024 ? `~${(frameBytes / 1024).toFixed(1)} KB` : `${frameBytes} B`}), ` +
      `payload=${probe.totalDstBytes} B, ${(MEASURE_SAMPLES * BATCH).toLocaleString()} decodes\n`,
  );
  console.log(pad("cell", 30), pad("note", 34), pad("p50", 10), pad("p99", 10), "mean");
  console.log("-".repeat(94));
  for (const r of results) {
    console.log(pad(r.name, 30), pad(r.note, 34), pad(fmt(r.p50), 10), pad(fmt(r.p99), 10), fmt(r.mean));
  }
  const g = results[0]!, m2r = results[2]!;
  console.log(
    `→ single-arg vs generic: ${(g.p50 / m2r.p50).toFixed(2)}× p50 ` +
      `(${fmt(g.p50)}→${fmt(m2r.p50)}), ${(g.p99 / m2r.p99).toFixed(2)}× p99 ` +
      `(${fmt(g.p99)}→${fmt(m2r.p99)}); ${probe.descCount} fields → ${plan0.copies.length} copy.`,
  );
}

async function main(): Promise<void> {
  if (!hasWasmConsumerSupport()) {
    console.error("emit-wasm-decoder.bench: runtime lacks WASM SIMD/threads — cannot bench.");
    process.exit(1);
  }
  const wabt = await wabtInit();
  const compile: Compile = (wat) => {
    const mod = wabt.parseWat("bench.wat", wat, { simd: true, threads: true, bulk_memory: true });
    const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
    mod.destroy();
    const out = new Uint8Array(buffer.byteLength);
    out.set(buffer);
    return out;
  };
  const packaged = (() => {
    const b = readFileSync(wasmPath);
    const u = new Uint8Array(b.byteLength); u.set(b); return u;
  })();

  console.log("emit-wasm-decoder bench — generic descriptor loop vs monomorphized decode");

  runBench("MACRO frame (memcpy-bound)", macroSchema, (f) => {
    const vEff = f.vEff as Float64Array, gEff = f.gEff as Float32Array, traj = f.traj as Float64Array;
    for (let k = 0; k < ARRAY_N; k++) { vEff[k] = Math.sin(k * 0.013) * 1000; gEff[k] = Math.fround(Math.cos(k * 0.021)); }
    for (let k = 0; k < TRAJ_N * 2; k++) traj[k] = k * 0.5;
    f.tMacroNs = 0n; f.vMax = 1.5; f.jMax = -2.5; f.flags = 0xdeadbeef; f.mode = 3;
  }, compile, packaged);

  runBench("CONTROL frame (overhead-bound)", controlSchema, (f) => {
    f.tNs = 0n; f.value = 1.5;
  }, compile, packaged);

  console.log(
    "\nTakeaway: monomorphization removes the descriptor loop + per-field i32.loads. " +
      "For the large memcpy-bound macro frame the win is modest; for the tiny control " +
      "frame — where the loop overhead dominates — it is largest. Output is byte-identical " +
      "(proven in tests/emitWasmDecoder.test.ts).",
  );
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
