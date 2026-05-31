// main.js — the PAGE thread that wires the three JIT realms together with one
// `connectJit` call.
//
//   1. Create the AudioContext, then `connectJit({ kernel: softClip, … })` — the
//      main-thread constructor allocates the shared WebAssembly.Memory, snapshots
//      `softClip.toString()`, and hands back the worklet `processorOptions`, the
//      compile-worker request, and the bind / forceJs controls.
//   2. addModule the worklet + create the node with `jit.processorOptions` (carries
//      the shared memory + the kernel source). Audio starts IMMEDIATELY on the JS
//      kernel.
//   3. Spawn the background compile worker and `jit.bind({ worker, workletPort })`
//      — connectJit forwards every gate-PASSED result to the worklet (Module
//      transport, bytes fallback) and fires onUpgrade / onFallback.
//   4. A beat later, `jit.requestCompile()` — the worklet silently upgrades to
//      SIMD mid-playback with zero audible glitch. "Force JS" reverts; "Recompile"
//      re-arms.

import { connectJit } from "../../dist/experimental/index.js";
import { softClip, SIGNATURE, MAX_BLOCK } from "./kernels.js";

const $ = (id) => document.getElementById(id);
const START = $("start");
const STOP = $("stop");
const FORCE = $("force");
const RECOMPILE = $("recompile");
const STATUS = $("status");
const HUD = $("hud");
const WBAR = $("wbar");
const FREQ = $("freq");
const DRIVE = $("drive");

const WINDOW_SECONDS = 0.25; // a visible crossfade (connectJit's default is 0.01)

const state = {
  ctx: null, node: null, worker: null, jit: null,
  running: false, forcedJs: false,
  diag: {}, upgrade: null, fallback: null, compileTimer: null,
};

function isolationOk() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
}

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
  const running = state.upgraded || d.ranSimd ? "SIMD" : "JS";
  const speedup = d.jsUs && d.simdUs ? (d.jsUs / d.simdUs).toFixed(2) + "×" : "—";

  setStatus([
    ["status", state.running ? "running" : "stopped", state.running ? "ok" : ""],
    ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
    ["JIT enabled", String(state.jit ? state.jit.jitEnabled : false), state.jit && state.jit.jitEnabled ? "ok" : "err"],
    ["swap phase", phase, phase === "fading" ? "hot" : phase === "complete" ? "ok" : ""],
    ["weight", w.toFixed(4)],
    ["running kernel", d.ranSimd ? "SIMD (vectorized) ✓" : "JS (scalar fallback)", d.ranSimd ? "ok" : "hot"],
    ["transport", d.transport ?? "—", d.transport === "module" ? "ok" : d.transport === "bytes" ? "hot" : ""],
    ["forced JS", String(state.forcedJs), state.forcedJs ? "hot" : ""],
  ]);

  const hudLines = [];
  if (state.upgrade) {
    const g = state.upgrade.gate;
    hudLines.push(`<span class="k">gate</span> <span class="v ok">VERIFIED bit-exact ✓ — ${g.casesChecked} cases, ${g.comparisons} comparisons, worst f32 ULP ${g.worstUlpF32}</span>`);
    hudLines.push(`<span class="k">install via</span> <span class="v hot">${state.upgrade.transport} transport</span>`);
  } else if (state.fallback) {
    hudLines.push(`<span class="k">gate</span> <span class="v err">FALLBACK — ${state.fallback.verdict}: ${state.fallback.detail}</span> (audio stays on JS)`);
  } else {
    hudLines.push(`<span class="k">gate</span> <span class="v">not yet compiled — press Start, then it compiles after ~1.2 s</span>`);
  }
  hudLines.push(
    `<span class="k">kernel time</span> <span class="v">JS ${fmtUs(d.jsUs)} · SIMD ${fmtUs(d.simdUs)} · speedup <strong>${speedup}</strong></span>`,
  );
  hudLines.push(
    `<span class="k">note</span> <span class="v dim">kernel time is measured in-worklet (coarse clock under isolation) — indicative. Rigorous: <code>npm run bench:jit</code> → 3.8×–9.2×.</span>`,
  );
  HUD.innerHTML = hudLines.join("\n");
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

  // 1. AudioContext first (we need its sampleRate), then connectJit (main thread).
  state.ctx = new AudioContext({ latencyHint: "interactive" });
  state.jit = connectJit({
    kernel: softClip,
    signature: SIGNATURE,
    maxBlock: MAX_BLOCK,
    sampleRate: state.ctx.sampleRate,
    windowSeconds: WINDOW_SECONDS,
  });

  // Resume the context (a click is a user gesture; resume() is belt-and-suspenders
  // for launch modes where the gesture window has already closed).
  try { await state.ctx.resume(); } catch {}

  // 2. The AudioWorklet holding the JitKernelConsumer — audio starts on JS now.
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "jit-vectorize", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: state.jit.processorOptions,
  });
  state.node.port.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === "diag") { state.diag = m; if (m.upgraded) state.upgraded = true; render(); }
  };
  state.node.port.postMessage({ type: "params", freq: Number(FREQ.value), drive: Number(DRIVE.value) });
  state.node.connect(state.ctx.destination);

  // 3. Background compile worker + the connectJit wiring (worker → worklet).
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.onerror = (e) => setStatus([["status", `worker error: ${e.message ?? e}`, "err"]]);
  state.jit.bind({
    worker: state.worker,
    workletPort: state.node.port,
    callbacks: {
      onUpgrade: (transport, gate) => { state.upgrade = { transport, gate }; state.fallback = null; render(); },
      onFallback: (verdict, detail) => { state.fallback = { verdict, detail }; render(); },
    },
  });

  state.running = true;
  STOP.disabled = false;
  FORCE.disabled = false;
  RECOMPILE.disabled = false;
  render();

  // 4. Let JS play audibly for a beat, then compile + silently upgrade.
  state.compileTimer = setTimeout(() => {
    if (!state.running) return;
    state.jit.requestCompile();
  }, 1200);
}

function toggleForceJs() {
  if (!state.running || !state.jit) return;
  state.forcedJs = !state.forcedJs;
  if (state.forcedJs) {
    state.jit.forceJs();
    state.upgraded = false;
    FORCE.textContent = "JS forced — re-enable JIT";
  } else {
    state.jit.requestCompile(); // re-arm the SIMD upgrade
    FORCE.textContent = "Force JS";
  }
  render();
}

function recompile() {
  if (!state.running || !state.jit || state.forcedJs) return;
  state.upgrade = null;
  state.jit.requestCompile();
  render();
}

function stop() {
  if (!state.running) return;
  state.running = false;
  if (state.compileTimer) { clearTimeout(state.compileTimer); state.compileTimer = null; }
  try { state.jit?.dispose(); } catch {}
  try { state.node?.disconnect(); } catch {}
  try { state.ctx?.close(); } catch {}
  try { state.worker?.terminate(); } catch {}
  state.node = state.ctx = state.worker = state.jit = null;
  state.diag = {}; state.upgrade = null; state.fallback = null; state.upgraded = false; state.forcedJs = false;
  STOP.disabled = true; FORCE.disabled = true; RECOMPILE.disabled = true; START.disabled = false;
  FORCE.textContent = "Force JS";
  WBAR.style.width = "0%";
  setStatus([["status", "stopped."]]);
  HUD.innerHTML = "";
}

// ─── Wiring ──────────────────────────────────────────────────────────────────
START.addEventListener("click", () => start().catch((e) => {
  setStatus([["status", `start failed: ${e.message ?? e}`, "err"]]);
  START.disabled = false;
}));
STOP.addEventListener("click", stop);
FORCE.addEventListener("click", toggleForceJs);
RECOMPILE.addEventListener("click", recompile);

for (const id of ["freq", "drive"]) {
  const el = $(id);
  el.addEventListener("input", () => {
    $(`${id}-val`).textContent = el.value;
    state.node?.port.postMessage({ type: "params", freq: Number(FREQ.value), drive: Number(DRIVE.value) });
  });
  $(`${id}-val`).textContent = el.value;
}

setStatus([
  ["status", "idle. press Start.", ""],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB", String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
  ["tip", "Start → hear the JS distortion → watch it upgrade to SIMD"],
]);

// Test/debug hook — the Playwright smoke (and DevTools) reads upgrade state here.
window.__jit = {
  state,
  isolated: () => isolationOk(),
  ctxState: () => state.ctx?.state ?? "none",
  diag: () => state.diag,
  upgrade: () => state.upgrade,
  fallback: () => state.fallback,
  forceJs: () => toggleForceJs(),
};
