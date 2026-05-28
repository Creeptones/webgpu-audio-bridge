// main.js — the page's main thread (hybrid-residual demo).
//
// Mirrors examples/audio-rate/main.js but threads two extra controls — a
// mode toggle and a residual-gain slider — through to the worklet, plus
// a "Simulate GPU stall" button that pings the worker.

import { Bridge } from "../../dist/index.js";
import {
  BLOCK_SIZE,
  CAPACITY,
  N_PARTIALS,
  makeSchema,
} from "./schema.js";

const STATUS = document.getElementById("status");
const START = document.getElementById("start");
const STOP = document.getElementById("stop");
const FREQ = document.getElementById("freq");
const FREQ_LABEL = document.getElementById("freq-label");
const RGAIN = document.getElementById("rgain");
const RGAIN_LABEL = document.getElementById("rgain-label");
const STALL = document.getElementById("stall");
const MODE_RADIOS = document.querySelectorAll("input[name=mode]");

const state = {
  ctx: null,
  node: null,
  worker: null,
  running: false,
  lastReport: {},
};

function setStatus(parts) {
  STATUS.innerHTML = parts
    .map(([k, v, cls]) => `<span class="k">${k.padEnd(20, " ")}</span> <span class="v ${cls ?? ""}">${v}</span>`)
    .join("\n");
}

function isolationOk() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
}

function currentMode() {
  for (const r of MODE_RADIOS) if (r.checked) return r.value;
  return "hybrid";
}

async function start() {
  if (state.running) return;

  if (!isolationOk()) {
    setStatus([
      ["status", "FAILED — page is not crossOriginIsolated", "err"],
      ["fix", "serve with COOP: same-origin + COEP: require-corp"],
    ]);
    return;
  }
  if (typeof SharedArrayBuffer === "undefined") {
    setStatus([["status", "FAILED — SharedArrayBuffer unavailable", "err"]]);
    return;
  }

  START.disabled = true;
  setStatus([["status", "starting…"]]);

  const schema = makeSchema(BLOCK_SIZE);
  const { sab } = Bridge.allocate(CAPACITY, schema);

  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.onmessage = onWorkerMessage;
  state.worker.onerror = (e) => {
    setStatus([["status", `worker error: ${e.message}`, "err"]]);
  };
  state.worker.postMessage({
    type: "init",
    sab,
    capacity: CAPACITY,
    blockSize: BLOCK_SIZE,
    nPartials: N_PARTIALS,
    carrierFreq: Number(FREQ.value),
  });

  state.ctx = new AudioContext({ latencyHint: "interactive" });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "hybrid-residual-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sab, capacity: CAPACITY, blockSize: BLOCK_SIZE },
  });
  state.node.port.onmessage = onWorkletMessage;
  state.node.connect(state.ctx.destination);

  // Push initial config into the worklet.
  state.node.port.postMessage({
    type: "config",
    carrierFreq: Number(FREQ.value),
    residualGain: Number(RGAIN.value),
    mode: currentMode(),
  });

  state.running = true;
  STOP.disabled = false;
  STALL.disabled = false;
  setStatus([["status", "running — waiting for first producer tick…", "ok"]]);
}

function stop() {
  if (!state.running) return;
  state.running = false;
  STOP.disabled = true;
  STALL.disabled = true;
  START.disabled = false;
  try { state.node?.disconnect(); } catch {}
  try { state.ctx?.close(); } catch {}
  try { state.worker?.postMessage({ type: "stop" }); } catch {}
  try { state.worker?.terminate(); } catch {}
  state.node = null;
  state.ctx = null;
  state.worker = null;
  state.lastReport = {};
  setStatus([["status", "stopped."]]);
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === "ready") {
    state.lastReport = { ...state.lastReport, backend: m.backend, adapter: m.adapter };
    render();
  } else if (m.type === "diag") {
    state.lastReport = { ...state.lastReport, ...m };
    render();
  } else if (m.type === "fatal") {
    setStatus([["status", `worker fatal: ${m.message}`, "err"]]);
    stop();
  }
}

function onWorkletMessage(e) {
  const m = e.data;
  if (m.type === "diag") {
    state.lastReport = { ...state.lastReport, ...m };
    render();
  }
}

function render() {
  const r = state.lastReport;
  setStatus([
    ["status", r.stalledNow ? "STALLED" : "running", r.stalledNow ? "err" : "ok"],
    ["mode", r.mode ?? currentMode()],
    ["backend", r.backend ?? "—"],
    ["adapter", r.adapter ?? "—"],
    ["produce rate", r.pushRateHz != null ? `${r.pushRateHz.toFixed(1)} Hz` : "—"],
    ["pushed blocks", String(r.pushedBlocks ?? 0)],
    ["dropped readbacks", String(r.droppedReadbacks ?? 0)],
    ["last readback μs", r.lastReadbackUs != null ? r.lastReadbackUs.toFixed(0) : "—"],
    ["frames consumed", String(r.framesConsumed ?? 0)],
    ["underflow samples", String(r.underflowSamples ?? 0)],
    ["stall samples", String(r.stallSamplesTotal ?? 0)],
  ]);
}

// ── Event wiring ──────────────────────────────────────────────────────────

FREQ.addEventListener("input", () => {
  const v = Number(FREQ.value);
  FREQ_LABEL.textContent = `${v.toFixed(0)} Hz`;
  // Push to both worker (drives WGSL uniform) and worklet (drives CPU
  // sawtooth phase). The two are nominally locked because they read the
  // same slider value; minor drift across the ~85 ms transit window is
  // invisible because the residual's pitch only matters relative to the
  // carrier's, and the WGSL kernel recomputes the partials freshly per
  // block.
  state.worker?.postMessage({ type: "freq", value: v });
  state.node?.port.postMessage({ type: "config", carrierFreq: v });
});

RGAIN.addEventListener("input", () => {
  const v = Number(RGAIN.value);
  RGAIN_LABEL.textContent = v.toFixed(2);
  state.node?.port.postMessage({ type: "config", residualGain: v });
});

for (const r of MODE_RADIOS) {
  r.addEventListener("change", () => {
    state.node?.port.postMessage({ type: "config", mode: currentMode() });
    render();
  });
}

STALL.addEventListener("click", () => {
  state.worker?.postMessage({ type: "stall", durationMs: 250 });
});

START.addEventListener("click", () => { start().catch((e) => {
  setStatus([["status", `start failed: ${e.message ?? e}`, "err"]]);
  START.disabled = false;
}); });
STOP.addEventListener("click", stop);

// Initialize labels.
FREQ_LABEL.textContent = `${Number(FREQ.value).toFixed(0)} Hz`;
RGAIN_LABEL.textContent = Number(RGAIN.value).toFixed(2);

setStatus([
  ["status", "idle. press Start to run."],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB", String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
  ["WebGPU", String(typeof navigator.gpu !== "undefined"), typeof navigator.gpu !== "undefined" ? "ok" : ""],
]);
