/**
 * delayKernel — Apollo Frontier 7, Stage 3 pins (delay lines / `z⁻N` ring buffers).
 *
 * Proves a developer's echo / comb / damped-comb kernel → gate-verified SCALAR WASM,
 * through REAL wabt compilation + execution, with the SIMULTANEOUS ring semantics
 * (docs/frontier7-statefulness-semantics.md §2.2 + the handoff §2): every `readDelay`
 * reads the slot written `delay` iterations ago, `writeDelay` schedules into slot `w`,
 * and `w` advances at iteration end. Mirrors tests/stateKernel.test.ts's harness.
 *
 * Run: tsx tests/delayKernel.test.ts
 *
 * Pins
 *  1  pure delay `out[i] = x[i−N]` (a length-N ring): accepted scalarOnly, gate bit-exact
 *     vs evalReference, and the deliverable reproduces a delayed copy — over a run that
 *     WRAPS the ring (the headline ring-addressing correctness gate).
 *  2  feedback comb / echo `out[i] = x[i] + g·out[i−N]`: stable (g=0.5 scalar) accepted +
 *     gate-verified; unstable (const 1.05) rejected by the acoustic stability gate, not
 *     cached as accepted (the equivalence gate still accepts — WASM≡ref even diverging).
 *  3  buffer + register COEXISTENCE: a damped feedback comb (a `z⁻¹` register AND a delay
 *     buffer) compiles + gate-verifies — proving the combined slab layout (stateLayout:
 *     registers first, then ring + cursor) is correct across both constructs.
 *  4  grammar round-trip + emitJsKernel faithfulness (f64): a delay kernel round-trips
 *     through the codec (stateBuffer/readDelay/writeDelay words), and the JS fallback ≡
 *     evalReference ≡ scalar WASM, all bit-exact.
 *  6  stateless + registers-only paths untouched: kernelHash(gain) pin holds, a Stage-1
 *     one-pole still compiles + runs bit-exact, and a delay kernel reserves more pages
 *     than a stateless one (the buffer slab is actually counted).
 *  (pin 5 — the cross-quantum runtime persistence pin — lives in tests/stateKernelConsumer.test.ts.)
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  compileIr, acousticGate, evalReference, emitJsKernel, paramLayout, jitMemoryPages,
  KernelCache, kernelToTokens, tokensToString, parseTokens, validateTokens, kernelHash, stateLayout,
  type CompileResult, type LaneWidth,
} from "../src/jit/index.js";
import {
  kernelKey,
  type IrKernel, type IrNode, type IrStore, type IrStateDecl, type IrStateStore,
  type IrStateBufferDecl, type IrStateBufferStore,
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
const RD = (buffer: string, delay: number): IrNode => ({ kind: "readDelay", buffer, delay });
const Bn = (op: BinaryOp, a: IrNode, b: IrNode): IrNode => ({ kind: "binary", op, a, b });
const ST = (array: string, value: IrNode, stride = 1, intercept = 0): IrStore => ({ array, stride, intercept, value });
const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
const SD = (name: string, init = 0): IrStateDecl => ({ name, init });
const SW = (name: string, value: IrNode): IrStateStore => ({ name, value });
const SB = (name: string, length: number): IrStateBufferDecl => ({ name, length });
const WD = (buffer: string, value: IrNode): IrStateBufferStore => ({ buffer, value });
const pb = (name: string): LoopBound => ({ kind: "param", name });

function K(
  width: LaneWidth, params: KernelParam[], bound: LoopBound, stores: IrStore[],
  opts: { stateDecls?: IrStateDecl[]; stateStores?: IrStateStore[]; stateBuffers?: IrStateBufferDecl[]; stateBufferStores?: IrStateBufferStore[] } = {},
): IrKernel {
  const base: IrKernel = { width, bound, stores, signature: { params, width } };
  const out: IrKernel = { ...base };
  if (opts.stateDecls || opts.stateStores) { (out as { stateDecls?: IrStateDecl[] }).stateDecls = opts.stateDecls ?? []; (out as { stateStores?: IrStateStore[] }).stateStores = opts.stateStores ?? []; }
  if (opts.stateBuffers || opts.stateBufferStores) { (out as { stateBuffers?: IrStateBufferDecl[] }).stateBuffers = opts.stateBuffers ?? []; (out as { stateBufferStores?: IrStateBufferStore[] }).stateBufferStores = opts.stateBufferStores ?? []; }
  return out;
}

// ── reference WASM runner with a PERSISTENT state slab sized via stateLayout ──
function makeSlab(ir: IrKernel): Float32Array | Float64Array {
  const TA = ir.width === "f32" ? Float32Array : Float64Array;
  return new TA(Math.max(1, stateLayout(ir).elements));
}
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
// pure delay (f32): out[i] = readDelay(buf, N); writeDelay(buf, x[i]).  ⇒ out[i] = x[i−N].
const DELAY_N = 4;
const pureDelay = K("f32",
  [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", RD("d", DELAY_N))],
  { stateBuffers: [SB("d", DELAY_N)], stateBufferStores: [WD("d", L("x"))] });

// feedback comb (f32, scalar gain): out[i] = x[i] + g·out[i−N]; writeDelay(buf, out).
const COMB_N = 5;
const combExpr = Bn("add", L("x"), Bn("mul", S("g"), RD("c", COMB_N)));
const comb = K("f32",
  [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
  [ST("out", combExpr)],
  { stateBuffers: [SB("c", COMB_N)], stateBufferStores: [WD("c", combExpr)] });

// unstable comb (const gain 1.05 ≥ 1 → diverges): out = x + 1.05·out[i−N].
const unstableExpr = Bn("add", L("x"), Bn("mul", C(1.05), RD("c", COMB_N)));
const unstableComb = K("f32",
  [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", unstableExpr)],
  { stateBuffers: [SB("c", COMB_N)], stateBufferStores: [WD("c", unstableExpr)] });

// damped feedback comb (f32): a z⁻¹ register AND a delay buffer.
//   s' = (1−c)·x + c·s         (one-pole smoothing of the input, register `s`)
//   out = s' + g·readDelay(buf, N)   (comb on the smoothed input)
//   writeState(s, s'); writeDelay(buf, out)
const DAMP_N = 6;
const sExpr = Bn("add", Bn("mul", Bn("sub", C(1), S("c")), L("x")), Bn("mul", S("c"), RS("s")));
const dampOut = Bn("add", sExpr, Bn("mul", S("g"), RD("d", DAMP_N)));
const dampedComb = K("f32",
  [P("n", "length"), P("out", "output"), P("x", "input"), P("c", "scalar"), P("g", "scalar")], pb("n"),
  [ST("out", dampOut)],
  { stateDecls: [SD("s", 0)], stateStores: [SW("s", sExpr)], stateBuffers: [SB("d", DAMP_N)], stateBufferStores: [WD("d", dampOut)] });

// pure delay f64 (for the bit-exact emitJsKernel faithfulness pin)
const pureDelay64 = K("f64",
  [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("add", L("x"), Bn("mul", C(0.5), RD("d", DELAY_N))))],
  { stateBuffers: [SB("d", DELAY_N)], stateBufferStores: [WD("d", Bn("add", L("x"), Bn("mul", C(0.5), RD("d", DELAY_N))))] });

// stateless gain (f32) — the kernelHash regression witness.
const gain = K("f32", [P("n", "length"), P("out", "output"), P("in", "input"), P("g", "scalar")], pb("n"),
  [ST("out", Bn("mul", L("in"), S("g")))]);

// registers-only one-pole (f32) — proves the Stage-1 path still works unchanged.
const onePoleExpr = Bn("add", Bn("mul", Bn("sub", C(1), S("c")), L("x")), Bn("mul", S("c"), RS("s")));
const onePole = K("f32",
  [P("n", "length"), P("out", "output"), P("x", "input"), P("c", "scalar")], pb("n"),
  [ST("out", onePoleExpr)], { stateDecls: [SD("s", 0)], stateStores: [SW("s", onePoleExpr)] });

async function main(): Promise<void> {
  // ── Pin 1: pure delay, gate-verified + reproduces x[i−N] over a WRAPPING run ──
  {
    const acc = expectAccepted(compileIr(pureDelay, { compileWat }), "pure-delay compileIr");
    assertEq(acc.plan.scalarOnly, true, "pure-delay: plan.scalarOnly");
    assertEq(acc.gate.status, "accepted", "pure-delay: gate accepted");
    assert(acc.gate.comparisons > 0, "pure-delay: gate ran comparisons");
    assertEq(acc.gate.worstUlpF32, 0, "pure-delay: scalar-WASM ≡ evalReference bit-exact");
    assert(acc.scalarWat.includes("$__state"), "pure-delay: scalar module threads a $__state arg");
    assertEq(acc.stateBuffers.length, 1, "pure-delay: accepted result exposes the delay buffer");
    assertEq(acc.stateBuffers[0]!.length, DELAY_N, "pure-delay: buffer length surfaced");

    // n=10 > N=4 wraps the ring 2×+; out[i] = x[i−N] (cold 0 for the first N).
    const n = 10;
    const x = Array.from({ length: n }, (_, i) => (i + 1) * 0.1);
    const ref = evalReference(pureDelay, { x }, {}, n)["out"]!;
    const out = runStateful(acc.wasm, pureDelay, n, { x }, {}, makeSlab(pureDelay));
    assertEq(maxAbsDiff(out, ref), 0, "pure-delay: deliverable ≡ evalReference (bit-exact f32)");
    for (let i = 0; i < n; i++) {
      const want = i < DELAY_N ? 0 : Math.fround(x[i - DELAY_N]!);
      assertEq(Math.fround(out[i]!), want, `pure-delay: out[${i}] = x[${i - DELAY_N}] (delayed copy)`);
    }
    ok("1 pure delay: accepted scalarOnly, gate bit-exact, reproduces x[i−N] across a ring wrap");
  }

  // ── Pin 2: feedback comb — stable accepted, unstable acoustically rejected ────
  {
    const acc = expectAccepted(compileIr(comb, { compileWat }), "comb compileIr");
    assertEq(acc.plan.scalarOnly, true, "comb: scalarOnly");
    assertEq(acc.gate.worstUlpF32, 0, "comb: gate bit-exact");
    const n = 64; const g = 0.5;
    const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 3 * i) / n));
    const ref = evalReference(comb, { x }, { g }, n)["out"]!;
    const out = runStateful(acc.wasm, comb, n, { x }, { g }, makeSlab(comb));
    assertEq(maxAbsDiff(out, ref), 0, "comb: deliverable ≡ evalReference (bit-exact, feedback closes through the ring)");

    // the stable comb passes the acoustic stability gate (probe g=0.5)
    const stable = acousticGate(comb);
    assert(stable.ok, `comb: stable comb passes the acoustic gate (${stable.ok ? "ok" : ("reason" in stable ? stable.reason : "?")})`);

    // the unstable (const 1.05) comb is acoustically rejected, equivalence-accepted
    const bad = acousticGate(unstableComb);
    assert(!bad.ok, "comb: unstable feedback rejected by the acoustic gate");
    if (!bad.ok) assert(/unstable-growth|peak-out-of-bounds|non-finite/.test(bad.reason), `comb: rejection is a divergence (${bad.reason})`);
    const eq = compileIr(unstableComb, { compileWat });
    assertEq(eq.status, "accepted", "comb: unstable comb passes the EQUIVALENCE gate (WASM≡ref)");
    const cache = new KernelCache();
    const rej = cache.getOrCompile(kernelToTokens(unstableComb), { compileWat });
    assertEq(rej.status, "rejected-acoustic", "comb: KernelCache returns rejected-acoustic for the unstable comb");
    assertEq(cache.size, 0, "comb: unstable comb not cached as accepted");
    ok("2 feedback comb: stable accepted + gate-verified; unstable rejected-acoustic (the free stability gate)");
  }

  // ── Pin 3: buffer + register coexistence (damped comb) ────────────────────────
  {
    const acc = expectAccepted(compileIr(dampedComb, { compileWat }), "damped-comb compileIr");
    assertEq(acc.plan.scalarOnly, true, "damped-comb: scalarOnly");
    assertEq(acc.gate.worstUlpF32, 0, "damped-comb: gate bit-exact");
    assertEq(acc.stateDecls.length, 1, "damped-comb: 1 register surfaced");
    assertEq(acc.stateBuffers.length, 1, "damped-comb: 1 buffer surfaced");
    // the combined slab is registers-first then ring+cursor (1 + DAMP_N + 1 elements).
    assertEq(stateLayout(dampedComb).elements, 1 + DAMP_N + 1, "damped-comb: combined slab = reg + ring + cursor");

    const n = 64; const sc = { c: 0.5, g: 0.5 };
    const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 4 * i) / n));
    const ref = evalReference(dampedComb, { x }, sc, n)["out"]!;
    const out = runStateful(acc.wasm, dampedComb, n, { x }, sc, makeSlab(dampedComb));
    assertEq(maxAbsDiff(out, ref), 0, "damped-comb: deliverable ≡ evalReference (register + buffer slab correct)");
    ok("3 coexistence: a z⁻¹ register AND a delay buffer compile + gate-verify (combined slab layout correct)");
  }

  // ── Pin 4: grammar round-trip + emitJsKernel faithfulness (f64) ───────────────
  {
    const tokens = kernelToTokens(pureDelay64);
    const text = tokensToString(tokens);
    assert(text.includes(`stateBuffer:d:${DELAY_N}`), "grammar: text carries the buffer decl");
    assert(text.includes("readDelay:d:"), "grammar: text carries readDelay");
    assert(text.includes("writeDelay:d"), "grammar: text carries writeDelay");
    const round = validateTokens(parseTokens(text));
    assert(round.ok, "grammar: round-tripped delay stream re-validates");
    if (round.ok) assertEq(kernelKey(round.ir), kernelKey(pureDelay64), "grammar: round-trip preserves kernelKey");

    const acc = expectAccepted(compileIr(pureDelay64, { compileWat }), "pure-delay f64");
    const n = 40;
    const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 3 * i) / n));
    const refOut = evalReference(pureDelay64, { x }, {}, n)["out"]!;

    const js = emitJsKernel(pureDelay64);
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${js});`)() as (...a: unknown[]) => void;
    const outArr = new Float64Array(n);
    const xArr = Float64Array.from(x);
    const slab = new Float64Array(stateLayout(pureDelay64).elements);
    fn(n, outArr, xArr, slab); // signature order + trailing __state slab
    assertEq(maxAbsDiff(Array.from(outArr), refOut), 0, "emitJsKernel: JS fallback ≡ evalReference (f64 bit-exact)");

    const wasmOut = runStateful(acc.wasm, pureDelay64, n, { x }, {}, new Float64Array(stateLayout(pureDelay64).elements));
    assertEq(maxAbsDiff(wasmOut, refOut), 0, "emitJsKernel: scalar WASM ≡ evalReference (f64) ⇒ all three agree");
    ok("4 grammar round-trip + emitJsKernel/WASM/evalReference all agree (f64 delay)");
  }

  // ── Pin 6: stateless + registers-only paths untouched (the frontier gate) ─────
  {
    // stateless gain: SIMD path unchanged + the canonical hash regression pin.
    const g = expectAccepted(compileIr(gain, { compileWat }), "gain (stateless)");
    assertEq(g.plan.scalarOnly, false, "stateless: gain NOT scalarOnly");
    assertEq(g.stateBuffers.length, 0, "stateless: no buffers on the accepted result");
    assert(!g.scalarWat.includes("$__state"), "stateless: no $state in the scalar module");
    assertEq(kernelHash(gain), "72b5c2e5a7a5f117", "stateless: kernelHash(gain) regression pin preserved");

    // registers-only one-pole: still compiles + the hash is the byte-identical register key.
    const op = expectAccepted(compileIr(onePole, { compileWat }), "one-pole (registers-only)");
    assertEq(op.plan.scalarOnly, true, "registers-only: one-pole scalarOnly");
    assertEq(op.stateBuffers.length, 0, "registers-only: no buffers (the dbuf segment is skipped)");
    const n = 64; const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / n));
    const ref = evalReference(onePole, { x }, { c: 0.6 }, n)["out"]!;
    const out = runStateful(op.wasm, onePole, n, { x }, { c: 0.6 }, makeSlab(onePole));
    assertEq(maxAbsDiff(out, ref), 0, "registers-only: one-pole deliverable ≡ evalReference (Stage-1 path intact)");

    // jitMemoryPages: a delay kernel reserves more than the stateless one (slab counted),
    // and stateElements=0 is byte-identical to the stateless no-arg form.
    assertEq(jitMemoryPages(gain.signature, 128), jitMemoryPages(gain.signature, 128, 16, 0), "stateless page count: default == explicit 0");
    const tight = Math.floor((65536 - 16) / (3 * 4)); // 3 f32 slabs ≈ fill one page
    const statelessPages = jitMemoryPages(gain.signature, tight, 16, 0);
    const delayPages = jitMemoryPages(pureDelay.signature, tight, 16, stateLayout(pureDelay).elements);
    assert(delayPages > statelessPages, `delay kernel reserves a state slab (${delayPages} > ${statelessPages} pages)`);
    ok("6 stateless + registers-only untouched: gain hash pin, one-pole bit-exact, delay slab counted");
  }

  console.log("\nAll delayKernel (Frontier 7, Stage 3) pins passed.");
}

await main();
