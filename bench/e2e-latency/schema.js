// schema.js — shared frame definition for the e2e-latency bench.
//
// All-f64 layout (f64 for every field, including seq and tMacroNs) rather
// than the recommended `physicsControlFrameSchema(n)` (u64 for seq/tMacroNs).
// The latency bench measures sub-microsecond timing by stamping
// `performance.now() * 1e6` (which carries sub-µs fractional digits) into
// tMacroNs; storing the value as a BigInt would require truncating the
// fraction. The bench's noise floor is well above 1µs in practice but
// preserving the f64 lane keeps the measurement identical to the v0.1.x
// baseline this harness was originally calibrated against.
//
// This was previously expressed via `legacyPhysicsControlFrameSchema(n)`.
// That helper was removed at 0.9.0 alongside the rest of the legacy
// surface; the inline `defineSchema(...)` form below produces byte-
// identical SAB contents and is the canonical pattern for any caller that
// specifically wants number-typed timestamps with sub-integer precision
// and doesn't need 64-bit counter semantics.

import { defineSchema, f64, f64Array } from "../../dist/index.js";

export function makeSchema(n) {
  return defineSchema({
    seq:      f64(),
    tMacroNs: f64(),
    vMax:     f64(),
    jMax:     f64(),
    vEff:     f64Array(n),
    jEff:     f64Array(n),
  });
}
