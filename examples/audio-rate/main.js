// main.js — the page's main thread (audio-rate demo).
//
// Responsibilities:
//   1. Confirm crossOriginIsolated (SAB requires it).
//   2. Allocate a Bridge-backed SharedArrayBuffer for the block schema.
//   3. Spawn the producer Worker (runs WebGPU compute + BridgeBlockProducer).
//   4. Create the AudioContext (requires user gesture) and load the worklet.
//   5. Hand the worklet the SAB so it can construct a sibling Bridge +
//      BridgeBlockConsumer on the audio thread. Unlike the minimal demo,
//      this one DOES import the library on the audio thread — the
//      BlockConsumer's process(out) API is the entire point.
//   6. Forward slider events to the worker as control updates.

import { Bridge } from "../../dist/index.js";
import { BLOCK_SIZE, CAPACITY, N_VOICES, makeSchema } from "./schema.js";

const STATUS = document.getElementById("status");
const START = document.getElementById("start");
const STOP = document.getElementById("stop");
const CTRL = document.getElementById("ctrl");

const state = {
  ctx: null,
  node: null,
  worker: null,
  running: false,
  lastReport: null,
};

function setStatus(parts) {
  STATUS.innerHTML = parts
    .map(([k, v, cls]) => `<span class="k">${k.padEnd(18, " ")}</span> <span class="v ${cls ?? ""}">${v}</span>`)
    .join("\n");
}

function isolationOk() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
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

  // 1. Allocate the SAB for the block-frame ring.
  const schema = makeSchema(BLOCK_SIZE);
  const { sab } = Bridge.allocate(CAPACITY, schema);

  // 2. Spawn the worker, hand it the SAB + initial control.
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
    nVoices: N_VOICES,
    controlValue: Number(CTRL.value),
  });

  // 3. Spin up audio (user-gesture-gated). latencyHint 'playback' is the
  //    honest default for block mode — input-to-audible is already
  //    bounded by the ring depth × block size, so trading interactivity
  //    for a larger output buffer is a wash.
  state.ctx = new AudioContext({ latencyHint: "playback" });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "audio-rate-block-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sab, capacity: CAPACITY, blockSize: BLOCK_SIZE },
  });
  state.node.port.onmessage = onWorkletMessage;
  state.node.connect(state.ctx.destination);

  state.running = true;
  STOP.disabled = false;
  setStatus([["status", "running — waiting for first producer tick…", "ok"]]);
}

function stop() {
  if (!state.running) return;
  state.running = false;
  STOP.disabled = true;
  START.disabled = false;
  try { state.node?.disconnect(); } catch {}
  try { state.ctx?.close(); } catch {}
  try { state.worker?.postMessage({ type: "stop" }); } catch {}
  try { state.worker?.terminate(); } catch {}
  state.node = null;
  state.ctx = null;
  state.worker = null;
  setStatus([["status", "stopped."]]);
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === "ready") {
    setStatus([
      ["status", "running", "ok"],
      ["backend", m.backend],
      ["adapter", m.adapter ?? "—"],
    ]);
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
  const r = state.lastReport ?? {};
  setStatus([
    ["status", "running", "ok"],
    ["backend", r.backend ?? "—"],
    ["produce rate", r.pushRateHz != null ? `${r.pushRateHz.toFixed(1)} Hz` : "—"],
    ["push rejects", String(r.pushRejects ?? 0)],
    ["pushed blocks", String(r.pushedBlocks ?? 0)],
    ["dropped readbacks", String(r.droppedReadbacks ?? 0)],
    ["last readback μs", r.lastReadbackUs != null ? r.lastReadbackUs.toFixed(0) : "—"],
    ["frames consumed", String(r.framesConsumed ?? 0)],
    ["underflow samples", String(r.underflowSamples ?? 0)],
  ]);
}

CTRL.addEventListener("input", () => {
  state.worker?.postMessage({ type: "control", value: Number(CTRL.value) });
});

START.addEventListener("click", () => { start().catch((e) => {
  setStatus([["status", `start failed: ${e.message ?? e}`, "err"]]);
  START.disabled = false;
}); });
STOP.addEventListener("click", stop);

setStatus([
  ["status", "idle. press Start to run."],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB", String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
  ["WebGPU", String(typeof navigator.gpu !== "undefined"), typeof navigator.gpu !== "undefined" ? "ok" : ""],
]);
