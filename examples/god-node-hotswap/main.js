// main.js — page thread for the God-Node hot-swap demo.
//
//   1. Compute migratePlan(A → B) up front and show what the swap will do.
//   2. Allocate two SABs (one per schema), spawn the producer worker (drives
//      both rings), create the AudioContext + the pre-registered consumer
//      worklet, and hand it both SABs + the plan.
//   3. "Morph to B" arms the click-free cross-schema swap AND performs the
//      Stage-4 headline: emit B's whole AudioWorklet module FROM ITS SCHEMA at
//      button-press, Blob it, addModule it LIVE, and run a verifier node that
//      decodes B's live ring through the freshly-materialized read path —
//      proving the bridge rewrote its own consumer path while audio plays.

import {
  Bridge,
  describeSchemaLayout,
  migratePlan,
  emitWorkletProcessorModule,
  toWorkletModuleURL,
} from "../../dist/index.js";
import { makeSchemaA, makeSchemaB, CAP } from "./schema.js";

const $ = (id) => document.getElementById(id);
const START = $("start");
const STOP = $("stop");
const MORPH = $("morph");
const RESET = $("reset");
const STATUS = $("status");
const REGEN = $("regen");
const WBAR = $("wbar");
const PLAN = $("plan");

const WINDOW_SECONDS = 0.18;

const state = {
  ctx: null,
  node: null,
  worker: null,
  verifier: null,
  verifierRevoke: null,
  sabA: null,
  sabB: null,
  running: false,
  diag: {},
  regen: { materialized: false, decoded: 0, freq: 0, res: 0, detune: 0 },
  // Each morph materializes a FRESH processor (unique name) — a runtime module
  // can only be registered once per AudioContext, and a new name makes the
  // "regenerated at click" story literal across repeated morphs.
  regenCount: 0,
};

// Compute the plan once at load — pure, no audio needed.
const PLAN_OBJ = migratePlan(
  describeSchemaLayout(makeSchemaA()),
  describeSchemaLayout(makeSchemaB()),
);

function isolationOk() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
}

function params() {
  return {
    carrier: Number($("carrier").value),
    depth: Number($("depth").value),
    lfoHz: Number($("lfoHz").value),
    controlHz: Number($("controlHz").value),
    res: Number($("res").value),
    detune: Number($("detune").value),
  };
}

function renderPlan() {
  const row = (kind, name, detail, cls) =>
    `<div class="prow"><span class="pk ${cls}">${kind}</span><span class="pn">${name}</span><span class="pd">${detail}</span></div>`;
  const rows = [];
  for (const f of PLAN_OBJ.crossfade) {
    rows.push(row("crossfade", f.to, `${f.blend}${f.trajectory ? ` · traj(order ${f.trajectory.order})` : ""}`, "xf"));
  }
  for (const f of PLAN_OBJ.rampIn) {
    rows.push(row("ramp-in", f.to, `${f.reason} · from ${f.default}`, "ri"));
  }
  for (const f of PLAN_OBJ.drop) {
    rows.push(row("drop", f.from, f.reason, "dr"));
  }
  PLAN.innerHTML = rows.join("");
}

function setStatus(parts) {
  STATUS.innerHTML = parts
    .map(([k, v, cls]) => `<span class="k">${k.padEnd(15, " ")}</span> <span class="v ${cls ?? ""}">${v}</span>`)
    .join("\n");
}

function renderRegen() {
  const g = state.regen;
  if (!g.materialized) {
    REGEN.innerHTML = `<span class="k">runtime module</span> <span class="v">not yet materialized — press “Morph to B”</span>`;
    return;
  }
  REGEN.innerHTML = [
    `<span class="k">runtime module</span> <span class="v ok">materialized at click ✓ (emitWorkletProcessorModule → Blob → addModule)</span>`,
    `<span class="k">live decode</span> <span class="v hot">${g.decoded} frames · freq ${g.freq.toFixed(1)} Hz · res ${g.res.toFixed(2)} · detune ${g.detune.toFixed(1)} Hz</span>`,
  ].join("\n");
}

function render() {
  const d = state.diag;
  const w = d.weight ?? 0;
  WBAR.style.width = `${Math.round(w * 100)}%`;
  WBAR.className = "wbar " + (d.phase === "complete" ? "done" : d.phase === "fading" ? "fade" : "");
  setStatus([
    ["status", state.running ? "running" : "stopped", state.running ? "ok" : ""],
    ["swap phase", d.phase ?? "idle", d.phase === "fading" ? "hot" : d.phase === "complete" ? "ok" : ""],
    ["weight", w.toFixed(4)],
    ["b ready", String(d.bReady ?? false)],
    ["freq A / B", d.freqA != null ? `${d.freqA.toFixed(1)} / ${d.freqB.toFixed(1)} Hz` : "—"],
    ["produce rate", d.pushRateHz != null ? `${d.pushRateHz.toFixed(0)} Hz` : "—"],
    ["plan (worklet)", d.planSummary ?? "—"],
  ]);
  renderRegen();
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

  // 1. Two SABs — one per schema. This is the two-ring overlap the swap needs.
  state.sabA = Bridge.allocate(CAP, makeSchemaA()).sab;
  state.sabB = Bridge.allocate(CAP, makeSchemaB()).sab;

  // 2. Producer worker drives both rings.
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "diag") { state.diag = { ...state.diag, ...m }; render(); }
  };
  state.worker.onerror = (e) => setStatus([["status", `worker error: ${e.message}`, "err"]]);
  state.worker.postMessage({ type: "init", sabA: state.sabA, sabB: state.sabB, params: params() });

  // 3. Audio + the pre-registered consumer worklet (imports the library).
  state.ctx = new AudioContext({ latencyHint: "interactive" });
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "god-node-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sabA: state.sabA, sabB: state.sabB },
  });
  state.node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "diag") { state.diag = { ...state.diag, ...m }; render(); }
  };
  state.node.port.postMessage({ type: "config", plan: PLAN_OBJ, windowSeconds: WINDOW_SECONDS });
  state.node.connect(state.ctx.destination);

  state.running = true;
  STOP.disabled = false;
  MORPH.disabled = false;
  render();
}

// ─── The Stage-4 headline: regenerate B's read path at runtime ───────────────
async function materializeRuntimeB() {
  // Emit B's WHOLE self-registering AudioWorklet module from its schema, at
  // click-time. The processBody decodes B's newest live slot through the emitted
  // reader and reports it — proof the materialized path is decoding the real ring.
  const layoutB = describeSchemaLayout(makeSchemaB());
  const processorName = `god-node-patch-b-runtime-${++state.regenCount}`;
  const processBody = [
    "    const wi = this._view.getInt32(0, true);",
    "    if (wi > 0) {",
    "      readFrameB(this._view, slotOf(wi - 1), out);",
    "      this._n = (this._n | 0) + 1;",
    "      if ((this._n % 32) === 0) {",
    "        this.port.postMessage({ type: 'decoded', n: this._n, freq: out.freq[0], res: out.res, detune: out.detune });",
    "      }",
    "    }",
    "    return true;",
  ].join("\n");

  const moduleSrc = emitWorkletProcessorModule(layoutB, {
    processorName,
    functionName: "readFrameB",
    capacity: CAP,
    processBody,
  });

  const { url, revoke } = toWorkletModuleURL(moduleSrc);
  state.verifierRevoke = revoke;
  await state.ctx.audioWorklet.addModule(url); // ← the read path crosses into the audio realm, LIVE
  revoke();
  state.verifierRevoke = null;

  state.verifier = new AudioWorkletNode(state.ctx, processorName, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sab: state.sabB, capacity: CAP },
  });
  state.verifier.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "decoded") {
      state.regen = { materialized: true, decoded: m.n, freq: m.freq, res: m.res, detune: m.detune };
      renderRegen();
    }
  };
  state.verifier.connect(state.ctx.destination); // silent (never writes output) but pulled by the graph
  state.regen.materialized = true;
  renderRegen();
}

async function morph() {
  if (!state.running) return;
  MORPH.disabled = true;
  // Arm the audible click-free swap (HotSwapConsumer in the consumer worklet)…
  state.node.port.postMessage({ type: "arm", windowSeconds: WINDOW_SECONDS });
  // …and materialize B's read path at runtime (the self-rewriting proof).
  try {
    await materializeRuntimeB();
  } catch (err) {
    REGEN.innerHTML = `<span class="k">runtime module</span> <span class="v err">addModule failed: ${err.message ?? err}</span>`;
  }
  RESET.disabled = false;
}

function reset() {
  if (!state.running) return;
  state.node.port.postMessage({ type: "reset" });
  try { state.verifier?.disconnect(); } catch {}
  state.verifier = null;
  try { state.verifierRevoke?.(); } catch {}
  state.regen = { materialized: false, decoded: 0, freq: 0, res: 0, detune: 0 };
  RESET.disabled = true;
  MORPH.disabled = false;
  render();
}

function stop() {
  if (!state.running) return;
  state.running = false;
  STOP.disabled = true;
  START.disabled = false;
  MORPH.disabled = true;
  RESET.disabled = true;
  try { state.verifier?.disconnect(); } catch {}
  try { state.node?.disconnect(); } catch {}
  try { state.ctx?.close(); } catch {}
  try { state.worker?.postMessage({ type: "stop" }); } catch {}
  try { state.worker?.terminate(); } catch {}
  state.verifier = state.node = state.ctx = state.worker = null;
  state.regen = { materialized: false, decoded: 0, freq: 0, res: 0, detune: 0 };
  setStatus([["status", "stopped."]]);
  WBAR.style.width = "0%";
  renderRegen();
}

// ─── Wiring ──────────────────────────────────────────────────────────────────
START.addEventListener("click", () => start().catch((e) => {
  setStatus([["status", `start failed: ${e.message ?? e}`, "err"]]);
  START.disabled = false;
}));
STOP.addEventListener("click", stop);
MORPH.addEventListener("click", () => morph());
RESET.addEventListener("click", reset);

for (const key of ["carrier", "depth", "lfoHz", "controlHz", "res", "detune"]) {
  const el = $(key);
  el.addEventListener("input", () => {
    $(`${key}-val`).textContent = el.value;
    state.worker?.postMessage({ type: "params", params: params() });
  });
  $(`${key}-val`).textContent = el.value;
}

renderPlan();
setStatus([
  ["status", "idle. press Start.", ""],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB", String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
  ["tip", "Start → let it run → Morph to B"],
]);
renderRegen();
