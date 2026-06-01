/**
 * kalman-simd microbenchmark — scalar (AoS) vs f64x2 SIMD (SoA) StatePredictor
 * kernels, plus Step-1 f32x4 candidate validation.
 *
 *   npx tsx bench/kalman-simd.bench.ts      (or `npm run bench:kalman-simd`)
 *
 * N=64 lanes (macro-field width), batched to beat the hrtime tick.
 */

import { hrtime } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { instantiateConsumer, hasWasmConsumerSupport } from "../src/worklet/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, "..", "dist", "worklet", "decoder.wasm");

const N = 64;
const WARMUP = 20_000;
const BATCH = 512;
const SAMPLES = 2_000;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))]!;
}
function mean(a: number[]): number {
  let s = 0;
  for (const x of a) s += x;
  return s / a.length;
}
function fmt(ns: number): string {
  return ns >= 1000 ? `${(ns / 1000).toFixed(2)} us` : `${ns.toFixed(0)} ns`;
}
function pad(s: string, w: number): string {
  return s.padEnd(w);
}

function main(): void {
  if (!hasWasmConsumerSupport()) {
    console.log("kalman-simd bench skipped: no WASM SIMD/threads in this runtime.");
    return;
  }

  const memory = new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true });
  const c = instantiateConsumer(readFileSync(wasmPath), memory);
  const cAny = c as unknown as Record<string, unknown>;
  const f64 = new Float64Array(memory.buffer as ArrayBufferLike);
  const f32 = new Float32Array(memory.buffer as ArrayBufferLike);

  const hasF32x4Kalman = [
    "kalmanIngestCvF32x4SoaSimd",
    "kalmanPredictCvF32x4SoaSimd",
    "kalmanIngestCaF32x4SoaSimd",
    "kalmanPredictCaF32x4SoaSimd",
  ].every((name) => typeof cAny[name] === "function");

  const m = 3; // CA
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
  // SoA region (f64): arrays-of-lanes, vscratch in v128.
  const sXoff = off; off += N * m * 8;
  const sPoff = off; off += N * m * m * 8;
  const sPos = off; off += N * 8;
  const sVel = off; off += N * 8;
  const sAcc = off; off += N * 8;
  const sVal = off; off += N * 8;
  const sVar = off; off += N * 8;
  const sScratch = off; off += 2 * m * 16;
  // Step-1 SoA region (f32): same SoA layout, f32 lanes.
  const f32Xoff = off; off += N * m * 4;
  const f32Poff = off; off += N * m * m * 4;
  const f32Pos = off; off += N * 4;
  const f32Vel = off; off += N * 4;
  const f32Acc = off; off += N * 4;
  const f32Val = off; off += N * 4;
  const f32Var = off; off += N * 4;
  const f32Scratch = off; off += 2 * m * 16;

  // Seed all buffers with same state (finite x, diagonal P = p0).
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < m; k++) {
      const v = Math.sin(i + k);
      f64[aXoff / 8 + i * m + k] = v;
      f64[sXoff / 8 + k * N + i] = v;
      f32[f32Xoff / 4 + k * N + i] = v;
    }
    for (let k = 0; k < m * m; k++) {
      f64[aPoff / 8 + i * m * m + k] = 0;
      f64[sPoff / 8 + k * N + i] = 0;
      f32[f32Poff / 4 + k * N + i] = 0;
    }
    for (const d of [0, m + 1, 2 * m + 2]) {
      f64[aPoff / 8 + i * m * m + d] = p0;
      f64[sPoff / 8 + d * N + i] = p0;
      f32[f32Poff / 4 + d * N + i] = p0;
    }
    const mp = Math.sin(i), mv = Math.cos(i), maa = -Math.sin(i);
    f64[aPos / 8 + i] = mp; f64[aVel / 8 + i] = mv; f64[aAcc / 8 + i] = maa;
    f64[sPos / 8 + i] = mp; f64[sVel / 8 + i] = mv; f64[sAcc / 8 + i] = maa;
    f32[f32Pos / 4 + i] = mp;
    f32[f32Vel / 4 + i] = mv;
    f32[f32Acc / 4 + i] = maa;
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

  console.log(
    `\nkalman-simd bench — N=${N} lanes (order-3 CA), ${(SAMPLES * BATCH).toLocaleString()} calls/cell\n`,
  );
  console.log(
    pad("kernel", 12),
    pad("scalar (AoS) p50", 18),
    pad("f64x2 SoA p50", 18),
    pad("f32x4 SoA p50", 18),
    pad("f64 speedup", 12),
    "f32 speedup",
  );
  console.log("-".repeat(84));

  const predScalar = time(() => c.kalmanPredictCaF64(aXoff, aPoff, aVal, aVar, N, pdt, q));
  const predSimd = time(() => c.kalmanPredictCaF64SoaSimd(sXoff, sPoff, sVal, sVar, N, pdt, q));
  const predF32x4 = hasF32x4Kalman
    ? time(() => c.kalmanPredictCaF32x4SoaSimd(f32Xoff, f32Poff, f32Val, f32Var, N, pdt, q))
    : null;
  console.log(
    pad("predict", 12),
    pad(fmt(predScalar.p50), 18),
    pad(fmt(predSimd.p50), 18),
    pad(predF32x4 ? fmt(predF32x4.p50) : "n/a", 18),
    pad((predScalar.p50 / predSimd.p50).toFixed(2), 12),
    predF32x4 ? `${(predSimd.p50 / predF32x4.p50).toFixed(2)}x` : "n/a",
  );

  const ingScalar = time(() =>
    c.kalmanIngestCaF64(aXoff, aPoff, aPos, aVel, aAcc, N, dt, q, rp, rv, ra, 1, 1, aScratch),
  );
  const ingSimd = time(() =>
    c.kalmanIngestCaF64SoaSimd(sXoff, sPoff, sPos, sVel, sAcc, N, dt, q, rp, rv, ra, 1, 1, sScratch),
  );
  const ingF32x4 = hasF32x4Kalman
    ? time(() =>
      c.kalmanIngestCaF32x4SoaSimd(f32Xoff, f32Poff, f32Pos, f32Vel, f32Acc, N, dt, q, rp, rv, ra, 1, 1, f32Scratch),
    )
    : null;
  console.log(
    pad("ingest", 12),
    pad(fmt(ingScalar.p50), 18),
    pad(fmt(ingSimd.p50), 18),
    pad(ingF32x4 ? fmt(ingF32x4.p50) : "n/a", 18),
    pad((ingScalar.p50 / ingSimd.p50).toFixed(2), 12),
    ingF32x4 ? `${(ingSimd.p50 / ingF32x4.p50).toFixed(2)}x` : "n/a",
  );

  console.log();
  const predWin = predScalar.p50 / predSimd.p50;
  const ingWin = ingScalar.p50 / ingSimd.p50;
  if (predWin > 1.0 && ingWin > 1.0) {
    console.log(
      `  baseline f64x2 SoA wins both paths: predict ${predWin.toFixed(2)}x, ingest ${ingWin.toFixed(2)}x vs scalar`,
    );
  } else {
    console.error(`  baseline f64x2 SoA does NOT win both paths (predict ${predWin.toFixed(2)}x, ingest ${ingWin.toFixed(2)}x)`);
    process.exitCode = 1;
  }

  if (!hasF32x4Kalman) {
    console.log(
      "  Step 1 blocked: f32x4 exports are not present in this build.",
    );
    return;
  }

  const f32PredWin = predSimd.p50 / (predF32x4?.p50 ?? predSimd.p50);
  const f32IngWin = ingSimd.p50 / (ingF32x4?.p50 ?? ingSimd.p50);
  if (f32PredWin > 1.0 && f32IngWin > 1.0) {
    console.log(
      `  Step 1 PASS: f32x4 SoA outperforms f64x2 SoA (predict ${f32PredWin.toFixed(2)}x, ingest ${f32IngWin.toFixed(2)}x).`,
    );
  } else {
    console.log(
      `  Step 1 BLOCKED: f32x4 SoA does not outperform f64x2 SoA (predict ${f32PredWin.toFixed(2)}x, ingest ${f32IngWin.toFixed(2)}x).`,
    );
    process.exitCode = 1;
  }
}

main();

