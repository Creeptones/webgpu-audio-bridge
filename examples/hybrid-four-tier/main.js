// main.js — the page's main thread (four-tier hybrid demo).
//
// Owns THREE SABs and the tier-1 + tier-4 PRODUCERS:
//
//   TIER 1  input lane (SpscRing<HybridInputSchema>)  — carrier-control events
//           written ~1 µs synchronous on each slider tick (BridgeInputLane).
//   TIER 3  residual block ring (Bridge)              — produced by the WORKER.
//   TIER 4  macro bridge (Bridge<MacroSchema>)        — a ~60 Hz producer here
//           stamps SMOOTH macro fields as position + VELOCITY so the worklet's
//           pullPredictedLatest can lead them forward.
//
// It also closes the tier-4 lead loop (handoff §3.3): the worker measures
// `lastReadbackUs` and posts it in its telemetry; we relay that straight to the
// worklet (`{ type: "readback" }`), which feeds it to the macro bridge's
// recordReadbackLatency(). No new measurement code — just plumbing.

import { Bridge, BridgeInputLane, SpscRing } from "../../dist/index.js";
import {
  BLOCK_SIZE,
  CHANNELS,
  CAPACITY,
  INPUT_CAPACITY,
  MACRO_CAPACITY,
  N_PARTIALS,
  EVT_FREQ,
  EVT_GAIN,
  makeBlockSchema,
  makeInputSchema,
  makeMacroSchema,
} from "./schema.js";

const STATUS = document.getElementById("status");
const START = document.getElementById("start");
const STOP = document.getElementById("stop");
const FREQ = document.getElementById("freq");
const FREQ_LABEL = document.getElementById("freq-label");
const RGAIN = document.getElementById("rgain");
const RGAIN_LABEL = document.getElementById("rgain-label");
const WIDTH = document.getElementById("width");
const WIDTH_LABEL = document.getElementById("width-label");
const CUTOFF = document.getElementById("cutoff");
const CUTOFF_LABEL = document.getElementById("cutoff-label");
const SWEEP = document.getElementById("sweep");
const PANRATE = document.getElementById("panrate");
const PANRATE_LABEL = document.getElementById("panrate-label");
const PREDICT = document.getElementById("predict");
const STALL = document.getElementById("stall");
const METER_L = document.getElementById("meter-l");
const METER_R = document.getElementById("meter-r");
const MODE_RADIOS = document.querySelectorAll("input[name=mode]");

// Tier-4 macro producer parameters (driven by the sliders above).
const CUTOFF_SWEEP_HZ = 0.4;     // LFO rate of the auto cutoff sweep
const CUTOFF_SWEEP_FRAC = 0.7;   // ± fraction of base the sweep travels
const MACRO_HZ = 60;             // macro control rate (well under audio quantum)

const state = {
  ctx: null,
  node: null,
  worker: null,
  running: false,
  lastReport: {},
  // Tier 1.
  inputRing: null,
  inputLane: null,
  inputFrame: null,
  seqInput: 0n,
  // Tier 4.
  macroBridge: null,
  macroFrame: null,
  macroSeq: 0n,
  macroTimer: 0,
  cutoffBase: Number(CUTOFF?.value ?? 6000),
  sweep: true,
  panRate: Number(PANRATE?.value ?? 0.25),
};

// ── Tier 1 fast-lane write (carrier control) ────────────────────────────────
function fireInputEvent(eventType, value0) {
  if (!state.inputLane || !state.inputFrame) return false;
  const ev = state.inputFrame;
  state.seqInput++;
  ev.seq          = state.seqInput;
  ev.tInputNs     = BigInt(Math.floor(performance.now() * 1e6));
  ev.eventType    = eventType;
  ev.sampleOffset = 0;
  ev.value0       = value0;
  ev.value1       = 0;
  return state.inputLane.push(ev);
}

// ── Tier 4 macro producer (position + VELOCITY per smooth field) ─────────────
// Runs at MACRO_HZ. Each field is an order-2 trajectory: index 0 = position,
// index 1 = velocity (the current sweep slope). Velocity = 0 for a held value,
// so prediction collapses to a hold — which is correct (handoff §5: "velocity
// must be real").
function macroTick() {
  if (!state.macroBridge || !state.macroFrame) return;
  const t = performance.now() / 1000;
  const fr = state.macroFrame;
  state.macroSeq++;
  fr.seq = state.macroSeq;
  fr.tMacroNs = BigInt(Math.floor(performance.now() * 1e6));

  // cutoff: optional sinusoidal sweep around the slider base. Position + the
  // analytic derivative as velocity so the lead is exact.
  const base = state.cutoffBase;
  if (state.sweep) {
    const w = 2 * Math.PI * CUTOFF_SWEEP_HZ;
    const depth = base * CUTOFF_SWEEP_FRAC;
    fr.cutoff[0] = base + depth * Math.sin(w * t);
    fr.cutoff[1] = depth * w * Math.cos(w * t);   // dHz/s
  } else {
    fr.cutoff[0] = base;
    fr.cutoff[1] = 0;                              // held → predict = hold
  }

  // azimuth: auto-pan LFO. panRate = 0 → centered hold.
  if (state.panRate > 0) {
    const wa = 2 * Math.PI * state.panRate;
    fr.azimuth[0] = Math.sin(wa * t);
    fr.azimuth[1] = wa * Math.cos(wa * t);        // angular velocity
  } else {
    fr.azimuth[0] = 0;
    fr.azimuth[1] = 0;
  }

  // morph: held (demonstrates a zero-velocity field → prediction holds).
  fr.morph[0] = 0;
  fr.morph[1] = 0;

  // Latest-wins: if the shallow ring is momentarily full, drop — the consumer
  // only ever reads the freshest macro frame anyway.
  state.macroBridge.push(fr);
}

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

  // Tier 3: residual block ring.
  const schema = makeBlockSchema(BLOCK_SIZE, CHANNELS);
  const { sab } = Bridge.allocate(CAPACITY, schema);

  // Tier 1: carrier-control input lane (producer side held here).
  const inputSchema = makeInputSchema();
  const { sab: inputSab } = SpscRing.allocate(INPUT_CAPACITY, inputSchema);
  state.inputRing = new SpscRing(inputSab, INPUT_CAPACITY, inputSchema);
  state.inputLane = new BridgeInputLane(state.inputRing);
  state.inputFrame = state.inputLane.scratchFrame();

  // Tier 4: macro bridge (producer side held here).
  const macroSchema = makeMacroSchema();
  const { sab: macroSab } = Bridge.allocate(MACRO_CAPACITY, macroSchema);
  state.macroBridge = new Bridge(macroSab, MACRO_CAPACITY, macroSchema);
  state.macroFrame = state.macroBridge.scratchFrame();

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
    channels: CHANNELS,
    nPartials: N_PARTIALS,
    carrierFreq: Number(FREQ.value),
    width: Number(WIDTH.value),
  });

  state.ctx = new AudioContext({ latencyHint: "interactive" });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "hybrid-four-tier-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      sab, capacity: CAPACITY, blockSize: BLOCK_SIZE, channels: CHANNELS,
      inputSab, inputCapacity: INPUT_CAPACITY,
      macroSab, macroCapacity: MACRO_CAPACITY,
      carrierFreq: Number(FREQ.value),
    },
  });
  state.node.port.onmessage = onWorkletMessage;
  state.node.connect(state.ctx.destination);

  // Only control-plane toggles ride postMessage (mode + predict A/B).
  state.node.port.postMessage({
    type: "config",
    mode: currentMode(),
    predict: PREDICT?.checked ?? true,
  });

  // Initial residual gain through the input lane (consistency with the carrier).
  fireInputEvent(EVT_GAIN, Number(RGAIN.value));

  // Start the tier-4 macro producer.
  state.macroSeq = 0n;
  state.macroTimer = setInterval(macroTick, 1000 / MACRO_HZ);

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
  if (state.macroTimer) { clearInterval(state.macroTimer); state.macroTimer = 0; }
  try { state.node?.disconnect(); } catch {}
  try { state.ctx?.close(); } catch {}
  try { state.worker?.postMessage({ type: "stop" }); } catch {}
  try { state.worker?.terminate(); } catch {}
  state.node = null;
  state.ctx = null;
  state.worker = null;
  state.inputRing = null;
  state.inputLane = null;
  state.inputFrame = null;
  state.macroBridge = null;
  state.macroFrame = null;
  state.lastReport = {};
  setMeter(0, 0);
  setStatus([["status", "stopped."]]);
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === "ready") {
    state.lastReport = { ...state.lastReport, backend: m.backend, adapter: m.adapter };
    render();
  } else if (m.type === "diag") {
    state.lastReport = { ...state.lastReport, ...m };
    // Close the tier-4 lead loop: relay the measured GPU readback wall to the
    // worklet, which feeds the macro bridge's recordReadbackLatency().
    if (typeof m.lastReadbackUs === "number" && state.node) {
      state.node.port.postMessage({ type: "readback", us: m.lastReadbackUs });
    }
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
    setMeter(m.peakL ?? 0, m.peakR ?? 0);
    render();
  }
}

function setMeter(peakL, peakR) {
  const pct = (p) => `${Math.min(100, Math.max(0, p * 130)).toFixed(0)}%`;
  if (METER_L) METER_L.style.width = pct(peakL);
  if (METER_R) METER_R.style.width = pct(peakR);
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
    ["last readback μs", r.lastReadbackUs != null ? r.lastReadbackUs.toFixed(0) : "—"],
    ["frames consumed", String(r.framesConsumed ?? 0)],
    ["underflow samples", String(r.underflowSamples ?? 0)],
    ["carrier events", String(state.seqInput)],
    ["events applied", String(r.inputDrained ?? 0)],
    ["── tier 4 ──", ""],
    ["predict", r.macroPredicted ? "ON (leading)" : "hold", r.macroPredicted ? "ok" : ""],
    ["lead applied", r.macroLeadMs != null ? `${r.macroLeadMs.toFixed(2)} ms` : "—"],
    ["confidence w", r.macroWeight != null ? r.macroWeight.toFixed(3) : "—"],
    ["cutoff (led)", r.cutoffHz != null ? `${r.cutoffHz.toFixed(0)} Hz` : "—"],
    ["azimuth (led)", r.azimuth != null ? r.azimuth.toFixed(3) : "—"],
  ]);
}

// ── Event wiring ────────────────────────────────────────────────────────────

FREQ.addEventListener("input", () => {
  const v = Number(FREQ.value);
  FREQ_LABEL.textContent = `${v.toFixed(0)} Hz`;
  // Carrier: sample-accurate via the input lane (tier 1). Residual: the slow
  // path — postMessage drives the WGSL uniform, lands ~85 ms later. The
  // ASYMMETRY (carrier instant, residual lagged) is the whole point.
  fireInputEvent(EVT_FREQ, v);
  state.worker?.postMessage({ type: "freq", value: v });
});

RGAIN.addEventListener("input", () => {
  const v = Number(RGAIN.value);
  RGAIN_LABEL.textContent = v.toFixed(2);
  fireInputEvent(EVT_GAIN, v);
});

WIDTH.addEventListener("input", () => {
  const v = Number(WIDTH.value);
  WIDTH_LABEL.textContent = v.toFixed(2);
  state.worker?.postMessage({ type: "width", value: v });
});

CUTOFF.addEventListener("input", () => {
  const v = Number(CUTOFF.value);
  CUTOFF_LABEL.textContent = `${v.toFixed(0)} Hz`;
  state.cutoffBase = v; // picked up by the next macroTick
});

SWEEP.addEventListener("change", () => { state.sweep = SWEEP.checked; });

PANRATE.addEventListener("input", () => {
  const v = Number(PANRATE.value);
  PANRATE_LABEL.textContent = v > 0 ? `${v.toFixed(2)} Hz` : "off (center)";
  state.panRate = v;
});

PREDICT.addEventListener("change", () => {
  state.node?.port.postMessage({ type: "config", predict: PREDICT.checked });
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
WIDTH_LABEL.textContent = Number(WIDTH.value).toFixed(2);
CUTOFF_LABEL.textContent = `${Number(CUTOFF.value).toFixed(0)} Hz`;
PANRATE_LABEL.textContent = Number(PANRATE.value) > 0 ? `${Number(PANRATE.value).toFixed(2)} Hz` : "off (center)";

setStatus([
  ["status", "idle. press Start to run."],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB", String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
  ["WebGPU", String(typeof navigator.gpu !== "undefined"), typeof navigator.gpu !== "undefined" ? "ok" : ""],
]);
