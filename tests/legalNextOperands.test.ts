/**
 * legalNextOperands — Stage-3a+ pins (Apollo Frontier 6).
 *
 * `legalNextOperands(prefix, kind)` is the OPERAND mask — the companion to the KIND
 * mask `legalNextTokens`. Where the kind mask says WHICH token kinds may come next,
 * the operand mask says WHICH operand values each kind may carry (which array names
 * by role, which scalar names, the legal widths/roles/ops, and validity predicates
 * for the unbounded fields: const value, affine stride/intercept, the param name).
 * Together they make a constrained decoder unable to emit ANY token `validateTokens`
 * would reject — operand included. These pins prove that MODEL-FREE:
 *
 *   1  Operand soundness over the corpus — for EVERY prefix of EVERY valid kernel,
 *      the actual next token's operands are admitted by `legalNextOperands`.
 *   2  The per-kind operand sets, exactly — at hand-built states: width/role/op
 *      enumerations, role-partitioned array+scalar+bound names, the freshness +
 *      numeric predicates, the empty-set refinement (kind mask admits `load`, but
 *      with no input declared the operand set is empty), illegal-kind/invalid-prefix
 *      → `{}`.
 *   3  No-invalid-TOKEN — the strengthened pin-3 emitter: it fills BODY operands
 *      ONLY from `legalNextOperands` (no hardcoded "in0"/"out"/"g" — it reads the
 *      array/scalar names back out of the mask), carrying ZERO grammar knowledge of
 *      its own operands. Over 1000 seeds every produced stream still validates.
 *   4  Broad operand soundness — 1000 random valid kernels, every prefix's actual
 *      token admitted (the broad form of pin 1).
 *   5  Parity + barrel identity — `legalNextTokens`/`validateTokens` unchanged
 *      (Stage-0 corpus validates, gain content-hash pin intact), and the barrel
 *      re-exports the same `legalNextOperands`.
 *
 * Run: tsx tests/legalNextOperands.test.ts
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  kernelToTokens, validateTokens, legalNextTokens, legalNextOperands, tokensToKernel, kernelHash,
  type KernelToken, type TokenKind, type OperandChoices,
} from "../src/jit/kernelGrammar.js";
import { legalNextOperands as legalNextOperandsFromBarrel } from "../src/jit/index.js";
import {
  type IrKernel, type IrNode, type IrStore, type LoopBound,
  type KernelParam, type ParamRole, type LaneWidth, type UnaryOp, type BinaryOp,
} from "../src/jit/ir.js";

// ── IR builders (mirror legalNextTokens.test.ts) ─────────────────────────────
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

/** Does `choices` (the operand mask for `tk.t`) admit the operands of `tk`? */
function admits(choices: OperandChoices, tk: KernelToken): boolean {
  switch (tk.t) {
    case "width": return !!choices.width?.includes(tk.width);
    case "param": return !!choices.paramRoles?.includes(tk.role) && !!choices.nameIsFresh?.(tk.name);
    case "bound": return tk.bound.kind === "param"
      ? !!choices.boundParams?.includes(tk.bound.name)
      : !!choices.boundConstOk && !!choices.boundConstValid?.(tk.bound.value);
    case "load": return !!choices.arrays?.includes(tk.array) && !!choices.strideValid?.(tk.stride) && !!choices.interceptValid?.(tk.intercept);
    case "store": return !!choices.arrays?.includes(tk.array) && !!choices.strideValid?.(tk.stride) && !!choices.interceptValid?.(tk.intercept);
    case "scalar": return !!choices.scalars?.includes(tk.name);
    case "const": return !!choices.constValid?.(tk.value);
    case "unary": return !!choices.ops?.includes(tk.op);
    case "binary": return !!choices.ops?.includes(tk.op);
    case "state": return !!choices.nameIsFresh?.(tk.name) && !!choices.constValid?.(tk.init);
    case "readState": return !!choices.stateNames?.includes(tk.name);
    case "writeState": return !!choices.stateNames?.includes(tk.name);
  }
}

function setEqArr<T>(a: ReadonlyArray<T> | undefined, b: ReadonlyArray<T>): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (const x of b) if (!a.includes(x)) return false;
  return true;
}

function main(): void {
  // ── Pin 1: operand soundness over the corpus ────────────────────────────────
  for (const { name, ir } of CORPUS) {
    const tokens = kernelToTokens(ir);
    assert(validateTokens(tokens).ok, `1 corpus ${name} is valid`);
    for (let j = 0; j < tokens.length; j++) {
      const prefix = tokens.slice(0, j);
      const next = tokens[j]!;
      // the kind must be legal (sanity — pin 1 of legalNextTokens), and the operand admitted
      assert(legalNextTokens(prefix).kinds.has(next.t), `1 ${name}@${j}: kind "${next.t}" legal`);
      const choices = legalNextOperands(prefix, next.t);
      assert(admits(choices, next), `1 ${name}@${j}: operands of "${next.t}" must be admitted by legalNextOperands`);
    }
  }
  ok(`1 operand soundness over the corpus (${CORPUS.length} kernels, every prefix)`);

  // ── Pin 2: the per-kind operand sets, exactly ───────────────────────────────
  const HDR: KernelToken[] = [
    { t: "width", width: "f32" },
    { t: "param", name: "n", role: "length" },
    { t: "param", name: "out", role: "output" },
    { t: "param", name: "in", role: "input" },
    { t: "param", name: "g", role: "scalar" },
  ];
  const BND: KernelToken = { t: "bound", bound: pb("n") };
  const ld: KernelToken = { t: "load", array: "in", stride: 1, intercept: 0 };

  // width phase → the two widths
  {
    const c = legalNextOperands([], "width");
    assert(setEqArr(c.width, ["f32", "f64"]), `2 width operands = {f32,f64} (got ${JSON.stringify(c.width)})`);
  }
  // params phase: `param` → all four roles + name-freshness predicate
  {
    const c = legalNextOperands([HDR[0]!], "param");
    assert(setEqArr(c.paramRoles, ["input", "output", "scalar", "length"]), "2 param roles = all four");
    assert(c.nameIsFresh!("fresh") && !c.nameIsFresh!("1bad") && !c.nameIsFresh!(""), "2 name freshness: IDENT only");
    // after declaring `n`, `n` is no longer fresh
    const c2 = legalNextOperands([HDR[0]!, HDR[1]!], "param");
    assert(!c2.nameIsFresh!("n") && c2.nameIsFresh!("m"), "2 declared name not fresh");
  }
  // params phase: `bound` → length params + const option
  {
    const c = legalNextOperands([...HDR], "bound");
    assert(setEqArr(c.boundParams, ["n"]), `2 bound params = {n} (length only; got ${JSON.stringify(c.boundParams)})`);
    assert(c.boundConstOk === true && c.boundConstValid!(0) && c.boundConstValid!(64) && !c.boundConstValid!(-1) && !c.boundConstValid!(1.5),
      "2 bound const: non-negative integer");
    // a kernel with NO length param: boundParams empty, const still ok
    const noLen: KernelToken[] = [{ t: "width", width: "f32" }, { t: "param", name: "out", role: "output" }, { t: "param", name: "in", role: "input" }];
    const cn = legalNextOperands(noLen, "bound");
    assert(setEqArr(cn.boundParams, []) && cn.boundConstOk === true, "2 no-length kernel → boundParams empty, const ok");
  }
  // body: load → input arrays only; store → output arrays only; scalar → scalar names only
  {
    const body = [...HDR, BND];
    const cl = legalNextOperands(body, "load");
    assert(setEqArr(cl.arrays, ["in"]) && cl.strideValid!(2) && !cl.strideValid!(0.5) && cl.interceptValid!(-1),
      `2 load arrays = inputs {in} + integer affine (got ${JSON.stringify(cl.arrays)})`);
    const cs = legalNextOperands(body, "scalar");
    assert(setEqArr(cs.scalars, ["g"]), `2 scalar names = {g} (got ${JSON.stringify(cs.scalars)})`);
    const cc = legalNextOperands(body, "const");
    assert(cc.constValid!(3.5) && cc.constValid!(-2) && !cc.constValid!(NaN) && !cc.constValid!(Infinity), "2 const: finite numbers");
    // store legal only at depth 1 → reach it with one load
    const cst = legalNextOperands([...body, ld], "store");
    assert(setEqArr(cst.arrays, ["out"]), `2 store arrays = outputs {out} (got ${JSON.stringify(cst.arrays)})`);
  }
  // ops: unary/binary enumerations (reachable kinds)
  {
    const u = legalNextOperands([...HDR, BND, ld], "unary");
    assert(setEqArr(u.ops, ["neg", "abs", "sqrt", "floor", "ceil", "trunc"]), "2 unary ops = the six");
    const b = legalNextOperands([...HDR, BND, ld, ld], "binary");
    assert(setEqArr(b.ops, ["add", "sub", "mul", "div", "min", "max"]), "2 binary ops = the six");
  }
  // the empty-set refinement: with NO input declared, the KIND mask admits `load`
  // (value-pushers always legal) but the OPERAND set is empty — no legal load token.
  {
    const noInput: KernelToken[] = [
      { t: "width", width: "f32" }, { t: "param", name: "n", role: "length" }, { t: "param", name: "out", role: "output" },
      { t: "bound", bound: pb("n") },
    ];
    assert(legalNextTokens(noInput).kinds.has("load"), "2 kind mask still admits load");
    assert(setEqArr(legalNextOperands(noInput, "load").arrays, []), "2 but operand mask: no legal load array (refinement)");
  }
  // illegal kind at this position → {} ; invalid prefix → {}
  {
    assertEq(Object.keys(legalNextOperands([...HDR, BND], "binary")).length, 0, "2 illegal kind (binary@depth0) → {}");
    assertEq(Object.keys(legalNextOperands([], "param")).length, 0, "2 illegal kind (param before width) → {}");
    const bad: KernelToken[] = [...HDR, BND, ld, { t: "binary", op: "add" }]; // binary underflow
    assertEq(Object.keys(legalNextOperands(bad, "load")).length, 0, "2 invalid prefix → {}");
  }
  ok("2 per-kind operand sets exact (roles/widths/ops + role-partitioned names + predicates + empty/illegal/invalid)");

  // ── Pin 3: no-invalid-TOKEN — operands filled ONLY from the operand mask ─────
  // The emitter declares a workable signature (its only "policy": pick a role mix that
  // can complete — ≥1 input, ≥1 output, ≥1 scalar, 1 length — with names validated by
  // the freshness predicate), then in the BODY reads array/scalar names back OUT of
  // `legalNextOperands` — it never hardcodes "in0"/"out"/"g". Every operand it emits is
  // sampled from the mask (enumerable) or predicate-checked (const/stride/intercept).
  function emit(seed: number): { stream: KernelToken[]; usedMaskArrays: boolean } {
    const rng = lcg(seed);
    const pick = <T,>(arr: ReadonlyArray<T>): T => arr[Math.floor(rng() * arr.length)]!;
    const stream: KernelToken[] = [];
    let usedMaskArrays = false;

    // header: width from the mask
    stream.push({ t: "width", width: pick(legalNextOperands([], "width").width!) });
    // declare a completable signature; names generated + freshness-checked via the mask
    const decls: ReadonlyArray<ParamRole> = ["length", "output", "input", "input", "scalar"];
    let counter = 0;
    for (const role of decls) {
      const c = legalNextOperands(stream, "param");
      assert(c.paramRoles!.includes(role), `3 role ${role} offered`);
      let nm = `p${counter++}`;
      while (!c.nameIsFresh!(nm)) nm = `p${counter++}`;
      stream.push({ t: "param", name: nm, role });
    }
    // bound: pick a length param from the mask, or a const
    {
      const c = legalNextOperands(stream, "bound");
      if (rng() < 0.5 && c.boundParams!.length > 0) {
        stream.push({ t: "bound", bound: { kind: "param", name: pick(c.boundParams!) } });
      } else {
        let v = Math.floor(rng() * 130) - 1; // may be -1; resample until the predicate accepts
        while (!c.boundConstValid!(v)) v = Math.floor(rng() * 130);
        stream.push({ t: "bound", bound: { kind: "const", value: v } });
      }
    }

    let depth = 0;
    let stores = 0;
    let guard = 0;
    for (;;) {
      assert(++guard < 5000, `3 emitter did not terminate (seed ${seed})`);
      const { kinds, done } = legalNextTokens(stream);
      if (done && rng() < 0.4) break;
      // depth-aware KIND choice, ALWAYS from the offered set
      let choice: TokenKind;
      if (depth === 0) choice = pick(["const", "scalar", "load"]);
      else if (depth >= 4) choice = depth >= 2 ? "binary" : "store";
      else if (depth === 1 && rng() < 0.5) choice = "store";
      else choice = pick((["const", "scalar", "load", "unary", "binary", "store"] as TokenKind[]).filter((k) => kinds.has(k)));
      assert(kinds.has(choice), `3 chose a non-masked kind "${choice}" (seed ${seed})`);

      // OPERANDS: 100% from legalNextOperands — the emitter carries no operand knowledge.
      const co = legalNextOperands(stream, choice);
      switch (choice) {
        case "const": {
          let v = pick([-2, -1, 0, 0.5, 1, 2, 3, NaN, Infinity]); // includes non-finite to exercise the predicate
          while (!co.constValid!(v)) v = pick([-2, -1, 0, 0.5, 1, 2, 3]);
          stream.push({ t: "const", value: v }); depth++; break;
        }
        case "scalar": {
          assert(co.scalars!.length > 0, `3 scalar offered but mask empty (seed ${seed})`);
          stream.push({ t: "scalar", name: pick(co.scalars!) }); depth++; break;
        }
        case "load": {
          assert(co.arrays!.length > 0, `3 load offered but mask empty (seed ${seed})`);
          usedMaskArrays = true;
          let str = pick([1, 2, 0.5]); while (!co.strideValid!(str)) str = pick([1, 2]);
          let icp = pick([0, 1, 1.5]); while (!co.interceptValid!(icp)) icp = pick([0, 1]);
          stream.push({ t: "load", array: pick(co.arrays!), stride: str, intercept: icp }); depth++; break;
        }
        case "unary": stream.push({ t: "unary", op: pick(co.ops!) as UnaryOp }); break;
        case "binary": stream.push({ t: "binary", op: pick(co.ops!) as BinaryOp }); depth--; break;
        case "store": {
          assert(co.arrays!.length > 0, `3 store offered but mask empty (seed ${seed})`);
          usedMaskArrays = true;
          stream.push({ t: "store", array: pick(co.arrays!), stride: 1, intercept: 0 }); depth--; stores++; break;
        }
        default: assert(false, `3 unexpected choice ${choice}`);
      }
    }
    assert(stores >= 1, `3 emitter produced no store (seed ${seed})`);
    return { stream, usedMaskArrays };
  }

  const SEEDS = 1000;
  const distinct = new Set<string>();
  let anyUsedMaskArrays = false;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { stream, usedMaskArrays } = emit(seed);
    anyUsedMaskArrays = anyUsedMaskArrays || usedMaskArrays;
    const r = validateTokens(stream);
    assert(r.ok, `3 mask-driven stream MUST validate (seed ${seed})${r.ok ? "" : " — " + r.error}`);
    assert(legalNextTokens(stream).done, `3 ends at a done boundary (seed ${seed})`);
    tokensToKernel(stream); // round-trips without throwing
    distinct.add(stream.map((t) => t.t).join("."));
  }
  assert(anyUsedMaskArrays, "3 the emitter actually used mask-derived array names (not hardcoded)");
  assert(distinct.size > 50, `3 emitter explores varied shapes (got ${distinct.size})`);
  ok(`3 no-invalid-TOKEN: ${SEEDS} fully operand-masked emissions all validate (${distinct.size} distinct shapes)`);

  // ── Pin 4: broad operand soundness over random valid kernels ────────────────
  const UN_OPS: ReadonlyArray<UnaryOp> = ["neg", "abs", "sqrt", "floor", "ceil", "trunc"];
  const BIN_OPS: ReadonlyArray<BinaryOp> = ["add", "sub", "mul", "div", "min", "max"];
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
      const next = tokens[j]!;
      assert(admits(legalNextOperands(tokens.slice(0, j), next.t), next), `4 generated@${seed}.${j}: operands of "${next.t}" admitted`);
    }
  }
  ok("4 broad operand soundness: 1000 random valid kernels, every prefix's operands admitted");

  // ── Pin 5: parity + barrel identity ─────────────────────────────────────────
  assert(legalNextOperandsFromBarrel === legalNextOperands, "5 barrel re-exports the same legalNextOperands");
  for (const { name, ir } of CORPUS) {
    assert(validateTokens(kernelToTokens(ir)).ok, `5 parity: ${name} still validates`);
  }
  assertEq(kernelHash(CORPUS[0]!.ir), "72b5c2e5a7a5f117", "5 parity: gain content-hash pin intact");
  // legalNextTokens unchanged: the empty prefix still admits exactly {width}
  {
    const r = legalNextTokens([]);
    assert(r.kinds.size === 1 && r.kinds.has("width") && !r.done, "5 legalNextTokens unchanged (empty → {width})");
  }
  ok("5 parity + barrel identity (legalNextTokens/validateTokens unchanged, hash pin intact)");

  console.log("\nAll legalNextOperands pins passed.");
}

main();
