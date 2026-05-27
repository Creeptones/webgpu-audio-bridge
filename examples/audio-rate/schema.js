// schema.js — shared block-frame definition for the audio-rate demo.
//
// Imported by main.js (for sizing the SAB), by worker.js (for constructing the
// Bridge instance + the BridgeBlockProducer), and by worklet.js (for
// constructing the consumer-side Bridge + the BridgeBlockConsumer).
//
// Block-mode schema: exactly one f32Array field (the samples block) plus a
// u64 blockIndex counter that BridgeBlockProducer auto-increments on every
// successful push. The 1024-sample block size is the demo's canonical choice
// — 8 audio quanta per block at 128-sample quanta and 48 kHz, ≈21.3 ms of
// audio per producer tick. See README §Audio-rate mode for the full latency
// table.

import {
  defineSchema,
  f32Array,
  u64,
} from "../../dist/index.js";

export const BLOCK_SIZE = 1024;
export const CAPACITY = 4;        // 4 blocks = 4096 samples ≈ 85 ms at 48 kHz
export const N_VOICES = 8;        // additive synth — 8 sine partials per block

export function makeSchema(blockSize = BLOCK_SIZE) {
  return defineSchema({
    blockIndex: u64(),
    samples:    f32Array(blockSize),
  });
}
