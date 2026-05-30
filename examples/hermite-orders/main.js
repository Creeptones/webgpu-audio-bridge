// main.js — page thread for the Hermite-order A/B demo.
//
//   1. Allocate the control-rate Bridge SAB.
//   2. Spawn the synthetic producer Worker (analytic FM trajectory).
//   3. Create the AudioContext + load the worklet; hand it the SAB.
//   4. Route worklet → AnalyserNode → destination so the seam-image spray is
//      VISIBLE (the order difference lives in the high sidebands).
//   5. Wire the order toggle (→ worklet) and the producer sliders (→ worker).

import { Bridge } from "../../dist/index.js";
import { makeSchema, CAPACITY } from "./schema.js";

const $ = (id) => document.getElementById(id);
const STATUS = $("status");
const START = $("start");
const STOP = $("stop");
const CANVAS = $("spectrum");
const CTX2D = CANVAS.getContext("2d");

const ORDER_BTNS = [$("order-cubic"), $("order-quintic"), $("order-septic")];
const ORDER_LABELS = ["cubic · C¹", "quintic · C²", "septic · C³"];

const SLIDERS = {
  controlHz: $("controlHz"),
  carrier: $("carrier"),
  lfoHz: $("lfoHz"),
  depth: $("depth"),
};

const state = {
  ctx: null,
  node: null,
  analyser: null,
  worker: null,
  running: false,
  activeOrder: 2,
  raf: 0,
  diag: {},
};

function isolationOk() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
}

function params() {
  return {
    controlHz: Number(SLIDERS.controlHz.value),
    carrier: Number(SLIDERS.carrier.value),
    lfoHz: Number(SLIDERS.lfoHz.value),
    depth: Number(SLIDERS.depth.value),
  };
}

function setStatus(parts) {
  STATUS.innerHTML = parts
    .map(([k, v, cls]) => `<span class="k">${k.padEnd(16, " ")}</span> <span class="v ${cls ?? ""}">${v}</span>`)
    .join("\n");
}

function highlightOrder() {
  ORDER_BTNS.forEach((b, i) => b.classList.toggle("on", i === state.activeOrder));
}

function setOrder(order) {
  state.activeOrder = order;
  highlightOrder();
  state.node?.port.postMessage({ type: "order", order });
}

async function start() {
  if (state.running) return;
  if (!isolationOk()) {
    setStatus([["status", "FAILED — not crossOriginIsolated", "err"],
      ["fix", "serve with COOP/COEP (serve.mjs does)"]]);
    return;
  }
  if (typeof SharedArrayBuffer === "undefined") {
    setStatus([["status", "FAILED — SharedArrayBuffer unavailable", "err"]]);
    return;
  }
  START.disabled = true;
  setStatus([["status", "starting…"]]);

  // 1. SAB for the control-rate ring.
  const { sab } = Bridge.allocate(CAPACITY, makeSchema());

  // 2. Producer worker.
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.onmessage = onWorkerMessage;
  state.worker.onerror = (e) => setStatus([["status", `worker error: ${e.message}`, "err"]]);
  state.worker.postMessage({ type: "init", sab, params: params() });

  // 3. Audio. latencyHint 'interactive' — the demo's interpolation latency is
  //    deliberate and lives in the worklet, not the output buffer.
  state.ctx = new AudioContext({ latencyHint: "interactive" });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "hermite-order-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sab },
  });
  state.node.port.onmessage = onWorkletMessage;

  // 4. Spectrum tap.
  state.analyser = new AnalyserNode(state.ctx, { fftSize: 4096, smoothingTimeConstant: 0.6 });
  state.node.connect(state.analyser);
  state.analyser.connect(state.ctx.destination);

  setOrder(state.activeOrder);
  state.running = true;
  STOP.disabled = false;
  drawSpectrum();
  setStatus([["status", "running", "ok"]]);
}

function stop() {
  if (!state.running) return;
  state.running = false;
  cancelAnimationFrame(state.raf);
  STOP.disabled = true;
  START.disabled = false;
  try { state.node?.disconnect(); } catch {}
  try { state.analyser?.disconnect(); } catch {}
  try { state.ctx?.close(); } catch {}
  try { state.worker?.postMessage({ type: "stop" }); } catch {}
  try { state.worker?.terminate(); } catch {}
  state.node = state.analyser = state.ctx = state.worker = null;
  CTX2D.clearRect(0, 0, CANVAS.width, CANVAS.height);
  setStatus([["status", "stopped."]]);
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === "diag") { state.diag = { ...state.diag, ...m }; render(); }
}
function onWorkletMessage(e) {
  const m = e.data;
  if (m.type === "diag") { state.diag = { ...state.diag, ...m }; render(); }
}

function render() {
  const d = state.diag;
  setStatus([
    ["status", "running", "ok"],
    ["active order", ORDER_LABELS[state.activeOrder], "hot"],
    ["control rate", `${SLIDERS.controlHz.value} Hz`],
    ["produce rate", d.pushRateHz != null ? `${d.pushRateHz.toFixed(1)} Hz` : "—"],
    ["interior frac", d.interiorFrac != null ? `${(d.interiorFrac * 100).toFixed(0)} %` : "—"],
    ["interp latency", d.latencyMs != null ? `${d.latencyMs.toFixed(1)} ms` : "—"],
    ["pushed frames", String(d.pushed ?? 0)],
  ]);
}

// ─── Spectrum rendering ─────────────────────────────────────────────────────
// Linear frequency axis 0…3 kHz. The carrier sits low; the seam-image "spray"
// is the high-frequency skirt around and above it — fatter on cubic, thinner
// on septic. Watch it change as you toggle orders or drop the control rate.
const SPECTRUM_MAX_HZ = 3000;

function drawSpectrum() {
  if (!state.running || !state.analyser) return;
  const a = state.analyser;
  const bins = a.frequencyBinCount;
  const data = new Float32Array(bins);
  a.getFloatFrequencyData(data);

  const W = CANVAS.width, H = CANVAS.height;
  CTX2D.clearRect(0, 0, W, H);

  // grid
  CTX2D.strokeStyle = "rgba(255,255,255,0.07)";
  CTX2D.lineWidth = 1;
  for (let hz = 500; hz < SPECTRUM_MAX_HZ; hz += 500) {
    const x = (hz / SPECTRUM_MAX_HZ) * W;
    CTX2D.beginPath(); CTX2D.moveTo(x, 0); CTX2D.lineTo(x, H); CTX2D.stroke();
  }

  const nyquist = state.ctx.sampleRate / 2;
  const maxBin = Math.min(bins, Math.ceil((SPECTRUM_MAX_HZ / nyquist) * bins));
  const minDb = -110, maxDb = -10;
  const colors = ["#ff7a59", "#ffd166", "#5bd1a0"]; // cubic / quintic / septic
  CTX2D.strokeStyle = colors[state.activeOrder];
  CTX2D.lineWidth = 1.5;
  CTX2D.beginPath();
  for (let k = 0; k < maxBin; k++) {
    const hz = (k / bins) * nyquist;
    const x = (hz / SPECTRUM_MAX_HZ) * W;
    const db = Math.max(minDb, Math.min(maxDb, data[k]));
    const y = H - ((db - minDb) / (maxDb - minDb)) * H;
    if (k === 0) CTX2D.moveTo(x, y); else CTX2D.lineTo(x, y);
  }
  CTX2D.stroke();

  // label
  CTX2D.fillStyle = colors[state.activeOrder];
  CTX2D.font = "13px ui-monospace, monospace";
  CTX2D.fillText(ORDER_LABELS[state.activeOrder], 10, 18);
  CTX2D.fillStyle = "rgba(255,255,255,0.4)";
  CTX2D.fillText("0", 2, H - 4);
  CTX2D.fillText(`${SPECTRUM_MAX_HZ / 1000} kHz`, W - 44, H - 4);

  state.raf = requestAnimationFrame(drawSpectrum);
}

// ─── Wiring ─────────────────────────────────────────────────────────────────
ORDER_BTNS.forEach((b, i) => b.addEventListener("click", () => setOrder(i)));

for (const key of Object.keys(SLIDERS)) {
  SLIDERS[key].addEventListener("input", () => {
    $(`${key}-val`).textContent = SLIDERS[key].value;
    state.worker?.postMessage({ type: "params", params: params() });
    if (key === "controlHz") render();
  });
}

START.addEventListener("click", () => start().catch((e) => {
  setStatus([["status", `start failed: ${e.message ?? e}`, "err"]]);
  START.disabled = false;
}));
STOP.addEventListener("click", stop);

// initial slider labels
for (const key of Object.keys(SLIDERS)) $(`${key}-val`).textContent = SLIDERS[key].value;
highlightOrder();
setStatus([
  ["status", "idle. press Start.", ""],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB", String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
  ["tip", "drop control rate → hear cubic buzz"],
]);
