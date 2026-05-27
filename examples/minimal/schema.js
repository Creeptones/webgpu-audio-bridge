// schema.js — shared frame definition for the minimal demo.
//
// Imported by main.js (for sizing the SAB and getting describeLayout()) and
// by worker.js (for constructing the Bridge instance). The worklet does NOT
// import this — it receives a JSON-safe SchemaLayoutDescription via
// processorOptions and reconstructs typed-array views from byte offsets.
// That keeps the audio thread free of library imports.

import {
  defineSchema,
  f64,
  f64Array,
  u64,
} from "../../dist/index.js";

export const N = 4;            // 4 harmonic frequencies in the demo
export const CAPACITY = 16;    // 16 slots at 60Hz = ~266ms of buffered macro state

/**
 * The canonical physics control frame. u64 seq/tMacroNs (BigInt) for proper
 * 64-bit semantics — no `≤ 2^53` precision caveat.
 */
export function makeSchema(n = N) {
  return defineSchema({
    seq:      u64(),
    tMacroNs: u64(),
    vMax:     f64(),
    jMax:     f64(),
    vEff:     f64Array(n),
    jEff:     f64Array(n),
  });
}
