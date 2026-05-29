// schema.js — the macro-control frame the comparator decodes.
//
// Same shape as bench/decode-path.bench.ts so the browser numbers line up
// with the headless Node numbers: a few scalars + two 64-element arrays + one
// 64×order-2 trajectory (~1.8 KB/frame). Imported by main.js (sizing, layout,
// descriptor + reader codegen) and producer.worker.js (the Bridge instance).
// The worklet does NOT import this — it gets a JSON layout + descriptor table
// + emitted reader source via processorOptions.

import {
  defineSchema,
  f64, f32, u64, u32, i32,
  f64Array, f32Array, f64TrajectoryArray,
} from "../../dist/index.js";

export const ARRAY_N = 64;
export const TRAJ_N = 64;
export const CAPACITY = 16;

export function makeSchema() {
  return defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    vMax: f64(),
    jMax: f64(),
    flags: u32(),
    mode: i32(),
    vEff: f64Array(ARRAY_N),
    gEff: f32Array(ARRAY_N),
    traj: f64TrajectoryArray(TRAJ_N, { order: 2 }),
  });
}
