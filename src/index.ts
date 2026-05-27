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
} from "./BridgeGPUSource.js";

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
  WithInvariantOptions,
} from "./schema.js";

export { DEFAULT_INVARIANT_ABSOLUTE_EPSILON } from "./schema.js";

// Trajectory evaluator — consumer-side Taylor extrapolation helper that
// reads the f{32,64}TrajectoryArray tag. See src/trajectory.ts header.
export { evaluateTrajectoryInto } from "./trajectory.js";

// Canonical schemas — see src/schemas/physics.ts.
export {
  physicsControlFrameSchema,
  legacyPhysicsControlFrameSchema,
} from "./schemas/physics.js";
export type {
  PhysicsControlFrameSchema,
  LegacyPhysicsControlFrameSchema,
} from "./schemas/physics.js";

// ── Legacy (deprecated): Float64RingBuffer ─────────────────────────────────

/**
 * @deprecated 0.3.0 — replaced by `Bridge<Schema>` with
 * `physicsControlFrameSchema(n)`. The legacy class is preserved unchanged
 * for v0.1.x byte-compat and will be removed no earlier than 2.0.
 */
export {
  Float64RingBuffer,
  RING_FRAME_PRELUDE,
  type RingFrameHeader,
  type RingAllocation,
} from "./Float64RingBuffer.js";
