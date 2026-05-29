// schema.js — block-frame + input-event definitions for the comparator bench.
//
// TWO schemas, same fast-lane pattern as examples/hybrid-residual/schema.js:
//
//   makeSchema       — the GPU sample block (paths B / C / G). One f32Array of
//                      `samples` (auto-detected by BridgeBlockConsumer /
//                      BridgeBlockProducer), one `blockIndex` u64, PLUS a
//                      `carrierFreq` f32 scalar tagging the carrier frequency
//                      the block was COMPUTED at. The consumer ignores the
//                      scalar fields for audio, but path C reads `carrierFreq`
//                      off the just-pulled frame to detect "the first block
//                      computed at the new freq has landed" — that is what
//                      makes C's control-latency ≈ the block-mode floor
//                      (see README §"Path C latency"). The producer fills it
//                      via BridgeBlockProducer's `fillScalars` hook.
//
//   makeInputSchema  — sample-accurate carrier-control events, identical in
//                      shape to the hybrid-residual demo's input lane. The main
//                      thread writes one frame per freq/gain change; the
//                      consumer worklets drain per quantum. Carries `tInputNs`
//                      (absolute Unix-epoch ns) so the worklet can compute
//                      input-event → applied latency without a postMessage hop.

import {
  defineSchema,
  f32,
  f32Array,
  u32,
  u64,
} from "../../dist/index.js";

export const BLOCK_SIZE = 1024; // 8 audio quanta per block @ 128-frame quantum.
export const CAPACITY = 4; // ring depth; 4 blocks ≈ 85 ms block-mode floor.
export const DEFAULT_PARTIALS = 16; // matches reference-signal DEFAULT_PARTIALS.

// Input lane sizing — same rationale as the hybrid-residual demo. 64 slots
// covers any human / scripted slider rate; the worklet drains up to 32 per
// quantum.
export const INPUT_CAPACITY = 64;
export const EVENT_DRAIN_PER_QUANTUM = 32;

// Carrier-control event types in the input lane's `eventType` field.
export const EVT_FREQ = 0; // value0 = carrier fundamental in Hz.
export const EVT_GAIN = 3; // value0 = residual mix gain (path G only).

// Block schema. Note the extra `carrierFreq` f32 scalar vs the hybrid demo's
// schema — it is the per-block freq tag path C's latency probe reads. Still
// exactly ONE f32Array, so both block helpers accept it unchanged.
export function makeSchema(blockSize = BLOCK_SIZE) {
  return defineSchema({
    blockIndex: u64(),
    carrierFreq: f32(),
    samples: f32Array(blockSize),
  });
}

// One frame per discrete carrier-parameter change. `tInputNs` is stamped by
// the page in absolute Unix-epoch ns at the instant the event fires; the
// worklet converts its apply instant into the same space and reports the
// delta. `sampleOffset` is the within-quantum offset (a slider/scripted event
// can't correlate to the quantum boundary, so it stays 0 = apply at quantum
// start — still a one-quantum response).
export function makeInputSchema() {
  return defineSchema({
    seq: u64(),
    tInputNs: u64(),
    eventType: u32(),
    sampleOffset: u32(),
    value0: f32(),
    value1: f32(),
  });
}
