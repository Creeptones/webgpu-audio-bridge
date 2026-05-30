/**
 * webgpu-audio-bridge
 *
 * Lock-free SPSC SharedArrayBuffer ring for streaming structured frames from
 * a Web Worker (typically driving WebGPU compute) into an AudioWorklet — the
 * control-rate-GPU / audio-rate-CPU pattern.
 *
 * Two public surfaces:
 *
 *   - `Bridge<Schema>`: schema-driven frame codec. Describe your frame with
 *     `defineSchema({ ... })` and arbitrary primitive types
 *     (f64/f32/u64/i64/u32/i32/u16/i16/u8/i8 scalars and arrays). Ships the
 *     monolithic producer + consumer API. Shipped 0.3.
 *
 *   - `SpscRing<Schema>` + `BridgeProducer<Schema>` /
 *     `BridgeConsumer<Schema>` + `FrameSmoother<Schema>` /
 *     `ConsumerClockRecovery` / `AdaptiveFlowController` (0.6.10): the
 *     composable alternative. `Bridge<S>` continues to work unchanged; the
 *     facades are for users who want explicit control over which primitives
 *     are wired in and which invariant-failure policy is active. Same SAB
 *     protocol — a facade-built peer interoperates with a Bridge-built peer.
 *
 * The 0.9.0 release removed three legacy surfaces (`Float64RingBuffer`, the
 * `legacyPhysicsControlFrameSchema(n)` byte-twin, and the
 * `BridgeBlockConsumer` `underflowPolicy: 'throw'` arm). If you need any
 * of those, pin `webgpu-audio-bridge@0.8.x` — see CHANGELOG `[0.9.0]` for
 * the migration guide.
 *
 * See README.md for the architectural pattern and use cases.
 */

// ── Recommended: Bridge<Schema> ───────────────────────────────────────────

export { Bridge, RING_HEADER_BYTES, RING_HEADER_LANES } from "./Bridge.js";
// Real-time-safety role lattice (0.9.45). `Bridge<S, Role>` brands a handle
// with the thread role it lives on; on `"worklet"` the MAY-BLOCK methods
// (`waitForData` / `waitForSpace`) and the interval-based `subscribeTelemetry`
// are structurally absent — calling them is a compile error. The brand is a
// phantom (zero runtime cost); `DefaultRole = "worker"` keeps a bare
// `Bridge<S>` fully compatible. `forWorklet` / `forWorker` are role-stamping
// factories over a single `Bridge.allocate(...)`. See
// docs/rt-safety-lattice-design.md.
export { forWorklet, forWorker } from "./Bridge.js";
// Predictive "negative latency" mode (0.9.71) — `pullPredictedLatest` +
// `lastReadbackMedianMs` live on the Bridge class; the lead ceiling constant
// and the option / result shapes are exported for callers + tests.
export { DEFAULT_MAX_LEAD_MS } from "./Bridge.js";
export type { BridgeRole, DefaultRole } from "./Bridge.js";
export type {
  BridgeAllocation,
  BridgeOptions,
  SmoothedPullOptions,
  SmootherSkipPolicy,
  PredictedPullOptions,
  PredictedPullResult,
  // Observability snapshot + subscription seam (0.7.3)
  TelemetrySnapshot,
  TelemetryListener,
  TelemetryUnsubscribe,
  SubscribeTelemetryOptions,
} from "./Bridge.js";

// ── Telemetry history ring (0.9.76) — rolling diagnostic buffer ───────────
// Fixed-size, allocation-free history layer that composes with
// `Bridge.subscribeTelemetry` (the push-callback) to retain the last N ticks.
export { TelemetryRing } from "./TelemetryRing.js";
export type { TelemetryRingSample, TelemetryRingOptions } from "./TelemetryRing.js";

// ── Standard mode (0.10.0) — MessageChannelBridge<Schema> ─────────────────
//
// Sibling tier to `Bridge<S>`'s Turbo mode. Same schema DSL surface,
// `MessageChannel` + transferable `ArrayBuffer` transport instead of
// `SharedArrayBuffer` + `Atomics`. Does NOT require cross-origin
// isolation. Latency floor 5-50 ms per round trip (vs Turbo's sub-µs).
// **Not for audio rate.** Right for prototyping before COOP/COEP is
// configured, control-plane updates in unisolated embeds, telemetry
// channels, anything non-audio-critical. See README §Standard mode for
// the full picture and `docs/standard-mode-design.md` for the MVP1
// scope decisions.

export { MessageChannelBridge } from "./MessageChannelBridge.js";
export type {
  MessageChannelBridgeAllocation,
} from "./MessageChannelBridge.js";

// ── One-call topology constructor (0.9.46) ────────────────────────────────
//
// `connect(spec)` collapses the multi-step Turbo setup recipe (allocate +
// size + postMessage + reconstruct-per-peer + COOP/COEP guard) into one call
// plus a symmetric `mount(handle, opts)`. It probes the environment via
// `getEnvironmentReport()`, picks Turbo (SAB) vs Standard (MessageChannel) vs
// a graceful `ConnectUnsupportedError` carrying `report.fixes`, sizes the
// ring(s) from a `latencyHint`, and returns a clone-safe handle to
// `postMessage`. Pure assembly over the shipped facades — no new wire format.
// See docs/connect-topology-design.md.

// 0.9.47 widens `latencyHint` to accept a precise `LatencyBudget` object
// (derive capacity from the actual per-frame audio duration, not a 3-value
// bucket) and surfaces the resolved `RingSizing` on `ConnectRingHandle.sizing`.
// `audioFramesPerSlot` is the pure block-schema detector the ladder uses.
export { connect, mount, ConnectUnsupportedError, audioFramesPerSlot } from "./connect.js";
export type {
  LatencyHint,
  LatencyBudget,
  RingSizing,
  ConnectRingSpec,
  ConnectSpec,
  ConnectMode,
  ConnectRingHandle,
  ConnectHandle,
  ConnectRole,
  MountOptions,
  MountResult,
  ConnectTopology,
} from "./connect.js";

// ── Composable primitives (0.6.10) ────────────────────────────────────────
//
// The four heap state machines that `Bridge<S>` composes internally, plus
// the two thin facade classes that wrap them as explicit consumer / producer
// objects. `Bridge<S>` continues to work unchanged; these are an additive
// alternative for users who want explicit composition. See the file headers
// of each module for the per-primitive contract.

export { SpscRing } from "./SpscRing.js";
export type {
  SpscPullResult,
  SpscRingOptions,
  BackpressurePolicy,
} from "./SpscRing.js";
export { FrameSmoother } from "./FrameSmoother.js";
export { ConsumerClockRecovery } from "./ConsumerClockRecovery.js";
export type { ConsumerClockRecoveryOptions } from "./ConsumerClockRecovery.js";
export { AdaptiveFlowController } from "./AdaptiveFlowController.js";

export { BridgeConsumer } from "./BridgeConsumer.js";
export type {
  BridgeConsumerOptions,
  InvariantFailurePolicy,
  InvariantFailureCallback,
} from "./BridgeConsumer.js";
export { BridgeProducer } from "./BridgeProducer.js";

// ── Pro-audio tracking fast lane (0.6.19) ─────────────────────────────────
//
// Event-queue facade for the "input lane" pattern: a separate Bridge
// dedicated to gestural input (MIDI / touch / slider events) that the
// AudioWorklet drains every quantum via `pullAll`. Bypasses the GPU /
// mapAsync chain entirely to reach ~3-6 ms input-to-audible latency on
// tuned hardware. See the README's "Achieving pro-audio tracking latency"
// section for the full pattern + latency math.

export { BridgeInputLane } from "./BridgeInputLane.js";

// ── Audio-rate / block-rate consumption (0.7.13 — Track 3) ────────────────
//
// `BridgeBlockConsumer<S>` carves AudioWorklet-quantum-sized chunks (128
// samples by convention) out of producer-side blocks (e.g. 1024 PCM
// samples per frame from a GPU compute shader). Owns a per-sample cursor
// inside the currently checked-out frame; pulls the next frame on cursor
// exhaustion. Three underflow policies select what happens on ring-empty.
// See src/BridgeBlockConsumer.ts header + README "Audio-rate mode" for
// the latency floor math.

export { BridgeBlockConsumer } from "./BridgeBlockConsumer.js";
export type {
  BlockUnderflowPolicy,
  BlockChannelLayout,
  BridgeBlockConsumerOptions,
} from "./BridgeBlockConsumer.js";

// ── Graceful degradation — quality-hint controller (0.9.51) ───────────────
//
// `ResidualQualityController` is the producer-side companion to
// `BridgeBlockConsumer`'s underflow telemetry (`underflowRate`,
// `lastSuccessfulPullTime`, `elapsedSeconds`). It maps a back-pressure signal
// — the existing `flow_scale` lane (Option 1, zero new wire) or the consumer's
// measured `underflowRate` over a back-channel (Option 2) — into a smoothed,
// hysteretic `suggestedQualityScale` the GPU worker applies to its own knobs
// (partial count, workgroup count, …) so the residual THINS before it
// glitches. Closes Gaps #8 + #12. See docs/underflow-quality-degradation-*.
export { ResidualQualityController } from "./ResidualQualityController.js";
export type {
  ResidualQualityHint,
  ResidualQualityControllerOptions,
} from "./ResidualQualityController.js";

// ── GPU readback automation (0.6.18) ──────────────────────────────────────
//
// The headline helper that closes the loop from "compute pass on the GPU"
// to "AudioWorklet pull" with automated staging-buffer ring + mapAsync
// overlap. See src/BridgeGPUSource.ts for the lifecycle + WebGPU typing
// approach.

export { BridgeGPUSource } from "./BridgeGPUSource.js";
export type {
  GpuBufferLike,
  GpuDeviceLike,
  GpuCommandEncoderLike,
  GpuReadbackDecoder,
  BridgeGPUSourceOptions,
  // Zero-copy WriteTarget scaffold (0.7.15 — Track 4). The strategy
  // interface and the kind selector are exported as types so callers
  // see the shape; today only the `'map-async'` resolution path is
  // implemented. See `getEnvironmentReport().webgpuZeroCopy` for the
  // platform capability sniff.
  WriteTarget,
  WriteTargetKind,
} from "./BridgeGPUSource.js";

// ── Block-shaped GPU readback adapter (0.7.14 — Track 3) ──────────────────
//
// `BridgeBlockProducer<S>` is the producer-side companion to
// `BridgeBlockConsumer<S>`. Wraps `BridgeGPUSource<S>` with a decoder that
// automatically copies a compute-shader output buffer's PCM samples into
// the schema's lone `f32Array` field, optionally maintaining an auto-
// increment `u64` block index. See src/BridgeBlockProducer.ts header +
// README "Audio-rate mode" for the pacing math.

export { BridgeBlockProducer } from "./BridgeBlockProducer.js";
export type {
  BridgeBlockProducerOptions,
} from "./BridgeBlockProducer.js";

// ── Environment diagnostics (0.7.1) ───────────────────────────────────────
//
// Synchronous, frozen snapshot of the host environment relative to the
// library's two transport tiers — `crossOriginIsolated`, SAB, Atomics,
// AudioWorklet, WebGPU. Deliberately disjoint from `Bridge<S>.telemetry()`:
// platform reflection vs ring runtime. See src/environment.ts header for
// the disjoint-by-design contract.

export { getEnvironmentReport } from "./environment.js";
export type {
  EnvironmentReport,
  EnvironmentFix,
  EstimatedLatencyFloorMs,
} from "./environment.js";

export {
  defineSchema,
  describeSchemaLayout,
  kindByteSize,
  kindTsType,
  // Scalar field constructors
  u64, i64, u32, i32, u16, i16, u8, i8, f64, f32,
  // Array field constructors
  u64Array, i64Array, u32Array, i32Array, u16Array, i16Array,
  u8Array, i8Array, f64Array, f32Array,
  // Trajectory array constructors (0.6.1 — Pillar 1 scaffolding)
  f64TrajectoryArray, f32TrajectoryArray,
} from "./schema.js";

export type {
  FieldKind,
  FieldSpec,
  FieldsObject,
  Schema,
  CompiledField,
  CompiledLayout,
  FrameFor,
  SchemaLayoutDescription,
  SchemaLayoutFieldDescription,
  TrajectoryOrder,
  TrajectorySpec,
  TrajectoryOverflowFallback,
  TrajectoryInterpolationMode,
  TrajectoryArrayOptions,
  WithInvariantOptions,
} from "./schema.js";

export { DEFAULT_INVARIANT_ABSOLUTE_EPSILON } from "./schema.js";

// Trajectory evaluator — consumer-side Taylor extrapolation helper that
// reads the f{32,64}TrajectoryArray tag. See src/trajectory.ts header.
// 0.7.3 adds the two-frame Hermite cubic reconstruction path; 0.9.80 adds the
// quintic Hermite (C²) path over the order-3 acceleration lane; 0.9.81 adds the
// septic Hermite (C³) path over the order-4 jerk lane.
export {
  evaluateTrajectoryInto,
  evaluateHermiteTrajectoryInto,
  evaluateQuinticHermiteTrajectoryInto,
  evaluateSepticHermiteTrajectoryInto,
} from "./trajectory.js";

// ── Click-free crossfade primitive (0.9.87 — God-Node Stage 1) ─────────────
//
// The seam-blend math underneath a live hot-swap: `crossfadeWeight(order)`
// returns the C^k smootherstep weight schedule (cubic/quintic/septic = the
// SAME position-to-position Hermite basis as the trajectory evaluators above),
// and `crossfadeInto(a, b, w, out, opts?)` blends two evaluated signal buffers
// `a → b` under that weight (amplitude or equal-power). Matching the crossfade
// order to the reconstruction order makes the whole swap — interior AND seam —
// C^k continuous, so the transition is click-free. Foundational slice of
// Apollo Frontier 4 (the real-time self-rewriting emitter). See
// src/crossfade.ts header for the continuity proof + mode rationale.
export { crossfadeWeight, crossfadeInto } from "./crossfade.js";
export type {
  CrossfadeContinuity,
  CrossfadeMode,
  CrossfadeOptions,
} from "./crossfade.js";

// ── Live hot-swap orchestration (0.9.88 — God-Node Stage 2) ────────────────
//
// `HotSwapConsumer<S>` holds an OLD + a NEW bridge (same schema), reconstructs
// both per quantum via `pullHermiteLatest`, and crossfades `a → b` over a
// configurable window driven by the audio clock — the two-bridge orchestration
// above the Stage-1 seam primitive. State machine idle → priming → fading →
// complete; the window clock anchors to when `b` becomes ready (not to
// arm-time) so the fade onset is click-free. Single-responsibility: it owns the
// swap state + dual reconstruction + the weight schedule (`weightAt`), and the
// caller blends with `crossfadeInto`. Cross-schema migration is Stage 3. See
// src/HotSwapConsumer.ts header.
export { HotSwapConsumer } from "./HotSwapConsumer.js";
export type {
  HotSwapPhase,
  HotSwapConsumerOptions,
  HotSwapPullResult,
} from "./HotSwapConsumer.js";

// ── Cross-schema migration planner (0.9.89 — God-Node Stage 3) ─────────────
//
// `migratePlan(oldLayout, newLayout, opts?)` diffs two `describeLayout()`
// descriptions into a per-field hot-swap plan: common/renamed fields
// `crossfade`, b-only fields `rampIn` from a default, a-only fields `drop`.
// Incompatible reshapes (bigint↔number, array length, trajectory order) split
// into ramp-in + drop. Pure data-in/data-out — the cross-schema companion to
// `HotSwapConsumer`'s same-schema swap; the caller drives the per-field blend
// from the plan using the swap's weight schedule. See src/migratePlan.ts.
export { migratePlan } from "./migratePlan.js";
export type {
  MigratePlan,
  MigratePlanOptions,
  MigrateBlend,
  MigrateCrossfadeField,
  MigrateRampInField,
  MigrateDropField,
} from "./migratePlan.js";

// Canonical schemas — see src/schemas/physics.ts.
export { physicsControlFrameSchema } from "./schemas/physics.js";
export type { PhysicsControlFrameSchema } from "./schemas/physics.js";

// ── Confidence-bounded predictive extrapolation ───────────────────────────
//
// Wraps `evaluateTrajectoryInto` with a documented confidence→horizon curve
// so forward prediction degrades gracefully as the consumer clock's
// uncertainty grows: low confidence shrinks the effective horizon AND
// crossfades back toward an order-1 hold; a cold/unlocked PLL collapses to
// pure hold. Pure + decoupled — consumes a plain `PllUncertainty` snapshot,
// not a `ConsumerClockRecovery` instance. See src/predictiveExtrapolation.ts.

export { predictiveExtrapolateInto } from "./predictiveExtrapolation.js";
export type {
  PllUncertainty,
  PredictiveExtrapolationConfig,
  PredictiveExtrapolationResult,
} from "./predictiveExtrapolation.js";

// ── Deterministic record / replay timeline ────────────────────────────────
//
// `TimelineRecorder<S>` captures pushed frames as `(tMacroNs, frame)` tuples
// and `serialize()`s them to a compact schema-tagged container; `deserialize`
// rebuilds a `TimelinePlayer<S>` that re-renders bit-identically by feeding a
// synthesized deterministic consumer clock through the pure Taylor evaluator
// (the PLL is removed from the replay loop). Standalone additive module — zero
// changes to the wire format. See src/TimelineRecorder.ts.

export {
  TimelineRecorder,
  TimelinePlayer,
  deserialize,
  TimelineSchemaMismatchError,
  TimelineFormatError,
} from "./TimelineRecorder.js";
export type {
  TimelineTuple,
  TimelineRecorderOptions,
} from "./TimelineRecorder.js";

// ── Worklet frame-reader codegen ───────────────────────────────────────────
//
// `emitWorkletReader` emits, as a SOURCE STRING, a zero-import, monomorphized
// DataView frame reader specialized to one exact schema — every field byte
// offset baked in as a numeric literal, no runtime offset math, no library
// import on the audio thread. Paste the emitted string straight into a built
// AudioWorklet module. See src/emitWorkletReader.ts.

// The convenience layer (0.9.47) closes the source-string boundary:
// `emitWorkletProcessorModule` wraps the reader in a self-registering
// `AudioWorkletProcessor` module; `toWorkletModuleURL` Blobs any emitted source
// into an `addModule`-ready object URL; `compileWorkletReader` `new Function`s
// the reader for tests / Standard-mode main-thread consumers (NOT the audio
// thread). The source-crossing boundary + CSP trade-off remain documented
// (build-step path stays the CSP-safe default). See README §codegen.
export {
  emitWorkletReader,
  emitWorkletProcessorModule,
  toWorkletModuleURL,
  compileWorkletReader,
} from "./emitWorkletReader.js";
export type {
  EmitWorkletReaderOptions,
  EmitWorkletReaderInput,
  EmitWorkletProcessorOptions,
} from "./emitWorkletReader.js";

// ── WGSL struct codegen ────────────────────────────────────────────────────
//
// `emitWgslStruct` emits, as a SOURCE STRING, a WGSL `struct` whose memory
// layout is byte-isomorphic to the SAB frame `Bridge` reads/writes for the same
// `Schema` — making the TS Schema the single source of truth for the GPU-side
// struct and eliminating the WGSL/TS "alignment trap". Sub-32-bit kinds are
// rejected (WgslUnsupportedKindError); 64-bit kinds byte-transport as
// vec2<u32>. Pairs with `BridgeGPUSource(device, bridge, "raw")` for a
// zero-decode GPU→SAB readback. See src/emitWgslStruct.ts.
export {
  emitWgslStruct,
  computeWgslLayout,
  WgslUnsupportedKindError,
} from "./emitWgslStruct.js";
export type {
  EmitWgslStructOptions,
  EmitWgslStructInput,
  WgslMember,
  WgslLayout,
} from "./emitWgslStruct.js";

// ── WASM whole-frame decoder codegen ───────────────────────────────────────
//
// `emitWasmDecoder` emits, as a SOURCE STRING, a monomorphized WAT module that
// decodes one ring slot into a scratch region with every field offset baked in
// as an `i32.const` literal — the WAT sibling of `emitWorkletReader` (JS) and
// `emitWgslStruct` (WGSL). Unlike the packaged GENERIC `decode_frame` (which
// loops a runtime descriptor table), a generated decoder is straight-line: no
// descriptor blit, no loop, and contiguous fields coalesce into a single
// `memory.copy`. Byte-identical to the generic path; bit-exact to Bridge.pull.
// Compile with any WAT→wasm compiler (e.g. `wabt`) and instantiate against the
// shared SAB memory. See src/emitWasmDecoder.ts.
export {
  emitWasmDecoder,
  planWasmDecoder,
} from "./emitWasmDecoder.js";
export type {
  EmitWasmDecoderOptions,
  EmitWasmDecoderInput,
  WasmDecoderField,
  WasmDecoderCopy,
  WasmDecoderPlan,
} from "./emitWasmDecoder.js";
