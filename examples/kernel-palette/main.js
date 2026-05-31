// main.js — the PAGE thread for the kernel-palette demo (Apollo Frontier 6, Stage 1).
//
// Pick a kernel from the palette → it is compiled, gate-verified, content-addressed,
// and live-swapped into the running AudioWorklet click-free. Re-pick a kernel and it
// is a CACHE HIT — the same characterized kernel, no recompile. That visible "hit"
// is the payoff of Stage 1 (the content-addressed `KernelCache`).
//
// The three realms wired here:
//   • PAGE (this file) — owns the AudioContext + the selection lifecycle, calls
//     `connectJit({ tokens })` to build the worklet processorOptions (shared memory
//     + the `emitJsKernel` JS fallback), forwards gate-verified bytes to the worklet.
//   • COMPILE+CACHE WORKER (worker.js) — holds ONE `KernelCache` + wabt; for each
//     selection it `getOrCompile`s the token stream and replies with the gate report,
//     the `cached` flag, and the SIMD bytes.
//   • AUDIOWORKLET (worklet.js) — generates the oscillators, runs the consumer, and
//     installs the bytes between quanta.
//
// On every selection audio starts on the JS fallback immediately; when the worker's
// gate-verified bytes arrive they fade in over ~0.25 s. Selecting the same kernel a
// second time returns from the cache with no recompile (cached ✓).

import { connectJit } from "../../dist/experimental/index.js";
import { PALETTE, MAX_BLOCK } from "./palette.js";

const $ = (id) => document.getElementById(id);
const KSEL = $("kernel");
const START = $("start");
const STOP = $("stop");
const FORCE = $("force");
const RELOAD = $("reload");
const STATUS = $("status");
const HUD = $("hud");
const WBAR = $("wbar");
const FREQ = $("freq");
const LEVEL = $("level");
const SCALARS = $("scalars");
const TOKENS = $("tokens");

const WINDOW_SECONDS = 0.25; // a visible crossfade (connectJit's default is 0.01)

const state = {
  ctx: null,
  node: null,
  worker: null,
  jit: null,
  running: false,
  moduleAdded: false,
  cache: { size: 0 }, // mirror of the worker's cache size, for the HUD
  current: null,      // the selected palette entry
  forcedJs: false,
  scalarValues: {},   // scalar name → current value for the selected kernel
  reqId: 0,           // monotonic compile-request id (ignore stale replies)
  diag: {},
  lastCompile: null,  // { cached, gate, hash, ms } from the last worker reply
  pendingPostMs: 0,
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

// A unicode block sparkline of the L1-normalized magnitude bands (relative scale).
const SPARK = "▁▂▃▄▅▆▇█";
function sparkline(bands) {
  if (!bands || bands.length === 0) return "—";
  // Max-pool to ≤16 display cells so the bar stays compact regardless of the
  // fingerprint resolution (the default fingerprintBands is 64).
  const CELLS = 16;
  let cells = bands;
  if (bands.length > CELLS) {
    cells = new Array(CELLS).fill(0);
    for (let i = 0; i < bands.length; i++) {
      const c = Math.min(CELLS - 1, Math.floor((i * CELLS) / bands.length));
      cells[c] = Math.max(cells[c], bands[i]);
    }
  }
  const max = cells.reduce((m, v) => Math.max(m, v), 0) || 1;
  return cells.map((v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))]).join("");
}

function render() {
  const d = state.diag;
  const w = d.weight ?? 0;
  WBAR.style.width = `${Math.round(Math.max(0, Math.min(1, w)) * 100)}%`;
  WBAR.className = "wbar " + (d.phase === "complete" ? "done" : d.phase === "fading" ? "fade" : "");

  const phase = d.phase ?? "idle";
  const speedup = d.jsUs && d.simdUs ? (d.jsUs / d.simdUs).toFixed(2) + "×" : "—";

  setStatus([
    ["status", state.running ? "running" : "stopped", state.running ? "ok" : ""],
    ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
    ["JIT enabled", String(state.jit ? state.jit.jitEnabled : false), state.jit && state.jit.jitEnabled ? "ok" : "err"],
    ["kernel", state.current ? `${state.current.id} (${state.current.width})` : "—"],
    ["swap phase", phase, phase === "fading" ? "hot" : phase === "complete" ? "ok" : ""],
    ["running kernel", d.ranSimd ? "SIMD (vectorized) ✓" : "JS (scalar fallback)", d.ranSimd ? "ok" : "hot"],
    ["forced JS", String(state.forcedJs), state.forcedJs ? "hot" : ""],
  ]);

  const lines = [];
  const lc = state.lastCompile;
  if (lc) {
    if (lc.cached) {
      lines.push(`<span class="k">cache</span> <span class="v ok">CACHE HIT ✓ — same characterized kernel, no recompile (${lc.ms.toFixed(1)} ms round-trip)</span>`);
    } else {
      lines.push(`<span class="k">cache</span> <span class="v hot">COMPILED — syntax + equivalence gate ran ${lc.gate.comparisons} comparisons (${lc.ms.toFixed(1)} ms)</span>`);
    }
    lines.push(`<span class="k">gate</span> <span class="v ok">VERIFIED ${lc.gate.status} — worst f32 ULP ${lc.gate.worstUlpF32}, ${lc.gate.casesChecked} cases</span>`);
    lines.push(`<span class="k">content hash</span> <span class="v">${lc.hash}</span>`);
    if (lc.acoustic) {
      const a = lc.acoustic;
      lines.push(
        `<span class="k">acoustic (gate #3)</span> <span class="v ok">SANE — peak ${a.peak.toFixed(3)} · rms ${a.rms.toFixed(3)} · crest ${a.crestFactor.toFixed(2)} · dc ${a.dcOffset.toFixed(3)} · centroid ${a.spectralCentroid.toFixed(3)}</span>`,
      );
      lines.push(`<span class="k">fingerprint</span> <span class="v">${sparkline(a.magnitude)} <span class="dim">(${a.magnitude.length}-band L1-normalized spectrum)</span></span>`);
    }
  } else {
    lines.push(`<span class="k">cache</span> <span class="v dim">pick a kernel — it compiles + gate-verifies; re-pick it for a cache hit</span>`);
  }
  lines.push(`<span class="k">cache size</span> <span class="v">${state.cache.size} distinct kernel${state.cache.size === 1 ? "" : "s"} held</span>`);
  lines.push(`<span class="k">kernel time</span> <span class="v">JS ${fmtUs(d.jsUs)} · SIMD ${fmtUs(d.simdUs)} · speedup <strong>${speedup}</strong> <span class="dim">(coarse worklet clock — rigorous: <code>npm run bench:jit</code>)</span></span>`);
  HUD.innerHTML = lines.join("\n");

  if (state.current) TOKENS.textContent = state.current.text;
}

// ─── scalar sliders (rebuilt per selected kernel) ────────────────────────────────

function buildScalarSliders(entry) {
  SCALARS.innerHTML = "";
  state.scalarValues = {};
  const names = entry.scalarNames;
  if (names.length === 0) {
    SCALARS.innerHTML = `<span class="dim">(this kernel has no scalar params)</span>`;
    return;
  }
  for (const name of names) {
    const cfg = entry.scalars[name] ?? { label: name, min: 0, max: 1, value: 0.5, step: 0.01 };
    state.scalarValues[name] = cfg.value;
    const wrap = document.createElement("div");
    wrap.innerHTML =
      `<label for="sc-${name}">${cfg.label} <span class="val" id="sc-${name}-val">${cfg.value}</span></label>` +
      `<input id="sc-${name}" type="range" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${cfg.value}" />`;
    SCALARS.appendChild(wrap);
    const input = wrap.querySelector("input");
    const valEl = wrap.querySelector(`#sc-${name}-val`);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      state.scalarValues[name] = v;
      valEl.textContent = input.value;
      postParams();
    });
  }
}

function postParams() {
  state.node?.port.postMessage({
    type: "params",
    freq: Number(FREQ.value),
    level: Number(LEVEL.value),
    scalars: { ...state.scalarValues },
  });
}

// ─── selection lifecycle (teardown / rebuild per kernel) ─────────────────────────

function tearDownNode() {
  if (state.node) {
    try { state.node.port.onmessage = null; } catch {}
    try { state.node.disconnect(); } catch {}
    state.node = null;
  }
  if (state.jit) { try { state.jit.dispose(); } catch {} state.jit = null; }
}

async function selectKernel(id) {
  if (!state.running || !state.ctx) return;
  const entry = PALETTE.find((p) => p.id === id);
  if (!entry) return;
  state.current = entry;
  state.forcedJs = false;
  FORCE.textContent = "Force JS";
  buildScalarSliders(entry);

  // Build the worklet plumbing for THIS kernel (fresh memory + the emitJsKernel JS
  // fallback). connectJit does NOT compile — the worker does, via the cache.
  tearDownNode();
  state.jit = connectJit({
    tokens: entry.tokens,
    signature: entry.signature,
    maxBlock: MAX_BLOCK,
    sampleRate: state.ctx.sampleRate,
    windowSeconds: WINDOW_SECONDS,
  });
  state.node = new AudioWorkletNode(state.ctx, "kernel-palette", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: state.jit.processorOptions,
  });
  state.node.port.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === "diag") { state.diag = m; render(); }
  };
  postParams();
  state.node.connect(state.ctx.destination);

  state.diag = {};
  render();

  // Ask the worker to compile (or cache-hit) the stream; install bytes on reply.
  state.reqId += 1;
  state.pendingPostMs = nowMs();
  state.worker.postMessage({ type: "compile", id: state.reqId, tokens: entry.tokens });
}

function onWorkerMessage(e) {
  const m = e.data;
  if (!m || m.type !== "compiled") return;
  if (m.id !== state.reqId) return; // a stale reply from a superseded selection
  const ms = nowMs() - state.pendingPostMs;
  if (typeof m.cacheSize === "number") state.cache.size = m.cacheSize;

  if (m.status !== "accepted") {
    state.lastCompile = null;
    // gate #3 (rejected-acoustic) is a meaningful verdict, not an error — surface it
    // with the fingerprint that explains the rejection (peak / dc / non-finite).
    const cls = m.verdict === "rejected-acoustic" ? "hot" : "err";
    const fp = m.acoustic ? ` — peak ${m.acoustic.peak.toExponential(2)}, finite ${m.acoustic.finite}` : "";
    setStatus([["status", `compile fallback — ${m.verdict}: ${m.detail}${fp}`, cls]]);
    return;
  }
  state.lastCompile = { cached: m.cached, gate: m.gate, hash: m.hash, acoustic: m.acoustic, ms };

  // Install the gate-verified SIMD bytes (a no-op if the host isn't JIT-enabled —
  // audio then stays on the JS fallback forever, the graceful-degrade floor).
  if (state.jit && state.jit.jitEnabled && !state.forcedJs) {
    state.node?.port.postMessage({
      type: "jit-install",
      transport: "bytes",
      bytes: m.bytes,
      exportName: m.exportName,
    });
  }
  render();
}

// ─── controls ────────────────────────────────────────────────────────────────────

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

  // The compile + cache worker (one per session — its cache persists across Stop).
  if (!state.worker) {
    state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    state.worker.onmessage = onWorkerMessage;
    state.worker.onerror = (e) => setStatus([["status", `worker error: ${e.message ?? e}`, "err"]]);
  }

  state.running = true;
  STOP.disabled = false;
  FORCE.disabled = false;
  RELOAD.disabled = false;
  KSEL.disabled = false;

  await selectKernel(KSEL.value);
}

function stop() {
  if (!state.running) return;
  state.running = false;
  tearDownNode();
  try { state.ctx?.close(); } catch {}
  state.ctx = null;
  state.moduleAdded = false;
  // NOTE: the worker (and its KernelCache) is intentionally kept alive across Stop,
  // so re-Starting and re-picking a kernel is still a cache HIT.
  state.diag = {};
  state.forcedJs = false;
  STOP.disabled = true;
  FORCE.disabled = true;
  RELOAD.disabled = true;
  FORCE.textContent = "Force JS";
  WBAR.style.width = "0%";
  setStatus([["status", "stopped (cache kept — re-Start to see a hit)."]]);
}

function toggleForceJs() {
  if (!state.running || !state.node) return;
  state.forcedJs = !state.forcedJs;
  if (state.forcedJs) {
    state.node.port.postMessage({ type: "jit-force-js" });
    FORCE.textContent = "JS forced — re-enable SIMD";
  } else {
    // Re-arm: ask the worker again (a cache hit) and re-install the bytes.
    FORCE.textContent = "Force JS";
    state.reqId += 1;
    state.pendingPostMs = nowMs();
    state.worker.postMessage({ type: "compile", id: state.reqId, tokens: state.current.tokens });
  }
  render();
}

function reload() {
  // Re-select the SAME kernel — a deliberate way to demonstrate the cache hit
  // without changing the dropdown.
  if (!state.running || !state.current) return;
  selectKernel(state.current.id);
}

// ─── wiring ──────────────────────────────────────────────────────────────────────

// Populate the palette dropdown.
for (const entry of PALETTE) {
  const opt = document.createElement("option");
  opt.value = entry.id;
  opt.textContent = entry.label;
  KSEL.appendChild(opt);
}
KSEL.disabled = true;

START.addEventListener("click", () => start().catch((e) => {
  setStatus([["status", `start failed: ${e.message ?? e}`, "err"]]);
  START.disabled = false;
}));
STOP.addEventListener("click", stop);
FORCE.addEventListener("click", toggleForceJs);
RELOAD.addEventListener("click", reload);
KSEL.addEventListener("change", () => selectKernel(KSEL.value));

for (const [el, id] of [[FREQ, "freq"], [LEVEL, "level"]]) {
  el.addEventListener("input", () => { $(`${id}-val`).textContent = el.value; postParams(); });
  $(`${id}-val`).textContent = el.value;
}

setStatus([
  ["status", "idle. press Start.", ""],
  ["isolated", String(isolationOk()), isolationOk() ? "ok" : "err"],
  ["SAB", String(typeof SharedArrayBuffer !== "undefined"), typeof SharedArrayBuffer !== "undefined" ? "ok" : "err"],
  ["tip", "Start → pick kernels → re-pick one to see a CACHE HIT"],
]);

// Test/debug hook — a Playwright smoke (and DevTools) can read state here.
window.__palette = {
  state,
  isolated: () => isolationOk(),
  ctxState: () => state.ctx?.state ?? "none",
  diag: () => state.diag,
  lastCompile: () => state.lastCompile,
  cacheSize: () => state.cache.size,
  select: (id) => selectKernel(id),
};
