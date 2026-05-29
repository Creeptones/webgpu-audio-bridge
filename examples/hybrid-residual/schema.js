// schema.js — block-frame + input-event definitions for the hybrid-residual demo.
//
// TWO schemas, mirroring the fast-lane pattern:
//
//   makeSchema       — the GPU residual block. One f32Array of samples, one
//                      u64 block index (same shape as examples/audio-rate/).
//                      BridgeBlockConsumer auto-detects both. 1024 samples
//                      (≈21.3 ms at 48 kHz) feed 8 audio quanta per producer
//                      tick. See README §Audio-rate mode for the latency table.
//
//   makeInputSchema  — sample-accurate CARRIER CONTROL events (0.9.49). The
//                      main thread writes one frame per slider tick straight
//                      into a dedicated SAB via BridgeInputLane — no
//                      postMessage hop. The worklet drains every unread event
//                      per quantum and applies each at its sampleOffset, so
//                      the carrier responds within ONE quantum (~2.7 ms)
//                      instead of at MessagePort delivery cadence. This is the
//                      whole point of the hybrid pattern made concrete:
//                      "GPU residual may lag; carrier control does not."

import {
  defineSchema,
  f32,
  f32Array,
  u32,
  u64,
} from "../../dist/index.js";

export const BLOCK_SIZE = 1024;
export const CAPACITY = 4;        // ring depth; 4 blocks = ~85 ms residual floor
export const N_PARTIALS = 16;     // harmonics 2..17 — the GPU residual layer

// Input lane sizing. 64 slots covers any human-rate slider drag (which fires
// at most ~one event per pointer-move, far below the audio quantum rate)
// without ever reaching the ring's back-pressure path; the worklet drains up
// to 32 per quantum, well above the ~5 events/quantum a fast drag produces.
export const INPUT_CAPACITY = 64;
export const EVENT_DRAIN_PER_QUANTUM = 32;

// Carrier-control event types carried in the input lane's `eventType` field.
//   0 = freq    value0 = carrier fundamental in Hz
//   1 = noteOn  value0 = MIDI note (reserved — this demo's carrier is a
//   2 = noteOff             continuous slider-driven drone, no keyboard)
//   3 = gain    value0 = residual mix gain (0..~1.2)
export const EVT_FREQ = 0;
export const EVT_NOTE_ON = 1;
export const EVT_NOTE_OFF = 2;
export const EVT_GAIN = 3;

export function makeSchema(blockSize = BLOCK_SIZE) {
  return defineSchema({
    blockIndex: u64(),
    samples:    f32Array(blockSize),
  });
}

// One frame per discrete carrier-parameter change. `sampleOffset` is the
// offset INSIDE the receiving quantum at which the change should take effect:
//   - A producer that can correlate its clock to the audio quantum (a
//     sequencer, a MIDI stream with timestamps) sets it for true intra-quantum
//     placement.
//   - A slider drag can't know the quantum boundary, so it leaves it 0 —
//     "apply at quantum start", still a one-quantum response.
export function makeInputSchema() {
  return defineSchema({
    seq:          u64(),
    tInputNs:     u64(),
    eventType:    u32(),
    sampleOffset: u32(),
    value0:       f32(),
    value1:       f32(),
  });
}
