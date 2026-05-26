/**
 * webgpu-audio-bridge
 *
 * Lock-free SPSC SharedArrayBuffer ring for streaming structured frames from
 * a Web Worker (typically driving WebGPU compute) into an AudioWorklet — the
 * control-rate-GPU / audio-rate-CPU pattern.
 *
 * Two public surfaces:
 *
 *   - `Bridge<Schema>` (recommended for new code): schema-driven frame
 *     codec. Describe your frame with `defineSchema({ ... })` and arbitrary
 *     primitive types (f64/f32/u64/i64/u32/i32/u16/i16/u8/i8 scalars and
 *     arrays). Ship in 0.3.
 *
 *   - `Float64RingBuffer` (deprecated): the original hard-coded
 *     `[seq, tMacroNs, vMax, jMax] + V_eff[N] + J_eff[N]` Float64 frame.
 *     Still exported, kept as-is for v0.1.x byte-compat. Slated for removal
 *     no earlier than 2.0. New code should prefer `Bridge` +
 *     `physicsControlFrameSchema(n)`.
 *
 * See README.md for the architectural pattern and use cases.
 */

// ── New (recommended): Bridge<Schema> ──────────────────────────────────────

export { Bridge, RING_HEADER_BYTES, RING_HEADER_LANES } from "./Bridge.js";
export type { BridgeAllocation } from "./Bridge.js";

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
} from "./schema.js";

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
