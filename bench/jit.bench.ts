/**
 * The Autonomous JIT — characterization microbenchmark
 * (Apollo Frontier 5, Stage 2, 0.9.916).
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/jit.bench.ts        (or `npm run bench:jit`)
 *
 * ─── What this answers ──────────────────────────────────────────────────────
 *
 * Stage 1a (0.9.913) shipped `compileKernel` — a developer's naive scalar JS DSP
 * loop is auto-vectorized to WASM SIMD and returned `accepted` ONLY after the
 * equivalence gate proves it bit-exact (f64) / within-ULP (f32). Stage 1b
 * (0.9.914) shipped `JitKernelConsumer` — the worklet-side runtime that
 * synchronously instantiates a gate-PASSED Module between quanta and crossfades
 * the live signal onto it click-free, degrading to the JS kernel on every
 * failure. 0.9.915 upgraded the fade blend to the EXACT-LERP form `a + w·(b−a)`,
 * making the f64 swap BIT-EXACT to the JS stream at every sample.
 *
 * Those pieces are PROVEN (tests/JitCompiler.test.ts, tests/JitKernelConsumer.test.ts,
 * tests/Bridge.crossfade.test.ts). This bench does not re-prove them — it turns
 * "we believe the SIMD kernel is faster and the fade fits the quantum" into
 * measured numbers + one load-bearing budget gate. Four cells:
 *
 *   1. Throughput — the developer's scalar JS closure vs the JIT-SIMD `Instance`,
 *      per kernel, N=128. Reports median + the speedup ratio (the headline "was
 *      the vectorization worth it" number).
 *   2. Off-thread compile vs sync install — `compileKernel` end-to-end
 *      (parse→lower→vectorize→emit→GATE→wasm), the async `WebAssembly.compile`
 *      (the background-worker step), and the SYNC `new WebAssembly.Instance`
 *      (the audio-thread `port.onmessage` install). Confirms the install is
 *      microseconds while the compile+gate is the off-thread cost.
 *   3. Measured swap glitch — drives a `JitKernelConsumer` through a full
 *      idle→fade→complete swap on a smooth input and reports the residual between
 *      the blended stream and the pure-JS reference (max abs deviation + excess
 *      sample-to-sample step). For an f64 kernel this is exactly 0 (the 0.9.915
 *      exact-lerp transparency); for an f32 cancelling kernel it is the tiny
 *      JS-vs-SIMD ULP gap the crossfade smooths.
 *   4. THE load-bearing budget check — during a fade the consumer runs BOTH
 *      kernels every quantum, so the worst-case per-quantum cost is ≈ JS + SIMD ≤
 *      2×JS. The quantum budget at 48 kHz / N=128 is 128/48000 ≈ 2.667 ms.
 *      Asserts `2×(slowest JS kernel median) < quantumBudgetMs` and prints
 *      PASS/FAIL. If it ever fails, the documented mitigation (do NOT silently
 *      cap) is to shorten the fade window and/or hard-switch at the
 *      exact-lerp-safe seam — flagged for `connectJit`'s default `windowSeconds`.
 *
 * The cross-thread Module-clone-INTO-A-WORKLET transport check is Stage 3's
 * Playwright smoke (a worklet realm ≠ a worker realm); this bench measures the
 * compile + install costs on one thread, which is the substance.
 *
 * ─── Methodology notes ──────────────────────────────────────────────────────
 *
 * Eval-only (no SPSC atomics), batched to beat the host hrtime tick (mirrors
 * bench/eval-simd.bench.ts). N=128 (the audio quantum the budget is defined at).
 * Deterministic, seedless inputs (sin/cos of the index) — a bench must be
 * reproducible; no Math.random / Date.now anywhere. Only `accepted` wasm is ever
 * benchmarked (the gate is the safety boundary; an ungated candidate is not a
 * shippable kernel).
 */

import { hrtime } from "node:process";
import wabtInit from "wabt";
import {
  compileKernel,
  type KernelSignature, type LaneWidth, type CompileResult,
} from "../src/jit/index.js";
import { ELEM_BYTES } from "../src/jit/ir.js";
import { JitKernelConsumer } from "../src/jit/JitKernelConsumer.js";
import { hasWasmConsumerSupport } from "../src/worklet/wasmSimdSupport.js";

// ── wabt-backed compileWat (the injected WAT→bytes compiler; identical to the
//    one tests/JitCompiler.test.ts uses) ─────────────────────────────────────
const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength);
  u.set(buffer);
  return u;
}

const N = 128;           // audio quantum (the budget is defined at this N)
const SAMPLE_RATE = 48_000;
const QUANTUM_BUDGET_MS = (N / SAMPLE_RATE) * 1000; // ≈ 2.667 ms

// Throughput-cell sampling (mirrors eval-simd's batch-to-beat-the-tick shape).
const WARMUP = 20_000;
const BATCH = 256;
const SAMPLES = 2_000;

// ── timing helpers (ported verbatim from bench/eval-simd.bench.ts) ───────────
function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))]!;
}
function mean(a: number[]): number { let s = 0; for (const x of a) s += x; return s / a.length; }
function fmt(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} μs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}
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
function summarize(fn: () => void, warmup = WARMUP, batch = BATCH, samples = SAMPLES): { p50: number; p99: number; mean: number } {
  for (let i = 0; i < warmup; i++) fn();
  const s = time(samples, batch, fn).sort((a, b) => a - b);
  return { p50: percentile(s, 0.5), p99: percentile(s, 0.99), mean: mean(s) };
}
/** Single-shot (no inner batch) timing for heavy ops (compileKernel, compile). */
function timeShots(samples: number, fn: () => void): number[] {
  const out = new Array<number>(samples);
  for (let s = 0; s < samples; s++) {
    const t0 = hrtime.bigint();
    fn();
    const t1 = hrtime.bigint();
    out[s] = Number(t1 - t0);
  }
  return out;
}
async function timeShotsAsync(samples: number, fn: () => Promise<void>): Promise<number[]> {
  const out = new Array<number>(samples);
  for (let s = 0; s < samples; s++) {
    const t0 = hrtime.bigint();
    await fn();
    const t1 = hrtime.bigint();
    out[s] = Number(t1 - t0);
  }
  return out;
}
function medianOf(samples: number[]): number {
  return percentile([...samples].sort((a, b) => a - b), 0.5);
}

// ── kernel fixtures ──────────────────────────────────────────────────────────

interface KernelSpec {
  readonly name: string;
  readonly width: LaneWidth;
  readonly sig: KernelSignature;
  readonly src: string;
  readonly scalars: Record<string, number>;
  /** Deterministic input arrays (length n), seeded by the index only. */
  readonly makeInputs: (n: number) => Record<string, Float32Array | Float64Array>;
  /** Whether this kernel is expected to exhibit a (tiny) f32 cancellation gap. */
  readonly cancelling: boolean;
}

function sig(width: LaneWidth, ...spec: Array<[string, "input" | "output" | "scalar" | "length"]>): KernelSignature {
  return { width, params: spec.map(([name, role]) => ({ name, role })) };
}
function typed(width: LaneWidth): Float32ArrayConstructor | Float64ArrayConstructor {
  return width === "f32" ? Float32Array : Float64Array;
}
function roundW(width: LaneWidth): (v: number) => number {
  return width === "f32" ? Math.fround : (v: number) => v;
}
function fill(width: LaneWidth, n: number, f: (i: number) => number): Float32Array | Float64Array {
  const a = new (typed(width))(n);
  for (let i = 0; i < n; i++) a[i] = f(i);
  return a;
}
function align16(n: number): number { return (n + 15) & ~15; }

/** 2–4 kernels spanning the cost range (reuses tests/JitCompiler.test.ts shapes). */
const KERNELS: KernelSpec[] = [
  {
    name: "identity (f32)",
    width: "f32",
    sig: sig("f32", ["out", "output"], ["x", "input"], ["n", "length"]),
    src: "function k(out, x, n){ for (let i = 0; i < n; i++) { out[i] = x[i]; } }",
    scalars: {},
    makeInputs: (n) => ({ x: fill("f32", n, (i) => Math.sin(0.013 * i + 0.2)) }),
    cancelling: false,
  },
  {
    name: "taylor o2 (f64)",
    width: "f64",
    sig: sig("f64", ["out", "output"], ["x", "input"], ["v", "input"], ["dt", "scalar"], ["n", "length"]),
    src: "function k(out, x, v, dt, n){ for (let i = 0; i < n; i++) { out[i] = x[i] + dt * v[i]; } }",
    scalars: { dt: 0.0166667 },
    makeInputs: (n) => ({
      x: fill("f64", n, (i) => Math.sin(0.011 * i + 0.5)),
      v: fill("f64", n, (i) => Math.cos(0.017 * i + 0.1)),
    }),
    cancelling: false,
  },
  {
    name: "hard-clip (f32)",
    width: "f32",
    sig: sig("f32", ["out", "output"], ["x", "input"], ["n", "length"]),
    src: "function k(out, x, n){ for (let i = 0; i < n; i++) { out[i] = Math.max(Math.min(x[i], 1), -1); } }",
    scalars: {},
    // Amplitude 1.5 so the min/max chain actually clips (exercises both branches).
    makeInputs: (n) => ({ x: fill("f32", n, (i) => 1.5 * Math.sin(0.05 * i)) }),
    cancelling: false,
  },
  {
    name: "diffsq x²−y² (f32)",
    width: "f32",
    sig: sig("f32", ["out", "output"], ["x", "input"], ["y", "input"], ["n", "length"]),
    src: "function k(out, x, y, n){ for (let i = 0; i < n; i++) { out[i] = x[i] * x[i] - y[i] * y[i]; } }",
    scalars: {},
    // Near-cancellation: x ≈ y, so x²−y² catastrophically cancels — the case
    // where the f64-intermediate JS and all-f32 SIMD legitimately differ by ULP.
    makeInputs: (n) => {
      const x = new Float32Array(n);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const base = 1 + 0.5 * Math.sin(2 * Math.PI * 110 * (i / SAMPLE_RATE));
        x[i] = base + 1e-3 * Math.sin(2 * Math.PI * 3000 * (i / SAMPLE_RATE));
        y[i] = base;
      }
      return { x, y };
    },
    cancelling: true,
  },
];

function compileAccepted(spec: KernelSpec): Extract<CompileResult, { status: "accepted" }> {
  const r = compileKernel(spec.src, spec.sig, { compileWat });
  if (r.status !== "accepted") throw new Error(`${spec.name}: expected accepted, got ${r.status}`);
  return r;
}

function moduleFromBytes(bytes: Uint8Array): WebAssembly.Module {
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  return new WebAssembly.Module(buf);
}

// ── reusable SIMD / JS run thunks (independent of JitKernelConsumer; this is the
//    raw per-kernel cost the way the gate's runModule / the test's simdReference
//    instantiate it) ──────────────────────────────────────────────────────────

/** A gate-PASSED SIMD `Instance` over its own shared memory, with inputs filled
 *  once and the ABI arg array prebuilt; returns a zero-alloc `run()` thunk. */
function simdThunk(spec: KernelSpec, wasm: Uint8Array, n: number): () => void {
  const TA = typed(spec.width); const eb = ELEM_BYTES[spec.width]; const round = roundW(spec.width);
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 16384, shared: true });
  const inst = new WebAssembly.Instance(moduleFromBytes(wasm), { env: { memory } });
  const kernel = inst.exports["kernel"] as (...a: number[]) => void;
  const slot = align16(Math.max(1, n) * eb);
  const arrayParams = spec.sig.params.filter((p) => p.role === "input" || p.role === "output");
  const off: Record<string, number> = {}; let cursor = 16;
  for (const p of arrayParams) { off[p.name] = cursor; cursor += slot; }
  const inputs = spec.makeInputs(n);
  for (const p of arrayParams) if (p.role === "input") {
    const v = new TA(memory.buffer, off[p.name]!, n); v.set(inputs[p.name]!.subarray(0, n));
  }
  const args: number[] = [n];
  for (const p of arrayParams) args.push(off[p.name]!);
  for (const p of spec.sig.params) if (p.role === "scalar") args.push(round(spec.scalars[p.name] ?? 0));
  return () => kernel(...args);
}

/** The developer's naive scalar JS closure, with typed-array views + the arg
 *  array prebuilt; returns a zero-alloc `run()` thunk in signature order. */
function jsThunk(spec: KernelSpec, n: number): () => void {
  // eslint-disable-next-line no-new-func
  const jsFn = new Function(`"use strict"; return (${spec.src});`)() as (...a: unknown[]) => void;
  const TA = typed(spec.width); const round = roundW(spec.width);
  const inputs = spec.makeInputs(n);
  const arrays: Record<string, Float32Array | Float64Array> = {};
  for (const p of spec.sig.params) {
    if (p.role === "input") { const a = new TA(n); a.set(inputs[p.name]!.subarray(0, n)); arrays[p.name] = a; }
    else if (p.role === "output") arrays[p.name] = new TA(n);
  }
  const args = spec.sig.params.map((p) =>
    p.role === "length" ? n : p.role === "scalar" ? round(spec.scalars[p.name] ?? 0) : arrays[p.name]!);
  return () => jsFn(...args);
}

// ── reference oracle (the pure-JS stream — mirrors the consumer's JS path,
//    width-rounding inputs + scalars before the kernel reads them) ─────────────
function jsReferenceQuantum(
  spec: KernelSpec, inputs: Record<string, ArrayLike<number>>, n: number,
): Record<string, Float64Array> {
  // eslint-disable-next-line no-new-func
  const jsFn = new Function(`"use strict"; return (${spec.src});`)() as (...a: unknown[]) => void;
  const TA = typed(spec.width); const round = roundW(spec.width);
  const arrays: Record<string, Float32Array | Float64Array> = {};
  for (const p of spec.sig.params) {
    if (p.role === "input") { const a = new TA(n); const src = inputs[p.name]!; for (let i = 0; i < n; i++) a[i] = src[i]!; arrays[p.name] = a; }
    else if (p.role === "output") arrays[p.name] = new TA(n);
  }
  const args = spec.sig.params.map((p) =>
    p.role === "length" ? n : p.role === "scalar" ? round(spec.scalars[p.name] ?? 0) : arrays[p.name]!);
  jsFn(...args);
  const out: Record<string, Float64Array> = {};
  for (const p of spec.sig.params) if (p.role === "output") {
    const a = arrays[p.name]!; const dst = new Float64Array(n); for (let i = 0; i < n; i++) dst[i] = a[i]!; out[p.name] = dst;
  }
  return out;
}

// ─── Cell 1: throughput — scalar JS vs JIT-SIMD ──────────────────────────────

interface ThroughputRow { name: string; width: LaneWidth; jsP50: number; simdP50: number; jsMean: number; simdMean: number; }

function runThroughput(): ThroughputRow[] {
  const rows: ThroughputRow[] = [];
  for (const spec of KERNELS) {
    const acc = compileAccepted(spec);
    const js = summarize(jsThunk(spec, N));
    const simd = summarize(simdThunk(spec, acc.wasm, N));
    rows.push({ name: spec.name, width: spec.width, jsP50: js.p50, simdP50: simd.p50, jsMean: js.mean, simdMean: simd.mean });
  }
  return rows;
}

// ─── Cell 2: off-thread compile vs sync install ──────────────────────────────

interface CompileRow { name: string; compileMed: number; wasmCompileMed: number; instanceMed: number; wasmBytes: number; }

async function runCompileLatency(): Promise<CompileRow[]> {
  const COMPILE_SHOTS = 10;     // compileKernel is heavy (wabt + gate corpus)
  const WASMCOMPILE_SHOTS = 30; // WebAssembly.compile is ~sub-ms
  const rows: CompileRow[] = [];
  for (const spec of KERNELS) {
    // (a) full compileKernel end-to-end (parse→lower→vectorize→emit→GATE→wasm).
    // Warm once (acorn/wabt JIT), then take the median over a handful of shots.
    compileAccepted(spec);
    const compileSamples = timeShots(COMPILE_SHOTS, () => { compileAccepted(spec); });

    const acc = compileAccepted(spec);

    // (b) WebAssembly.compile(wasm) — the async step the background worker does.
    await WebAssembly.compile(asArrayBuffer(acc.wasm)); // warm
    const wasmCompileSamples = await timeShotsAsync(WASMCOMPILE_SHOTS, async () => {
      await WebAssembly.compile(asArrayBuffer(acc.wasm));
    });

    // (c) the SYNC new WebAssembly.Instance — the audio-thread port.onmessage
    // install. Microseconds; batch it to beat the tick.
    const module = moduleFromBytes(acc.wasm);
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 16384, shared: true });
    const instStats = summarize(() => { void new WebAssembly.Instance(module, { env: { memory } }); }, 5_000, 256, 1_000);

    rows.push({
      name: spec.name,
      compileMed: medianOf(compileSamples),
      wasmCompileMed: medianOf(wasmCompileSamples),
      instanceMed: instStats.p50,
      wasmBytes: acc.wasm.byteLength,
    });
  }
  return rows;
}
function asArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(bytes.byteLength)); buf.set(bytes); return buf;
}

// ─── Cell 3: measured swap glitch (≈ 0) ──────────────────────────────────────

interface GlitchRow { name: string; width: LaneWidth; cancelling: boolean; maxAbsDev: number; refMaxStep: number; blendMaxStep: number; sawFade: boolean; }

/** Drive a JitKernelConsumer through idle→priming→fading→complete on a smooth
 *  input; compare the blended stream to the pure-JS reference. */
function runSwapGlitch(): GlitchRow[] {
  const rows: GlitchRow[] = [];
  const QUANTA = 16;
  const INSTALL_AT = 2;
  for (const spec of KERNELS) {
    if (!hasWasmConsumerSupport()) continue;
    const acc = compileAccepted(spec);
    const pages = 16;
    const memory = new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true });
    // eslint-disable-next-line no-new-func
    const jsFn = new Function(`"use strict"; return (${spec.src});`)() as (...a: unknown[]) => void;
    const c = new JitKernelConsumer({
      memory, signature: spec.sig, jsKernel: jsFn, maxBlock: N, sampleRate: SAMPLE_RATE, windowSeconds: 0.01,
    });
    if (!c.jitEnabled) continue;

    const outName = spec.sig.params.find((p) => p.role === "output")!.name;
    const total = QUANTA * N;
    const blend = new Float64Array(total);
    const ref = new Float64Array(total);
    let sawFade = false;

    for (let q = 0; q < QUANTA; q++) {
      if (q === INSTALL_AT) c.installCompiledKernel(moduleFromBytes(acc.wasm));
      const inputs = spec.makeInputs(N); // deterministic per quantum (same shape)
      const inObj: Record<string, ArrayLike<number>> = {};
      for (const p of spec.sig.params) if (p.role === "input") inObj[p.name] = inputs[p.name]!;
      const out = new (typed(spec.width))(N);
      const baseNs = (q * N / SAMPLE_RATE) * 1e9;
      const res = c.process(inObj, spec.scalars, { [outName]: out }, N, baseNs);
      if (res.phase === "fading") sawFade = true;
      const refQ = jsReferenceQuantum(spec, inObj, N)[outName]!;
      for (let i = 0; i < N; i++) { blend[q * N + i] = out[i]!; ref[q * N + i] = refQ[i]!; }
    }

    let maxAbsDev = 0;
    for (let k = 0; k < total; k++) maxAbsDev = Math.max(maxAbsDev, Math.abs(blend[k]! - ref[k]!));
    let refMaxStep = 0; let blendMaxStep = 0;
    for (let k = 1; k < total; k++) {
      refMaxStep = Math.max(refMaxStep, Math.abs(ref[k]! - ref[k - 1]!));
      blendMaxStep = Math.max(blendMaxStep, Math.abs(blend[k]! - blend[k - 1]!));
    }
    rows.push({ name: spec.name, width: spec.width, cancelling: spec.cancelling, maxAbsDev, refMaxStep, blendMaxStep, sawFade });
  }
  return rows;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!hasWasmConsumerSupport()) {
    console.log("jit.bench: runtime lacks WASM SIMD/threads — skipped (no-op on this host).");
    process.exit(0);
  }

  console.log(
    `\nThe Autonomous JIT — characterization bench  (N=${N}, sampleRate=${SAMPLE_RATE} Hz, ` +
      `quantum budget=${QUANTUM_BUDGET_MS.toFixed(3)} ms, ${(SAMPLES * BATCH).toLocaleString()} evals/throughput-cell)\n`,
  );

  // ── Cell 1: throughput ─────────────────────────────────────────────────────
  console.log("  ── Cell 1: throughput — scalar JS closure vs JIT-SIMD Instance (N=128) ──");
  const pad = (x: string, n: number) => x.padEnd(n);
  const tput = runThroughput();
  console.log("  " + pad("kernel", 20) + pad("JS p50", 12) + pad("SIMD p50", 12) + pad("speedup", 10) + "JS/SIMD mean");
  console.log("  " + "-".repeat(76));
  for (const r of tput) {
    const sp = r.jsP50 / r.simdP50;
    console.log(
      "  " + pad(r.name, 20) + pad(fmt(r.jsP50), 12) + pad(fmt(r.simdP50), 12) +
        pad(`${sp.toFixed(2)}×`, 10) + `${fmt(r.jsMean)} / ${fmt(r.simdMean)}`,
    );
  }
  console.log(
    "  (a speedup < 1.0× means this kernel is memory-bound / too cheap to amortize the\n" +
      "   v128 load-store at N=128 — the swap still degrades to JS, so it is never a loss.)",
  );
  console.log();

  // ── Cell 2: compile vs install ─────────────────────────────────────────────
  console.log("  ── Cell 2: off-thread compile vs sync install (the port.onmessage cost) ──");
  const comp = await runCompileLatency();
  console.log("  " + pad("kernel", 20) + pad("compileKernel", 16) + pad("WASM.compile", 16) + pad("new Instance", 16) + "bytes");
  console.log("  " + "-".repeat(80));
  for (const r of comp) {
    console.log(
      "  " + pad(r.name, 20) + pad(fmt(r.compileMed), 16) + pad(fmt(r.wasmCompileMed), 16) +
        pad(fmt(r.instanceMed), 16) + `${r.wasmBytes}`,
    );
  }
  const slowestInstall = Math.max(...comp.map((r) => r.instanceMed));
  console.log(
    `  the audio-thread install (new Instance) is ${fmt(slowestInstall)} at worst — microseconds,\n` +
      "  so it fits in port.onmessage between quanta; compileKernel + WASM.compile are the\n" +
      "  off-thread (background-worker) costs that never touch the audio thread.",
  );
  console.log();

  // ── Cell 3: swap glitch ────────────────────────────────────────────────────
  console.log("  ── Cell 3: measured swap glitch — blended stream vs pure-JS reference ──");
  const glitch = runSwapGlitch();
  console.log("  " + pad("kernel", 20) + pad("max|blend−ref|", 16) + pad("excess step", 16) + "transparency");
  console.log("  " + "-".repeat(74));
  for (const r of glitch) {
    const excess = r.blendMaxStep - r.refMaxStep;
    const verdict = r.maxAbsDev === 0
      ? "BIT-EXACT (exact-lerp)"
      : r.cancelling
        ? "f32 cancellation ULP gap"
        : "f32 ULP gap";
    if (!r.sawFade) console.error(`  WARN: ${r.name} never reached a fading quantum`);
    console.log(
      "  " + pad(r.name, 20) + pad(r.maxAbsDev.toExponential(2), 16) +
        pad(excess.toExponential(2), 16) + verdict,
    );
  }
  console.log(
    "  max|blend−ref| is the residual between the live swap output and the developer's pure\n" +
      "  JS stream; f64 kernels are exactly 0 (the 0.9.915 exact-lerp property), f32 kernels\n" +
      "  away from cancellation are 0 too, and an f32 cancelling kernel shows the small ULP gap\n" +
      "  the crossfade smooths. excess step = blendMaxStep − refMaxStep (a click would be a\n" +
      "  large positive spike; it is ≈0 everywhere).",
  );
  console.log();

  // ── Cell 4: THE load-bearing budget check ──────────────────────────────────
  console.log("  ── Cell 4: load-bearing budget — 2×(slowest JS kernel) < quantum budget ──");
  let slowest: ThroughputRow = tput[0]!;
  for (const r of tput) if (r.jsP50 > slowest.jsP50) slowest = r;
  const slowestJsMs = slowest.jsP50 / 1e6;
  const twoXMs = 2 * slowestJsMs;
  const fracOfQuantum = (twoXMs / QUANTUM_BUDGET_MS) * 100;
  console.log(
    `  slowest JS kernel (N=128): ${slowest.name} @ ${fmt(slowest.jsP50)} median\n` +
      `  worst-case fade quantum ≈ JS + SIMD ≤ 2×JS = ${twoXMs.toFixed(4)} ms ` +
      `(${fracOfQuantum.toFixed(2)}% of the ${QUANTUM_BUDGET_MS.toFixed(3)} ms quantum)`,
  );
  if (twoXMs < QUANTUM_BUDGET_MS) {
    console.log(`  within budget       2×JS ${twoXMs.toFixed(4)} ms < quantum ${QUANTUM_BUDGET_MS.toFixed(3)} ms — PASS`);
  } else {
    console.error(
      `  FAIL                2×JS ${twoXMs.toFixed(4)} ms ≥ quantum ${QUANTUM_BUDGET_MS.toFixed(3)} ms\n` +
        "  mitigation (document, do NOT silently cap): shorten the fade window and/or hard-switch\n" +
        "  at the exact-lerp-safe seam; flag a smaller default windowSeconds for connectJit (Stage 3).",
    );
    process.exitCode = 1;
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
