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
  type IrKernel, type IrNode, type IrStore, type IrStateDecl, type IrStateStore,
  type IrStateBufferDecl, type IrStateBufferStore, type LoopBound,
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
  /** state-register declaration (Frontier 7) — in the params phase, beside `param`. */
  | { readonly t: "state"; readonly name: string; readonly init: number }
  /** delay-line buffer declaration (Frontier 7, Stage 3) — in the params phase. */
  | { readonly t: "stateBuffer"; readonly name: string; readonly length: number }
  | { readonly t: "bound"; readonly bound: LoopBound }
  | { readonly t: "load"; readonly array: string; readonly stride: number; readonly intercept: number }
  /** read a state register (Frontier 7) — a body value-pusher, like `scalar`. */
  | { readonly t: "readState"; readonly name: string }
  /** read a delay-line buffer at a fixed integer offset (Frontier 7, Stage 3) — a
   *  body value-pusher, like `load`; the buffer must be declared + `1 ≤ delay ≤ length`. */
  | { readonly t: "readDelay"; readonly buffer: string; readonly delay: number }
  | { readonly t: "scalar"; readonly name: string }
  | { readonly t: "const"; readonly value: number }
  | { readonly t: "unary"; readonly op: UnaryOp }
  | { readonly t: "binary"; readonly op: BinaryOp }
  | { readonly t: "store"; readonly array: string; readonly stride: number; readonly intercept: number }
  /** commit a state register's next value (Frontier 7) — a body terminator, like
   *  `store` (consumes the one value on the stack); one per register per iteration. */
  | { readonly t: "writeState"; readonly name: string }
  /** schedule a value into a delay-line buffer (Frontier 7, Stage 3) — a body
   *  terminator, like `writeState`; one per buffer per iteration. */
  | { readonly t: "writeDelay"; readonly buffer: string };

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

/** Serialize an `IrKernel` to its canonical token stream (lossless). Order: width,
 *  the `param` run (signature order), the `state` decls (Frontier 7), `bound`, then
 *  the body — each output store's expression + `store`, then each state register's
 *  next-value expression + `writeState`. */
export function kernelToTokens(ir: IrKernel): KernelToken[] {
  warnOnce();
  const tokens: KernelToken[] = [{ t: "width", width: ir.width }];
  for (const p of ir.signature.params) tokens.push({ t: "param", name: p.name, role: p.role });
  for (const d of ir.stateDecls ?? []) tokens.push({ t: "state", name: d.name, init: d.init });
  for (const b of ir.stateBuffers ?? []) tokens.push({ t: "stateBuffer", name: b.name, length: b.length });
  tokens.push({ t: "bound", bound: ir.bound });
  for (const store of ir.stores) {
    emitNode(store.value, tokens);
    tokens.push({ t: "store", array: store.array, stride: store.stride, intercept: store.intercept });
  }
  for (const ss of ir.stateStores ?? []) {
    emitNode(ss.value, tokens);
    tokens.push({ t: "writeState", name: ss.name });
  }
  for (const bs of ir.stateBufferStores ?? []) {
    emitNode(bs.value, tokens);
    tokens.push({ t: "writeDelay", buffer: bs.buffer });
  }
  return tokens;
}

function emitNode(node: IrNode, out: KernelToken[]): void {
  switch (node.kind) {
    case "const": out.push({ t: "const", value: node.value }); break;
    case "scalar": out.push({ t: "scalar", name: node.name }); break;
    case "load": out.push({ t: "load", array: node.array, stride: node.stride, intercept: node.intercept }); break;
    case "readState": out.push({ t: "readState", name: node.name }); break;
    case "readDelay": out.push({ t: "readDelay", buffer: node.buffer, delay: node.delay }); break;
    case "unary": emitNode(node.a, out); out.push({ t: "unary", op: node.op }); break;
    case "binary": emitNode(node.a, out); emitNode(node.b, out); out.push({ t: "binary", op: node.op }); break;
  }
}

// ── tokens → IR (validate + build) ────────────────────────────────────────────

function fail(error: string, at?: number): ValidateFailure {
  return at === undefined ? { ok: false, error } : { ok: false, error, at };
}

/** True iff `name` is already declared in ANY of the three namespaces (signature
 *  params, state registers, delay buffers) — names are globally unique. */
function taken(s: GrammarState, name: string): boolean {
  return s.names.has(name) || s.stateNames.has(name) || s.bufferNames.has(name);
}

// ── the grammar step machine (shared by validateTokens + legalNextTokens) ───────
//
// `validateTokens` and `legalNextTokens` are two readings of ONE walk: validate
// folds the step over a whole stream then checks the final state; legalNextTokens
// folds over a prefix and asks which token KINDS the next step would accept. Sharing
// a single `stepGrammar` is what guarantees the Stage-3 decoder's mask can NEVER
// drift from the validator — the mask is, by construction, exactly the set of kinds
// the validator will not reject.

/** The three sequential phases of a token stream: the leading `width`, the
 *  contiguous `param` run (the signature), then the postfix body. */
type GrammarPhase = "width" | "params" | "body";

/** The full structural + IR-building state of a partial walk. `stack`/`stores` are
 *  the operand stack + accumulated stores the validator builds; the mask only reads
 *  `phase` + `stack.length` + `stores.length` + the declared `names`. */
interface GrammarState {
  phase: GrammarPhase;
  width: LaneWidth | null;
  params: KernelParam[];
  names: Set<string>;
  bound: LoopBound | null;
  stack: IrNode[];
  stores: IrStore[];
  // ── state registers (Frontier 7) ──────────────────────────────────────────
  /** Declared register names — a SEPARATE namespace from `names` (signature
   *  params), so a `scalar`/`load`/`store`/`bound` name can never resolve to a
   *  register and vice versa (sound: a register is internal memory, not an arg). */
  stateNames: Set<string>;
  stateDecls: IrStateDecl[];
  stateStores: IrStateStore[];
  /** Registers already written this iteration (at most one `writeState` each). */
  written: Set<string>;
  // ── delay-line ring buffers (Frontier 7, Stage 3) ──────────────────────────
  /** Declared buffer names — a THIRD namespace (beside signature params + state
   *  registers), so a buffer name never collides with an array/scalar/register. */
  bufferNames: Set<string>;
  stateBuffers: IrStateBufferDecl[];
  stateBufferStores: IrStateBufferStore[];
  /** Buffers already written this iteration (at most one `writeDelay` each). */
  bufWritten: Set<string>;
}

function initialState(): GrammarState {
  return {
    phase: "width", width: null, params: [], names: new Set<string>(), bound: null,
    stack: [], stores: [], stateNames: new Set<string>(), stateDecls: [], stateStores: [], written: new Set<string>(),
    bufferNames: new Set<string>(), stateBuffers: [], stateBufferStores: [], bufWritten: new Set<string>(),
  };
}

/** Advance the state by one token. Mutates `s`; returns a `ValidateFailure` (with
 *  the same message + `at` index the original `validateTokens` produced) if the
 *  token is illegal at this position, or `null` on success. */
function stepGrammar(s: GrammarState, tk: KernelToken, at: number): ValidateFailure | null {
  switch (s.phase) {
    case "width": {
      if (tk.t !== "width") return fail("first token must be `width`", at);
      if (tk.width !== "f32" && tk.width !== "f64") return fail(`unknown width "${String(tk.width)}"`, at);
      s.width = tk.width;
      s.phase = "params";
      return null;
    }
    case "params": {
      if (tk.t === "param") {
        if (!IDENT.test(tk.name)) return fail(`invalid param name "${tk.name}"`, at);
        if (taken(s, tk.name)) return fail(`duplicate param "${tk.name}"`, at);
        if (!ROLES.has(tk.role)) return fail(`unknown param role "${String(tk.role)}"`, at);
        s.names.add(tk.name);
        s.params.push({ name: tk.name, role: tk.role });
        return null;
      }
      if (tk.t === "state") {
        if (!IDENT.test(tk.name)) return fail(`invalid state name "${tk.name}"`, at);
        if (taken(s, tk.name)) return fail(`duplicate state register "${tk.name}"`, at);
        if (typeof tk.init !== "number" || !Number.isFinite(tk.init)) return fail(`state "${tk.name}" init must be a finite number`, at);
        s.stateNames.add(tk.name);
        s.stateDecls.push({ name: tk.name, init: tk.init });
        return null;
      }
      if (tk.t === "stateBuffer") {
        if (!IDENT.test(tk.name)) return fail(`invalid state buffer name "${tk.name}"`, at);
        if (taken(s, tk.name)) return fail(`duplicate state buffer "${tk.name}"`, at);
        if (!Number.isInteger(tk.length) || tk.length < 1) return fail(`state buffer "${tk.name}" length must be a positive integer (got ${tk.length})`, at);
        s.bufferNames.add(tk.name);
        s.stateBuffers.push({ name: tk.name, length: tk.length });
        return null;
      }
      if (tk.t === "bound") {
        const bound = tk.bound;
        if (bound.kind === "param") {
          if (!s.names.has(bound.name)) return fail(`bound references undeclared param "${bound.name}"`, at);
        } else if (!Number.isInteger(bound.value) || bound.value < 0) {
          return fail(`bound constant must be a non-negative integer (got ${bound.value})`, at);
        }
        s.bound = bound;
        s.phase = "body";
        return null;
      }
      return fail("expected a `param`, `state`, `stateBuffer`, or `bound` token in the signature phase", at);
    }
    case "body": {
      switch (tk.t) {
        case "width": return fail("unexpected `width` token in body", at);
        case "param": return fail("`param` tokens must precede `bound`", at);
        case "state": return fail("`state` tokens must precede `bound`", at);
        case "stateBuffer": return fail("`stateBuffer` tokens must precede `bound`", at);
        case "bound": return fail("duplicate `bound` token", at);
        case "const":
          if (typeof tk.value !== "number") return fail("const value must be a number", at);
          s.stack.push({ kind: "const", value: tk.value });
          return null;
        case "scalar":
          if (!s.names.has(tk.name)) return fail(`scalar references undeclared param "${tk.name}"`, at);
          s.stack.push({ kind: "scalar", name: tk.name });
          return null;
        case "readState":
          if (!s.stateNames.has(tk.name)) return fail(`readState references undeclared state register "${tk.name}"`, at);
          s.stack.push({ kind: "readState", name: tk.name });
          return null;
        case "readDelay": {
          const buf = s.stateBuffers.find((b) => b.name === tk.buffer);
          if (!buf) return fail(`readDelay references undeclared state buffer "${tk.buffer}"`, at);
          if (!Number.isInteger(tk.delay) || tk.delay < 1 || tk.delay > buf.length) {
            return fail(`readDelay delay must be an integer in [1, ${buf.length}] (got ${tk.delay})`, at);
          }
          s.stack.push({ kind: "readDelay", buffer: tk.buffer, delay: tk.delay });
          return null;
        }
        case "writeState": {
          if (!s.stateNames.has(tk.name)) return fail(`writeState references undeclared state register "${tk.name}"`, at);
          if (s.written.has(tk.name)) return fail(`state register "${tk.name}" is written more than once per iteration`, at);
          if (s.stack.length !== 1) return fail(`writeState expects exactly one value on the stack (found ${s.stack.length})`, at);
          s.stateStores.push({ name: tk.name, value: s.stack.pop()! });
          s.written.add(tk.name);
          return null;
        }
        case "writeDelay": {
          if (!s.bufferNames.has(tk.buffer)) return fail(`writeDelay references undeclared state buffer "${tk.buffer}"`, at);
          if (s.bufWritten.has(tk.buffer)) return fail(`state buffer "${tk.buffer}" is written more than once per iteration`, at);
          if (s.stack.length !== 1) return fail(`writeDelay expects exactly one value on the stack (found ${s.stack.length})`, at);
          s.stateBufferStores.push({ buffer: tk.buffer, value: s.stack.pop()! });
          s.bufWritten.add(tk.buffer);
          return null;
        }
        case "load": {
          const err = checkAffine("load", tk.array, tk.stride, tk.intercept, s.names, at);
          if (err) return err;
          s.stack.push({ kind: "load", array: tk.array, stride: tk.stride, intercept: tk.intercept });
          return null;
        }
        case "unary": {
          if (!UNARY_OPS.has(tk.op)) return fail(`unknown unary op "${String(tk.op)}"`, at);
          const a = s.stack.pop();
          if (a === undefined) return fail(`unary "${tk.op}" underflows the operand stack`, at);
          s.stack.push({ kind: "unary", op: tk.op, a });
          return null;
        }
        case "binary": {
          if (!BINARY_OPS.has(tk.op)) return fail(`unknown binary op "${String(tk.op)}"`, at);
          const b = s.stack.pop();
          const a = s.stack.pop();
          if (a === undefined || b === undefined) return fail(`binary "${tk.op}" underflows the operand stack`, at);
          s.stack.push({ kind: "binary", op: tk.op, a, b });
          return null;
        }
        case "store": {
          const err = checkAffine("store", tk.array, tk.stride, tk.intercept, s.names, at);
          if (err) return err;
          if (s.stack.length !== 1) return fail(`STORE expects exactly one value on the stack (found ${s.stack.length})`, at);
          s.stores.push({ array: tk.array, stride: tk.stride, intercept: tk.intercept, value: s.stack.pop()! });
          return null;
        }
      }
    }
  }
}

/** Close the walk: turn the final state into the accepted `IrKernel`, or the
 *  end-of-stream failure (empty / missing bound / unconsumed operand / no store). */
function finalizeGrammar(s: GrammarState): ValidateResult {
  if (s.phase === "width") return fail("empty token stream");
  if (s.phase === "params") return fail("missing `bound` token");
  if (s.stack.length !== 0) return fail(`${s.stack.length} unconsumed value(s) at end of stream (missing STORE?)`);
  if (s.stores.length === 0) return fail("kernel has no stores");
  const signature: KernelSignature = { params: s.params, width: s.width! };
  // State fields are added ONLY when present, so a stateless stream rebuilds the
  // byte-identical (state-free) IR, and a registers-only stream omits the buffer
  // fields — preserving both content addresses.
  const ir: IrKernel = { width: s.width!, bound: s.bound!, stores: s.stores, signature };
  const withState = (s.stateDecls.length > 0 || s.stateStores.length > 0)
    ? { ...ir, stateDecls: s.stateDecls, stateStores: s.stateStores }
    : ir;
  const withBuffers = (s.stateBuffers.length > 0 || s.stateBufferStores.length > 0)
    ? { ...withState, stateBuffers: s.stateBuffers, stateBufferStores: s.stateBufferStores }
    : withState;
  return { ok: true, ir: withBuffers };
}

/**
 * The syntax gate: validate a token stream and, on success, build the `IrKernel`.
 * Never throws — rejection is a value. Checks (in order): a single leading
 * `width`; a contiguous `param` run with unique, well-formed names + known roles;
 * one `bound` resolving to a declared param or a non-negative integer constant;
 * a postfix body with correct stack arity, known ops, integer affine strides, and
 * exactly one value on the stack at each `store`; every referenced name declared;
 * an empty stack and ≥1 store at the end. A fold of `stepGrammar` + `finalizeGrammar`.
 */
export function validateTokens(tokens: ReadonlyArray<KernelToken>): ValidateResult {
  warnOnce();
  const s = initialState();
  for (let i = 0; i < tokens.length; i++) {
    const err = stepGrammar(s, tokens[i]!, i);
    if (err) return err;
  }
  return finalizeGrammar(s);
}

// ── the constrained-decoder mask (Stage 3a) ─────────────────────────────────────
//
// `legalNextTokens(prefix)` is the forward-direction sibling of `validateTokens`:
// it answers "given this valid prefix, which token KINDS may legally come next, and
// is the stream a complete kernel here?". The set is a finite function of the
// operand-stack depth + the declaration phase, so a Stage-3 decoder that masks its
// logits to this set *cannot* emit a structurally-invalid stream (stack underflow,
// dangling operand, store with the wrong arity, param-after-bound). v1 masks KINDS;
// a wrong OPERAND (an undeclared array name, a fractional stride) can still be
// rejected by `validateTokens` — that is the operand-mask's job (a v2), and the
// reason the emitter is responsible for filling operands from the declared names.

/** The result of `legalNextTokens`: the legal next-token KIND set + whether the
 *  prefix is already a complete, valid kernel (so the decoder may stop here). */
export interface LegalNextResult {
  /** The token kinds that `validateTokens` will not reject as the next step. Empty
   *  iff the prefix is itself invalid (no legal continuation exists). */
  readonly kinds: ReadonlySet<TokenKind>;
  /** True iff stopping here yields a complete, valid kernel (body phase, empty
   *  operand stack, ≥1 store emitted) — i.e. `validateTokens(prefix).ok`. */
  readonly done: boolean;
}

/** The legal next-token kinds for a (valid) state — the pure mask function. */
function legalKinds(s: GrammarState): Set<TokenKind> {
  const out = new Set<TokenKind>();
  switch (s.phase) {
    case "width":
      out.add("width");
      break;
    case "params":
      out.add("param"); // declare another signature parameter
      out.add("state"); // …or declare a state register (Frontier 7)
      out.add("stateBuffer"); // …or declare a delay-line buffer (Frontier 7, Stage 3)
      out.add("bound"); // …or end the signature phase and begin the body
      break;
    case "body": {
      const depth = s.stack.length;
      out.add("const"); // value-pushers are always legal (depth → depth+1)
      out.add("scalar");
      out.add("load");
      out.add("readState"); // a state read is a value-pusher too (Frontier 7)
      out.add("readDelay"); // …as is a delay-line read (Frontier 7, Stage 3)
      if (depth >= 1) out.add("unary");  // pops 1, pushes 1
      if (depth >= 2) out.add("binary"); // pops 2, pushes 1
      if (depth === 1) {
        out.add("store");      // consumes the one value → starts a new statement
        out.add("writeState"); // …or commits it to a state register (Frontier 7)
        out.add("writeDelay"); // …or schedules it into a delay buffer (Frontier 7, Stage 3)
      }
      break;
    }
  }
  return out;
}

/** Whether the state is an accepting state — exactly `validateTokens(prefix).ok`. */
function isAccepting(s: GrammarState): boolean {
  return s.phase === "body" && s.stack.length === 0 && s.stores.length >= 1;
}

/**
 * The constrained-decoder mask: the legal next-token KIND set for a token-stream
 * prefix, plus a `done` flag. Folds `stepGrammar` over the prefix, then reads the
 * mask off the final state. Pure + value-returning (never throws). An invalid
 * prefix returns an empty `kinds` set with `done: false` (there is no legal
 * continuation of a malformed stream).
 */
export function legalNextTokens(prefix: ReadonlyArray<KernelToken>): LegalNextResult {
  warnOnce();
  const s = initialState();
  for (let i = 0; i < prefix.length; i++) {
    if (stepGrammar(s, prefix[i]!, i)) return { kinds: new Set<TokenKind>(), done: false };
  }
  return { kinds: legalKinds(s), done: isAccepting(s) };
}

// ── the OPERAND mask (Stage 3a+) ────────────────────────────────────────────────
//
// `legalNextTokens` masks the token KIND; this masks the operand CHOICES of a given
// kind, closing the last gap C1 left. Given a (valid) prefix and a chosen `kind`,
// `legalNextOperands` returns the legal value-sets for that kind's operand fields:
// enumerable fields (`width`, `param` role, `bound`/`load`/`store`/`scalar` names,
// `unary`/`binary` op) as explicit arrays, unbounded fields (`const` value, affine
// `stride`/`intercept`, `bound` const, the `param` name) as validity predicates the
// decoder samples-then-checks. A decoder that masks its KIND logits with
// `legalNextTokens` AND fills the operand from `legalNextOperands` *literally cannot*
// emit any token `validateTokens` would reject — operand included.
//
// ROLE-PARTITIONED (a deliberate tightening of the validator). `validateTokens`
// admits a `load`/`store`/`scalar`/`bound:$name` referencing ANY declared param;
// `legalNextOperands` returns only the role-correct names (load ⊂ inputs, store ⊂
// outputs, scalar ⊂ scalars, bound-param ⊂ lengths). This is STRICTLY SOUND — a
// role-correct name is a declared name, so every choice still validates — and it is
// the semantically-meaningful set an emitter actually wants (you don't load from an
// output or take a trip count from an input array). The corpus authors role-correct
// kernels, so the operand-soundness pin holds.

/** The legal operand choices for one token kind at a prefix position. Only the
 *  fields relevant to `kind` are populated; the rest are absent. Enumerable fields
 *  are arrays (possibly empty ⇒ no legal token of that kind here, even if the KIND
 *  mask admits it); unbounded fields are validity predicates. */
export interface OperandChoices {
  /** `width` token: the two lane widths. */
  readonly width?: ReadonlyArray<LaneWidth>;
  /** `param` token: the legal roles + a name-freshness predicate (fresh IDENT). */
  readonly paramRoles?: ReadonlyArray<ParamRole>;
  readonly nameIsFresh?: (name: string) => boolean;
  /** `bound` token: declared length-param names usable as a trip count, plus the
   *  const-bound option (a non-negative integer per `boundConstValid`). */
  readonly boundParams?: ReadonlyArray<string>;
  readonly boundConstOk?: boolean;
  readonly boundConstValid?: (value: number) => boolean;
  /** `load`/`store` token: the role-correct array names + affine-coefficient predicates. */
  readonly arrays?: ReadonlyArray<string>;
  readonly strideValid?: (n: number) => boolean;
  readonly interceptValid?: (n: number) => boolean;
  /** `scalar` token: the declared scalar-role names. */
  readonly scalars?: ReadonlyArray<string>;
  /** `const` token: a value-validity predicate (finite number). Also the `state`
   *  token's `init` field validity (a finite number). */
  readonly constValid?: (value: number) => boolean;
  /** `unary`/`binary` token: the legal ops. */
  readonly ops?: ReadonlyArray<UnaryOp | BinaryOp>;
  /** `readState` token: every declared register; `writeState` token: the registers
   *  not yet written this iteration (Frontier 7). Empty ⇒ no legal token of that kind
   *  here (no register declared, or all already written). */
  readonly stateNames?: ReadonlyArray<string>;
  /** `readDelay` token: every declared delay buffer; `writeDelay` token: the buffers
   *  not yet written this iteration (Frontier 7, Stage 3). Empty ⇒ no legal token. */
  readonly buffers?: ReadonlyArray<string>;
  /** `readDelay` token: validity of the (buffer, delay) pair — integer in
   *  `[1, lengthOf(buffer)]`. Takes the buffer name because the bound is per-buffer. */
  readonly delayValid?: (buffer: string, delay: number) => boolean;
  /** `stateBuffer` token: validity of the declared ring length (a positive integer).
   *  (The buffer NAME freshness rides on `nameIsFresh`, shared with `param`/`state`.) */
  readonly lengthValid?: (n: number) => boolean;
}

const ALL_WIDTHS: ReadonlyArray<LaneWidth> = ["f32", "f64"];
const ALL_ROLES: ReadonlyArray<ParamRole> = ["input", "output", "scalar", "length"];
const UNARY_OP_LIST = [...UNARY_OPS] as ReadonlyArray<UnaryOp>;
const BINARY_OP_LIST = [...BINARY_OPS] as ReadonlyArray<BinaryOp>;
const isInteger = (n: number): boolean => Number.isInteger(n);
const isFiniteNumber = (n: number): boolean => Number.isFinite(n);
const isBoundConst = (v: number): boolean => Number.isInteger(v) && v >= 0;
const isBufferLength = (v: number): boolean => Number.isInteger(v) && v >= 1;

/** The declared names of a given role, in declaration order. */
function namesByRole(s: GrammarState, role: ParamRole): string[] {
  const out: string[] = [];
  for (const p of s.params) if (p.role === role) out.push(p.name);
  return out;
}

/**
 * The operand mask: the legal operand choices for `kind` at the end of `prefix`.
 * Pure + value-returning (never throws). Returns an empty `OperandChoices` (`{}`) if
 * the prefix is invalid OR `kind` is not itself legal here (i.e. not in
 * `legalNextTokens(prefix).kinds`) — so a decoder can compose the two masks freely.
 */
export function legalNextOperands(
  prefix: ReadonlyArray<KernelToken>,
  kind: TokenKind,
): OperandChoices {
  warnOnce();
  const s = initialState();
  for (let i = 0; i < prefix.length; i++) {
    if (stepGrammar(s, prefix[i]!, i)) return {}; // invalid prefix → no legal operands
  }
  if (!legalKinds(s).has(kind)) return {}; // the KIND itself is illegal at this position
  switch (kind) {
    case "width": return { width: ALL_WIDTHS };
    case "param": return { paramRoles: ALL_ROLES, nameIsFresh: (n) => IDENT.test(n) && !taken(s, n) };
    case "state": return { nameIsFresh: (n) => IDENT.test(n) && !taken(s, n), constValid: isFiniteNumber };
    case "stateBuffer": return { nameIsFresh: (n) => IDENT.test(n) && !taken(s, n), lengthValid: isBufferLength };
    case "bound": return { boundParams: namesByRole(s, "length"), boundConstOk: true, boundConstValid: isBoundConst };
    case "load": return { arrays: namesByRole(s, "input"), strideValid: isInteger, interceptValid: isInteger };
    case "store": return { arrays: namesByRole(s, "output"), strideValid: isInteger, interceptValid: isInteger };
    case "scalar": return { scalars: namesByRole(s, "scalar") };
    case "const": return { constValid: isFiniteNumber };
    case "unary": return { ops: UNARY_OP_LIST };
    case "binary": return { ops: BINARY_OP_LIST };
    case "readState": return { stateNames: [...s.stateNames] };
    case "writeState": return { stateNames: [...s.stateNames].filter((nm) => !s.written.has(nm)) };
    case "readDelay": {
      const lenOf = (b: string): number => s.stateBuffers.find((x) => x.name === b)?.length ?? 0;
      return {
        buffers: s.stateBuffers.map((b) => b.name),
        delayValid: (b, d) => Number.isInteger(d) && d >= 1 && d <= lenOf(b),
      };
    }
    case "writeDelay": return { buffers: s.stateBuffers.map((b) => b.name).filter((nm) => !s.bufWritten.has(nm)) };
  }
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
    case "state": return `state:${tk.name}:${String(tk.init)}`;
    case "stateBuffer": return `stateBuffer:${tk.name}:${String(tk.length)}`;
    case "bound": return tk.bound.kind === "param" ? `bound:$${tk.bound.name}` : `bound:#${String(tk.bound.value)}`;
    case "load": return `load:${tk.array}:${String(tk.stride)}:${String(tk.intercept)}`;
    case "readState": return `readState:${tk.name}`;
    case "readDelay": return `readDelay:${tk.buffer}:${String(tk.delay)}`;
    case "scalar": return `scalar:${tk.name}`;
    case "const": return `const:${String(tk.value)}`;
    case "unary": return `unary:${tk.op}`;
    case "binary": return `binary:${tk.op}`;
    case "store": return `store:${tk.array}:${String(tk.stride)}:${String(tk.intercept)}`;
    case "writeState": return `writeState:${tk.name}`;
    case "writeDelay": return `writeDelay:${tk.buffer}`;
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
    case "state": {
      const name = parts[1];
      const init = parts[2];
      if (name === undefined || init === undefined) throw new Error(`parseTokens: bad state token "${w}"`);
      return { t: "state", name, init: strToNum(init) };
    }
    case "stateBuffer": {
      const name = parts[1];
      const length = parts[2];
      if (name === undefined || length === undefined) throw new Error(`parseTokens: bad stateBuffer token "${w}"`);
      return { t: "stateBuffer", name, length: strToNum(length) };
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
    case "readState": {
      const name = parts[1];
      if (name === undefined) throw new Error(`parseTokens: bad readState token "${w}"`);
      return { t: "readState", name };
    }
    case "readDelay": {
      const buffer = parts[1];
      const delay = parts[2];
      if (buffer === undefined || delay === undefined) throw new Error(`parseTokens: bad readDelay token "${w}"`);
      return { t: "readDelay", buffer, delay: strToNum(delay) };
    }
    case "writeState": {
      const name = parts[1];
      if (name === undefined) throw new Error(`parseTokens: bad writeState token "${w}"`);
      return { t: "writeState", name };
    }
    case "writeDelay": {
      const buffer = parts[1];
      if (buffer === undefined) throw new Error(`parseTokens: bad writeDelay token "${w}"`);
      return { t: "writeDelay", buffer };
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
