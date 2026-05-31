/**
 * JIT lowering — ESTree → typed IR, validating the sub-language as it goes
 * (Apollo Frontier 5, Stage 1a). This is the single source of truth for what is
 * IN the compilable sub-language (docs/frontier5-jit-semantics.md): every node
 * is matched against the grammar and the FIRST out-of-subset construct throws a
 * `JitRejection` carrying the precise `E_*` diagnostic. There is no fallthrough
 * that lowers an unrecognized node — rejection is total.
 *
 * SSA temps (`let t = expr;`) are INLINED: a reference to `t` returns its
 * defining IR subtree (immutable, so sharing is safe). The result is a list of
 * affine stores over pure expression trees with no temp nodes — which keeps the
 * emitter and the gate's reference interpreter simple, and makes loop-carry
 * structurally impossible (a temp is within-iteration; an accumulator would be a
 * binding outside the single for-loop, which the shape check forbids).
 *
 * `validate()` is the thin wrapper that runs the same walk and returns the
 * diagnostic as a value (for callers that only want to check, not lower).
 */

import type { EsNode } from "./parse.js";
import { reject, JitRejection, type Diagnostic } from "./diagnostics.js";
import {
  type IrKernel, type IrNode, type IrStore, type LoopBound, type KernelSignature,
  type BinaryOp, type UnaryOp, signatureWidth, paramsByRole, lengthParamName,
} from "./ir.js";

interface Ctx {
  readonly sig: KernelSignature;
  readonly inputs: Set<string>;
  readonly outputs: Set<string>;
  readonly scalars: Set<string>;
  readonly lengthName: string | null;
  readonly loopVar: string;
  readonly temps: Map<string, IrNode>;
}

const n = (x: unknown): EsNode => x as EsNode;
const isType = (x: unknown, t: string): boolean => !!x && (x as EsNode).type === t;

// ── entry ───────────────────────────────────────────────────────────────────

export function lowerKernel(program: EsNode, sig: KernelSignature): IrKernel {
  const fn = findFunction(program);
  checkParams(fn, sig);

  const loopVar = readForHeaderLoopVar(getSingleFor(fn));
  const forStmt = getSingleFor(fn);
  const ctx: Ctx = {
    sig,
    inputs: new Set(paramsByRole(sig, "input").map((p) => p.name)),
    outputs: new Set(paramsByRole(sig, "output").map((p) => p.name)),
    scalars: new Set(paramsByRole(sig, "scalar").map((p) => p.name)),
    lengthName: lengthParamName(sig),
    loopVar,
    temps: new Map(),
  };
  const bound = readForBound(forStmt, ctx);
  const stores = lowerLoopBody(forStmt, ctx);
  if (stores.length === 0) reject("E_SHAPE", "kernel loop body writes no output", forStmt);

  return { width: signatureWidth(sig), bound, stores, signature: sig };
}

/** Validation-only wrapper: returns the first diagnostic, or null if acceptable. */
export function validate(program: EsNode, sig: KernelSignature): Diagnostic | null {
  try {
    lowerKernel(program, sig);
    return null;
  } catch (err) {
    if (err instanceof JitRejection) return err.diagnostic;
    throw err;
  }
}

// ── function + signature shape ───────────────────────────────────────────────

function findFunction(program: EsNode): EsNode {
  const body = (program.body as EsNode[]) ?? [];
  for (const stmt of body) {
    if (isType(stmt, "FunctionDeclaration")) return stmt;
    if (isType(stmt, "ExpressionStatement")) {
      const e = n(stmt.expression);
      if (isType(e, "ArrowFunctionExpression") || isType(e, "FunctionExpression")) return e;
    }
    if (isType(stmt, "VariableDeclaration")) {
      const decl = n((stmt.declarations as EsNode[])?.[0]);
      const init = decl && n(decl.init);
      if (init && (isType(init, "ArrowFunctionExpression") || isType(init, "FunctionExpression"))) return init;
    }
    if (isType(stmt, "ExportDefaultDeclaration") || isType(stmt, "ExportNamedDeclaration")) {
      const d = n(stmt.declaration);
      if (d && isType(d, "FunctionDeclaration")) return d;
    }
  }
  reject("E_SHAPE", "no kernel function found (expected a single function declaration or arrow function)", program);
}

function checkParams(fn: EsNode, sig: KernelSignature): void {
  const params = (fn.params as EsNode[]) ?? [];
  if (params.length !== sig.params.length) {
    reject("E_SHAPE", `function has ${params.length} parameters; signature declares ${sig.params.length}`, fn);
  }
  for (let i = 0; i < params.length; i++) {
    const p = n(params[i]);
    if (!isType(p, "Identifier")) reject("E_SHAPE", "kernel parameters must be plain identifiers (no destructuring/defaults)", p);
    if ((p.name as string) !== sig.params[i]!.name) {
      reject("E_SHAPE", `parameter ${i} is "${p.name as string}"; signature declares "${sig.params[i]!.name}"`, p);
    }
  }
}

function getFunctionBody(fn: EsNode): EsNode {
  const body = n(fn.body);
  if (!isType(body, "BlockStatement")) reject("E_SHAPE", "kernel body must be a block { … }", body);
  return body;
}

function getSingleFor(fn: EsNode): EsNode {
  const block = getFunctionBody(fn);
  const stmts = (block.body as EsNode[]) ?? [];
  const fors = stmts.filter((s) => isType(s, "ForStatement"));
  if (stmts.length !== 1 || fors.length !== 1) {
    reject("E_SHAPE", "kernel body must be exactly one for-loop (no statements before/after, no accumulators)", block);
  }
  return n(fors[0]);
}

// ── for-header ────────────────────────────────────────────────────────────────

function readForHeaderLoopVar(forStmt: EsNode): string {
  const init = n(forStmt.init);
  if (!isType(init, "VariableDeclaration") || (init.kind as string) !== "let") {
    reject("E_SHAPE", "loop init must be `let i = 0`", init);
  }
  const decls = (init.declarations as EsNode[]) ?? [];
  if (decls.length !== 1) reject("E_SHAPE", "loop init must declare exactly one variable", init);
  const d = n(decls[0]);
  const id = n(d.id);
  if (!isType(id, "Identifier")) reject("E_SHAPE", "loop variable must be an identifier", id);
  const initVal = n(d.init);
  if (!isType(initVal, "Literal") || (initVal.value as unknown) !== 0) {
    reject("E_SHAPE", "loop must start at 0 (`let i = 0`)", initVal);
  }
  return id.name as string;
}

function readForBound(forStmt: EsNode, ctx: Ctx): LoopBound {
  // update: i++ or i += 1
  const upd = n(forStmt.update);
  const okUpdate =
    (isType(upd, "UpdateExpression") && (upd.operator as string) === "++" && identName(n(upd.argument)) === ctx.loopVar) ||
    (isType(upd, "AssignmentExpression") && (upd.operator as string) === "+=" && identName(n(upd.left)) === ctx.loopVar &&
      isType(n(upd.right), "Literal") && (n(upd.right).value as unknown) === 1);
  if (!okUpdate) reject("E_SHAPE", "loop update must be `i++` or `i += 1`", upd);

  // test: i < bound
  const test = n(forStmt.test);
  if (!isType(test, "BinaryExpression") || (test.operator as string) !== "<" || identName(n(test.left)) !== ctx.loopVar) {
    reject("E_SHAPE", "loop test must be `i < <bound>`", test);
  }
  const right = n(test.right);
  if (isType(right, "Identifier")) {
    const name = right.name as string;
    if (name !== ctx.lengthName) reject("E_SHAPE", `loop bound "${name}" is not the declared length parameter`, right);
    return { kind: "param", name };
  }
  if (isType(right, "Literal") && typeof right.value === "number" && Number.isInteger(right.value) && (right.value as number) >= 0) {
    return { kind: "const", value: right.value as number };
  }
  reject("E_SHAPE", "loop bound must be the length parameter or a non-negative integer literal", right);
}

// ── body: statements → stores (with SSA-temp inlining) ───────────────────────

function lowerLoopBody(forStmt: EsNode, ctx: Ctx): IrStore[] {
  const body = n(forStmt.body);
  if (!isType(body, "BlockStatement")) reject("E_SHAPE", "loop body must be a block { … }", body);
  const stores: IrStore[] = [];
  for (const raw of (body.body as EsNode[]) ?? []) {
    const stmt = n(raw);
    if (isType(stmt, "VariableDeclaration")) {
      lowerTempDecl(stmt, ctx);
    } else if (isType(stmt, "ExpressionStatement")) {
      stores.push(lowerStore(n(stmt.expression), ctx));
    } else {
      // nested loops / if / while / break / return live here:
      if (isType(stmt, "IfStatement") || isType(stmt, "SwitchStatement")) reject("E_BRANCH", "branches are not allowed in a kernel loop", stmt);
      if (isType(stmt, "ForStatement") || isType(stmt, "WhileStatement") || isType(stmt, "DoWhileStatement")) reject("E_CONTROL", "nested loops are not allowed", stmt);
      if (isType(stmt, "BreakStatement") || isType(stmt, "ContinueStatement") || isType(stmt, "ReturnStatement")) reject("E_CONTROL", "break/continue/return are not allowed in a kernel loop", stmt);
      reject("E_DYNAMIC", `unsupported statement: ${stmt.type}`, stmt);
    }
  }
  return stores;
}

function lowerTempDecl(stmt: EsNode, ctx: Ctx): void {
  const kind = stmt.kind as string;
  if (kind === "var") reject("E_REASSIGN", "`var` is not allowed; use `let`/`const` single-assignment temps", stmt);
  const decls = (stmt.declarations as EsNode[]) ?? [];
  if (decls.length !== 1) reject("E_REASSIGN", "declare one temp per statement", stmt);
  const d = n(decls[0]);
  const id = n(d.id);
  if (!isType(id, "Identifier")) reject("E_DYNAMIC", "temp must be a plain identifier (no destructuring)", id);
  const name = id.name as string;
  if (ctx.temps.has(name)) reject("E_REASSIGN", `temp "${name}" is re-declared (SSA temps are single-assignment)`, id);
  if (ctx.scalars.has(name) || ctx.inputs.has(name) || ctx.outputs.has(name) || name === ctx.loopVar || name === ctx.lengthName) {
    reject("E_REASSIGN", `temp "${name}" shadows a parameter`, id);
  }
  if (!d.init) reject("E_SHAPE", `temp "${name}" must be initialized`, id);
  ctx.temps.set(name, lowerExpr(n(d.init), ctx));
}

function lowerStore(expr: EsNode, ctx: Ctx): IrStore {
  if (!isType(expr, "AssignmentExpression")) {
    if (isType(expr, "UpdateExpression")) reject("E_REASSIGN", "++/-- is not allowed", expr);
    reject("E_SHAPE", "loop body statements must be `out[idx] = expr` or `let t = expr`", expr);
  }
  if ((expr.operator as string) !== "=") reject("E_REASSIGN", `compound assignment "${expr.operator as string}" is not allowed (would read the output → loop-carry)`, expr);
  const left = n(expr.left);
  if (!isType(left, "MemberExpression") || !(left.computed as boolean)) {
    reject("E_REASSIGN", "kernel may only assign to an output array element `out[idx]`", left);
  }
  const arrName = identName(n(left.object));
  if (!arrName || !ctx.outputs.has(arrName)) reject("E_SHAPE", `store target must be a declared output array (got "${arrName ?? "?"}")`, left);
  const { stride, intercept } = lowerAffineIndex(n(left.property), ctx, true);
  const value = lowerExpr(n(expr.right), ctx);
  return { array: arrName!, stride, intercept, value };
}

// ── expressions → IrNode ──────────────────────────────────────────────────────

function lowerExpr(node: EsNode, ctx: Ctx): IrNode {
  switch (node.type) {
    case "Literal": {
      const v = node.value as unknown;
      if (typeof v !== "number") reject("E_DYNAMIC", `only numeric literals are allowed (got ${typeof v})`, node);
      if (!Number.isFinite(v)) reject("E_NONFINITE_LITERAL", "NaN / Infinity literals are not allowed in source", node);
      return { kind: "const", value: v };
    }
    case "Identifier": {
      const name = node.name as string;
      // `Infinity` / `NaN` are GLOBAL IDENTIFIERS in JS, not numeric literals.
      if (name === "Infinity" || name === "NaN") reject("E_NONFINITE_LITERAL", `${name} is not allowed in a kernel`, node);
      if (ctx.temps.has(name)) return ctx.temps.get(name)!; // inline the SSA subtree
      if (ctx.scalars.has(name)) return { kind: "scalar", name };
      if (name === ctx.loopVar) reject("E_DYNAMIC", "the loop variable may only appear inside an array index, not as a value", node);
      if (ctx.inputs.has(name) || ctx.outputs.has(name)) reject("E_DYNAMIC", `array "${name}" must be indexed (e.g. ${name}[i])`, node);
      if (name === ctx.lengthName) reject("E_DYNAMIC", "the length parameter may not be used as a value", node);
      reject("E_USE_BEFORE_DEF", `unknown identifier "${name}" (temp read before definition, or undeclared)`, node);
      break;
    }
    case "MemberExpression": {
      if (!(node.computed as boolean)) reject("E_DYNAMIC", "property access (a.b) is not allowed outside Math.<fn>(…)", node);
      const arrName = identName(n(node.object));
      if (!arrName) reject("E_DYNAMIC", "array load must be `name[idx]`", node);
      if (ctx.outputs.has(arrName!)) reject("E_LOOP_CARRY", `reading an output array ("${arrName}") is a loop-carried dependency`, node);
      if (!ctx.inputs.has(arrName!)) reject("E_DYNAMIC", `"${arrName}" is not a declared input array`, node);
      const { stride, intercept } = lowerAffineIndex(n(node.property), ctx, false);
      return { kind: "load", array: arrName!, stride, intercept };
    }
    case "UnaryExpression": {
      const op = node.operator as string;
      if (op === "+") return lowerExpr(n(node.argument), ctx); // unary plus is identity
      if (op === "-") return { kind: "unary", op: "neg", a: lowerExpr(n(node.argument), ctx) };
      reject("E_OP", `unary operator "${op}" is not allowed`, node);
      break;
    }
    case "BinaryExpression": {
      const op = node.operator as string;
      const map: Record<string, BinaryOp> = { "+": "add", "-": "sub", "*": "mul", "/": "div" };
      if (op in map) {
        return { kind: "binary", op: map[op]!, a: lowerExpr(n(node.left), ctx), b: lowerExpr(n(node.right), ctx) };
      }
      reject("E_OP", `operator "${op}" is not allowed (no bitwise / % / comparison in v1)`, node);
      break;
    }
    case "CallExpression":
      return lowerCall(node, ctx);
    case "ConditionalExpression":
      reject("E_BRANCH", "the ternary operator (?:) is not allowed", node);
      break;
    case "LogicalExpression":
      reject("E_BRANCH", `logical operator "${node.operator as string}" is not allowed`, node);
      break;
    case "AssignmentExpression":
      reject("E_REASSIGN", "assignment is not allowed inside an expression", node);
      break;
    case "UpdateExpression":
      reject("E_REASSIGN", "++/-- is not allowed", node);
      break;
    case "ArrayExpression":
    case "ObjectExpression":
    case "NewExpression":
    case "SpreadElement":
      reject("E_DYNAMIC", `allocation / ${node.type} is not allowed`, node);
      break;
    default:
      reject("E_DYNAMIC", `unsupported expression: ${node.type}`, node);
  }
  // unreachable (every branch rejects or returns)
  reject("E_DYNAMIC", "unsupported expression", node);
}

const TRANSCENDENTALS = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "exp", "expm1", "log", "log2", "log10", "log1p", "pow", "cbrt", "sinh", "cosh", "tanh", "hypot", "sign", "round", "fround", "random"]);
const UNARY_MATH = new Set<UnaryOp>(["abs", "sqrt", "floor", "ceil", "trunc"]);
const BINARY_MATH = new Set<BinaryOp>(["min", "max"]);

function lowerCall(node: EsNode, ctx: Ctx): IrNode {
  const callee = n(node.callee);
  if (!isType(callee, "MemberExpression") || (callee.computed as boolean) || identName(n(callee.object)) !== "Math") {
    reject("E_CALL", "only whitelisted Math.<fn>(…) calls are allowed (no user functions / recursion / methods)", node);
  }
  const fn = identName(n(callee.property));
  if (!fn) reject("E_CALL", "malformed Math call", node);
  const args = ((node.arguments as EsNode[]) ?? []).map((a) => n(a));
  if (TRANSCENDENTALS.has(fn!)) reject("E_TRANSCENDENTAL", `Math.${fn} has no SIMD intrinsic / no exact lowering (deferred to a v2 lane)`, node);
  if (UNARY_MATH.has(fn as UnaryOp)) {
    if (args.length !== 1) reject("E_CALL", `Math.${fn} takes 1 argument`, node);
    return { kind: "unary", op: fn as UnaryOp, a: lowerExpr(args[0]!, ctx) };
  }
  if (BINARY_MATH.has(fn as BinaryOp)) {
    if (args.length !== 2) reject("E_CALL", `Math.${fn} takes exactly 2 arguments in v1`, node);
    return { kind: "binary", op: fn as BinaryOp, a: lowerExpr(args[0]!, ctx), b: lowerExpr(args[1]!, ctx) };
  }
  reject("E_CALL", `Math.${fn} is not in the v1 whitelist (min/max/abs/sqrt/floor/ceil/trunc)`, node);
}

// ── affine index: a*i + b with a ∈ {1,2}, b integer ≥ 0 ─────────────────────

interface Affine { a: number; b: number; }

function lowerAffineIndex(node: EsNode, ctx: Ctx, isStore: boolean): { stride: number; intercept: number } {
  const aff = evalAffine(node, ctx);
  if (aff.a !== 1 && aff.a !== 2) {
    reject("E_STRIDE", `array index slope must be 1 or 2 (got ${aff.a}); index must be affine in the loop variable`, node);
  }
  if (!Number.isInteger(aff.b) || aff.b < 0) {
    reject("E_STRIDE", `array index intercept must be a non-negative integer (got ${aff.b})`, node);
  }
  // A store at stride 2 would need an interleaving store the v1 emitter does not
  // produce; the language allows it but vectorize.ts surfaces it as unsupported.
  void isStore;
  return { stride: aff.a, intercept: aff.b };
}

function evalAffine(node: EsNode, ctx: Ctx): Affine {
  if (isType(node, "Identifier")) {
    if ((node.name as string) === ctx.loopVar) return { a: 1, b: 0 };
    reject("E_STRIDE", `array index may only use the loop variable "${ctx.loopVar}" (got "${node.name as string}")`, node);
  }
  if (isType(node, "Literal")) {
    const v = node.value as unknown;
    if (typeof v !== "number" || !Number.isInteger(v)) reject("E_STRIDE", "array index constant must be an integer", node);
    return { a: 0, b: v as number };
  }
  if (isType(node, "UnaryExpression") && (node.operator as string) === "-") {
    const inner = evalAffine(n(node.argument), ctx);
    return { a: -inner.a, b: -inner.b };
  }
  if (isType(node, "BinaryExpression")) {
    const op = node.operator as string;
    const l = evalAffine(n(node.left), ctx);
    const r = evalAffine(n(node.right), ctx);
    if (op === "+") return { a: l.a + r.a, b: l.b + r.b };
    if (op === "-") return { a: l.a - r.a, b: l.b - r.b };
    if (op === "*") {
      if (l.a === 0) return { a: r.a * l.b, b: r.b * l.b }; // const * affine
      if (r.a === 0) return { a: l.a * r.b, b: l.b * r.b }; // affine * const
      reject("E_STRIDE", "array index is non-linear in the loop variable (i*i)", node);
    }
    reject("E_STRIDE", `array index operator "${op}" is not allowed (affine only)`, node);
  }
  reject("E_STRIDE", `array index must be affine in the loop variable (got ${node.type})`, node);
}

// ── tiny helpers ──────────────────────────────────────────────────────────────

function identName(node: EsNode): string | null {
  return isType(node, "Identifier") ? (node.name as string) : null;
}
