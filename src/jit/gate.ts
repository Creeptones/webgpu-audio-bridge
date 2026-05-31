/**
 * JIT equivalence gate — the load-bearing safety (Apollo Frontier 5, Stage 1a).
 *
 * The compiler is a CANDIDATE GENERATOR; THIS is the component that makes a
 * generated kernel safe to run. No SIMD kernel is ever returned as `accepted`
 * unless it agrees with a scalar reference — compiled from the SAME IR — on the
 * whole fuzz corpus, BIT-EXACTLY for f64 and within a declared ULP budget for
 * f32 (and, for the v1 op-set, bit-exactly for f32 too). A third oracle, the
 * user's own JS function, is cross-checked on finite inputs to catch a faulty
 * LOWERING (the scalar WASM disagreeing with the source) vs a faulty
 * VECTORIZATION (the SIMD disagreeing with the scalar).
 *
 * This is the mechanism that makes an UNTRUSTED candidate generator (a future
 * SLM) safe: it plugs in before the gate and changes nothing about the contract.
 * The gate's own correctness is pinned by negative tests — a deliberately-wrong
 * candidate MUST be rejected (the Stage-0 probe's SCENARIO B/D, now in-CI).
 *
 * The module imports NO WASM compiler: `compileWat` is INJECTED (the same
 * boundary `emitWasmDecoder` documents). In tests/the build it is wabt; in the
 * browser worker it is wabt or a direct binary encoder.
 */

import { type IrKernel, type LaneWidth, ELEM_BYTES, LANES, signatureWidth, isStateful, stateLayout } from "./ir.js";
import { type CorpusCase } from "./corpus.js";
import { evalReference } from "./acousticGate.js";
import { hasWasmSimd } from "../worklet/wasmSimdSupport.js";

export type CompileWat = (wat: string, name?: string) => Uint8Array;

export type GateStatus = "accepted" | "rejected-gate" | "unsupported";

export interface GateMismatch {
  readonly kind: "simd-vs-scalar" | "scalar-vs-js" | "scalar-vs-ref" | "voice-vs-ref";
  readonly caseIndex: number;
  readonly n: number;
  readonly array: string;
  readonly index: number;
  readonly a: number; // reference value
  readonly b: number; // candidate value
  /** Voice-SIMD gate only (Frontier 7, Stage 4): the offending lane (voice) index. */
  readonly lane?: number;
}

export interface GateReport {
  readonly status: GateStatus;
  readonly casesChecked: number;
  readonly comparisons: number;
  readonly worstUlpF32: number;
  readonly mismatch?: GateMismatch;
  readonly reason?: string;
}

export interface GateInput {
  readonly ir: IrKernel;
  readonly scalarWat: string;
  readonly simdWat: string;
  readonly corpus: ReadonlyArray<CorpusCase>;
  readonly compileWat: CompileWat;
  /** The user's JS source (a function), used as the third oracle. Optional. */
  readonly jsSource?: string;
  /** f32 ULP budget (default 0 — v1 is bit-exact). */
  readonly maxUlpF32?: number;
  /** Stateful kernels (Frontier 7): there is no SIMD candidate (the recurrence is
   *  scalar-only), so the proof is the scalar WASM ≡ `evalReference(ir)` (the IR spec),
   *  not SIMD ≡ scalar. When set, `simdWat` is ignored and the JS oracle is N/A. */
  readonly scalarOnly?: boolean;
  /** Voice-SIMD kernels (Frontier 7, Stage 4): the candidate (`simdWat`) is the
   *  voice-axis module that packs W voices per v128. The proof is: lane `j` ≡
   *  `evalReference(ir, voice-j inputs/scalars, n)`, bit-exact, for every lane
   *  `j ∈ [0, W)`. When set, `runVoiceGate` runs (the scalar/SIMD/JS paths are N/A).
   *  Requires `voiceCorpora` — W per-voice corpora (distinct rows per voice so a
   *  lane-crossing bug surfaces). */
  readonly voiceMode?: boolean;
  /** W per-voice corpora for the voice gate (one per lane), all sharing the same
   *  n-values so case indices align across lanes. */
  readonly voiceCorpora?: ReadonlyArray<ReadonlyArray<CorpusCase>>;
}

const dvF64 = new DataView(new ArrayBuffer(8));
const dvF32 = new DataView(new ArrayBuffer(4));
function bitsF64(x: number): bigint { dvF64.setFloat64(0, x); return dvF64.getBigUint64(0); }
function bitsF32(x: number): number { dvF32.setFloat32(0, x); return dvF32.getUint32(0) >>> 0; }
function ulpF32(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) === Number.isNaN(b) ? 0 : Infinity;
  const order = (u: number) => (u & 0x80000000 ? (0x100000000 - u) >>> 0 : (u | 0x80000000) >>> 0);
  return Math.abs(order(bitsF32(a)) - order(bitsF32(b)));
}
function equalW(a: number, b: number, w: LaneWidth, maxUlp: number): boolean {
  if (w === "f64") return bitsF64(a) === bitsF64(b);
  if (maxUlp === 0) return bitsF32(a) === bitsF32(b);
  return ulpF32(a, b) <= maxUlp;
}

/** Tolerance for the JS THIRD-oracle cross-check (scalar-WASM vs the user's JS).
 *  This link is intentionally LOOSE for f32: JavaScript has no f32 arithmetic, so
 *  a naive f32 kernel computes intermediates in f64 and rounds only at the
 *  Float32Array store, whereas the WASM f32 path rounds every intermediate — they
 *  legitimately differ by a few ULP (which is exactly why the swap is a crossfade,
 *  not a hard switch). The oracle's job is to catch a GROSS lowering error (wrong
 *  op / wrong operand), not this rounding gap, so f32 uses a generous relative
 *  band. f64 JS == WASM f64 bit-for-bit (===, lenient only on ±0; NaN is skipped
 *  by the caller). */
function closeForOracle(a: number, b: number, w: LaneWidth): boolean {
  if (w === "f64") return a === b; // -0 === +0 is true; exact otherwise
  return Math.abs(a - b) <= 1.9e-6 * Math.max(1e-6, Math.abs(a)); // ≈ 16 f32-ULP relative
}

function typedCtor(w: LaneWidth): Float32ArrayConstructor | Float64ArrayConstructor {
  return w === "f32" ? Float32Array : Float64Array;
}
function roundW(v: number, w: LaneWidth): number { return w === "f32" ? Math.fround(v) : v; }

interface Layout {
  readonly offsets: Record<string, number>; // array name → byte offset
  readonly maxN: number;
  readonly pages: number;
  /** Byte offset of the state slab (Frontier 7), or -1 if the kernel is stateless. */
  readonly stateOffset: number;
}

function planLayout(ir: IrKernel, corpus: ReadonlyArray<CorpusCase>): Layout {
  const eb = ELEM_BYTES[ir.width];
  const maxN = Math.max(1, ...corpus.map((c) => c.n));
  const slot = align16(maxN * eb);
  const offsets: Record<string, number> = {};
  let cursor = 16; // leave the first 16 bytes unused (null-guard)
  for (const p of ir.signature.params) {
    if (p.role === "input" || p.role === "output") {
      offsets[p.name] = cursor;
      cursor += slot;
    }
  }
  // The state slab (Frontier 7): registers + delay-buffer rings + cursors, sized by
  // the single-source-of-truth `stateLayout`, after the arrays.
  let stateOffset = -1;
  const slab = stateLayout(ir);
  if (slab.elements > 0) {
    stateOffset = cursor;
    cursor += align16(slab.elements * eb);
  }
  const pages = Math.max(1, Math.ceil(cursor / 65536));
  return { offsets, maxN, pages, stateOffset };
}
function align16(n: number): number { return (n + 15) & ~15; }

/** Seed the state slab to the COLD start (matching `evalReference`): zero the whole
 *  region (buffer rings + cursors → 0), then write each register's declared init. Run
 *  per corpus case so the slab never carries the previous case's evolved state. */
function seedState(memory: WebAssembly.Memory, layout: Layout, ir: IrKernel, TA: Float32ArrayConstructor | Float64ArrayConstructor): void {
  const slab = stateLayout(ir);
  if (layout.stateOffset < 0 || slab.elements === 0) return;
  const view = new TA(memory.buffer, layout.stateOffset, slab.elements);
  view.fill(0);
  for (const r of slab.regs) view[r.offset] = r.init;
}

function instantiate(bytes: Uint8Array, memory: WebAssembly.Memory): WebAssembly.Instance {
  // Copy into a fresh ArrayBuffer-backed view: `compileWat` may hand back a
  // SharedArrayBuffer-backed Uint8Array, which the WebAssembly.Module ctor type
  // (BufferSource over ArrayBuffer) does not accept.
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  const mod = new WebAssembly.Module(buf);
  return new WebAssembly.Instance(mod, { env: { memory } });
}

/** Build the positional argument list for a kernel export call from a case. */
function callArgs(ir: IrKernel, layout: Layout, c: CorpusCase, w: LaneWidth): number[] {
  const args: number[] = [c.n];
  for (const p of ir.signature.params) {
    if (p.role === "input" || p.role === "output") args.push(layout.offsets[p.name]!);
  }
  // The state slab base pointer (Frontier 7) — after the arrays, before the scalars,
  // matching `paramLayout`. Present only for a stateful kernel.
  if (isStateful(ir) && layout.stateOffset >= 0) args.push(layout.stateOffset);
  for (const p of ir.signature.params) {
    if (p.role === "scalar") args.push(roundW(c.scalars[p.name] ?? 0, w));
  }
  return args;
}

/** Run the equivalence gate. Synchronous (off the audio thread). */
export function runGate(input: GateInput): GateReport {
  const { ir, scalarWat, simdWat, corpus, compileWat } = input;
  const w = signatureWidth(ir.signature);
  const maxUlp = input.maxUlpF32 ?? 0;

  // Frontier 7, Stage 4: a voice-SIMD kernel proves lane j ≡ evalReference(voice j),
  // bit-exact for every lane. Distinct path from the time-axis SIMD vs scalar check.
  if (input.voiceMode) return runVoiceGate(input, w, maxUlp);

  // Frontier 7: a stateful (scalar-only) kernel has no SIMD candidate, so the proof is
  // scalar WASM ≡ evalReference(ir). No SIMD support needed; no JS oracle.
  if (input.scalarOnly) return runScalarOnlyGate(input, w, maxUlp);

  if (!hasWasmSimd()) {
    return { status: "unsupported", casesChecked: 0, comparisons: 0, worstUlpF32: 0, reason: "no-wasm-simd" };
  }

  let scalarInst: WebAssembly.Instance, simdInst: WebAssembly.Instance, memory: WebAssembly.Memory;
  const layout = planLayout(ir, corpus);
  try {
    memory = new WebAssembly.Memory({ initial: layout.pages, maximum: 16384, shared: true });
    scalarInst = instantiate(compileWat(scalarWat, "scalar"), memory);
    simdInst = instantiate(compileWat(simdWat, "simd"), memory);
  } catch (err) {
    return { status: "rejected-gate", casesChecked: 0, comparisons: 0, worstUlpF32: 0, reason: `instantiate-failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const scalarFn = scalarInst.exports["kernel"] as (...a: number[]) => void;
  const simdFn = simdInst.exports["kernel"] as (...a: number[]) => void;
  const TA = typedCtor(w);
  const outputs = ir.signature.params.filter((p) => p.role === "output").map((p) => p.name);
  const inputs = ir.signature.params.filter((p) => p.role === "input").map((p) => p.name);

  const jsFn = input.jsSource ? tryBuildJsFn(input.jsSource) : null;

  let comparisons = 0;
  let worstUlpF32 = 0;

  for (let ci = 0; ci < corpus.length; ci++) {
    const c = corpus[ci]!;
    // Write inputs into shared memory (rounds to width on store).
    for (const name of inputs) {
      const view = new TA(memory.buffer, layout.offsets[name]!, layout.maxN);
      const row = c.arrays[name]!;
      for (let i = 0; i < c.n; i++) view[i] = row[i]!;
    }
    const args = callArgs(ir, layout, c, w);

    // Run scalar reference, snapshot outputs.
    zeroOutputs(memory, layout, outputs, TA);
    scalarFn(...args);
    const ref: Record<string, number[]> = {};
    for (const name of outputs) ref[name] = readOut(memory, layout, name, c.n, TA);

    // Run SIMD candidate, compare.
    zeroOutputs(memory, layout, outputs, TA);
    simdFn(...args);
    for (const name of outputs) {
      const cand = readOut(memory, layout, name, c.n, TA);
      for (let i = 0; i < c.n; i++) {
        comparisons++;
        if (w === "f32") worstUlpF32 = Math.max(worstUlpF32, ulpF32(ref[name]![i]!, cand[i]!));
        if (!equalW(ref[name]![i]!, cand[i]!, w, maxUlp)) {
          return { status: "rejected-gate", casesChecked: ci + 1, comparisons, worstUlpF32,
            mismatch: { kind: "simd-vs-scalar", caseIndex: ci, n: c.n, array: name, index: i, a: ref[name]![i]!, b: cand[i]! } };
        }
      }
    }

    // Third oracle: the user's JS, on finite inputs only (Math.min/max diverge
    // from f*.min on NaN/-0 — that is a documented, expected gap, not a bug).
    if (jsFn) {
      const jsOut = runJsOracle(jsFn, ir, c, w, TA);
      if (jsOut) {
        for (const name of outputs) {
          for (let i = 0; i < c.n; i++) {
            const r = ref[name]![i]!, j = jsOut[name]![i]!;
            if (!Number.isFinite(r) || !Number.isFinite(j)) continue;
            if (!closeForOracle(r, j, w)) {
              return { status: "rejected-gate", casesChecked: ci + 1, comparisons, worstUlpF32,
                reason: "E_REF_MISMATCH",
                mismatch: { kind: "scalar-vs-js", caseIndex: ci, n: c.n, array: name, index: i, a: r, b: j } };
            }
          }
        }
      }
    }
  }

  return { status: "accepted", casesChecked: corpus.length, comparisons, worstUlpF32 };
}

/**
 * The scalar-only gate (Frontier 7): proves the deliverable SCALAR WASM equals
 * `evalReference(ir)` — the pure-JS IR interpreter that IS the spec — over the corpus,
 * with the state slab seeded to the declared inits and both sides evolving from that
 * cold state through the whole (long) run. There is no SIMD candidate and no JS oracle;
 * this is the safety for a stateful kernel, and a genuine strengthening (the scalar
 * itself is pinned to the spec, not merely trusted as the SIMD reference).
 */
function runScalarOnlyGate(input: GateInput, w: LaneWidth, maxUlp: number): GateReport {
  const { ir, scalarWat, corpus, compileWat } = input;
  const layout = planLayout(ir, corpus);
  let scalarInst: WebAssembly.Instance;
  let memory: WebAssembly.Memory;
  try {
    memory = new WebAssembly.Memory({ initial: layout.pages, maximum: 16384, shared: true });
    scalarInst = instantiate(compileWat(scalarWat, "scalar"), memory);
  } catch (err) {
    return { status: "rejected-gate", casesChecked: 0, comparisons: 0, worstUlpF32: 0, reason: `instantiate-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const scalarFn = scalarInst.exports["kernel"] as (...a: number[]) => void;
  const TA = typedCtor(w);
  const outputs = ir.signature.params.filter((p) => p.role === "output").map((p) => p.name);
  const inputs = ir.signature.params.filter((p) => p.role === "input").map((p) => p.name);

  let comparisons = 0;
  let worstUlpF32 = 0;

  for (let ci = 0; ci < corpus.length; ci++) {
    const c = corpus[ci]!;
    for (const name of inputs) {
      const view = new TA(memory.buffer, layout.offsets[name]!, layout.maxN);
      const row = c.arrays[name]!;
      for (let i = 0; i < c.n; i++) view[i] = row[i]!;
    }
    zeroOutputs(memory, layout, outputs, TA);
    seedState(memory, layout, ir, TA); // cold start = declared inits, matching evalReference
    scalarFn(...callArgs(ir, layout, c, w));

    // The reference: evalReference threads the same simultaneous state from the inits.
    const ref = evalReference(ir, c.arrays, c.scalars, c.n);
    for (const name of outputs) {
      const got = readOut(memory, layout, name, c.n, TA);
      const want = ref[name] ?? [];
      for (let i = 0; i < c.n; i++) {
        comparisons++;
        const a = want[i] ?? 0;
        const b = got[i]!;
        if (w === "f32") worstUlpF32 = Math.max(worstUlpF32, ulpF32(a, b));
        // NaN sign/payload is IEEE-UNSPECIFIED: JS arithmetic and WASM produce
        // different NaN bit patterns (e.g. ffc00000 vs 7fc00000) for the SAME "not a
        // number" result, so NaN≡NaN is a match. A real +Inf vs −Inf divergence still
        // fails `equalW`. (The stateless gate avoids this by comparing WASM-vs-WASM;
        // here the reference is JS, so the tolerance is explicit.)
        if (!equalW(a, b, w, maxUlp) && !(Number.isNaN(a) && Number.isNaN(b))) {
          return { status: "rejected-gate", casesChecked: ci + 1, comparisons, worstUlpF32,
            mismatch: { kind: "scalar-vs-ref", caseIndex: ci, n: c.n, array: name, index: i, a, b } };
        }
      }
    }
  }
  return { status: "accepted", casesChecked: corpus.length, comparisons, worstUlpF32 };
}

// ── voice-SIMD gate (Apollo Frontier 7, Stage 4) ─────────────────────────────

interface VoiceLayout {
  readonly offsets: Record<string, number>; // array name → byte offset (slab of maxN·W)
  readonly maxN: number;
  readonly pages: number;
  readonly stateOffset: number; // lane-packed state slab (elements·W)
  readonly scalarOffset: number; // lane-packed scalar slab (scalarCount·W), or -1
  readonly scalarNames: string[]; // signature order
}

/** Memory layout for the voice gate: each I/O array a voice-interleaved slab of
 *  `maxN·W` elements; the lane-packed state slab (`stateLayout.elements·W`); a
 *  lane-packed scalar slab (`scalarCount·W`). One W-voice batch. */
function planVoiceLayout(ir: IrKernel, corpus: ReadonlyArray<CorpusCase>, W: number): VoiceLayout {
  const eb = ELEM_BYTES[ir.width];
  const maxN = Math.max(1, ...corpus.map((c) => c.n));
  const slot = align16(maxN * W * eb);
  const offsets: Record<string, number> = {};
  let cursor = 16;
  for (const p of ir.signature.params) {
    if (p.role === "input" || p.role === "output") { offsets[p.name] = cursor; cursor += slot; }
  }
  const slab = stateLayout(ir);
  const stateOffset = cursor;
  cursor += align16(Math.max(1, slab.elements) * W * eb);
  const scalarNames = ir.signature.params.filter((p) => p.role === "scalar").map((p) => p.name);
  let scalarOffset = -1;
  if (scalarNames.length > 0) { scalarOffset = cursor; cursor += align16(scalarNames.length * W * eb); }
  const pages = Math.max(1, Math.ceil(cursor / 65536));
  return { offsets, maxN, pages, stateOffset, scalarOffset, scalarNames };
}

/** Seed the lane-packed state slab COLD: zero the whole region (rings + cursors → 0),
 *  then write each register's declared init into ALL W lanes. */
function seedVoiceState(memory: WebAssembly.Memory, layout: VoiceLayout, ir: IrKernel, TA: Float32ArrayConstructor | Float64ArrayConstructor, W: number): void {
  const slab = stateLayout(ir);
  const view = new TA(memory.buffer, layout.stateOffset, Math.max(1, slab.elements) * W);
  view.fill(0);
  for (const r of slab.regs) for (let j = 0; j < W; j++) view[r.offset * W + j] = r.init;
}

/**
 * The voice-SIMD gate (Frontier 7, Stage 4): proves the voice-axis module's lane `j`
 * equals `evalReference(ir, voice-j inputs/scalars, n)` — the IR spec — BIT-EXACTLY for
 * EVERY lane `j ∈ [0, W)`, over W DISTINCT per-voice corpora (so a lane-crossing bug —
 * reading voice 0's state for voice 1, swapping two lanes — actually surfaces). Bit-
 * exact for f32 AND f64 (each f32x4/f64x2 lane rounds identically to the scalar op),
 * so this is STRONGER than the time-axis f32 path (no ULP budget).
 */
function runVoiceGate(input: GateInput, w: LaneWidth, maxUlp: number): GateReport {
  const { ir, simdWat, compileWat } = input;
  const W = LANES[w];
  const corpora = input.voiceCorpora;
  if (!corpora || corpora.length !== W) {
    return { status: "rejected-gate", casesChecked: 0, comparisons: 0, worstUlpF32: 0, reason: `voice-gate: expected ${W} per-lane corpora, got ${corpora?.length ?? 0}` };
  }
  if (!hasWasmSimd()) {
    return { status: "unsupported", casesChecked: 0, comparisons: 0, worstUlpF32: 0, reason: "no-wasm-simd" };
  }
  const corpus0 = corpora[0]!;
  const layout = planVoiceLayout(ir, corpus0, W);
  let inst: WebAssembly.Instance;
  let memory: WebAssembly.Memory;
  try {
    memory = new WebAssembly.Memory({ initial: layout.pages, maximum: 16384, shared: true });
    inst = instantiate(compileWat(simdWat, "voice"), memory);
  } catch (err) {
    return { status: "rejected-gate", casesChecked: 0, comparisons: 0, worstUlpF32: 0, reason: `instantiate-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const fn = inst.exports["kernel"] as (...a: number[]) => void;
  const TA = typedCtor(w);
  const outputs = ir.signature.params.filter((p) => p.role === "output").map((p) => p.name);
  const inputs = ir.signature.params.filter((p) => p.role === "input").map((p) => p.name);

  let comparisons = 0;
  let worstUlpF32 = 0;

  for (let ci = 0; ci < corpus0.length; ci++) {
    const n = corpus0[ci]!.n;

    // Write each input lane-packed: view[i·W + j] = voice-j's row.
    for (const name of inputs) {
      const view = new TA(memory.buffer, layout.offsets[name]!, layout.maxN * W);
      for (let j = 0; j < W; j++) {
        const row = corpora[j]![ci]!.arrays[name]!;
        for (let i = 0; i < n; i++) view[i * W + j] = row[i]!;
      }
    }
    // Lane-pack the per-voice scalars.
    if (layout.scalarOffset >= 0) {
      const sv = new TA(memory.buffer, layout.scalarOffset, layout.scalarNames.length * W);
      for (let s = 0; s < layout.scalarNames.length; s++) {
        const name = layout.scalarNames[s]!;
        for (let j = 0; j < W; j++) sv[s * W + j] = roundW(corpora[j]![ci]!.scalars[name] ?? 0, w);
      }
    }
    // Cold-seed the lane-packed state slab; zero the outputs.
    seedVoiceState(memory, layout, ir, TA, W);
    for (const name of outputs) new TA(memory.buffer, layout.offsets[name]!, layout.maxN * W).fill(0);

    // Build args (voiceParamLayout order): trip, arrays (sig order), __state, __scalars?
    const args: number[] = [n];
    for (const p of ir.signature.params) {
      if (p.role === "input" || p.role === "output") args.push(layout.offsets[p.name]!);
    }
    args.push(layout.stateOffset);
    if (layout.scalarOffset >= 0) args.push(layout.scalarOffset);
    fn(...args);

    // Compare each lane against evalReference(voice j).
    for (const name of outputs) {
      const view = new TA(memory.buffer, layout.offsets[name]!, layout.maxN * W);
      for (let j = 0; j < W; j++) {
        const ref = evalReference(ir, corpora[j]![ci]!.arrays, corpora[j]![ci]!.scalars, n)[name] ?? [];
        for (let i = 0; i < n; i++) {
          comparisons++;
          const a = ref[i] ?? 0;
          const b = view[i * W + j]!;
          if (w === "f32") worstUlpF32 = Math.max(worstUlpF32, ulpF32(a, b));
          // NaN sign/payload is IEEE-unspecified (JS vs WASM), so NaN≡NaN is a match;
          // a real ±Inf divergence still fails (mirrors runScalarOnlyGate).
          if (!equalW(a, b, w, maxUlp) && !(Number.isNaN(a) && Number.isNaN(b))) {
            return { status: "rejected-gate", casesChecked: ci + 1, comparisons, worstUlpF32,
              mismatch: { kind: "voice-vs-ref", caseIndex: ci, n, array: name, index: i, a, b, lane: j } };
          }
        }
      }
    }
  }
  return { status: "accepted", casesChecked: corpus0.length, comparisons, worstUlpF32 };
}

function zeroOutputs(memory: WebAssembly.Memory, layout: Layout, outputs: string[], TA: Float32ArrayConstructor | Float64ArrayConstructor): void {
  for (const name of outputs) {
    const view = new TA(memory.buffer, layout.offsets[name]!, layout.maxN);
    view.fill(0);
  }
}
function readOut(memory: WebAssembly.Memory, layout: Layout, name: string, n: number, TA: Float32ArrayConstructor | Float64ArrayConstructor): number[] {
  const view = new TA(memory.buffer, layout.offsets[name]!, layout.maxN);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = view[i]!;
  return out;
}

function tryBuildJsFn(source: string): ((...a: unknown[]) => void) | null {
  try {
    // Wrap so both `function k(){}` and `(…)=>{}` evaluate to the function value.
    // No closure over outer scope (validated); references only Math (global).
    // eslint-disable-next-line no-new-func
    return new Function(`"use strict"; return (${source});`)() as (...a: unknown[]) => void;
  } catch {
    return null;
  }
}

function runJsOracle(
  jsFn: (...a: unknown[]) => void, ir: IrKernel, c: CorpusCase, w: LaneWidth,
  TA: Float32ArrayConstructor | Float64ArrayConstructor,
): Record<string, number[]> | null {
  try {
    const arraysJs: Record<string, Float32Array | Float64Array> = {};
    for (const p of ir.signature.params) {
      if (p.role === "input") {
        const a = new TA(c.n); const row = c.arrays[p.name]!;
        for (let i = 0; i < c.n; i++) a[i] = row[i]!;
        arraysJs[p.name] = a;
      } else if (p.role === "output") {
        arraysJs[p.name] = new TA(c.n);
      }
    }
    // JS arg order = the source function's parameter order (signature order).
    const args = ir.signature.params.map((p) => {
      if (p.role === "length") return c.n;
      if (p.role === "scalar") return roundW(c.scalars[p.name] ?? 0, w);
      return arraysJs[p.name]!;
    });
    jsFn(...args);
    const out: Record<string, number[]> = {};
    for (const p of ir.signature.params) {
      if (p.role === "output") out[p.name] = Array.from(arraysJs[p.name]!.subarray(0, c.n));
    }
    return out;
  } catch {
    return null; // a throwing user fn can only cause its OWN rejection elsewhere
  }
}
