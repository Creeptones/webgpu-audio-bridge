// main.js — the page thread. Allocates the MP→SC fan-in topology ONCE with
// `connectFanIn`, hands the clone-safe handle to three producer Workers + one
// AudioWorklet consumer, and renders the live HUD.
//
// The whole Stage-3 story in one file:
//   1. connectFanIn(spec)  → allocate + init the shared MpmcRing SAB once,
//                            reserve SLACK, get a clone-safe handle.
//   2. postMessage(handle) → every producer worker + the worklet mountFanIn it.
//   3. The HUD proves: three independent push rates, one audio thread, torn=0
//      always, graceful counted drop under "Flood".

import { connectFanIn } from "../../dist/experimental/index.js";
import {
  makeFanInSchema,
  PRODUCER_COUNT,
  CAPACITY,
  PRODUCER_FREQS,
  PRODUCER_RATES,
} from "./schema.js";

const $ = (id) => document.getElementById(id);
const START = $("start");
const FLOOD = $("flood");
const STOP = $("stop");

const state = {
  running: false,
  flooding: false,
  topo: null,
  workers: [],
  ctx: null,
  node: null,
  rate: Array.from({ length: PRODUCER_COUNT }, () => ({ pushed: 0, dropped: 0, rateHz: 0 })),
  diag: { consumed: 0, dropped: 0, torn: 0, overrunLost: 0, available: 0, freq: [], amp: [] },
};

function isolationOk() {
  return typeof crossOriginIsolated === "undefined" ? false : crossOriginIsolated === true;
}

function setStatus(rows) {
  $("status").innerHTML = rows
    .map(([k, v, cls]) => `<div class="row"><span class="k">${k}</span><span class="v ${cls ?? ""}">${v}</span></div>`)
    .join("");
}

async function start() {
  if (state.running) return;
  if (!isolationOk()) {
    setStatus([["status", "FAILED — not crossOriginIsolated", "err"], ["fix", "serve via serve.mjs (sets COOP/COEP)"]]);
    return;
  }
  if (typeof SharedArrayBuffer === "undefined") {
    setStatus([["status", "FAILED — SharedArrayBuffer unavailable", "err"]]);
    return;
  }
  START.disabled = true;
  setStatus([["status", "starting…"]]);

  // 1. Allocate the fan-in topology ONCE. connectFanIn probes the (real,
  //    isolated) environment → Turbo, sizes the ring, MpmcRing.creates +
  //    initLayouts the SAB. A non-isolated env would have thrown above.
  const schema = makeFanInSchema();
  state.topo = connectFanIn({
    schema,
    producerCount: PRODUCER_COUNT,
    capacity: CAPACITY,
  });
  const handle = state.topo.handle;

  // 2. Three producer workers, each mounting the SAME handle.
  state.workers = [];
  for (let p = 0; p < PRODUCER_COUNT; p++) {
    const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "rate") {
        state.rate[m.producerId] = { pushed: m.pushed, dropped: m.dropped, rateHz: m.rateHz };
        render();
      }
    };
    w.onerror = (e) => setStatus([["status", `worker ${p} error: ${e.message}`, "err"]]);
    // SABs are shared, never transferred — pass the handle as a plain clone.
    w.postMessage({ type: "mount", handle, producerId: p, baseFreq: PRODUCER_FREQS[p], rateHz: PRODUCER_RATES[p] });
    state.workers.push(w);
  }

  // 3. Audio + the consumer worklet, mounting the SAME handle.
  state.ctx = new AudioContext({ latencyHint: "interactive" });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "fan-in-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { handle },
  });
  state.node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "diag") { state.diag = { ...state.diag, ...m }; render(); }
  };
  state.node.connect(state.ctx.destination);
  await state.ctx.resume();

  state.running = true;
  STOP.disabled = false;
  FLOOD.disabled = false;
  render();
}

function toggleFlood() {
  state.flooding = !state.flooding;
  for (const w of state.workers) w.postMessage({ type: "flood", on: state.flooding });
  FLOOD.textContent = state.flooding ? "Stop flood" : "Flood (overrun the ring)";
  FLOOD.classList.toggle("hot", state.flooding);
}

async function stop() {
  if (!state.running) return;
  for (const w of state.workers) { w.postMessage({ type: "stop" }); w.terminate(); }
  state.workers = [];
  if (state.node) state.node.disconnect();
  if (state.ctx) await state.ctx.close();
  state.running = false;
  state.flooding = false;
  START.disabled = false;
  STOP.disabled = true;
  FLOOD.disabled = true;
  FLOOD.textContent = "Flood (overrun the ring)";
  FLOOD.classList.remove("hot");
  setStatus([["status", "stopped"]]);
}

function render() {
  const sz = state.topo?.handle.sizing;
  setStatus([
    ["mode", "Turbo (cross-origin isolated) ✓", "ok"],
    ["ring", `capacity ${CAPACITY} · usableDepth ${sz?.usableDepth ?? "—"} · reservedSlack ${sz?.reservedSlack ?? "—"}`],
    ["producers", `${PRODUCER_COUNT} concurrent (fixed at allocation)`],
    [state.flooding ? "FLOOD" : "load", state.flooding ? "ON — producers overrunning the ring" : "normal pacing", state.flooding ? "hot" : ""],
  ]);

  // Per-producer rows.
  const rows = [];
  for (let p = 0; p < PRODUCER_COUNT; p++) {
    const r = state.rate[p];
    const f = state.diag.freq?.[p];
    const a = state.diag.amp?.[p];
    rows.push(
      `<tr>
        <td class="pid p${p}">producer ${p}</td>
        <td>${PRODUCER_RATES[p]} Hz</td>
        <td>${(r.pushed ?? 0).toLocaleString()}</td>
        <td class="${(r.dropped ?? 0) > 0 ? "warn" : ""}">${(r.dropped ?? 0).toLocaleString()}</td>
        <td>${f != null ? f.toFixed(1) + " Hz" : "—"}</td>
        <td>${a != null ? a.toFixed(2) : "—"}</td>
      </tr>`,
    );
  }
  $("producers").innerHTML = rows.join("");

  // Consumer stats. torn MUST be 0 — render it green when 0, red if it ever isn't.
  const d = state.diag;
  $("consumer").innerHTML = [
    ["consumed", (d.consumed ?? 0).toLocaleString()],
    ["available (in-flight)", `${d.available ?? 0} / ${state.topo?.handle.sizing.usableDepth ?? CAPACITY}`],
    ["droppedFrames()", (d.dropped ?? 0).toLocaleString(), (d.dropped ?? 0) > 0 ? "warn" : ""],
    ["overrunLostFrames()", (d.overrunLost ?? 0).toLocaleString(), (d.overrunLost ?? 0) > 0 ? "err" : "ok"],
    ["tornFrameCount()", (d.torn ?? 0).toLocaleString(), (d.torn ?? 0) === 0 ? "ok" : "err"],
    ["drained last quantum", (d.drainedLast ?? 0).toLocaleString()],
  ]
    .map(([k, v, cls]) => `<div class="row"><span class="k">${k}</span><span class="v ${cls ?? ""}">${v}</span></div>`)
    .join("");
}

START.addEventListener("click", () => start().catch((e) => setStatus([["status", String(e), "err"]])));
FLOOD.addEventListener("click", toggleFlood);
STOP.addEventListener("click", () => stop());

setStatus([
  ["status", isolationOk() ? "ready — press Start" : "NOT cross-origin isolated", isolationOk() ? "ok" : "err"],
  ["isolation", isolationOk() ? "crossOriginIsolated ✓" : "serve via npm run dev:mpmc-fan-in", isolationOk() ? "ok" : "err"],
]);
render();
