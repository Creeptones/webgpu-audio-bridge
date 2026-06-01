// schema.js — the shared control-frame schema + graph topology for the
// audio-DAG demo (Apollo Frontier 3, DAG Stage 2). Every realm — the page, the
// two oscillator workers, the mixer + fx intermediate workers, the meter worker,
// AND the audio worklet — imports THIS so the bytes one node writes are decoded
// by the next with the identical compiled layout, and so they all agree on the
// graph shape (node names, edge ids, capacities).
//
// Each frame is one voice's latest control state:
//   producerId — which oscillator (0 or 1). An APPLICATION concern; the rings are
//                producer-id-agnostic.
//   seq        — monotonic per-producer counter (lets the HUD spot drops).
//   freq, amp  — the synthesis target this voice wants the speaker to voice.
//
// A CONTROL-rate schema (scalars, no PCM array) — the natural shape for a control
// DAG: cheap control producers fanned in, transformed by intermediate nodes, then
// broadcast to an audio sink + a meter.

import { defineSchema, u32, f64 } from "../../dist/index.js";

/** Every participating node, in one place so every realm agrees. */
export const NODES = ["osc0", "osc1", "mixer", "fx", "speaker", "meter"];

/** Per-voice base frequency (a perfect fifth). Index by producerId. */
export const VOICE_FREQS = [220, 330];

/** Per-voice push cadence (Hz) — deliberately DIFFERENT so the fan-in shows two
 *  independent rates merging into one stream. */
export const VOICE_RATES = [60, 90];

/** Edge capacities (pow2). 256 control frames is ample backlog for two sub-kHz
 *  producers — the headroom is what makes "Flood" visibly drop at the fan-in. The
 *  broadcast is deeper so both sinks stay inside the no-lap regime. */
export const FANIN_CAP = 256;
export const LINK_CAP = 256;
export const BCAST_CAP = 1024;

/** One control frame. Used by every edge in this graph (they all carry the same
 *  control payload), so a single schema definition is shared per realm. */
export function makeSchema() {
  return defineSchema({
    producerId: u32(),
    seq: u32(),
    freq: f64(),
    amp: f64(),
  });
}

/** The per-edge schema map re-supplied at `mountGraph` time (schema closures are
 *  not clone-safe and do NOT cross `postMessage`, so each realm rebuilds them).
 *  All three edges carry the same control frame, so one schema instance backs
 *  all three keys. */
export function makeSchemas() {
  const s = makeSchema();
  return { fanin: s, link: s, bcast: s };
}

/** Build the declarative `connectGraph` spec on the allocating (page) thread.
 *  The audible topology, using THREE of the four edge kinds:
 *
 *    osc0,osc1 ─(mpmc fan-in)→ mixer ─(spsc)→ fx ─(spmc broadcast)→ speaker, meter
 *
 *  `mixer` and `fx` are real INTERMEDIATE nodes (consume one edge, produce
 *  another) each on their own Worker — the consume-one-ring-produce-another shape
 *  the Stage-2 stress witnesses. The broadcast fans the SAME stream to BOTH the
 *  audio worklet (`speaker`) and a `meter` worker, so the HUD can show
 *  broadcast-completeness (both sinks see every frame). The fourth edge kind
 *  (MP→MC work-queue partition) is non-audible and is covered by the test suite.
 */
export function makeGraphSpec(schemas) {
  return {
    nodes: NODES,
    edges: [
      { id: "fanin", kind: "mpmc", schema: schemas.fanin, from: ["osc0", "osc1"], to: "mixer", capacity: FANIN_CAP },
      { id: "link", kind: "spsc", schema: schemas.link, from: "mixer", to: "fx", capacity: LINK_CAP },
      { id: "bcast", kind: "spmc", schema: schemas.bcast, from: "fx", to: ["speaker", "meter"], capacity: BCAST_CAP },
    ],
  };
}
