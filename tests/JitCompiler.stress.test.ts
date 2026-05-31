/**
 * The Autonomous JIT — stress + determinism soak (Apollo Frontier 5, Stage 1a).
 *
 * The third proof layer. Where the gate checks a small IEEE-edge corpus and the
 * fuzzer checks a broad program space at tiny n, this suite validates the actual
 * DELIVERABLE (the accepted SIMD WASM) at AUDIO-BLOCK scale: thousands of
 * 128-sample blocks of random input, executed through the returned module and
 * compared to the user's naive JS reference — bit-exact for f64 (JS f64 ≡ WASM
 * f64), within a small relative band for f32 (JS computes f32 kernels with f64
 * intermediates; the SIMD path is f32 throughout — the gap the swap crossfade
 * absorbs). Plus a determinism soak: the same source compiled many times yields
 * byte-identical WASM (no Math.random / Date.now leak).
 *
 * Run: tsx tests/JitCompiler.stress.test.ts
 */

import { assert, ok } from "./_assert.js";
import wabtInit from "wabt";
import { compileKernel, type KernelSignature, type LaneWidth, type CompileResult } from "../src/jit/index.js";

const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength); u.set(buffer); return u;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

const _b8 = new DataView(new ArrayBuffer(8));
const _b4 = new DataView(new ArrayBuffer(4));
function sameBits(a: number, b: number, w: LaneWidth): boolean {
  if (w === "f64") { _b8.setFloat64(0, a); const x = _b8.getBigUint64(0); _b8.setFloat64(0, b); return x === _b8.getBigUint64(0); }
  _b4.setFloat32(0, a); const x = _b4.getUint32(0); _b4.setFloat32(0, b); return x === _b4.getUint32(0);
}
function ulpF32(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  _b4.setFloat32(0, a); const ia = _b4.getUint32(0); _b4.setFloat32(0, b); const ib = _b4.getUint32(0);
  const order = (u: number) => (u & 0x80000000 ? (0x100000000 - u) >>> 0 : (u | 0x80000000) >>> 0);
  return Math.abs(order(ia) - order(ib));
}

interface Kernel {
  readonly name: string;
  readonly width: LaneWidth;
  readonly sig: KernelSignature;
  readonly src: string;
  /** number of input arrays + scalar names, in JS param order, for the reference. */
  readonly inputs: string[];
  readonly scalars: string[];
}

const KERNELS: Kernel[] = [
  {
    name: "taylor-f32", width: "f32", inputs: ["x", "v"], scalars: ["dt"],
    sig: { width: "f32", params: [{ name: "out", role: "output" }, { name: "x", role: "input" }, { name: "v", role: "input" }, { name: "dt", role: "scalar" }, { name: "n", role: "length" }] },
    src: "function k(out, x, v, dt, n){ for (let i = 0; i < n; i++) { out[i] = x[i] + dt * v[i]; } }",
  },
  {
    name: "lerp-f64", width: "f64", inputs: ["x", "y"], scalars: ["g"],
    sig: { width: "f64", params: [{ name: "out", role: "output" }, { name: "x", role: "input" }, { name: "y", role: "input" }, { name: "g", role: "scalar" }, { name: "n", role: "length" }] },
    src: "function k(out, x, y, g, n){ for (let i = 0; i < n; i++) { out[i] = (1 - g) * x[i] + g * y[i]; } }",
  },
  {
    name: "softclip-f32", width: "f32", inputs: ["x"], scalars: ["g"],
    sig: { width: "f32", params: [{ name: "out", role: "output" }, { name: "x", role: "input" }, { name: "g", role: "scalar" }, { name: "n", role: "length" }] },
    src: "function k(out, x, g, n){ for (let i = 0; i < n; i++) { out[i] = Math.max(Math.min(g * x[i], 1), -1); } }",
  },
  {
    name: "diffsq-f64", width: "f64", inputs: ["x", "y"], scalars: [],
    sig: { width: "f64", params: [{ name: "out", role: "output" }, { name: "x", role: "input" }, { name: "y", role: "input" }, { name: "n", role: "length" }] },
    src: "function k(out, x, y, n){ for (let i = 0; i < n; i++) { out[i] = x[i] * x[i] - y[i] * y[i]; } }",
  },
];

function instantiate(wasm: Uint8Array): { mem: WebAssembly.Memory; kernel: (...a: number[]) => void } {
  const mem = new WebAssembly.Memory({ initial: 8, maximum: 16384, shared: true });
  const buf = new Uint8Array(wasm.byteLength); buf.set(wasm);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(buf), { env: { memory: mem } });
  return { mem, kernel: inst.exports["kernel"] as (...a: number[]) => void };
}

function main(): void {
  const N = 128;          // audio block
  const BLOCKS = 1000;    // blocks per kernel
  const r = rng(0x5757);

  for (const K of KERNELS) {
    const res: CompileResult = compileKernel(K.src, K.sig, { compileWat });
    assert(res.status === "accepted", `${K.name}: expected accepted, got ${res.status}`);
    const acc = res;
    const TA = K.width === "f32" ? Float32Array : Float64Array;
    const eb = K.width === "f32" ? 4 : 8;
    // The deliverable (SIMD) and its scalar reference share the same op-tree; at
    // audio-block scale the TIGHT check is SIMD ≡ scalar bit-exact (both f32/f64
    // intermediates). The user's naive JS is compared too: bit-exact for f64
    // (JS f64 ≡ WASM f64), and within a small band for f32 (JS uses f64
    // intermediates — the gap the swap crossfade absorbs; reported, not gated).
    const simd = instantiate(acc.wasm);
    const scalar = instantiate(compileWat(acc.scalarWat, "scalar"));

    const slot = ((N * eb + 15) & ~15);
    const outOff = 16;
    const inOff: Record<string, number> = {};
    K.inputs.forEach((nm, k) => (inOff[nm] = 16 + (k + 1) * slot));

    // eslint-disable-next-line no-new-func
    const jsFn = new Function(`"use strict"; return (${K.src});`)() as (...a: unknown[]) => void;

    let worstUlpVsJs = 0, compared = 0;
    for (let b = 0; b < BLOCKS; b++) {
      const jsArrays: Record<string, Float32Array | Float64Array> = {};
      for (const nm of K.inputs) {
        const jsView = new TA(N);
        for (let i = 0; i < N; i++) jsView[i] = (r() - 0.5) * 4; // finite ⇒ Math.min/max ≡ f*.min/max
        new TA(simd.mem.buffer, inOff[nm]!, N).set(jsView);
        new TA(scalar.mem.buffer, inOff[nm]!, N).set(jsView);
        jsArrays[nm] = jsView;
      }
      const sv: Record<string, number> = {};
      for (const nm of K.scalars) sv[nm] = (r() - 0.5) * 3;
      const scalarArg = (nm: string) => (K.width === "f32" ? Math.fround(sv[nm]!) : sv[nm]!);

      const args = [N, outOff, ...K.inputs.map((nm) => inOff[nm]!), ...K.scalars.map(scalarArg)];
      new TA(simd.mem.buffer, outOff, N).fill(0);
      new TA(scalar.mem.buffer, outOff, N).fill(0);
      simd.kernel(...args);
      scalar.kernel(...args);
      const simdOut = new TA(simd.mem.buffer, outOff, N);
      const scalarOut = new TA(scalar.mem.buffer, outOff, N);

      // tight: SIMD ≡ scalar bit-exact
      for (let i = 0; i < N; i++) {
        if (!sameBits(simdOut[i]!, scalarOut[i]!, K.width)) {
          assert(false, `${K.name}: SIMD ≠ scalar at block ${b} i ${i}: ${simdOut[i]} vs ${scalarOut[i]}`);
        }
      }

      // JS reference
      const jsOut = new TA(N);
      const jsArgs = K.sig.params.map((p) => {
        if (p.role === "length") return N;
        if (p.role === "output") return jsOut;
        if (p.role === "scalar") return scalarArg(p.name);
        return jsArrays[p.name]!;
      });
      jsFn(...jsArgs);
      for (let i = 0; i < N; i++) {
        const w = simdOut[i]!, j = jsOut[i]!;
        compared++;
        if (!Number.isFinite(w) || !Number.isFinite(j)) continue;
        if (K.width === "f64") {
          assert(w === j, `${K.name}: f64 deliverable ≠ JS at block ${b} i ${i}: ${w} vs ${j}`);
        } else {
          worstUlpVsJs = Math.max(worstUlpVsJs, ulpF32(w, j));
        }
      }
    }
    ok(`${K.name}: ${BLOCKS}×${N} samples — SIMD ≡ scalar bit-exact; ${K.width === "f64" ? "deliverable bit-exact vs JS" : `deliverable within ${worstUlpVsJs} f32-ULP of naive JS (the crossfade-absorbed gap)`}`);
  }

  // ── determinism soak ───────────────────────────────────────────────────────
  {
    const K = KERNELS[0]!;
    const first = compileKernel(K.src, K.sig, { compileWat });
    assert(first.status === "accepted", "soak: first compile accepted");
    const hex0 = Buffer.from(first.wasm).toString("hex");
    const ROUNDS = 50;
    for (let i = 0; i < ROUNDS; i++) {
      const r2 = compileKernel(K.src, K.sig, { compileWat });
      assert(r2.status === "accepted", `soak round ${i} accepted`);
      assert(Buffer.from(r2.wasm).toString("hex") === hex0, `soak round ${i}: wasm bytes drifted (nondeterminism)`);
    }
    ok(`determinism soak: ${ROUNDS} recompiles all byte-identical (${first.wasm.byteLength} bytes)`);
  }

  console.log("\nAll JitCompiler.stress assertions passed.");
}

main();
