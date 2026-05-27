// worker.js — slow-evolving macro envelope producer.
//
// At 60 Hz, publishes a slowly-rotating filter cutoff + detune envelope
// into the macro bridge. This is the "GPU macro" path of the pattern,
// minus the actual GPU compute — what matters for the demo is the
// SEPARATION of slow macro state (here) from fast gestural input (main
// thread → worklet). The fast-lane pattern works regardless of whether
// the macro is GPU- or CPU-driven; we use CPU here so the demo runs in
// any browser.

import { Bridge } from "../../dist/index.js";
import { makeMacroSchema } from "./schema.js";

const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
const REPORT_EVERY_MS = 250;

const state = {
  ring: null,
  scratch: null,
  capacity: 0,
  startTime: 0,
  seq: 0n,
  pushRejects: 0,
  running: false,
  lastReportAt: 0,
  lastReportSeq: 0n,
};

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") init(m).catch(fatal);
  else if (m.type === "stop") state.running = false;
};

function fatal(err) {
  self.postMessage({ type: "fatal", message: err?.message ?? String(err) });
}

async function init({ sab, capacity }) {
  const schema = makeMacroSchema();
  state.ring = new Bridge(sab, capacity, schema);
  state.scratch = state.ring.scratchFrame();
  state.capacity = capacity;
  state.startTime = performance.now();
  state.running = true;
  self.postMessage({ type: "ready" });
  loop();
}

async function loop() {
  while (state.running) {
    const tNow = performance.now();
    const tSec = (tNow - state.startTime) / 1000;

    // Slow envelope: filter cutoff sweeps 400-3000 Hz on a ~6 s period;
    // detune wobbles ±20 cents on a ~3 s period.
    const cutoffHz   = 1500 + 1300 * Math.sin(tSec * (2 * Math.PI / 6));
    const detuneCents = 20 * Math.sin(tSec * (2 * Math.PI / 3));

    state.scratch.seq          = state.seq;
    state.scratch.tMacroNs     = BigInt(Math.floor(tNow * 1e6));
    state.scratch.cutoffHz     = cutoffHz;
    state.scratch.detuneCents  = detuneCents;
    if (!state.ring.push(state.scratch)) state.pushRejects++;
    state.seq++;

    if (tNow - state.lastReportAt > REPORT_EVERY_MS) {
      self.postMessage({
        type: "diag",
        macroPushes: Number(state.seq),
        macroPushRejects: state.pushRejects,
      });
      state.lastReportAt = tNow;
      state.lastReportSeq = state.seq;
    }

    const drift = performance.now() - tNow;
    await new Promise((r) => setTimeout(r, Math.max(0, TICK_MS - drift)));
  }
}
