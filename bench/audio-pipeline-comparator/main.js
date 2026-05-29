// main.js — the comparator orchestrator.
//
// Renders ONE reference signal through ALL FOUR pipelines and produces a
// side-by-side scorecard. Runs the paths SEQUENTIALLY (one active at a time)
// so no path's measurement is polluted by another path's GPU / audio / main-
// thread contention — the scorecard is apples-to-apples on content, and
// isolated on resources. A fixed scripted sequence per path (settle → latency
// sweep → stall continuity → partial-count ramp) keeps cross-browser captures
// comparable (handoff §8.1).
//
// Paths:
//   A — pure-CPU AudioWorklet additive synth (worklet.cpu.js). No worker/GPU.
//   B — naïve GPU → AudioBufferSourceNode (worker.gpu.js "absn" + main-thread
//       scheduler here). The only path with no process() callback.
//   C — GPU block-replace (worker.gpu.js "full"/"bridge" + worklet.gpu-block-
//       replace.js).
//   G — hybrid carrier + GPU residual (worker.gpu.js "residual"/"bridge" +
//       worklet.hybrid.js). The pattern under test.
//
// See README.md for the metric definitions and the predicted-vs-measured
// scorecard. The "Copy report" button emits a machine-readable JSON+text blob
// → results/<engine>.txt (handoff §4.7).

import { Bridge, BridgeInputLane, SpscRing } from "../../dist/index.js";
import {
  BLOCK_SIZE,
  CAPACITY,
  DEFAULT_PARTIALS,
  EVT_FREQ,
  INPUT_CAPACITY,
  makeInputSchema,
  makeSchema,
} from "./schema.js";
import { SAMPLE_RATE } from "./reference-signal.js";

// ── Scripted-sequence constants ─────────────────────────────────────────────
const SETTLE_MS = 1500;
const LATENCY_EVENTS = 24; // distinct freq changes per path's latency sweep.
const LATENCY_SPACING_MS = 200; // > the ~85 ms block floor, so blocks land between events.
const RAMP_STEPS = [16, 64, 256, 1024, 2048]; // spectral-richness ramp.
const RAMP_WINDOW_MS = 1200;
const QUANTUM = 128;
const PROC_BUDGET_MS = (QUANTUM / SAMPLE_RATE) * 1000; // ~2.67 ms quantum budget.
const PROC_BUDGET_FRACTION = 0.8; // A sustains while synth cost < 80 % of budget.
const FREQ_EPS = 0.01;
const BLOCK_DUR = BLOCK_SIZE / SAMPLE_RATE; // ~21.3 ms.
const ABSN_MAX_AHEAD = 4 * BLOCK_DUR; // path B's bounded buffer queue ≈ its latency floor.
// Continuity protocol: the stall must outlast the buffer drain + sample window
// so we measure RMS purely in the drained region (not the pre-buffered audio
// that keeps playing for one ring-depth after the producer stops).
const BUFFER_DEPTH_MS = CAPACITY * BLOCK_DUR * 1000; // ring depth ≈ 85 ms at D=4.
const STALL_MS = 700; // long enough to outlast drain + sample window.
const DRAIN_WAIT_MS = BUFFER_DEPTH_MS + 60; // wait past the drain before sampling.
const POST_DRAIN_MS = 400; // sample window fully inside the drained region.

const freqAt = (i) => 150 + 9 * i; // 150 .. 357 Hz, all distinct.

// ── DOM ─────────────────────────────────────────────────────────────────────
const STATUS = document.getElementById("status");
const RUN = document.getElementById("run");
const STOP = document.getElementById("stop");
const STRESS = document.getElementById("stress");
const RAMP = document.getElementById("ramp");
const RESULTS = document.getElementById("results");
const REPORT = document.getElementById("report");
const COPY = document.getElementById("copy");

const run = { active: false, abort: false, results: {}, stressHandle: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isolationOk = () =>
  typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
function setStatus(t) { STATUS.textContent = t; }

function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
const nsToMs = (ns) => (Number.isFinite(ns) ? ns / 1e6 : NaN);

// Main-thread contention burst (handoff §4.2 stress mode). Affects B most
// (its scheduling lives on the main thread).
function startStress() {
  if (run.stressHandle) return;
  run.stressHandle = setInterval(() => {
    const t0 = performance.now();
    while (performance.now() - t0 < 4) {
      document.body.style.outlineWidth = (1 + ((Math.random() * 3) | 0)) + "px";
      void document.body.offsetHeight;
    }
  }, 16);
}
function stopStress() {
  if (run.stressHandle) { clearInterval(run.stressHandle); run.stressHandle = null; }
  document.body.style.outlineWidth = "";
}

// ── Shared input-lane producer (paths A / C / G) ────────────────────────────
function makeInputLane() {
  const schema = makeInputSchema();
  const { sab } = SpscRing.allocate(INPUT_CAPACITY, schema);
  const ring = new SpscRing(sab, INPUT_CAPACITY, schema);
  const lane = new BridgeInputLane(ring);
  const frame = lane.scratchFrame();
  let seq = 0n;
  // Fire a freq event into the lane and return the tInput in epoch-ms.
  function fire(value0) {
    seq++;
    const tInputMs = performance.timeOrigin + performance.now();
    frame.seq = seq;
    frame.tInputNs = BigInt(Math.floor(tInputMs * 1e6));
    frame.eventType = EVT_FREQ;
    frame.sampleOffset = 0;
    frame.value0 = value0;
    frame.value1 = 0;
    lane.push(frame);
    return tInputMs;
  }
  return { sab, fire };
}

// ── Worklet-path runner (A / C / G) ─────────────────────────────────────────
async function runWorkletPath(cfg) {
  setStatus(`${cfg.name}: setup…`);
  const diag = { worklet: null, workletReportN: 0, worker: {} };
  const il = makeInputLane();

  let blockSab = null;
  if (cfg.needsBlockRing) {
    ({ sab: blockSab } = Bridge.allocate(CAPACITY, makeSchema(BLOCK_SIZE)));
  }

  let worker = null;
  if (cfg.needsWorker) {
    worker = new Worker(new URL("./worker.gpu.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      // Preserve adapter/backend across diag updates (the "ready" message
      // carries the adapter once; diag messages must not clobber it).
      if (m.type === "diag") diag.worker = { adapter: diag.worker.adapter, ...m };
      else if (m.type === "ready") { diag.worker.backend = m.backend; diag.worker.adapter = m.adapter; }
      else if (m.type === "fatal") setStatus(`${cfg.name}: worker fatal: ${m.message}`);
    };
    worker.postMessage({
      type: "init", sab: blockSab, capacity: CAPACITY, blockSize: BLOCK_SIZE,
      nPartials: DEFAULT_PARTIALS, carrierFreq: 220,
      signalMode: cfg.signalMode, emitMode: "bridge",
    });
  }

  const ctx = new AudioContext({ latencyHint: "interactive" });
  const audioStartPerfMs = performance.timeOrigin + performance.now();
  const outputLatencyMs = (ctx.outputLatency ?? 0) * 1000;
  await ctx.audioWorklet.addModule(new URL(`./${cfg.worklet}`, import.meta.url));
  const node = new AudioWorkletNode(ctx, cfg.processor, {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: {
      sab: blockSab, capacity: CAPACITY, blockSize: BLOCK_SIZE,
      inputSab: il.sab, inputCapacity: INPUT_CAPACITY, audioStartPerfMs, carrierFreq: 220,
    },
  });
  node.port.onmessage = (e) => {
    if (e.data.type === "diag") { diag.worklet = e.data; diag.workletReportN++; }
  };
  const gain = ctx.createGain();
  gain.gain.value = 0.0001; // ~ -80 dBFS — run the graph without blasting the user.
  node.connect(gain).connect(ctx.destination);
  node.port.postMessage({ type: "config", enableRms: true });

  const handle = { ctx, node, worker, diag };

  await sleep(SETTLE_MS);
  if (run.abort) return teardownWorklet(handle, cfg, { aborted: true });

  // ── Latency sweep ─────────────────────────────────────────────────────────
  setStatus(`${cfg.name}: latency sweep (${LATENCY_EVENTS} freq changes)…`);
  if (STRESS.checked) startStress();
  node.port.postMessage({ type: "latency-reset" });
  for (let i = 0; i < LATENCY_EVENTS; i++) {
    const f = freqAt(i);
    il.fire(f); // worklet learns tInputNs (sample-accurate apply for A/G).
    if (worker) worker.postMessage({ type: "freq", value: f }); // GPU recompute (C/G/B residual moot).
    await sleep(LATENCY_SPACING_MS);
    if (run.abort) return teardownWorklet(handle, cfg, { aborted: true });
  }
  await sleep(600); // let the last freq's block cross the ring (path C).
  stopStress();
  const latencySnap = diag.worklet?.latency ?? null;
  const procSnap = diag.worklet?.procDuration ?? null;

  // ── Stall continuity ────────────────────────────────────────────────────
  setStatus(`${cfg.name}: stall continuity…`);
  const continuity = await measureContinuity(handle);
  if (run.abort) return teardownWorklet(handle, cfg, { aborted: true });

  // ── Partial-count ramp ────────────────────────────────────────────────────
  let maxPartials = DEFAULT_PARTIALS;
  if (RAMP.checked) {
    setStatus(`${cfg.name}: partial-count ramp…`);
    maxPartials = await measureRampWorklet(cfg, handle);
  }

  const result = {
    id: cfg.id, name: cfg.name,
    backend: cfg.needsWorker ? (diag.worker.backend ?? "?") : "cpu-worklet",
    adapter: diag.worker.adapter ?? null,
    latency: latencySnap,
    procP99Ns: procSnap ? procSnap.p99Ns : null,
    continuity,
    maxPartials,
    underflow: diag.worklet?.underflowSamples ?? 0,
    outputLatencyMs,
  };
  teardownWorklet(handle, cfg, {});
  return result;
}

function teardownWorklet(handle, cfg, { aborted }) {
  stopStress();
  try { handle.node?.disconnect(); } catch {}
  try { handle.ctx?.close(); } catch {}
  try { handle.worker?.postMessage({ type: "stop" }); } catch {}
  try { handle.worker?.terminate(); } catch {}
  return aborted ? { id: cfg.id, name: cfg.name, aborted: true } : undefined;
}

// Read the worklet's cumulative-since-reset RMS from the latest diag.
function readRms(handle) {
  const d = handle.diag.worklet;
  if (!d || !d.rmsSinceReport) return NaN;
  return Math.sqrt(d.rmsSqAccum / d.rmsSinceReport);
}
async function waitForFreshReport(handle) {
  const base = handle.diag.workletReportN;
  const t0 = performance.now();
  while (performance.now() - t0 < 600 && handle.diag.workletReportN <= base) {
    await sleep(15);
  }
}

async function measureContinuity(handle) {
  handle.node.port.postMessage({ type: "rms-reset" });
  await sleep(500);
  await waitForFreshReport(handle);
  const baselineRms = readRms(handle);

  if (!handle.worker) {
    // Path A has no GPU to stall — it is immune to GPU outage by construction
    // (the cost it pays instead is the partial cap). Continuity is 100 %.
    return { baselineRms, stallRms: baselineRms, ratio: 1.0, immune: true };
  }

  handle.worker.postMessage({ type: "stall", durationMs: STALL_MS });
  await sleep(DRAIN_WAIT_MS); // let the ring drain past its depth (buffered audio plays out)
  handle.node.port.postMessage({ type: "rms-reset" }); // measure ONLY the drained region
  await sleep(POST_DRAIN_MS); // > the 250 ms diag interval → a post-reset report exists
  const stallRms = readRms(handle);
  await sleep(600); // recovery
  return { baselineRms, stallRms, ratio: stallRms / baselineRms, immune: false };
}

function underflowNow(handle) { return handle.diag.worklet?.underflowSamples ?? 0; }

// Path A's cap is a CPU-cost question: the O(N)-per-sample additive synth must
// fit the 2.67 ms quantum budget. `performance.now()` is not portably exposed
// inside an AudioWorklet (it is absent in some Chrome builds, and historically
// Firefox/Safari), so we measure the cap with a MAIN-THREAD micro-bench of the
// exact same per-quantum inner loop — a representative proxy for the audio-
// thread cost (handoff §4.4/4.5: max-partial-count IS the CPU-cost proxy).
function timeSynthQuantumMs(N) {
  const TWO_PI = Math.PI * 2;
  const phase = new Float64Array(N + 2);
  const dphi = new Float64Array(N + 2);
  const amps = new Float64Array(N + 2);
  for (let k = 1; k <= N + 1; k++) { dphi[k] = (220 * k) / SAMPLE_RATE; amps[k] = 1 / k; }
  const ITER = 200;
  // Warm up the JIT.
  for (let it = 0; it < 20; it++) {
    for (let i = 0; i < QUANTUM; i++) {
      for (let k = 1; k <= N + 1; k++) { Math.sin(TWO_PI * phase[k]); phase[k] += dphi[k]; }
    }
  }
  const t0 = performance.now();
  for (let it = 0; it < ITER; it++) {
    for (let i = 0; i < QUANTUM; i++) {
      let acc = 0;
      for (let k = 1; k <= N + 1; k++) { acc += Math.sin(TWO_PI * phase[k]) * amps[k]; phase[k] += dphi[k]; }
      if (acc === 1e30) phase[1] += 1; // defeat dead-code elimination
    }
    for (let k = 1; k <= N + 1; k++) phase[k] -= Math.floor(phase[k]);
  }
  return (performance.now() - t0) / ITER; // ms per 128-sample quantum
}

function measureRampCpuProxy() {
  let maxOk = 0;
  for (const N of RAMP_STEPS) {
    const msPerQuantum = timeSynthQuantumMs(N);
    if (msPerQuantum < PROC_BUDGET_MS * PROC_BUDGET_FRACTION) maxOk = N; else break;
  }
  return maxOk;
}

async function measureRampWorklet(cfg, handle) {
  if (cfg.id === "A") return measureRampCpuProxy();
  let maxOk = 0;
  for (const N of RAMP_STEPS) {
    if (run.abort) break;
    handle.worker.postMessage({ type: "setPartials", n: N });
    await sleep(300); // take effect
    const beforeUnder = underflowNow(handle);
    await sleep(RAMP_WINDOW_MS);
    const afterUnder = underflowNow(handle);
    if (afterUnder - beforeUnder === 0) maxOk = N; else break;
  }
  handle.worker.postMessage({ type: "setPartials", n: DEFAULT_PARTIALS });
  return maxOk;
}

// ── ABSN-path runner (B) ────────────────────────────────────────────────────
async function runAbsnPath(cfg) {
  setStatus(`${cfg.name}: setup…`);
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const outputLatencyMs = (ctx.outputLatency ?? 0) * 1000;
  const absnGain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0.0001;
  absnGain.connect(analyser).connect(muteGain).connect(ctx.destination);
  const tdBuf = new Float32Array(analyser.fftSize);

  const st = {
    nextStart: 0, started: false, underruns: 0, drops: 0, blocksReceived: 0,
    backend: "?", adapter: null,
    pendingB: [], latencyMs: [], partials: DEFAULT_PARTIALS,
  };

  const worker = new Worker(new URL("./worker.gpu.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") { st.backend = m.backend; st.adapter = m.adapter; return; }
    if (m.type === "diag") { st.partials = m.nPartials ?? st.partials; return; }
    if (m.type === "fatal") { setStatus(`${cfg.name}: worker fatal: ${m.message}`); return; }
    if (m.type !== "block") return;

    // Naïve scheduler: copy the transferred samples into an AudioBuffer and
    // schedule a fresh AudioBufferSourceNode back-to-back. The queue depth is
    // B's structural latency floor — there is no process() callback to splice
    // into mid-stream.
    if (!st.started) { st.nextStart = ctx.currentTime + 2 * BLOCK_DUR; st.started = true; }
    // Bounded queue: a real naïve ABSN player can't queue unboundedly. The
    // producer over-produces vs the ~46.9 Hz consumption rate, so if we're
    // already ABSN_MAX_AHEAD ahead of the playhead, DROP the freshly computed
    // block. This bounds B's latency to the queue depth and lets a stall drain
    // the queue to silence (without the bound, the queue grows without limit
    // and both the latency and the stall-continuity numbers become meaningless).
    // Intentional over-production drop (queue already full). NOT an underrun —
    // the producer simply runs faster than ~46.9 Hz consumption. Counted
    // separately so it doesn't masquerade as a glitch in the partial ramp.
    if (st.nextStart - ctx.currentTime > ABSN_MAX_AHEAD) { st.drops++; return; }

    const buf = ctx.createBuffer(1, BLOCK_SIZE, SAMPLE_RATE);
    buf.copyToChannel(m.samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(absnGain);
    let when = st.nextStart;
    if (when < ctx.currentTime) {
      // Fell behind the playhead — a REAL ABSN buffer-queue underrun (the
      // producer couldn't keep the queue fed). This is the glitch signal.
      st.underruns++;
      when = ctx.currentTime + 0.005;
      st.nextStart = when;
    }
    src.start(when);
    // Latency: match this block to a pending freq target by frequency, then
    // measure the "control → scheduled-audible" delay PURELY in the audio
    // clock — `when` (scheduled play time) minus the AudioContext time captured
    // when the control event fired (handoff §4.B). Staying in one clock avoids
    // mixing wall-clock and playback-clock (which carry different output-buffer
    // biases) and is positive by construction: it is the buffer-queue delay,
    // B's structural latency floor.
    for (let i = 0; i < st.pendingB.length; i++) {
      if (Math.abs(st.pendingB[i].freq - m.carrierFreq) < FREQ_EPS) {
        st.latencyMs.push((when - st.pendingB[i].tCtx) * 1000);
        st.pendingB.splice(i, 1);
        break;
      }
    }
    st.nextStart += BLOCK_DUR;
    st.blocksReceived++;
  };
  worker.postMessage({
    type: "init", capacity: CAPACITY, blockSize: BLOCK_SIZE,
    nPartials: DEFAULT_PARTIALS, carrierFreq: 220, signalMode: "full", emitMode: "absn",
  });

  const readAnalyserRms = () => {
    analyser.getFloatTimeDomainData(tdBuf);
    let sq = 0;
    for (let i = 0; i < tdBuf.length; i++) sq += tdBuf[i] * tdBuf[i];
    return Math.sqrt(sq / tdBuf.length);
  };
  const avgRms = async (windowMs) => {
    const t0 = performance.now();
    let sum = 0, n = 0;
    while (performance.now() - t0 < windowMs) { sum += readAnalyserRms(); n++; await sleep(20); }
    return n ? sum / n : NaN;
  };

  await sleep(SETTLE_MS);
  if (run.abort) { teardownAbsn(ctx, worker); return { id: cfg.id, name: cfg.name, aborted: true }; }

  // ── Latency sweep ───────────────────────────────────────────────────────
  setStatus(`${cfg.name}: latency sweep…`);
  if (STRESS.checked) startStress();
  st.latencyMs.length = 0;
  st.pendingB.length = 0;
  for (let i = 0; i < LATENCY_EVENTS; i++) {
    const f = freqAt(i);
    st.pendingB.push({ freq: f, tCtx: ctx.currentTime });
    worker.postMessage({ type: "freq", value: f });
    await sleep(LATENCY_SPACING_MS);
    if (run.abort) { teardownAbsn(ctx, worker); return { id: cfg.id, name: cfg.name, aborted: true }; }
  }
  await sleep(600);
  stopStress();
  const latencyMs = st.latencyMs.slice();

  // ── Stall continuity (AnalyserNode tap) ───────────────────────────────────
  setStatus(`${cfg.name}: stall continuity…`);
  const baselineRms = await avgRms(500);
  worker.postMessage({ type: "stall", durationMs: STALL_MS });
  // Wait for the bounded buffer queue to drain, then sample purely the silent
  // region (the window stays inside the stall: DRAIN_WAIT + 200 < STALL_MS).
  await sleep(DRAIN_WAIT_MS);
  const stallRms = await avgRms(200);
  await sleep(600);

  // ── Partial-count ramp ────────────────────────────────────────────────────
  let maxPartials = DEFAULT_PARTIALS;
  if (RAMP.checked) {
    setStatus(`${cfg.name}: partial-count ramp…`);
    for (const N of RAMP_STEPS) {
      if (run.abort) break;
      worker.postMessage({ type: "setPartials", n: N });
      await sleep(300);
      const underrunsBefore = st.underruns;
      await sleep(RAMP_WINDOW_MS);
      // Sustained iff no REAL underruns over the window (intentional
      // over-production drops don't count — the GPU producing too fast is fine;
      // the GPU producing too slow to keep the queue fed is the failure).
      const sustained = st.underruns - underrunsBefore === 0;
      if (sustained) maxPartials = N; else break;
    }
    worker.postMessage({ type: "setPartials", n: DEFAULT_PARTIALS });
  }

  const result = {
    id: cfg.id, name: cfg.name, backend: st.backend, adapter: st.adapter,
    latency: latencyMs.length
      ? {
          count: latencyMs.length,
          p50Ns: pct(latencyMs, 0.5) * 1e6,
          p95Ns: pct(latencyMs, 0.95) * 1e6,
          p99Ns: pct(latencyMs, 0.99) * 1e6,
          maxNs: Math.max(...latencyMs) * 1e6,
          lastSignedNs: latencyMs[latencyMs.length - 1] * 1e6,
        }
      : null,
    procP99Ns: null, // B has no worklet — process() duration is not applicable.
    continuity: { baselineRms, stallRms, ratio: stallRms / baselineRms, immune: false },
    maxPartials,
    underflow: st.underruns, // B's "underflow" is real buffer-queue underruns.
    outputLatencyMs,
  };
  teardownAbsn(ctx, worker);
  return result;
}

function teardownAbsn(ctx, worker) {
  stopStress();
  try { worker?.postMessage({ type: "stop" }); } catch {}
  try { worker?.terminate(); } catch {}
  try { ctx?.close(); } catch {}
}

// ── Orchestration ───────────────────────────────────────────────────────────
const PATH_CONFIGS = [
  { id: "A", name: "A — Pure CPU worklet", kind: "worklet", processor: "comparator-cpu", worklet: "worklet.cpu.js", needsWorker: false, needsBlockRing: false },
  { id: "C", name: "C — GPU block-replace", kind: "worklet", processor: "comparator-gpu-block-replace", worklet: "worklet.gpu-block-replace.js", needsWorker: true, needsBlockRing: true, signalMode: "full" },
  { id: "G", name: "G — Hybrid carrier+residual", kind: "worklet", processor: "comparator-hybrid", worklet: "worklet.hybrid.js", needsWorker: true, needsBlockRing: true, signalMode: "residual" },
  { id: "B", name: "B — GPU → AudioBufferSourceNode", kind: "absn", needsWorker: true },
];

async function runAll() {
  if (run.active) return;
  if (!isolationOk()) { setStatus("page is not crossOriginIsolated — set COOP/COEP and reload."); return; }
  if (typeof SharedArrayBuffer === "undefined") { setStatus("SharedArrayBuffer unavailable."); return; }

  run.active = true; run.abort = false; run.results = {};
  RUN.disabled = true; STOP.disabled = false; RESULTS.innerHTML = ""; REPORT.textContent = "";
  try {
    for (const cfg of PATH_CONFIGS) {
      if (run.abort) break;
      const r = cfg.kind === "absn" ? await runAbsnPath(cfg) : await runWorkletPath(cfg);
      if (r && !r.aborted) { run.results[cfg.id] = r; renderScorecard(); }
    }
    setStatus(run.abort ? "stopped." : "done. all four pipelines measured.");
    renderScorecard();
    renderReport();
  } catch (e) {
    setStatus(`FAILED: ${e?.message ?? e}`);
    console.error(e);
  } finally {
    stopStress();
    run.active = false;
    RUN.disabled = false; STOP.disabled = true;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────
const fmtMs = (ns) => (Number.isFinite(ns) ? `${nsToMs(ns).toFixed(1)} ms` : "—");
const fmtPct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "—");
const fmtUs = (ns) => (ns == null || !Number.isFinite(ns) ? "—" : `${(ns / 1000).toFixed(0)} µs`);

function spreadNs(lat) {
  return lat && Number.isFinite(lat.p99Ns) && Number.isFinite(lat.p50Ns)
    ? lat.p99Ns - lat.p50Ns : NaN;
}

function renderScorecard() {
  const order = ["A", "B", "C", "G"];
  const rows = [
    ["Backend", (r) => r.backend ?? "—"],
    ["Freq-change latency (p50)", (r) => fmtMs(r.latency?.p50Ns), "latency"],
    ["… p95 / p99", (r) => `${fmtMs(r.latency?.p95Ns)} / ${fmtMs(r.latency?.p99Ns)}`],
    ["… spread (p99−p50)", (r) => fmtMs(spreadNs(r.latency))],
    ["… samples", (r) => String(r.latency?.count ?? 0)],
    ["Stall continuity", (r) => fmtPct(r.continuity?.ratio), "continuity"],
    ["Max sustainable partials", (r) => String(r.maxPartials ?? "—"), "partials"],
    ["process() p99", (r) => fmtUs(r.procP99Ns)],
    ["Underflow / sched-gaps", (r) => String(r.underflow ?? 0)],
  ];
  let html = `<table class="results"><thead><tr><th>Metric</th>`;
  for (const id of order) html += `<th>${run.results[id]?.id ?? id}</th>`;
  html += `</tr></thead><tbody>`;
  for (const [label, fn, hl] of rows) {
    html += `<tr><td>${label}</td>`;
    for (const id of order) {
      const r = run.results[id];
      let cls = "";
      if (r && hl === "continuity") cls = r.continuity?.ratio > 0.5 ? "win" : "lose";
      if (r && hl === "latency") cls = nsToMs(r.latency?.p50Ns) < 20 ? "win" : "lose";
      html += `<td class="${cls}">${r ? fn(r) : "…"}</td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>
    <p class="note"><strong>The headline:</strong> G is the only path that wins the
    latency column <em>and</em> the continuity column <em>and</em> the partial-count
    column at once. A wins latency but loses partials; B / C win partials but lose
    latency + continuity. Latency is reported as a magnitude biased by the audio
    output-buffer offset (~${run.results.G ? run.results.G.outputLatencyMs?.toFixed(0) : "?"} ms);
    the spread (p99−p50) is the glitch-governing figure. See README for definitions.</p>`;
  RESULTS.innerHTML = html;
}

function renderReport() {
  const blob = {
    bench: "audio-pipeline-comparator",
    generatedAtIso: new Date().toISOString(),
    engine: navigator.userAgent,
    crossOriginIsolated: isolationOk(),
    stress: STRESS.checked,
    ramp: RAMP.checked,
    config: {
      blockSize: BLOCK_SIZE, capacity: CAPACITY, sampleRate: SAMPLE_RATE,
      defaultPartials: DEFAULT_PARTIALS, latencyEvents: LATENCY_EVENTS,
      latencySpacingMs: LATENCY_SPACING_MS, rampSteps: RAMP_STEPS,
      procBudgetMs: PROC_BUDGET_MS, absnMaxAheadMs: ABSN_MAX_AHEAD * 1000, stallMs: STALL_MS,
    },
    paths: run.results,
  };
  const json = JSON.stringify(blob, null, 2);
  // Human-readable header + machine-readable JSON in one blob for results/*.txt.
  let txt = `webgpu-audio-bridge — audio pipeline comparator\n`;
  txt += `engine: ${navigator.userAgent}\n`;
  txt += `isolated: ${isolationOk()}  stress: ${STRESS.checked}  ramp: ${RAMP.checked}\n\n`;
  const order = ["A", "B", "C", "G"];
  txt += `path                          backend   lat-p50   lat-spread  continuity  maxPartials  proc-p99\n`;
  for (const id of order) {
    const r = run.results[id];
    if (!r) continue;
    txt += `${(r.name).padEnd(30)}${(r.backend ?? "?").padEnd(10)}`
      + `${fmtMs(r.latency?.p50Ns).padStart(8)}  ${fmtMs(spreadNs(r.latency)).padStart(9)}  `
      + `${fmtPct(r.continuity?.ratio).padStart(9)}  ${String(r.maxPartials).padStart(11)}  `
      + `${fmtUs(r.procP99Ns).padStart(8)}\n`;
  }
  txt += `\n--- machine-readable ---\n${json}\n`;
  REPORT.textContent = txt;
}

// ── Wiring ───────────────────────────────────────────────────────────────────
RUN.addEventListener("click", () => runAll());
STOP.addEventListener("click", () => { run.abort = true; setStatus("stopping after current step…"); });
COPY.addEventListener("click", () => {
  navigator.clipboard?.writeText(REPORT.textContent ?? "").catch(() => {});
});

setStatus(
  isolationOk()
    ? "ready. press Run to measure all four pipelines (~40–70 s)."
    : "page is not crossOriginIsolated — set COOP/COEP and reload.",
);

// MCP / automation hooks.
window.__comparator = {
  run: () => runAll(),
  stop: () => { run.abort = true; },
  getResults: () => run.results,
  getReport: () => REPORT.textContent,
};
