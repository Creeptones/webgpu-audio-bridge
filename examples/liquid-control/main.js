// main.js — the page thread. Wires the three realms together:
//
//   1. Confirm crossOriginIsolated (SAB needs it).
//   2. Allocate the Bridge-backed SAB for the control schema.
//   3. Spawn the LNN worker (the brain) and hand it the SAB + a seed.
//   4. Create the AudioContext + load the worklet (the synth voice), handing it
//      the SAB and the describeLayout() table.
//   5. Forward energy/mood/tick-rate sliders to the worker; offer a reseed dice
//      to roll a fresh random liquid network (a new texture).
//
// The brain streams control @100 Hz; the voice renders @48 kHz; the bridge is
// the lock-free seam. Nothing here touches audio-rate data — it just sets up
// the pipe and renders diagnostics.

import { Bridge } from "../../dist/index.js";
import { CAPACITY, K, makeSchema } from "./schema.js";

const $ = (id) => document.getElementById(id);
const START = $("start");
const STOP = $("stop");
const RESEED = $("reseed");
const STATUS = $("status");
const HUD = $("hud");
const ENERGY = $("energy");
const MOOD = $("mood");
const RATE = $("rate");

const CONTROL_LABELS = ["pitch", "cutoff", "amp", "vibrato", "detune", "tilt"];

const state = {
  ctx: null,
  node: null,
  worker: null,
  running: false,
  seed: 1234,
  report: {},
};

const isoOk = () => typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;

function setStatus(msg, cls) {
  STATUS.innerHTML = `<span class="k">status</span> <span class="v ${cls ?? ""}">${msg}</span>`;
}

// A 12-cell bar for a control value in [−1, 1].
const SPARK = "▁▂▃▄▅▆▇█";
function bar(v) {
  const u = Math.min(1, Math.max(0, (v + 1) * 0.5));
  return SPARK[Math.min(7, Math.round(u * 7))].repeat(1) + "";
}
function meter(v) {
  const u = Math.min(1, Math.max(0, (v + 1) * 0.5));
  const cells = 14;
  const on = Math.round(u * cells);
  return "█".repeat(on) + "·".repeat(cells - on);
}

function render() {
  const r = state.report;
  const lines = [];
  lines.push(
    `<span class="k">isolated</span> <span class="v ${isoOk() ? "ok" : "err"}">${isoOk()}</span>  ·  ` +
      `<span class="k">seed</span> <span class="v">#${state.seed}</span>  ·  ` +
      `<span class="k">brain</span> <span class="v">${r.nHid ?? 24}-neuron LTC</span>`,
  );
  lines.push(
    `<span class="k">tick rate</span> <span class="v">${r.tickRateHz != null ? r.tickRateHz.toFixed(0) + " Hz" : "—"}</span>  ·  ` +
      `<span class="k">pushed</span> <span class="v">${r.pushed ?? 0}</span>  ·  ` +
      `<span class="k">dropped</span> <span class="v ${r.dropped ? "hot" : ""}">${r.dropped ?? 0}</span>  ·  ` +
      `<span class="k">state‖x‖</span> <span class="v">${r.stateNorm != null ? r.stateNorm.toFixed(2) : "—"}</span>`,
  );
  lines.push(
    `<span class="k">worklet</span> <span class="v">${r.workletPulls ?? 0} pulls · ${r.workletMisses ?? 0} misses</span>  ·  ` +
      `<span class="k">voice</span> <span class="v">${r.freq != null ? r.freq.toFixed(1) + " Hz" : "—"} · cutoff ${r.cutoff != null ? (r.cutoff / 1000).toFixed(2) + " kHz" : "—"}</span>`,
  );
  if (Array.isArray(r.control)) {
    lines.push(`<span class="k dim">— live control vector (LNN read-out) —</span>`);
    for (let i = 0; i < r.control.length; i++) {
      const name = CONTROL_LABELS[i] ?? `c${i}`;
      lines.push(
        `<span class="k">${name.padEnd(8, " ")}</span> <span class="v">${meter(r.control[i])} <span class="dim">${r.control[i].toFixed(3)}</span></span>`,
      );
    }
  }
  HUD.innerHTML = lines.join("\n");
}

async function start() {
  if (state.running) return;
  if (!isoOk()) {
    setStatus("FAILED — page is not crossOriginIsolated (serve via serve.mjs)", "err");
    return;
  }
  if (typeof SharedArrayBuffer === "undefined") {
    setStatus("FAILED — SharedArrayBuffer unavailable", "err");
    return;
  }
  START.disabled = true;
  setStatus("starting…");

  // Allocate the ring + describe its layout for the worklet.
  const schema = makeSchema(K);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  const ring = new Bridge(sab, CAPACITY, schema);
  const layout = ring.describeLayout();

  // Spawn the brain.
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.onmessage = onWorkerMessage;
  state.worker.onerror = (e) => setStatus(`worker error: ${e.message ?? e}`, "err");
  state.worker.postMessage({
    type: "init",
    sab,
    capacity: CAPACITY,
    k: K,
    tickHz: Number(RATE.value),
    energy: Number(ENERGY.value),
    mood: Number(MOOD.value),
    seed: state.seed,
  });

  // Spin up audio (user-gesture-gated).
  state.ctx = new AudioContext({ latencyHint: "interactive" });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "liquid-control-voice", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sab, capacity: CAPACITY, k: K, layout },
  });
  state.node.port.onmessage = onWorkletMessage;
  state.node.connect(state.ctx.destination);

  state.running = true;
  STOP.disabled = false;
  RESEED.disabled = false;
  setStatus("running — the liquid net is driving the voice. Tweak energy/mood, or reseed 🎲.", "ok");
}

function stop() {
  if (!state.running) return;
  state.running = false;
  STOP.disabled = true;
  RESEED.disabled = true;
  START.disabled = false;
  try {
    state.node?.disconnect();
  } catch {}
  try {
    state.ctx?.close();
  } catch {}
  try {
    state.worker?.postMessage({ type: "stop" });
  } catch {}
  try {
    state.worker?.terminate();
  } catch {}
  state.node = null;
  state.ctx = null;
  state.worker = null;
  setStatus("stopped.");
}

function reseed() {
  // A fresh random network = a fresh texture. Cheap to explore "is it musical?"
  state.seed = (state.seed * 1664525 + 1013904223) >>> 0;
  state.worker?.postMessage({ type: "reseed", seed: state.seed });
  setStatus(`reseeded → network #${state.seed}`, "ok");
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === "ready") {
    state.report.nHid = m.nHid;
    if (typeof m.seed === "number") state.seed = m.seed;
    render();
  } else if (m.type === "diag") {
    state.report = { ...state.report, ...m };
    render();
  } else if (m.type === "fatal") {
    setStatus(`worker fatal: ${m.message}`, "err");
    stop();
  }
}

function onWorkletMessage(e) {
  const m = e.data;
  if (m.type === "diag") {
    state.report = { ...state.report, ...m };
    render();
  }
}

// ── controls ───────────────────────────────────────────────────────────────
ENERGY.addEventListener("input", () => {
  $("energy-val").textContent = Number(ENERGY.value).toFixed(2);
  state.worker?.postMessage({ type: "control", energy: Number(ENERGY.value) });
});
MOOD.addEventListener("input", () => {
  $("mood-val").textContent = Number(MOOD.value).toFixed(2);
  state.worker?.postMessage({ type: "control", mood: Number(MOOD.value) });
});
RATE.addEventListener("input", () => {
  $("rate-val").textContent = RATE.value;
  state.worker?.postMessage({ type: "control", tickHz: Number(RATE.value) });
});
for (const [el, id] of [[ENERGY, "energy"], [MOOD, "mood"], [RATE, "rate"]]) {
  $(`${id}-val`).textContent = el.value;
}

START.addEventListener("click", () =>
  start().catch((e) => {
    setStatus(`start failed: ${e.message ?? e}`, "err");
    START.disabled = false;
  }),
);
STOP.addEventListener("click", stop);
RESEED.addEventListener("click", reseed);

setStatus(`idle. press Start. isolated=${isoOk()} · SAB=${typeof SharedArrayBuffer !== "undefined"}`);
