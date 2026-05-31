/**
 * Kernel grammar — Stage-0 pins (Apollo Frontier 6).
 *
 * Pure data: no wabt, no compile, no model. Exercises the token codec, the
 * syntax validator, the flat text form, and the content hash directly over the
 * REAL IR (src/jit/ir.ts) — `kernelToTokens`/`tokensToKernel`/`validateTokens`/
 * `tokensToString`/`parseTokens`/`kernelHash`.
 *
 * Run: tsx tests/kernelGrammar.test.ts
 *
 * Pins
 *  A  codec round-trip — tokensToKernel(kernelToTokens(ir)) ≡ ir (by kernelKey)
 *  B  flat-form round-trip — parseTokens(tokensToString(t)) ≡ t (canonical string)
 *  C  validator accepts every corpus kernel and rebuilds the same IR
 *  D  validator rejects (as a VALUE) every malformed stream — arity underflow,
 *     unknown unary/binary op, two-values-before-STORE, fractional stride,
 *     undeclared name, trailing operand, no-leading-width, empty, bad bound
 *  E  hash — determinism, ir≡tokens parity, equal-key⇒equal-hash (signature-
 *     ignored), corpus distinctness (no collisions), 16-hex shape, regression pin
 *  F  barrel — the experimental re-export is the same function identity
 *  G  tokensToKernel throws on an invalid stream (the throwing convenience)
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  kernelToTokens, tokensToKernel, validateTokens, tokensToString, parseTokens, kernelHash,
  type KernelToken,
} from "../src/jit/kernelGrammar.js";
import { kernelHash as kernelHashFromBarrel } from "../src/jit/index.js";
import {
  kernelKey,
  type IrKernel, type IrNode, type IrStore, type LoopBound,
  type KernelParam, type ParamRole, type LaneWidth, type UnaryOp, type BinaryOp,
} from "../src/jit/ir.js";

// ── IR builders ───────────────────────────────────────────────────────────────
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
const paramBound = (name: string): LoopBound => ({ kind: "param", name });

// ── corpus: hand-authored IrKernels spanning the grammar ──────────────────────
// Covers every UNARY op (neg/abs/sqrt/floor/ceil/trunc) and BINARY op
// (add/sub/mul/div/min/max), const/scalar/load operands, contiguous AND stride-2
// loads (valid in the language though not v1-emittable), multiple stores/outputs,
// param AND const loop bounds, and both lane widths.
interface Named { readonly name: string; readonly ir: IrKernel; }
const CORPUS: ReadonlyArray<Named> = [
  { name: "gain", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input"), P("g", "scalar")], paramBound("n"),
    [ST("out", B("mul", L("in"), S("g")))]) },
  { name: "mix2", ir: K("f32", [P("n", "length"), P("out", "output"), P("a", "input"), P("b", "input")], paramBound("n"),
    [ST("out", B("add", L("a"), L("b")))]) },
  { name: "affine", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input")], paramBound("n"),
    [ST("out", B("add", B("mul", L("in"), C(2)), C(1)))]) },
  { name: "hardclip", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input")], paramBound("n"),
    [ST("out", B("min", B("max", L("in"), C(-1)), C(1)))]) },
  { name: "absval", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input")], paramBound("n"),
    [ST("out", U("abs", L("in")))]) },
  { name: "softclip", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input")], paramBound("n"),
    [ST("out", B("sub", L("in"), B("div", B("mul", B("mul", L("in"), L("in")), L("in")), C(3))))]) },
  { name: "f64sqrt", ir: K("f64", [P("n", "length"), P("out", "output"), P("in", "input")], paramBound("n"),
    [ST("out", U("sqrt", L("in")))]) },
  { name: "stereo", ir: K("f32",
    [P("n", "length"), P("outL", "output"), P("outR", "output"), P("in", "input"), P("gl", "scalar"), P("gr", "scalar")],
    paramBound("n"), [ST("outL", B("mul", L("in"), S("gl"))), ST("outR", B("mul", L("in"), S("gr")))]) },
  { name: "copy-const-bound", ir: K("f32", [P("out", "output"), P("in", "input")], { kind: "const", value: 64 },
    [ST("out", L("in"))]) },
  { name: "deinterleave-stride2", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input")], paramBound("n"),
    [ST("out", B("add", L("in", 2, 0), L("in", 2, 1)))]) },
  { name: "opsweep", ir: K("f32", [P("n", "length"), P("out", "output"), P("in", "input"), P("g", "scalar")], paramBound("n"),
    [ST("out", U("trunc", B("sub", U("neg", L("in")), U("floor", U("ceil", S("g"))))))]) },
];

// ── token builders for malformed streams ──────────────────────────────────────
const tld = (array: string, stride = 1, intercept = 0): KernelToken => ({ t: "load", array, stride, intercept });
const tst = (array: string, stride = 1, intercept = 0): KernelToken => ({ t: "store", array, stride, intercept });
const tun = (op: string): KernelToken => ({ t: "unary", op: op as UnaryOp });
const tbin = (op: string): KernelToken => ({ t: "binary", op: op as BinaryOp });

const HDR: KernelToken[] = [
  { t: "width", width: "f32" },
  { t: "param", name: "n", role: "length" },
  { t: "param", name: "out", role: "output" },
  { t: "param", name: "in", role: "input" },
  { t: "param", name: "g", role: "scalar" },
  { t: "bound", bound: paramBound("n") },
];
const body = (...b: KernelToken[]): KernelToken[] => [...HDR, ...b];

function expectReject(tokens: KernelToken[], label: string, needle: string): void {
  const r = validateTokens(tokens);
  assert(!r.ok, `${label}: expected a rejection value, got ok`);
  assert(r.error.includes(needle), `${label}: error "${r.error}" should mention "${needle}"`);
  ok(`D reject — ${label}`);
}

function main(): void {
  // ── A: codec round-trip ─────────────────────────────────────────────────────
  for (const { name, ir } of CORPUS) {
    const rebuilt = tokensToKernel(kernelToTokens(ir));
    assertEq(kernelKey(rebuilt), kernelKey(ir), `A codec round-trip — ${name}`);
  }
  ok(`A codec round-trip (${CORPUS.length} kernels, by kernelKey)`);

  // ── B: flat-form round-trip ─────────────────────────────────────────────────
  for (const { name, ir } of CORPUS) {
    const t = kernelToTokens(ir);
    const str = tokensToString(t);
    const reparsed = parseTokens(str);
    assertEq(reparsed.length, t.length, `B token count — ${name}`);
    assertEq(tokensToString(reparsed), str, `B flat round-trip — ${name}`);
    // and the reparsed stream rebuilds the same IR
    assertEq(kernelKey(tokensToKernel(reparsed)), kernelKey(ir), `B flat→IR — ${name}`);
  }
  ok(`B flat-form round-trip (${CORPUS.length} kernels)`);

  // ── C: validator accepts + rebuilds ─────────────────────────────────────────
  for (const { name, ir } of CORPUS) {
    const r = validateTokens(kernelToTokens(ir));
    assert(r.ok, `C validator accepts — ${name}`);
    assertEq(kernelKey(r.ir), kernelKey(ir), `C validator rebuild — ${name}`);
  }
  ok(`C validator accepts every corpus kernel`);

  // ── D: validator rejects (as a value) ───────────────────────────────────────
  expectReject(body(tld("in"), tbin("add"), tst("out")), "arity underflow (binary)", "underflow");
  expectReject(body(tld("in"), tun("log"), tst("out")), "unknown unary op", "unknown unary");
  expectReject(body(tld("in"), tld("in"), tbin("pow"), tst("out")), "unknown binary op", "unknown binary");
  expectReject(body(tld("in"), tld("in"), tst("out")), "two values before STORE", "exactly one");
  expectReject(body(tld("in", 1.5, 0), tst("out")), "fractional load stride", "integer");
  expectReject(body(tld("ghost"), tst("out")), "undeclared load array", "undeclared");
  expectReject(body(tld("in"), tst("out"), tld("in")), "trailing operand", "unconsumed");
  expectReject([{ t: "param", name: "n", role: "length" }], "no leading width", "first token");
  expectReject([], "empty stream", "empty");
  expectReject(
    [{ t: "width", width: "f32" }, { t: "bound", bound: paramBound("missing") }],
    "bound references undeclared param", "undeclared",
  );

  // ── E: hash ─────────────────────────────────────────────────────────────────
  for (const { name, ir } of CORPUS) {
    assertEq(kernelHash(ir), kernelHash(ir), `E determinism — ${name}`);
    assertEq(kernelHash(kernelToTokens(ir)), kernelHash(ir), `E ir≡tokens parity — ${name}`);
    assert(/^[0-9a-f]{16}$/.test(kernelHash(ir)), `E 16-hex shape — ${name}`);
  }
  ok(`E hash determinism + ir≡tokens parity + 16-hex shape (${CORPUS.length} kernels)`);

  // equal kernelKey ⇒ equal hash (the hash addresses the BODY, not the signature):
  // same body, reordered params + an extra unused scalar.
  const gain = CORPUS[0]!.ir;
  const gainVariant = K("f32",
    [P("g", "scalar"), P("in", "input"), P("out", "output"), P("n", "length"), P("extra", "scalar")],
    paramBound("n"), [ST("out", B("mul", L("in"), S("g")))]);
  assertEq(kernelKey(gainVariant), kernelKey(gain), "E signature-independent kernelKey");
  assertEq(kernelHash(gainVariant), kernelHash(gain), "E equal-key ⇒ equal-hash");
  ok(`E equal-key ⇒ equal-hash (signature ignored)`);

  // corpus distinctness — every kernel hashes uniquely (no collisions).
  const hashes = CORPUS.map((c) => kernelHash(c.ir));
  assertEq(new Set(hashes).size, CORPUS.length, "E no hash collisions across corpus");
  ok(`E ${CORPUS.length} distinct hashes (no collisions)`);

  // regression pin — guards against an accidental hash-algorithm change. Update
  // ONLY intentionally (it pins FNV-1a-64 over kernelKey, not external truth).
  assertEq(kernelHash(gain), "72b5c2e5a7a5f117", "E gain hash regression pin");
  ok(`E gain hash pin = 72b5c2e5a7a5f117`);

  // ── F: barrel re-export identity ────────────────────────────────────────────
  assert(kernelHashFromBarrel === kernelHash, "F barrel re-exports the same kernelHash");
  ok(`F barrel re-export identity`);

  // ── G: tokensToKernel throws on an invalid stream ───────────────────────────
  let threw = false;
  try {
    tokensToKernel([{ t: "width", width: "f32" }, { t: "bound", bound: paramBound("n") }, tst("out")]);
  } catch {
    threw = true;
  }
  assert(threw, "G tokensToKernel throws on an invalid stream");
  ok(`G tokensToKernel throws on invalid input`);

  console.log("\nALL kernelGrammar pins passed.");
}

main();
