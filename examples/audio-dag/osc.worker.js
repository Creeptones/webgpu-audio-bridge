// osc.worker.js — ONE oscillator/source node of the audio DAG.
//
// Two of these run concurrently (osc0, osc1). Each `mountGraph`s its OWN node and
// pushes control frames onto the fan-in edge it produces (`outbound.fanin`, a real
// MpmcRing producer) at its own rate. The ring is producer-id-agnostic — the
// wait-free fetch-add ticket handles the concurrency; `producerId` is stamped into
// the payload only so downstream can tell the two voices apart.
//
// Browser workers CAN import the real `dist` facades (unlike the eval-workers in
// the Node concurrent test, which must reimplement each protocol). We import
// `mountGraph` straight from `dist/connectGraph.js` (NOT the experimental barrel —
// that transitively pulls the JIT's `acorn` import, which has no browser
// resolution here).

import { mountGraph } from "../../dist/connectGraph.js";
import { makeSchemas, VOICE_FREQS, VOICE_RATES } from "./schema.js";

let ring = null;       // the fan-in producer end (an MpmcRing)
let node = "osc0";
let producerId = 0;
let baseFreq = 220;
let rateHz = 60;
let flood = false;

let pushTimer = null;
let reportTimer = null;
let frame = null;
let pushed = 0;
let dropped = 0;
let seq = 0;
let t0 = 0;

const FLOOD_BURST = 500; // frames per tick in flood mode → overruns the fan-in.

function tick() {
  const t = (performance.now() - t0) / 1000;
  // Slow vibrato around the base frequency + a slow tremolo on amplitude, phase-
  // offset per voice so the two breathe independently.
  const freq = baseFreq * (1 + 0.03 * Math.sin(2 * Math.PI * 0.2 * t + producerId));
  let amp = 0.6 + 0.35 * Math.sin(2 * Math.PI * 0.13 * t + producerId * 1.7);
  if (amp < 0) amp = 0;

  const burst = flood ? FLOOD_BURST : 1;
  for (let b = 0; b < burst; b++) {
    frame.producerId = producerId;
    frame.seq = seq >>> 0;
    frame.freq = freq;
    frame.amp = amp;
    // Wait-free push. Never blocks: at the envelope limit it drop-newests
    // (counted) — a slow downstream can never wedge this source (Stage-0 §5).
    if (ring.push(frame)) pushed++;
    else dropped++;
    seq++;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "mount") {
    node = m.node;
    producerId = m.producerId;
    baseFreq = VOICE_FREQS[producerId];
    rateHz = VOICE_RATES[producerId];
    const mounted = mountGraph(m.handle, { node, schemas: makeSchemas() });
    ring = mounted.outbound.fanin; // this node PRODUCES the fan-in edge
    frame = ring.createFrame();
    t0 = performance.now();
    pushTimer = setInterval(tick, 1000 / rateHz);
    reportTimer = setInterval(() => {
      self.postMessage({ type: "diag", node, producerId, pushed, dropped, rateHz, flood });
    }, 200);
  } else if (m.type === "flood") {
    flood = !!m.on;
  } else if (m.type === "stop") {
    if (pushTimer) clearInterval(pushTimer);
    if (reportTimer) clearInterval(reportTimer);
    pushTimer = reportTimer = null;
  }
};
