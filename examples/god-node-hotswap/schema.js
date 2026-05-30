// schema.js — the two DIFFERENT-schema patches the God-Node hot-swap morphs
// between. This is the demo's whole point: A and B are not the same shape, so
// `migratePlan` does real cross-schema work (Stage 3) and the swap proves the
// bridge can rewrite its own read path into B's layout at runtime (Stage 4).
//
//   Patch A — { freq(traj order-3), amp }
//     A bare FM carrier: one order-3 frequency trajectory (position + velocity +
//     acceleration → C² quintic-Hermite reconstruction) and a scalar amplitude.
//
//   Patch B — { freq(traj order-3), amp, res, detune }
//     The SAME freq trajectory + amp, PLUS two NEW fields:
//       res    — a 0..1 "resonance" that adds an upper-octave partial (brightness)
//       detune — a few Hz of detune for a second oscillator (width/chorus)
//     so B is an audibly richer, fatter timbre than A while the PITCH MOTION is
//     identical (same freq trajectory). The morph you hear is therefore a clean
//     TIMBRE morph, not a pitch slide — the seam continuity is the only variable.
//
//   migratePlan(A → B) classifies:
//     freq, amp, seq, tNs  → crossfade   (compatible, present in both)
//     res, detune          → ramp-in     (added; fade from a default across window)
//     (nothing dropped)
//
// Both carry `.withTimestamps` so the consumer's PLL aligns the producer wall
// clock to the audio-render clock and `pullHermiteLatest` can reconstruct the
// freq trajectory between control frames.

import { defineSchema, f64, u64, f64TrajectoryArray } from "../../dist/index.js";

// Control-rate ring. Shallow: the consumer keeps no long history (it uses
// `pullHermiteLatest`, which needs only the newest two frames). 16 leaves
// headroom for setTimeout pacing jitter.
export const CAP = 16;

// Quintic-Hermite (C²) needs order ≥ 3 (endpoint accelerations); the freq lane
// carries position+velocity+acceleration of the instantaneous carrier frequency.
function freqField() {
  return f64TrajectoryArray(1, { order: 3, interpolationMode: "quintic-hermite" });
}

export function makeSchemaA() {
  return defineSchema({
    seq: u64(),
    tNs: u64(),
    freq: freqField(),
    amp: f64(),
  }).withTimestamps({ macro: { field: "tNs", unit: "ns", default: true } });
}

export function makeSchemaB() {
  return defineSchema({
    seq: u64(),
    tNs: u64(),
    freq: freqField(),
    amp: f64(),
    res: f64(),
    detune: f64(),
  }).withTimestamps({ macro: { field: "tNs", unit: "ns", default: true } });
}
