/**
 * webgpu-audio-bridge
 *
 * Lock-free SPSC SharedArrayBuffer ring for streaming structured frames from
 * a Web Worker (typically driving WebGPU compute) into an AudioWorklet â€” the
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
 *     protocol â€” a facade-built peer interoperates with a Bridge-built peer.
 *
 * The 0.9.0 release removed three legacy surfaces (`Float64RingBuffer`, the
 * `legacyPhysicsControlFrameSchema(n)` byte-twin, and the
 * `BridgeBlockConsumer` `underflowPolicy: 'throw'` arm). If you need any
 * of those, pin `webgpu-audio-bridge@0.8.x` â€” see CHANGELOG `[0.9.0]` for
 * the migration guide.
 *
 * See README.md for the architectural pattern and use cases.
 */

// â”€â”€ Recommended: Bridge<Schema> â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export { Bridge, RING_HEADER_BYTES, RING_HEADER_LANES } from "./Bridge.js";
// Real-time-safety role lattice (0.9.45). `Bridge<S, Role>` brands a handle
// with the thread role it lives on; on `"worklet"` the MAY-BLOCK methods
// (`waitForData` / `waitForSpace`) and the interval-based `subscribeTelemetry`
// are structurally absent â€” calling them is a compile error. The brand is a
// phantom (zero runtime cost); `DefaultRole = "worker"` keeps a bare
// `Bridge<S>` fully compatible. `forWorklet` / `forWorker` are role-stamping
// factories over a single `Bridge.allocate(...)`. See
// docs/rt-safety-lattice-design.md.
export { forWorklet, forWorker } from "./Bridge.js";
// Predictive "negative latency" mode (0.9.71) â€” `pullPredictedLatest` +
// `lastReadbackMedianMs` live on the Bridge class; the lead ceiling constant
// and the option / result shapes are exported for callers + tests.
export { DEFAULT_MAX_LEAD_MS } from "./Bridge.js";
export {
  DEFAULT_KALMAN_PROCESS_NOISE,
  DEFAULT_KALMAN_MEAS_POS_NOISE,
  DEFAULT_KALMAN_INITIAL_VARIANCE,
} from "./Bridge.js";
export type { BridgeRole, DefaultRole } from "./Bridge.js";
export type {
  BridgeAllocation,
  BridgeOptions,
  SmoothedPullOptions,
  SmootherSkipPolicy,
  PredictedPullOptions,
  PredictedPullResult,
  KalmanPredictedPullOptions,
  KalmanPredictedPullResult,
  // Observability snapshot + subscription seam (0.7.3)
  TelemetrySnapshot,
  TelemetryListener,
  TelemetryUnsubscribe,
  SubscribeTelemetryOptions,
} from "./Bridge.js";

// â”€â”€ Telemetry history ring (0.9.76) â€” rolling diagnostic buffer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fixed-size, allocation-free history layer that composes with
// `Bridge.subscribeTelemetry` (the push-callback) to retain the last N ticks.
export { TelemetryRing } from "./TelemetryRing.js";
export type { TelemetryRingSample, TelemetryRingOptions } from "./TelemetryRing.js";

// â”€â”€ Standard mode (0.9.40) â€” MessageChannelBridge<Schema> â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Sibling tier to `Bridge<S>`'s Turbo mode. Same schema DSL surface,
// `MessageChannel` + transferable `ArrayBuffer` transport instead of
// `SharedArrayBuffer` + `Atomics`. Does NOT require cross-origin
// isolation. Latency floor 5-50 ms per round trip (vs Turbo's sub-Âµs).
// **Not for audio rate.** Right for prototyping before COOP/COEP is
// configured, control-plane updates in unisolated embeds, telemetry
// channels, anything non-audio-critical. See README Â§Standard mode for
// the full picture and `docs/standard-mode-design.md` for the MVP1
// scope decisions.

export { MessageChannelBridge } from "./MessageChannelBridge.js";
export type {
  MessageChannelBridgeAllocation,
} from "./MessageChannelBridge.js";

// â”€â”€ One-call topology constructor (0.9.46) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `connect(spec)` collapses the multi-step Turbo setup recipe (allocate +
// size + postMessage + reconstruct-per-peer + COOP/COEP guard) into one call
// plus a symmetric `mount(handle, opts)`. It probes the environment via
// `getEnvironmentReport()`, picks Turbo (SAB) vs Standard (MessageChannel) vs
// a graceful `ConnectUnsupportedError` carrying `report.fixes`, sizes the
// ring(s) from a `latencyHint`, and returns a clone-safe handle to
// `postMessage`. Pure assembly over the shipped facades â€” no new wire format.
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

// â”€â”€ Composable primitives (0.6.10) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
export { StatePredictor } from "./StatePredictor.js";
export type { StatePredictorModel, StatePredictorOptions } from "./StatePredictor.js";

export { BridgeConsumer } from "./BridgeConsumer.js";
export type {
  BridgeConsumerOptions,
  InvariantFailurePolicy,
  InvariantFailureCallback,
} from "./BridgeConsumer.js";
export { BridgeProducer } from "./BridgeProducer.js";

// â”€â”€ Pro-audio tracking fast lane (0.6.19) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Event-queue facade for the "input lane" pattern: a separate Bridge
// dedicated to gestural input (MIDI / touch / slider events) that the
// AudioWorklet drains every quantum via `pullAll`. Bypasses the GPU /
// mapAsync chain entirely to reach ~3-6 ms input-to-audible latency on
// tuned hardware. See the README's "Achieving pro-audio tracking latency"
// section for the full pattern + latency math.

export { BridgeInputLane } from "./BridgeInputLane.js";

// â”€â”€ Audio-rate / block-rate consumption (0.7.13 â€” Track 3) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Graceful degradation â€” quality-hint controller (0.9.51) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `ResidualQualityController` is the producer-side companion to
// `BridgeBlockConsumer`'s underflow telemetry (`underflowRate`,
// `lastSuccessfulPullTime`, `elapsedSeconds`). It maps a back-pressure signal
// â€” the existing `flow_scale` lane (Option 1, zero new wire) or the consumer's
// measured `underflowRate` over a back-channel (Option 2) â€” into a smoothed,
// hysteretic `suggestedQualityScale` the GPU worker applies to its own knobs
// (partial count, workgroup count, â€¦) so the residual THINS before it
// glitches. Closes Gaps #8 + #12. See docs/underflow-quality-degradation-*.
export { ResidualQualityController } from "./ResidualQualityController.js";
export type {
  ResidualQualityHint,
  ResidualQualityControllerOptions,
} from "./ResidualQualityController.js";

// â”€â”€ GPU readback automation (0.6.18) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  ReadbackLatencyStats,
  ReadbackBackpressureMode,
  ReadbackPacingMode,
  ReadbackAction,
  ReadbackPressureSnapshot,
  RawReadbackCompatibility,
  RawReadbackCompatibilityOptions,
  RawReadbackCompatibilityReason,
  PartialReadbackInitialFrame,
  // Zero-copy WriteTarget scaffold (0.7.15 â€” Track 4). The strategy
  // interface and the kind selector are exported as types so callers
  // see the shape; today only the `'map-async'` resolution path is
  // implemented. See `getEnvironmentReport().webgpuZeroCopy` for the
  // platform capability sniff.
  WriteTarget,
  WriteTargetKind,
} from "./BridgeGPUSource.js";

// â”€â”€ Block-shaped GPU readback adapter (0.7.14 â€” Track 3) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Environment diagnostics (0.7.1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Synchronous, frozen snapshot of the host environment relative to the
// library's two transport tiers â€” `crossOriginIsolated`, SAB, Atomics,
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
  // Trajectory array constructors (0.6.1 â€” Pillar 1 scaffolding)
  f64TrajectoryArray, f32TrajectoryArray,
  // Circular (angular) field constructors (0.9.935 â€” Topological Lanes)
  f64Phase, f32Phase, f64Circular, f32Circular,
  f64PhaseArray, f32PhaseArray, f64CircularArray, f32CircularArray,
  f64CircularTrajectoryArray, f32CircularTrajectoryArray,
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
  TrajectoryLayout,
  TrajectorySpec,
  TrajectoryOverflowFallback,
  TrajectoryInterpolationMode,
  TrajectoryArrayOptions,
  WithInvariantOptions,
  // Circular lanes (0.9.935)
  CircularSpec,
  CircularOptions,
  CircularTrajectoryArrayOptions,
} from "./schema.js";

export { DEFAULT_INVARIANT_ABSOLUTE_EPSILON } from "./schema.js";

// Trajectory evaluator â€” consumer-side Taylor extrapolation helper that
// reads the f{32,64}TrajectoryArray tag. See src/trajectory.ts header.
// 0.7.3 adds the two-frame Hermite cubic reconstruction path; 0.9.80 adds the
// quintic Hermite (CÂ²) path over the order-3 acceleration lane; 0.9.81 adds the
// septic Hermite (CÂ³) path over the order-4 jerk lane.
export {
  evaluateTrajectoryInto,
  evaluateHermiteTrajectoryInto,
  evaluateQuinticHermiteTrajectoryInto,
  evaluateSepticHermiteTrajectoryInto,
  // Circular (angular) evaluators â€” shorter-arc Taylor + cubic Hermite over a
  // phase lane, re-wrapped at output. 0.9.935 (Topological Lanes).
  evaluateCircularTrajectoryInto,
  evaluateCircularHermiteTrajectoryInto,
} from "./trajectory.js";

// â”€â”€ Circular (angular) lane math (0.9.935 â€” Topological Lanes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The dependency-free topological core under `f64Phase` / `f64Circular`:
// `wrapSymmetric` (project onto [âˆ’P/2, +P/2)), `shortestArcDelta` (signed
// shorter-arc difference), `circularLerp` (geodesic blend), and
// `CircularUnwrapper` (lift a wrapped stream onto the covering space â„,
// tracking the winding number + counting cycle slips â€” the angular monodromy
// diagnostic). See src/circular.ts + docs/topological-lanes-design.md.
export {
  wrapSymmetric,
  shortestArcDelta,
  circularLerp,
  CircularUnwrapper,
  TWO_PI,
} from "./circular.js";

// Canonical schemas â€” see src/schemas/physics.ts.
export { physicsControlFrameSchema } from "./schemas/physics.js";
export type { PhysicsControlFrameSchema } from "./schemas/physics.js";

// â”€â”€ Confidence-bounded predictive extrapolation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Wraps `evaluateTrajectoryInto` with a documented confidenceâ†’horizon curve
// so forward prediction degrades gracefully as the consumer clock's
// uncertainty grows: low confidence shrinks the effective horizon AND
// crossfades back toward an order-1 hold; a cold/unlocked PLL collapses to
// pure hold. Pure + decoupled â€” consumes a plain `PllUncertainty` snapshot,
// not a `ConsumerClockRecovery` instance. See src/predictiveExtrapolation.ts.

export { predictiveExtrapolateInto } from "./predictiveExtrapolation.js";
export type {
  PllUncertainty,
  PredictiveExtrapolationConfig,
  PredictiveExtrapolationResult,
} from "./predictiveExtrapolation.js";

// â”€â”€ Deterministic record / replay timeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `TimelineRecorder<S>` captures pushed frames as `(tMacroNs, frame)` tuples
// and `serialize()`s them to a compact schema-tagged container; `deserialize`
// rebuilds a `TimelinePlayer<S>` that re-renders bit-identically by feeding a
// synthesized deterministic consumer clock through the pure Taylor evaluator
// (the PLL is removed from the replay loop). Standalone additive module â€” zero
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

// â”€â”€ Worklet frame-reader codegen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `emitWorkletReader` emits, as a SOURCE STRING, a zero-import, monomorphized
// DataView frame reader specialized to one exact schema â€” every field byte
// offset baked in as a numeric literal, no runtime offset math, no library
// import on the audio thread. Paste the emitted string straight into a built
// AudioWorklet module. See src/emitWorkletReader.ts.

// The convenience layer (0.9.47) closes the source-string boundary:
// `emitWorkletProcessorModule` wraps the reader in a self-registering
// `AudioWorkletProcessor` module; `toWorkletModuleURL` Blobs any emitted source
// into an `addModule`-ready object URL; `compileWorkletReader` `new Function`s
// the reader for tests / Standard-mode main-thread consumers (NOT the audio
// thread). The source-crossing boundary + CSP trade-off remain documented
// (build-step path stays the CSP-safe default). See README Â§codegen.
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

// â”€â”€ WGSL struct codegen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `emitWgslStruct` emits, as a SOURCE STRING, a WGSL `struct` whose memory
// layout is byte-isomorphic to the SAB frame `Bridge` reads/writes for the same
// `Schema` â€” making the TS Schema the single source of truth for the GPU-side
// struct and eliminating the WGSL/TS "alignment trap". Sub-32-bit kinds are
// rejected (WgslUnsupportedKindError); 64-bit kinds byte-transport as
// vec2<u32>. Pairs with `BridgeGPUSource(device, bridge, "raw")` for a
// zero-decode GPUâ†’SAB readback. See src/emitWgslStruct.ts.
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

// â”€â”€ WASM whole-frame decoder codegen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `emitWasmDecoder` emits, as a SOURCE STRING, a monomorphized WAT module that
// decodes one ring slot into a scratch region with every field offset baked in
// as an `i32.const` literal â€” the WAT sibling of `emitWorkletReader` (JS) and
// `emitWgslStruct` (WGSL). Unlike the packaged GENERIC `decode_frame` (which
// loops a runtime descriptor table), a generated decoder is straight-line: no
// descriptor blit, no loop, and contiguous fields coalesce into a single
// `memory.copy`. Byte-identical to the generic path; bit-exact to Bridge.pull.
// Compile with any WATâ†’wasm compiler (e.g. `wabt`) and instantiate against the
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
