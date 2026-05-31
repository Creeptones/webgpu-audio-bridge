/**
 * compileTokens + KernelCache + emitJsKernel — Stage-1 pins (Apollo Frontier 6).
 *
 * Proves the model-free tokens → IR → gate → accepted pipeline end-to-end through
 * REAL wabt compilation + execution, the content-addressed characterized cache, and
 * the IR→JS fallback emitter. A DETERMINISTIC hand-authored palette stands in for
 * the Stage-3 SLM. Mirrors the JitCompiler/connectJit wabt harness + the ring
 * frontiers' numbered-pin style.
 *
 * Run: tsx tests/compileTokens.test.ts
 *
 * Pins
 *  1  palette compiles — every hand-authored token kernel → accepted, gate ran
 *     comparisons, gate status accepted (bit-exact). The accepted SIMD bytes also
 *     re-run independently (gain) to confirm the deliverable executes.
 *  2  E_TOKENS — an out-of-grammar token stream → rejected-source with the new
 *     E_TOKENS diagnostic (rejection is a VALUE; the syntax gate is gate #1).
 *  3  cache — getOrCompile hit returns the SAME object with cached:true and does
 *     NOT invoke compileWat (compile-count probe); a distinct kernel grows the
 *     store; a rejected stream is not cached. Characterized fields are populated.
 *  4  emitJsKernel round-trip — lower(parse(emitJsKernel(ir))) ≡ ir by kernelKey,
 *     modulo neg(const c)↔const(-c) (JS has no negative literal). The structural
 *     identity guarantees the worklet JS fallback is faithful to the scalar ref.
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  compileTokens, KernelCache, emitJsKernel,
  kernelToTokens, tokensToKernel, tokensToString,
  lowerKernel, parseProgram,
  type KernelToken, type CompileResult, type LaneWidth,
} from "../src/jit/index.js";
import {
  kernelKey,
  type IrKernel, type IrNode, type IrStore, type LoopBound,
  type KernelParam, type ParamRole, type UnaryOp, type BinaryOp,
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

// ── IR builders (mirror kernelGrammar.test.ts) ───────────────────────────────
const C = (value: number): IrNode => ({ kind: "const", value });
const S = (name: string): IrNode => ({ kind: "scalar", name });
const L = (array: string, stride = 1, intercept = 0): IrNode => ({ kind: "load", array, stride, intercept });
const U = (op: UnaryOp, a: IrNode): IrNode => ({ kind: "unary", op, a });
const Bn = (op: BinaryOp, a: IrNode, b: IrNode): IrNode => ({ kind: "binary", op, a, b });
const ST = (array: string, value: IrNode, stride = 1, intercept = 0): IrStore => ({ array, stride, intercept, value });
const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
const pb = (name: string): LoopBound => ({ kind: "param", name });
function K(width: LaneWidth, params: KernelParam[], bound: LoopBound, stores: IrStore[]): IrKernel {
  return { width, bound, stores, signature: { params, width } };
}

// ── the deterministic palette (the SLM stand-in) ─────────────────────────────
// Names are all JS-safe identifiers (out/x/y/a/b/g/n) — the worklet JS fallback
// must be valid JS source. Covers: scalar mul, min/max with a NEGATIVE const
// (the neg round-trip), a cubic chain, two inputs, a crossfade, and a unary abs.
interface Named { readonly name: string; readonly ir: IrKernel; }
const PALETTE: ReadonlyArray<Named> = [
  { name: "gain", ir: K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
    [ST("out", Bn("mul", L("x"), S("g")))]) },
  { name: "hardclip", ir: K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
    [ST("out", Bn("min", Bn("max", L("x"), C(-1)), C(1)))]) },
  { name: "cubic-softclip", ir: K("f64", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
    [ST("out", Bn("sub", L("x"), Bn("div", Bn("mul", Bn("mul", L("x"), L("x")), L("x")), C(3))))]) },
  { name: "ringmod", ir: K("f32", [P("n", "length"), P("out", "output"), P("a", "input"), P("b", "input")], pb("n"),
    [ST("out", Bn("mul", L("a"), L("b")))]) },
  { name: "mix", ir: K("f64", [P("n", "length"), P("out", "output"), P("a", "input"), P("b", "input"), P("g", "scalar")], pb("n"),
    [ST("out", Bn("add", Bn("mul", Bn("sub", C(1), S("g")), L("a")), Bn("mul", S("g"), L("b"))))]) },
  { name: "rectify-scale", ir: K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
    [ST("out", Bn("mul", U("abs", L("x")), S("g")))]) },
];

function tokensOf(name: string): KernelToken[] {
  return kernelToTokens(PALETTE.find((p) => p.name === name)!.ir);
}

// Independent execution of accepted SIMD bytes (mirrors JitCompiler.runModule):
// out at 16, inputs at 16+(k+1)*slot. Signature lists output before inputs, so the
// canonical WASM param order is [n, out, ...ins, ...scalars].
function runModule(wasm: Uint8Array, width: LaneWidth, n: number, inputs: number[][], scalars: number[]): number[] {
  const TA = width === "f32" ? Float32Array : Float64Array;
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 16384, shared: true });
  const buf = new Uint8Array(wasm.byteLength); buf.set(wasm);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(buf), { env: { memory } });
  const kernel = inst.exports["kernel"] as (...a: number[]) => void;
  const slot = 1024;
  const outOff = 16;
  const inOffs = inputs.map((_, k) => 16 + (k + 1) * slot);
  inputs.forEach((row, k) => { const v = new TA(memory.buffer, inOffs[k]!, n); row.forEach((x, i) => (v[i] = x)); });
  const args = [n, outOff, ...inOffs, ...scalars.map((s) => (width === "f32" ? Math.fround(s) : s))];
  kernel(...args);
  return Array.from(new TA(memory.buffer, outOff, n));
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

// ── neg-const fold: the one legitimate IR↔JS representational gap ─────────────
// JS has no negative numeric literal — `-1` parses as unary minus on `1`, so
// `const(-1)` re-lowers to `neg(const(1))`. They are numerically identical; folding
// `neg(const c) → const(-c)` on both sides makes the structural round-trip exact.
function foldNeg(node: IrNode): IrNode {
  switch (node.kind) {
    case "const":
    case "scalar":
    case "load":
      return node;
    case "unary": {
      const a = foldNeg(node.a);
      if (node.op === "neg" && a.kind === "const") return { kind: "const", value: -a.value };
      return { kind: "unary", op: node.op, a };
    }
    case "binary":
      return { kind: "binary", op: node.op, a: foldNeg(node.a), b: foldNeg(node.b) };
  }
}
function foldKernel(ir: IrKernel): IrKernel {
  return { ...ir, stores: ir.stores.map((s) => ({ ...s, value: foldNeg(s.value) })) };
}

async function main(): Promise<void> {
  // ── Pin 1: the palette compiles (tokens → gate → accepted) ────────────────
  for (const { name, ir } of PALETTE) {
    const tokens = kernelToTokens(ir);
    const acc = expectAccepted(compileTokens(tokens, { compileWat }), `palette ${name}`);
    assertEq(acc.gate.status, "accepted", `${name}: gate accepted`);
    assert(acc.gate.comparisons > 0, `${name}: gate ran comparisons`);
    assert(acc.wasm.byteLength > 8, `${name}: accepted carries SIMD bytes`);
    assertEq(acc.gate.worstUlpF32, 0, `${name}: SIMD≡scalar bit-exact (worst ULP 0)`);
  }
  // independent run of the deliverable: gain f32, x=[1,2,3,4,5], g=2 → [2,4,6,8,10]
  {
    const acc = expectAccepted(compileTokens(tokensOf("gain"), { compileWat }), "gain rerun");
    const out = runModule(acc.wasm, "f32", 5, [[1, 2, 3, 4, 5]], [2]);
    assertEq(out.join(","), "2,4,6,8,10", "gain SIMD bytes reproduce x*g");
  }
  // and ringmod (two inputs): a=[1,2,3], b=[4,5,6] → [4,10,18]
  {
    const acc = expectAccepted(compileTokens(tokensOf("ringmod"), { compileWat }), "ringmod rerun");
    const out = runModule(acc.wasm, "f32", 3, [[1, 2, 3], [4, 5, 6]], []);
    assertEq(out.join(","), "4,10,18", "ringmod SIMD bytes reproduce a*b");
  }
  ok(`1 palette (${PALETTE.length}: gain/hardclip/cubic-softclip/ringmod/mix/rectify-scale) compiles accepted + bit-exact + reruns`);

  // ── Pin 2: out-of-grammar → rejected-source E_TOKENS ──────────────────────
  {
    // a binary `add` with only ONE operand on the stack — a syntax-gate failure.
    const bad: KernelToken[] = [
      { t: "width", width: "f32" },
      { t: "param", name: "n", role: "length" },
      { t: "param", name: "out", role: "output" },
      { t: "param", name: "x", role: "input" },
      { t: "bound", bound: pb("n") },
      { t: "load", array: "x", stride: 1, intercept: 0 },
      { t: "binary", op: "add" }, // underflow
      { t: "store", array: "out", stride: 1, intercept: 0 },
    ];
    const r = compileTokens(bad, { compileWat });
    assert(r.status === "rejected-source", `E_TOKENS: expected rejected-source, got ${r.status}`);
    assertEq(r.diagnostic.code, "E_TOKENS", "E_TOKENS: diagnostic code");
    assert(r.diagnostic.message.includes("underflow"), `E_TOKENS: message carries the grammar error (${r.diagnostic.message})`);
    assertEq(r.diagnostic.line, 0, "E_TOKENS: no source line (token index lives in the message)");
    ok(`2 out-of-grammar token stream → rejected-source E_TOKENS (${r.diagnostic.message})`);
  }

  // ── Pin 3: the content-addressed characterized cache ──────────────────────
  {
    const cache = new KernelCache();
    const gainTokens = tokensOf("gain");

    // miss → compile + characterize.
    const r1 = cache.getOrCompile(gainTokens, { compileWat });
    assert(r1.status === "accepted", "cache: gain accepted");
    if (r1.status !== "accepted") return;
    assertEq(r1.cached, false, "cache: first getOrCompile is a MISS");
    assertEq(cache.size, 1, "cache: store holds 1 after first compile");
    // characterized fields populated
    assert(/^[0-9a-f]{16}$/.test(r1.kernel.hash), "cache: hash is 16-hex");
    assert(r1.kernel.wasm.byteLength > 8, "cache: characterized wasm bytes");
    assertEq(r1.kernel.gate.status, "accepted", "cache: characterized gate accepted");
    assertEq(tokensToString(r1.kernel.tokens), tokensToString(gainTokens), "cache: canonical tokens stored");
    assertEq(r1.kernel.jsSource, emitJsKernel(tokensToKernel(gainTokens)), "cache: jsSource = emitJsKernel(ir)");

    // hit → SAME object, cached:true, and NO compileWat call (compile-count probe).
    let compileWatCalls = 0;
    const countingCompileWat = (wat: string, name?: string): Uint8Array => { compileWatCalls++; return compileWat(wat, name); };
    const r2 = cache.getOrCompile(gainTokens, { compileWat: countingCompileWat });
    assert(r2.status === "accepted", "cache: gain hit accepted");
    if (r2.status !== "accepted") return;
    assertEq(r2.cached, true, "cache: second getOrCompile is a HIT");
    assert(r1.kernel === r2.kernel, "cache: hit returns the SAME object (no recompile)");
    assertEq(compileWatCalls, 0, "cache: hit does NOT invoke compileWat (no recompile)");
    assertEq(cache.size, 1, "cache: hit does not grow the store");

    // has/get over the content address.
    assert(cache.has(r1.kernel.hash), "cache: has(hash)");
    assertEq(cache.get(r1.kernel.hash), r1.kernel, "cache: get(hash) returns the entry");

    // a distinct kernel grows the store.
    const r3 = cache.getOrCompile(tokensOf("hardclip"), { compileWat });
    assert(r3.status === "accepted" && !r3.cached, "cache: distinct kernel is a fresh miss");
    assertEq(cache.size, 2, "cache: store holds 2 distinct kernels");

    // a rejected stream is a VALUE and is NOT cached.
    const rej = cache.getOrCompile([{ t: "width", width: "f32" }], { compileWat });
    assert(rej.status === "rejected-source", "cache: malformed stream rejected");
    if (rej.status === "rejected-source") assertEq(rej.diagnostic.code, "E_TOKENS", "cache: reject carries E_TOKENS");
    assertEq(cache.size, 2, "cache: rejected stream not added to the store");

    ok(`3 content-addressed cache: hit identity + compile-count probe + reject-not-cached`);
  }

  // ── Pin 4: emitJsKernel round-trip (structural faithfulness) ──────────────
  for (const { name, ir } of PALETTE) {
    const js = emitJsKernel(ir);
    const relowered = lowerKernel(parseProgram(js), ir.signature);
    assertEq(
      kernelKey(foldKernel(relowered)), kernelKey(foldKernel(ir)),
      `round-trip ${name}: lower(parse(emitJsKernel(ir))) ≡ ir (neg-folded kernelKey)`,
    );
  }
  ok(`4 emitJsKernel IR→JS→IR round-trip exact over the palette (${PALETTE.length} kernels)`);

  console.log("\nAll compileTokens / KernelCache / emitJsKernel pins passed.");
}

await main();
