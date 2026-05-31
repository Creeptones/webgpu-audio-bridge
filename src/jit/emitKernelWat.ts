/**
 * JIT WAT emitter — IR → WebAssembly Text (Apollo Frontier 5, Stage 1a).
 *
 * Mirrors `emitWasmDecoder.ts`: a monomorphized SOURCE STRING with offsets/
 * strides folded to `i32.const` literals, behind a "GENERATED — DO NOT EDIT"
 * banner that fingerprints the kernel. Imports `env.memory` as a `shared`
 * memory (the SAB-as-memory contract) and exports one `kernel` function.
 *
 * Two emitters from the SAME IR (the tree-shape-preserving (NR) lowering):
 *   emitScalarModule — single-lane f{32,64}.* ops, one straight loop. The gate's
 *                      compiled scalar REFERENCE (the ground truth `S`).
 *   emitSimdModule   — packed f{32x4,64x2}.* ops in a W-lane body + a SCALAR
 *                      EPILOGUE for the n%W tail (the simdEnd/tailEnd partition).
 *                      The candidate that must equal the reference lane-wise.
 *
 * NEVER emits a fused / `relaxed_*` opcode (the (NF) invariant — the FMA
 * finding). Both modules share the canonical WASM param layout from
 * `paramLayout` so the gate can call either with the same arguments.
 *
 * v1 supports CONTIGUOUS (stride-1) loads/stores only; `vectorize.ts` rejects
 * anything else as `unsupported` before this emitter runs, so every load/store
 * reached here has stride 1.
 */

import {
  type IrKernel, type IrNode, type IrStore, type LaneWidth, type UnaryOp, type BinaryOp,
  ELEM_BYTES, LANES, lengthParamName, kernelKey,
} from "./ir.js";

export interface WasmParam {
  readonly name: string;
  readonly wasm: "i32" | "f32" | "f64";
}

/** Canonical WASM export param order, shared by both modules and the gate:
 *  trip count (i32) → arrays (i32 base offsets, signature order) → scalars
 *  (width type, signature order). The trip count reuses the length-param name
 *  when present, else `__trip`. */
export function paramLayout(ir: IrKernel): WasmParam[] {
  const w = ir.width;
  const trip = lengthParamName(ir.signature) ?? "__trip";
  const params: WasmParam[] = [{ name: trip, wasm: "i32" }];
  for (const p of ir.signature.params) {
    if (p.role === "input" || p.role === "output") params.push({ name: p.name, wasm: "i32" });
  }
  for (const p of ir.signature.params) {
    if (p.role === "scalar") params.push({ name: p.name, wasm: w });
  }
  return params;
}

function tripName(ir: IrKernel): string {
  return lengthParamName(ir.signature) ?? "__trip";
}

// ── number formatting (shortest round-trip decimal; wabt parses it exactly) ──
function fmtNum(v: number): string {
  // Source literals are finite & non-negative (neg is a unary node). Integers
  // print exactly; others use the shortest round-trip decimal.
  return Number.isInteger(v) ? v.toFixed(1) : v.toString();
}

// ── scalar expression → WAT that pushes one f32/f64 ──────────────────────────
function emitScalar(node: IrNode, ir: IrKernel): string {
  const t = ir.width; // "f32" | "f64"
  switch (node.kind) {
    case "const": return `(${t}.const ${fmtNum(node.value)})`;
    case "scalar": return `(local.get $${node.name})`;
    case "load": return `(${t}.load ${addr(node.array, node.stride, node.intercept, ir)})`;
    case "unary": return `(${t}.${unaryOp(node.op)} ${emitScalar(node.a, ir)})`;
    case "binary": return `(${t}.${node.op} ${emitScalar(node.a, ir)} ${emitScalar(node.b, ir)})`;
  }
}

// ── vector expression → WAT that pushes one v128 ─────────────────────────────
function emitVector(node: IrNode, ir: IrKernel): string {
  const v = ir.width === "f32" ? "f32x4" : "f64x2";
  const t = ir.width;
  switch (node.kind) {
    case "const": return `(${v}.splat (${t}.const ${fmtNum(node.value)}))`;
    case "scalar": return `(${v}.splat (local.get $${node.name}))`;
    case "load": return `(v128.load ${addr(node.array, node.stride, node.intercept, ir)})`;
    case "unary": return `(${v}.${unaryOp(node.op)} ${emitVector(node.a, ir)})`;
    case "binary": return `(${v}.${node.op} ${emitVector(node.a, ir)} ${emitVector(node.b, ir)})`;
  }
}

function unaryOp(op: UnaryOp): string {
  return op; // neg/abs/sqrt/floor/ceil/trunc are the literal opcode suffixes
}

/** byte address of element (stride*i + intercept) in array `name` (stride is 1 here). */
function addr(name: string, stride: number, intercept: number, ir: IrKernel): string {
  const eb = ELEM_BYTES[ir.width];
  // element index expression (stride is 1 in v1)
  const elem = intercept === 0
    ? `(local.get $i)`
    : `(i32.add (local.get $i) (i32.const ${intercept}))`;
  void stride;
  return `(i32.add (local.get $${name}) (i32.mul ${elem} (i32.const ${eb})))`;
}

function storeScalar(s: IrStore, ir: IrKernel): string {
  return `(${ir.width}.store ${addr(s.array, s.stride, s.intercept, ir)} ${emitScalar(s.value, ir)})`;
}
function storeVector(s: IrStore, ir: IrKernel): string {
  return `(v128.store ${addr(s.array, s.stride, s.intercept, ir)} ${emitVector(s.value, ir)})`;
}

function paramDecls(ir: IrKernel): string {
  return paramLayout(ir).map((p) => `(param $${p.name} ${p.wasm})`).join(" ");
}

function banner(ir: IrKernel, mode: "scalar" | "simd"): string {
  const W = LANES[ir.width];
  return [
    `;; ── GENERATED by emitKernelWat (${mode}) — DO NOT EDIT ──────────────`,
    `;; Apollo Frontier 5 — The Autonomous JIT. width=${ir.width} laneWidth=${mode === "simd" ? W : 1}`,
    `;; kernel fingerprint: ${kernelKey(ir)}`,
  ].join("\n");
}

const PAGES = { min: 1, max: 16384 };

/** Scalar reference module: one straight loop in single-lane ops. */
export function emitScalarModule(ir: IrKernel, exportName = "kernel"): string {
  const trip = tripName(ir);
  const body = ir.stores.map((s) => "        " + storeScalar(s, ir)).join("\n");
  return `${banner(ir, "scalar")}
(module
  (import "env" "memory" (memory ${PAGES.min} ${PAGES.max} shared))
  (func $${exportName} (export "${exportName}") ${paramDecls(ir)}
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $tailExit
      (loop $tailLoop
        (br_if $tailExit (i32.ge_s (local.get $i) (local.get $${trip})))
${body}
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $tailLoop)
      )
    )
  )
)`;
}

/** SIMD candidate module: W-lane body over [0, trip & ~(W-1)) + scalar tail. */
export function emitSimdModule(ir: IrKernel, exportName = "kernel"): string {
  const trip = tripName(ir);
  const W = LANES[ir.width];
  const mask = (~(W - 1)) | 0; // -2 (W=2) / -4 (W=4)
  const vbody = ir.stores.map((s) => "        " + storeVector(s, ir)).join("\n");
  const sbody = ir.stores.map((s) => "        " + storeScalar(s, ir)).join("\n");
  return `${banner(ir, "simd")}
(module
  (import "env" "memory" (memory ${PAGES.min} ${PAGES.max} shared))
  (func $${exportName} (export "${exportName}") ${paramDecls(ir)}
    (local $i i32)
    (local $simdEnd i32)
    (local.set $simdEnd (i32.and (local.get $${trip}) (i32.const ${mask})))
    (local.set $i (i32.const 0))
    (block $simdExit
      (loop $simdLoop
        (br_if $simdExit (i32.ge_s (local.get $i) (local.get $simdEnd)))
${vbody}
        (local.set $i (i32.add (local.get $i) (i32.const ${W})))
        (br $simdLoop)
      )
    )
    (block $tailExit
      (loop $tailLoop
        (br_if $tailExit (i32.ge_s (local.get $i) (local.get $${trip})))
${sbody}
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $tailLoop)
      )
    )
  )
)`;
}

export { ELEM_BYTES, LANES };
export type { LaneWidth, BinaryOp };
