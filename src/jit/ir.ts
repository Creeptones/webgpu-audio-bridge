/**
 * JIT IR — typed expression tree for the per-sample loop body (Apollo Frontier 5, Stage 1a).
 *
 * A kernel is one counted loop `for (let i=0; i<n; i++) { … }` whose body, after
 * SSA-temp inlining (see `lower.ts`), is a list of affine STORES, each holding an
 * expression TREE over loads / scalars / constants / arithmetic. The tree shape
 * is preserved verbatim by both the scalar and the SIMD emitter — that
 * tree-shape preservation is the (NR) "no reassociation" invariant the
 * vectorization-correctness proof's Lemma 4 rests on.
 *
 * Single width per kernel (v1): every array, scalar, and the body's arithmetic
 * are one width `w ∈ {f32, f64}`. The semantics doc's `Math.fround` width-
 * coercion boundary is therefore not exercised in v1 (it would require a mixed
 * kernel, which `E_MIXED_WIDTH` rejects) — so it is not in the emittable op set.
 *
 * The IR is plain data (no behavior) so it round-trips cleanly and the emitter,
 * the gate's reference interpreter, and a future serializer all read the same
 * shape. No hash-consing in v1 (temps are inlined; CSE is a later perf lane).
 */

export type LaneWidth = "f32" | "f64";

/** Bytes per element + lanes per v128, per width. */
export const ELEM_BYTES: Record<LaneWidth, number> = { f32: 4, f64: 8 };
export const LANES: Record<LaneWidth, number> = { f32: 4, f64: 2 };

export type UnaryOp = "neg" | "abs" | "sqrt" | "floor" | "ceil" | "trunc";
export type BinaryOp = "add" | "sub" | "mul" | "div" | "min" | "max";

export const UNARY_OPS: ReadonlySet<string> = new Set<UnaryOp>(["neg", "abs", "sqrt", "floor", "ceil", "trunc"]);
export const BINARY_OPS: ReadonlySet<string> = new Set<BinaryOp>(["add", "sub", "mul", "div", "min", "max"]);
/** The exactly-reproducible `Math.*` whitelist (each has a SIMD intrinsic). */
export const MATH_WHITELIST: ReadonlySet<string> = new Set(["min", "max", "abs", "sqrt", "floor", "ceil", "trunc"]);

export type IrNode =
  | { readonly kind: "const"; readonly value: number }
  | { readonly kind: "scalar"; readonly name: string }
  /** affine load: element index = stride*i + intercept. */
  | { readonly kind: "load"; readonly array: string; readonly stride: number; readonly intercept: number }
  /** read a single-sample state register's value at iteration start (Frontier 7). */
  | { readonly kind: "readState"; readonly name: string }
  | { readonly kind: "unary"; readonly op: UnaryOp; readonly a: IrNode }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly a: IrNode; readonly b: IrNode };

/** One affine store: out-array[stride*i + intercept] = value. */
export interface IrStore {
  readonly array: string;
  readonly stride: number;
  readonly intercept: number;
  readonly value: IrNode;
}

// ── state registers (Apollo Frontier 7, Stage 1) ────────────────────────────
//
// A single-sample memory the kernel may read (`readState`) and write (at most
// once per iteration, `IrStateStore`). Semantics are SIMULTANEOUS / state-space
// (docs/frontier7-statefulness-semantics.md §2.2): every `readState` in an
// iteration sees the value committed at the END of the previous iteration (the
// decl's `init` for iteration 0); each written register commits at the end of
// the iteration. Registers are NOT signature params — they are internal memory;
// the emitter threads them through a `$state` base pointer, not a declared arg.

/** A declared single-sample state register and its cold-start value (default 0). */
export interface IrStateDecl {
  readonly name: string;
  readonly init: number;
}

/** A register's next-iteration value (one per register name per iteration max). */
export interface IrStateStore {
  readonly name: string;
  readonly value: IrNode;
}

export type LoopBound =
  | { readonly kind: "param"; readonly name: string } // trip count = a `length` param
  | { readonly kind: "const"; readonly value: number }; // compile-time trip count

export interface IrKernel {
  readonly width: LaneWidth;
  readonly bound: LoopBound;
  readonly stores: ReadonlyArray<IrStore>;
  /** Declared state registers (Frontier 7). Absent/empty ⇒ a stateless kernel —
   *  the content address (`kernelKey`/`kernelHash`) is then byte-identical to
   *  pre-statefulness, so the stateless hash regression pins are preserved. */
  readonly stateDecls?: ReadonlyArray<IrStateDecl>;
  /** Per-iteration register commits (Frontier 7). Absent/empty ⇒ stateless. */
  readonly stateStores?: ReadonlyArray<IrStateStore>;
  readonly signature: KernelSignature;
}

/** True iff the kernel carries state registers (⇒ scalar-only, not time-axis SIMD). */
export function isStateful(k: IrKernel): boolean {
  return (k.stateDecls?.length ?? 0) > 0 || (k.stateStores?.length ?? 0) > 0;
}

// ── KernelSignature — the declared I/O shape ────────────────────────────────
//
// The caller declares each parameter's role so the compiler need not infer it
// from the body. Arrays and scalars are all the kernel `width`. Param ORDER in
// `params` is the source function's parameter order; the emitter lays out the
// WASM export params in a canonical order (length, then output arrays, then
// input arrays, then scalars) — see `emitKernelWat.paramLayout`.

export type ParamRole = "input" | "output" | "scalar" | "length";

export interface KernelParam {
  readonly name: string;
  readonly role: ParamRole;
}

export interface KernelSignature {
  readonly params: ReadonlyArray<KernelParam>;
  /** Lane width for every array + scalar (default "f32"). */
  readonly width?: LaneWidth;
}

export function signatureWidth(sig: KernelSignature): LaneWidth {
  return sig.width ?? "f32";
}
export function paramsByRole(sig: KernelSignature, role: ParamRole): KernelParam[] {
  return sig.params.filter((p) => p.role === role);
}
export function lengthParamName(sig: KernelSignature): string | null {
  return paramsByRole(sig, "length")[0]?.name ?? null;
}

/** A canonical, stable string for a node — used for determinism checks and the
 *  emitted-WAT banner fingerprint. Mirrors the probe's `key()`. */
export function nodeKey(n: IrNode): string {
  switch (n.kind) {
    case "const": return `#${n.value}`;
    case "scalar": return `$${n.name}`;
    case "load": return `${n.array}[${n.stride}i+${n.intercept}]`;
    case "readState": return `@${n.name}`;
    case "unary": return `${n.op}(${nodeKey(n.a)})`;
    case "binary": return `${n.op}(${nodeKey(n.a)},${nodeKey(n.b)})`;
  }
}
export function kernelKey(k: IrKernel): string {
  const b = k.bound.kind === "param" ? `n=${k.bound.name}` : `n=${k.bound.value}`;
  const base = `${k.width}|${b}|` + k.stores.map((s) => `${s.array}[${s.stride}i+${s.intercept}]=${nodeKey(s.value)}`).join(";");
  // State segment appended ONLY when present, so a stateless kernel's key (and
  // therefore its hash) is byte-identical to pre-statefulness.
  const decls = k.stateDecls ?? [];
  const stores = k.stateStores ?? [];
  if (decls.length === 0 && stores.length === 0) return base;
  const dseg = decls.map((d) => `${d.name}=${d.init}`).join(",");
  const sseg = stores.map((s) => `${s.name}:=${nodeKey(s.value)}`).join(";");
  return `${base}|state{${dseg}}{${sseg}}`;
}
