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

// ── voice-axis SIMD (Apollo Frontier 7, Stage 4) ─────────────────────────────
//
// A STATEFUL kernel cannot be vectorized along TIME (the recurrence wall), but
// polyphony hands us `V` INDEPENDENT voices, each running the SAME kernel with its
// OWN state + its OWN per-voice scalars. Independent recurrences ARE vectorizable:
// pack W voices into one v128 (lane j = voice j), run the sequential time loop ONCE,
// and every iteration advances all W recurrences lock-step lane-parallel. The
// recurrence stays sequential WITHIN a lane; it goes parallel ACROSS lanes. Sound
// because no IrNode can reference another voice ⇒ lane j is bit-for-bit a scalar run
// of voice j (so the gate is bit-exact even for f32 — stronger than the time path).
//
// LAYOUT — VOICE-INTERLEAVED (voice is the fast axis), so one v128.load gathers a
// lane group:
//   • inputs/outputs : x[i·W + j]            → v128.load (base + i·W·eb)
//   • per-voice scalars: lane-packed $__scalars slab, scalar s at element s·W (+j),
//     loaded ONCE before the loop into a v128 local (loop-invariant per voice).
//   • state slab     : every `stateLayout` element offset · W. register r → v128 at
//     (regOffset·W)·eb; ring slot k of buffer b → (b.offset+k)·W·eb; the cursor is a
//     SCALAR float at (cursorOffset·W)·eb — ONE shared i32 for the whole lane group
//     (all W voices share the time loop ⇒ are time-aligned ⇒ share the write cursor;
//     the §2 shared-cursor insight, the analogue of Stage 3's d ≥ 1).
//
// `stateLayout` is NOT changed (it stays the per-voice element map); the ·W fold lives
// ONLY here (and in the voice consumer), so the single-voice scalar path + the
// stateless SIMD path stay byte-identical (the frontier gate). The deferral temps, the
// commit-at-iteration-end, and the advance-cursor-at-end ordering are IDENTICAL to the
// scalar module — just v128 instead of scalar — so the SIMULTANEOUS semantics fall out
// per-lane exactly as they do per-sample.

/** WASM v128 local holding a scalar's per-voice values (loaded once before the loop). */
function scLocal(name: string): string { return `$__sc_${name}`; }

/** Lane-packed byte offset of register `name` (regOffset·W elements into the slab). */
function voiceStateOffset(ir: IrKernel, name: string, W: number): number {
  const r = stateLayout(ir).regs.find((x) => x.name === name);
  return (r ? r.offset : 0) * W * ELEM_BYTES[ir.width];
}
/** Lane-packed slab descriptor for a delay buffer: the ring base byte, the (scalar,
 *  lane-0) cursor byte, the ring length, and the per-time-step lane stride (W·eb). */
function voiceBufferInfo(ir: IrKernel, name: string, W: number): { byteBase: number; cursorByte: number; length: number; laneStride: number } {
  const eb = ELEM_BYTES[ir.width];
  const b = stateLayout(ir).buffers.find((x) => x.name === name)!;
  return { byteBase: b.offset * W * eb, cursorByte: b.cursorOffset * W * eb, length: b.length, laneStride: W * eb };
}

/** byte address of the v128 lane group at (i + intercept) in voice-interleaved array
 *  `name` — element (i+intercept)·W, byte ·eb (loads the W voices at that time). */
function voiceAddr(name: string, intercept: number, ir: IrKernel, W: number): string {
  const eb = ELEM_BYTES[ir.width];
  const elem = intercept === 0
    ? `(i32.mul (local.get $i) (i32.const ${W}))`
    : `(i32.mul (i32.add (local.get $i) (i32.const ${intercept})) (i32.const ${W}))`;
  return `(i32.add (local.get $${name}) (i32.mul ${elem} (i32.const ${eb})))`;
}

/** byte address of the lane group `buffer[(w − delay + L) mod L]` in the lane-packed
 *  ring — the shared i32 cursor `w`, lane stride W·eb (delay ≥ 1 ⇒ never aliases w). */
function voiceDelayReadAddr(buffer: string, delay: number, ir: IrKernel, W: number): string {
  const { byteBase, length, laneStride } = voiceBufferInfo(ir, buffer, W);
  const w = curLocal(buffer);
  const ring = `(i32.rem_u (i32.add (i32.sub (local.get ${w}) (i32.const ${delay})) (i32.const ${length})) (i32.const ${length}))`;
  return `(i32.add (local.get $__state) (i32.add (i32.const ${byteBase}) (i32.mul ${ring} (i32.const ${laneStride}))))`;
}
/** byte address of the lane group at the buffer cursor `w` (the writeDelay target). */
function voiceDelayWriteAddr(buffer: string, ir: IrKernel, W: number): string {
  const { byteBase, laneStride } = voiceBufferInfo(ir, buffer, W);
  const w = curLocal(buffer);
  return `(i32.add (local.get $__state) (i32.add (i32.const ${byteBase}) (i32.mul (local.get ${w}) (i32.const ${laneStride}))))`;
}

/** Voice-SIMD WASM export param order: trip (i32) → arrays (i32 base, signature order)
 *  → $__state (i32) → $__scalars (i32, only when the kernel has scalar params). The one
 *  ABI difference from `paramLayout`: scalars become a LANE-PACKED slab POINTER (each
 *  voice its own value), not f32/f64 value args. (The voice path is stateful-only, so
 *  $__state is always present.) */
export function voiceParamLayout(ir: IrKernel): WasmParam[] {
  const params: WasmParam[] = [{ name: tripName(ir), wasm: "i32" }];
  for (const p of ir.signature.params) {
    if (p.role === "input" || p.role === "output") params.push({ name: p.name, wasm: "i32" });
  }
  params.push({ name: "__state", wasm: "i32" });
  if (ir.signature.params.some((p) => p.role === "scalar")) params.push({ name: "__scalars", wasm: "i32" });
  return params;
}
function voiceParamDecls(ir: IrKernel): string {
  return voiceParamLayout(ir).map((p) => `(param $${p.name} ${p.wasm})`).join(" ");
}

/** vector expression → WAT that pushes one v128, with VOICE-interleaved leaf addressing
 *  (the only difference from `emitVector`: leaves read the W voices at time `i` rather
 *  than W times of one voice). Arithmetic is the layout-agnostic f{32x4,64x2}.* op. */
function emitVoice(node: IrNode, ir: IrKernel, W: number): string {
  const v = ir.width === "f32" ? "f32x4" : "f64x2";
  const t = ir.width;
  switch (node.kind) {
    case "const": return `(${v}.splat (${t}.const ${fmtNum(node.value)}))`;
    case "scalar": return `(local.get ${scLocal(node.name)})`;
    case "load": return `(v128.load ${voiceAddr(node.array, node.intercept, ir, W)})`;
    case "readState": return `(local.get ${stLocal(node.name)})`;
    case "readDelay": return `(v128.load ${voiceDelayReadAddr(node.buffer, node.delay, ir, W)})`;
    case "unary": return `(${v}.${unaryOp(node.op)} ${emitVoice(node.a, ir, W)})`;
    case "binary": return `(${v}.${node.op} ${emitVoice(node.a, ir, W)} ${emitVoice(node.b, ir, W)})`;
  }
}

function voiceBanner(ir: IrKernel, W: number): string {
  return [
    `;; ── GENERATED by emitKernelWat (voice-simd) — DO NOT EDIT ───────────`,
    `;; Apollo Frontier 7 — SIMD across voices. width=${ir.width} voicesPerBatch=${W}`,
    `;; kernel fingerprint: ${kernelKey(ir)}`,
  ].join("\n");
}

/**
 * Voice-SIMD candidate module (Apollo Frontier 7, Stage 4): one straight time loop
 * (`i` strides by 1, like the scalar module — the recurrence is sequential) whose every
 * leaf is a v128 reading W voices at once. Stateful-only; `W` voices per batch. The
 * register deferral / commit-at-end / advance-cursor-at-end ordering mirrors
 * `emitScalarModule` exactly — the SIMULTANEOUS semantics hold per-lane as per-sample.
 */
export function emitVoiceSimdModule(ir: IrKernel, W: number, exportName = "kernel"): string {
  if (!isStateful(ir)) throw new Error("emitVoiceSimdModule: voice-SIMD is for stateful kernels only");
  const trip = tripName(ir);
  const t = ir.width;
  const eb = ELEM_BYTES[ir.width];
  const cvt = ir.width === "f32" ? "f32" : "f64"; // i32.trunc_<cvt>_s / <cvt>.convert_i32_s
  const decls = ir.stateDecls ?? [];
  const stateStores = ir.stateStores ?? [];
  const buffers = ir.stateBuffers ?? [];
  const bufferStores = ir.stateBufferStores ?? [];
  const scalars = ir.signature.params.filter((p) => p.role === "scalar").map((p) => p.name);

  // Locals: per-register $__st_* (v128 current) + $__next_* (v128 to-commit, if
  // written); per-buffer the shared i32 cursor $__cur_*; per-scalar $__sc_* (v128).
  const written = new Set(stateStores.map((ss) => ss.name));
  const regLocals = decls
    .map((d) => `    (local ${stLocal(d.name)} v128)` + (written.has(d.name) ? `\n    (local ${nextLocal(d.name)} v128)` : ""));
  const cursorLocals = buffers.map((b) => `    (local ${curLocal(b.name)} i32)`);
  const scalarLocals = scalars.map((s) => `    (local ${scLocal(s)} v128)`);
  const allLocals = [...regLocals, ...cursorLocals, ...scalarLocals].join("\n");

  // Preamble: load the per-voice scalar lane groups + each register lane group; truncate
  // each buffer's (scalar, lane-0) cursor into its $__cur_* i32 local.
  const scalarPreamble = scalars
    .map((s, k) => `    (local.set ${scLocal(s)} (v128.load (i32.add (local.get $__scalars) (i32.const ${k * W * eb}))))`);
  const regPreamble = decls
    .map((d) => `    (local.set ${stLocal(d.name)} (v128.load (i32.add (local.get $__state) (i32.const ${voiceStateOffset(ir, d.name, W)}))))`);
  const cursorPreamble = buffers.map((b) => {
    const { cursorByte } = voiceBufferInfo(ir, b.name, W);
    return `    (local.set ${curLocal(b.name)} (i32.trunc_${cvt}_s (${t}.load (i32.add (local.get $__state) (i32.const ${cursorByte})))))`;
  });
  const preamble = [...scalarPreamble, ...regPreamble, ...cursorPreamble].join("\n");

  // In-loop body (SIMULTANEOUS, per-lane): output stores · register next-values · buffer
  // writes (direct to buf[w]) · commit registers · advance cursors.
  const outStores = ir.stores
    .map((s) => `        (v128.store ${voiceAddr(s.array, s.intercept, ir, W)} ${emitVoice(s.value, ir, W)})`).join("\n");
  const computeNext = stateStores
    .map((ss) => `        (local.set ${nextLocal(ss.name)} ${emitVoice(ss.value, ir, W)})`).join("\n");
  const bufferWrites = bufferStores
    .map((bs) => `        (v128.store ${voiceDelayWriteAddr(bs.buffer, ir, W)} ${emitVoice(bs.value, ir, W)})`).join("\n");
  const commitNext = stateStores
    .map((ss) => `        (local.set ${stLocal(ss.name)} (local.get ${nextLocal(ss.name)}))`).join("\n");
  const advanceCursors = buffers
    .map((b) => `        (local.set ${curLocal(b.name)} (i32.rem_u (i32.add (local.get ${curLocal(b.name)}) (i32.const 1)) (i32.const ${b.length})))`).join("\n");
  const loopBody = [outStores, computeNext, bufferWrites, commitNext, advanceCursors].filter((x) => x.length > 0).join("\n");

  // Epilogue: store register lane groups back; store each cursor back as a (lane-0)
  // width-typed float.
  const regEpilogue = decls
    .map((d) => `    (v128.store (i32.add (local.get $__state) (i32.const ${voiceStateOffset(ir, d.name, W)})) (local.get ${stLocal(d.name)}))`);
  const cursorEpilogue = buffers.map((b) => {
    const { cursorByte } = voiceBufferInfo(ir, b.name, W);
    return `    (${t}.store (i32.add (local.get $__state) (i32.const ${cursorByte})) (${cvt}.convert_i32_s (local.get ${curLocal(b.name)})))`;
  });
  const epilogue = [...regEpilogue, ...cursorEpilogue].join("\n");

  const localDecls = allLocals.length > 0 ? `\n${allLocals}` : "";
  const pre = preamble.length > 0 ? `\n${preamble}` : "";
  const epi = epilogue.length > 0 ? `\n${epilogue}` : "";

  return `${voiceBanner(ir, W)}
(module
  (import "env" "memory" (memory ${PAGES.min} ${PAGES.max} shared))
  (func $${exportName} (export "${exportName}") ${voiceParamDecls(ir)}
    (local $i i32)${localDecls}${pre}
    (local.set $i (i32.const 0))
    (block $exit
      (loop $loop
        (br_if $exit (i32.ge_s (local.get $i) (local.get $${trip})))
${loopBody}
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )${epi}
  )
)`;
}

export { ELEM_BYTES, LANES };
export type { LaneWidth, BinaryOp };
