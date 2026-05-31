/**
 * stateKernel — Apollo Frontier 7, Stage 1 pins (stateful kernels).
 *
 * Proves a developer's IIR filter → gate-verified SCALAR WASM, through REAL wabt
 * compilation + execution, with the SIMULTANEOUS state semantics
 * (docs/frontier7-statefulness-semantics.md §2.2). Mirrors the compileTokens /
 * JitCompiler wabt harness + the numbered-pin style.
 *
 * Run: tsx tests/stateKernel.test.ts
 *
 * Pins
 *  1  one-pole lowpass (f32) → accepted, scalarOnly, gate proved scalar-WASM ≡
 *     evalReference bit-exact (worst ULP 0). The deliverable reproduces the filter,
 *     and persists state across quanta (one call(512) ≡ two calls(256+256)).
 *  2  biquad DF1 (f32) → accepted scalarOnly, gate-verified; the deliverable matches
 *     evalReference, and the SIMULTANEOUS shift is order-independent in the IR.
 *  3  stability gate (Frontier 7 §3): a stable filter passes the acoustic gate; an
 *     unstable feedback (const 1.05) is REJECTED (peak / unstable-growth) and the
 *     KernelCache returns `rejected-acoustic` (not cached as accepted).
 *  4  the stateless SIMD path is UNTOUCHED — a stateless kernel is scalarOnly:false,
 *     emits no `$state`, and `kernelHash(gain)` is the byte-identical regression pin.
 *  5  grammar round-trip + emitJsKernel behavioral faithfulness — a stateful kernel
 *     round-trips through the codec, and (f64, finite input) the emitted JS fallback
 *     ≡ evalReference ≡ the scalar WASM deliverable, all bit-exact (the §6 claim that
 *     the three evaluators agree).
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  compileIr, compileTokens, acousticGate, evalReference, emitJsKernel, paramLayout,
  KernelCache, kernelToTokens, tokensToString, parseTokens, validateTokens, kernelHash,
  type CompileResult, type LaneWidth,
} from "../src/jit/index.js";
import {
  kernelKey,
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

// ── IR builders ───────────────────────────────────────────────────────────────
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

// ── reference WASM runner with a PERSISTENT state slab (the Stage-2 convention) ─
// Drives the deliverable via the canonical paramLayout: [trip, ...arrays, __state?,
// ...scalars]. `stateSlab` is read into memory before the call + read back after, so
// repeated calls persist state across "quanta".
function runStateful(
  wasm: Uint8Array, ir: IrKernel, n: number,
  inputRows: Record<string, number[]>, scalarVals: Record<string, number>,
  stateSlab: Float32Array | Float64Array,
): number[] {
  const TA = ir.width === "f32" ? Float32Array : Float64Array;
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 16384, shared: true });
  const buf = new Uint8Array(wasm.byteLength); buf.set(wasm);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(buf), { env: { memory } });
  const kernel = inst.exports["kernel"] as (...a: number[]) => void;
  const slot = 8192;
  const layout = paramLayout(ir);
  const trip = layout[0]!.name;
  let off = 16;
  const offsets: Record<string, number> = {};
  const args: number[] = [];
  for (let k = 0; k < layout.length; k++) {
    const p = layout[k]!;
    if (k === 0 && p.name === trip) { args.push(n); continue; }
    if (p.wasm === "i32") { offsets[p.name] = off; args.push(off); off += slot; }
    else { args.push(ir.width === "f32" ? Math.fround(scalarVals[p.name] ?? 0) : (scalarVals[p.name] ?? 0)); }
  }
  for (const name of Object.keys(inputRows)) {
    const v = new TA(memory.buffer, offsets[name]!, n);
    inputRows[name]!.forEach((x, i) => (v[i] = x));
  }
  if (offsets["__state"] !== undefined) {
    const v = new TA(memory.buffer, offsets["__state"]!, stateSlab.length);
    v.set(stateSlab as never);
  }
  kernel(...args);
  if (offsets["__state"] !== undefined) {
    const v = new TA(memory.buffer, offsets["__state"]!, stateSlab.length);
    stateSlab.set(v as never);
  }
  const outName = ir.signature.params.find((p) => p.role === "output")!.name;
  return Array.from(new TA(memory.buffer, offsets[outName]!, n));
}

function expectAccepted(r: CompileResult, label: string): Extract<CompileResult, { status: "accepted" }> {
  if (r.status !== "accepted") {
    const detail = r.status === "rejected-source" ? JSON.stringify(r.diagnostic)
      : r.status === "rejected-gate" ? JSON.stringify(r.gate.mismatch ?? r.gate.reason)
        : JSON.stringify((r as { reason?: string }).reason);
    assert(false, `${label}: expected accepted, got ${r.status} — ${detail}`);
  }
  return r as Extract<CompileResult, { status: "accepted" }>;
}

function maxAbsDiff(a: number[], b: number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

// ── the kernels ────────────────────────────────────────────────────────────────
// one-pole lowpass (f32): out[i] = (1-c)*x[i] + c*s; s := out[i].
const onePoleExpr = Bn("add", Bn("mul", Bn("sub", C(1), S("c")), L("x")), Bn("mul", S("c"), RS("s")));
const onePole = K("f32",
  [P("n", "length"), P("out", "output"), P("x", "input"), P("c", "scalar")], pb("n"),
  [ST("out", onePoleExpr)], [SD("s", 0)], [SW("s", onePoleExpr)]);

// the f64 twin (for the bit-exact emitJsKernel faithfulness pin)
const onePole64 = K("f64",
  [P("n", "length"), P("out", "output"), P("x", "input"), P("c", "scalar")], pb("n"),
  [ST("out", onePoleExpr)], [SD("s", 0)], [SW("s", onePoleExpr)]);

// biquad DF1 (f32): y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2; shift the delay line.
const biquadY = Bn("sub",
  Bn("add", Bn("add", Bn("mul", S("b0"), L("x")), Bn("mul", S("b1"), RS("x1"))), Bn("mul", S("b2"), RS("x2"))),
  Bn("add", Bn("mul", S("a1"), RS("y1")), Bn("mul", S("a2"), RS("y2"))));
const biquad = K("f32",
  [P("n", "length"), P("out", "output"), P("x", "input"),
    P("b0", "scalar"), P("b1", "scalar"), P("b2", "scalar"), P("a1", "scalar"), P("a2", "scalar")],
  pb("n"),
  [ST("out", biquadY)],
  [SD("x1"), SD("x2"), SD("y1"), SD("y2")],
  // simultaneous semantics ⇒ the listing order is irrelevant
  [SW("x1", L("x")), SW("x2", RS("x1")), SW("y1", biquadY), SW("y2", RS("y1"))]);

// stateless gain (the "stateless path untouched" witness) — input named "in" to
// match the canonical kernelHash regression pin (72b5c2e5a7a5f117).
const gain = K("f32", [P("n", "length"), P("out", "output"), P("in", "input"), P("g", "scalar")], pb("n"),
  [ST("out", Bn("mul", L("in"), S("g")))]);

// unstable: out = x + 1.05*s; s := out  (pole at 1.05 → diverges)
const unstableExpr = Bn("add", L("x"), Bn("mul", C(1.05), RS("s")));
const unstable = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", unstableExpr)], [SD("s", 0)], [SW("s", unstableExpr)]);

async function main(): Promise<void> {
  // ── Pin 1: one-pole lowpass, gate-verified + persistent across quanta ─────
  {
    // both the IR entry and the token entry accept
    const accIr = expectAccepted(compileIr(onePole, { compileWat }), "one-pole compileIr");
    const accTok = expectAccepted(compileTokens(kernelToTokens(onePole), { compileWat }), "one-pole compileTokens");
    assertEq(accIr.plan.scalarOnly, true, "one-pole: plan.scalarOnly");
    assertEq(accIr.gate.status, "accepted", "one-pole: gate accepted");
    assert(accIr.gate.comparisons > 0, "one-pole: gate ran comparisons");
    assertEq(accIr.gate.worstUlpF32, 0, "one-pole: scalar-WASM ≡ evalReference bit-exact (worst ULP 0)");
    assert(accIr.scalarWat.includes("$__state"), "one-pole: scalar module threads a $__state arg");
    assert(accTok.plan.scalarOnly, "one-pole token path: scalarOnly");

    // run the deliverable vs evalReference over a clean sine, c=0.6
    const n = 512;
    const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / n));
    const ref = evalReference(onePole, { x }, { c: 0.6 }, n)["out"]!;

    const slabFull = new Float32Array([0]);
    const full = runStateful(accIr.wasm, onePole, n, { x }, { c: 0.6 }, slabFull);
    assertEq(maxAbsDiff(full, ref), 0, "one-pole: deliverable ≡ evalReference (bit-exact f32)");

    // cross-quantum persistence: one call(512) ≡ two calls(256 + 256) with a kept slab
    const slabHalves = new Float32Array([0]);
    const h1 = runStateful(accIr.wasm, onePole, 256, { x: x.slice(0, 256) }, { c: 0.6 }, slabHalves);
    const h2 = runStateful(accIr.wasm, onePole, 256, { x: x.slice(256) }, { c: 0.6 }, slabHalves);
    assertEq(maxAbsDiff(h1.concat(h2), full), 0, "one-pole: state persists across quanta (256+256 ≡ 512)");
    // and the recurrence is real: a non-trivial filtered signal, not a passthrough
    assert(maxAbsDiff(full, x) > 0.05, "one-pole: output actually filters (≠ input)");
    ok("1 one-pole lowpass: accepted scalarOnly, gate bit-exact, deliverable filters + persists across quanta");
  }

  // ── Pin 2: biquad DF1, gate-verified ──────────────────────────────────────
  {
    const acc = expectAccepted(compileIr(biquad, { compileWat }), "biquad compileIr");
    assertEq(acc.plan.scalarOnly, true, "biquad: scalarOnly");
    assertEq(acc.gate.status, "accepted", "biquad: gate accepted");
    assertEq(acc.gate.worstUlpF32, 0, "biquad: gate bit-exact");

    const n = 400;
    const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 7 * i) / n));
    const sc = { b0: 0.2, b1: 0.1, b2: 0.05, a1: -0.4, a2: 0.2 };
    const ref = evalReference(biquad, { x }, sc, n)["out"]!;
    const out = runStateful(acc.wasm, biquad, n, { x }, sc, new Float32Array(4));
    assertEq(maxAbsDiff(out, ref), 0, "biquad: deliverable ≡ evalReference (bit-exact)");
    ok("2 biquad DF1: accepted scalarOnly, gate bit-exact, 4-register delay line correct");
  }

  // ── Pin 3: the stability gate (Frontier 7 §3) ─────────────────────────────
  {
    // stable one-pole (probe scalar 0.5 ⇒ pole 0.5) passes the acoustic gate
    const stable = acousticGate(onePole);
    assert(stable.ok, `stability: stable one-pole passes the acoustic gate (got ${stable.ok ? "ok" : ("reason" in stable ? stable.reason : "?")})`);

    // the unstable feedback is gate-rejected (peak runaway or unstable-growth)
    const bad = acousticGate(unstable);
    assert(!bad.ok, "stability: unstable feedback is rejected by the acoustic gate");
    if (!bad.ok) assert(/unstable-growth|peak-out-of-bounds|non-finite/.test(bad.reason), `stability: rejection reason is a divergence (${bad.reason})`);

    // the equivalence gate still ACCEPTS the unstable kernel (WASM ≡ reference even
    // when both diverge) — it is the ACOUSTIC gate that catches instability.
    const eq = compileIr(unstable, { compileWat });
    assertEq(eq.status, "accepted", "stability: unstable kernel passes the EQUIVALENCE gate (WASM≡ref)");

    // through the cache, the acoustic gate fires ⇒ rejected-acoustic, not stored.
    const cache = new KernelCache();
    const rej = cache.getOrCompile(kernelToTokens(unstable), { compileWat });
    assertEq(rej.status, "rejected-acoustic", "stability: KernelCache returns rejected-acoustic");
    assertEq(cache.size, 0, "stability: an unstable kernel is not cached as accepted");
    ok("3 stability gate: stable passes, unstable rejected-acoustic (the free stability check)");
  }

  // ── Pin 4: the stateless SIMD path is untouched ───────────────────────────
  {
    const acc = expectAccepted(compileIr(gain, { compileWat }), "gain (stateless)");
    assertEq(acc.plan.scalarOnly, false, "stateless: gain is NOT scalarOnly");
    assert(!acc.scalarWat.includes("$__state"), "stateless: no $state in the scalar module");
    assert(!acc.simdWat.includes("$__state"), "stateless: no $state in the SIMD module");
    assert(!paramLayout(gain).some((p) => p.name === "__state"), "stateless: paramLayout has no __state arg");
    assertEq(kernelHash(gain), "72b5c2e5a7a5f117", "stateless: kernelHash(gain) regression pin preserved");
    ok("4 stateless path untouched: gain SIMD unchanged, no $state, hash regression pin holds");
  }

  // ── Pin 5: grammar round-trip + emitJsKernel faithfulness ─────────────────
  {
    // round-trip the one-pole through the codec (tokens → text → tokens → IR)
    const tokens = kernelToTokens(onePole);
    const text = tokensToString(tokens);
    assert(text.includes("state:s:0"), "grammar: text carries the state decl");
    assert(text.includes("readState:s"), "grammar: text carries readState");
    assert(text.includes("writeState:s"), "grammar: text carries writeState");
    const round = validateTokens(parseTokens(text));
    assert(round.ok, "grammar: round-tripped stateful stream re-validates");
    if (round.ok) assertEq(kernelKey(round.ir), kernelKey(onePole), "grammar: round-trip preserves kernelKey");

    // emitJsKernel faithfulness (f64, finite input): JS fallback ≡ evalReference ≡ WASM
    const acc = expectAccepted(compileIr(onePole64, { compileWat }), "one-pole f64");
    const n = 300;
    const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 4 * i) / n));
    const refOut = evalReference(onePole64, { x }, { c: 0.7 }, n)["out"]!;

    const js = emitJsKernel(onePole64);
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${js});`)() as (...a: unknown[]) => void;
    const outArr = new Float64Array(n);
    const xArr = Float64Array.from(x);
    const slab = new Float64Array([0]);
    fn(n, outArr, xArr, 0.7, slab); // signature order + trailing __state slab
    const jsOut = Array.from(outArr);
    assertEq(maxAbsDiff(jsOut, refOut), 0, "emitJsKernel: JS fallback ≡ evalReference (f64 bit-exact)");

    const wasmOut = runStateful(acc.wasm, onePole64, n, { x }, { c: 0.7 }, new Float64Array([0]));
    assertEq(maxAbsDiff(wasmOut, refOut), 0, "emitJsKernel: scalar WASM ≡ evalReference (f64) ⇒ all three agree");
    ok("5 grammar round-trip + emitJsKernel/WASM/evalReference all agree (f64)");
  }

  console.log("\nAll stateKernel (Frontier 7, Stage 1) pins passed.");
}

await main();
