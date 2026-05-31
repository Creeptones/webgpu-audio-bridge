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

export interface VectorizedKernelPlan {
  readonly width: LaneWidth;
  readonly laneWidth: number; // W
  readonly arrays: ReadonlyArray<PlanArrayRef>; // distinct arrays, signature order
  readonly scalars: ReadonlyArray<string>; // distinct scalar params, signature order
  readonly exportName: string;
  /** True ⇒ the kernel carries a loop-carried state recurrence (Frontier 7), so it
   *  is SUPPORTED but NOT time-axis vectorized: `compileIr` emits only the scalar
   *  module (as both reference and deliverable) and the gate proves scalar ≡
   *  reference. False ⇒ the normal stateless SIMD path (unchanged, bit-for-bit). */
  readonly scalarOnly: boolean;
}

export type VectorizeResult =
  | { readonly ok: true; readonly plan: VectorizedKernelPlan }
  | { readonly ok: false; readonly reason: string };

export function vectorize(ir: IrKernel, exportName = "kernel"): VectorizeResult {
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

  return { ok: true, plan: { width: ir.width, laneWidth: W, arrays, scalars, exportName, scalarOnly: isStateful(ir) } };
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
