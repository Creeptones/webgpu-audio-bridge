// mixer.worker.js — the FIRST intermediate node, on its own Worker.
//
// `mixer` CONSUMES the fan-in edge (`inbound.fanin`, a real MpmcRing consumer) and
// PRODUCES the SPSC edge (`outbound.link`, a real BridgeProducer) — the genuine
// consume-one-ring-produce-another shape the Stage-2 stress witnesses. Every tick
// it drains whatever the two oscillators fanned in and forwards each frame onto the
// SPSC link to `fx`. Both ends are wait-free on push, so a slow `fx`/sink can never
// wedge the mixer, and the mixer never wedges the oscillators (Stage-0 §5).
//
// This is a pure forwarder — the topology is the point, not a transform. (`fx`,
// the next node, is where the audible transform lives.) The SPSC edge defaults to
// `drop-oldest`, so under a slow `fx` the freshest control state always wins.

import { mountGraph } from "../../dist/connectGraph.js";
import { makeSchemas } from "./schema.js";

let inRing = null;   // fan-in consumer end (MpmcRing)
let outProd = null;  // SPSC producer end (BridgeProducer)
let frame = null;    // reused fan-in pull target / SPSC push source
let pumpTimer = null;
let reportTimer = null;

let consumed = 0;
let forwarded = 0;

const DRAIN_CAP = 4096; // bound the per-tick work so a flood can't monopolize.

function pump() {
  let n = 0;
  while (inRing.pull(frame)) {
    // Forward the SAME control frame onto the SPSC link (pull target IS the push
    // source — same schema, same field layout).
    if (outProd.push(frame)) forwarded++;
    consumed++;
    if (++n >= DRAIN_CAP) break;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "mount") {
    const mounted = mountGraph(m.handle, { node: "mixer", schemas: makeSchemas() });
    inRing = mounted.inbound.fanin;   // consumes fan-in
    outProd = mounted.outbound.link;  // produces SPSC
    frame = inRing.createFrame();
    pumpTimer = setInterval(pump, 2); // poll the ring at ~500 Hz (control-rate)
    reportTimer = setInterval(() => {
      self.postMessage({
        type: "diag", node: "mixer",
        consumed, forwarded,
        available: inRing.available(),
        torn: inRing.tornFrameCount(),
        faninDropped: inRing.droppedFrames(),
      });
    }, 200);
  } else if (m.type === "stop") {
    if (pumpTimer) clearInterval(pumpTimer);
    if (reportTimer) clearInterval(reportTimer);
    pumpTimer = reportTimer = null;
  }
};
