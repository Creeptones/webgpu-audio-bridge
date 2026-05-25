// schema.js — shared frame definition for the e2e-latency bench.
//
// Uses `legacyPhysicsControlFrameSchema(n)` (f64 for every field, including
// tMacroNs) rather than the recommended `physicsControlFrameSchema(n)` (u64
// for seq/tMacroNs). The latency bench measures sub-microsecond timing by
// stamping `performance.now() * 1e6` (which carries sub-µs fractional digits)
// into tMacroNs; storing the value as a BigInt would require truncating the
// fraction. The bench's noise floor is well above 1µs in practice but
// preserving the f64 lane keeps the measurement identical to the v0.1.x
// baseline this harness was originally calibrated against.
//
// This is the canonical example of when to reach for the legacy schema: any
// time you specifically want number-typed timestamps with sub-integer
// precision and don't need 64-bit counter semantics.

import { legacyPhysicsControlFrameSchema } from "../../dist/index.js";

export function makeSchema(n) {
  return legacyPhysicsControlFrameSchema(n);
}
