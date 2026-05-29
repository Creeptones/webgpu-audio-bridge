// schema.js — THREE bridge definitions for the four-tier hybrid demo.
//
// The four-tier stack composes three independent SABs, each owning a different
// latency class (see docs/hybrid-four-tier-handoff.md):
//
//   TIER 1  BridgeInputLane   note / gesture / carrier params   ~1 µs SAB
//   TIER 2  CPU AudioWorklet  pitch / attack / fundamental       sub-quantum
//   TIER 3  GPU residual ring upper harmonics + spatial field   ~85 ms
//   TIER 4  macro Bridge<S>   smooth macro fields (cutoff/azimuth) "negative"
//
// This file defines the three SHARED SCHEMAS the demo allocates:
//
//   1. makeInputSchema()  — tier 1. Sample-accurate carrier-control events,
//      byte-identical to examples/hybrid-residual/schema.js (one frame per
//      slider tick, drained per quantum and applied at its sampleOffset).
//
//   2. makeBlockSchema()  — tier 3. The interleaved stereo residual block ring,
//      byte-identical to examples/hybrid-residual-stereo/schema.js (one u64
//      blockIndex + one interleaved f32Array(2 × blockSize)).
//
//   3. makeMacroSchema()  — tier 4. A CONTROL-RATE bridge of SMOOTH macro
//      fields carried as order-2 trajectories (position + velocity) so the
//      worklet's pullPredictedLatest can forward-extrapolate them by the
//      measured GPU-readback lead. Each macro is scalar (sampleCount = 1); the
//      raw frame field is therefore length 2 ([position, velocity]).
//
// HARD RULE (repeated from the handoff): tier 4 is SMOOTH MACROS ONLY. Never
// put pitch / attack / note-on / transport here — forward-extrapolating a step
// pre-echoes it. Those discontinuous events belong on tiers 1+2 (the input
// lane + the CPU carrier).

import {
  defineSchema,
  f32,
  f32Array,
  f64TrajectoryArray,
  u32,
  u64,
} from "../../dist/index.js";

// ── Tier 3: stereo residual block ring ──────────────────────────────────────
export const BLOCK_SIZE = 1024;   // PER-CHANNEL samples (≈21.3 ms at 48 kHz)
export const CHANNELS = 2;
export const CAPACITY = 4;        // ring depth; 4 blocks = ~85 ms residual floor
export const N_PARTIALS = 16;     // harmonics 2..17 — the GPU residual layer

export function makeBlockSchema(blockSize = BLOCK_SIZE, channels = CHANNELS) {
  return defineSchema({
    blockIndex: u64(),
    samples:    f32Array(channels * blockSize),   // interleaved L,R,L,R…
  });
}

// ── Tier 1: sample-accurate carrier-control input lane ──────────────────────
export const INPUT_CAPACITY = 64;
export const EVENT_DRAIN_PER_QUANTUM = 32;

// Carrier-control event types carried in the input lane's `eventType` field.
//   0 = freq  value0 = carrier fundamental in Hz
//   3 = gain  value0 = residual mix gain (0..~1.2)
export const EVT_FREQ = 0;
export const EVT_GAIN = 3;

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

// ── Tier 4: smooth-macro control bridge ─────────────────────────────────────
export const MACRO_CAPACITY = 8;  // shallow ring; the worklet only ever reads latest

export function makeMacroSchema() {
  return defineSchema({
    seq:      u64(),
    tMacroNs: u64(),
    // Smooth macro fields as order-2 trajectories (position + velocity) so
    // pullPredictedLatest can lead them forward by the readback wall. Scalar
    // valued → sampleCount = 1, raw field length = 1 × order = 2 ([p, v]); the
    // evaluated frame collapses each to a single predicted position.
    cutoff:  f64TrajectoryArray(1, { order: 2 }),  // filter cutoff Hz + dHz/s
    azimuth: f64TrajectoryArray(1, { order: 2 }),  // pan −1..+1 + angular vel
    morph:   f64TrajectoryArray(1, { order: 2 }),  // spare IR/wavetable morph
  }).withTimestamps({ macro: { field: "tMacroNs", unit: "ns", default: true } });
}
