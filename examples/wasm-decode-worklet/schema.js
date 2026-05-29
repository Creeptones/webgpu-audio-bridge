// schema.js — the macro frame for the WASM-decode example.
//
// A compact additive-synth control frame: 8 partial frequencies (vEff) + 8
// gains (gEff), plus seq/timestamp/peak scalars and an order-2 trajectory lane
// (carried to exercise the decoder's trajectory handling, not used by the
// synth). Imported by main.js (sizing + layout + codegen) and worker.js (the
// Bridge producer). The worklet does NOT import this — it gets a JSON layout +
// descriptor table via processorOptions.

import {
  defineSchema, f64, f32, u64, u32,
  f64Array, f32Array, f64TrajectoryArray,
} from "../../dist/index.js";

export const N = 8;          // partials
export const CAPACITY = 16;

export function makeSchema() {
  return defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    vMax: f64(),
    flags: u32(),
    vEff: f64Array(N),                       // partial frequencies (Hz)
    gEff: f32Array(N),                       // partial gains (0..1)
    traj: f64TrajectoryArray(N, { order: 2 }), // carried, decoded, unused by synth
  });
}
