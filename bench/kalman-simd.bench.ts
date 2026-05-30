/**
 * kalman-simd microbenchmark — scalar (AoS) vs f64x2 SIMD (SoA) StatePredictor
 * kernels (Apollo Frontier 2, 0.9.904).
 *
 *   npx tsx bench/kalman-simd.bench.ts      (or `npm run bench:kalman-simd`)
 *
 * Correctness (bit-exact f64) is pinned in tests/StatePredictor.wasm.test.ts.
 * This answers the throughput question the project's "every SIMD path must win
 * the bench" discipline demands: does the SoA f64x2 lane-parallel port actually
 * beat the AoS scalar kernel? The SoA layout (each derivative / covariance
 * element its own contiguous array across lanes) is the whole point — it makes
 * every load/store contiguous (no gather), which a naive lane-parallel SIMD over
 * the per-lane AoS state could not.
 *
 * N=64 lanes (a generous macro-field width), batched to beat the hrtime tick.
 */

import { hrtime } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { instantiateConsumer, hasWasmConsumerSupport } from "../src/worklet/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, "..", "dist", "worklet", "decoder.wasm");

const N = 64;          // even lane count (SIMD requires even)
const WARMUP = 20_000;
const BATCH = 512;
const SAMPLES = 2_000;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))]!;
}
function mean(a: number[]): number { let s = 0; for (const x of a) s += x; return s / a.length; }
function fmt(ns: number): string { return ns >= 1000 ? `${(ns / 1000).toFixed(2)} µs` : `${ns.toFixed(0)} ns`; }
function pad(s: string, w: number): string { return s.padEnd(w); }

function main(): void {
  if (!hasWasmConsumerSupport()) {
    console.log("kalman-simd bench skipped — no WASM SIMD/threads in this runtime.");
    return;
  }
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true });
  const c = instantiateConsumer(readFileSync(wasmPath), memory);
  const f64 = new Float64Array(memory.buffer as ArrayBufferLike);

  const m = 3; // CA — the heaviest, most representative model
  const q = 5e2, rp = 1e-3, rv = 1e-2, ra = 1e-1, p0 = 1e6;
  const dt = 0.016, pdt = 0.008;

  // AoS region: x[lane*m+k], P[lane*m*m+...], pos/vel/acc/val/var [lane], scratch.
  let off = 1024;
  const aXoff = off; off += N * m * 8;
  const aPoff = off; off += N * m * m * 8;
  const aPos = off; off += N * 8;
  const aVel = off; off += N * 8;
  const aAcc = off; off += N * 8;
  const aVal = off; off += N * 8;
  const aVar = off; off += N * 8;
  const aScratch = off; off += 2 * m * 8;
  // SoA region (separate): arrays-of-lanes, vscratch in v128.
  const sXoff = off; off += N * m * 8;
  const sPoff = off; off += N * m * m * 8;
  const sPos = off; off += N * 8;
  const sVel = off; off += N * 8;
  const sAcc = off; off += N * 8;
  const sVal = off; off += N * 8;
  const sVar = off; off += N * 8;
  const sScratch = off; off += 2 * m * 16;

  // Seed both with the same valid state (x finite, P diag = p0).
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < m; k++) {
      const v = Math.sin(i + k);
      f64[aXoff / 8 + i * m + k] = v;
      f64[sXoff / 8 + k * N + i] = v;
    }
    for (let k = 0; k < m * m; k++) { f64[aPoff / 8 + i * m * m + k] = 0; f64[sPoff / 8 + k * N + i] = 0; }
    for (const d of [0, m + 1, 2 * m + 2]) { f64[aPoff / 8 + i * m * m + d] = p0; f64[sPoff / 8 + d * N + i] = p0; }
    const mp = Math.sin(i), mv = Math.cos(i), maa = -Math.sin(i);
    f64[aPos / 8 + i] = mp; f64[aVel / 8 + i] = mv; f64[aAcc / 8 + i] = maa;
    f64[sPos / 8 + i] = mp; f64[sVel / 8 + i] = mv; f64[sAcc / 8 + i] = maa;
  }

  function time(fn: () => void): { p50: number; mean: number } {
    for (let i = 0; i < WARMUP; i++) fn();
    const s: number[] = [];
    for (let k = 0; k < SAMPLES; k++) {
      const t0 = hrtime.bigint();
      for (let b = 0; b < BATCH; b++) fn();
      const t1 = hrtime.bigint();
      s.push(Number(t1 - t0) / BATCH);
    }
    s.sort((a, b) => a - b);
    return { p50: percentile(s, 0.5), mean: mean(s) };
  }

  console.log(`\nkalman-simd bench — N=${N} lanes (order-3 CA), ${(SAMPLES * BATCH).toLocaleString()} calls/cell\n`);
  console.log(pad("kernel", 12), pad("scalar (AoS) p50", 18), pad("SIMD (SoA) p50", 18), "speedup");
  console.log("-".repeat(64));

  const predScalar = time(() => c.kalmanPredictCaF64(aXoff, aPoff, aVal, aVar, N, pdt, q));
  const predSimd = time(() => c.kalmanPredictCaF64SoaSimd(sXoff, sPoff, sVal, sVar, N, pdt, q));
  console.log(pad("predict", 12), pad(fmt(predScalar.p50), 18), pad(fmt(predSimd.p50), 18),
    `${(predScalar.p50 / predSimd.p50).toFixed(2)}×`);

  const ingScalar = time(() => c.kalmanIngestCaF64(aXoff, aPoff, aPos, aVel, aAcc, N, dt, q, rp, rv, ra, 1, 1, aScratch));
  const ingSimd = time(() => c.kalmanIngestCaF64SoaSimd(sXoff, sPoff, sPos, sVel, sAcc, N, dt, q, rp, rv, ra, 1, 1, sScratch));
  console.log(pad("ingest", 12), pad(fmt(ingScalar.p50), 18), pad(fmt(ingSimd.p50), 18),
    `${(ingScalar.p50 / ingSimd.p50).toFixed(2)}×`);

  console.log();
  const predWin = predScalar.p50 / predSimd.p50;
  if (predWin > 1.0) {
    console.log(`  predict SIMD wins: ${predWin.toFixed(2)}× vs scalar (SoA f64x2 lane-parallel, contiguous loads)`);
  } else {
    console.error(`  predict SIMD does NOT win (${predWin.toFixed(2)}×) — assess`);
    process.exitCode = 1;
  }
}

main();
