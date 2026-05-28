// schema.js — shared block-frame definition for the hybrid-residual demo.
//
// Same shape as examples/audio-rate/schema.js — one f32Array of samples,
// one u64 block index. BridgeBlockConsumer auto-detects both. The block
// size here is 1024 samples (≈21.3 ms at 48 kHz), feeding 8 audio quanta
// per producer tick. See README §Audio-rate mode for the latency table
// and §Hybrid residual-on-carrier mode for what makes this demo different
// from the audio-rate one.

import {
  defineSchema,
  f32Array,
  u64,
} from "../../dist/index.js";

export const BLOCK_SIZE = 1024;
export const CAPACITY = 4;        // ring depth; 4 blocks = ~85 ms residual floor
export const N_PARTIALS = 16;     // harmonics 2..17 — the GPU residual layer

export function makeSchema(blockSize = BLOCK_SIZE) {
  return defineSchema({
    blockIndex: u64(),
    samples:    f32Array(blockSize),
  });
}
