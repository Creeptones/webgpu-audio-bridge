/**
 * JIT vectorize — IR → VectorizedKernelPlan (Apollo Frontier 5, Stage 1a).
 *
 * The lowering proper (the scalar→SIMD rewrite) is realized in
 * `emitKernelWat.ts`, which emits the SAME operation tree as either single-lane
 * `f{32,64}.*` ops (scalar reference) or packed `f{32x4,64x2}.*` ops (SIMD
 * candidate) — the tree-shape-preserving (NR)+(NF) lowering the proof's Lemma 4
 * requires. This module computes the *plan* the emitter consumes and decides
 * **emittability**:
 *
 *   - It collects the distinct arrays + scalars (the WASM export's params).
 *   - It pins the lane width W = (f32 ⇒ 4, f64 ⇒ 2).
 *   - It checks every load/store is one the v1 emitter can produce. v1 emits
 *     **contiguous (stride-1) loads and stores only.** A stride-2 (AoS
 *     deinterleave) load is VALID in the language (semantics §1) but not yet
 *     vectorized by this patch, so it is returned as `{ ok:false,
 *     reason:"stride-2-not-emitted" }` → `compileKernel` reports `unsupported`
 *     → the runtime keeps the JS kernel. (Stride-2 deinterleave is a named
 *     follow-up; the Stage-0 probe already proved its soundness.)
 *
 * Deterministic: array/scalar ordering follows signature declaration order; no
 * Math.random / Date.now anywhere (same source ⇒ same plan ⇒ same WAT bytes).
 */

import { type IrKernel, type IrNode, type LaneWidth, LANES, isStateful } from "./ir.js";

export interface PlanArrayRef {
  readonly name: string;
  readonly role: "input" | "output";
}

/** How the kernel is lowered to WASM (Apollo Frontier 7, Stage 4 generalized
 *  `scalarOnly` to a three-way mode):
 *  - `"simd-time"` — stateless: the normal time-axis SIMD path (unchanged default).
 *  - `"scalar"`    — stateful, single voice: scalar-only (the recurrence wall —
 *    Stages 1–3). The fallback + the `voices === 1` case.
 *  - `"simd-voice"`— stateful, `voices ≥ W` (a multiple of W): re-engage SIMD along
 *    the VOICE axis (W independent voices per v128). */
export type VectorizeMode = "simd-time" | "scalar" | "simd-voice";

export interface VectorizedKernelPlan {
  readonly width: LaneWidth;
  readonly laneWidth: number; // W
  readonly arrays: ReadonlyArray<PlanArrayRef>; // distinct arrays, signature order
  readonly scalars: ReadonlyArray<string>; // distinct scalar params, signature order
  readonly exportName: string;
  /** The lowering mode (Frontier 7, Stage 4). */
  readonly mode: VectorizeMode;
  /** DERIVED back-compat flag (`mode !== "simd-time"`): true ⇒ NOT the time-axis
   *  SIMD path. A stateful kernel is `scalarOnly` whether it takes the `"scalar"`
   *  fallback or the `"simd-voice"` path — both are gated against `evalReference`
   *  (the IR spec), not SIMD ≡ scalar. Kept so downstream `scalarOnly` reads still
   *  work; the `"simd-voice"` distinction rides on `mode`. */
  readonly scalarOnly: boolean;
}

export type VectorizeResult =
  | { readonly ok: true; readonly plan: VectorizedKernelPlan }
  | { readonly ok: false; readonly reason: string };

/** Options for `vectorize`. `voices` (the polyphonic batch the caller declares — a
 *  runtime/calling-convention choice, NOT in the IR, like `maxBlock`) selects the
 *  `"simd-voice"` path for a stateful kernel when `voices ≥ W && voices % W === 0`.
 *  Default 1 ⇒ the single-voice `"scalar"` path (a stateful kernel) or `"simd-time"`
 *  (a stateless one) — byte-identical to pre-Stage-4. */
export interface VectorizeOptions {
  readonly voices?: number;
}

export function vectorize(ir: IrKernel, exportName = "kernel", opts: VectorizeOptions = {}): VectorizeResult {
  const W = LANES[ir.width];

  // Emittability: every store contiguous; every load contiguous (v1). Holds for
  // stateful kernels too — the scalar emitter still only produces stride-1 access;
  // statefulness lifts the SIMD assumption, not the affine-shape one.
  for (const store of ir.stores) {
    if (store.stride !== 1) {
      return { ok: false, reason: `stride-${store.stride} store not emitted in v1 (contiguous stores only)` };
    }
    const bad = firstNonContiguousLoad(store.value);
    if (bad) return { ok: false, reason: `stride-${bad}-not-emitted` };
  }
  for (const ss of ir.stateStores ?? []) {
    const bad = firstNonContiguousLoad(ss.value);
    if (bad) return { ok: false, reason: `stride-${bad}-not-emitted` };
  }
  for (const bs of ir.stateBufferStores ?? []) {
    const bad = firstNonContiguousLoad(bs.value);
    if (bad) return { ok: false, reason: `stride-${bad}-not-emitted` };
  }

  // Collect arrays/scalars in signature order (deterministic).
  const arrays: PlanArrayRef[] = [];
  for (const p of ir.signature.params) {
    if (p.role === "input") arrays.push({ name: p.name, role: "input" });
    else if (p.role === "output") arrays.push({ name: p.name, role: "output" });
  }
  const scalars = ir.signature.params.filter((p) => p.role === "scalar").map((p) => p.name);

  // Pick the lowering mode. A stateless kernel always takes the (unchanged) time-axis
  // SIMD path. A stateful kernel takes the NEW voice-axis SIMD path iff the caller
  // declared a power-of-W-aligned batch of ≥ W voices (the consumer enforces the same
  // `voices % W === 0`); otherwise the single-voice scalar fallback (Stages 1–3).
  const voices = opts.voices ?? 1;
  const stateful = isStateful(ir);
  const mode: VectorizeMode = !stateful
    ? "simd-time"
    : (voices >= W && voices % W === 0 ? "simd-voice" : "scalar");

  return { ok: true, plan: { width: ir.width, laneWidth: W, arrays, scalars, exportName, mode, scalarOnly: mode !== "simd-time" } };
}

/** Returns the stride of the first non-contiguous (stride ≠ 1) load, or null. */
function firstNonContiguousLoad(node: IrNode): number | null {
  switch (node.kind) {
    case "load": return node.stride !== 1 ? node.stride : null;
    case "unary": return firstNonContiguousLoad(node.a);
    case "binary": return firstNonContiguousLoad(node.a) ?? firstNonContiguousLoad(node.b);
    default: return null;
  }
}
