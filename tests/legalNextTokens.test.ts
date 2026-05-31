/**
 * legalNextTokens — Stage-3a pins (Apollo Frontier 6).
 *
 * `legalNextTokens(prefix)` is the constrained-decoder mask: the forward-direction
 * sibling of `validateTokens`, sharing ONE grammar step machine. These pins prove
 * the two load-bearing properties the Stage-3 SLM plugs behind, MODEL-FREE:
 *
 *   1  Exact-mask completeness — for EVERY prefix of EVERY valid kernel the actual
 *      next token's kind is in the mask, and a complete kernel reports `done`.
 *   2  Depth rules — the body mask is exactly the operand-stack arity function
 *      (value-pushers always; unary@≥1; binary@≥2; store@==1), checked positive AND
 *      negative at hand-built states + the declaration-phase masks.
 *   3  No-invalid-stream — a seeded mock emitter that picks ONLY kinds the mask
 *      offers (filling operands from the declared signature) and stops at `done`
 *      produces, over 1000 seeds, ONLY streams that `validateTokens` accepts. This
 *      is the safety contract that lets an UNTRUSTED model emit kernels.
 *   4  Random-kernel completeness — 1000 randomly-generated valid kernels: the mask
 *      contains every token's kind at every prefix (the broad form of pin 1).
 *   5  Invalid-prefix → empty mask + not done; and refactor parity (the Stage-0
 *      corpus still validates and the gain content-hash pin is intact).
 *
 * Run: tsx tests/legalNextTokens.test.ts
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  kernelToTokens, validateTokens, legalNextTokens, tokensToKernel, kernelHash,
  type KernelToken, type TokenKind,
} from "../src/jit/kernelGrammar.js";
import { legalNextTokens as legalNextTokensFromBarrel } from "../src/jit/index.js";
import {
  type IrKernel, type IrNode, type IrStore, type LoopBound,
  type KernelParam, type ParamRole, type LaneWidth, type UnaryOp, type BinaryOp,
} from "../src/jit/ir.js";

// ── IR builders (mirror kernelGrammar.test.ts) ───────────────────────────────
const C = (value: number): IrNode => ({ kind: "const", value });
const S = (name: string): IrNode => ({ kind: "scalar", name });
const L = (array: string, stride = 1, intercept = 0): IrNode => ({ kind: "load", array, stride, intercept });
const U = (op: UnaryOp, a: IrNode): IrNode => ({ kind: "unary", op, a });
const B = (op: BinaryOp, a: IrNode, b: IrNode): IrNode => ({ kind: "binary", op, a, b });
const ST = (array: string, value: IrNode, stride = 1, intercept = 0): IrStore => ({ array, stride, intercept, value });
const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
function K(width: LaneWidth, params: KernelParam[], bound: LoopBound, stores: IrStore[]): IrKernel {
  return { width, bound, stores, signature: { params, width } };
}
const pb = (name: string): LoopBound => ({ kind: "param", name });

interface Named { readonly name: string; readonly ir: IrKernel; }
const CORPUS: ReadonlyArray<Named> = [
  { name: "gain", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input"), P("g", "scalar")], pb("n"),
    [ST("out", B("mul", L("in"), S("g")))]) },
  { name: "affine", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input")], pb("n"),
    [ST("out", B("add", B("mul", L("in"), C(2)), C(1)))]) },
  { name: "hardclip", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input")], pb("n"),
    [ST("out", B("min", B("max", L("in"), C(-1)), C(1)))]) },
  { name: "softclip", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input")], pb("n"),
    [ST("out", B("sub", L("in"), B("div", B("mul", B("mul", L("in"), L("in")), L("in")), C(3))))]) },
  { name: "f64sqrt", ir: K("f64", [P("n", "length"), P("out", "output"), P("in", "input")], pb("n"),
    [ST("out", U("sqrt", L("in")))]) },
  { name: "stereo", ir: K("f32",
    [P("n", "length"), P("outL", "output"), P("outR", "output"), P("in", "input"), P("gl", "scalar"), P("gr", "scalar")],
    pb("n"), [ST("outL", B("mul", L("in"), S("gl"))), ST("outR", B("mul", L("in"), S("gr")))]) },
  { name: "copy-const-bound", ir: K("f32", [P("out", "output"), P("in", "input")], { kind: "const", value: 64 },
    [ST("out", L("in"))]) },
  { name: "deinterleave-stride2", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input")], pb("n"),
    [ST("out", B("add", L("in", 2, 0), L("in", 2, 1)))]) },
  { name: "opsweep", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input"), P("g", "scalar")], pb("n"),
    [ST("out", U("trunc", B("sub", U("neg", L("in")), U("floor", U("ceil", S("g"))))))]) },
];

// ── tiny deterministic RNG (LCG, byte-stable across runs) ─────────────────────
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const UN_OPS: ReadonlyArray<UnaryOp> = ["neg", "abs", "sqrt", "floor", "ceil", "trunc"];
const BIN_OPS: ReadonlyArray<BinaryOp> = ["add", "sub", "mul", "div", "min", "max"];

function setEq(a: ReadonlySet<TokenKind>, b: ReadonlyArray<TokenKind>): boolean {
  if (a.size !== b.length) return false;
  for (const k of b) if (!a.has(k)) return false;
  return true;
}

function main(): void {
  // ── Pin 1: exact-mask completeness over the corpus ──────────────────────────
  // The empty prefix admits exactly `width` and is not done.
  {
    const r = legalNextTokens([]);
    assert(setEq(r.kinds, ["width"]), `1 empty prefix mask is {width} (got {${[...r.kinds].join(",")}})`);
    assert(!r.done, "1 empty prefix is not done");
  }
  for (const { name, ir } of CORPUS) {
    const tokens = kernelToTokens(ir);
    assert(validateTokens(tokens).ok, `1 corpus ${name} is valid`);
    for (let j = 0; j < tokens.length; j++) {
      const prefix = tokens.slice(0, j);
      const { kinds, done } = legalNextTokens(prefix);
      const nextKind = tokens[j]!.t;
      assert(kinds.has(nextKind), `1 ${name}@${j}: next kind "${nextKind}" must be in the mask {${[...kinds].join(",")}}`);
      // `done` is EXACTLY `validateTokens(prefix).ok`: true at every store boundary that
      // completes a valid (possibly shorter) kernel — e.g. after the FIRST store of a
      // multi-store kernel like `stereo`. Pin that equivalence, not a blanket !done.
      assertEq(done, validateTokens(prefix).ok, `1 ${name}@${j}: done === validateTokens(prefix).ok`);
    }
    const full = legalNextTokens(tokens);
    assert(full.done, `1 ${name}: the complete stream reports done`);
    // …and the mask still offers value-pushers (a new statement could begin).
    assert(full.kinds.has("const") && full.kinds.has("load"), `1 ${name}: done state still admits a new statement`);
  }
  ok(`1 exact-mask completeness over the corpus (${CORPUS.length} kernels, every prefix)`);

  // ── Pin 2: the depth rules, exactly ─────────────────────────────────────────
  const HDR: KernelToken[] = [
    { t: "width", width: "f32" },
    { t: "param", name: "n", role: "length" },
    { t: "param", name: "out", role: "output" },
    { t: "param", name: "in", role: "input" },
    { t: "param", name: "g", role: "scalar" },
  ];
  const BND: KernelToken = { t: "bound", bound: pb("n") };
  const ld: KernelToken = { t: "load", array: "in", stride: 1, intercept: 0 };
  const stTok: KernelToken = { t: "store", array: "out", stride: 1, intercept: 0 };

  // The signature phase also offers `state` (a register decl, Frontier 7) + `stateBuffer`
  // (a delay-line decl, Stage 3); the body always offers `readState`/`readDelay` (value-
  // pushers) and, at depth 1, `writeState`/`writeDelay` (store-like terminators). The KIND
  // mask is broad; the OPERAND mask narrows the register/buffer name to the declared set
  // (empty here ⇒ none, like `load` with no inputs — see legalNextOperands.test.ts) — so
  // the composition stays sound.
  // width phase
  assert(setEq(legalNextTokens([HDR[0]!]).kinds, ["param", "state", "stateBuffer", "bound"]), "2 after width → {param, state, stateBuffer, bound}");
  // params phase (mid-run)
  assert(setEq(legalNextTokens([HDR[0]!, HDR[1]!]).kinds, ["param", "state", "stateBuffer", "bound"]), "2 mid-param-run → {param, state, stateBuffer, bound}");
  // body, depth 0 (just after bound): value-pushers only, NOT unary/binary/store
  {
    const r = legalNextTokens([...HDR, BND]);
    assert(setEq(r.kinds, ["const", "scalar", "load", "readState", "readDelay"]), `2 body depth0 → {const,scalar,load,readState,readDelay} (got {${[...r.kinds].join(",")}})`);
    assert(!r.done, "2 body depth0 with no store is not done");
  }
  // body, depth 1: + unary + store + writeState + writeDelay, NOT binary
  {
    const r = legalNextTokens([...HDR, BND, ld]);
    assert(setEq(r.kinds, ["const", "scalar", "load", "readState", "readDelay", "unary", "store", "writeState", "writeDelay"]), `2 body depth1 (got {${[...r.kinds].join(",")}})`);
    assert(!r.kinds.has("binary"), "2 body depth1 excludes binary");
    assert(!r.done, "2 body depth1 is not done");
  }
  // body, depth 2: + binary, NOT store/writeState/writeDelay
  {
    const r = legalNextTokens([...HDR, BND, ld, ld]);
    assert(setEq(r.kinds, ["const", "scalar", "load", "readState", "readDelay", "unary", "binary"]), `2 body depth2 (got {${[...r.kinds].join(",")}})`);
    assert(!r.kinds.has("store") && !r.kinds.has("writeState") && !r.kinds.has("writeDelay"), "2 body depth2 excludes store/writeState/writeDelay (arity ≠ 1)");
  }
  // body, depth 3: still binary, still no store
  {
    const r = legalNextTokens([...HDR, BND, ld, ld, ld]);
    assert(r.kinds.has("binary") && !r.kinds.has("store"), "2 body depth3 has binary, no store");
  }
  // after a store: depth 0 again AND done (one store emitted)
  {
    const r = legalNextTokens([...HDR, BND, ld, stTok]);
    assert(setEq(r.kinds, ["const", "scalar", "load", "readState", "readDelay"]), `2 post-store depth0 (got {${[...r.kinds].join(",")}})`);
    assert(r.done, "2 post-store with ≥1 store IS done");
  }
  ok(`2 depth rules exact (width/params/body × depth 0..3 + post-store done)`);

  // ── Pin 3: no-invalid-stream — the mask-driven mock emitter ──────────────────
  // The emitter declares a fixed valid signature (its operand policy), then in the
  // body picks ONLY kinds the mask offers, filling operands from the declared names,
  // and stops at a `done` boundary. A depth-aware bias guarantees termination. Every
  // produced stream MUST validate — the contract an untrusted model relies on.
  function emit(seed: number): KernelToken[] {
    const rng = lcg(seed);
    const pick = <T,>(arr: ReadonlyArray<T>): T => arr[Math.floor(rng() * arr.length)]!;
    const stream: KernelToken[] = [];
    stream.push({ t: "width", width: rng() < 0.5 ? "f32" : "f64" });
    stream.push({ t: "param", name: "n", role: "length" });
    stream.push({ t: "param", name: "out", role: "output" });
    stream.push({ t: "param", name: "in0", role: "input" });
    stream.push({ t: "param", name: "in1", role: "input" });
    stream.push({ t: "param", name: "g", role: "scalar" });
    stream.push(rng() < 0.5
      ? { t: "bound", bound: { kind: "param", name: "n" } }
      : { t: "bound", bound: { kind: "const", value: 1 + Math.floor(rng() * 128) } });

    const inputs = ["in0", "in1"];
    let depth = 0;
    let stores = 0;
    let guard = 0;
    for (;;) {
      assert(++guard < 5000, `3 emitter did not terminate (seed ${seed})`);
      const { kinds, done } = legalNextTokens(stream);
      if (done && rng() < 0.4) break;
      // depth-aware choice, ALWAYS from the offered set:
      let choice: TokenKind;
      if (depth === 0) {
        choice = pick(["const", "scalar", "load"]);
      } else if (depth >= 4) {
        choice = depth >= 2 ? "binary" : "store"; // reduce hard past the cap
      } else if (depth === 1 && rng() < 0.5) {
        choice = "store"; // complete the statement
      } else {
        const opts = (["const", "scalar", "load", "unary", "binary", "store"] as TokenKind[]).filter((k) => kinds.has(k));
        choice = pick(opts);
      }
      assert(kinds.has(choice), `3 emitter chose a non-masked kind "${choice}" at depth ${depth} (seed ${seed})`);
      switch (choice) {
        case "const": stream.push({ t: "const", value: pick([-2, -1, 0, 0.5, 1, 2, 3]) }); depth++; break;
        case "scalar": stream.push({ t: "scalar", name: "g" }); depth++; break;
        case "load": stream.push({ t: "load", array: pick(inputs), stride: pick([1, 2]), intercept: pick([0, 1]) }); depth++; break;
        case "unary": stream.push({ t: "unary", op: pick(UN_OPS) }); break; // depth unchanged
        case "binary": stream.push({ t: "binary", op: pick(BIN_OPS) }); depth--; break;
        case "store": stream.push({ t: "store", array: "out", stride: 1, intercept: 0 }); depth--; stores++; break;
        default: assert(false, `3 unexpected choice ${choice}`);
      }
    }
    assert(stores >= 1, `3 emitter produced no store (seed ${seed})`);
    return stream;
  }

  const SEEDS = 1000;
  const distinct = new Set<string>();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const stream = emit(seed);
    const r = validateTokens(stream);
    assert(r.ok, `3 mask-driven stream MUST validate (seed ${seed})`);
    // the closing prefix is a complete kernel the decoder was allowed to stop at
    assert(legalNextTokens(stream).done, `3 mask-driven stream ends at a done boundary (seed ${seed})`);
    // round-trips to an IrKernel without throwing
    tokensToKernel(stream);
    distinct.add(stream.map((t) => t.t).join("."));
  }
  assert(distinct.size > 50, `3 emitter explores varied shapes (got ${distinct.size} distinct kind-sequences)`);
  ok(`3 no-invalid-stream: ${SEEDS} mask-driven emissions all validate (${distinct.size} distinct shapes)`);

  // ── Pin 4: random-kernel completeness (the broad form of pin 1) ──────────────
  // Generate random VALID kernels via a recursive postfix expression generator (each
  // expression nets exactly +1 depth), then assert the mask contains every token's
  // kind at every prefix — over a far larger space than the hand-authored corpus.
  function genExpr(rng: () => number, depthBudget: number, out: KernelToken[]): void {
    const pick = <T,>(arr: ReadonlyArray<T>): T => arr[Math.floor(rng() * arr.length)]!;
    if (depthBudget <= 0 || rng() < 0.45) {
      const r = rng();
      if (r < 0.34) out.push({ t: "const", value: pick([-1, 0, 0.25, 1, 2]) });
      else if (r < 0.67) out.push({ t: "scalar", name: "g" });
      else out.push({ t: "load", array: pick(["in0", "in1"]), stride: pick([1, 2]), intercept: pick([0, 1]) });
      return;
    }
    if (rng() < 0.5) { genExpr(rng, depthBudget - 1, out); out.push({ t: "unary", op: pick(UN_OPS) }); }
    else { genExpr(rng, depthBudget - 1, out); genExpr(rng, depthBudget - 1, out); out.push({ t: "binary", op: pick(BIN_OPS) }); }
  }
  function genKernel(seed: number): KernelToken[] {
    const rng = lcg(seed * 2654435761);
    const pick = <T,>(arr: ReadonlyArray<T>): T => arr[Math.floor(rng() * arr.length)]!;
    const out: KernelToken[] = [
      { t: "width", width: rng() < 0.5 ? "f32" : "f64" },
      { t: "param", name: "n", role: "length" },
      { t: "param", name: "out", role: "output" },
      { t: "param", name: "in0", role: "input" },
      { t: "param", name: "in1", role: "input" },
      { t: "param", name: "g", role: "scalar" },
      rng() < 0.5 ? { t: "bound", bound: { kind: "param", name: "n" } } : { t: "bound", bound: { kind: "const", value: 1 + Math.floor(rng() * 32) } },
    ];
    const statements = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < statements; k++) {
      genExpr(rng, 4, out);
      out.push({ t: "store", array: pick(["out"]), stride: 1, intercept: 0 });
    }
    return out;
  }

  for (let seed = 1; seed <= 1000; seed++) {
    const tokens = genKernel(seed);
    assert(validateTokens(tokens).ok, `4 generated kernel is valid (seed ${seed})`);
    for (let j = 0; j < tokens.length; j++) {
      const { kinds } = legalNextTokens(tokens.slice(0, j));
      assert(kinds.has(tokens[j]!.t), `4 generated@${seed}.${j}: next kind "${tokens[j]!.t}" in mask`);
    }
    assert(legalNextTokens(tokens).done, `4 generated kernel reports done (seed ${seed})`);
  }
  ok(`4 random-kernel completeness: 1000 generated valid kernels, mask contains every token`);

  // ── Pin 5: invalid-prefix handling + refactor parity ────────────────────────
  {
    // a binary with only one operand — a malformed prefix has NO legal continuation.
    const bad: KernelToken[] = [...HDR, BND, ld, { t: "binary", op: "add" }];
    const r = legalNextTokens(bad);
    assertEq(r.kinds.size, 0, "5 invalid prefix → empty mask");
    assert(!r.done, "5 invalid prefix → not done");
  }
  {
    // first-token-not-width is also an invalid prefix
    const r = legalNextTokens([{ t: "param", name: "n", role: "length" }]);
    assertEq(r.kinds.size, 0, "5 non-width first token → empty mask");
  }
  // barrel identity
  assert(legalNextTokensFromBarrel === legalNextTokens, "5 barrel re-exports the same legalNextTokens");
  // refactor parity: the Stage-0 corpus still validates + rebuilds, and the content
  // hash regression pin is intact (the step-machine refactor preserved behavior).
  for (const { name, ir } of CORPUS) {
    assert(validateTokens(kernelToTokens(ir)).ok, `5 parity: ${name} still validates`);
  }
  assertEq(kernelHash(CORPUS[0]!.ir), "72b5c2e5a7a5f117", "5 parity: gain content-hash pin intact");
  ok(`5 invalid-prefix empty mask + barrel identity + refactor parity (hash pin intact)`);

  console.log("\nAll legalNextTokens pins passed.");
}

main();
