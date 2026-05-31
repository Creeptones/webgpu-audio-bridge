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
  /** read a delay-line ring buffer at a fixed integer offset `delay` (≥1) — the
   *  sample written `delay` iterations ago (Frontier 7, Stage 3). */
  | { readonly kind: "readDelay"; readonly buffer: string; readonly delay: number }
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

// ── delay-line ring buffers (Apollo Frontier 7, Stage 3) ─────────────────────
//
// A `z⁻N` ring buffer: `length` f32/f64 slots + an implicit write cursor `w`, all
// 0-init in v1. `readDelay(buf, d)` (1 ≤ d ≤ length) reads `buf[(w−d+L) mod L]` —
// the sample written `d` iterations ago; `writeDelay` (≤1 per buffer per iteration)
// schedules a value into slot `w`. Because every read uses `d ≥ 1`, no read in an
// iteration ever touches the slot about to be written, so — unlike a single-sample
// register — a buffer needs NO deferral temp: it writes directly to `buf[w]` (after
// the reads), then `w` advances at iteration end. Simultaneity (the locked §2.2
// semantics) falls out for free. A `z⁻¹` register IS a length-1 buffer read at
// delay 1; v1 keeps registers + buffers as separate constructs for back-compat.

/** A declared delay-line ring buffer (`length` slots, all 0-init in v1). */
export interface IrStateBufferDecl {
  readonly name: string;
  readonly length: number;
}

/** A buffer's scheduled write (one per buffer per iteration max). */
export interface IrStateBufferStore {
  readonly buffer: string;
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
  /** Declared delay-line ring buffers (Frontier 7, Stage 3). Absent/empty ⇒ no
   *  delay lines. Like `stateDecls`, the content address folds these in ONLY when
   *  present, so a stateless / registers-only kernel's hash is byte-identical. */
  readonly stateBuffers?: ReadonlyArray<IrStateBufferDecl>;
  /** Per-iteration buffer writes (Frontier 7, Stage 3). Absent/empty ⇒ no writes. */
  readonly stateBufferStores?: ReadonlyArray<IrStateBufferStore>;
  readonly signature: KernelSignature;
}

/** True iff the kernel carries loop-carried state — registers OR delay buffers
 *  (⇒ scalar-only, not time-axis SIMD: the recurrence wall). */
export function isStateful(k: IrKernel): boolean {
  return (
    (k.stateDecls?.length ?? 0) > 0 || (k.stateStores?.length ?? 0) > 0 ||
    (k.stateBuffers?.length ?? 0) > 0 || (k.stateBufferStores?.length ?? 0) > 0
  );
}

// ── the single state-layout descriptor (the non-drift source of truth) ───────
//
// The slab layout (which element holds which register / which buffer ring / which
// cursor) is needed by the emitter, `evalReference`, and the Stage-2 consumer. Three
// ad-hoc copies WOULD drift (the same risk the single `stepGrammar` machine avoids on
// the grammar side), so ALL THREE read this one function. Layout order (declaration
// order): registers first (one slot each), then per buffer its `length` ring slots
// followed by ONE cursor slot. Offsets are ELEMENT indices (multiply by
// `ELEM_BYTES[width]` for byte offsets). The cursor lives IN the slab as a width-typed
// float (homogeneous slab ⇒ trivial to seed/copy; small integers are exact in f32 ≤
// 2²⁴ / f64 ≤ 2⁵³, far above any buffer length), truncated to an i32 in the loop.

export interface StateLayout {
  /** Total element (f-word) count in one generation's slab. */
  readonly elements: number;
  /** Registers, in declaration order — element offset + cold-start init. */
  readonly regs: ReadonlyArray<{ readonly name: string; readonly offset: number; readonly init: number }>;
  /** Delay buffers, in declaration order — the ring start offset, its length, and
   *  the element offset of the (float) write cursor that follows the ring. */
  readonly buffers: ReadonlyArray<{
    readonly name: string; readonly offset: number; readonly length: number; readonly cursorOffset: number;
  }>;
}

/** Compute the (single source of truth) slab layout for a kernel's loop-carried
 *  state. Accepts any `{ stateDecls?, stateBuffers? }` shape (an `IrKernel`, or the
 *  consumer's decls+buffers), so every consumer reads the SAME offsets. */
export function stateLayout(ir: {
  readonly stateDecls?: ReadonlyArray<IrStateDecl>;
  readonly stateBuffers?: ReadonlyArray<IrStateBufferDecl>;
}): StateLayout {
  const decls = ir.stateDecls ?? [];
  const bufs = ir.stateBuffers ?? [];
  const regs = decls.map((d, k) => ({ name: d.name, offset: k, init: d.init }));
  let cursor = decls.length;
  const buffers = bufs.map((b) => {
    const offset = cursor;
    const cursorOffset = offset + b.length;
    cursor = cursorOffset + 1;
    return { name: b.name, offset, length: b.length, cursorOffset };
  });
  return { elements: cursor, regs, buffers };
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
    case "readDelay": return `@${n.buffer}[~${n.delay}]`;
    case "unary": return `${n.op}(${nodeKey(n.a)})`;
    case "binary": return `${n.op}(${nodeKey(n.a)},${nodeKey(n.b)})`;
  }
}
export function kernelKey(k: IrKernel): string {
  const b = k.bound.kind === "param" ? `n=${k.bound.name}` : `n=${k.bound.value}`;
  const base = `${k.width}|${b}|` + k.stores.map((s) => `${s.array}[${s.stride}i+${s.intercept}]=${nodeKey(s.value)}`).join(";");
  // State segments appended ONLY when present, so a stateless kernel's key (and
  // therefore its hash) is byte-identical to pre-statefulness, AND a registers-only
  // kernel's key is byte-identical to pre-Stage-3 (the `dbuf` segment is skipped).
  const decls = k.stateDecls ?? [];
  const stores = k.stateStores ?? [];
  const bufs = k.stateBuffers ?? [];
  const bufStores = k.stateBufferStores ?? [];
  if (decls.length === 0 && stores.length === 0 && bufs.length === 0 && bufStores.length === 0) return base;
  let key = base;
  if (decls.length > 0 || stores.length > 0) {
    const dseg = decls.map((d) => `${d.name}=${d.init}`).join(",");
    const sseg = stores.map((s) => `${s.name}:=${nodeKey(s.value)}`).join(";");
    key += `|state{${dseg}}{${sseg}}`;
  }
  if (bufs.length > 0 || bufStores.length > 0) {
    const bseg = bufs.map((b) => `${b.name}:${b.length}`).join(",");
    const bstoreseg = bufStores.map((s) => `${s.buffer}<=${nodeKey(s.value)}`).join(";");
    key += `|dbuf{${bseg}}{${bstoreseg}}`;
  }
  return key;
}
