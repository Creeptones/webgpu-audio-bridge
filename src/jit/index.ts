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

export { compileKernel } from "./compileKernel.js";
export type { CompileKernelOptions, CompileResult } from "./compileKernel.js";

export type { CompileWat, GateReport, GateStatus, GateMismatch } from "./gate.js";
export { runGate } from "./gate.js";

export type {
  KernelSignature, KernelParam, ParamRole, LaneWidth, IrKernel, IrNode, IrStore,
} from "./ir.js";

export type { Diagnostic, DiagnosticCode } from "./diagnostics.js";

export type { VectorizedKernelPlan } from "./vectorize.js";

// Lower-level building blocks (useful for the runtime + tests; still experimental).
export { emitScalarModule, emitSimdModule, paramLayout } from "./emitKernelWat.js";
export { buildCorpus, CORPUS_N_VALUES } from "./corpus.js";
export type { CorpusOptions, CorpusCase } from "./corpus.js";
export { vectorize } from "./vectorize.js";
export { lowerKernel, validate } from "./lower.js";
export { parseProgram } from "./parse.js";

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
  JitWorkletOptions, JitCompileRequest, JitCompileResponse, JitInstallMessage,
  JitTransport, JitPostTarget, JitMessageSource, JitInstallOutcome, ForwardOptions,
} from "./connectJit.js";
