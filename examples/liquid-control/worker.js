// worker.js — the PRODUCER realm: the LNN "brain".
//
// Runs a small Liquid Time-Constant cell (lnn.js) in a DedicatedWorker on the
// CPU at a control rate (~100 Hz) and streams its 6-vector output into the
// audio thread through `BridgeWebNNSource.pushFromTypedArray()`.
//
// WHY THIS FILE IS THE WHOLE POINT OF THE SPIKE:
//   • `BridgeWebNNSource` is the bridge's neural-model → AudioWorklet adapter.
//     Its `pushFromTypedArray()` is the CPU path — it needs NO WebNN runtime
//     (we pass skipAvailabilityCheck) — so a small model running as plain JS on
//     a decent CPU streams straight into glitch-free audio. That is exactly the
//     "2 GB RAM, decent CPU, no tokens" envelope the Reddit commenter described.
//   • The brain runs at ~100 Hz; the audio thread renders at 48 kHz. The bridge
//     is the lock-free seam between those two clocks — audio never waits on the
//     model, the model never blocks audio.
//
// Swap the LiquidCell for a trained CfC, an ONNX-Runtime-Web session, or a real
// WebNN graph and NOT ONE LINE of the transport below changes — the brain is
// pluggable, the nervous system is fixed.

import { Bridge } from "../../dist/index.js";
import { BridgeWebNNSource } from "../../dist/experimental/index.js";
import { makeSchema } from "./schema.js";
import { LiquidCell, driveInput, CLOCK_HZ } from "./lnn.js";

const REPORT_EVERY_MS = 200;

const state = {
  bridge: null,
  source: null,
  cell: null,
  input: null, // reused [sin, cos, energy, mood, bias] — allocation-free loop
  k: 0,
  tickHz: 100,
  energy: 0.6,
  mood: 0.0,
  clockPhase: 0,
  startTime: 0,
  lastTick: 0,
  running: false,
  tickCount: 0,
  lastReportAt: 0,
  lastReportTicks: 0,
  timer: null,
};

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") return init(m).catch(fatal);
  if (m.type === "control") {
    if (typeof m.energy === "number") state.energy = m.energy;
    if (typeof m.mood === "number") state.mood = m.mood;
    if (typeof m.tickHz === "number") state.tickHz = m.tickHz;
    return;
  }
  if (m.type === "reseed") return reseed(m.seed >>> 0);
  if (m.type === "stop") return stop();
};

function fatal(err) {
  self.postMessage({ type: "fatal", message: err?.message ?? String(err) });
}

async function init({ sab, capacity, k, tickHz, energy, mood, seed }) {
  const schema = makeSchema(k);
  state.bridge = new Bridge(sab, capacity, schema);

  // The neural→audio adapter. CPU path only (skipAvailabilityCheck) — no WebNN
  // dependency. `seq` auto-increments per push; `tMacroNs` is stamped after the
  // samples land + the index bumps (fillScalars sees the new seq).
  state.source = new BridgeWebNNSource(state.bridge, {
    skipAvailabilityCheck: true,
    blockIndexField: "seq",
    fillScalars: (frame) => {
      frame.tMacroNs = BigInt(Math.floor(performance.now() * 1e6));
    },
  });

  state.cell = new LiquidCell({ nIn: 5, nHid: 24, nOut: k, seed: (seed ?? 1234) >>> 0 });
  state.input = new Float32Array(5);
  state.k = k;
  state.tickHz = tickHz ?? 100;
  state.energy = energy ?? 0.6;
  state.mood = mood ?? 0.0;
  state.startTime = performance.now();
  state.lastTick = state.startTime;
  state.lastReportAt = state.startTime;

  self.postMessage({ type: "ready", seed: state.cell.seed, nHid: state.cell.nHid });
  state.running = true;
  loop();
}

function reseed(seed) {
  if (!state.cell) return;
  state.cell = new LiquidCell({ nIn: 5, nHid: 24, nOut: state.k, seed });
  self.postMessage({ type: "ready", seed, nHid: state.cell.nHid });
}

function loop() {
  if (!state.running) return;

  const now = performance.now();
  // True elapsed dt (s) since the last tick — feeds the ODE solver so the
  // dynamics are wall-clock-correct even if setTimeout jitters.
  const dt = Math.min(0.05, Math.max(1e-4, (now - state.lastTick) / 1000));
  state.lastTick = now;

  // Build the drive vector (shared with the selftest) + one ODE step → the
  // K-vector control output, pushed straight into audio.
  state.clockPhase += CLOCK_HZ * dt;
  if (state.clockPhase >= 1) state.clockPhase -= 1;
  const inp = driveInput(state.input, state.clockPhase, state.energy, state.mood);
  const out = state.cell.step(inp, dt);
  state.source.pushFromTypedArray(out);
  state.tickCount++;

  if (now - state.lastReportAt > REPORT_EVERY_MS) {
    const elapsedSec = (now - state.lastReportAt) / 1000;
    const tickRateHz = (state.tickCount - state.lastReportTicks) / elapsedSec;
    self.postMessage({
      type: "diag",
      tickRateHz,
      pushed: state.source.pushedCount(),
      dropped: state.source.droppedCount(),
      available: state.bridge.available(),
      stateNorm: state.cell.stateNorm(),
      // Snapshot the live control vector for the page HUD (plain array → JSON).
      control: Array.from(out),
    });
    state.lastReportAt = now;
    state.lastReportTicks = state.tickCount;
  }

  // Pace to the requested control rate. setTimeout granularity is plenty at
  // ≤100 Hz; the ODE uses real dt so rate drift doesn't distort the dynamics.
  const periodMs = 1000 / state.tickHz;
  const drift = performance.now() - now;
  state.timer = setTimeout(loop, Math.max(0, periodMs - drift));
}

function stop() {
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}
