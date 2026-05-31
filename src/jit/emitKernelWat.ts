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
  ELEM_BYTES, LANES, lengthParamName, kernelKey, isStateful, stateLayout,
} from "./ir.js";

/** WASM local name for a state register's current (pre-commit) value. */
function stLocal(name: string): string { return `$__st_${name}`; }
/** WASM local name for a state register's next (to-commit) value. */
function nextLocal(name: string): string { return `$__next_${name}`; }
/** WASM i32 local holding a delay buffer's live write cursor (Stage 3). */
function curLocal(name: string): string { return `$__cur_${name}`; }
/** Byte offset of register `name` within the `$state` slab (via `stateLayout`,
 *  the single source of truth — registers occupy the slab prefix). */
function stateOffset(ir: IrKernel, name: string): number {
  const r = stateLayout(ir).regs.find((x) => x.name === name);
  return (r ? r.offset : 0) * ELEM_BYTES[ir.width];
}
/** The slab descriptor for a delay buffer (ring start + cursor element offsets). */
function bufferInfo(ir: IrKernel, name: string): { byteBase: number; cursorByte: number; length: number } {
  const eb = ELEM_BYTES[ir.width];
  const b = stateLayout(ir).buffers.find((x) => x.name === name)!;
  return { byteBase: b.offset * eb, cursorByte: b.cursorOffset * eb, length: b.length };
}

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
  // The state slab base pointer (Frontier 7) — appended after the arrays, before the
  // scalars, ONLY for a stateful kernel, so a stateless layout (and its emitted SIMD
  // bytes) are byte-identical to pre-statefulness.
  if (isStateful(ir)) params.push({ name: "__state", wasm: "i32" });
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
    case "readState": return `(local.get ${stLocal(node.name)})`;
    case "readDelay": return `(${t}.load ${delayReadAddr(node.buffer, node.delay, ir)})`;
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
    // A stateful kernel is scalar-only (vectorize → scalarOnly), so emitSimdModule is
    // never called for one; this arm is unreachable and guards the (NR) invariant.
    case "readState": throw new Error("emitVector: readState has no SIMD lowering (stateful kernels are scalar-only)");
    case "readDelay": throw new Error("emitVector: readDelay has no SIMD lowering (delay-line kernels are scalar-only)");
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

/** Byte address of `buffer[(w − delay + L) mod L]` in the state slab, where `w` is the
 *  buffer's live cursor i32 local. `(w − delay + L)` is in `[0, 2L)`, so `i32.rem_u`
 *  by `L` lands non-negative in `[0, L)`. (delay ≥ 1, so this never aliases slot `w`.) */
function delayReadAddr(buffer: string, delay: number, ir: IrKernel): string {
  const eb = ELEM_BYTES[ir.width];
  const { byteBase, length } = bufferInfo(ir, buffer);
  const w = curLocal(buffer);
  const ring = `(i32.rem_u (i32.add (i32.sub (local.get ${w}) (i32.const ${delay})) (i32.const ${length})) (i32.const ${length}))`;
  return `(i32.add (local.get $__state) (i32.add (i32.const ${byteBase}) (i32.mul ${ring} (i32.const ${eb}))))`;
}

/** Byte address of the slot the buffer's cursor `w` currently points at (the
 *  `writeDelay` target — written AFTER all reads, before the cursor advances). */
function delayWriteAddr(buffer: string, ir: IrKernel): string {
  const eb = ELEM_BYTES[ir.width];
  const { byteBase } = bufferInfo(ir, buffer);
  const w = curLocal(buffer);
  return `(i32.add (local.get $__state) (i32.add (i32.const ${byteBase}) (i32.mul (local.get ${w}) (i32.const ${eb}))))`;
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

/** Scalar reference module: one straight loop in single-lane ops. For a stateful
 *  kernel (Frontier 7) it threads the state registers — load the slab into locals
 *  before the loop, read them (`readState` → `local.get`) and compute each register's
 *  next value into a `$__next_*` local inside the loop, COMMIT all next-values at the
 *  END of the iteration body (so every read in the iteration saw the pre-commit value
 *  — the SIMULTANEOUS semantics, docs/frontier7-statefulness-semantics.md §2.2), and
 *  store the locals back to the slab after the loop. A stateless kernel emits exactly
 *  as before (no state preamble/commit/epilogue). */
export function emitScalarModule(ir: IrKernel, exportName = "kernel"): string {
  const trip = tripName(ir);
  const t = ir.width;
  const decls = ir.stateDecls ?? [];
  const stateStores = ir.stateStores ?? [];
  const buffers = ir.stateBuffers ?? [];
  const bufferStores = ir.stateBufferStores ?? [];
  const cvt = ir.width === "f32" ? "f32" : "f64"; // i32.trunc_<cvt>_s / <cvt>.convert_i32_s

  // Per-register locals: $__st_* (current) + $__next_* (to-commit, only if written);
  // per-buffer: a single i32 cursor local $__cur_* (Stage 3 — a buffer needs NO
  // deferral temp: it writes directly to buf[w] after the reads, then w advances).
  const written = new Set(stateStores.map((ss) => ss.name));
  const regLocals = decls
    .map((d) => `    (local ${stLocal(d.name)} ${t})` + (written.has(d.name) ? `\n    (local ${nextLocal(d.name)} ${t})` : ""));
  const cursorLocals = buffers.map((b) => `    (local ${curLocal(b.name)} i32)`);
  const stateLocals = [...regLocals, ...cursorLocals].join("\n");

  // Preamble: load each register into its $__st_* local; truncate each buffer's
  // (float-in-slab) cursor into its $__cur_* i32 local.
  const regPreamble = decls
    .map((d) => `    (local.set ${stLocal(d.name)} (${t}.load (i32.add (local.get $__state) (i32.const ${stateOffset(ir, d.name)}))))`);
  const cursorPreamble = buffers.map((b) => {
    const { cursorByte } = bufferInfo(ir, b.name);
    return `    (local.set ${curLocal(b.name)} (i32.trunc_${cvt}_s (${t}.load (i32.add (local.get $__state) (i32.const ${cursorByte})))))`;
  });
  const statePreamble = [...regPreamble, ...cursorPreamble].join("\n");

  // In-loop body (SIMULTANEOUS — all reads see pre-iteration state):
  //   1 output stores · 2 register next-values · 3 buffer writes (direct to buf[w],
  //   reading pre-commit registers + w−d slots) · 4 commit registers · 5 advance cursors.
  const outStores = ir.stores.map((s) => "        " + storeScalar(s, ir)).join("\n");
  const computeNext = stateStores
    .map((ss) => `        (local.set ${nextLocal(ss.name)} ${emitScalar(ss.value, ir)})`)
    .join("\n");
  const bufferWrites = bufferStores
    .map((bs) => `        (${t}.store ${delayWriteAddr(bs.buffer, ir)} ${emitScalar(bs.value, ir)})`)
    .join("\n");
  const commitNext = stateStores
    .map((ss) => `        (local.set ${stLocal(ss.name)} (local.get ${nextLocal(ss.name)}))`)
    .join("\n");
  const advanceCursors = buffers
    .map((b) => `        (local.set ${curLocal(b.name)} (i32.rem_u (i32.add (local.get ${curLocal(b.name)}) (i32.const 1)) (i32.const ${b.length})))`)
    .join("\n");
  const loopBody = [outStores, computeNext, bufferWrites, commitNext, advanceCursors].filter((x) => x.length > 0).join("\n");

  // Epilogue: store registers back, and each cursor back as a width-typed float.
  const regEpilogue = decls
    .map((d) => `    (${t}.store (i32.add (local.get $__state) (i32.const ${stateOffset(ir, d.name)})) (local.get ${stLocal(d.name)}))`);
  const cursorEpilogue = buffers.map((b) => {
    const { cursorByte } = bufferInfo(ir, b.name);
    return `    (${t}.store (i32.add (local.get $__state) (i32.const ${cursorByte})) (${cvt}.convert_i32_s (local.get ${curLocal(b.name)})))`;
  });
  const stateEpilogue = [...regEpilogue, ...cursorEpilogue].join("\n");

  const localDecls = stateLocals.length > 0 ? `\n${stateLocals}` : "";
  const preamble = statePreamble.length > 0 ? `\n${statePreamble}` : "";
  const epilogue = stateEpilogue.length > 0 ? `\n${stateEpilogue}` : "";

  return `${banner(ir, "scalar")}
(module
  (import "env" "memory" (memory ${PAGES.min} ${PAGES.max} shared))
  (func $${exportName} (export "${exportName}") ${paramDecls(ir)}
    (local $i i32)${localDecls}${preamble}
    (local.set $i (i32.const 0))
    (block $tailExit
      (loop $tailLoop
        (br_if $tailExit (i32.ge_s (local.get $i) (local.get $${trip})))
${loopBody}
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $tailLoop)
      )
    )${epilogue}
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
