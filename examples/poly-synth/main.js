// main.js — the PAGE thread for the poly-synth demo (Frontier 7, Stage 4).
//
// Play the on-screen (or computer-key) keyboard: each key gates one of V = 8 voices
// of a fixed STATEFUL per-voice kernel (a one-pole lowpass + feedback comb). Audio
// starts immediately on the developer's JS fallback; a background worker compiles the
// token stream for `voices: 8` (the voice-equivalence gate proves every lane bit-exact
// to an independent scalar voice), and the gate-verified VOICE-SIMD bytes fade in over
// the JS fallback click-free. The HUD shows the upgrade ("JS fallback → voice-SIMD,
// V voices, W per v128") and the gate's `worstUlpF32 === 0`.
//
// The wiring is exactly the shipped connectJit surface — and minimal, because
// `jit.bind()` auto-forwards the worker's gate-verified bytes to the worklet:
//   • PAGE (this file) — owns the AudioContext + the keyboard, calls
//     `connectJit({ tokens, signature, voices })`, builds the AudioWorkletNode +
//     the compile worker, and `bind`s them. `requestCompile()` kicks the compile.
//   • COMPILE WORKER (worker.js) — runs `runJitCompile` (→ `compileTokens` with the
//     voice count → the gates → the voice-SIMD module) and replies.
//   • AUDIOWORKLET (worklet.js) — per-voice oscillators + the voice-batched consumer.

import { connectJit } from "../../dist/experimental/index.js";
import {
  KERNEL_TOKENS, KERNEL_TEXT, KERNEL_HASH, SIGNATURE,
  VOICES, MAX_BLOCK, NOTES, cutoffsForTone,
} from "./voices.js";

const $ = (id) => document.getElementById(id);
const START = $("start");
const STOP = $("stop");
const FORCE = $("force");
const STATUS = $("status");
const HUD = $("hud");
const WBAR = $("wbar");
const KEYS = $("keys");
const TONE = $("tone");
const FB = $("fb");
const LEVEL = $("level");
const TOKENS = $("tokens");

const WINDOW_SECONDS = 0.25; // a visible crossfade (connectJit's default is 0.01)

const state = {
  ctx: null,
  node: null,
  worker: null,
  jit: null,
  running: false,
  moduleAdded: false,
  forcedJs: false,
  diag: {},
  gate: null,          // the gate report from onUpgrade
  upgradedTransport: null,
  fellBack: null,
  freqs: new Array(VOICES).fill(0),
  gates: new Array(VOICES).fill(0),
  keyButtons: [],      // DOM nodes, per voice
};

function isolationOk() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
}
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : 0);

// ─── HUD ───────────────────────────────────────────────────────────────────────

function setStatus(parts) {
  STATUS.innerHTML = parts
    .map(([k, v, cls]) => `<span class="k">${k.padEnd(16, " ")}</span> <span class="v ${cls ?? ""}">${v}</span>`)
    .join("\n");
}
function fmtUs(us) {
  if (!us) return "—";
  return us < 1 ? `${(us * 1000).toFixed(0)} ns` : `${us.toFixed(2)} µs`;
}

function render() {
  const d = state.diag;
  const w = d.weight ?? 0;
  WBAR.style.width = `${Math.round(Math.max(0, Math.min(1, w)) * 100)}%`;
  WBAR.className = "wbar " + (d.phase === "complete" ? "done" : d.phase === "fading" ? "fade" : "");

  const phase = d.phase ?? "idle";
  const speedup = d.jsUs && d.simdUs ? (d.jsUs / d.simdUs).toFixed(2) + "×" : "—";
  const W = SIGNATURE.width === "f64" ? 2 : 4;

  setStatus([
    ["status", state.running ? "running" : "stopped", state.running ? "ok" : ""],
    ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
    ["JIT enabled", String(state.jit ? state.jit.jitEnabled : false), state.jit && state.jit.jitEnabled ? "ok" : "err"],
    ["voices", `${VOICES} (W=${W} per v128 ⇒ ${VOICES / W} batches)`],
    ["swap phase", phase, phase === "fading" ? "hot" : phase === "complete" ? "ok" : ""],
    ["running kernel", d.ranSimd ? "VOICE-SIMD (vectorized) ✓" : "JS (scalar fallback)", d.ranSimd ? "ok" : "hot"],
    ["active voices", String(d.activeVoices ?? 0)],
    ["forced JS", String(state.forcedJs), state.forcedJs ? "hot" : ""],
  ]);

  const lines = [];
  if (state.fellBack) {
    lines.push(`<span class="k">compile</span> <span class="v err">FALLBACK — ${state.fellBack.verdict}: ${state.fellBack.detail}</span>`);
  } else if (state.gate) {
    const g = state.gate;
    lines.push(`<span class="k">upgrade</span> <span class="v ok">JS fallback → VOICE-SIMD upgraded (${VOICES} voices, ${W} per v128) — transport ${state.upgradedTransport}</span>`);
    lines.push(`<span class="k">voice gate</span> <span class="v ok">VERIFIED ${g.status} — worst f32 ULP <strong>${g.worstUlpF32}</strong> (bit-exact per lane), ${g.comparisons} comparisons</span>`);
  } else {
    lines.push(`<span class="k">compile</span> <span class="v dim">compiling token stream for ${VOICES} voices… (audio is on the JS fallback meanwhile)</span>`);
  }
  lines.push(`<span class="k">content hash</span> <span class="v">${KERNEL_HASH}</span>`);
  lines.push(`<span class="k">kernel time</span> <span class="v">JS ${fmtUs(d.jsUs)} · SIMD ${fmtUs(d.simdUs)} · speedup <strong>${speedup}</strong> <span class="dim">(coarse worklet clock — rigorous: <code>npm run bench:jit</code> Cell 5)</span></span>`);
  HUD.innerHTML = lines.join("\n");
}

// ─── per-voice scalars ───────────────────────────────────────────────────────────

function postParams() {
  state.node?.port.postMessage({
    type: "params",
    cutoffs: cutoffsForTone(Number(TONE.value)),
    fb: Number(FB.value),
    level: Number(LEVEL.value),
  });
}
function postNotes() {
  state.node?.port.postMessage({ type: "notes", freqs: state.freqs, gates: state.gates });
}

// ─── keyboard ────────────────────────────────────────────────────────────────────

function voiceOn(v) {
  if (v < 0 || v >= VOICES) return;
  state.freqs[v] = NOTES[v].freq;
  state.gates[v] = 1;
  postNotes();
  state.keyButtons[v]?.classList.add("down");
}
function voiceOff(v) {
  if (v < 0 || v >= VOICES) return;
  state.gates[v] = 0;
  postNotes();
  state.keyButtons[v]?.classList.remove("down");
}

function buildKeyboard() {
  KEYS.innerHTML = "";
  state.keyButtons = [];
  NOTES.forEach((note, v) => {
    const b = document.createElement("button");
    b.className = "pkey";
    b.innerHTML = `<span class="note">${note.label}</span><span class="kk">${note.key.toUpperCase()}</span>`;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); voiceOn(v); });
    b.addEventListener("pointerup", () => voiceOff(v));
    b.addEventListener("pointerleave", () => voiceOff(v));
    KEYS.appendChild(b);
    state.keyButtons.push(b);
  });
}

const keyIndex = new Map(NOTES.map((n, v) => [n.key, v]));
window.addEventListener("keydown", (e) => {
  if (e.repeat || !state.running) return;
  const v = keyIndex.get(e.key.toLowerCase());
  if (v !== undefined) { e.preventDefault(); voiceOn(v); }
});
window.addEventListener("keyup", (e) => {
  const v = keyIndex.get(e.key.toLowerCase());
  if (v !== undefined) { e.preventDefault(); voiceOff(v); }
});

// ─── lifecycle ─────────────────────────────────────────────────────────────────

function tearDownNode() {
  if (state.node) {
    try { state.node.port.onmessage = null; } catch {}
    try { state.node.disconnect(); } catch {}
    state.node = null;
  }
  if (state.jit) { try { state.jit.dispose(); } catch {} state.jit = null; }
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

  state.ctx = new AudioContext({ latencyHint: "interactive" });
  try { await state.ctx.resume(); } catch {}

  if (!state.moduleAdded) {
    await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
    state.moduleAdded = true;
  }

  // Build the worklet plumbing for the fixed voice kernel. connectJit derives
  // `voices` from the spec because the token IR is STATEFUL (a stateless kernel
  // would collapse to voices = 1 — the frontier gate).
  state.jit = connectJit({
    tokens: KERNEL_TOKENS,
    signature: SIGNATURE,
    voices: VOICES,
    maxBlock: MAX_BLOCK,
    sampleRate: state.ctx.sampleRate,
    windowSeconds: WINDOW_SECONDS,
  });
  state.node = new AudioWorkletNode(state.ctx, "poly-synth", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: state.jit.processorOptions,
  });
  state.node.port.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === "diag") { state.diag = m; render(); }
  };
  state.node.connect(state.ctx.destination);

  // The compile worker (runs runJitCompile off-thread).
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.onerror = (e) => setStatus([["status", `worker error: ${e.message ?? e}`, "err"]]);

  // bind() auto-forwards the gate-verified bytes from the worker to the worklet port
  // (bytes transport by default — robust for the worklet realm), firing the callbacks.
  state.jit.bind({
    worker: state.worker,
    workletPort: state.node.port,
    callbacks: {
      onUpgrade: (transport, gate) => {
        if (state.forcedJs) return;
        state.gate = gate; state.upgradedTransport = transport; state.fellBack = null; render();
      },
      onFallback: (verdict, detail) => { state.fellBack = { verdict, detail }; render(); },
    },
  });

  state.running = true;
  STOP.disabled = false;
  FORCE.disabled = false;

  postParams();
  postNotes();
  render();

  // Kick the (voice) compile. The worklet stays on the JS fallback until it lands.
  if (state.jit.jitEnabled) state.jit.requestCompile();
}

function stop() {
  if (!state.running) return;
  state.running = false;
  tearDownNode();
  if (state.worker) { try { state.worker.terminate(); } catch {} state.worker = null; }
  try { state.ctx?.close(); } catch {}
  state.ctx = null;
  state.moduleAdded = false;
  state.diag = {};
  state.gate = null;
  state.fellBack = null;
  state.forcedJs = false;
  state.freqs.fill(0);
  state.gates.fill(0);
  for (const b of state.keyButtons) b.classList.remove("down");
  STOP.disabled = true;
  FORCE.disabled = true;
  FORCE.textContent = "Force JS";
  WBAR.style.width = "0%";
  setStatus([["status", "stopped."]]);
  HUD.innerHTML = "";
}

function toggleForceJs() {
  if (!state.running || !state.node || !state.jit) return;
  state.forcedJs = !state.forcedJs;
  if (state.forcedJs) {
    state.jit.forceJs();
    FORCE.textContent = "JS forced — re-enable SIMD";
    state.gate = null;
  } else {
    FORCE.textContent = "Force JS";
    if (state.jit.jitEnabled) state.jit.requestCompile(); // re-compile + re-install
  }
  render();
}

// ─── wiring ──────────────────────────────────────────────────────────────────────

buildKeyboard();
TOKENS.textContent = KERNEL_TEXT;

START.addEventListener("click", () => start().catch((e) => {
  setStatus([["status", `start failed: ${e.message ?? e}`, "err"]]);
  START.disabled = false;
}));
STOP.addEventListener("click", stop);
FORCE.addEventListener("click", toggleForceJs);

for (const [el, id] of [[TONE, "tone"], [FB, "fb"], [LEVEL, "level"]]) {
  el.addEventListener("input", () => { $(`${id}-val`).textContent = el.value; postParams(); });
  $(`${id}-val`).textContent = el.value;
}

setStatus([
  ["status", "idle. press Start, then play A S D F G H J K.", ""],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB", String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
]);

// Test/debug hook — a Playwright smoke (and DevTools) can read state here.
window.__poly = {
  state,
  isolated: () => isolationOk(),
  ctxState: () => state.ctx?.state ?? "none",
  diag: () => state.diag,
  gate: () => state.gate,
  upgraded: () => !!(state.diag && state.diag.upgraded),
  noteOn: (v) => voiceOn(v),
  noteOff: (v) => voiceOff(v),
};
