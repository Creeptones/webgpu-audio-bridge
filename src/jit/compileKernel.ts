/**
 * compileKernel — the JIT pipeline entry (Apollo Frontier 5, Stage 1a).
 *
 *   source (naive scalar JS) + KernelSignature
 *     → parse (acorn)            [E_PARSE on bad JS]
 *     → lower/validate → IR      [rejected-source on any out-of-subset construct]
 *     → vectorize → plan         [unsupported if not v1-emittable, e.g. stride-2]
 *     → emit scalar + SIMD WAT
 *     → equivalence gate         [rejected-gate if SIMD ≠ scalar on the corpus]
 *     → accepted { wasm, … }
 *
 * The result is a DISCRIMINATED UNION — `compileKernel` NEVER throws on a user
 * program (rejection is a value). The caller (the Stage-1b hot-swap runtime)
 * swaps ONLY on `status === "accepted"`; every other status keeps the JS kernel
 * running. That is the safety contract: an out-of-subset program, a
 * gate-rejected candidate, and a SIMD-unavailable host all degrade to "the audio
 * keeps playing on the user's JS".
 *
 * `@experimental` — exported from `webgpu-audio-bridge/experimental`, NOT the
 * 1.0 core. A one-shot construction warning fires (mirrors MpmcRing/SpmcRing).
 */

import { parseProgram } from "./parse.js";
import { lowerKernel } from "./lower.js";
import { JitRejection, type Diagnostic } from "./diagnostics.js";
import { vectorize, type VectorizedKernelPlan } from "./vectorize.js";
import { emitScalarModule, emitSimdModule, emitVoiceSimdModule } from "./emitKernelWat.js";
import { buildCorpus, CORPUS_N_VALUES, type CorpusOptions } from "./corpus.js";
import { runGate, type CompileWat, type GateReport } from "./gate.js";
import { type IrKernel, type IrStateDecl, type IrStateBufferDecl, type KernelSignature, type LaneWidth } from "./ir.js";
import { validateTokens, type KernelToken } from "./kernelGrammar.js";

export interface CompileKernelOptions {
  /** Injected WAT→bytes compiler (wabt in tests/build; a binary encoder in the
   *  live browser worker). Required — the gate cannot run without it. */
  readonly compileWat: CompileWat;
  /** Override the signature width (default: signature.width ?? "f32"). */
  readonly width?: LaneWidth;
  readonly exportName?: string;
  readonly corpus?: CorpusOptions;
  /** f32 ULP budget for the gate (default 0 — v1 is bit-exact). */
  readonly maxUlpF32?: number;
  /** Polyphonic voice batch (Apollo Frontier 7, Stage 4). When `> 1` and a multiple
   *  of the lane width `W`, a STATEFUL kernel is compiled along the VOICE axis (W
   *  independent voices per v128) instead of the scalar fallback — gate-proven lane
   *  `j` ≡ a scalar run of voice `j`. Default 1 (the single-voice scalar path,
   *  byte-identical to pre-Stage-4). Ignored for a stateless kernel (time-axis SIMD). */
  readonly voices?: number;
}

/** Options for the IR back-half (`compileIr`) and the token entry (`compileTokens`).
 *  The width is NOT here — it is carried by the IR (`ir.width` / `ir.signature`),
 *  already resolved by lowering / token validation. */
export interface CompileIrOptions {
  readonly compileWat: CompileWat;
  readonly exportName?: string;
  readonly corpus?: CorpusOptions;
  /** f32 ULP budget for the gate (default 0 — v1 is bit-exact). */
  readonly maxUlpF32?: number;
  /** The user's JS source, used ONLY as the gate's THIRD oracle (catches a faulty
   *  LOWERING — scalar WASM ≠ source). N/A on the IR/token path: there the IR IS
   *  the spec and SIMD≡scalar is the safety, so leave it undefined. Threaded only
   *  from the legacy `compileKernel(source)` entry. */
  readonly jsSource?: string;
  /** Polyphonic voice batch (Apollo Frontier 7, Stage 4) — see `CompileKernelOptions.voices`. */
  readonly voices?: number;
}

/** Options for the token entry (`compileTokens`). Identical to `CompileIrOptions`
 *  minus `jsSource` (the token path has no separate JS author — the IR is the
 *  spec). */
export type CompileTokensOptions = Omit<CompileIrOptions, "jsSource">;

export type CompileResult =
  | {
      readonly status: "accepted";
      readonly wasm: Uint8Array;
      readonly scalarWat: string;
      readonly simdWat: string;
      readonly plan: VectorizedKernelPlan;
      readonly exportName: string;
      readonly gate: GateReport;
      /** The kernel's declared state registers (Apollo Frontier 7), declaration
       *  order. Empty for a stateless kernel. The Stage-2 runtime needs these to
       *  allocate + seed the per-generation state slab — they cannot be derived
       *  from the `KernelSignature` (state registers are NOT signature params). */
      readonly stateDecls: ReadonlyArray<IrStateDecl>;
      /** The kernel's declared delay-line ring buffers (Apollo Frontier 7, Stage 3),
       *  declaration order. Empty for a kernel with no delay lines. The runtime needs
       *  these (with `stateDecls`) to size + seed the per-generation state slab; like
       *  registers, they are NOT derivable from the `KernelSignature`. */
      readonly stateBuffers: ReadonlyArray<IrStateBufferDecl>;
      /** The polyphonic voice batch this kernel was compiled for (Apollo Frontier 7,
       *  Stage 4). `1` for the single-voice scalar / stateless paths; `> 1` (a
       *  multiple of `plan.laneWidth`) for the voice-SIMD path — the runtime sizes its
       *  lane-packed slabs + drives its voice-interleaved I/O by this count, and the
       *  install guard checks it against what the consumer reserved. */
      readonly voices: number;
    }
  | { readonly status: "rejected-source"; readonly diagnostic: Diagnostic }
  | { readonly status: "rejected-gate"; readonly gate: GateReport }
  | { readonly status: "unsupported"; readonly reason: string; readonly gate?: GateReport };

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[webgpu-audio-bridge] The Autonomous JIT (compileKernel) is EXPERIMENTAL " +
      "(0.9.913, Apollo Frontier 5, Stage 1a). Its API + the compilable sub-language " +
      "are outside the 1.0 stability contract and may change before promotion. A " +
      "generated kernel is only ever returned as `accepted` after passing the " +
      "bit-exact/within-ULP equivalence gate. See docs/frontier5-jit-handoff.md.",
  );
}

export function compileKernel(
  source: string,
  signature: KernelSignature,
  opts: CompileKernelOptions,
): CompileResult {
  warnOnce();
  const sig: KernelSignature = opts.width ? { ...signature, width: opts.width } : signature;
  const exportName = opts.exportName ?? "kernel";

  // parse + lower/validate — rejection is a value, not an exception.
  let ir: IrKernel;
  try {
    const program = parseProgram(source);
    ir = lowerKernel(program, sig);
  } catch (err) {
    if (err instanceof JitRejection) return { status: "rejected-source", diagnostic: err.diagnostic };
    throw err;
  }

  // The user's source is the gate's THIRD oracle on this (JS) path only. (The JS
  // authoring path is stateless in v1 — `lower.ts` statefulness is deferred — so
  // `voices` here is inert unless a future stateful lowering lands; threaded for
  // completeness.)
  return compileIr(ir, {
    compileWat: opts.compileWat,
    exportName,
    corpus: opts.corpus,
    maxUlpF32: opts.maxUlpF32,
    jsSource: source,
    voices: opts.voices,
  });
}

/**
 * The IR back-half of the pipeline (Apollo Frontier 6, Stage 1): vectorize → emit
 * scalar + SIMD WAT → equivalence gate → accepted SIMD bytes. Shared by the legacy
 * `compileKernel(source)` front-half (parse → lower) and the token front-half
 * (`compileTokens` / the kernel grammar). Behavior is IDENTICAL to the pre-Stage-1
 * inline block — `compileKernel` is now `parse → lower → compileIr`.
 *
 * The width + signature ride in `ir` (resolved by lowering or token validation), so
 * there is no width override here. `opts.jsSource` is the gate's THIRD oracle — pass
 * it ONLY from `compileKernel(source)`; on the IR/token path the IR is the spec, so
 * leave it undefined (SIMD≡scalar is the safety).
 */
export function compileIr(ir: IrKernel, opts: CompileIrOptions): CompileResult {
  const exportName = opts.exportName ?? "kernel";
  const voices = opts.voices ?? 1;

  // vectorize — surfaces v1-non-emittable shapes as `unsupported` (→ JS fallback);
  // picks the lowering mode: stateless ⇒ "simd-time"; stateful + a power-of-W voice
  // batch ⇒ "simd-voice" (Frontier 7, Stage 4); else "scalar" (the recurrence wall).
  const vec = vectorize(ir, exportName, { voices });
  if (!vec.ok) return { status: "unsupported", reason: vec.reason };

  const scalarWat = emitScalarModule(ir, exportName);
  const stateDecls = ir.stateDecls ?? [];
  const stateBuffers = ir.stateBuffers ?? [];

  // The long-run corpus must exceed the longest delay so the ring WRAPS (a too-short
  // run never re-reads a wrapped slot — a ring-addressing / off-by-one bug would hide).
  const maxBuf = Math.max(0, ...(ir.stateBuffers ?? []).map((b) => b.length));
  const longRun = maxBuf > 0 ? [256, 512, maxBuf * 2 + 17] : [256, 512];

  // ── Frontier 7, Stage 4: the voice-axis SIMD path ────────────────────────────
  // A stateful kernel compiled across W independent voices (lane j = voice j). The
  // deliverable is the voice module; the gate proves lane j ≡ evalReference(voice j),
  // bit-exact, over W DISTINCT per-voice corpora (a lane-crossing bug surfaces).
  if (vec.plan.mode === "simd-voice") {
    const W = vec.plan.laneWidth;
    const voiceWat = emitVoiceSimdModule(ir, W, exportName);
    const nValues = [...CORPUS_N_VALUES, ...longRun];
    const baseSeed = opts.corpus?.seed ?? 0xc0ffee;
    // W per-lane corpora — same n-values (case indices align) but DISTINCT values per
    // voice, so reading another voice's state/inputs is caught.
    const voiceCorpora = Array.from({ length: W }, (_, j) =>
      buildCorpus(ir.signature, { ...(opts.corpus ?? { nValues }), seed: baseSeed + j * 0x9e3779b1 }),
    );
    const gate = runGate({
      ir, scalarWat, simdWat: voiceWat, corpus: voiceCorpora[0]!, voiceCorpora,
      compileWat: opts.compileWat, maxUlpF32: opts.maxUlpF32, voiceMode: true,
    });
    if (gate.status === "unsupported") return { status: "unsupported", reason: gate.reason ?? "unsupported", gate };
    if (gate.status === "rejected-gate") return { status: "rejected-gate", gate };
    const wasm = opts.compileWat(voiceWat, "voice");
    return { status: "accepted", wasm, scalarWat, simdWat: voiceWat, plan: vec.plan, exportName, gate, stateDecls, stateBuffers, voices };
  }

  // ── Frontier 7: the scalar-only (stateful, single-voice) path ────────────────
  // No SIMD candidate (the recurrence is not time-axis vectorizable), so the
  // deliverable IS the scalar module and the gate proves scalar WASM ≡ evalReference
  // over a corpus that includes a LONG run. The stateless SIMD path below is untouched.
  if (vec.plan.scalarOnly) {
    const corpus = buildCorpus(ir.signature, opts.corpus ?? { nValues: [...CORPUS_N_VALUES, ...longRun] });
    const gate = runGate({ ir, scalarWat, simdWat: scalarWat, corpus, compileWat: opts.compileWat, maxUlpF32: opts.maxUlpF32, scalarOnly: true });
    if (gate.status === "unsupported") return { status: "unsupported", reason: gate.reason ?? "unsupported", gate };
    if (gate.status === "rejected-gate") return { status: "rejected-gate", gate };
    const wasm = opts.compileWat(scalarWat, "scalar");
    return { status: "accepted", wasm, scalarWat, simdWat: scalarWat, plan: vec.plan, exportName, gate, stateDecls, stateBuffers, voices: 1 };
  }

  const simdWat = emitSimdModule(ir, exportName);

  const corpus = buildCorpus(ir.signature, opts.corpus);
  const gate = runGate({ ir, scalarWat, simdWat, corpus, compileWat: opts.compileWat, jsSource: opts.jsSource, maxUlpF32: opts.maxUlpF32 });

  if (gate.status === "unsupported") return { status: "unsupported", reason: gate.reason ?? "unsupported", gate };
  if (gate.status === "rejected-gate") return { status: "rejected-gate", gate };

  // accepted — produce the deliverable SIMD bytes.
  const wasm = opts.compileWat(simdWat, "simd");
  return { status: "accepted", wasm, scalarWat, simdWat, plan: vec.plan, exportName, gate, stateDecls, stateBuffers, voices: 1 };
}

/**
 * The TOKEN entry (Apollo Frontier 6, Stage 1): a kernel grammar token stream →
 * `CompileResult`. Runs the SYNTAX gate (`validateTokens`, gate #1 of 3); on
 * success compiles the validated IR through `compileIr` (gate #2, equivalence).
 * Rejection is a VALUE, mirroring `compileKernel`.
 *
 * A syntax failure is surfaced as `rejected-source` with an `E_TOKENS` diagnostic
 * — the bridge from the grammar's `{ error, at? }` shape (a token index, no source
 * line/col) to the compiler's closed `Diagnostic` shape. The token index is folded
 * into the message (line/col are 0; the token stream has no source location).
 *
 * No `jsSource`: the token stream IS the spec, so the gate's SIMD≡scalar check is
 * the whole safety. The emitted JS fallback (`emitJsKernel`) is a DERIVATIVE of the
 * IR, not an independent author, so it is not used as the third oracle here.
 */
export function compileTokens(
  tokens: ReadonlyArray<KernelToken>,
  opts: CompileTokensOptions,
): CompileResult {
  const v = validateTokens(tokens);
  if (!v.ok) {
    const message = v.at !== undefined ? `${v.error} (at token ${v.at})` : v.error;
    return { status: "rejected-source", diagnostic: { code: "E_TOKENS", message, line: 0, col: 0 } };
  }
  return compileIr(v.ir, {
    compileWat: opts.compileWat,
    exportName: opts.exportName,
    corpus: opts.corpus,
    maxUlpF32: opts.maxUlpF32,
    voices: opts.voices,
  });
}
