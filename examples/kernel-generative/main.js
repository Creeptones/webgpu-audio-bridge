// main.js — the PAGE thread for the generative demo (Apollo Frontier 6, Stage 3a).
//
// MODEL-FREE music: a seeded generator (generate.js) walks the constrained-decoder
// mask (`legalNextTokens`) to emit random VALID kernel-grammar token streams; a
// background worker `getOrCompile`s each through the three gates (syntax → equivalence
// → acoustic); `curate()` keeps only the audibly-interesting ones; the gate-verified
// SIMD bytes morph into a running AudioWorklet click-free. No model — the LCG stands
// in for the Stage-3b SLM, and the mask + gates are exactly the safety contract the
// real model will plug behind.
//
//   • Roll 🎲      — generate → curate (auto-reroll past gate/curation rejects) →
//                    install the first keeper; you hear it immediately.
//   • Keep ★       — add the current kernel to the bank.
//   • Build bank   — auto-roll + curate until the bank holds N kernels.
//   • Evolve ▶     — cycle the bank, morphing to the next kernel every "bar", with
//                    the scalar g swept by an LFO → an evolving generative texture.
//
// Because every generated kernel shares ONE signature, the audio graph is built once
// (connectJit + a bootstrap gain kernel) and successive kernels are installed over it;
// the consumer crossfades SIMD→SIMD, so each swap is a click-free morph.

import { connectJit } from "../../dist/experimental/index.js";
import { generateKernel, curate, GEN_SIGNATURE, BOOTSTRAP_TOKENS } from "./generate.js";

const $ = (id) => document.getElementById(id);
const START = $("start"), STOP = $("stop"), ROLL = $("roll"), KEEP = $("keep");
const BUILD = $("build"), EVOLVE = $("evolve");
const STATUS = $("status"), HUD = $("hud"), WBAR = $("wbar"), TOKENS = $("tokens"), BANK = $("bank");
const TEMPO = $("tempo"), LEVEL = $("level"), GAIN = $("gain"), LFO = $("lfo");

const MAX_BLOCK = 128;
const WINDOW_SECONDS = 0.25;   // a visible, audible morph between kernels
const MAX_TRIES = 16;          // reroll budget before giving up a roll
const BANK_TARGET = 6;         // auto-build bank size

const state = {
  ctx: null, node: null, jit: null, worker: null,
  running: false, moduleAdded: false,
  cacheSize: 0,
  pending: new Map(),          // reqId → resolve (request/response over the worker)
  reqId: 0,
  seedCtr: 1,
  current: null,               // { gen, m, cur } currently installed
  bank: [],                    // kept kernels [{ gen, bytes, exportName, acoustic, hash }]
  rolls: 0, rejects: 0,        // session stats
  lastRejects: [],             // reasons from the last roll's discards
  evolve: false, evolveIdx: 0, evolveTimer: null, lfoTimer: null, lfoT: 0,
  diag: {},
};

const isoOk = () => typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
const SPARK = "▁▂▃▄▅▆▇█";
function sparkline(b) {
  if (!b || !b.length) return "—";
  // Max-pool to ≤16 cells (default fingerprintBands is 64) so the bar stays compact.
  const CELLS = 16;
  let cells = b;
  if (b.length > CELLS) {
    cells = new Array(CELLS).fill(0);
    for (let i = 0; i < b.length; i++) {
      const c = Math.min(CELLS - 1, Math.floor((i * CELLS) / b.length));
      cells[c] = Math.max(cells[c], b[i]);
    }
  }
  const max = cells.reduce((m, v) => Math.max(m, v), 0) || 1;
  return cells.map((v) => SPARK[Math.min(7, Math.round((v / max) * 7))]).join("");
}
const fmtUs = (us) => (!us ? "—" : us < 1 ? `${(us * 1000).toFixed(0)} ns` : `${us.toFixed(2)} µs`);

// ── worker request/response (promise per compile) ────────────────────────────────
function workerCompile(tokens) {
  return new Promise((resolve) => {
    const id = ++state.reqId;
    state.pending.set(id, resolve);
    state.worker.postMessage({ type: "compile", id, tokens });
  });
}
function onWorkerMessage(e) {
  const m = e.data;
  if (!m || m.type !== "compiled") return;
  if (typeof m.cacheSize === "number") state.cacheSize = m.cacheSize;
  const resolve = state.pending.get(m.id);
  if (resolve) { state.pending.delete(m.id); resolve(m); }
}

// ── the roll → curate core (one keeper, or null after MAX_TRIES) ─────────────────
async function rollOne() {
  const rejects = [];
  for (let tries = 1; tries <= MAX_TRIES; tries++) {
    state.rolls++;
    const gen = generateKernel((state.seedCtr++ * 2654435761) >>> 0);
    const m = await workerCompile(gen.tokens);
    if (!state.running) return null;
    if (m.status !== "accepted") {
      state.rejects++; rejects.push(m.verdict.replace("rejected-", "") + (m.verdict === "rejected-acoustic" && m.acoustic ? ` (peak ${m.acoustic.peak.toExponential(1)})` : ""));
      continue;
    }
    const cur = curate(m.acoustic);
    if (!cur.ok) { state.rejects++; rejects.push(cur.why); continue; }
    state.lastRejects = rejects;
    return { gen, m, cur, tries };
  }
  state.lastRejects = rejects;
  return null;
}

function installKeeper(k) {
  state.current = k;
  if (state.jit && state.jit.jitEnabled) {
    state.node?.port.postMessage({
      type: "jit-install", transport: "bytes", bytes: k.m.bytes, exportName: k.m.exportName,
    });
  }
  TOKENS.textContent = k.gen.text;
  render();
}

// ── controls: roll / keep / build / evolve ───────────────────────────────────────
async function roll() {
  if (!state.running) return;
  ROLL.disabled = true; setStatusLine("rolling… (generate → 3 gates → curate)");
  const k = await rollOne();
  ROLL.disabled = false;
  if (!state.running) return;
  if (!k) { setStatusLine(`no keeper in ${MAX_TRIES} tries — try again (${state.lastRejects.join(", ")})`, "hot"); return; }
  installKeeper(k);
  KEEP.disabled = false;
}

function keep() {
  const k = state.current;
  if (!k) return;
  if (state.bank.some((b) => b.hash === k.gen.hash)) { setStatusLine("already in the bank", "dim"); return; }
  state.bank.push({ gen: k.gen, bytes: k.m.bytes, exportName: k.m.exportName, acoustic: k.m.acoustic, hash: k.gen.hash });
  EVOLVE.disabled = state.bank.length === 0;
  render();
}

async function buildBank() {
  if (!state.running) return;
  BUILD.disabled = true;
  while (state.running && state.bank.length < BANK_TARGET) {
    setStatusLine(`building bank… ${state.bank.length}/${BANK_TARGET} (auto-rolling + curating)`);
    const k = await rollOne();
    if (!k) break;
    if (!state.bank.some((b) => b.hash === k.gen.hash)) {
      state.bank.push({ gen: k.gen, bytes: k.m.bytes, exportName: k.m.exportName, acoustic: k.m.acoustic, hash: k.gen.hash });
      installKeeper(k); // audition each as it's added
    }
    render();
  }
  BUILD.disabled = false;
  EVOLVE.disabled = state.bank.length === 0;
  setStatusLine(`bank ready — ${state.bank.length} kernels. Press Evolve ▶`, "ok");
}

async function toggleEvolve() {
  if (!state.running) return;
  state.evolve = !state.evolve;
  if (state.evolve) {
    EVOLVE.textContent = "Stop evolve ⏸";
    if (state.bank.length === 0) await buildBank();
    if (!state.running || state.bank.length === 0) { state.evolve = false; EVOLVE.textContent = "Evolve ▶"; return; }
    startEvolveLoop();
  } else {
    EVOLVE.textContent = "Evolve ▶";
    stopEvolveLoop();
  }
}

function barSeconds() {
  // tempo slider is BPM; a "bar" = 4 beats.
  const bpm = Number(TEMPO.value);
  return (60 / bpm) * 4;
}
function installBankEntry(i) {
  const b = state.bank[i % state.bank.length];
  if (!b) return;
  state.current = { gen: b.gen, m: { bytes: b.bytes, exportName: b.exportName, acoustic: b.acoustic, hash: b.hash, gate: null, cached: true }, cur: { ok: true, why: "bank" } };
  if (state.jit && state.jit.jitEnabled) {
    state.node?.port.postMessage({ type: "jit-install", transport: "bytes", bytes: b.bytes, exportName: b.exportName });
  }
  TOKENS.textContent = b.gen.text;
  render();
}
function startEvolveLoop() {
  stopEvolveLoop();
  installBankEntry(state.evolveIdx);
  state.evolveTimer = setInterval(() => {
    state.evolveIdx = (state.evolveIdx + 1) % state.bank.length;
    installBankEntry(state.evolveIdx);
  }, Math.max(400, barSeconds() * 1000));
  // LFO on g (~30 Hz control rate).
  state.lfoT = 0;
  state.lfoTimer = setInterval(() => {
    state.lfoT += 1 / 30;
    const depth = Number(LFO.value);
    const center = Number(GAIN.value);
    const rate = 0.18; // Hz — a slow sweep
    const g = center + depth * Math.sin(2 * Math.PI * rate * state.lfoT);
    postParams(g);
  }, 1000 / 30);
}
function stopEvolveLoop() {
  if (state.evolveTimer) { clearInterval(state.evolveTimer); state.evolveTimer = null; }
  if (state.lfoTimer) { clearInterval(state.lfoTimer); state.lfoTimer = null; }
  postParams(Number(GAIN.value));
}

// ── params → worklet ─────────────────────────────────────────────────────────────
function postParams(gOverride) {
  const bpm = Number(TEMPO.value);
  const beat = 60 / bpm;
  state.node?.port.postMessage({
    type: "params",
    level: Number(LEVEL.value),
    stepSec: beat / 2,       // 8th-note arpeggio
    beatSec: beat,
    scalars: { g: typeof gOverride === "number" ? gOverride : Number(GAIN.value) },
  });
}

// ── HUD ──────────────────────────────────────────────────────────────────────────
function setStatusLine(msg, cls) {
  STATUS.innerHTML = `<span class="k">status</span> <span class="v ${cls ?? ""}">${msg}</span>`;
}
function render() {
  const d = state.diag;
  const w = d.weight ?? 0;
  WBAR.style.width = `${Math.round(Math.max(0, Math.min(1, w)) * 100)}%`;
  WBAR.className = "wbar " + (d.phase === "complete" ? "done" : d.phase === "fading" ? "fade" : "");

  const lines = [];
  lines.push(`<span class="k">isolated</span> <span class="v ${isoOk() ? "ok" : "err"}">${isoOk()}</span>  ·  <span class="k">JIT</span> <span class="v ${state.jit && state.jit.jitEnabled ? "ok" : "err"}">${state.jit ? state.jit.jitEnabled : false}</span>  ·  <span class="k">running kernel</span> <span class="v ${d.ranSimd ? "ok" : "hot"}">${d.ranSimd ? "SIMD ✓" : "JS fallback"}</span>`);
  const k = state.current;
  if (k) {
    const a = k.m.acoustic;
    lines.push(`<span class="k">current</span> <span class="v">#${k.gen.hash} <span class="dim">(seed ${k.gen.seed})</span></span>`);
    if (a) {
      lines.push(`<span class="k">acoustic (gate #3)</span> <span class="v ok">peak ${a.peak.toFixed(3)} · rms ${a.rms.toFixed(3)} · crest ${a.crestFactor.toFixed(2)} · centroid ${a.spectralCentroid.toFixed(3)}</span>`);
      lines.push(`<span class="k">fingerprint</span> <span class="v">${sparkline(a.magnitude)} <span class="dim">(${a.magnitude.length}-band spectrum · ${k.cur.why})</span></span>`);
    }
    if (k.m.gate) lines.push(`<span class="k">equivalence (gate #2)</span> <span class="v ok">${k.m.gate.status} — worst f32 ULP ${k.m.gate.worstUlpF32}, ${k.m.gate.comparisons} comparisons</span>`);
  } else {
    lines.push(`<span class="k">current</span> <span class="v dim">press Roll 🎲 to generate a gate-verified kernel</span>`);
  }
  lines.push(`<span class="k">session</span> <span class="v">${state.rolls} rolled · ${state.rejects} gated/curated out · ${state.cacheSize} cached</span>`);
  if (state.lastRejects.length) lines.push(`<span class="k">last discards</span> <span class="v dim">${state.lastRejects.join(", ")}</span>`);
  lines.push(`<span class="k">kernel time</span> <span class="v">JS ${fmtUs(d.jsUs)} · SIMD ${fmtUs(d.simdUs)}${d.jsUs && d.simdUs ? ` · <strong>${(d.jsUs / d.simdUs).toFixed(2)}×</strong>` : ""}</span>`);
  HUD.innerHTML = lines.join("\n");

  BANK.innerHTML = state.bank.length
    ? state.bank.map((b, i) => `<div class="bankrow ${state.evolve && i === state.evolveIdx ? "on" : ""}"><span class="dim">#${b.hash}</span> ${sparkline(b.acoustic.magnitude)} <span class="dim">${b.gen.text.length > 60 ? b.gen.text.slice(0, 60) + "…" : b.gen.text}</span></div>`).join("")
    : `<span class="dim">(empty — Keep ★ a roll, or Build bank)</span>`;
}

// ── lifecycle ──────────────────────────────────────────────────────────────────────
async function start() {
  if (state.running) return;
  if (!isoOk()) { setStatusLine("FAILED — not crossOriginIsolated (serve via serve.mjs)", "err"); return; }
  if (typeof SharedArrayBuffer === "undefined") { setStatusLine("FAILED — SharedArrayBuffer unavailable", "err"); return; }
  START.disabled = true; setStatusLine("starting…");

  state.ctx = new AudioContext({ latencyHint: "interactive" });
  try { await state.ctx.resume(); } catch {}
  if (!state.moduleAdded) { await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url)); state.moduleAdded = true; }
  if (!state.worker) {
    state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    state.worker.onmessage = onWorkerMessage;
    state.worker.onerror = (ev) => setStatusLine(`worker error: ${ev.message ?? ev}`, "err");
  }

  // Build the audio graph ONCE over a bootstrap gain kernel; generated kernels install
  // over it (the consumer morphs SIMD→SIMD click-free).
  state.jit = connectJit({
    tokens: BOOTSTRAP_TOKENS, signature: GEN_SIGNATURE,
    maxBlock: MAX_BLOCK, sampleRate: state.ctx.sampleRate, windowSeconds: WINDOW_SECONDS,
  });
  state.node = new AudioWorkletNode(state.ctx, "kernel-generative", {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: state.jit.processorOptions,
  });
  state.node.port.onmessage = (e) => { const m = e.data; if (m && m.type === "diag") { state.diag = m; render(); } };
  state.node.connect(state.ctx.destination);

  state.running = true;
  STOP.disabled = false; ROLL.disabled = false; BUILD.disabled = false;
  postParams();
  setStatusLine("running — bootstrap gain on the arpeggio. Press Roll 🎲", "ok");
  render();
  roll(); // kick off with one keeper so there's something to hear
}

function stop() {
  if (!state.running) return;
  state.running = false;
  state.evolve = false; EVOLVE.textContent = "Evolve ▶";
  stopEvolveLoop();
  if (state.jit) { try { state.jit.dispose(); } catch {} }
  if (state.node) { try { state.node.port.onmessage = null; state.node.disconnect(); } catch {} state.node = null; }
  try { state.ctx?.close(); } catch {}
  state.ctx = null; state.moduleAdded = false; state.jit = null; state.diag = {};
  STOP.disabled = true; ROLL.disabled = true; KEEP.disabled = true; BUILD.disabled = true; EVOLVE.disabled = true;
  WBAR.style.width = "0%";
  setStatusLine("stopped (cache + bank kept — re-Start to reuse).");
}

// ── wiring ──────────────────────────────────────────────────────────────────────
START.addEventListener("click", () => start().catch((e) => { setStatusLine(`start failed: ${e.message ?? e}`, "err"); START.disabled = false; }));
STOP.addEventListener("click", stop);
ROLL.addEventListener("click", () => roll());
KEEP.addEventListener("click", keep);
BUILD.addEventListener("click", () => buildBank());
EVOLVE.addEventListener("click", () => toggleEvolve());
for (const [el, id] of [[TEMPO, "tempo"], [LEVEL, "level"], [GAIN, "gain"], [LFO, "lfo"]]) {
  el.addEventListener("input", () => { $(`${id}-val`).textContent = el.value; if (!state.evolve) postParams(); });
  $(`${id}-val`).textContent = el.value;
}

setStatusLine(`idle. press Start. isolated=${isoOk()} · SAB=${typeof SharedArrayBuffer !== "undefined"}`);

// Test/debug hook.
window.__gen = { state, roll, rollOne, isolated: isoOk, cacheSize: () => state.cacheSize };
