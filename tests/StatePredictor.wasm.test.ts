/**
 * StatePredictor — WASM scalar ⇄ JS bit-exact equivalence (Apollo Frontier 2,
 * 0.9.903). Node/tsx, assert-helper convention.
 *
 * Drives a JS `StatePredictor` and the WASM scalar kernels
 * (`kalmanIngestCvF64`/`kalmanPredictCvF64` + the CA pair) with IDENTICAL seeds,
 * measurement traces, and `dt`s, and asserts the predicted value + variance match
 * BIT-EXACT (assertEq) over a multi-step noisy/curved trace. Because a perfect
 * end-to-end match of both value (depends on the state mean x) and variance
 * (depends on the covariance P) across many ingest+predict cycles can only hold
 * if the WASM port reproduces the JS propagate + sequential-update math exactly,
 * this transitively validates the in-memory state evolution without exposing P.
 *
 * The WASM kernels use left-to-right f64 with no implicit FMA, matching the JS
 * reference, so the f64 scalar path is bit-exact (the f32 SIMD port, 0.9.904,
 * relaxes to within-ULP). Skips cleanly if the runtime lacks WASM SIMD/threads.
 *
 *   npx tsx tests/StatePredictor.wasm.test.ts
 */

import { assertEq, ok } from "./_assert.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StatePredictor } from "../src/StatePredictor.js";
import { instantiateConsumer, hasWasmConsumerSupport } from "../src/worklet/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, "..", "dist", "worklet", "decoder.wasm");
const NS = 1e9;

interface Layout {
  xOff: number; pOff: number; posOff: number; velOff: number; accOff: number;
  valOff: number; varOff: number; scratchOff: number;
}
function layout(n: number, m: number): Layout {
  let off = 1024;
  const xOff = off; off += n * m * 8;
  const pOff = off; off += n * m * m * 8;
  const posOff = off; off += n * 8;
  const velOff = off; off += n * 8;
  const accOff = off; off += n * 8;
  const valOff = off; off += n * 8;
  const varOff = off; off += n * 8;
  const scratchOff = off; off += 2 * m * 8;
  return { xOff, pOff, posOff, velOff, accOff, valOff, varOff, scratchOff };
}

function main(): void {
  if (!hasWasmConsumerSupport()) {
    ok("StatePredictor-wasm-equivalence (skipped — no WASM SIMD/threads in this runtime)");
    return;
  }
  const wasmBytes = readFileSync(wasmPath);
  const memory = new WebAssembly.Memory({ initial: 8, maximum: 8, shared: true });
  const c = instantiateConsumer(wasmBytes, memory);
  const f64 = new Float64Array(memory.buffer as ArrayBufferLike);

  // Deterministic noisy curved trace generator (seeded LCG).
  function trace(seed0: number) {
    let seed = seed0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    return rnd;
  }

  // ── CV (order-2) equivalence ─────────────────────────────────────────────
  {
    const N = 5, m = 2;
    const q = 1e3, rp = 4e-4, rv = 0.25, p0 = 1e6;
    const L = layout(N, m);
    const sp = new StatePredictor({ laneCount: N, model: "cv", processNoise: q, measPosNoise: rp, measVelNoise: rv, initialVariance: p0 });
    const rnd = trace(99);
    // Seed both at frame 0 with identical measurements.
    const pos0 = new Float64Array(N), vel0 = new Float64Array(N);
    for (let i = 0; i < N; i++) { pos0[i] = Math.sin(i) + 0.01 * rnd(); vel0[i] = Math.cos(i) + 0.05 * rnd(); }
    sp.ingest(0, pos0, vel0);
    // WASM seed: x=[pos,vel], P=diag(p0).
    for (let i = 0; i < N; i++) {
      f64[L.xOff / 8 + i * m] = pos0[i]!;
      f64[L.xOff / 8 + i * m + 1] = vel0[i]!;
      for (let k = 0; k < m * m; k++) f64[L.pOff / 8 + i * m * m + k] = 0;
      f64[L.pOff / 8 + i * m * m + 0] = p0;
      f64[L.pOff / 8 + i * m * m + 3] = p0;
    }
    let lastNs = 0;
    const period = 16_666_667;
    let maxAbsErr = 0;
    for (let frame = 1; frame <= 25; frame++) {
      const tNs = frame * period;
      const pos = new Float64Array(N), vel = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const s = tNs * 1e-9;
        pos[i] = Math.sin(s + i) + 0.01 * rnd();
        vel[i] = Math.cos(s + i) + 0.05 * rnd();
      }
      sp.ingest(tNs, pos, vel);
      // WASM ingest.
      for (let i = 0; i < N; i++) { f64[L.posOff / 8 + i] = pos[i]!; f64[L.velOff / 8 + i] = vel[i]!; }
      const dt = (tNs - lastNs) * 1e-9;
      c.kalmanIngestCvF64(L.xOff, L.pOff, L.posOff, L.velOff, N, dt, q, rp, rv, 1, L.scratchOff);
      lastNs = tNs;
      // Predict 8 ms ahead, compare bit-exact.
      const targetNs = tNs + 8 * 1e-3 * NS;
      const jsVal = new Float64Array(N), jsVar = new Float64Array(N);
      sp.predictInto(targetNs, jsVal, jsVar);
      const pdt = (targetNs - lastNs) * 1e-9;
      c.kalmanPredictCvF64(L.xOff, L.pOff, L.valOff, L.varOff, N, pdt, q);
      for (let i = 0; i < N; i++) {
        assertEq(f64[L.valOff / 8 + i], jsVal[i], `CV frame ${frame} lane ${i} value bit-exact`);
        assertEq(f64[L.varOff / 8 + i], jsVar[i], `CV frame ${frame} lane ${i} variance bit-exact`);
        maxAbsErr = Math.max(maxAbsErr, Math.abs(f64[L.valOff / 8 + i]! - jsVal[i]!));
      }
    }
    assertEq(maxAbsErr, 0, "CV max value error exactly 0 over the trace");
    ok("StatePredictor-wasm-cv-bit-exact");
  }

  // ── CA (order-3) equivalence ─────────────────────────────────────────────
  {
    const N = 4, m = 3;
    const q = 5e2, rp = 1e-3, rv = 1e-2, ra = 1e-1, p0 = 1e6;
    const L = layout(N, m);
    const sp = new StatePredictor({ laneCount: N, model: "ca", processNoise: q, measPosNoise: rp, measVelNoise: rv, measAccNoise: ra, initialVariance: p0 });
    const rnd = trace(31337);
    const pos0 = new Float64Array(N), vel0 = new Float64Array(N), acc0 = new Float64Array(N);
    for (let i = 0; i < N; i++) { pos0[i] = Math.sin(i) + 0.01 * rnd(); vel0[i] = Math.cos(i); acc0[i] = -Math.sin(i); }
    sp.ingest(0, pos0, vel0, acc0);
    for (let i = 0; i < N; i++) {
      f64[L.xOff / 8 + i * m] = pos0[i]!;
      f64[L.xOff / 8 + i * m + 1] = vel0[i]!;
      f64[L.xOff / 8 + i * m + 2] = acc0[i]!;
      for (let k = 0; k < m * m; k++) f64[L.pOff / 8 + i * m * m + k] = 0;
      f64[L.pOff / 8 + i * m * m + 0] = p0; // P00
      f64[L.pOff / 8 + i * m * m + 4] = p0; // P11
      f64[L.pOff / 8 + i * m * m + 8] = p0; // P22
    }
    let lastNs = 0;
    const period = 16_666_667;
    for (let frame = 1; frame <= 25; frame++) {
      const tNs = frame * period;
      const s = tNs * 1e-9;
      const pos = new Float64Array(N), vel = new Float64Array(N), acc = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        pos[i] = Math.sin(s + i) + 0.01 * rnd();
        vel[i] = Math.cos(s + i) + 0.05 * rnd();
        acc[i] = -Math.sin(s + i) + 0.2 * rnd();
      }
      sp.ingest(tNs, pos, vel, acc);
      for (let i = 0; i < N; i++) { f64[L.posOff / 8 + i] = pos[i]!; f64[L.velOff / 8 + i] = vel[i]!; f64[L.accOff / 8 + i] = acc[i]!; }
      const dt = (tNs - lastNs) * 1e-9;
      c.kalmanIngestCaF64(L.xOff, L.pOff, L.posOff, L.velOff, L.accOff, N, dt, q, rp, rv, ra, 1, 1, L.scratchOff);
      lastNs = tNs;
      const targetNs = tNs + 8 * 1e-3 * NS;
      const jsVal = new Float64Array(N), jsVar = new Float64Array(N);
      sp.predictInto(targetNs, jsVal, jsVar);
      const pdt = (targetNs - lastNs) * 1e-9;
      c.kalmanPredictCaF64(L.xOff, L.pOff, L.valOff, L.varOff, N, pdt, q);
      for (let i = 0; i < N; i++) {
        assertEq(f64[L.valOff / 8 + i], jsVal[i], `CA frame ${frame} lane ${i} value bit-exact`);
        assertEq(f64[L.varOff / 8 + i], jsVar[i], `CA frame ${frame} lane ${i} variance bit-exact`);
      }
    }
    ok("StatePredictor-wasm-ca-bit-exact");
  }

  // ── position-only CV (no stamped velocity, useVel=0) ─────────────────────
  {
    const N = 3, m = 2;
    const q = 1e2, rp = 1e-4, p0 = 1e6;
    const L = layout(N, m);
    const sp = new StatePredictor({ laneCount: N, model: "cv", processNoise: q, measPosNoise: rp, initialVariance: p0 });
    const pos0 = new Float64Array(N);
    for (let i = 0; i < N; i++) pos0[i] = 0.5 + i;
    sp.ingest(0, pos0);
    for (let i = 0; i < N; i++) {
      f64[L.xOff / 8 + i * m] = pos0[i]!;
      f64[L.xOff / 8 + i * m + 1] = 0;
      for (let k = 0; k < m * m; k++) f64[L.pOff / 8 + i * m * m + k] = 0;
      f64[L.pOff / 8 + i * m * m + 0] = p0;
      f64[L.pOff / 8 + i * m * m + 3] = p0;
    }
    let lastNs = 0;
    const period = 16_666_667;
    for (let frame = 1; frame <= 20; frame++) {
      const tNs = frame * period;
      const pos = new Float64Array(N);
      for (let i = 0; i < N; i++) pos[i] = 0.5 + i + 4 * tNs * 1e-9; // ramp v=4
      sp.ingest(tNs, pos);
      for (let i = 0; i < N; i++) f64[L.posOff / 8 + i] = pos[i]!;
      const dt = (tNs - lastNs) * 1e-9;
      c.kalmanIngestCvF64(L.xOff, L.pOff, L.posOff, L.velOff, N, dt, q, rp, 1e-3, 0, L.scratchOff);
      lastNs = tNs;
      const targetNs = tNs + 5 * 1e-3 * NS;
      const jsVal = new Float64Array(N), jsVar = new Float64Array(N);
      sp.predictInto(targetNs, jsVal, jsVar);
      const pdt = (targetNs - lastNs) * 1e-9;
      c.kalmanPredictCvF64(L.xOff, L.pOff, L.valOff, L.varOff, N, pdt, q);
      for (let i = 0; i < N; i++) {
        assertEq(f64[L.valOff / 8 + i], jsVal[i], `posOnly frame ${frame} lane ${i} value bit-exact`);
        assertEq(f64[L.varOff / 8 + i], jsVar[i], `posOnly frame ${frame} lane ${i} variance bit-exact`);
      }
    }
    ok("StatePredictor-wasm-position-only-bit-exact");
  }

  console.log("\nAll StatePredictor WASM-equivalence pins passed.");
}

main();
