// main.js — drives the cross-engine notify-cost bench in the page.
//
// Imports SpscRing directly (exported as of 0.6.10) so the bench can call
// the dev-only `_pullNoNotify` shim. Bridge is NOT involved here — the
// shim lives only on SpscRing and Bridge doesn't delegate to it (see
// CHANGELOG[0.6.11]).
//
// Measurement strategy. performance.now() has 5-1000 μs resolution
// depending on engine; far too coarse for a 100 ns per-call delta. We
// time batches of push+pull pairs (default 1000 per batch ≈ 1.2 ms on
// V8), divide by batchIters, and treat each batch as one sample. Median
// + p99 + p999 + max over `batches` samples is the per-iter figure.
// Push is identical between both paths so it cancels in the delta.

import { SpscRing } from "../../dist/SpscRing.js";
import { physicsControlFrameSchema } from "../../dist/schemas/physics.js";

const REPORT_EL = document.getElementById("report");
const RUN_EL = document.getElementById("run");
const COPY_EL = document.getElementById("copy");
const PROG_EL = document.getElementById("progress");
const ISO_EL = document.getElementById("isoBanner");

if (typeof crossOriginIsolated === "undefined" || !crossOriginIsolated) {
  ISO_EL.textContent =
    "WARNING: page is not crossOriginIsolated. SAB unavailable + " +
    "performance.now() clamped to 1ms — bench will fail or report garbage. " +
    "Serve via `npm run bench:notify-cost` to get the right headers.";
}

function readUI() {
  return {
    n: Math.max(1, Math.min(4096, Number(document.getElementById("n").value) || 1000)),
    capacity: Number(document.getElementById("capacity").value),
    batchIters: Math.max(100, Number(document.getElementById("batchIters").value) || 1000),
    batches: Math.max(100, Number(document.getElementById("batches").value) || 1000),
    warmupBatches: Math.max(10, Number(document.getElementById("warmupBatches").value) || 100),
  };
}

function fmtNs(ns) {
  if (!Number.isFinite(ns)) return "n/a";
  if (Math.abs(ns) < 1000) return `${ns.toFixed(1)} ns`;
  if (Math.abs(ns) < 1_000_000) return `${(ns / 1000).toFixed(2)} μs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
    max: sorted[sorted.length - 1],
    mean: samples.reduce((s, x) => s + x, 0) / samples.length,
  };
}

function makeFrame(n) {
  const vEff = new Float64Array(n);
  const jEff = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    vEff[k] = Math.sin(k * 0.01);
    jEff[k] = Math.cos(k * 0.01);
  }
  return { seq: 0n, tMacroNs: 0n, vMax: 1, jMax: 1, vEff, jEff };
}

function makeOutFrame(n) {
  return {
    seq: 0n,
    tMacroNs: 0n,
    vMax: 0,
    jMax: 0,
    vEff: new Float64Array(n),
    jEff: new Float64Array(n),
  };
}

// Detect the engine — best-effort UA + feature sniff. Bench reports it
// verbatim because the whole point of this harness is the cross-engine
// comparison.
function detectEngine() {
  const ua = navigator.userAgent;
  let engine = "unknown";
  if (/Firefox\//.test(ua)) engine = "Firefox / SpiderMonkey";
  else if (/Edg\//.test(ua)) engine = "Edge / V8";
  else if (/OPR\//.test(ua)) engine = "Opera / V8";
  else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) engine = "Chromium / V8";
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) engine = "Safari / JavaScriptCore";
  return { engine, ua };
}

// One batched-pull benchmark. mode is one of:
//   "notify"      — public ring.pull (fires Atomics.notify always).
//   "noNotify"    — dev-only _pullNoNotify shim (never notifies).
//   "wfClear"     — dev-only _pullWithWaitFlag with lane 4 = 0
//                   (proposed protocol common case; notify skipped).
//   "wfSet"       — dev-only _pullWithWaitFlag with lane 4 = 1
//                   (proposed protocol degenerates to notify+load+branch).
// Identical push path across all four; the delta isolates the trailing
// notify behavior under each protocol variant.
//
// Investigation 3 / 0.6.12-WIP. The wfClear/wfSet variants exist so
// the harness can settle whether the proposed protocol's per-pull
// overhead (Atomics.load(lane 4) + branch) is cheaper than the notify
// it eliminates, with cross-engine precision the Node bench can't
// reach at hrtime's 100 ns resolution.
async function runBench(mode, opts, ring, indices, frame, out, onProgress) {
  const { batchIters, batches, warmupBatches } = opts;
  const hasWaitFlag = typeof ring._pullWithWaitFlag === "function";
  // Warmup. Run all four code paths so V8 / JSC / SpiderMonkey JITs tier
  // up on each before any measurement starts. Without this the first
  // measured path takes a 2-3x penalty from incomplete tier-up.
  for (let b = 0; b < warmupBatches; b++) {
    for (let i = 0; i < batchIters; i++) {
      frame.seq = BigInt(i);
      ring.push(frame);
      ring.pull(out);
    }
    for (let i = 0; i < batchIters; i++) {
      frame.seq = BigInt(i);
      ring.push(frame);
      ring._pullNoNotify(out);
    }
    if (hasWaitFlag) {
      Atomics.store(indices, 4, 0);
      for (let i = 0; i < batchIters; i++) {
        frame.seq = BigInt(i);
        ring.push(frame);
        ring._pullWithWaitFlag(out);
      }
      Atomics.store(indices, 4, 1);
      for (let i = 0; i < batchIters; i++) {
        frame.seq = BigInt(i);
        ring.push(frame);
        ring._pullWithWaitFlag(out);
      }
      Atomics.store(indices, 4, 0);
    }
    if ((b & 31) === 0) await new Promise((r) => setTimeout(r, 0));
  }

  const samples = new Array(batches);
  // Set lane 4 once before the measure phase if needed; the wfClear /
  // wfSet inner loops then run with the flag at the expected value.
  if (mode === "wfClear") Atomics.store(indices, 4, 0);
  else if (mode === "wfSet") Atomics.store(indices, 4, 1);
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    if (mode === "notify") {
      for (let i = 0; i < batchIters; i++) {
        frame.seq = BigInt(i);
        ring.push(frame);
        ring.pull(out);
      }
    } else if (mode === "noNotify") {
      for (let i = 0; i < batchIters; i++) {
        frame.seq = BigInt(i);
        ring.push(frame);
        ring._pullNoNotify(out);
      }
    } else if (mode === "wfClear" || mode === "wfSet") {
      for (let i = 0; i < batchIters; i++) {
        frame.seq = BigInt(i);
        ring.push(frame);
        ring._pullWithWaitFlag(out);
      }
    } else {
      throw new Error(`unknown bench mode: ${mode}`);
    }
    const t1 = performance.now();
    samples[b] = ((t1 - t0) * 1e6) / batchIters; // ns/iter
    if ((b & 63) === 0) {
      onProgress?.(`measuring ${mode}… batch ${b}/${batches}`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (mode === "wfClear" || mode === "wfSet") Atomics.store(indices, 4, 0);
  return summarize(samples);
}

async function run() {
  if (typeof crossOriginIsolated === "undefined" || !crossOriginIsolated) {
    REPORT_EL.textContent = "FAIL: page is not crossOriginIsolated. Aborting.";
    return;
  }
  RUN_EL.disabled = true;
  COPY_EL.disabled = true;
  PROG_EL.textContent = "preparing…";
  await new Promise((r) => setTimeout(r, 0));

  try {
    const opts = readUI();
    const schema = physicsControlFrameSchema(opts.n);
    const { sab } = SpscRing.allocate(opts.capacity, schema);
    const ring = new SpscRing(sab, opts.capacity, schema);
    // Direct Int32 view of the SAB header so the wfClear / wfSet
    // benches can flip lane 4 between the two protocol states.
    const indices = new Int32Array(sab, 0, 8);

    if (typeof ring._pullNoNotify !== "function") {
      REPORT_EL.textContent =
        "FAIL: SpscRing._pullNoNotify not found. The dist/ build is older " +
        "than 0.6.11. Run `npm run build` and reload.";
      return;
    }
    const hasWaitFlag = typeof ring._pullWithWaitFlag === "function";

    const frame = makeFrame(opts.n);
    const out = makeOutFrame(opts.n);

    const { engine, ua } = detectEngine();
    const startTs = new Date().toISOString();

    const notify = await runBench("notify", opts, ring, indices, frame, out, (s) =>
      (PROG_EL.textContent = s),
    );
    const noNotify = await runBench("noNotify", opts, ring, indices, frame, out, (s) =>
      (PROG_EL.textContent = s),
    );
    let wfClear = null;
    let wfSet = null;
    if (hasWaitFlag) {
      wfClear = await runBench("wfClear", opts, ring, indices, frame, out, (s) =>
        (PROG_EL.textContent = s),
      );
      wfSet = await runBench("wfSet", opts, ring, indices, frame, out, (s) =>
        (PROG_EL.textContent = s),
      );
    }

    PROG_EL.textContent = "done.";

    const lines = [];
    lines.push(`webgpu-audio-bridge — cross-engine notify-cost bench`);
    lines.push(``);
    lines.push(`engine     : ${engine}`);
    lines.push(`UA         : ${ua}`);
    lines.push(`platform   : ${navigator.platform}`);
    lines.push(`hwConcurr  : ${navigator.hardwareConcurrency ?? "?"}`);
    lines.push(`isolated   : ${crossOriginIsolated}`);
    lines.push(`timestamp  : ${startTs}`);
    lines.push(``);
    lines.push(
      `schema     : physicsControlFrameSchema(${opts.n})  ` +
        `capacity=${opts.capacity}  frameBytes=${schema.frameByteSize}`,
    );
    lines.push(
      `batches    : ${opts.batches} × ${opts.batchIters} iters  ` +
        `(warmup ${opts.warmupBatches} × ${opts.batchIters})`,
    );
    lines.push(``);

    const fmtRow = (label, s) =>
      `${label.padEnd(20)} median=${fmtNs(s.median).padStart(9)}  ` +
        `p99=${fmtNs(s.p99).padStart(9)}  ` +
        `p999=${fmtNs(s.p999).padStart(9)}  ` +
        `max=${fmtNs(s.max).padStart(9)}  ` +
        `mean=${fmtNs(s.mean).padStart(9)}`;

    lines.push(fmtRow("pull (notify)", notify));
    lines.push(fmtRow("pull (noNotify)", noNotify));
    if (wfClear && wfSet) {
      lines.push(fmtRow("pull (wf clear)", wfClear));
      lines.push(fmtRow("pull (wf set)", wfSet));
    }
    lines.push(``);
    lines.push(
      `notify delta (notify - noNotify)  median=${fmtNs(notify.median - noNotify.median)}  ` +
        `p99=${fmtNs(notify.p99 - noNotify.p99)}  ` +
        `max=${fmtNs(notify.max - noNotify.max)}`,
    );

    if (wfClear && wfSet) {
      lines.push(``);
      lines.push(`Investigation 3 — wait-flag protocol simulation`);
      lines.push(
        `  protocol overhead (wfClear - noNotify)   = ${fmtNs(wfClear.median - noNotify.median)}` +
          `  (cost of lane-4 load + branch on no-waiter path)`,
      );
      lines.push(
        `  protocol savings  (notify - wfClear)     = ${fmtNs(notify.median - wfClear.median)}` +
          `  (notify cost recovered on no-waiter path)`,
      );
      lines.push(
        `  protocol NET      (savings - overhead)   = ${fmtNs((notify.median - wfClear.median) - (wfClear.median - noNotify.median))}` +
          `  (positive = protocol is net positive per pull)`,
      );
      lines.push(
        `  flag-set sanity   (wfSet ≈ notify?)      delta=${fmtNs(wfSet.median - notify.median)}` +
          `  (small delta confirms wfSet degenerates to notify+load)`,
      );
    }

    lines.push(``);
    lines.push(`interpretation:`);
    const delta = notify.median - noNotify.median;
    if (delta < 200) {
      lines.push(
        `  notify delta < 200 ns. ${engine} appears to short-circuit ` +
          `Atomics.notify with zero waiters in user space. The 0.7.0 ` +
          `wait-flag wire-format protocol payoff is small on this engine.`,
      );
    } else if (delta < 1000) {
      lines.push(
        `  200 ns ≤ notify delta < 1 μs. ${engine} has measurable notify ` +
          `overhead but not a full syscall. The wait-flag protocol is a ` +
          `moderate win on this engine.`,
      );
    } else {
      lines.push(
        `  notify delta ≥ 1 μs. ${engine}'s notify path goes to the kernel even ` +
          `with zero waiters — the wait-flag protocol is a clear win on ` +
          `this engine and the 0.7.0 wire-format extension is justified.`,
      );
    }
    if (wfClear) {
      const net = (notify.median - wfClear.median) - (wfClear.median - noNotify.median);
      if (net > 5) {
        lines.push(
          `  wait-flag protocol is net positive by ${fmtNs(net)} per pull on this engine.`,
        );
      } else if (net > -5) {
        lines.push(
          `  wait-flag protocol is at the noise floor (net ${fmtNs(net)}) on this engine — ` +
            `the load + branch overhead is comparable to the notify cost it eliminates.`,
        );
      } else {
        lines.push(
          `  wait-flag protocol is net NEGATIVE by ${fmtNs(-net)} per pull on this engine — ` +
            `the lane-4 load + branch costs more than the notify it skips.`,
        );
      }
    }
    REPORT_EL.textContent = lines.join("\n");
  } catch (err) {
    REPORT_EL.textContent = `ERROR: ${err && err.stack ? err.stack : String(err)}`;
  } finally {
    RUN_EL.disabled = false;
    COPY_EL.disabled = false;
  }
}

RUN_EL.addEventListener("click", run);
COPY_EL.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(REPORT_EL.textContent || "");
    PROG_EL.textContent = "report copied to clipboard.";
  } catch (err) {
    PROG_EL.textContent = `copy failed: ${err}`;
  }
});
