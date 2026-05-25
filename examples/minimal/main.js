// main.js — the page's main thread.
//
// Responsibilities:
//   1. Confirm crossOriginIsolated (SAB requires it).
//   2. Allocate a Bridge-backed SharedArrayBuffer for the shared schema.
//   3. Spawn the producer Worker and hand it the SAB.
//   4. Create the AudioContext (requires user gesture) and load the worklet.
//   5. Pass the SAB AND the schema layout (describeLayout JSON) to the
//      worklet via processorOptions, so the worklet can read frames without
//      importing the library on the audio thread.
//   6. Forward slider events to the worker as control updates.
//
// The worklet then runs at audio rate, pullLatest()'ing the newest macro
// frame each quantum using the layout the main thread handed it. The bridge
// does the heavy lifting.

import { Bridge } from "../../dist/index.js";
import { CAPACITY, N, makeSchema } from "./schema.js";
const STATUS = document.getElementById("status");
const START = document.getElementById("start");
const STOP = document.getElementById("stop");
const CTRL = document.getElementById("ctrl");

const state = {
  ctx: null,           // AudioContext
  node: null,          // AudioWorkletNode
  worker: null,        // DedicatedWorker (producer)
  ring: null,          // Bridge<physicsControlFrameSchema> (for available()-only debug; the actual data flows through SAB)
  running: false,
  lastReport: null,    // most recent diagnostics dict from worker
};

function setStatus(parts) {
  // parts is an array of [key, value, optional class]
  STATUS.innerHTML = parts
    .map(([k, v, cls]) => `<span class="k">${k.padEnd(14, " ")}</span> <span class="v ${cls ?? ""}">${v}</span>`)
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

  // 1. Allocate the ring's SAB.
  const schema = makeSchema(N);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  state.ring = new Bridge(sab, CAPACITY, schema);
  // describeLayout() emits a postMessageable byte-offset table the worklet
  // uses to inline its read without importing the library on the audio thread.
  const layout = state.ring.describeLayout();

  // 2. Spawn the worker, hand it the SAB.
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.onmessage = onWorkerMessage;
  state.worker.onerror = (e) => {
    setStatus([["status", `worker error: ${e.message}`, "err"]]);
  };
  state.worker.postMessage({
    type: "init",
    sab,
    capacity: CAPACITY,
    n: N,
    controlValue: Number(CTRL.value),
  });

  // 3. Spin up audio (this is the user-gesture-gated step).
  state.ctx = new AudioContext({ latencyHint: "interactive" });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "bridge-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sab, capacity: CAPACITY, n: N, layout },
  });
  state.node.port.onmessage = onWorkletMessage;
  state.node.connect(state.ctx.destination);

  state.running = true;
  STOP.disabled = false;
  setStatus([["status", "running — waiting for first worker tick…", "ok"]]);
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
  state.ring = null;
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
    state.lastReport = m;
    render();
  } else if (m.type === "fatal") {
    setStatus([["status", `worker fatal: ${m.message}`, "err"]]);
    stop();
  }
}

function onWorkletMessage(e) {
  // Worklet reports its own diagnostics periodically; merge with worker's.
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
    ["push rate", r.pushRateHz != null ? `${r.pushRateHz.toFixed(1)} Hz` : "—"],
    ["push rejects", String(r.pushRejects ?? 0)],
    ["worklet pulls", String(r.workletPulls ?? 0)],
    ["worklet misses", String(r.workletMisses ?? 0)],
    ["mean skipped", r.meanSkipped != null ? r.meanSkipped.toFixed(2) : "—"],
    ["available()", String(r.available ?? 0)],
    ["seq", String(r.lastSeq ?? 0)],
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

// One-line summary on first load so users without DevTools see the prereq.
setStatus([
  ["status", "idle. press Start to run."],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB", String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
  ["WebGPU", String(typeof navigator.gpu !== "undefined"), typeof navigator.gpu !== "undefined" ? "ok" : ""],
]);
