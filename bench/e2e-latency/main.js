// e2e-latency / main.js --- orchestrates the bench page.
//
// Three pieces:
//   - worker.js  : producer, stamps tMacroNs in the frame header at push.
//   - worklet.js : consumer (silence) pulls using one of several modes and
//                  computes latency = consume_wallclock_ns - tMacroNs.
//   - main.js    : wires UI, owns AudioContext + Worker, displays reports.
//
// "End-to-end latency" means: time between producer's performance.now() at push,
// and audio thread's wall-clock at consume() via pull strategy.
// The worklet header carries the alignment math.

import { Bridge } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

const REPORT_EL = document.getElementById("report");
const START_EL = document.getElementById("start");
const STOP_EL = document.getElementById("stop");
const SWEEP_EL = document.getElementById("sweep");
const COPY_EL = document.getElementById("copy");
const NOTIFY_MODE_EL = document.getElementById("notifyMode");
const PRODUCER_PUSH_MODE_EL = document.getElementById("producerPushMode");
const PRODUCER_TICK_HZ_EL = document.getElementById("producerTickHz");
const SWEEP_MS_EL = document.getElementById("sweepMs");
const SWEEP_ROUNDS_EL = document.getElementById("sweepRounds");
const SWEEP_WARMUP_MS_EL = document.getElementById("sweepWarmupMs");
const SWEEP_MIN_SAMPLES_EL = document.getElementById("sweepMinSamples");
const SWEEP_RANDOMIZE_EL = document.getElementById("sweepRandomize");
const COPY_SWEEP_EL = document.getElementById("copySweep");
const SWEEP_MODES_EL = document.getElementById("sweepModes");
const SWEEP_N_VALUES_EL = document.getElementById("sweepNValues");
const SWEEP_CAPACITIES_EL = document.getElementById("sweepCapacities");
const SWEEP_BACKENDS_EL = document.getElementById("sweepBackends");
const SWEEP_LOADS_EL = document.getElementById("sweepLoads");
const SWEEP_NOTIFY_MODES_EL = document.getElementById("sweepNotifyModes");
const SWEEP_PRODUCER_PUSH_MODES_EL = document.getElementById("sweepProducerPushModes");
const SWEEP_TICK_HZ_EL = document.getElementById("sweepProducerTickHz");

const SWEEP_IMPLS = [
  { value: "rawPullLatest", label: "raw pullLatest (notify)" },
  { value: "rawPullLatestNoNotify", label: "raw pullLatest (no notify)" },
  { value: "rawPull", label: "raw pull (FIFO)" },
  { value: "bridgePullLatestNoNotify", label: "Bridge.pullLatest (no notify)" },
  { value: "bridgePullLatest", label: "Bridge.pullLatest" },
  { value: "bridgePull", label: "Bridge.pull" },
];

let state = null;
let sweepState = null;
let lastSweepResults = null;
let lastReport = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readUI() {
  const capacityValue = Number.parseInt(document.getElementById("capacity").value, 10) || 16;
  return {
    backend: document.getElementById("backend").value,
    n: Math.max(1, Math.min(4096, Number(document.getElementById("n").value) || 1000)),
    capacity: Math.max(1, capacityValue),
    load: document.getElementById("load").value,
    notifyMode: document.getElementById("notifyMode").value || "always",
    producerPushMode: document.getElementById("producerPushMode").value || "push",
    producerTickHz: Number.parseInt(document.getElementById("producerTickHz").value, 10) || 60,
    consumerMode: document.getElementById("consumerMode").value || "rawPullLatest",
  };
}

function parseIntInput(el, fallback, min, max) {
  const parsed = Number.parseInt(el.value, 10);
  if (Number.isNaN(parsed)) return fallback;
  if (min !== undefined) return Math.max(min, Math.min(parsed, max ?? parsed));
  return parsed;
}

function parseCSVValues(el, fallback) {
  if (!el || !(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLTextAreaElement)) {
    return [...fallback];
  }
  const raw = String(el.value || "").trim();
  if (!raw) return [...fallback];
  return raw
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseIntList(el, fallback, min, max) {
  const raw = Array.isArray(el)
    ? el.map((value) => String(value))
    : typeof el === "string"
      ? el.split(/[\s,;]+/).map((v) => v.trim()).filter((v) => v.length > 0)
      : parseCSVValues(el, fallback.map((v) => String(v)));
  const parsed = [];
  for (const token of raw) {
    const n = Number.parseInt(token, 10);
    if (Number.isNaN(n)) continue;
    const clamped = (min !== undefined || max !== undefined)
      ? Math.max(min ?? n, Math.min(n, max ?? n))
      : n;
    if (Number.isFinite(clamped)) parsed.push(clamped);
  }
  return parsed.length ? parsed : [...fallback];
}

function parseModeList(rawModes, fallbackValues) {
  const values = typeof rawModes === "string"
    ? rawModes.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean)
    : Array.isArray(rawModes)
      ? rawModes
      : [];
  if (!values.length) return [...fallbackValues];
  const modes = [];
  for (const m of values) {
    const token = typeof m === "object" && m && "value" in m
      ? String(m.value).trim()
      : String(m).trim();
    if (!token) continue;
    if (!modes.includes(token)) modes.push(token);
  }
  return modes.length ? modes : fallbackValues.map((item) => item.value ?? item);
}

function splitSweepConfig(rawConfig) {
  const {
    modes,
    nValues,
    capacities,
    backends,
    loads,
    notifyModes,
    producerPushModes,
    producerTickHz,
    durationMs,
    warmupMs,
    minSamples,
    randomize,
    rounds,
    ...runtime
  } = rawConfig;
  return { durationMs, warmupMs, minSamples, randomize, rounds, runtime };
}

function labelForRun(components) {
  const safe = {
    backend: components.backend || "auto",
    load: components.load || "idle",
    notifyMode: components.notifyMode || "always",
    producerPushMode: components.producerPushMode || "push",
    producerTickHz: components.producerTickHz || 60,
    n: components.n ?? "-",
    capacity: components.capacity ?? "-",
    mode: components.mode || "rawPullLatest",
  };
  return `${safe.backend}/${safe.load}/notify:${safe.notifyMode}/push:${safe.producerPushMode}/${safe.producerTickHz}Hz/n${safe.n}/cap${safe.capacity}/${safe.mode}`;
}

function readSweep() {
  const durationMs = parseIntInput(SWEEP_MS_EL, 5000, 500, 30000);
  const rounds = parseIntInput(SWEEP_ROUNDS_EL, 1, 1, 10);
  const warmupMs = parseIntInput(SWEEP_WARMUP_MS_EL, 500, 0, 10000);
  const minSamples = parseIntInput(SWEEP_MIN_SAMPLES_EL, 40, 1, 10_000);
  const randomize = !!(SWEEP_RANDOMIZE_EL && SWEEP_RANDOMIZE_EL.checked);
  const defaults = readUI();
  const modes = parseModeList(parseCSVValues(SWEEP_MODES_EL, [defaults.consumerMode]), SWEEP_IMPLS);
  const nValues = parseIntList(SWEEP_N_VALUES_EL, [defaults.n], 1, 4096);
  const capacities = parseIntList(SWEEP_CAPACITIES_EL, [defaults.capacity], 1, 8192);
  const backends = parseCSVValues(SWEEP_BACKENDS_EL, [defaults.backend]).map((token) => token.trim()).filter((token) => token);
  const loads = parseCSVValues(SWEEP_LOADS_EL, [defaults.load]).map((token) => token.trim()).filter((token) => token);
  const notifyModes = parseCSVValues(SWEEP_NOTIFY_MODES_EL, [defaults.notifyMode]).map((token) => token.trim()).filter((token) => token);
  const producerPushModes = parseCSVValues(SWEEP_PRODUCER_PUSH_MODES_EL, [defaults.producerPushMode]).map((token) => token.trim()).filter((token) => token);
  const producerTickHz = parseIntList(SWEEP_TICK_HZ_EL, [defaults.producerTickHz], 1, 2000);
  return {
    durationMs,
    rounds,
    warmupMs,
    minSamples,
    randomize,
    modes,
    nValues,
    capacities,
    backends,
    loads,
    notifyModes,
    producerPushModes,
    producerTickHz,
  };
}

function clampMs(v) { return Math.max(100, Math.min(60_000, Number(v) || 0)); }

async function waitForReport(timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (!lastReport && performance.now() < deadline) {
    await sleep(16);
  }
  return !!lastReport;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

async function start(override = null) {
  if (state) return;
  const opts = { ...readUI(), ...(override ?? {}) };
  if (typeof crossOriginIsolated === "undefined" || !crossOriginIsolated) {
    REPORT_EL.textContent = "FAIL: page is not crossOriginIsolated. Serve with COOP/COEP.";
    return;
  }

  lastReport = null;
  const schema = makeSchema(opts.n);
  const notifyMode = opts.notifyMode === "waiter-flag" ? "waiter-flag" : "always";
  const { sab } = Bridge.allocate(opts.capacity, schema, { notify: notifyMode });
  // Build the ring on main just to extract the layout description we pass to
  // the worklet. The worker creates its own Bridge instance over the same SAB.
  const layout = new Bridge(sab, opts.capacity, schema, { notify: notifyMode }).describeLayout();
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.postMessage({ type: "init", sab, ...opts });
  let workerBackend = "starting";
  worker.onmessage = (e) => {
    if (e.data.type === "ready") {
      workerBackend = e.data.backend;
      REPORT_EL.textContent = `worker ready: backend=${e.data.backend}\nwaiting for first samples...`;
    } else if (e.data.type === "fatal") {
      REPORT_EL.textContent = `worker fatal: ${e.data.message}`;
      stop();
    }
  };

  // Clock alignment. Each context (main, worker, AudioWorklet) has its own
  // performance.timeOrigin, so raw performance.now() values aren't comparable.
  // We use absolute Unix-epoch ms (timeOrigin + now()).
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const audioStartPerfMs = performance.timeOrigin + performance.now();
  // Output buffer latency on this device. Chrome reports it for interactive
  // contexts; safe to read once and surface as context around signed
  // measurement bias.
  const outputLatencyMs = (ctx.outputLatency ?? 0) * 1000;
  const baseLatencyMs = (ctx.baseLatency ?? 0) * 1000;
  await ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  const node = new AudioWorkletNode(ctx, "bridge-latency-consumer", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      sab,
      capacity: opts.capacity,
      n: opts.n,
      audioStartPerfMs,
      mode: opts.consumerMode,
      layout,
    },
  });
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  node.connect(silentGain).connect(ctx.destination);
  node.port.onmessage = (e) => {
    if (e.data.type === "report") {
      // Worklet doesn't know which backend the worker is running, or output
      // buffer latency; we add those here.
      lastReport = {
        ...e.data,
        backend: workerBackend,
        outputLatencyMs,
        baseLatencyMs,
      };
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
  SWEEP_EL.disabled = true;
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
  if (!sweepState || !sweepState.active) {
    START_EL.disabled = false;
    SWEEP_EL.disabled = false;
    STOP_EL.disabled = true;
  }
}

function fmt(ns) {
  if (ns == null || !isFinite(ns)) return "-";
  const sign = ns < 0 ? "-" : "";
  const abs = Math.abs(ns);
  if (abs < 1000) return `${sign}${abs.toFixed(0)} ns`;
  if (abs < 1_000_000) return `${sign}${(abs / 1000).toFixed(2)} us`;
  return `${sign}${(abs / 1_000_000).toFixed(2)} ms`;
}

function renderReport() {
  const r = lastReport;
  if (!r) {
    REPORT_EL.textContent = "(waiting...)";
    return;
  }
  REPORT_EL.textContent =
`backend         : ${r.backend}
consumer mode   : ${r.mode ?? r.consumerMode ?? "rawPullLatest"}
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
last signed     : ${fmt(r.lastSignedNs)}   (negative approx output buffer bias)
outputLatency   : ${r.outputLatencyMs?.toFixed(2)} ms
baseLatency     : ${r.baseLatencyMs?.toFixed(2)} ms`;
}

function renderSweepSummary() {
  if (!sweepState) return;
  const rows = [];
  const summarizeByMetric = (metric, label) => {
    const byImpl = new Map();
    for (const run of sweepState.results) {
      if (run.invalid) continue;
      const value = Number(run[metric]);
      if (!Number.isFinite(value)) continue;
      const key = run.label ?? run.consumerMode;
      const bucket = byImpl.get(key);
      if (!bucket) byImpl.set(key, { sum: value, count: 1 });
      else {
        bucket.sum += value;
        bucket.count += 1;
      }
    }
    if (!byImpl.size) return `best by mean ${label || metric}: n/a`;
    const best = [...byImpl.entries()]
      .map(([label, v]) => ({ label, mean: v.sum / v.count }))
      .sort((a, b) => a.mean - b.mean);
    return `best by mean ${label || metric}: ${best[0].label} (${fmt(best[0].mean)})`;
  };
  if (!sweepState.results.length) {
    rows.push("No runs completed.");
  } else {
    rows.push("recursive implementation sweep (completed runs)");
    rows.push(
      `duration=${clampMs(sweepState.durationMs)}ms ` +
      `warmup=${clampMs(sweepState.warmupMs)}ms ` +
      `minSamples=${sweepState.minSamples} ` +
      `randomize=${sweepState.randomize ? "yes" : "no"}`,
    );
    const invalid = sweepState.results.filter((run) => run.invalid).length;
    for (const run of sweepState.results) {
      const status = run.invalid ? "invalid" : "valid";
      rows.push(
        `round ${run.round} / ${run.label ?? run.consumerMode} : ` +
        `p50=${fmt(run.medianNs)} p99=${fmt(run.p99Ns)} ` +
        `spread=${fmt(run.spreadNs)} samples=${run.samples} misses=${run.workletMisses}` +
        ` status=${status}` +
        `${run.invalidReason ? ` (${run.invalidReason})` : ""}`,
      );
    }
    if (invalid > 0) rows.push(`invalid runs (below min samples): ${invalid}`);
  }
  rows.push("");
  rows.push(summarizeByMetric("p99Ns", "p99"));
  rows.push(summarizeByMetric("spreadNs", "spread"));
  rows.push(summarizeByMetric("meanSkipped", "meanSkipped"));
  if (sweepState.abort) rows.push("");
  rows.push(`status: ${sweepState.active ? "running" : "done"}`);
  rows.push(`completed: ${sweepState.results.length} / ${sweepState.expectedRuns}`);
  REPORT_EL.textContent = rows.join("\n");
}

async function runOnceWithMode(consumerMode, extraConfig, extraLabel, round) {
  const cfg = { ...readSweep(), ...extraConfig };
  const {
    durationMs,
    warmupMs,
    minSamples,
    runtime,
  } = splitSweepConfig(cfg);
  const base = readUI();
  const label = extraLabel || consumerMode;
  const startConfig = {
    backend: runtime.backend ?? base.backend,
    load: runtime.load ?? base.load,
    n: Number(runtime.n ?? base.n),
    capacity: Number(runtime.capacity ?? base.capacity),
    notifyMode: runtime.notifyMode ?? base.notifyMode,
    producerPushMode: runtime.producerPushMode ?? base.producerPushMode,
    producerTickHz: Number.isFinite(Number(runtime.producerTickHz))
      ? Number(runtime.producerTickHz)
      : base.producerTickHz,
  };
  await start({ ...base, ...startConfig, consumerMode });
  if (!state) return null;

  const ready = await waitForReport(2500);
  if (!ready) {
    stop();
    return null;
  }
  REPORT_EL.textContent = `sweep running: ${label} (round ${round})`;
  if (state?.node?.port) {
    state.node.port.postMessage({ type: "command", command: "reset" });
  }
  if (warmupMs > 0) {
    await sleep(clampMs(warmupMs));
  }
  await sleep(clampMs(durationMs));
  if (!state) return null;
  const runConfig = { ...runtime, ...startConfig };
  const baseSummary = {
    round,
    label,
    consumerMode,
    mode: consumerMode,
    durationMs: clampMs(durationMs),
    warmupMs: clampMs(warmupMs),
    minSamples,
    backend: startConfig.backend,
    load: startConfig.load,
    notifyMode: startConfig.notifyMode,
    producerPushMode: startConfig.producerPushMode,
    producerTickHz: startConfig.producerTickHz,
    n: startConfig.n,
    capacity: startConfig.capacity,
    runConfig,
  };
  const snap = lastReport
    ? {
        ...baseSummary,
        ...lastReport,
        consumerMode,
        mode: lastReport.mode ?? consumerMode,
      }
    : {
        ...baseSummary,
        samples: 0,
        samplesDelta: 0,
        p50Ns: Number.NaN,
        p95Ns: Number.NaN,
        p99Ns: Number.NaN,
        maxNs: Number.NaN,
        pushRejects: 0,
        workletQuanta: 0,
        workletMisses: 0,
        underrunEvents: 0,
        maxMissStreak: 0,
        missRate: 0,
        meanSkipped: 0,
        pulls: 0,
        invalid: true,
        invalidReason: "no report received",
        spreadNs: Number.NaN,
      };

  snap.mode = snap.mode ?? consumerMode;
  snap.spreadNs = Number.isFinite(snap.p99Ns) && Number.isFinite(snap.p50Ns)
    ? snap.p99Ns - snap.p50Ns
    : Number.NaN;
  if (!Number.isFinite(snap.samples)) snap.samples = 0;
  snap.invalid = !Number.isFinite(snap.samples) || snap.samples < minSamples;
  if (snap.invalid && !snap.invalidReason) {
    snap.invalidReason = `samples ${snap.samples} < minSamples ${minSamples}`;
  }

  stop();
  return snap;
}

async function runRecursiveSweep(override = null) {
  if (state || (sweepState && sweepState.active)) return;
  if (typeof crossOriginIsolated === "undefined" || !crossOriginIsolated) {
    REPORT_EL.textContent = "FAIL: page is not crossOriginIsolated. Serve with COOP/COEP.";
    lastSweepResults = null;
    return;
  }
  const config = { ...readSweep(), ...(override || {}) };
  const {
    durationMs,
    warmupMs,
    minSamples,
    randomize,
    rounds,
    notifyModes,
    producerPushModes,
    producerTickHz,
    runtime,
  } = splitSweepConfig(config);
  const base = readUI();
  const modes = parseModeList(config.modes, SWEEP_IMPLS.map((item) => item.value));
  const nValues = Array.isArray(config.nValues)
    ? parseIntList(config.nValues, [base.n], 1, 4096)
    : parseIntList(SWEEP_N_VALUES_EL, [base.n], 1, 4096);
  const capacities = Array.isArray(config.capacities)
    ? parseIntList(config.capacities, [base.capacity], 1, 8192)
    : parseIntList(SWEEP_CAPACITIES_EL, [base.capacity], 1, 8192);
  const backends = Array.isArray(config.backends) && config.backends.length > 0
    ? config.backends.map((value) => String(value))
    : [base.backend];
  const loads = Array.isArray(config.loads) && config.loads.length > 0
    ? config.loads.map((value) => String(value))
    : [base.load];
  const notifyModeValues = Array.isArray(config.notifyModes) && config.notifyModes.length > 0
    ? config.notifyModes.map((value) => String(value))
    : [base.notifyMode];
  const producerPushModeValues = Array.isArray(config.producerPushModes) && config.producerPushModes.length > 0
    ? config.producerPushModes.map((value) => String(value))
    : [base.producerPushMode];
  const producerTickHzValues = Array.isArray(config.producerTickHz) && config.producerTickHz.length > 0
    ? config.producerTickHz.map((value) => Number(value))
    : [base.producerTickHz];

  const axes = [
    { key: "backend", values: [...new Set(backends)] },
    { key: "load", values: [...new Set(loads)] },
    { key: "notifyMode", values: [...new Set(notifyModeValues)] },
    { key: "producerPushMode", values: [...new Set(producerPushModeValues)] },
    { key: "producerTickHz", values: [...new Set(producerTickHzValues)] },
    { key: "n", values: [...new Set(nValues)] },
    { key: "capacity", values: [...new Set(capacities)] },
    { key: "mode", values: [...new Set(modes)] },
  ];

  const implCount = axes.reduce((acc, axis) => acc * axis.values.length, 1);
  const results = [];
  lastSweepResults = [];
  const seenRunSignatures = new Set();
  sweepState = {
    active: true,
    abort: false,
    expectedRuns: implCount * rounds,
      completed: 0,
      results,
      durationMs,
      rounds,
    warmupMs,
    minSamples,
    randomize: config.randomize,
  };
  START_EL.disabled = true;
  SWEEP_EL.disabled = true;
  STOP_EL.disabled = false;
  if (window && !window.__benchRunTrace) {
    window.__benchRunTrace = [];
  } else if (window) {
    window.__benchRunTrace.length = 0;
  }
  try {
    const runOne = async (axisIndex, current, round) => {
      if (!sweepState || !sweepState.active || sweepState.abort) return;
      if (axisIndex >= axes.length) {
        const configState = current || {};
        const { mode, backend, load, n, capacity, notifyMode, producerPushMode, producerTickHz } = configState;
        const activeMode = String(mode);
        const startConfig = {
          backend: backend || base.backend,
          load: load || base.load,
          n: Number(n ?? base.n),
          capacity: Number(capacity ?? base.capacity),
          notifyMode: notifyMode || base.notifyMode,
          producerPushMode: producerPushMode || base.producerPushMode,
          producerTickHz: Number.isFinite(Number(producerTickHz))
            ? Number(producerTickHz)
            : base.producerTickHz,
        };
        const label = labelForRun({
          backend: startConfig.backend,
          load: startConfig.load,
          notifyMode: startConfig.notifyMode,
          producerPushMode: startConfig.producerPushMode,
          producerTickHz: startConfig.producerTickHz,
          n: startConfig.n,
          capacity: startConfig.capacity,
          mode: activeMode,
        });
        const report = await runOnceWithMode(
          activeMode,
          { durationMs, warmupMs, minSamples, ...runtime, ...startConfig },
          label,
          round,
        );
        if (!sweepState || !sweepState.active || sweepState.abort) return;
        if (report) {
          const summarized = {
            ...report,
            label,
            consumerMode: activeMode,
            backend: startConfig.backend,
            load: startConfig.load,
            n: startConfig.n,
            capacity: startConfig.capacity,
            round,
            durationMs,
            runConfig: { ...runtime, ...startConfig },
          };
          if (configState.modeIndex != null) summarized.modeIndex = configState.modeIndex;
          if (configState.roundLabel != null) summarized.roundLabel = configState.roundLabel;
          const signature = [
            round,
            startConfig.backend,
            startConfig.load,
            startConfig.notifyMode,
            startConfig.producerPushMode,
            startConfig.producerTickHz,
            startConfig.n,
            startConfig.capacity,
            activeMode,
          ].join("|");
          window.__benchRunTrace.push(signature);
          if (seenRunSignatures.has(signature)) {
            return;
          }
          seenRunSignatures.add(signature);
          summarized.roundConfig = {
            ...runtime,
            durationMs,
            warmupMs,
            minSamples,
            rounds,
            randomize,
            backend: startConfig.backend,
            load: startConfig.load,
            notifyMode: startConfig.notifyMode,
            producerPushMode: startConfig.producerPushMode,
            producerTickHz: startConfig.producerTickHz,
            n: startConfig.n,
            capacity: startConfig.capacity,
            modes,
            nValues,
            capacities,
            backends,
            loads,
            notifyModes,
            producerPushModes,
            producerTickHz,
          };
          results.push(summarized);
          sweepState.completed += 1;
        }
        if (!sweepState.abort) renderSweepSummary();
        await sleep(150);
        return;
      }
      const axis = axes[axisIndex];
      const values = randomize ? [...axis.values] : axis.values;
      if (randomize) shuffleInPlace(values);
      const key = axis.key;
      for (let i = 0; i < values.length; i++) {
        if (!sweepState.active || sweepState.abort) break;
        const value = values[i];
        const next = { ...current, [key]: value };
        if (key === "mode") next.modeIndex = i;
        await runOne(axisIndex + 1, next, round);
      }
    }
    for (let round = 1; round <= rounds; round++) {
      const roundState = { ...runtime, roundLabel: String(round) };
      await runOne(0, roundState, round);
    }
  } finally {
    if (state) stop();
    if (sweepState) sweepState.active = false;
    START_EL.disabled = false;
    SWEEP_EL.disabled = false;
    STOP_EL.disabled = true;
    renderSweepSummary();
    sweepState = null;
  }
  lastSweepResults = results;
  return results;
}

COPY_EL.addEventListener("click", () => {
  navigator.clipboard?.writeText(REPORT_EL.textContent ?? "").catch(() => {});
});
COPY_SWEEP_EL.addEventListener("click", () => {
  const payload = lastSweepResults ?? [];
  const body = payload.length ? JSON.stringify(payload, null, 2) : "";
  navigator.clipboard?.writeText(body).catch(() => {});
});
START_EL.addEventListener("click", () => {
  if (sweepState?.active) {
    REPORT_EL.textContent = "sweep is active; stop it first.";
    return;
  }
  start().then(() => {}).catch((e) => {
    REPORT_EL.textContent = `start failed: ${e.message ?? e}`;
    stop();
  });
});
STOP_EL.addEventListener("click", () => {
  if (sweepState) sweepState.abort = true;
  stop();
});
SWEEP_EL.addEventListener("click", () => {
  runRecursiveSweep().catch((e) => {
    REPORT_EL.textContent = `sweep failed: ${e.message ?? e}`;
    if (sweepState && sweepState.active) sweepState.active = false;
    if (state) stop();
  });
});

window.__bench = {
  getReport: () => lastReport,
  start: () => start(),
  stop: () => stop(),
  runSweep: (opts) => runRecursiveSweep(opts),
  setConsumerMode: (mode) => {
    const el = document.getElementById("consumerMode");
    if (el) el.value = mode;
  },
  runModes: SWEEP_IMPLS,
  readSweepConfig: () => readSweep(),
  stopSweep: () => {
    if (sweepState) sweepState.abort = true;
    stop();
  },
  getSweepReport: () => lastSweepResults,
};



