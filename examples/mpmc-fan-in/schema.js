// schema.js — the shared control-frame schema for the MP→SC fan-in demo
// (Apollo Frontier 3, Stage 3). Every producer worker AND the consumer worklet
// import THIS so the bytes a producer writes are decoded by the consumer with
// the identical compiled layout.
//
// Each frame is one producer's latest control state:
//   producerId — who sent it (an APPLICATION concern; the MpmcRing itself is
//                producer-id-agnostic — see the connectFanIn module header).
//   seq        — monotonic per-producer counter (lets the HUD spot drops).
//   freq, amp  — the synthesis target this producer wants the consumer to voice.
//
// This is a CONTROL-rate schema (scalars, no PCM array) — the fan-in edge's
// natural shape: many cheap control producers, one audio consumer summing them.

import { defineSchema, u32, f64 } from "../../dist/index.js";

/** Concurrent producer threads. Fixed at allocation — sets SLACK =
 *  PRODUCER_COUNT − 1 in the MpmcRing envelope. */
export const PRODUCER_COUNT = 3;

/** Ring capacity (pow2). Usable depth is CAPACITY − (PRODUCER_COUNT − 1). 256
 *  control frames is far more backlog than three sub-kHz producers need under
 *  normal pacing — the headroom is what makes "Flood" visibly drop. */
export const CAPACITY = 256;

/** Per-producer voice colour: base frequency the worker orbits with a slow
 *  vibrato. Index by producerId. (A perfect fifth + octave-ish stack.) */
export const PRODUCER_FREQS = [220, 330, 440];

/** Push cadence per producer (Hz) — deliberately DIFFERENT so the demo shows
 *  three independent rates fanning into one consumer. */
export const PRODUCER_RATES = [30, 50, 120];

export function makeFanInSchema() {
  return defineSchema({
    producerId: u32(),
    seq: u32(),
    freq: f64(),
    amp: f64(),
  });
}
