// e2e-latency / main.js — orchestrates the bench page.
//
// Three pieces:
//   - worker.js  : producer, stamps tMacroNs in the frame header at push.
//   - worklet.js : consumer (silent), reads tMacroNs and computes latency =
//                  consume_wallclock_ns - tMacroNs. Bins into a histogram
//                  and reports a percentile summary to main every ~250ms.
//   - main.js    : this file. Wires UI, owns AudioContext + Worker, displays.
//
// "End-to-end latency" here means: time between producer's performance.now() at
// push, and audio thread's wall-clock at the process() that consumes the frame
// via pullLatest. Aligned via audioStartPerfMs captured at AudioContext creation;
// the worklet header carries the alignment math.

import { Bridge } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

const REPORT_EL = document.getElementById("report");
const START_EL = document.getElementById("start");
const STOP_EL = document.getElementById("stop");
const COPY_EL = document.getElementById("copy");

let state = null;
let lastReport = null;

function readUI() {
  return {
    backend: document.getElementById("backend").value,
    n: Math.max(1, Math.min(4096, Number(document.getElementById("n").value) || 1000)),
    capacity: Number(document.getElementById("capacity").value),
    load: document.getElementById("load").value,
  };
}

async function start() {
  if (state) return;
  const opts = readUI();
  if (typeof crossOriginIsolated === "undefined" || !crossOriginIsolated) {
    REPORT_EL.textContent = "FAIL: page is not crossOriginIsolated. Serve with COOP/COEP.";
    return;
  }

  const schema = makeSchema(opts.n);
  const { sab } = Bridge.allocate(opts.capacity, schema);
  // Build the ring on main just to extract the layout description we pass to
  // the worklet. The worker creates its own Bridge instance over the same SAB.
  const layout = new Bridge(sab, opts.capacity, schema).describeLayout();
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.postMessage({ type: "init", sab, ...opts });
  let workerBackend = "starting";
  worker.onmessage = (e) => {
    if (e.data.type === "ready") {
      workerBackend = e.data.backend;
      REPORT_EL.textContent = `worker ready: backend=${e.data.backend}\nwaiting for first samples…`;
    } else if (e.data.type === "fatal") {
      REPORT_EL.textContent = `worker fatal: ${e.data.message}`;
      stop();
    }
  };

  // Clock alignment. Each context (main, worker, AudioWorklet) has its own
  // performance.timeOrigin, so raw performance.now() values aren't comparable
  // across them. We work in absolute Unix-epoch ms (timeOrigin + now()): the
  // worker stamps tMacroNs in this space, and we capture audioStartPerfMs in
  // this space immediately after `new AudioContext(...)` returns. The worklet
  // converts via
  //   nowEpochNs = audioStartPerfMs * 1e6 + currentTime * 1e9
  //   latencyNs  = nowEpochNs - tMacroNs
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const audioStartPerfMs = performance.timeOrigin + performance.now();
  // Output buffer latency on this device. Chrome reports it for interactive
  // contexts; safe to read once. Surfaces in the report as context for the
  // |signedNs| bias that the worklet's currentTime carries.
  const outputLatencyMs = (ctx.outputLatency ?? 0) * 1000;
  const baseLatencyMs = (ctx.baseLatency ?? 0) * 1000;
  await ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  const node = new AudioWorkletNode(ctx, "bridge-latency-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sab, capacity: opts.capacity, n: opts.n, audioStartPerfMs, layout },
  });
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  node.connect(silentGain).connect(ctx.destination);
  node.port.onmessage = (e) => {
    if (e.data.type === "report") {
      // Worklet doesn't know which backend the worker is running, or the
      // output buffer latency; merge those in.
      lastReport = { ...e.data, backend: workerBackend, outputLatencyMs, baseLatencyMs };
      renderReport();
    }
  };

  // Optional main-thread load.
  let loadHandle = null;
  if (opts.load === "main") {
    loadHandle = setInterval(() => {
      const t0 = performance.now();
      while (performance.now() - t0 < 4) {
        document.body.style.width = (700 + (Math.random() * 4) | 0) + "px";
        void document.body.offsetHeight;
      }
    }, 16);
  }

  state = { worker, ctx, node, silentGain, loadHandle, opts };
  START_EL.disabled = true;
  STOP_EL.disabled = false;
}

function stop() {
  if (!state) return;
  if (state.loadHandle) clearInterval(state.loadHandle);
  try { state.node.disconnect(); } catch {}
  try { state.silentGain.disconnect(); } catch {}
  try { state.ctx.close(); } catch {}
  try { state.worker.postMessage({ type: "stop" }); } catch {}
  try { state.worker.terminate(); } catch {}
  document.body.style.width = "";
  state = null;
  START_EL.disabled = false;
  STOP_EL.disabled = true;
}

function fmt(ns) {
  if (ns == null || !isFinite(ns)) return "—";
  const sign = ns < 0 ? "-" : "";
  const abs = Math.abs(ns);
  if (abs < 1000) return `${sign}${abs.toFixed(0)} ns`;
  if (abs < 1_000_000) return `${sign}${(abs / 1000).toFixed(2)} µs`;
  return `${sign}${(abs / 1_000_000).toFixed(2)} ms`;
}

function renderReport() {
  const r = lastReport;
  if (!r) { REPORT_EL.textContent = "(waiting…)"; return; }
  REPORT_EL.textContent =
`backend         : ${r.backend}
n / capacity    : ${r.n} / ${r.capacity}
worklet quanta  : ${r.workletQuanta}
samples         : ${r.samples}      (since last report: ${r.samplesDelta})
median |latency|: ${fmt(r.medianNs)}
p50             : ${fmt(r.p50Ns)}
p95             : ${fmt(r.p95Ns)}
p99             : ${fmt(r.p99Ns)}
max             : ${fmt(r.maxNs)}
push rejects    : ${r.pushRejects}
worklet pulls   : ${r.pulls}
worklet misses  : ${r.workletMisses}
underrun events : ${r.underrunEvents}
max miss streak : ${r.maxMissStreak}
miss rate       : ${(r.missRate * 100).toFixed(2)}%
mean skipped    : ${r.meanSkipped.toFixed(2)}
last signed     : ${fmt(r.lastSignedNs)}   (negative ≈ output buffer bias)
outputLatency   : ${r.outputLatencyMs?.toFixed(2)} ms
baseLatency     : ${r.baseLatencyMs?.toFixed(2)} ms`;
}

COPY_EL.addEventListener("click", () => {
  navigator.clipboard?.writeText(REPORT_EL.textContent ?? "").catch(() => {});
});
START_EL.addEventListener("click", () => start().catch((e) => {
  REPORT_EL.textContent = `start failed: ${e.message ?? e}`;
  stop();
}));
STOP_EL.addEventListener("click", stop);

window.__bench = {
  getReport: () => lastReport,
  start: () => start(),
  stop: () => stop(),
};
