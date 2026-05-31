/**
 * The Autonomous JIT — internal barrel (Apollo Frontier 5, Stage 1a).
 *
 * Re-exported by `src/experimental/index.ts` under the
 * `webgpu-audio-bridge/experimental` subpath. NOT exported from `src/index.ts`
 * (the zero-runtime-dep core): this subtree transitively imports `acorn` via
 * `parse.ts`, and the import-graph guard in `tests/JitCompiler.test.ts` pins
 * that the core never reaches it.
 *
 * Internal-first + `@experimental` — the API and the compilable sub-language
 * may change before promotion, mirroring SpscRing internal@0.6.8 → public@0.6.10.
 */

export { compileKernel, compileIr, compileTokens } from "./compileKernel.js";
export type {
  CompileKernelOptions, CompileIrOptions, CompileTokensOptions, CompileResult,
} from "./compileKernel.js";

export type { CompileWat, GateReport, GateStatus, GateMismatch } from "./gate.js";
export { runGate } from "./gate.js";

export type {
  KernelSignature, KernelParam, ParamRole, LaneWidth, IrKernel, IrNode, IrStore,
  IrStateDecl, IrStateStore, IrStateBufferDecl, IrStateBufferStore, StateLayout,
  LoopBound, UnaryOp, BinaryOp,
} from "./ir.js";
export { isStateful, stateLayout } from "./ir.js";

export type { Diagnostic, DiagnosticCode } from "./diagnostics.js";

export type { VectorizedKernelPlan, VectorizeMode, VectorizeOptions } from "./vectorize.js";

// Lower-level building blocks (useful for the runtime + tests; still experimental).
export { emitScalarModule, emitSimdModule, emitVoiceSimdModule, paramLayout, voiceParamLayout } from "./emitKernelWat.js";
export { buildCorpus, CORPUS_N_VALUES } from "./corpus.js";
export type { CorpusOptions, CorpusCase } from "./corpus.js";
export { vectorize } from "./vectorize.js";
export { lowerKernel, validate } from "./lower.js";
export { parseProgram } from "./parse.js";

// ── Stage-0 kernel grammar (Apollo Frontier 6) ───────────────────────────────
// The token serialization of the IR: a closed postfix grammar, a lossless codec,
// the syntax validator (gate #1 of 3), the flat text form, and the content hash.
// Pure data — depends only on the IR types + `kernelKey`, never on the
// parser/vectorizer/emitter/gate. See kernelGrammar.ts.
export {
  kernelToTokens, tokensToKernel, validateTokens, legalNextTokens, legalNextOperands,
  kernelHash, tokensToString, parseTokens,
} from "./kernelGrammar.js";
export type {
  KernelToken, TokenKind, ValidateResult, ValidateFailure, LegalNextResult, OperandChoices,
} from "./kernelGrammar.js";

// ── Stage-1 compile pipeline: IR→JS emitter + content-addressed cache ────────
// `emitJsKernel` inverts `lower.ts` (IR → naive scalar JS — the worklet fallback
// for the token path). `KernelCache.getOrCompile` content-addresses + characterizes
// (gate-verifies) a token stream, returning a cached kernel instantly on a repeat.
export { emitJsKernel } from "./emitJsKernel.js";
export { KernelCache } from "./kernelCache.js";
export type {
  CharacterizedKernel, GetOrCompileOptions, GetOrCompileResult, RejectVerdict,
} from "./kernelCache.js";

// ── Stage-2 acoustic gate (gate #3) ──────────────────────────────────────────
// `acousticGate(ir, opts)` runs the accepted IR over a deterministic probe (no wasm —
// gate #2 already proved SIMD ≡ the IR reference) and returns an `AcousticProfile`
// fingerprint, accepting iff it is finite + within sane bounds. `evalReference` is the
// pure IR interpreter the probe rides on (reusable by Stage 3). `KernelCache` owns the
// gate; this is the standalone surface. See acousticGate.ts.
export { acousticGate, evalReference } from "./acousticGate.js";
export type {
  AcousticProfile, AcousticGateOptions, AcousticGateResult,
} from "./acousticGate.js";

// ── fingerprint queries over the acoustic embedding (quick-win #2) ────────────
// "Sounds-like" math over `AcousticProfile.magnitude` (the L1-normalized,
// amplitude-invariant band vector): L2 distance, nearest-neighbour, dedup-by-sound,
// and brightness ordering along `spectralCentroid`. Pure (no wasm). See fingerprint.ts.
export {
  fingerprintDistance, nearestByFingerprint, dedupByFingerprint,
  sortByBrightness, brighterThan, darkerThan,
} from "./fingerprint.js";
export type { FingerprintLike, FingerprintMatch } from "./fingerprint.js";

// ── offline corpus index (quick-win #3) ──────────────────────────────────────
// Batch-characterize kernels → cluster by fingerprint → export prototypes (a vetted
// seed set). Build/worker-time tooling, pure (no wasm). See corpusIndex.ts.
export {
  characterizeCorpus, clusterByFingerprint, buildCorpusIndex, corpusPrototypes,
} from "./corpusIndex.js";
export type {
  CorpusEntry, CorpusRejection, CorpusCluster, CorpusIndex, BuildCorpusIndexOptions,
} from "./corpusIndex.js";

// ── live-swap runtime (Stage 1b) ─────────────────────────────────────────────
export { JitKernelSwap } from "./JitKernelSwap.js";
export type { JitKernelSwapOptions, JitSwapPhase, JitSwapQuantum } from "./JitKernelSwap.js";
export { JitKernelConsumer } from "./JitKernelConsumer.js";
export type {
  JitKernelConsumerOptions, JitJsKernel, JitMemoryRegion, JitProcessResult,
} from "./JitKernelConsumer.js";

// ── one-call constructor + 3-realm wiring (Stage 3) ──────────────────────────
export {
  connectJit, runJitCompile, forwardCompileResponse,
  createJitConsumer, handleJitInstallMessage, jitMemoryPages,
} from "./connectJit.js";
export type {
  ConnectJitSpec, ConnectJitKernel, ConnectJitCallbacks, JitConnection,
  JitWorkletOptions, JitCompileRequest, JitCompileRequestBase, JitCompileResponse,
  JitInstallMessage, JitTransport, JitPostTarget, JitMessageSource, JitInstallOutcome,
  ForwardOptions,
} from "./connectJit.js";
