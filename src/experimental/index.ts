/**
 * webgpu-audio-bridge / experimental — opt-in entry point for APIs that
 * sit OUTSIDE the project's 1.0 stability contract.
 *
 * The shapes exported here may break across MINOR version bumps as the
 * underlying browser specs (WebNN as of 0.7.16; future entries as they
 * land) stabilize. Patch bumps within a minor preserve compatibility.
 *
 * Import path is the `webgpu-audio-bridge/experimental` subpath:
 *
 *   import { BridgeWebNNSource } from "webgpu-audio-bridge/experimental";
 *
 * Production code that wants pre-construction capability checks should
 * use `getEnvironmentReport()` from the main entry point (the 0.7.17
 * patch adds `webnn` + `mlTensor` capability flags) — that report-
 * shape API is stable; the helpers under this subpath are not.
 */

export { BridgeWebNNSource } from "./BridgeWebNNSource.js";
export type {
  BridgeWebNNSourceOptions,
  MLTensorLike,
  WebNNTensorReader,
} from "./BridgeWebNNSource.js";

// ── renderSizeHint probe (0.9.73) ──────────────────────────────────────────
//
// Web Audio's experimental `renderSizeHint` construction knob + the
// `renderQuantumSize` readback. A smaller quantum (e.g. 64 vs 128) halves the
// AudioWorklet scheduling granularity — the largest reducible term in the
// Turbo input-latency floor. `measureRenderQuantum()` constructs a context,
// asks for a size, and reports what the browser actually did; `honored` tells
// you whether the hint moved the quantum. The stable pre-construction sniff is
// `getEnvironmentReport().renderSizeHint` on the main entry point. Treat the
// shapes here as unstable — they track an unsettled spec.
export {
  measureRenderQuantum,
  sweepRenderQuantum,
  quantumLatencyMs,
  isRenderSizeHintSupported,
} from "./renderQuantum.js";
export type {
  RenderSizeHint,
  RenderQuantumReport,
  QuantumLatencyMs,
  MeasureRenderQuantumOptions,
  AudioContextCtorLike,
} from "./renderQuantum.js";

// ── MpmcRing + connectFanIn/mountFanIn (0.9.907 / 0.9.909) ──────────────────
//
// Apollo Frontier 3's wait-free MP→SC (multi-producer, single-consumer) fan-in
// edge. `MpmcRing` is the primitive (Stage 1); `connectFanIn`/`mountFanIn` are
// the declarative `connect()`-style topology constructor over it (Stage 3) —
// allocate the shared SAB once, hand a clone-safe handle to N producer threads +
// 1 consumer, each `mountFanIn`s an `MpmcRing` over it. Turbo-ONLY: a
// non-isolated environment throws `ConnectUnsupportedError('isolation-required')`
// — there is NO MessageChannel fallback (the point is the wait-free SAB
// fetch-add). The MP→SC wire format is OUTSIDE the 1.0 stability contract until
// it soaks + promotes (mirrors SpscRing internal@0.6.8 → public@0.6.10); a
// one-shot construction warning fires. See docs/frontier3-stage3-connect-
// integration-handoff.md.
export { MpmcRing, MPMC_HEADER_BYTES } from "../MpmcRing.js";
export type { MpmcRingOptions } from "../MpmcRing.js";
export { connectFanIn, mountFanIn } from "../connectFanIn.js";
export type {
  ConnectFanInSpec,
  FanInHandle,
  FanInTopology,
  FanInSizing,
  FanInRole,
  MountFanInOptions,
} from "../connectFanIn.js";

// ── SpmcRing (0.9.911) ──────────────────────────────────────────────────────
//
// Apollo Frontier 3's wait-free SP→MC (single-producer, multi-consumer)
// BROADCAST fan-out edge (Stage 4.1) — one producer, N consumers, every consumer
// sees every frame through its own cursor. The second single-edge primitive
// (after MpmcRing). Internal-first + `@experimental`: its SP→MC broadcast wire
// format is OUTSIDE the 1.0 stability contract until it soaks + promotes
// (mirrors SpscRing internal@0.6.8 → public@0.6.10, MpmcRing's pending
// promotion); a one-shot construction warning fires. The `connectFanOut()`
// topology constructor over it is Stage 4.3. See
// docs/frontier3-stage4.1-spmc-primitive-handoff.md.
export { SpmcRing, SPMC_HEADER_BYTES } from "../SpmcRing.js";
export type { SpmcRingOptions } from "../SpmcRing.js";

// ── MpmcWorkQueue (0.9.934) ─────────────────────────────────────────────────
//
// Apollo Frontier 3's wait-free MP→MC (multi-producer, multi-CONSUMER)
// competing-consumer WORK QUEUE (MP→MC Work-Queue Stage 1) — N producers, M
// consumers, every frame to EXACTLY ONE consumer (a partition, not a broadcast —
// contrast SpmcRing). The THIRD single-edge primitive (after MpmcRing@0.9.907 and
// SpmcRing@0.9.911); the genuinely-new hazard is consumer-side contention, solved
// HARD WAIT-FREE on both ends by symmetric fetch-add + a held-claim (the classic
// bounded MPMC queue, Vyukov's, is only lock-free). Tear-freedom comes from the
// per-slot Vyukov sequence stamp (mechanism 1), which serializes the slot
// producer→consumer→producer; the producer reuse envelope is MpmcRing's, measured
// from a lazily-scanned contiguous delivered frontier. Internal-first +
// `@experimental`: the MP→MC wire format is OUTSIDE the 1.0 stability contract
// until it soaks + promotes (mirrors SpscRing internal@0.6.8 → public@0.6.10,
// MpmcRing/SpmcRing's pending promotion); a one-shot construction warning fires.
// The connectWorkQueue() topology constructor + the end-of-stream protocol (to
// release the bounded teardown strand) are Stage 3. See
// docs/mpmc-workqueue-design.md.
export { MpmcWorkQueue, MPMC_WQ_HEADER_BYTES } from "../MpmcWorkQueue.js";
export type { MpmcWorkQueueOptions } from "../MpmcWorkQueue.js";

// ── connectWorkQueue/mountWorkQueue (0.9.937) ───────────────────────────────
//
// Apollo Frontier 3, MP→MC Work-Queue Stage 3: the `connect()`-style MP→MC
// work-queue topology constructor over `MpmcWorkQueue` — the third sibling of
// `connectFanIn` (MP→SC) and `connectFanOut` (SP→MC). Allocate + `initLayout` the
// shared SAB ONCE → a clone-safe handle; every producer + every competing consumer
// `mountWorkQueue` an `MpmcWorkQueue` over it. Turbo-ONLY (a non-isolated env
// throws `ConnectUnsupportedError('isolation-required')`; no MessageChannel
// fallback). The KEY asymmetry vs `connectFanOut`: `producerCount` sizes the SAB
// (SLACK = producerCount − 1) but `consumerCount` does NOT (anonymous consumers,
// no per-consumer lane) — it is carried only for close-coordination + strand
// accounting. The end-of-stream protocol that releases the bounded teardown strand
// lives in `MpmcWorkQueue.close()`/`isDrained()`. `@experimental` until
// `MpmcWorkQueue` promotes. See docs/mpmc-workqueue-design.md.
export { connectWorkQueue, mountWorkQueue } from "../connectWorkQueue.js";
export type {
  ConnectWorkQueueSpec,
  WorkQueueHandle,
  WorkQueueTopology,
  WorkQueueSizing,
  WorkQueueRole,
  MountWorkQueueOptions,
} from "../connectWorkQueue.js";

// ── connectFanOut/mountFanOut (0.9.928) ─────────────────────────────────────
//
// Apollo Frontier 3, Stage 4.3: the `connect()`-style SP→MC broadcast topology
// constructor over `SpmcRing` — the direct sibling of `connectFanIn`. Allocate +
// `initLayout` the shared SAB ONCE → a clone-safe handle; the producer + each of
// N consumers `mountFanOut` a `SpmcRing` over it (a consumer with its
// `consumerIndex`, the producer unbound). Turbo-ONLY: a non-isolated environment
// throws `ConnectUnsupportedError('isolation-required')` (no MessageChannel
// fallback). Capacity is the lap window (no reserved slack). `@experimental`
// until `SpmcRing` promotes.
export { connectFanOut, mountFanOut } from "../connectFanOut.js";
export type {
  ConnectFanOutSpec,
  FanOutHandle,
  FanOutTopology,
  FanOutSizing,
  FanOutRole,
  MountFanOutOptions,
} from "../connectFanOut.js";

// ── The Autonomous JIT — compileKernel (0.9.913) ────────────────────────────
//
// Apollo Frontier 5, Stage 1a: the in-browser JS→WASM-SIMD micro-compiler.
// `compileKernel(source, signature, { compileWat })` parses a developer's naive
// scalar JS DSP loop, auto-vectorizes it to WASM SIMD (f32x4 / f64x2), and
// returns the SIMD bytes ONLY after the equivalence gate proves them bit-exact
// (f64) / within-ULP (f32) to a scalar reference compiled from the same IR — so
// a generated kernel can never reach the audio thread unless it is proven
// equivalent. Internal-first + `@experimental`: the API and the compilable
// sub-language are OUTSIDE the 1.0 stability contract until they soak + promote;
// a one-shot construction warning fires. `acorn` (the JS parser) is a
// compile-time dependency confined to this subtree — the zero-runtime-dep core
// (the root entry point) never reaches it. The live hot-swap runtime
// (`JitKernelConsumer` / `connectJit`) is Stage 1b. See docs/frontier5-jit-handoff.md.
export { compileKernel, runGate, vectorize, lowerKernel, validate, parseProgram } from "../jit/index.js";
export { emitScalarModule, emitSimdModule, emitVoiceSimdModule, paramLayout, voiceParamLayout, buildCorpus, CORPUS_N_VALUES } from "../jit/index.js";
export { isStateful, stateLayout } from "../jit/index.js";
export type {
  CompileKernelOptions, CompileResult, CompileWat, GateReport, GateStatus, GateMismatch,
  KernelSignature, KernelParam, ParamRole, LaneWidth, IrKernel, IrNode, IrStore,
  IrStateDecl, IrStateStore, IrStateBufferDecl, IrStateBufferStore, StateLayout,
  Diagnostic, DiagnosticCode, VectorizedKernelPlan, CorpusOptions, CorpusCase,
} from "../jit/index.js";

// ── The Autonomous JIT — live-swap runtime (0.9.914, Stage 1b) ───────────────
//
// Apollo Frontier 5, Stage 1b: the audio-thread runtime that gets a gate-PASSED
// SIMD kernel into the live AudioWorklet click-free. `JitKernelSwap` is the pure,
// Node-testable dual-kernel swap state machine (the `HotSwapConsumer` sibling);
// `JitKernelConsumer` is the worklet-side executor — it holds the developer's
// permanent JS fallback + the compiled SIMD `Instance`, instantiates the Module
// SYNCHRONOUSLY between quanta, runs both kernels into disjoint scratch slabs
// during the fade, and AMPLITUDE-crossfades them (the two kernels are ULP-
// correlated, so a hard switch could click near cancellation — the Stage-1a
// stress finding). It degrades to the JS kernel on EVERY failure (no shared
// memory, instantiation throw, missing export, non-finite output). Still
// `@experimental` — same surface as `compileKernel`. The `connectJit()` one-call
// constructor + browser demo is Stage 3. See docs/frontier5-stage1b-runtime-handoff.md.
export { JitKernelSwap, JitKernelConsumer } from "../jit/index.js";
export type {
  JitKernelSwapOptions, JitSwapPhase, JitSwapQuantum,
  JitKernelConsumerOptions, JitJsKernel, JitMemoryRegion, JitProcessResult,
} from "../jit/index.js";

// ── The Autonomous JIT — connectJit() one-call constructor (0.9.917, Stage 3) ─
//
// Apollo Frontier 5, Stage 3: the `connect()`-style constructor that hides the
// three-realm dance behind one main-thread call + two tiny realm helpers.
// `connectJit(spec)` (main) allocates/adopts the shared memory, snapshots
// `kernel.toString()` (a closure can't cross `postMessage` — the kernel reaches
// both off-thread realms as a SOURCE STRING), and returns the worklet
// `processorOptions` + the compile-worker request + the bind/forceJs controls.
// `runJitCompile(request, { compileWat })` (compile worker) runs `compileKernel`
// and, on `accepted` ONLY, async-`WebAssembly.compile`s a clone-safe response.
// `createJitConsumer` + `handleJitInstallMessage` (worklet) reconstruct the JS
// fallback and route the install. The Module-vs-bytes transport is one swappable
// strategy decided at the send boundary (`forwardCompileResponse`). Degrades to
// JS forever on a non-isolated / no-SIMD host (never throws). Still
// `@experimental` — same surface as `compileKernel` / `JitKernelConsumer`. See
// docs/jit-vectorize-design.md + the `examples/jit-vectorize/` browser demo.
export {
  connectJit, runJitCompile, forwardCompileResponse,
  createJitConsumer, handleJitInstallMessage, jitMemoryPages,
} from "../jit/index.js";
export type {
  ConnectJitSpec, ConnectJitKernel, ConnectJitCallbacks, JitConnection,
  JitWorkletOptions, JitCompileRequest, JitCompileRequestBase, JitCompileResponse,
  JitInstallMessage, JitTransport, JitPostTarget, JitMessageSource, JitInstallOutcome,
  ForwardOptions,
} from "../jit/index.js";

// ── The kernel grammar (0.9.918, Apollo Frontier 6, Stage 0) ─────────────────
//
// Language→music begins here: a small, CLOSED token grammar that IS the JIT IR
// serialized (postfix/RPN), with a lossless bidirectional codec, a value-returning
// SYNTAX validator (gate #1 of the three-gate stack: syntax → equivalence →
// acoustic), a copy-pasteable flat text form, and a deterministic content hash.
// Pure data — no parser/compiler/gate, no model, no wabt. `kernelHash` is a
// content-address / cache key (FNV-1a-64 over the canonical `kernelKey`), NOT a
// security boundary — the equivalence gate is the boundary. `@experimental`: the
// grammar + codec + hash are outside the 1.0 stability contract until they soak +
// promote. See docs/frontier6-stage0-1-grammar-handoff.md.
export {
  kernelToTokens, tokensToKernel, validateTokens, kernelHash, tokensToString, parseTokens,
} from "../jit/index.js";
export type { KernelToken, TokenKind, ValidateResult, ValidateFailure } from "../jit/index.js";

// ── The kernel grammar — Stage 3a: the constrained-decoder mask (0.9.922) ─────
//
// `legalNextTokens(prefix)` is the forward-direction sibling of `validateTokens`:
// the set of token KINDS that may legally come next, plus a `done` flag (is the
// prefix already a complete, valid kernel?). It shares ONE step machine with
// `validateTokens`, so the mask a Stage-3 decoder applies to its logits can never
// drift from the syntax gate — an emitter constrained to the mask cannot produce a
// structurally-invalid stream (the model-free safety contract the SLM plugs behind).
// v1 masks KINDS; a wrong OPERAND can still be rejected (a v2 operand-mask). All
// additive + `@experimental`. See docs/frontier6-grammar-design.md.
export { legalNextTokens } from "../jit/index.js";
export type { LegalNextResult } from "../jit/index.js";

// ── The kernel grammar — Stage 1: compile pipeline + characterized cache ──────
//
// Apollo Frontier 6, Stage 1: tokens → IR → gate → install → audio, model-free.
// `compileIr` is the IR back-half of the compiler (shared by the JS + token
// front-halves); `compileTokens` runs the syntax gate (`validateTokens`) then
// `compileIr` (a syntax failure surfaces as a `rejected-source` E_TOKENS
// diagnostic). `emitJsKernel` inverts `lower.ts` (IR → naive scalar JS — the
// worklet fallback for the token path, tree-shape + number faithful). `KernelCache`
// content-addresses + characterizes (gate-verifies) a token stream by `kernelHash`,
// so a repeated kernel returns instantly without recompiling — the exact object a
// Stage-3 SLM worker calls. All additive + `@experimental`. See
// docs/frontier6-grammar-design.md.
export { compileIr, compileTokens, emitJsKernel, KernelCache } from "../jit/index.js";
export type {
  CompileIrOptions, CompileTokensOptions,
  CharacterizedKernel, GetOrCompileOptions, GetOrCompileResult,
} from "../jit/index.js";

// ── The kernel grammar — Stage 2: the acoustic gate (gate #3) ─────────────────
//
// Apollo Frontier 6, Stage 2: the last model-free gate. `acousticGate(ir, opts)`
// runs the equivalence-accepted IR over a fixed DETERMINISTIC probe (a bin-aligned
// sine) — with NO `WebAssembly.Instance` (gate #2 already proved SIMD ≡ the scalar IR
// reference, so profiling `evalReference(ir, …)` is equivalent) — and returns an
// `AcousticProfile` (rms / peak / dcOffset / crestFactor / spectralCentroid + an
// L1-normalized magnitude fingerprint). It ACCEPTs iff the profile is finite + within
// sane bounds (acoustic SANITY + a fingerprint, NOT taste). `KernelCache.getOrCompile`
// owns the gate: a pass attaches the profile to the `CharacterizedKernel` (computed
// once per content hash, free on a hit); a runaway/non-finite kernel returns
// `rejected-acoustic` (the cache-layer-only verdict). All additive + `@experimental`.
// See docs/frontier6-grammar-design.md.
export { acousticGate, evalReference } from "../jit/index.js";
export type {
  AcousticProfile, AcousticGateOptions, AcousticGateResult,
} from "../jit/index.js";
