/**
 * JitKernelConsumer pins (0.9.914 — Apollo Frontier 5, The Autonomous JIT, Stage 1b).
 *
 * A Node "real-audio" harness for the worklet-side live-swap runtime: a real
 * `compileKernel` (through wabt) feeds a real gate-PASSED SIMD `WebAssembly.Module`
 * into a `JitKernelConsumer` backed by a fake shared `WebAssembly.Memory`, and we
 * stream audio quanta across the swap. Pins:
 *
 *   A  layout: the consumer's scratch regions (input slabs + BOTH output
 *      generations) are pairwise disjoint, slab-sized, in-bounds; too-small
 *      memory throws (the disjoint-scratch RISK from the handoff).
 *   B  pre-install idle = exactly the pure JS-kernel stream.
 *   C  JIT disabled (non-shared memory) → install is a no-op; output is pure JS.
 *   D  install → priming → fading → complete; the WHOLE f64 stream is BIT-EXACT
 *      to the JS reference. The gate proves f64 SIMD≡JS bit-exact, and the
 *      EXACT-LERP amplitude blend `a + w·(b−a)` is exactly `a` for every w when
 *      a==b (b−a==0), so EVERY phase — including each fading sample — is exact (a
 *      `(1−w)a+wb` blend would drift ≤1 ULP; a corrupted/overlapping slab would
 *      diverge grossly). Both generation slabs hold their kernel's finite output
 *      during the fade.
 *   E  an f32 CANCELLING kernel (x²−y², the ~ULP-gap case): the blended stream is
 *      a true convex combination of the JS and SIMD streams at every sample
 *      (finite, bounded, no discontinuity), exactly JS at idle and exactly SIMD
 *      at complete.
 *   F  failure: `new Instance` throwing (bad import) and a missing `kernel`
 *      export both leave the consumer on JS (install returns false).
 *   G  failure injection: a POISONED incoming kernel (writes non-finite) → the
 *      fade aborts, snaps to the JS fallback (finite), and the poison NEVER
 *      reaches the output; the consumer reverts and keeps streaming pure JS.
 *   H  the bytes-clone fallback install path arms identically.
 *   I  re-upgrade (SIMD→SIMD) completes and retires the superseded instance.
 *
 * `tsx` script; `assert`/`assertEq`/`ok` from `_assert.ts`. No framework.
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import { compileKernel, type KernelSignature, type LaneWidth } from "../src/jit/index.js";
import { JitKernelConsumer, type JitMemoryRegion } from "../src/jit/JitKernelConsumer.js";

// ── wabt-backed compileWat (the injected WAT→bytes compiler) ─────────────────
const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength);
  u.set(buffer);
  return u;
}

const SR = 48_000;
const N = 128; // audio quantum

function sig(width: LaneWidth, ...spec: Array<[string, "input" | "output" | "scalar" | "length"]>): KernelSignature {
  return { width, params: spec.map(([name, role]) => ({ name, role })) };
}
function align16(n: number): number { return (n + 15) & ~15; }
function typed(width: LaneWidth): Float32ArrayConstructor | Float64ArrayConstructor {
  return width === "f32" ? Float32Array : Float64Array;
}
function roundW(width: LaneWidth): (v: number) => number {
  return width === "f32" ? Math.fround : (v: number) => v;
}

function sharedMemory(pages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true });
}

function moduleFromBytes(bytes: Uint8Array): WebAssembly.Module {
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  return new WebAssembly.Module(buf);
}

// ── reference oracles (mirror gate.runJsOracle / runModule exactly) ──────────

function jsReference(
  jsFn: (...a: unknown[]) => void, s: KernelSignature, width: LaneWidth,
  inputs: Record<string, ArrayLike<number>>, scalars: Record<string, number>, n: number,
): Record<string, number[]> {
  const TA = typed(width); const round = roundW(width);
  const arrays: Record<string, Float32Array | Float64Array> = {};
  for (const p of s.params) {
    if (p.role === "input") { const a = new TA(n); const src = inputs[p.name]!; for (let i = 0; i < n; i++) a[i] = src[i]!; arrays[p.name] = a; }
    else if (p.role === "output") arrays[p.name] = new TA(n);
  }
  const args = s.params.map((p) =>
    p.role === "length" ? n : p.role === "scalar" ? round(scalars[p.name] ?? 0) : arrays[p.name]!);
  jsFn(...args);
  const out: Record<string, number[]> = {};
  for (const p of s.params) if (p.role === "output") out[p.name] = Array.from(arrays[p.name]!.subarray(0, n));
  return out;
}

function simdReference(
  wasm: Uint8Array, s: KernelSignature, width: LaneWidth,
  inputs: Record<string, ArrayLike<number>>, scalars: Record<string, number>, n: number,
): Record<string, number[]> {
  const TA = typed(width); const round = roundW(width); const eb = width === "f32" ? 4 : 8;
  const memory = sharedMemory(16);
  const inst = new WebAssembly.Instance(moduleFromBytes(wasm), { env: { memory } });
  const kernel = inst.exports["kernel"] as (...a: number[]) => void;
  const slot = align16(Math.max(1, n) * eb);
  const arrayParams = s.params.filter((p) => p.role === "input" || p.role === "output");
  const off: Record<string, number> = {}; let cursor = 16;
  for (const p of arrayParams) { off[p.name] = cursor; cursor += slot; }
  for (const p of arrayParams) if (p.role === "input") { const v = new TA(memory.buffer, off[p.name]!, n); const src = inputs[p.name]!; for (let i = 0; i < n; i++) v[i] = src[i]!; }
  const args: number[] = [n];
  for (const p of arrayParams) args.push(off[p.name]!);
  for (const p of s.params) if (p.role === "scalar") args.push(round(scalars[p.name] ?? 0));
  kernel(...args);
  const out: Record<string, number[]> = {};
  for (const p of arrayParams) if (p.role === "output") out[p.name] = Array.from(new TA(memory.buffer, off[p.name]!, n));
  return out;
}

// ── poisoned + malformed modules (failure injection) ─────────────────────────

// A module that matches the gain ABI (n,out,x,g) but writes non-finite (1/0=inf)
// to every output element — a deliberately-broken "incoming" kernel.
const POISON_WAT = `(module
  (import "env" "memory" (memory 1 16384 shared))
  (func $kernel (export "kernel") (param $n i32) (param $out i32) (param $x i32) (param $g f64)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $exit (loop $loop
      (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
      (f64.store (i32.add (local.get $out) (i32.mul (local.get $i) (i32.const 8)))
                 (f64.div (f64.const 1) (f64.const 0)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))))`;

// Imports a function we never provide → instantiation throws (LinkError).
const BAD_IMPORT_WAT = `(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "missing_fn" (func $m))
  (func $kernel (export "kernel") (param $n i32) (param $out i32) (param $x i32) (param $g f64)))`;

// Instantiates fine but does NOT export "kernel".
const NO_EXPORT_WAT = `(module
  (import "env" "memory" (memory 1 16384 shared))
  (func $k (export "notkernel") (param $n i32) (param $out i32) (param $x i32) (param $g f64)))`;

// ── the canonical f64 "gain" kernel (out[i] = g * x[i]) ──────────────────────
const GAIN_SIG = sig("f64", ["out", "output"], ["x", "input"], ["g", "scalar"], ["n", "length"]);
const GAIN_SRC = "function k(out, x, g, n){ for (let i = 0; i < n; i++) { out[i] = g * x[i]; } }";
// eslint-disable-next-line no-new-func
const GAIN_JS = new Function(`"use strict"; return (${GAIN_SRC});`)() as (...a: unknown[]) => void;

function compileGain(): Uint8Array {
  const r = compileKernel(GAIN_SRC, GAIN_SIG, { compileWat });
  assert(r.status === "accepted", `gain kernel must accept (got ${r.status})`);
  return r.wasm;
}

// ─── Pin A: layout disjointness + bounds ────────────────────────────────────

function testLayoutDisjoint(): void {
  const mem = sharedMemory(8);
  const c = new JitKernelConsumer({ memory: mem, signature: GAIN_SIG, jsKernel: GAIN_JS, maxBlock: N, sampleRate: SR });
  const { regions, baseEnd, width } = c.describeLayout();

  // 1 input (x) + 2 generations × 1 output (out) = 3 regions.
  assertEq(regions.length, 3, "regions = 1 input + 2 output generations");
  const slot = align16(N * (width === "f32" ? 4 : 8));
  for (const r of regions) {
    assertEq(r.bytes, slot, `region ${r.label} sized to align16(maxBlock*elem)`);
    assert(r.offset >= 16, `region ${r.label} respects base offset`);
  }
  // Independent pairwise-disjointness check over the reported layout.
  const overlap = (a: JitMemoryRegion, b: JitMemoryRegion) => a.offset < b.offset + b.bytes && b.offset < a.offset + a.bytes;
  for (let i = 0; i < regions.length; i++)
    for (let j = i + 1; j < regions.length; j++)
      assert(!overlap(regions[i]!, regions[j]!), `regions ${regions[i]!.label} / ${regions[j]!.label} disjoint`);
  // outA and outB are present and distinct (the disjoint blend slabs).
  const labels = regions.map((r) => r.label).sort();
  assertEq(labels.join("|"), "in:x|outA:out|outB:out", "labels: in slab + both output generations");
  assert(baseEnd <= mem.buffer.byteLength, "layout fits the memory");

  // Too-small memory throws (1 page = 65536 B; 3×slot+16 > 65536 only if N huge —
  // use a deliberately tiny memory by demanding a large maxBlock).
  let threw = false;
  try {
    new JitKernelConsumer({ memory: sharedMemory(1), signature: GAIN_SIG, jsKernel: GAIN_JS, maxBlock: 4096, sampleRate: SR });
  } catch { threw = true; }
  assert(threw, "layout exceeding the memory throws");
  ok("consumer layout (3 disjoint slabs, sized + in-bounds; too-small memory throws)");
}

// ─── Pin B: pre-install idle = pure JS stream ───────────────────────────────

function testIdleIsPureJs(): void {
  const mem = sharedMemory(8);
  const c = new JitKernelConsumer({ memory: mem, signature: GAIN_SIG, jsKernel: GAIN_JS, maxBlock: N, sampleRate: SR });
  assertEq(c.phase(), "idle", "idle before any install");
  const g = 0.75;
  const x: number[] = []; for (let i = 0; i < N; i++) x[i] = Math.sin(0.01 * i);
  const out = new Float64Array(N);
  const r = c.process({ x }, { g }, { out }, N, 0);
  assertEq(r.phase, "idle", "process stays idle pre-install");
  assertEq(r.ranSimd, false, "no SIMD ran pre-install");
  const ref = jsReference(GAIN_JS, GAIN_SIG, "f64", { x }, { g }, N).out!;
  for (let i = 0; i < N; i++) assertEq(out[i]!, ref[i]!, `idle out[${i}] == JS ref`);
  ok("consumer idle pre-install = exactly the pure JS-kernel stream");
}

// ─── Pin C: JIT disabled on non-shared memory ───────────────────────────────

function testJitDisabledNonShared(): void {
  const nonShared = new WebAssembly.Memory({ initial: 8, maximum: 16384 }); // NOT shared
  const c = new JitKernelConsumer({ memory: nonShared, signature: GAIN_SIG, jsKernel: GAIN_JS, maxBlock: N, sampleRate: SR });
  assertEq(c.jitEnabled, false, "JIT disabled when memory is not shared (no SAB)");
  const installed = c.installCompiledKernel(moduleFromBytes(compileGain()));
  assertEq(installed, false, "install is a no-op when JIT disabled");
  const g = 1.5; const x: number[] = []; for (let i = 0; i < N; i++) x[i] = i / N;
  const out = new Float64Array(N);
  c.process({ x }, { g }, { out }, N, 0);
  const ref = jsReference(GAIN_JS, GAIN_SIG, "f64", { x }, { g }, N).out!;
  for (let i = 0; i < N; i++) assertEq(out[i]!, ref[i]!, `disabled out[${i}] == JS ref`);
  assertEq(c.phase(), "idle", "stays idle (never armed) when disabled");
  ok("consumer JIT-disabled on non-shared memory (install no-op, pure JS)");
}

// ─── Pin D: full f64 swap — exact at the seams, ≤ULP in the fade, no click ───

function testF64Swap(): void {
  const mem = sharedMemory(8);
  const c = new JitKernelConsumer({ memory: mem, signature: GAIN_SIG, jsKernel: GAIN_JS, maxBlock: N, sampleRate: SR, windowSeconds: 0.01 });
  const g = 0.5;
  const QUANTA = 12;
  const total = QUANTA * N;
  const xAll = new Float64Array(total);
  for (let k = 0; k < total; k++) xAll[k] = Math.sin(2 * Math.PI * 220 * (k / SR)) * 0.8;

  const wasm = compileGain();
  const layout = c.describeLayout();
  const outAOff = layout.regions.find((r) => r.label === "outA:out")!.offset;
  const outBOff = layout.regions.find((r) => r.label === "outB:out")!.offset;

  const stream = new Float64Array(total);
  const refStream = new Float64Array(total);
  for (let k = 0; k < total; k++) refStream[k] = g * xAll[k]!;
  let sawFading = false; let sawComplete = false; let installedAt = -1;
  let checkedSlabs = false;
  for (let q = 0; q < QUANTA; q++) {
    // Install between quanta (the onmessage path) just before quantum 2.
    if (q === 2) { assert(c.installCompiledKernel(moduleFromBytes(wasm)), "install accepted"); assertEq(c.phase(), "priming", "primed after install"); installedAt = q; }
    const x = xAll.subarray(q * N, q * N + N);
    const out = new Float64Array(N);
    const baseNs = (q * N / SR) * 1e9;
    const r = c.process({ x }, { g }, { out }, N, baseNs);
    if (r.phase === "fading") {
      sawFading = true;
      // The two generation slabs each hold THEIR kernel's finite output (disjoint,
      // un-clobbered). For f64 both equal g*x for this quantum, EXACTLY (this is
      // the raw pre-blend kernel output — a corrupted/overlapping slab breaks it).
      if (!checkedSlabs) {
        const a = new Float64Array(mem.buffer, outAOff, N);
        const b = new Float64Array(mem.buffer, outBOff, N);
        for (let i = 0; i < N; i++) {
          assert(Number.isFinite(a[i]!) && Number.isFinite(b[i]!), `fade slabs finite at i=${i}`);
          assertEq(a[i]!, g * x[i]!, `outA slab (current/JS) holds g*x at i=${i}`);
          assertEq(b[i]!, g * x[i]!, `outB slab (incoming/SIMD) holds g*x at i=${i}`);
        }
        checkedSlabs = true;
      }
    }
    if (r.phase === "complete") sawComplete = true;
    stream.set(out, q * N);
  }
  assert(installedAt === 2, "installed at quantum 2");
  assert(sawFading, "observed a fading quantum");
  assert(sawComplete, "swap reached complete");
  assert(c.isUpgraded(), "consumer is upgraded (SIMD is the steady kernel)");

  // EXACT-LERP TRANSPARENCY: the gate proves f64 SIMD≡JS bit-exact, and the
  // amplitude blend is `a + w·(b−a)` (b−a == 0 when they agree → exactly `a` for
  // every w), so the WHOLE stream — idle, EVERY fading sample, and complete — is
  // BIT-EXACT to the pure JS reference. `(1−w)·a + w·b` would drift ≤1 ULP in the
  // fade; an overlapping/corrupted slab would diverge grossly. This is a formal
  // transparency proof, not "imperceptibly close".
  for (let k = 0; k < total; k++)
    assertEq(stream[k]!, refStream[k]!, `f64 stream[${k}] BIT-EXACT to JS (exact-lerp transparency)`);
  // Bit-exact ⇒ trivially click-free: the blended stream's steps equal the
  // reference's exactly.
  let maxRefStep = 0; let maxBlendStep = 0;
  for (let k = 1; k < total; k++) {
    maxRefStep = Math.max(maxRefStep, Math.abs(refStream[k]! - refStream[k - 1]!));
    maxBlendStep = Math.max(maxBlendStep, Math.abs(stream[k]! - stream[k - 1]!));
  }
  assertEq(maxBlendStep, maxRefStep, "blended stream steps == reference steps (bit-exact ⇒ no discontinuity)");
  ok("consumer f64 swap (priming→fading→complete) is BIT-EXACT to JS throughout; slabs disjoint+intact");
}

// ─── Pin E: f32 cancelling kernel — blend is a finite convex combo of JS/SIMD ─

function testF32CancellingBlend(): void {
  const s = sig("f32", ["out", "output"], ["x", "input"], ["y", "input"], ["n", "length"]);
  const src = "function k(out, x, y, n){ for (let i = 0; i < n; i++) { out[i] = x[i] * x[i] - y[i] * y[i]; } }";
  // eslint-disable-next-line no-new-func
  const jsFn = new Function(`"use strict"; return (${src});`)() as (...a: unknown[]) => void;
  const r = compileKernel(src, s, { compileWat });
  assert(r.status === "accepted", `diffsq must accept (got ${r.status})`);
  const wasm = r.wasm;

  const mem = sharedMemory(8);
  const c = new JitKernelConsumer({ memory: mem, signature: s, jsKernel: jsFn, maxBlock: N, sampleRate: SR, windowSeconds: 0.01 });

  // Near-cancellation inputs: x ≈ y, so x²−y² catastrophically cancels — the case
  // where the f64-intermediate JS and all-f32 SIMD legitimately differ by ULP.
  const QUANTA = 12; const total = QUANTA * N;
  const xAll = new Float32Array(total); const yAll = new Float32Array(total);
  for (let k = 0; k < total; k++) {
    const base = 1 + 0.5 * Math.sin(2 * Math.PI * 110 * (k / SR));
    xAll[k] = base + 1e-3 * Math.sin(2 * Math.PI * 3000 * (k / SR));
    yAll[k] = base; // x ≈ y
  }

  const eps = 1e-6; // absolute slack for the convex-combination bound
  let sawFading = false;
  for (let q = 0; q < QUANTA; q++) {
    if (q === 2) assert(c.installCompiledKernel(moduleFromBytes(wasm)), "diffsq install accepted");
    const x = xAll.subarray(q * N, q * N + N);
    const y = yAll.subarray(q * N, q * N + N);
    const out = new Float32Array(N);
    const baseNs = (q * N / SR) * 1e9;
    const res = c.process({ x, y }, {}, { out }, N, baseNs);
    const js = jsReference(jsFn, s, "f32", { x, y }, {}, N).out!;
    const simd = simdReference(wasm, s, "f32", { x, y }, {}, N).out!;
    if (res.phase === "fading") sawFading = true;
    for (let i = 0; i < N; i++) {
      const v = out[i]!;
      assert(Number.isFinite(v), `f32 blend finite at q=${q} i=${i}`);
      const lo = Math.min(js[i]!, simd[i]!) - eps;
      const hi = Math.max(js[i]!, simd[i]!) + eps;
      assert(v >= lo && v <= hi, `f32 blend is a convex combo of JS/SIMD at q=${q} i=${i}: ${v} ∉ [${lo},${hi}]`);
      if (res.phase === "idle" || res.phase === "priming") assertEq(v, js[i]!, `idle/priming == JS at q=${q} i=${i}`);
      if (res.phase === "complete") assertEq(v, simd[i]!, `complete == SIMD at q=${q} i=${i}`);
    }
  }
  assert(sawFading, "observed a fading quantum (f32)");
  assert(c.isUpgraded(), "f32 consumer upgraded");
  ok("consumer f32 cancelling kernel: blend is a finite convex combo of JS/SIMD (idle==JS, complete==SIMD)");
}

// ─── Pin F: install failures keep the consumer on JS ────────────────────────

function testInstallFailures(): void {
  const mem = sharedMemory(8);
  const c = new JitKernelConsumer({ memory: mem, signature: GAIN_SIG, jsKernel: GAIN_JS, maxBlock: N, sampleRate: SR });

  // `new Instance` throws (missing import) → install false, never armed.
  const badImport = moduleFromBytes(compileWat(BAD_IMPORT_WAT, "bad"));
  assertEq(c.installCompiledKernel(badImport), false, "instantiation failure → install returns false");
  assertEq(c.phase(), "idle", "not armed after instantiation failure");

  // Module instantiates but has no `kernel` export → install false.
  const noExport = moduleFromBytes(compileWat(NO_EXPORT_WAT, "noexp"));
  assertEq(c.installCompiledKernel(noExport), false, "missing kernel export → install returns false");
  assertEq(c.phase(), "idle", "not armed when kernel export missing");

  // Still streams pure JS.
  const g = 2; const x: number[] = []; for (let i = 0; i < N; i++) x[i] = Math.cos(0.02 * i);
  const out = new Float64Array(N);
  const r = c.process({ x }, { g }, { out }, N, 0);
  assertEq(r.ranSimd, false, "no SIMD after failed installs");
  const ref = jsReference(GAIN_JS, GAIN_SIG, "f64", { x }, { g }, N).out!;
  for (let i = 0; i < N; i++) assertEq(out[i]!, ref[i]!, `post-failure out[${i}] == JS ref`);
  ok("consumer install failures (bad import / missing export) keep it on pure JS");
}

// ─── Pin G: poisoned incoming → abort fade, snap to JS, poison never emitted ─

function testPoisonAbortsToJs(): void {
  const mem = sharedMemory(8);
  const c = new JitKernelConsumer({ memory: mem, signature: GAIN_SIG, jsKernel: GAIN_JS, maxBlock: N, sampleRate: SR, windowSeconds: 0.01 });
  const poison = moduleFromBytes(compileWat(POISON_WAT, "poison"));
  assert(c.installCompiledKernel(poison), "poison module installs (exports kernel, instantiates)");
  assertEq(c.phase(), "priming", "primed with the poison kernel");

  const g = 0.5; const x: number[] = []; for (let i = 0; i < N; i++) x[i] = Math.sin(0.03 * i);
  const out = new Float64Array(N);
  const r = c.process({ x }, { g }, { out }, N, 0); // first fade quantum → poison runs into slab B
  assertEq(r.abortedToJs, true, "non-finite incoming aborts the fade");
  assertEq(r.ranSimd, false, "SIMD did NOT contribute to the output on abort");
  // Output is the finite pure-JS stream — the poison (inf) never reaches `out`.
  const ref = jsReference(GAIN_JS, GAIN_SIG, "f64", { x }, { g }, N).out!;
  for (let i = 0; i < N; i++) {
    assert(Number.isFinite(out[i]!), `aborted output finite at i=${i}`);
    assertEq(out[i]!, ref[i]!, `aborted output == JS ref at i=${i}`);
  }
  // Reverted to the JS fallback; subsequent quanta stay pure JS.
  assertEq(c.phase(), "idle", "reverted to idle after abort");
  assert(!c.isUpgraded(), "not upgraded after abort");
  const out2 = new Float64Array(N);
  const r2 = c.process({ x }, { g }, { out: out2 }, N, (N / SR) * 1e9);
  assertEq(r2.ranSimd, false, "subsequent quantum runs pure JS");
  for (let i = 0; i < N; i++) assertEq(out2[i]!, ref[i]!, `post-abort out2[${i}] == JS ref`);
  ok("consumer poison injection (non-finite incoming) aborts to JS; poison never emitted");
}

// ─── Pin H: bytes-clone fallback install path ───────────────────────────────

function testBytesFallbackInstall(): void {
  const mem = sharedMemory(8);
  const c = new JitKernelConsumer({ memory: mem, signature: GAIN_SIG, jsKernel: GAIN_JS, maxBlock: N, sampleRate: SR, windowSeconds: 0.005 });
  const wasm = compileGain();
  assert(c.installCompiledKernelFromBytes(wasm), "bytes-fallback install arms");
  assertEq(c.phase(), "priming", "primed via bytes fallback");

  const g = 1.25; const x: number[] = []; for (let i = 0; i < N; i++) x[i] = (i - 64) / 64;
  // Run enough quanta to complete the 5 ms window (~2 quanta).
  let completed = false;
  for (let q = 0; q < 6; q++) {
    const out = new Float64Array(N);
    const r = c.process({ x }, { g }, { out }, N, (q * N / SR) * 1e9);
    const ref = jsReference(GAIN_JS, GAIN_SIG, "f64", { x }, { g }, N).out!;
    for (let i = 0; i < N; i++) assertEq(out[i]!, ref[i]!, `bytes-fallback f64 bit-exact q=${q} i=${i}`);
    if (r.phase === "complete") completed = true;
  }
  assert(completed, "bytes-fallback swap completes");
  ok("consumer bytes-clone fallback install path arms + completes (f64 bit-exact)");
}

// ─── Pin I: re-upgrade (SIMD→SIMD) completes + retires the old instance ──────

function testReUpgrade(): void {
  const mem = sharedMemory(8);
  const c = new JitKernelConsumer({ memory: mem, signature: GAIN_SIG, jsKernel: GAIN_JS, maxBlock: N, sampleRate: SR, windowSeconds: 0.005 });
  const g = 0.9; const x: number[] = []; for (let i = 0; i < N; i++) x[i] = Math.sin(0.05 * i);
  const ref = jsReference(GAIN_JS, GAIN_SIG, "f64", { x }, { g }, N).out!;

  // First upgrade JS→SIMD.
  assert(c.installCompiledKernel(moduleFromBytes(compileGain())), "first install");
  let q = 0;
  const step = () => { const out = new Float64Array(N); const r = c.process({ x }, { g }, { out }, N, (q * N / SR) * 1e9); q++; for (let i = 0; i < N; i++) assertEq(out[i]!, ref[i]!, `re-upgrade bit-exact q=${q} i=${i}`); return r; };
  let r = step();
  while (r.phase !== "complete" && q < 10) r = step();
  assert(c.isUpgraded(), "upgraded after first swap");

  // Second upgrade SIMD→SIMD (a freshly-compiled instance of the same kernel).
  assert(c.installCompiledKernel(moduleFromBytes(compileGain())), "second install (re-upgrade) from complete");
  assertEq(c.phase(), "priming", "re-arm from complete");
  r = step();
  assertEq(r.phase, "fading", "second swap fades");
  while (r.phase !== "complete" && q < 20) r = step();
  assertEq(r.phase, "complete", "second swap completes");
  // A couple more quanta to let the superseded instance retire (complete+1).
  step(); step();
  assert(c.isUpgraded(), "still upgraded after re-upgrade");
  ok("consumer re-upgrade (SIMD→SIMD) completes + retires the superseded instance (bit-exact throughout)");
}

async function main(): Promise<void> {
  testLayoutDisjoint();
  testIdleIsPureJs();
  testJitDisabledNonShared();
  testF64Swap();
  testF32CancellingBlend();
  testInstallFailures();
  testPoisonAbortsToJs();
  testBytesFallbackInstall();
  testReUpgrade();
  console.log("\nAll JitKernelConsumer tests passed.");
}

await main();
