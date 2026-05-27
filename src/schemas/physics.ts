/**
 * Canonical "control-rate physics" frame schemas.
 *
 * These ship as ready-made schemas for the WebGPU → AudioWorklet macro/micro
 * pattern that this library was originally designed around:
 *
 *   - `physicsControlFrameSchema(n)` — recommended for new code. Uses u64
 *     for `seq` and `tMacroNs` so the monotonic counter and the wall-clock
 *     timestamp escape the `≤ 2^53` precision caveat of f64-as-Number that
 *     the legacy Float64RingBuffer header carries.
 *
 *   - `legacyPhysicsControlFrameSchema(n)` — wire-compatible with v0.1.x
 *     `Float64RingBuffer` bytes. Uses f64 for every field (including seq
 *     and tMacroNs). Bridge<legacyPhysicsControlFrameSchema(N)> produces
 *     byte-identical SAB contents to `new Float64RingBuffer(sab, capacity, N)`.
 *     Choose this if you're porting from Float64RingBuffer line-by-line and
 *     want number-typed seq access. New code should prefer the u64 variant.
 *
 * Both schemas describe one "macro frame" of physics control data:
 *
 *   seq         monotonic frame counter
 *   tMacroNs    producer timestamp in nanoseconds (best-effort)
 *   vMax        precomputed max(|V_eff|) — saves the consumer from scanning
 *   jMax        precomputed max(|J_eff|)
 *   V_eff[N]    effective potential / parameter envelope, N samples per frame
 *   J_eff[N]    effective driving / gain envelope, N samples per frame
 *
 * `N` is set by the caller (e.g. 8, 16, 64, 128) and is fixed for the
 * lifetime of the schema instance.
 */

import { defineSchema, f64, f64Array, u64, type Schema } from "../schema.js";

/**
 * Recommended schema for new code. `seq` and `tMacroNs` are u64 (BigInt) for
 * proper 64-bit semantics — no `≤ 2^53` precision caveat. Bytes on the wire
 * are NOT compatible with v0.1.x Float64RingBuffer (which stores those fields
 * as f64-via-Number); use legacyPhysicsControlFrameSchema(n) for wire-compat.
 */
export function physicsControlFrameSchema(n: number) {
  return defineSchema({
    seq:      u64(),
    tMacroNs: u64(),
    vMax:     f64(),
    jMax:     f64(),
    vEff:     f64Array(n),
    jEff:     f64Array(n),
  });
}

/** TS type of the frame view for `physicsControlFrameSchema(n)`. */
export type PhysicsControlFrameSchema = ReturnType<typeof physicsControlFrameSchema>;

/** Module-global one-shot guard for the legacy schema's runtime deprecation
 *  warning. We warn at most once per process load — the `@deprecated`
 *  JSDoc gives the IDE-time strikethrough; this is the runtime backstop. */
let _legacyPhysicsControlFrameSchemaDeprecationWarned = false;

/**
 * @deprecated 0.8.11 — scheduled for removal at 0.9.0 (the pre-1.0
 * breaking cut). Byte-compatible with v0.1.x `Float64RingBuffer` (also
 * removed at 0.9.0). All fields are f64 (Number) — same lane layout, same
 * SAB byte sequence per frame. Use this if you're migrating from
 * `Float64RingBuffer` and want to preserve the exact wire format, or want
 * number-typed seq/tMacroNs reads at the cost of the `≤ 2^53` precision
 * caveat. New code should prefer `physicsControlFrameSchema(n)` instead.
 *
 * If you cannot migrate before 0.9.0, pin `webgpu-audio-bridge@0.8.x` (or
 * the v0.1.1 npm tarball for the original `Float64RingBuffer` surface).
 */
export function legacyPhysicsControlFrameSchema(n: number) {
  if (!_legacyPhysicsControlFrameSchemaDeprecationWarned) {
    _legacyPhysicsControlFrameSchemaDeprecationWarned = true;
    console.warn(
      "[webgpu-audio-bridge] legacyPhysicsControlFrameSchema() is " +
      "deprecated and will be removed at 0.9.0 (the pre-1.0 breaking " +
      "cut). Migrate to physicsControlFrameSchema(n) (u64 seq/tMacroNs); " +
      "see CHANGELOG.md for the wire-format diff. Pin " +
      "webgpu-audio-bridge@0.8.x if you cannot migrate before 0.9.0.",
    );
  }
  return defineSchema({
    seq:      f64(),
    tMacroNs: f64(),
    vMax:     f64(),
    jMax:     f64(),
    vEff:     f64Array(n),
    jEff:     f64Array(n),
  });
}

/** @deprecated 0.8.11 — removed at 0.9.0. TS type of the frame view for
 *  `legacyPhysicsControlFrameSchema(n)`. */
export type LegacyPhysicsControlFrameSchema = ReturnType<typeof legacyPhysicsControlFrameSchema>;

// Surface the Schema marker for downstream type-only consumers.
export type { Schema };
