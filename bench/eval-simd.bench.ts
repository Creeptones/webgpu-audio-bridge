/**
 * eval-simd microbenchmark — scalar vs SIMD trajectory evaluators.
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/eval-simd.bench.ts      (or `npm run bench:eval-simd`)
 *
 * ─── What this answers ──────────────────────────────────────────────────────
 *
 * 0.9.79 added SIMD evaluators that were deferred at the 0.7.10 SIMD cut:
 *   - Hermite order-2 (f64x2 / f32x4) — clean interleaved [p,v] deinterleave.
 *   - Taylor  order-3 (f64x2 / f32x4) — the stride-3 [p,v,a] deinterleave the
 *     0.7.10 note flagged ("deinterleave cost dwarfs the per-sample win").
 *
 * Correctness is proven (bit-exact f64 / within-ULP f32) in
 * tests/Bridge.wasmEquivalence.test.ts pins 18–19. This bench answers the
 * SEPARATE throughput question: does each SIMD path actually BEAT its scalar
 * sibling, and by how much? The order-3 f32x4 path in particular pays 6
 * shuffles per 4 samples — the bench decides whether that breaks through.
 *
 * Eval-only (no SPSC atomics), batched to beat the host hrtime tick. N=64
 * samples (a realistic partial / audio-block count). Each cell evaluates the
 * SAME fixed source slot repeatedly.
 */

import { hrtime } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema, u64,
  f64TrajectoryArray, f32TrajectoryArray,
} from "../src/schema.js";
import {
  allocateWorkletMemory,
  instantiateConsumer,
  hasWasmConsumerSupport,
  type WorkletConsumer,
} from "../src/worklet/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, "..", "dist", "worklet", "decoder.wasm");

const N = 64;
const CAP = 4;
const HEADER = 32;
const WARMUP = 20_000;
const BATCH = 256;
const SAMPLES = 2_000;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))]!;
}
function mean(a: number[]): number { let s = 0; for (const x of a) s += x; return s / a.length; }
function fmt(ns: number): string { return ns < 1000 ? `${ns.toFixed(0)} ns` : `${(ns / 1000).toFixed(2)} μs`; }
function time(samples: number, batch: number, fn: () => void): number[] {
  const out = new Array<number>(samples);
  for (let s = 0; s < samples; s++) {
    const t0 = hrtime.bigint();
    for (let b = 0; b < batch; b++) fn();
    const t1 = hrtime.bigint();
    out[s] = Number(t1 - t0) / batch;
  }
  return out;
}
function summarize(name: string, fn: () => void) {
  for (let i = 0; i < WARMUP; i++) fn();
  const s = time(SAMPLES, BATCH, fn).sort((a, b) => a - b);
  return { name, p50: percentile(s, 0.5), p99: percentile(s, 0.99), mean: mean(s) };
}

function readWasm(): Uint8Array<ArrayBuffer> {
  const b = readFileSync(wasmPath);
  const u = new Uint8Array(b.byteLength); u.set(b); return u;
}

/** Stand up a single-trajectory bridge + consumer, push one filled frame, and
 *  return the consumer plus the absolute src offset of the trajectory + two
 *  scratch offsets (scalar / simd). */
function setup(order: 2 | 3, elem: 4 | 8): {
  consumer: WorkletConsumer; srcOff: number; scalarOff: number; simdOff: number; prevOff: number;
} {
  const schema = elem === 8
    ? defineSchema({ seq: u64(), traj: f64TrajectoryArray(N, { order }) })
    : defineSchema({ seq: u64(), traj: f32TrajectoryArray(N, { order }) });
  const sabBytes = Bridge.byteLength(CAP, schema);
  const dstBytes = N * elem;
  const alloc = allocateWorkletMemory({ sabBytes, scratchBytes: dstBytes * 2 });
  const bridge = new Bridge(alloc.sab, CAP, schema);
  const consumer = instantiateConsumer(readWasm(), alloc.memory);
  const frameBytes = schema.compiled.frameByteSize;
  const trajOff = schema.compiled.fields.find((f) => f.name === "traj")!.byteOffset;
  const omega = 2 * Math.PI * 3;
  const pf = bridge.scratchFrame();
  for (let k = 0; k < N; k++) {
    const c = Math.cos(k * 0.19 + 0.5), sN = Math.sin(k * 0.19 + 0.5);
    pf.traj[k * order] = c;
    pf.traj[k * order + 1] = -omega * sN;
    if (order === 3) pf.traj[k * order + 2] = -omega * omega * c;
  }
  // Push twice so Hermite has prev+curr; bench against slot 0 (prev) / slot 1.
  bridge.push(pf);
  bridge.push(pf);
  const base = alloc.scratchByteOffset!;
  return {
    consumer,
    srcOff: HEADER + 1 * frameBytes + trajOff, // curr (slot 1)
    prevOff: HEADER + 0 * frameBytes + trajOff, // prev (slot 0)
    scalarOff: base,
    simdOff: base + dstBytes,
  };
}

function main(): void {
  if (!hasWasmConsumerSupport()) {
    console.error("eval-simd.bench: runtime lacks WASM SIMD/threads — cannot bench.");
    process.exit(1);
  }
  const dt = 0.0166667;
  // Hermite basis at a representative (t, segmentSeconds).
  const t = 0.37, segS = 1 / 60;
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10s = (t3 - 2 * t2 + t) * segS;
  const h01 = -2 * t3 + 3 * t2, h11s = (t3 - t2) * segS;

  const rows: Array<{ group: string; scalar: ReturnType<typeof summarize>; simd: ReturnType<typeof summarize> }> = [];

  // Hermite order-2 f64
  {
    const s = setup(2, 8);
    rows.push({
      group: "Hermite o2 f64",
      scalar: summarize("scalar", () => s.consumer.evalHermiteF64(s.prevOff, s.srcOff, s.scalarOff, N, 2, h00, h10s, h01, h11s)),
      simd: summarize("f64x2", () => s.consumer.evalHermiteF64O2Simd(s.prevOff, s.srcOff, s.simdOff, N, h00, h10s, h01, h11s)),
    });
  }
  // Hermite order-2 f32
  {
    const s = setup(2, 4);
    rows.push({
      group: "Hermite o2 f32",
      scalar: summarize("scalar", () => s.consumer.evalHermiteF32(s.prevOff, s.srcOff, s.scalarOff, N, 2, h00, h10s, h01, h11s)),
      simd: summarize("f32x4", () => s.consumer.evalHermiteF32O2Simd(s.prevOff, s.srcOff, s.simdOff, N, h00, h10s, h01, h11s)),
    });
  }
  // Taylor order-3 f64
  {
    const s = setup(3, 8);
    rows.push({
      group: "Taylor o3 f64",
      scalar: summarize("scalar", () => s.consumer.evalTaylorF64O3(s.srcOff, s.scalarOff, N, dt)),
      simd: summarize("f64x2", () => s.consumer.evalTaylorF64O3Simd(s.srcOff, s.simdOff, N, dt)),
    });
  }
  // Taylor order-3 f32
  {
    const s = setup(3, 4);
    rows.push({
      group: "Taylor o3 f32",
      scalar: summarize("scalar", () => s.consumer.evalTaylorF32O3(s.srcOff, s.scalarOff, N, dt)),
      simd: summarize("f32x4", () => s.consumer.evalTaylorF32O3Simd(s.srcOff, s.simdOff, N, dt)),
    });
  }

  const pad = (x: string, n: number) => x.padEnd(n);
  console.log(`\neval-simd bench — N=${N} samples/call, ${(SAMPLES * BATCH).toLocaleString()} evals/cell\n`);
  console.log(pad("evaluator", 18), pad("scalar p50", 12), pad("SIMD p50", 12), pad("speedup", 10), "scalar/SIMD mean");
  console.log("-".repeat(82));
  for (const r of rows) {
    const sp = r.scalar.p50 / r.simd.p50;
    console.log(
      pad(r.group, 18),
      pad(fmt(r.scalar.p50), 12),
      pad(fmt(r.simd.p50), 12),
      pad(`${sp.toFixed(2)}×`, 10),
      `${fmt(r.scalar.mean)} / ${fmt(r.simd.mean)}`,
    );
  }
  console.log(
    "\nf64 paths are bit-exact to scalar; f32 paths within a few ULP " +
      "(proven in tests/Bridge.wasmEquivalence.test.ts pins 18–19). " +
      "A speedup < 1.0 means the deinterleave cost outweighs the vector win for that path.",
  );
}

main();
