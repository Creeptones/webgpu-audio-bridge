// schema.js — shared block-frame definition for the STEREO hybrid-residual demo.
//
// Same one-f32Array contract as examples/hybrid-residual/schema.js, but the
// lone array carries INTERLEAVED stereo: f32Array(2 * BLOCK_SIZE), packed
// L,R,L,R…  BridgeBlockConsumer's `channels: 2` option de-interleaves it on
// the consumer side; the wire format and the producer are unchanged (the
// producer still copies the lone array's full length — it just has to fill
// it interleaved). See README §"Stereo / multichannel" for the convention
// and the cursor-advance contract.

import {
  defineSchema,
  f32Array,
  u64,
} from "../../dist/index.js";

export const BLOCK_SIZE = 1024;   // PER-CHANNEL samples (≈21.3 ms at 48 kHz)
export const CHANNELS = 2;
export const CAPACITY = 4;        // ring depth; 4 blocks = ~85 ms residual floor
export const N_PARTIALS = 16;     // harmonics 2..17 — the GPU residual layer

export function makeSchema(blockSize = BLOCK_SIZE, channels = CHANNELS) {
  return defineSchema({
    blockIndex: u64(),
    samples:    f32Array(channels * blockSize),   // interleaved L,R,L,R…
  });
}
