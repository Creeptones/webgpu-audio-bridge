// schema.js — the control-rate trajectory schema for the Hermite-order A/B demo.
//
// ONE order-4 trajectory field carries the instantaneous frequency of an FM
// carrier PLUS its first three derivatives:
//
//   freq[0] = f(t)      position     (Hz)
//   freq[1] = f'(t)     velocity     (Hz/s)
//   freq[2] = f''(t)    acceleration (Hz/s²)
//   freq[3] = f'''(t)   jerk         (Hz/s³)   ← the order-4 lane (0.9.80)
//
// Order 4 is the wire shape that backs ALL THREE reconstruction modes the demo
// A/Bs — cubic Hermite (C¹, reads p,v), quintic (C², reads p,v,a), septic (C³,
// reads p,v,a,jerk). The producer stamps the full tuple once; the consumer
// chooses how many derivatives to honor at the seam, live.
//
// `.withTimestamps` attaches the nanosecond producer clock so the consumer's
// PLL (`observeConsumerTime` / `phaseLockedTime`) can align the producer's
// wall clock to the audio-render clock — the two run on different origins, and
// the PLL is what bridges them. See worklet.js for why this demo reconstructs
// manually (interior-segment interpolation) rather than via `pullHermiteLatest`.

import { defineSchema, f64TrajectoryArray, u64 } from "../../dist/index.js";

// Control-rate ring. Shallow — the consumer keeps its own short frame history
// and only ever needs the newest few frames; capacity 16 leaves generous
// headroom for setTimeout pacing jitter at the lowest control rates.
export const CAPACITY = 16;

// Note the interpolationMode here is 'septic-hermite' purely so the schema
// validates the order-4 jerk lane; the demo's live A/B does NOT dispatch on it
// (it calls the three evaluator functions directly), so the same schema serves
// cubic, quintic, and septic reconstruction off one SAB.
export function makeSchema() {
  return defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    freq: f64TrajectoryArray(1, { order: 4, interpolationMode: "septic-hermite" }),
  }).withTimestamps({ macro: { field: "tMacroNs", unit: "ns", default: true } });
}
