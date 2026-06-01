// fx.worker.js — the SECOND intermediate node, on its own Worker.
//
// `fx` CONSUMES the SPSC edge (`inbound.link`, a real BridgeConsumer) and PRODUCES
// the broadcast edge (`outbound.bcast`, a real SpmcRing producer). It is the
// audible transform of the graph: it scales each frame's amplitude by a
// UI-controlled master gain before broadcasting, so dragging the "FX gain" slider
// in the page is heard live at the speaker AND seen at the meter (proving the
// broadcast carries the transformed stream to BOTH sinks).
//
// Both ends are wait-free on push (the SpmcRing producer laps freely and never
// reads consumer cursors), so neither the speaker nor the meter can wedge `fx`,
// and `fx` cannot wedge the mixer upstream.

import { mountGraph } from "../../dist/connectGraph.js";
import { makeSchemas } from "./schema.js";

let inCons = null;   // SPSC consumer end (BridgeConsumer)
let outRing = null;  // broadcast producer end (SpmcRing)
let inFrame = null;  // SPSC pull target
let outFrame = null; // broadcast push source
let pumpTimer = null;
let reportTimer = null;

let consumed = 0;
let produced = 0;
let gain = 0.8; // master gain, driven by the page slider

const DRAIN_CAP = 4096;

function pump() {
  let n = 0;
  while (inCons.pull(inFrame)) {
    outFrame.producerId = inFrame.producerId;
    outFrame.seq = inFrame.seq;
    outFrame.freq = inFrame.freq;
    outFrame.amp = inFrame.amp * gain; // the audible transform
    outRing.push(outFrame);            // wait-free broadcast (never blocks)
    consumed++;
    produced++;
    if (++n >= DRAIN_CAP) break;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "mount") {
    const mounted = mountGraph(m.handle, { node: "fx", schemas: makeSchemas() });
    inCons = mounted.inbound.link;   // consumes SPSC
    outRing = mounted.outbound.bcast; // produces broadcast
    inFrame = inCons.scratchFrame();
    outFrame = outRing.createFrame();
    pumpTimer = setInterval(pump, 2);
    reportTimer = setInterval(() => {
      self.postMessage({
        type: "diag", node: "fx",
        consumed, produced, gain,
        available: inCons.available(),
      });
    }, 200);
  } else if (m.type === "gain") {
    gain = Math.max(0, Math.min(1, Number(m.value) || 0));
  } else if (m.type === "stop") {
    if (pumpTimer) clearInterval(pumpTimer);
    if (reportTimer) clearInterval(reportTimer);
    pumpTimer = reportTimer = null;
  }
};
