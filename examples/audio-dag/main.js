// main.js — the page (allocating) thread of the audio-DAG demo.
//
// The whole Stage-2 story in one file:
//   1. connectGraph(spec) → allocate + initLayout EVERY edge's SAB once on this
//      thread, get one clone-safe handle bag (per-edge handles + node→incidence
//      index + the criticalPathLatencyMs / totalSabBytes roll-ups).
//   2. postMessage(handle) → each producer/intermediate/meter Worker + the
//      AudioWorklet `mountGraph`s ONLY its incident edges, as the right facades.
//   3. The HUD proves: two oscillators fan into a mixer, a chain of two
//      intermediate nodes (mixer, fx) each on its own thread, and a broadcast that
//      reaches BOTH the audio worklet AND a meter worker — every sink seeing every
//      frame (broadcast-completeness), tornGuarded() === 0 always, and audio that
//      never stalls even when you Flood the sources or drag the FX gain.
//
// Imports straight from dist/connectGraph.js — NOT the experimental barrel, which
// transitively pulls the JIT's bare `acorn` import (no browser resolution here).

import { connectGraph } from "../../dist/connectGraph.js";
import { makeSchemas, makeGraphSpec, VOICE_RATES } from "./schema.js";

const $ = (id) => document.getElementById(id);
const START = $("start");
const FLOOD = $("flood");
const STOP = $("stop");
const GAIN = $("gain");

const state = {
  running: false,
  flooding: false,
  topo: null,
  workers: {}, // node → Worker
  ctx: null,
  node: null,
  diag: {}, // node → latest diag message
};

function isolationOk() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
}

function setRows(el, rows) {
  $(el).innerHTML = rows
    .map(([k, v, cls]) => `<div class="row"><span class="k">${k}</span><span class="v ${cls ?? ""}">${v}</span></div>`)
    .join("");
}

async function start() {
  if (state.running) return;
  if (!isolationOk()) {
    setRows("topology", [["status", "FAILED — not crossOriginIsolated", "err"], ["fix", "serve via npm run dev:audio-dag", "err"]]);
    return;
  }
  if (typeof SharedArrayBuffer === "undefined") {
    setRows("topology", [["status", "FAILED — SharedArrayBuffer unavailable", "err"]]);
    return;
  }
  START.disabled = true;

  // 1. Allocate the whole DAG ONCE. connectGraph probes the real (isolated)
  //    environment → Turbo, sizes + initLayouts every edge's SAB. A non-isolated
  //    host would have thrown ConnectUnsupportedError above.
  const schemas = makeSchemas();
  state.topo = connectGraph(makeGraphSpec(schemas));
  const handle = state.topo.handle;

  // 2. Spawn the worker nodes. Each mountGraphs ONLY its incident edges.
  const spawn = (file, node, producerId) => {
    const w = new Worker(new URL(file, import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "diag") { state.diag[m.node] = m; render(); }
    };
    w.onerror = (e) => setRows("topology", [["status", `${node} worker error: ${e.message}`, "err"]]);
    w.postMessage({ type: "mount", handle, node, producerId });
    state.workers[node] = w;
    return w;
  };
  spawn("./osc.worker.js", "osc0", 0);
  spawn("./osc.worker.js", "osc1", 1);
  spawn("./mixer.worker.js", "mixer");
  spawn("./fx.worker.js", "fx");
  spawn("./meter.worker.js", "meter");

  // Push the current FX gain to the freshly-mounted fx node.
  state.workers.fx.postMessage({ type: "gain", value: Number(GAIN.value) });

  // 3. The audio sink: the AudioWorklet `speaker` node, mounting the SAME handle.
  state.ctx = new AudioContext({ latencyHint: "interactive" });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "dag-speaker", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { handle },
  });
  state.node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "diag") { state.diag[m.node] = m; render(); }
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
  for (const node of ["osc0", "osc1"]) state.workers[node]?.postMessage({ type: "flood", on: state.flooding });
  FLOOD.textContent = state.flooding ? "Stop flood" : "Flood (overrun the fan-in)";
  FLOOD.classList.toggle("hot", state.flooding);
  render();
}

async function stop() {
  if (!state.running) return;
  for (const w of Object.values(state.workers)) { w.postMessage({ type: "stop" }); w.terminate(); }
  state.workers = {};
  if (state.node) state.node.disconnect();
  if (state.ctx) await state.ctx.close();
  state.running = false;
  state.flooding = false;
  state.diag = {};
  START.disabled = false;
  STOP.disabled = true;
  FLOOD.disabled = true;
  FLOOD.textContent = "Flood (overrun the fan-in)";
  FLOOD.classList.remove("hot");
  setRows("topology", [["status", "stopped"]]);
}

function fmt(n) { return (n ?? 0).toLocaleString(); }

function render() {
  const topo = state.topo;
  const sab = topo ? (topo.totalSabBytes / 1024).toFixed(1) + " KB" : "—";
  const crit = topo && Number.isFinite(topo.criticalPathLatencyMs)
    ? topo.criticalPathLatencyMs.toFixed(2) + " ms" : "—";
  setRows("topology", [
    ["mode", isolationOk() ? "Turbo (cross-origin isolated) ✓" : "NOT isolated", isolationOk() ? "ok" : "err"],
    ["edges", "fanin (mpmc) · link (spsc) · bcast (spmc)"],
    ["total SAB", sab],
    ["critical path", crit],
    [state.flooding ? "FLOOD" : "load", state.flooding ? "ON — oscillators overrunning the fan-in" : "normal", state.flooding ? "hot" : ""],
  ]);

  // ── Graph flow: one row per node, in topological order ──
  const d = state.diag;
  const o0 = d.osc0 ?? {}, o1 = d.osc1 ?? {}, mx = d.mixer ?? {}, fx = d.fx ?? {}, sp = d.speaker ?? {}, me = d.meter ?? {};
  const rows = [
    ["osc0", `source · ${VOICE_RATES[0]} Hz`, `pushed ${fmt(o0.pushed)}`, `dropped ${fmt(o0.dropped)}`, (o0.dropped ?? 0) > 0 ? "warn" : ""],
    ["osc1", `source · ${VOICE_RATES[1]} Hz`, `pushed ${fmt(o1.pushed)}`, `dropped ${fmt(o1.dropped)}`, (o1.dropped ?? 0) > 0 ? "warn" : ""],
    ["mixer", "intermediate (own thread)", `forwarded ${fmt(mx.forwarded)}`, `fan-in torn ${fmt(mx.torn)}`, (mx.torn ?? 0) === 0 ? "ok" : "err"],
    ["fx", "intermediate (own thread)", `produced ${fmt(fx.produced)}`, `gain ${(fx.gain ?? 0).toFixed(2)}`, ""],
    ["speaker", "audio sink (worklet)", `consumed ${fmt(sp.consumed)}`, `tornGuarded ${fmt(sp.tornGuarded)}`, (sp.tornGuarded ?? 0) === 0 ? "ok" : "err"],
    ["meter", "broadcast sink (worker)", `consumed ${fmt(me.consumed)}`, `tornGuarded ${fmt(me.tornGuarded)}`, (me.tornGuarded ?? 0) === 0 ? "ok" : "err"],
  ];
  $("flow").innerHTML = rows
    .map(([n, role, a, b, cls]) =>
      `<tr><td class="pid">${n}</td><td class="dim">${role}</td><td>${a}</td><td class="${cls}">${b}</td></tr>`)
    .join("");

  // ── Broadcast-completeness: speaker.consumed vs meter.consumed track together ──
  const spc = sp.consumed ?? 0, mec = me.consumed ?? 0;
  const delta = Math.abs(spc - mec);
  setRows("broadcast", [
    ["speaker consumed", fmt(spc)],
    ["meter consumed", fmt(mec)],
    ["Δ (both see every frame)", fmt(delta), delta < 2000 ? "ok" : "warn"],
    ["speaker dropped", fmt(sp.dropped), (sp.dropped ?? 0) > 0 ? "warn" : "ok"],
    ["meter dropped", fmt(me.dropped), (me.dropped ?? 0) > 0 ? "warn" : "ok"],
  ]);

  // ── Live voices (from the audio sink) ──
  const f = sp.freq ?? [], a = sp.amp ?? [], lv = me.level ?? [];
  $("voices").innerHTML = [0, 1]
    .map((p) =>
      `<tr><td class="pid p${p}">voice ${p}</td>` +
      `<td>${f[p] != null ? f[p].toFixed(1) + " Hz" : "—"}</td>` +
      `<td>${a[p] != null ? a[p].toFixed(3) : "—"}</td>` +
      `<td>${lv[p] != null ? lv[p].toFixed(3) : "—"}</td></tr>`)
    .join("");
}

START.addEventListener("click", () => start().catch((e) => setRows("topology", [["status", String(e), "err"]])));
FLOOD.addEventListener("click", toggleFlood);
STOP.addEventListener("click", () => stop());
GAIN.addEventListener("input", () => {
  $("gainval").textContent = Number(GAIN.value).toFixed(2);
  state.workers.fx?.postMessage({ type: "gain", value: Number(GAIN.value) });
});

setRows("topology", [
  ["status", isolationOk() ? "ready — press Start" : "NOT cross-origin isolated", isolationOk() ? "ok" : "err"],
  ["isolation", isolationOk() ? "crossOriginIsolated ✓" : "serve via npm run dev:audio-dag", isolationOk() ? "ok" : "err"],
]);
render();
