// meter.worker.js — the SECOND broadcast sink (a non-audio consumer).
//
// `meter` CONSUMES the broadcast edge (`inbound.bcast`, a real SpmcRing consumer)
// — the SAME edge the audio worklet (`speaker`) consumes. Its `consumerIndex` is
// DERIVED by `mountGraph` from the node's position in the edge's `to[]` array
// (`["speaker", "meter"]` → meter is index 1); the worker never names an index.
//
// It exists to make broadcast-completeness visible: it counts every frame it
// receives and tracks a per-voice level, so the HUD can show that `meter.consumed`
// tracks `speaker.consumed` — both sinks see EVERY broadcast frame, independently,
// each via its own cursor. A non-audio consumer also proves a slow/odd sink (a JS
// timer, not the audio clock) never wedges the producer.

import { mountGraph } from "../../dist/connectGraph.js";
import { makeSchemas } from "./schema.js";

let ring = null;  // broadcast consumer end (SpmcRing, consumerIndex DERIVED = 1)
let frame = null;
let pumpTimer = null;
let reportTimer = null;

let consumed = 0;
const level = [0, 0]; // smoothed per-voice amplitude (the "meter")

const DRAIN_CAP = 4096;

function pump() {
  let n = 0;
  while (ring.pull(frame)) {
    const pid = frame.producerId;
    if (pid === 0 || pid === 1) {
      // One-pole smooth toward the latest amplitude (a simple VU-style meter).
      level[pid] += 0.05 * (frame.amp - level[pid]);
    }
    consumed++;
    if (++n >= DRAIN_CAP) break;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "mount") {
    const mounted = mountGraph(m.handle, { node: "meter", schemas: makeSchemas() });
    ring = mounted.inbound.bcast; // consumes broadcast (index 1, derived)
    frame = ring.createFrame();
    pumpTimer = setInterval(pump, 2);
    reportTimer = setInterval(() => {
      self.postMessage({
        type: "diag", node: "meter",
        consumed,
        level: [level[0], level[1]],
        dropped: ring.dropped(),
        tornGuarded: ring.tornGuarded(),
      });
    }, 200);
  } else if (m.type === "stop") {
    if (pumpTimer) clearInterval(pumpTimer);
    if (reportTimer) clearInterval(reportTimer);
    pumpTimer = reportTimer = null;
  }
};
