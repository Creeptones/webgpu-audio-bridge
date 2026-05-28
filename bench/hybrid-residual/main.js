// main.js — bench-page orchestrator (hybrid-residual benchmark).
//
// Drives a fixed-cadence test sequence against the demo's worker + worklet
// (re-imported from /examples/hybrid-residual/) and measures the metric
// that distinguishes processAdd from process: output continuity during a
// programmed GPU-side stall.
//
// Sequence per measured mode:
//   1. Settle 1500 ms at the given mode.
//   2. Capture baseline RMS over a 500 ms quiet window.
//   3. Trigger a 250 ms GPU stall.
//   4. Capture stall-window RMS over the same 250 ms.
//   5. Wait 500 ms recovery, then move to next mode.
//
// The headline metric is the ratio (stallRms / baselineRms). For replace
// mode this approaches 0 (zero-fill); for hybrid mode it approaches 1
// (carrier survives the GPU outage).

import { Bridge } from "../../dist/index.js";
import {
  BLOCK_SIZE,
  CAPACITY,
  N_PARTIALS,
  makeSchema,
} from "../../examples/hybrid-residual/schema.js";

const STATUS = document.getElementById("status");
const RUN = document.getElementById("run");
const STOP = document.getElementById("stop");
const RESULTS = document.getElementById("results");

const state = {
  ctx: null,
  node: null,
  worker: null,
  running: false,
  lastDiag: {},
  diagHistory: [],
};

function setStatus(text) {
  STATUS.textContent = text;
}

function isolationOk() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  if (!isolationOk()) {
    throw new Error("page not crossOriginIsolated — set COOP/COEP headers");
  }
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error("SharedArrayBuffer unavailable");
  }
  const schema = makeSchema(BLOCK_SIZE);
  const { sab } = Bridge.allocate(CAPACITY, schema);

  state.worker = new Worker(
    new URL("../../examples/hybrid-residual/worker.js", import.meta.url),
    { type: "module" },
  );
  state.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "diag") {
      state.lastDiag = { ...state.lastDiag, ...m, _src: "worker" };
      state.diagHistory.push({ t: performance.now(), src: "worker", ...m });
    }
  };
  state.worker.postMessage({
    type: "init",
    sab,
    capacity: CAPACITY,
    blockSize: BLOCK_SIZE,
    nPartials: N_PARTIALS,
    carrierFreq: 220,
  });

  state.ctx = new AudioContext({ latencyHint: "interactive" });
  await state.ctx.audioWorklet.addModule(
    new URL("../../examples/hybrid-residual/worklet.js", import.meta.url),
  );
  state.node = new AudioWorkletNode(state.ctx, "hybrid-residual-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sab, capacity: CAPACITY, blockSize: BLOCK_SIZE },
  });
  state.node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "diag") {
      state.lastDiag = { ...state.lastDiag, ...m, _src: "worklet" };
      state.diagHistory.push({ t: performance.now(), src: "worklet", ...m });
    }
  };
  // Output through a -infinity gain so the bench doesn't blast the user
  // — we still need the worklet to actually run, so connect to destination.
  // Spec-wise, AudioWorkletProcessor.process is only called when the node
  // is part of a live graph. Mute via GainNode so the bench is silent.
  const gain = state.ctx.createGain();
  gain.gain.value = 0.0001; // ~ -80 dBFS, basically inaudible
  state.node.connect(gain).connect(state.ctx.destination);
  state.gain = gain;

  // Enable RMS instrumentation; default mode = carrier-only for warm-up.
  state.node.port.postMessage({
    type: "config",
    enableRms: true,
    mode: "carrier-only",
    residualGain: 0.5,
  });
}

function teardown() {
  try { state.node?.disconnect(); } catch {}
  try { state.ctx?.close(); } catch {}
  try { state.worker?.postMessage({ type: "stop" }); } catch {}
  try { state.worker?.terminate(); } catch {}
  state.node = null;
  state.ctx = null;
  state.worker = null;
}

// Wait for the next worklet diag report and capture the RMS² window.
async function captureRmsWindow(windowMs) {
  // Reset the worklet's RMS accumulator, then wait `windowMs` for it to
  // accumulate, then wait for the next diag to capture the snapshot.
  state.node.port.postMessage({ type: "rms-reset" });
  await sleep(windowMs);
  // The worklet reports diag at ~4 Hz (every 250 ms). Wait up to 350 ms
  // for the next one.
  const start = performance.now();
  let captured = null;
  while (performance.now() - start < 400) {
    await sleep(20);
    if (
      state.lastDiag._src === "worklet" &&
      state.lastDiag.rmsSinceReport > 0
    ) {
      captured = {
        sqAccum: state.lastDiag.rmsSqAccum,
        nSamples: state.lastDiag.rmsSinceReport,
      };
      // Drain so we don't re-capture the same one.
      state.lastDiag._src = null;
      break;
    }
  }
  if (!captured) return { rms: NaN, nSamples: 0 };
  return {
    rms: Math.sqrt(captured.sqAccum / captured.nSamples),
    nSamples: captured.nSamples,
  };
}

async function measureMode(mode, label) {
  setStatus(`mode=${label}: settling…`);
  state.node.port.postMessage({ type: "config", mode });
  await sleep(1500);

  setStatus(`mode=${label}: capturing baseline RMS…`);
  const baseline = await captureRmsWindow(500);

  setStatus(`mode=${label}: triggering 250ms GPU stall…`);
  // Reset accumulator just before triggering the stall so the window
  // we measure spans the stall itself.
  state.node.port.postMessage({ type: "rms-reset" });
  state.worker.postMessage({ type: "stall", durationMs: 250 });
  // Stall duration + a little tail for the underflow to start being felt
  // (the consumer's already-pulled frame still has samples, so the
  // perceptible silence-onset lags the producer-side stall by up to one
  // block's worth = ~21 ms; plus the consumer's ring depth = up to 85 ms
  // additional). We want the RMS window to span just the producer stall
  // PLUS that drain — total 300 ms is enough to see the difference
  // without being so long that recovery dominates the average.
  const beforeUnderflow = state.lastDiag.underflowSamples ?? 0;
  await sleep(350);
  const stall = await captureRmsWindow(0); // capture what just accumulated
  const afterUnderflow = state.lastDiag.underflowSamples ?? 0;

  setStatus(`mode=${label}: recovery…`);
  await sleep(400);

  return {
    label,
    baselineRms: baseline.rms,
    stallRms: stall.rms,
    continuityRatio: stall.rms / baseline.rms,
    underflowDelta: afterUnderflow - beforeUnderflow,
  };
}

function renderResults(rows) {
  const fmt = (n, d = 4) => (Number.isFinite(n) ? n.toFixed(d) : "—");
  const fmtPct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "—");
  let html = `
    <table class="results">
      <thead>
        <tr>
          <th>Mode</th>
          <th>Baseline RMS</th>
          <th>Stall-window RMS</th>
          <th>Continuity</th>
          <th>Underflow samples</th>
        </tr>
      </thead>
      <tbody>`;
  for (const r of rows) {
    const winCls = r.continuityRatio > 0.5 ? "win" : "lose";
    html += `
      <tr>
        <td>${r.label}</td>
        <td>${fmt(r.baselineRms)}</td>
        <td>${fmt(r.stallRms)}</td>
        <td class="${winCls}">${fmtPct(r.continuityRatio)}</td>
        <td>${r.underflowDelta.toLocaleString()}</td>
      </tr>`;
  }
  html += `
      </tbody>
    </table>
    <p style="margin-top: 16px; font-size: 13px; color: #c8cdd5;">
      <strong>Continuity</strong> is (stall-window RMS / baseline RMS). In Replace mode
      the consumer's <code>process()</code> overwrites <code>out</code> with the empty
      ring's zero-fill, so RMS collapses to near zero — visible as an audible
      click / silence. In Hybrid mode <code>processAdd</code> leaves <code>out</code>
      untouched on underflow, so the CPU carrier survives and RMS stays at the
      carrier's level. Same underflow-sample count (the ring-empty event is
      identical); different audible consequence.
    </p>
    <p style="font-size: 13px; color: #c8cdd5;">
      Per-quantum hot-path cost from <code>npm run bench</code> (Node 22 dev machine):
      <code>process</code> ≈ 100 ns, <code>processAdd</code> ≈ 300 ns. The 200 ns
      hybrid-mode tax is &lt;0.01% of the 2.67 ms audio-quantum budget.
    </p>`;
  RESULTS.innerHTML = html;
}

async function run() {
  if (state.running) return;
  state.running = true;
  RUN.disabled = true;
  STOP.disabled = false;
  RESULTS.innerHTML = "";
  try {
    setStatus("setup…");
    await setup();
    // Initial settle + producer warm-up.
    await sleep(1500);

    const results = [];
    results.push(await measureMode("replace", "Replace (process)"));
    results.push(await measureMode("hybrid", "Hybrid (processAdd)"));

    setStatus("done.");
    renderResults(results);
  } catch (e) {
    setStatus(`FAILED: ${e.message ?? e}`);
  } finally {
    teardown();
    state.running = false;
    RUN.disabled = false;
    STOP.disabled = true;
  }
}

function stop() {
  if (!state.running) return;
  state.running = false;
  teardown();
  RUN.disabled = false;
  STOP.disabled = true;
  setStatus("stopped.");
}

RUN.addEventListener("click", run);
STOP.addEventListener("click", stop);

setStatus(
  isolationOk()
    ? "ready. press Run to start the benchmark sequence (~6 s)."
    : "page is not crossOriginIsolated — set COOP/COEP and reload.",
);
