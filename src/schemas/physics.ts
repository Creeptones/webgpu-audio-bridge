/**
 * Canonical "control-rate physics" frame schema.
 *
 * Ships as a ready-made schema for the WebGPU → AudioWorklet macro/micro
 * pattern that this library was originally designed around:
 *
 *   - `physicsControlFrameSchema(n)` — uses u64 for `seq` and `tMacroNs` so
 *     the monotonic counter and the wall-clock timestamp escape the
 *     `≤ 2^53` precision caveat of f64-as-Number.
 *
 * Describes one "macro frame" of physics control data:
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
 *
 * Note for callers porting from the pre-0.9.0 surface: the legacy
 * `legacyPhysicsControlFrameSchema(n)` (all-f64 variant for v0.1.x
 * `Float64RingBuffer` byte-compat) was removed at 0.9.0 alongside the
 * `Float64RingBuffer` class itself. If your producer or consumer
 * specifically needs the all-f64 wire layout (e.g. for sub-microsecond
 * fractional `tMacroNs` precision), declare it inline with `defineSchema({
 * seq: f64(), tMacroNs: f64(), vMax: f64(), jMax: f64(), vEff: f64Array(n),
 * jEff: f64Array(n) })` — the resulting bytes match the removed schema
 * exactly. See CHANGELOG `[0.9.0]` for the migration guide.
 */

import { defineSchema, f64, f64Array, u64, type Schema } from "../schema.js";

/**
 * Recommended schema. `seq` and `tMacroNs` are u64 (BigInt) for proper
 * 64-bit semantics — no `≤ 2^53` precision caveat.
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

// Surface the Schema marker for downstream type-only consumers.
export type { Schema };
