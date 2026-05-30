// worker.js — the synthetic producer for the Hermite-order A/B demo.
//
// No GPU. A plain DedicatedWorker stamps an analytic FM control trajectory at a
// (deliberately low, user-adjustable) "control rate" and pushes it into the
// Bridge. The trajectory is the instantaneous frequency of a carrier swept by
// an LFO:
//
//   f(t)   = carrier + depth · sin(2π · lfoHz · t)
//   f'(t)  =          depth · ω · cos(2π · lfoHz · t)        ω = 2π·lfoHz
//   f''(t) =         −depth · ω² · sin(…)
//   f'''(t)=         −depth · ω³ · cos(…)
//
// Stamping the exact derivatives is precisely what a real GPU physics producer
// would emit alongside each macro value — the whole point of the trajectory
// lanes. The consumer then reconstructs f(t) BETWEEN control frames with cubic
// / quintic / septic Hermite, and the seam-continuity order is audible.
//
// The control rate is the star slider: at 60 Hz the orders are nearly
// indistinguishable, but drop it toward 24–30 Hz and each 16–40 ms segment
// spans a big arc of the LFO — now the cubic seam buzzes and septic stays
// clean. That's the "kills the FM/zipper click" claim, made interactive.

import { Bridge } from "../../dist/index.js";
import { makeSchema, CAPACITY } from "./schema.js";

const state = {
  ring: null,
  push: null,
  running: false,
  // live params (mirrored from the UI)
  carrier: 330,
  depth: 220,
  lfoHz: 8,
  controlHz: 30,
  // pacing / diag
  seq: 0n,
  pushed: 0,
  rejects: 0,
  startNs: 0,
  lastReportAt: 0,
  lastReportPushed: 0,
};

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") return init(m);
  if (m.type === "params") return applyParams(m.params);
  if (m.type === "stop") return stop();
};

function applyParams(p) {
  if (p.carrier != null) state.carrier = p.carrier;
  if (p.depth != null) state.depth = p.depth;
  if (p.lfoHz != null) state.lfoHz = p.lfoHz;
  if (p.controlHz != null) state.controlHz = p.controlHz;
}

function init({ sab, params }) {
  state.ring = new Bridge(sab, CAPACITY, makeSchema());
  state.push = state.ring.scratchFrame();
  if (params) applyParams(params);
  state.startNs = nowNs();
  state.lastReportAt = performance.now();
  state.running = true;
  self.postMessage({ type: "ready" });
  loop();
}

// Producer clock in nanoseconds. performance.now() is ms with sub-µs
// resolution; the consumer's PLL aligns this origin to the audio clock, so the
// absolute epoch is irrelevant — only the rate and monotonicity matter.
function nowNs() {
  return performance.now() * 1e6;
}

function stampAndPush(tNs) {
  const t_s = (tNs - state.startNs) * 1e-9;
  const w = 2 * Math.PI * state.lfoHz;
  const d = state.depth;
  const sin = Math.sin(w * t_s);
  const cos = Math.cos(w * t_s);
  const f = state.push.freq;
  f[0] = state.carrier + d * sin;
  f[1] = d * w * cos;
  f[2] = -d * w * w * sin;
  f[3] = -d * w * w * w * cos;
  state.push.seq = state.seq;
  state.push.tMacroNs = BigInt(Math.round(tNs));
  if (state.ring.push(state.push)) {
    state.seq += 1n;
    state.pushed++;
  } else {
    state.rejects++;
  }
}

function loop() {
  // Schedule the next control frame on a wall-clock timer. setTimeout jitter is
  // real (and exactly what the consumer's PLL + interpolation smooths over), so
  // we stamp each frame with the ACTUAL emit time rather than an idealized grid.
  let nextWallMs = performance.now();
  const tick = () => {
    if (!state.running) return;
    stampAndPush(nowNs());

    const tNow = performance.now();
    if (tNow - state.lastReportAt > 250) {
      const dt = (tNow - state.lastReportAt) / 1000;
      self.postMessage({
        type: "diag",
        pushRateHz: (state.pushed - state.lastReportPushed) / dt,
        pushed: state.pushed,
        rejects: state.rejects,
      });
      state.lastReportAt = tNow;
      state.lastReportPushed = state.pushed;
    }

    const periodMs = 1000 / state.controlHz;
    nextWallMs += periodMs;
    let wait = nextWallMs - performance.now();
    if (wait < 0) { wait = 0; nextWallMs = performance.now(); }
    setTimeout(tick, wait);
  };
  tick();
}

function stop() {
  state.running = false;
}
