/**
 * stateKernelConsumer — Apollo Frontier 7, Stage 2 pins (the persistent-state runtime).
 *
 * Proves a gate-verified STATEFUL kernel (a one-pole IIR) actually RUNS click-free
 * across `process()` quanta in the `JitKernelConsumer`: state persists across calls
 * (no per-quantum reset), the hot-swap keeps each generation's recurrence memory in
 * its OWN slab, promotion is continuous, a non-finite incoming aborts to the live JS
 * state, and the stateless path is byte-for-byte untouched (the frontier gate).
 *
 * Real wabt → real gate-PASSED scalar WASM → a real `JitKernelConsumer` over a fake
 * shared memory, streaming audio quanta. Mirrors tests/JitKernelConsumer.test.ts (the
 * stateless runtime pins) + reuses the wabt harness + IR builders from
 * tests/stateKernel.test.ts. `tsx` script; `assert`/`assertEq`/`ok`; no framework.
 *
 * Pins
 *  1  JS-fallback persistence (no install): the stateful JS fallback carries state
 *     across many small quanta — concat output ≡ one big evalReference run.
 *  2  click-free swap with INDEPENDENT state: install mid-stream; the two generations
 *     use disjoint state slabs holding different (warm-A vs cold-B) recurrence memory;
 *     output is finite + click-free throughout.
 *  3  promotion continuity (install at q0, f64 lockstep): the whole swap stream is
 *     BIT-EXACT to evalReference — the promoted SIMD continues from its accrued state
 *     past `complete` with no re-seed.
 *  4  non-finite abort snaps to the live JS state: a poisoned incoming kernel aborts
 *     the fade; the consumer keeps emitting the JS fallback, whose state advanced once
 *     per quantum (no double-advance), so the whole stream ≡ evalReference.
 *  5  stateless-path-untouched frontier pin: a stateless consumer has no state slab,
 *     its layout + page count are byte-identical to pre-Stage-2, and `stateDecls: []`
 *     is identical to omitting it.
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  compileIr, evalReference, emitJsKernel, jitMemoryPages,
  type LaneWidth,
} from "../src/jit/index.js";
import { JitKernelConsumer, MAX_STATE_REGISTERS, type JitMemoryRegion } from "../src/jit/JitKernelConsumer.js";
import {
  type IrKernel, type IrNode, type IrStore, type IrStateDecl, type IrStateStore,
  type LoopBound, type KernelParam, type ParamRole, type BinaryOp,
} from "../src/jit/ir.js";

// ── wabt-backed compileWat (identical to the rest of the JIT suite) ──────────
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

// ── IR builders (same shorthand as tests/stateKernel.test.ts) ─────────────────
const C = (value: number): IrNode => ({ kind: "const", value });
const S = (name: string): IrNode => ({ kind: "scalar", name });
const L = (array: string, stride = 1, intercept = 0): IrNode => ({ kind: "load", array, stride, intercept });
const RS = (name: string): IrNode => ({ kind: "readState", name });
const Bn = (op: BinaryOp, a: IrNode, b: IrNode): IrNode => ({ kind: "binary", op, a, b });
const ST = (array: string, value: IrNode, stride = 1, intercept = 0): IrStore => ({ array, stride, intercept, value });
const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
const SD = (name: string, init = 0): IrStateDecl => ({ name, init });
const SW = (name: string, value: IrNode): IrStateStore => ({ name, value });
const pb = (name: string): LoopBound => ({ kind: "param", name });

function K(
  width: LaneWidth, params: KernelParam[], bound: LoopBound, stores: IrStore[],
  stateDecls?: IrStateDecl[], stateStores?: IrStateStore[],
): IrKernel {
  const base = { width, bound, stores, signature: { params, width } };
  return stateDecls || stateStores ? { ...base, stateDecls: stateDecls ?? [], stateStores: stateStores ?? [] } : base;
}

// one-pole lowpass (f64): out[i] = (1-c)*x[i] + c*s; s := out[i]. f64 so the gate's
// scalar WASM, evalReference, and emitJsKernel all agree BIT-EXACT (lockstep swaps).
const onePoleExpr = Bn("add", Bn("mul", Bn("sub", C(1), S("c")), L("x")), Bn("mul", S("c"), RS("s")));
const onePole = K("f64",
  [P("n", "length"), P("out", "output"), P("x", "input"), P("c", "scalar")], pb("n"),
  [ST("out", onePoleExpr)], [SD("s", 0)], [SW("s", onePoleExpr)]);

// stateless gain (f64) — the "stateless path untouched" witness.
const gain = K("f64", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
  [ST("out", Bn("mul", L("x"), S("g")))]);

// ── helpers ───────────────────────────────────────────────────────────────────
function sharedMemory(pages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true });
}
function moduleFromBytes(bytes: Uint8Array): WebAssembly.Module {
  const buf = new Uint8Array(bytes.byteLength); buf.set(bytes);
  return new WebAssembly.Module(buf);
}
function reconstituteJs(ir: IrKernel): (...a: unknown[]) => void {
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict"; return (${emitJsKernel(ir)});`)() as (...a: unknown[]) => void;
}
function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}
function sine(total: number, cycles: number, amp = 0.8): Float64Array {
  const x = new Float64Array(total);
  for (let k = 0; k < total; k++) x[k] = amp * Math.sin((2 * Math.PI * cycles * k) / total);
  return x;
}
function compileOnePole(): { wasm: Uint8Array; stateDecls: ReadonlyArray<IrStateDecl> } {
  const r = compileIr(onePole, { compileWat });
  assert(r.status === "accepted", `one-pole must accept (got ${r.status})`);
  assertEq(r.stateDecls.length, 1, "one-pole exposes 1 state decl on the accepted result");
  return { wasm: r.wasm, stateDecls: r.stateDecls };
}

// A poison module matching the stateful one-pole f64 ABI [n, out, x, __state, c] that
// writes non-finite (1/0 = inf) to every output element — a broken "incoming" kernel.
const POISON_WAT = `(module
  (import "env" "memory" (memory 1 16384 shared))
  (func $kernel (export "kernel") (param $n i32) (param $out i32) (param $x i32) (param $st i32) (param $c f64)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $exit (loop $loop
      (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
      (f64.store (i32.add (local.get $out) (i32.mul (local.get $i) (i32.const 8)))
                 (f64.div (f64.const 1) (f64.const 0)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))))`;

// ─── Pin 1: JS-fallback persistence across quanta (no install) ───────────────

function testJsFallbackPersistence(): void {
  const mem = sharedMemory(8);
  const { stateDecls } = compileOnePole();
  const c = new JitKernelConsumer({
    memory: mem, signature: onePole.signature, jsKernel: reconstituteJs(onePole),
    maxBlock: N, sampleRate: SR, stateDecls,
  });
  assertEq(c.phase(), "idle", "idle (no install)");

  const QUANTA = 8; const total = QUANTA * N; const coef = 0.6;
  // A high-ish frequency so the one-pole lowpass visibly attenuates (not a passthrough).
  const x = sine(total, 80);
  const ref = evalReference(onePole, { x: Array.from(x) }, { c: coef }, total)["out"]!;

  const stream = new Float64Array(total);
  for (let q = 0; q < QUANTA; q++) {
    const xq = x.subarray(q * N, q * N + N);
    const out = new Float64Array(N);
    const r = c.process({ x: xq }, { c: coef }, { out }, N, (q * N / SR) * 1e9);
    assertEq(r.phase, "idle", `stays idle at q=${q}`);
    assertEq(r.ranSimd, false, `pure JS at q=${q}`);
    stream.set(out, q * N);
  }
  // The headline: 8×128 quanta with a kept slab ≡ one big 1024 run. If state reset
  // every quantum the filter would restart each block and this would diverge.
  assertEq(maxAbsDiff(stream, ref), 0, "JS fallback persists state across quanta (8×128 ≡ 1024)");
  assert(maxAbsDiff(stream, x) > 0.05, "the recurrence is real (output ≠ input passthrough)");
  ok("1 JS-fallback persistence: stateful fallback carries state across process() calls (≡ evalReference)");
}

// ─── Pin 2: click-free swap with INDEPENDENT (disjoint) per-generation state ──

function testIndependentStateSwap(): void {
  const mem = sharedMemory(8);
  const { wasm, stateDecls } = compileOnePole();
  const c = new JitKernelConsumer({
    memory: mem, signature: onePole.signature, jsKernel: reconstituteJs(onePole),
    maxBlock: N, sampleRate: SR, windowSeconds: 0.01, stateDecls,
  });

  // describeLayout exposes the two state slabs, pairwise disjoint with everything.
  const { regions } = c.describeLayout();
  const labels = regions.map((r) => r.label).sort();
  assertEq(labels.join("|"), "in:x|outA:out|outB:out|stateA|stateB", "layout adds stateA + stateB slabs");
  const overlap = (a: JitMemoryRegion, b: JitMemoryRegion) => a.offset < b.offset + b.bytes && b.offset < a.offset + a.bytes;
  for (let i = 0; i < regions.length; i++)
    for (let j = i + 1; j < regions.length; j++)
      assert(!overlap(regions[i]!, regions[j]!), `regions ${regions[i]!.label}/${regions[j]!.label} disjoint`);
  const stateAOff = regions.find((r) => r.label === "stateA")!.offset;
  const stateBOff = regions.find((r) => r.label === "stateB")!.offset;
  assert(stateAOff !== stateBOff, "the two state slabs are at distinct offsets");

  const QUANTA = 12; const total = QUANTA * N; const coef = 0.6;
  const x = sine(total, 5);
  const stream = new Float64Array(total);
  let sawFading = false; let checkedIndependence = false;
  for (let q = 0; q < QUANTA; q++) {
    // Install mid-stream (q3), AFTER current-A (the JS fallback) has warmed up — so
    // the incoming B starts COLD while A is warm: the two generations must hold
    // independent state or the swap is corrupt.
    if (q === 3) {
      assert(c.installCompiledKernel(moduleFromBytes(wasm), stateDecls), "mid-stream install arms");
      assertEq(c.phase(), "priming", "primed after install");
      // Right after install: slab-B is seeded COLD (0) while slab-A is WARM (≠ 0).
      const sA = new Float64Array(mem.buffer, stateAOff, 1)[0]!;
      const sB = new Float64Array(mem.buffer, stateBOff, 1)[0]!;
      assertEq(sB, 0, "incoming slab-B seeded cold (init 0) at install");
      assert(sA !== 0, "current slab-A is warm (it advanced over the priming quanta)");
      assert(sA !== sB, "the two generations hold INDEPENDENT recurrence state");
      checkedIndependence = true;
    }
    const xq = x.subarray(q * N, q * N + N);
    const out = new Float64Array(N);
    const r = c.process({ x: xq }, { c: coef }, { out }, N, (q * N / SR) * 1e9);
    if (r.phase === "fading") sawFading = true;
    stream.set(out, q * N);
  }
  assert(checkedIndependence, "checked slab independence at install");
  assert(sawFading, "observed a fading quantum");
  assert(c.isUpgraded(), "upgraded to SIMD after the swap");

  // Click-free: the blended stream is finite, bounded, and has no discontinuity. The
  // input is a smooth sine and both generations are smooth one-poles, so the blend's
  // per-sample step stays small (a corrupted/shared slab would spike).
  let maxStep = 0;
  for (let k = 0; k < total; k++) {
    assert(Number.isFinite(stream[k]!), `output finite at k=${k}`);
    assert(Math.abs(stream[k]!) < 2, `output bounded at k=${k}`);
    if (k > 0) maxStep = Math.max(maxStep, Math.abs(stream[k]! - stream[k - 1]!));
  }
  assert(maxStep < 0.2, `swap is click-free (max inter-sample step ${maxStep.toFixed(4)} < 0.2)`);
  ok("2 independent-state swap: disjoint per-generation slabs (warm-A vs cold-B), finite + click-free");
}

// ─── Pin 3: promotion continuity — full f64 swap BIT-EXACT to evalReference ───

function testPromotionContinuity(): void {
  const mem = sharedMemory(8);
  const { wasm, stateDecls } = compileOnePole();
  const c = new JitKernelConsumer({
    memory: mem, signature: onePole.signature, jsKernel: reconstituteJs(onePole),
    maxBlock: N, sampleRate: SR, windowSeconds: 0.01, stateDecls,
  });
  // Install BEFORE the first quantum: A (JS) and B (SIMD) both start cold and stay
  // in f64 lockstep (the gate proves scalar WASM ≡ evalReference, emitJsKernel ≡
  // evalReference) — so the exact-lerp blend is exactly A throughout, the promotion
  // copy is a no-op continuation, and the SIMD continues bit-exact past `complete`.
  assert(c.installCompiledKernel(moduleFromBytes(wasm), stateDecls), "install before first quantum");
  assertEq(c.phase(), "priming", "primed");

  const QUANTA = 16; const total = QUANTA * N; const coef = 0.5;
  const x = sine(total, 3);
  const ref = evalReference(onePole, { x: Array.from(x) }, { c: coef }, total)["out"]!;

  const stream = new Float64Array(total);
  let sawComplete = false; let completeAt = -1;
  for (let q = 0; q < QUANTA; q++) {
    const xq = x.subarray(q * N, q * N + N);
    const out = new Float64Array(N);
    const r = c.process({ x: xq }, { c: coef }, { out }, N, (q * N / SR) * 1e9);
    if (r.phase === "complete" && completeAt < 0) { completeAt = q; }
    if (r.phase === "complete") sawComplete = true;
    stream.set(out, q * N);
  }
  assert(sawComplete, "swap reached complete");
  assert(c.isUpgraded(), "consumer is upgraded (SIMD steady)");
  // BIT-EXACT to evalReference over the WHOLE stream — including every fading sample
  // AND every post-promotion sample. The post-`complete` tail being exact is the
  // promotion-continuity proof: a re-seed at promotion would restart the filter and
  // diverge from `ref` after `completeAt`.
  assertEq(maxAbsDiff(stream, ref), 0, "full stateful swap stream is BIT-EXACT to evalReference");
  // belt-and-braces: the promotion boundary sample follows smoothly (no jump).
  if (completeAt > 0) {
    const k0 = completeAt * N;
    assertEq(stream[k0]!, ref[k0]!, "promotion-boundary sample is exact (continues accrued state)");
  }
  ok("3 promotion continuity: full f64 stateful swap bit-exact to evalReference (no re-seed at promotion)");
}

// ─── Pin 4: non-finite incoming → abort to the live JS state ─────────────────

function testAbortToLiveJsState(): void {
  const mem = sharedMemory(8);
  const { stateDecls } = compileOnePole();
  const c = new JitKernelConsumer({
    memory: mem, signature: onePole.signature, jsKernel: reconstituteJs(onePole),
    maxBlock: N, sampleRate: SR, windowSeconds: 0.01, stateDecls,
  });

  const QUANTA = 8; const total = QUANTA * N; const coef = 0.6;
  const x = sine(total, 5);
  const ref = evalReference(onePole, { x: Array.from(x) }, { c: coef }, total)["out"]!;
  // The poison kernel matches the stateful one-pole ABI (its stateDecls match, so the
  // consumer accepts the install) but writes non-finite output.
  const poison = moduleFromBytes(compileWat(POISON_WAT, "poison"));

  const stream = new Float64Array(total);
  let sawAbort = false;
  for (let q = 0; q < QUANTA; q++) {
    if (q === 3) {
      assert(c.installCompiledKernel(poison, stateDecls), "poison module installs (matches the stateful ABI)");
      assertEq(c.phase(), "priming", "primed with poison");
    }
    const xq = x.subarray(q * N, q * N + N);
    const out = new Float64Array(N);
    const r = c.process({ x: xq }, { c: coef }, { out }, N, (q * N / SR) * 1e9);
    if (r.abortedToJs) sawAbort = true;
    for (let i = 0; i < N; i++) assert(Number.isFinite(out[i]!), `output finite at q=${q} i=${i} (poison never emitted)`);
    stream.set(out, q * N);
  }
  assert(sawAbort, "a fading quantum aborted on the non-finite incoming");
  assert(!c.isUpgraded(), "reverted to the JS fallback (not upgraded)");
  // The JS fallback ran exactly ONCE per quantum (idle/priming/the aborted fading
  // quantum), advancing slab-A's live state with no double-advance — so the WHOLE
  // stream equals the cold-started one-pole reference. The poison only ever touched
  // slab-B, never slab-A.
  assertEq(maxAbsDiff(stream, ref), 0, "post-abort stream ≡ evalReference (JS state stayed live, no double-advance)");
  ok("4 non-finite abort: snaps to the live JS state; poison never emitted; state intact");
}

// ─── Pin 5: stateless path untouched (the frontier gate) ─────────────────────

function testStatelessUntouched(): void {
  const mem = sharedMemory(8);
  const jsGain = reconstituteJs(gain);
  const c = new JitKernelConsumer({ memory: mem, signature: gain.signature, jsKernel: jsGain, maxBlock: N, sampleRate: SR });
  const { regions, baseEnd } = c.describeLayout();
  // No state slab: layout is exactly the pre-Stage-2 three regions.
  const labels = regions.map((r) => r.label).sort();
  assertEq(labels.join("|"), "in:x|outA:out|outB:out", "stateless layout has NO state slabs");
  assert(!regions.some((r) => r.label === "stateA" || r.label === "stateB"), "no stateA/stateB regions");

  // `stateDecls: []` is identical to omitting it (byte-for-byte layout).
  const c2 = new JitKernelConsumer({ memory: sharedMemory(8), signature: gain.signature, jsKernel: jsGain, maxBlock: N, sampleRate: SR, stateDecls: [] });
  const l2 = c2.describeLayout();
  assertEq(l2.baseEnd, baseEnd, "stateDecls:[] ⇒ same regionEnd as omitting stateDecls");
  assertEq(l2.regions.map((r) => `${r.label}@${r.offset}+${r.bytes}`).join("|"),
    regions.map((r) => `${r.label}@${r.offset}+${r.bytes}`).join("|"),
    "stateDecls:[] ⇒ byte-identical region layout");

  // jitMemoryPages: stateRegisters=0 (default) is byte-identical to the no-arg form
  // (the page-count frontier gate); a positive count reserves the fixed-max window.
  assertEq(jitMemoryPages(gain.signature, N), jitMemoryPages(gain.signature, N, 16, 0), "stateless page count unchanged (default == explicit 0)");
  // A maxBlock chosen so the fixed-max state reservation tips it over a page boundary
  // proves the reservation is actually counted when stateful.
  const tight = Math.floor((65536 - 16) / (3 * 8)); // 3 f64 slabs ≈ fill one page
  const statelessPages = jitMemoryPages(gain.signature, tight, 16, 0);
  const statefulPages = jitMemoryPages(gain.signature, tight, 16, 1);
  assert(statefulPages > statelessPages, `stateful reserves the ${MAX_STATE_REGISTERS}-register window (${statefulPages} > ${statelessPages} pages)`);

  // Output is exactly the pure JS stream (the stateless runtime path is unchanged).
  const g = 0.75; const x = sine(N, 3);
  const out = new Float64Array(N);
  const r = c.process({ x }, { g }, { out }, N, 0);
  assertEq(r.ranSimd, false, "stateless idle is pure JS");
  const refOut = new Float64Array(N); for (let i = 0; i < N; i++) refOut[i] = g * x[i]!;
  assertEq(maxAbsDiff(out, refOut), 0, "stateless output bit-exact to JS");
  ok("5 stateless path untouched: no state slab, layout + page count unchanged, output bit-exact");
}

async function main(): Promise<void> {
  testJsFallbackPersistence();
  testIndependentStateSwap();
  testPromotionContinuity();
  testAbortToLiveJsState();
  testStatelessUntouched();
  console.log("\nAll stateKernelConsumer (Frontier 7, Stage 2) pins passed.");
}

await main();
