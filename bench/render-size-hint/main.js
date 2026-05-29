// main.js — renderSizeHint bench driver.
//
// Two layers of measurement:
//
//   1. Library API sweep — `measureRenderQuantum(hint)` from the shipped
//      `webgpu-audio-bridge/experimental` subpath, run across a list of hints.
//      Reports ctx.renderQuantumSize / baseLatency / outputLatency and the
//      derived input→audible estimate. This is the API a consumer would use.
//
//   2. Worklet ground-truth — for the smallest honored hint, build a live
//      context, load `worklet.js`, and read the ACTUAL process() block length
//      from inside the audio thread. The main-thread `renderQuantumSize`
//      attribute can in principle disagree with what process() receives;
//      this row settles it.
//
// Everything is gated behind a button (AudioContext needs a user gesture).
// Import from /dist — run `npm run build` first.

import { getEnvironmentReport } from "../../dist/index.js";
import {
  measureRenderQuantum,
  quantumLatencyMs,
  isRenderSizeHintSupported,
} from "../../dist/experimental/index.js";

const HINTS = ["default", 64, 128, 256, 512, "hardware"];

const els = {
  env: document.getElementById("env"),
  run: document.getElementById("run"),
  status: document.getElementById("status"),
  rows: document.getElementById("rows"),
  worklet: document.getElementById("worklet"),
  baseline: document.getElementById("baseline"),
};

function fmt(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (typeof v === "number") return v.toFixed(digits);
  return String(v);
}

function renderEnvironment() {
  const r = getEnvironmentReport();
  const supported = isRenderSizeHintSupported();
  els.env.innerHTML = [
    ["suggestedMode", r.suggestedMode],
    ["renderSizeHint attr", String(r.renderSizeHint), r.renderSizeHint ? "ok" : "warn"],
    ["isRenderSizeHintSupported()", String(supported), supported ? "ok" : "warn"],
    ["secureContext", String(r.secureContext)],
    ["userAgent", r.userAgent || "—"],
  ]
    .map(
      ([k, v, cls]) =>
        `<div class="kv"><span class="k">${k}</span><span class="v ${cls ?? ""}">${v}</span></div>`,
    )
    .join("");
  if (!supported) {
    setStatus(
      "This browser does not expose renderQuantumSize — the hint will be inert. " +
        "Try Chrome with the Web Audio render-size experiment enabled.",
      "warn",
    );
  }
}

function setStatus(msg, cls = "") {
  els.status.className = `status ${cls}`;
  els.status.textContent = msg;
}

function addRow(report) {
  const tr = document.createElement("tr");
  const honoredCls = report.honored ? "ok" : "warn";
  tr.innerHTML = `
    <td>${fmt(report.requested)}</td>
    <td>${fmt(report.renderQuantumSize, 0)}</td>
    <td class="${honoredCls}">${report.honored ? "yes" : "no"}</td>
    <td>${fmt(report.quantumLatencyMs?.averageMs)}</td>
    <td>${fmt(report.baseLatencyMs)}</td>
    <td>${fmt(report.outputLatencyMs)}</td>
    <td><strong>${fmt(report.estimatedInputToAudibleMs)}</strong></td>
    <td class="err">${report.error ?? ""}</td>
  `;
  els.rows.appendChild(tr);
  return report;
}

// ── Worklet ground-truth ────────────────────────────────────────────────────

async function probeWithWorklet(hint) {
  let ctx;
  try {
    ctx = new AudioContext({ latencyHint: "interactive", renderSizeHint: hint });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  try {
    await ctx.resume();
    await ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
    const node = new AudioWorkletNode(ctx, "render-probe", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.connect(ctx.destination);

    const probe = await new Promise((resolve) => {
      const to = setTimeout(() => resolve({ timeout: true }), 3000);
      node.port.onmessage = (e) => {
        if (e.data?.type === "probe") {
          clearTimeout(to);
          resolve(e.data);
        }
      };
    });

    const ctxQuantum = typeof ctx.renderQuantumSize === "number" ? ctx.renderQuantumSize : null;
    node.disconnect();
    return {
      requested: hint,
      ctxQuantum,
      blockLength: probe.blockLength ?? null,
      frameDelta: probe.frameDelta ?? null,
      timeout: !!probe.timeout,
      agree:
        ctxQuantum !== null &&
        probe.blockLength != null &&
        ctxQuantum === probe.blockLength &&
        probe.blockLength === probe.frameDelta,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { await ctx.close(); } catch {}
  }
}

function renderWorkletResult(res) {
  if (res.error) {
    els.worklet.innerHTML = `<span class="err">worklet probe failed: ${res.error}</span>`;
    return;
  }
  if (res.timeout) {
    els.worklet.innerHTML = `<span class="warn">worklet probe timed out (no process() callbacks)</span>`;
    return;
  }
  els.worklet.innerHTML = `
    <div class="kv"><span class="k">requested</span><span class="v">${fmt(res.requested)}</span></div>
    <div class="kv"><span class="k">ctx.renderQuantumSize</span><span class="v">${fmt(res.ctxQuantum, 0)}</span></div>
    <div class="kv"><span class="k">worklet block length</span><span class="v">${fmt(res.blockLength, 0)}</span></div>
    <div class="kv"><span class="k">currentFrame delta</span><span class="v">${fmt(res.frameDelta, 0)}</span></div>
    <div class="kv"><span class="k">attr ↔ runtime agree</span><span class="v ${res.agree ? "ok" : "warn"}">${res.agree ? "yes" : "no"}</span></div>
  `;
}

// ── Sweep ─────────────────────────────────────────────────────────────────

async function runSweep() {
  els.run.disabled = true;
  els.rows.innerHTML = "";
  els.worklet.innerHTML = "";
  els.baseline.textContent = "";
  setStatus("running library sweep…");

  const reports = [];
  for (const hint of HINTS) {
    setStatus(`measuring hint: ${hint}…`);
    // keepOpen: false (default) — each call opens then closes its own context.
    const r = await measureRenderQuantum({ hint });
    reports.push(addRow(r));
  }

  // Baseline comparison: default vs the smallest honored numeric quantum.
  const baseline = reports.find((r) => r.requested === "default") ?? reports[0];
  const honoredNumeric = reports
    .filter((r) => typeof r.requested === "number" && r.honored && r.estimatedInputToAudibleMs != null)
    .sort((a, b) => a.renderQuantumSize - b.renderQuantumSize)[0];

  if (baseline?.estimatedInputToAudibleMs != null && honoredNumeric) {
    const delta = baseline.estimatedInputToAudibleMs - honoredNumeric.estimatedInputToAudibleMs;
    const qDelta =
      quantumLatencyMs(baseline.renderQuantumSize, baseline.sampleRate).averageMs -
      quantumLatencyMs(honoredNumeric.renderQuantumSize, honoredNumeric.sampleRate).averageMs;
    els.baseline.innerHTML =
      `<strong>Gain:</strong> smallest honored quantum = ${honoredNumeric.renderQuantumSize} ` +
      `(vs default ${baseline.renderQuantumSize}). ` +
      `Quantum-boundary latency drops <strong>${qDelta.toFixed(3)} ms</strong>; ` +
      `estimated input→audible drops <strong>${delta.toFixed(3)} ms</strong>.`;
    setStatus("sweep complete — confirming with worklet…");
    renderWorkletResult(await probeWithWorklet(honoredNumeric.requested));
  } else {
    els.baseline.innerHTML =
      `<span class="warn">No numeric hint was honored — the browser is rendering at its default quantum. ` +
      `No gain available on this platform today.</span>`;
    setStatus("sweep complete — confirming default quantum with worklet…");
    renderWorkletResult(await probeWithWorklet("default"));
  }

  setStatus("done. results above are this machine's actual numbers, not estimates from the spec.", "ok");
  els.run.disabled = false;
}

els.run.addEventListener("click", () => {
  runSweep().catch((e) => {
    setStatus(`sweep failed: ${e?.message ?? e}`, "err");
    els.run.disabled = false;
  });
});

renderEnvironment();
