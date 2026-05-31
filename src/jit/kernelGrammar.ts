/**
 * Kernel grammar — the canonical token serialization of the JIT IR
 * (Apollo Frontier 6, Stage 0).
 *
 * This is the FRONT of the language→music pipeline: a small, CLOSED token
 * grammar that IS `ir.ts`'s `IrKernel` serialized, with a lossless bidirectional
 * codec, a value-returning syntax validator, and a deterministic content hash.
 * No model. No compile. Pure data — it depends only on the IR *types* and the
 * canonical `kernelKey`, never on the parser/vectorizer/emitter/gate.
 *
 * Why postfix (RPN): an `IrNode` expression tree serializes cleanly to postfix —
 * each token either PUSHES one operand (`const`/`scalar`/`load`) or POPS N and
 * pushes one result (`unary` pops 1, `binary` pops 2); a `store` pops exactly the
 * one value of its expression. That push/pop shape is exactly what a future
 * constrained decoder (Stage 3) wants: at every position the set of legal next
 * tokens is finite and computable from the operand-stack depth, so an emitter
 * *literally cannot* produce invalid IR. `validateTokens` is the spec that
 * decoder enforces — built now, used later.
 *
 * SELF-CONTAINED STREAMS (a deliberate refinement of the handoff sketch). The
 * token stream carries the FULL kernel — `width`, the signature (`param` tokens),
 * the loop `bound`, then the body — so `tokensToKernel`/`validateTokens` need NO
 * external `signature` argument. This is strictly more capable than the sketched
 * `tokensToKernel(tokens, signature)` (signature is derivable, not required) and
 * makes the flat text form a complete, copy-pasteable surface.
 *
 * THREE GATES, this is gate #1 (syntax). `validateTokens` is the syntax layer:
 * stack arity, known ops, integer affine strides, exactly-one-value-before-STORE,
 * a single leading `width`, and declared-name resolution. Gate #2 (equivalence,
 * `gate.ts`) and gate #3 (acoustic, Stage 2) live elsewhere. Rejection is a
 * VALUE here, mirroring `compileKernel`'s contract — these functions never throw
 * on a malformed *token array* (`tokensToKernel` is the one throwing convenience
 * wrapper; `parseTokens` throws only on lexically-malformed *text*).
 *
 * `kernelHash` is a CONTENT ADDRESS / cache key / identity — FNV-1a-64 over the
 * canonical `kernelKey(ir)`, synchronous and zero-dependency (browser- and
 * AudioWorklet-realm safe). It is **NOT a security boundary**: the equivalence
 * gate is the boundary. Because `kernelKey` is over the kernel BODY (width, bound,
 * stores) and not the signature, two kernels with the same computation but a
 * different calling convention hash equal — that is the intended identity.
 *
 * `@experimental` — exported from `webgpu-audio-bridge/experimental`, NOT the 1.0
 * core. A one-shot construction warning fires (mirrors compileKernel/MpmcRing).
 */

import {
  type IrKernel, type IrNode, type IrStore, type LoopBound,
  type KernelSignature, type KernelParam, type ParamRole,
  type LaneWidth, type UnaryOp, type BinaryOp,
  UNARY_OPS, BINARY_OPS, kernelKey,
} from "./ir.js";

// ── token grammar ─────────────────────────────────────────────────────────────
//
// A token stream is, in order: one `width`; zero+ `param` (the signature, in
// declaration order); one `bound`; then the body — for each store, the store's
// expression in postfix followed by its `store` token.

export type KernelToken =
  | { readonly t: "width"; readonly width: LaneWidth }
  | { readonly t: "param"; readonly name: string; readonly role: ParamRole }
  | { readonly t: "bound"; readonly bound: LoopBound }
  | { readonly t: "load"; readonly array: string; readonly stride: number; readonly intercept: number }
  | { readonly t: "scalar"; readonly name: string }
  | { readonly t: "const"; readonly value: number }
  | { readonly t: "unary"; readonly op: UnaryOp }
  | { readonly t: "binary"; readonly op: BinaryOp }
  | { readonly t: "store"; readonly array: string; readonly stride: number; readonly intercept: number };

export type TokenKind = KernelToken["t"];

/** Validator result — rejection is a VALUE (mirrors `compileKernel`). */
export type ValidateFailure = { readonly ok: false; readonly error: string; readonly at?: number };
export type ValidateResult =
  | { readonly ok: true; readonly ir: IrKernel }
  | ValidateFailure;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROLES: ReadonlySet<string> = new Set<ParamRole>(["input", "output", "scalar", "length"]);

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[webgpu-audio-bridge] The kernel grammar (kernelGrammar) is EXPERIMENTAL " +
      "(0.9.918, Apollo Frontier 6, Stage 0). The token grammar, codec, validator, " +
      "and content hash are outside the 1.0 stability contract and may change before " +
      "promotion. `kernelHash` is a content-address / cache key, NOT a security " +
      "boundary — the equivalence gate (gate.ts) is the boundary.",
  );
}

// ── IR → tokens ───────────────────────────────────────────────────────────────

/** Serialize an `IrKernel` to its canonical token stream (lossless). */
export function kernelToTokens(ir: IrKernel): KernelToken[] {
  warnOnce();
  const tokens: KernelToken[] = [{ t: "width", width: ir.width }];
  for (const p of ir.signature.params) tokens.push({ t: "param", name: p.name, role: p.role });
  tokens.push({ t: "bound", bound: ir.bound });
  for (const store of ir.stores) {
    emitNode(store.value, tokens);
    tokens.push({ t: "store", array: store.array, stride: store.stride, intercept: store.intercept });
  }
  return tokens;
}

function emitNode(node: IrNode, out: KernelToken[]): void {
  switch (node.kind) {
    case "const": out.push({ t: "const", value: node.value }); break;
    case "scalar": out.push({ t: "scalar", name: node.name }); break;
    case "load": out.push({ t: "load", array: node.array, stride: node.stride, intercept: node.intercept }); break;
    case "unary": emitNode(node.a, out); out.push({ t: "unary", op: node.op }); break;
    case "binary": emitNode(node.a, out); emitNode(node.b, out); out.push({ t: "binary", op: node.op }); break;
  }
}

// ── tokens → IR (validate + build) ────────────────────────────────────────────

function fail(error: string, at?: number): ValidateFailure {
  return at === undefined ? { ok: false, error } : { ok: false, error, at };
}

/**
 * The syntax gate: validate a token stream and, on success, build the `IrKernel`.
 * Never throws — rejection is a value. Checks (in order): a single leading
 * `width`; a contiguous `param` run with unique, well-formed names + known roles;
 * one `bound` resolving to a declared param or a non-negative integer constant;
 * a postfix body with correct stack arity, known ops, integer affine strides, and
 * exactly one value on the stack at each `store`; every referenced name declared;
 * an empty stack and ≥1 store at the end.
 */
export function validateTokens(tokens: ReadonlyArray<KernelToken>): ValidateResult {
  warnOnce();
  if (tokens.length === 0) return fail("empty token stream");

  // 1) width — must be the first token, exactly once.
  const first = tokens[0]!;
  if (first.t !== "width") return fail("first token must be `width`", 0);
  if (first.width !== "f32" && first.width !== "f64") return fail(`unknown width "${String(first.width)}"`, 0);
  const width: LaneWidth = first.width;

  // 2) params — a contiguous run declaring the signature.
  let i = 1;
  const params: KernelParam[] = [];
  const names = new Set<string>();
  for (; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.t !== "param") break;
    if (!IDENT.test(tk.name)) return fail(`invalid param name "${tk.name}"`, i);
    if (names.has(tk.name)) return fail(`duplicate param "${tk.name}"`, i);
    if (!ROLES.has(tk.role)) return fail(`unknown param role "${String(tk.role)}"`, i);
    names.add(tk.name);
    params.push({ name: tk.name, role: tk.role });
  }

  // 3) bound.
  if (i >= tokens.length) return fail("missing `bound` token");
  const boundTok = tokens[i]!;
  if (boundTok.t !== "bound") return fail("expected `bound` token after the param run", i);
  const bound = boundTok.bound;
  if (bound.kind === "param") {
    if (!names.has(bound.name)) return fail(`bound references undeclared param "${bound.name}"`, i);
  } else if (!Number.isInteger(bound.value) || bound.value < 0) {
    return fail(`bound constant must be a non-negative integer (got ${bound.value})`, i);
  }
  i++;

  // 4) body — postfix with an operand stack; one value per STORE.
  const stack: IrNode[] = [];
  const stores: IrStore[] = [];
  for (; i < tokens.length; i++) {
    const tk = tokens[i]!;
    switch (tk.t) {
      case "width": return fail("unexpected `width` token in body", i);
      case "param": return fail("`param` tokens must precede `bound`", i);
      case "bound": return fail("duplicate `bound` token", i);
      case "const":
        if (typeof tk.value !== "number") return fail("const value must be a number", i);
        stack.push({ kind: "const", value: tk.value });
        break;
      case "scalar":
        if (!names.has(tk.name)) return fail(`scalar references undeclared param "${tk.name}"`, i);
        stack.push({ kind: "scalar", name: tk.name });
        break;
      case "load": {
        const err = checkAffine("load", tk.array, tk.stride, tk.intercept, names, i);
        if (err) return err;
        stack.push({ kind: "load", array: tk.array, stride: tk.stride, intercept: tk.intercept });
        break;
      }
      case "unary": {
        if (!UNARY_OPS.has(tk.op)) return fail(`unknown unary op "${String(tk.op)}"`, i);
        const a = stack.pop();
        if (a === undefined) return fail(`unary "${tk.op}" underflows the operand stack`, i);
        stack.push({ kind: "unary", op: tk.op, a });
        break;
      }
      case "binary": {
        if (!BINARY_OPS.has(tk.op)) return fail(`unknown binary op "${String(tk.op)}"`, i);
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) return fail(`binary "${tk.op}" underflows the operand stack`, i);
        stack.push({ kind: "binary", op: tk.op, a, b });
        break;
      }
      case "store": {
        const err = checkAffine("store", tk.array, tk.stride, tk.intercept, names, i);
        if (err) return err;
        if (stack.length !== 1) return fail(`STORE expects exactly one value on the stack (found ${stack.length})`, i);
        stores.push({ array: tk.array, stride: tk.stride, intercept: tk.intercept, value: stack.pop()! });
        break;
      }
    }
  }

  if (stack.length !== 0) return fail(`${stack.length} unconsumed value(s) at end of stream (missing STORE?)`);
  if (stores.length === 0) return fail("kernel has no stores");

  const signature: KernelSignature = { params, width };
  return { ok: true, ir: { width, bound, stores, signature } };
}

function checkAffine(
  what: "load" | "store", array: string, stride: number, intercept: number,
  names: ReadonlySet<string>, at: number,
): ValidateFailure | null {
  if (!IDENT.test(array)) return fail(`${what} has invalid array name "${array}"`, at);
  if (!names.has(array)) return fail(`${what} references undeclared array "${array}"`, at);
  if (!Number.isInteger(stride)) return fail(`${what} stride must be an integer (got ${stride})`, at);
  if (!Number.isInteger(intercept)) return fail(`${what} intercept must be an integer (got ${intercept})`, at);
  return null;
}

/**
 * Build an `IrKernel` from a token stream. Throws on an invalid stream (the one
 * throwing convenience over the value-returning `validateTokens`). The optional
 * `signature` is accepted for call-shape compatibility but IGNORED — the stream
 * is self-contained (its `param` tokens carry the signature).
 */
export function tokensToKernel(tokens: ReadonlyArray<KernelToken>): IrKernel {
  const r = validateTokens(tokens);
  if (!r.ok) throw new Error(`tokensToKernel: invalid token stream — ${r.error}${r.at !== undefined ? ` (at token ${r.at})` : ""}`);
  return r.ir;
}

// ── flat text form ────────────────────────────────────────────────────────────
//
// One whitespace-separated word per token; multi-field tokens are colon-joined.
// A complete kernel is one copy-pasteable line, e.g.:
//   width:f32 param:n:length param:out:output param:in:input param:g:scalar \
//   bound:$n load:in:1:0 scalar:g binary:mul store:out:1:0

/** Render a token stream to the flat one-line text form. */
export function tokensToString(tokens: ReadonlyArray<KernelToken>): string {
  warnOnce();
  return tokens.map(tokenToWord).join(" ");
}

function tokenToWord(tk: KernelToken): string {
  switch (tk.t) {
    case "width": return `width:${tk.width}`;
    case "param": return `param:${tk.name}:${tk.role}`;
    case "bound": return tk.bound.kind === "param" ? `bound:$${tk.bound.name}` : `bound:#${String(tk.bound.value)}`;
    case "load": return `load:${tk.array}:${String(tk.stride)}:${String(tk.intercept)}`;
    case "scalar": return `scalar:${tk.name}`;
    case "const": return `const:${String(tk.value)}`;
    case "unary": return `unary:${tk.op}`;
    case "binary": return `binary:${tk.op}`;
    case "store": return `store:${tk.array}:${String(tk.stride)}:${String(tk.intercept)}`;
  }
}

/** Parse the flat text form back to a token stream. Throws on lexically-malformed
 *  text (use `validateTokens` for the semantic/structural checks). */
export function parseTokens(text: string): KernelToken[] {
  warnOnce();
  const words = text.trim().length === 0 ? [] : text.trim().split(/\s+/);
  return words.map(wordToToken);
}

function wordToToken(w: string): KernelToken {
  const parts = w.split(":");
  const kind = parts[0];
  switch (kind) {
    case "width": {
      const ww = parts[1];
      if (ww !== "f32" && ww !== "f64") throw new Error(`parseTokens: bad width token "${w}"`);
      return { t: "width", width: ww };
    }
    case "param": {
      const name = parts[1];
      const role = parts[2];
      if (name === undefined || role === undefined) throw new Error(`parseTokens: bad param token "${w}"`);
      if (role !== "input" && role !== "output" && role !== "scalar" && role !== "length") {
        throw new Error(`parseTokens: bad param role in "${w}"`);
      }
      return { t: "param", name, role };
    }
    case "bound": {
      const arg = parts[1];
      if (arg === undefined || arg.length < 2) throw new Error(`parseTokens: bad bound token "${w}"`);
      if (arg[0] === "$") return { t: "bound", bound: { kind: "param", name: arg.slice(1) } };
      if (arg[0] === "#") return { t: "bound", bound: { kind: "const", value: strToNum(arg.slice(1)) } };
      throw new Error(`parseTokens: bad bound token "${w}" (expected $name or #value)`);
    }
    case "load":
    case "store": {
      const array = parts[1];
      const s = parts[2];
      const c = parts[3];
      if (array === undefined || s === undefined || c === undefined) throw new Error(`parseTokens: bad ${kind} token "${w}"`);
      const t: "load" | "store" = kind === "store" ? "store" : "load";
      return { t, array, stride: strToNum(s), intercept: strToNum(c) };
    }
    case "scalar": {
      const name = parts[1];
      if (name === undefined) throw new Error(`parseTokens: bad scalar token "${w}"`);
      return { t: "scalar", name };
    }
    case "const": {
      const v = parts[1];
      if (v === undefined) throw new Error(`parseTokens: bad const token "${w}"`);
      return { t: "const", value: strToNum(v) };
    }
    case "unary": {
      const op = parts[1];
      if (op === undefined) throw new Error(`parseTokens: bad unary token "${w}"`);
      return { t: "unary", op: op as UnaryOp };
    }
    case "binary": {
      const op = parts[1];
      if (op === undefined) throw new Error(`parseTokens: bad binary token "${w}"`);
      return { t: "binary", op: op as BinaryOp };
    }
    default:
      throw new Error(`parseTokens: unknown token kind "${String(kind)}" in "${w}"`);
  }
}

function strToNum(s: string): number {
  if (s.length === 0) throw new Error("parseTokens: empty numeric field");
  const n = Number(s);
  if (Number.isNaN(n) && s !== "NaN") throw new Error(`parseTokens: not a number "${s}"`);
  return n;
}

// ── content hash ──────────────────────────────────────────────────────────────

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK64 = (1n << 64n) - 1n;

/**
 * Deterministic content address for a kernel: FNV-1a-64 (16 hex chars) over the
 * canonical `kernelKey(ir)`. Synchronous + zero-dependency (no `node:crypto`),
 * safe in the AudioWorklet realm. Identity/cache key only — see the file header:
 * the GATE is the safety boundary. Equal `kernelKey` ⇒ equal hash (so the kernel
 * BODY, not the signature, is the address).
 */
export function kernelHash(input: IrKernel | ReadonlyArray<KernelToken>): string {
  warnOnce();
  const ir: IrKernel = isTokenArray(input) ? tokensToKernel(input) : input;
  return fnv1a64Hex(kernelKey(ir));
}

function isTokenArray(x: IrKernel | ReadonlyArray<KernelToken>): x is ReadonlyArray<KernelToken> {
  return Array.isArray(x);
}

function fnv1a64Hex(s: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}
