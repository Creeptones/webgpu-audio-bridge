/**
 * webgpu-audio-bridge
 *
 * Lock-free SPSC SharedArrayBuffer ring for streaming structured frames from
 * a Web Worker (typically driving WebGPU compute) into an AudioWorklet — the
 * control-rate-GPU / audio-rate-CPU pattern.
 *
 * Three public surfaces:
 *
 *   - `Bridge<Schema>` (recommended for new code): schema-driven frame
 *     codec. Describe your frame with `defineSchema({ ... })` and arbitrary
 *     primitive types (f64/f32/u64/i64/u32/i32/u16/i16/u8/i8 scalars and
 *     arrays). Ships the monolithic producer + consumer API. Shipped 0.3.
 *
 *   - `SpscRing<Schema>` + `BridgeProducer<Schema>` /
 *     `BridgeConsumer<Schema>` + `FrameSmoother<Schema>` /
 *     `ConsumerClockRecovery` / `AdaptiveFlowController` (0.6.10): the
 *     composable alternative. `Bridge<S>` continues to work unchanged; the
 *     facades are for users who want explicit control over which primitives
 *     are wired in and which invariant-failure policy is active. Same SAB
 *     protocol — a facade-built peer interoperates with a Bridge-built peer.
 *
 *   - `Float64RingBuffer` (deprecated): the original hard-coded
 *     `[seq, tMacroNs, vMax, jMax] + V_eff[N] + J_eff[N]` Float64 frame.
 *     Still exported, kept as-is for v0.1.x byte-compat. Slated for removal
 *     no earlier than 2.0. New code should prefer `Bridge` +
 *     `physicsControlFrameSchema(n)`.
 *
 * See README.md for the architectural pattern and use cases.
 */

// ── Recommended: Bridge<Schema> ───────────────────────────────────────────

export { Bridge, RING_HEADER_BYTES, RING_HEADER_LANES } from "./Bridge.js";
export type {
  BridgeAllocation,
  BridgeOptions,
  SmoothedPullOptions,
  SmootherSkipPolicy,
  // Observability snapshot + subscription seam (0.7.3)
  TelemetrySnapshot,
  TelemetryListener,
  TelemetryUnsubscribe,
  SubscribeTelemetryOptions,
} from "./Bridge.js";

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
  BridgeBlockConsumerOptions,
} from "./BridgeBlockConsumer.js";

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
// 0.7.3 adds the two-frame Hermite cubic reconstruction path.
export { evaluateTrajectoryInto, evaluateHermiteTrajectoryInto } from "./trajectory.js";

// Canonical schemas — see src/schemas/physics.ts.
//
// The `legacyPhysicsControlFrameSchema` re-export is deprecated and will be
// removed at 0.9.0 (the pre-1.0 breaking cut). New code should import
// `physicsControlFrameSchema` only. The deprecation tag rides on the
// definition in `src/schemas/physics.ts`; this re-export inherits it.
export {
  physicsControlFrameSchema,
  /** @deprecated 0.8.11 — removed at 0.9.0. See `src/schemas/physics.ts`. */
  legacyPhysicsControlFrameSchema,
} from "./schemas/physics.js";
export type {
  PhysicsControlFrameSchema,
  /** @deprecated 0.8.11 — removed at 0.9.0. */
  LegacyPhysicsControlFrameSchema,
} from "./schemas/physics.js";

// ── Legacy (deprecated): Float64RingBuffer ─────────────────────────────────
//
// **Scheduled for removal at 0.9.0** (the pre-1.0 breaking cut). The
// `@deprecated` tag rides on the class definition in
// `src/Float64RingBuffer.ts`; the runtime backstop warning fires once per
// process from the constructor. Pin `webgpu-audio-bridge@0.8.x` (or the
// v0.1.1 npm tarball for the original surface) if you cannot migrate
// before 0.9.0.

/**
 * @deprecated 0.3.0 — replaced by `Bridge<Schema>` with
 * `physicsControlFrameSchema(n)`. The legacy class is preserved unchanged
 * for v0.1.x byte-compat and is **scheduled for removal at 0.9.0** (the
 * pre-1.0 breaking cut). See `src/Float64RingBuffer.ts` for the full
 * deprecation note + migration path.
 */
export {
  Float64RingBuffer,
  RING_FRAME_PRELUDE,
  type RingFrameHeader,
  type RingAllocation,
} from "./Float64RingBuffer.js";
