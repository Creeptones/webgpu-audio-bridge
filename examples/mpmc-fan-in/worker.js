// worker.js — ONE producer thread of the MP→SC fan-in demo.
//
// Three of these run concurrently, each `mountFanIn(role:'producer')`-ing the
// SAME shared MpmcRing SAB (handed over in the clone-safe handle) and pushing
// control frames at its OWN rate. The ring is producer-id-agnostic — every
// worker just calls `ring.push(frame)`; the wait-free fetch-add ticket handles
// the concurrency. `producerId` is stamped into the payload purely so the
// consumer can tell the three voices apart (an application concern).
//
// Loads the experimental subpath (where connectFanIn/mountFanIn live until the
// MP→SC wire format soaks + promotes). Imports `../../dist/...` — run
// `npm run build` (or `tsc -p tsconfig.build.json`) once so dist is fresh.

import { mountFanIn } from "../../dist/experimental/index.js";
import { makeFanInSchema } from "./schema.js";

let ring = null;
let producerId = 0;
let baseFreq = 220;
let rateHz = 50;
let flood = false;

let pushTimer = null;
let reportTimer = null;
let pushed = 0;
let dropped = 0;
let seq = 0;
let t0 = 0;

const FLOOD_BURST = 600; // frames per tick in flood mode → overruns the ring.

function tick(frame) {
  const t = (performance.now() - t0) / 1000;
  // Slow vibrato around the base frequency + a slow tremolo on amplitude, phase-
  // offset per producer so the three voices breathe independently.
  const freq = baseFreq * (1 + 0.03 * Math.sin(2 * Math.PI * 0.2 * t + producerId));
  let amp = 0.55 + 0.4 * Math.sin(2 * Math.PI * 0.13 * t + producerId * 1.7);
  if (amp < 0) amp = 0;

  const burst = flood ? FLOOD_BURST : 1;
  for (let b = 0; b < burst; b++) {
    frame.producerId = producerId;
    frame.seq = seq >>> 0;
    frame.freq = freq;
    frame.amp = amp;
    if (ring.push(frame)) pushed++;
    else dropped++; // ring at the envelope limit → drop-newest (counted).
    seq++;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "mount") {
    ring = mountFanIn(m.handle, { role: "producer", schema: makeFanInSchema() });
    producerId = m.producerId;
    baseFreq = m.baseFreq;
    rateHz = m.rateHz;
    const frame = ring.createFrame();
    t0 = performance.now();
    pushTimer = setInterval(() => tick(frame), 1000 / rateHz);
    reportTimer = setInterval(() => {
      self.postMessage({ type: "rate", producerId, pushed, dropped, rateHz, flood });
    }, 250);
  } else if (m.type === "flood") {
    flood = !!m.on;
  } else if (m.type === "stop") {
    if (pushTimer) clearInterval(pushTimer);
    if (reportTimer) clearInterval(reportTimer);
    pushTimer = reportTimer = null;
  }
};
