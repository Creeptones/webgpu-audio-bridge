// worker.js — the synthetic producer for the God-Node hot-swap demo.
//
// It drives BOTH rings at once. Patch A and patch B share the SAME analytic
// frequency trajectory (so the morph is a pure timbre change, not a pitch
// slide); B additionally carries `res` + `detune` so its synthesis is richer.
//
//   f(t)    = carrier + depth · sin(2π · lfoHz · t)        instantaneous freq
//   f'(t)   =          depth · ω · cos(…)                  ω = 2π·lfoHz
//   f''(t)  =         −depth · ω² · sin(…)                 (the order-3 accel lane)
//
// Driving both rings throughout means B is already streaming when the consumer
// arms the swap, so `HotSwapConsumer` finds B "ready" (≥2 fresh frames) within a
// couple of control periods and the fade window opens promptly. The crossfade
// window IS the overlap where both rings are live — exactly the two-SAB regime
// the Stage-4 handoff calls out.

import { Bridge } from "../../dist/index.js";
import { makeSchemaA, makeSchemaB, CAP } from "./schema.js";

const state = {
  ringA: null, pushA: null,
  ringB: null, pushB: null,
  running: false,
  // live params (mirrored from the UI)
  carrier: 220,
  depth: 80,
  lfoHz: 5,
  controlHz: 60,
  res: 0.85,     // B's resonance target
  detune: 8,     // B's detune target (Hz)
  // pacing / diag
  seq: 0n,
  pushedA: 0, pushedB: 0, rejects: 0,
  startNs: 0,
  lastReportAt: 0, lastReportPushed: 0,
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
  if (p.res != null) state.res = p.res;
  if (p.detune != null) state.detune = p.detune;
}

function init({ sabA, sabB, params }) {
  state.ringA = new Bridge(sabA, CAP, makeSchemaA());
  state.pushA = state.ringA.scratchFrame();
  state.ringB = new Bridge(sabB, CAP, makeSchemaB());
  state.pushB = state.ringB.scratchFrame();
  if (params) applyParams(params);
  state.startNs = nowNs();
  state.lastReportAt = performance.now();
  state.running = true;
  self.postMessage({ type: "ready" });
  loop();
}

// Producer clock in nanoseconds; the consumer's PLL aligns this origin to the
// audio clock, so only rate + monotonicity matter, not the epoch.
function nowNs() {
  return performance.now() * 1e6;
}

function stampAndPush(tNs) {
  const t_s = (tNs - state.startNs) * 1e-9;
  const w = 2 * Math.PI * state.lfoHz;
  const d = state.depth;
  const sin = Math.sin(w * t_s);
  const cos = Math.cos(w * t_s);
  const f0 = state.carrier + d * sin;
  const f1 = d * w * cos;
  const f2 = -d * w * w * sin;
  const seq = state.seq;
  const tStamp = BigInt(Math.round(tNs));

  // A: bare carrier.
  const fa = state.pushA.freq;
  fa[0] = f0; fa[1] = f1; fa[2] = f2;
  state.pushA.seq = seq;
  state.pushA.tNs = tStamp;
  state.pushA.amp = 1.0;
  if (state.ringA.push(state.pushA)) state.pushedA++; else state.rejects++;

  // B: same freq trajectory + res/detune.
  const fb = state.pushB.freq;
  fb[0] = f0; fb[1] = f1; fb[2] = f2;
  state.pushB.seq = seq;
  state.pushB.tNs = tStamp;
  state.pushB.amp = 1.0;
  state.pushB.res = state.res;
  state.pushB.detune = state.detune;
  if (state.ringB.push(state.pushB)) state.pushedB++; else state.rejects++;

  state.seq += 1n;
}

function loop() {
  let nextWallMs = performance.now();
  const tick = () => {
    if (!state.running) return;
    stampAndPush(nowNs());

    const tNow = performance.now();
    if (tNow - state.lastReportAt > 250) {
      const dt = (tNow - state.lastReportAt) / 1000;
      // Rate is measured on ring B (the patch that stays drained after the swap
      // completes). Ring A stops being pulled once the consumer retires it, so
      // its ring fills and pushes reject — `pushedA` would freeze post-complete.
      self.postMessage({
        type: "diag",
        pushRateHz: (state.pushedB - state.lastReportPushed) / dt,
        pushedA: state.pushedA,
        pushedB: state.pushedB,
        rejects: state.rejects,
      });
      state.lastReportAt = tNow;
      state.lastReportPushed = state.pushedB;
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
