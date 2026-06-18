// schema.js — the control frame the LNN streams into the audio thread.
//
// Imported by main.js (to size the SAB + emit describeLayout()) and worker.js
// (to construct the Bridge). The worklet does NOT import it — it gets a
// JSON-safe layout via processorOptions and rebuilds typed-array views from
// byte offsets, so no library code runs on the audio thread.
//
// SHAPE NOTE: the schema declares EXACTLY ONE f32Array field (`control`). That
// is a hard requirement of BridgeWebNNSource, which treats that array as the
// model's output "samples" vector — here, the LNN's K control outputs. The
// u64 `seq` is auto-incremented by the source on every push; `tMacroNs` is the
// producer clock, stamped via the source's fillScalars hook.

import { defineSchema, u64, f32Array } from "../../dist/index.js";

export const K = 6;          // LNN control outputs per frame
export const CAPACITY = 32;  // 32 slots @100 Hz ≈ 320 ms of buffered control state

export function makeSchema(k = K) {
  return defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    control: f32Array(k),
  });
}
