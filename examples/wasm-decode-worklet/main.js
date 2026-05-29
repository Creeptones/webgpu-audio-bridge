// main.js — wires the producer worker, the shared WASM memory, and the
// WASM-decode AudioWorklet, with the fallback ladder decided on the main thread.
//
//   hasWasmConsumerSupport()  → mode "wasm"  (peek → decodeFrame → commit)
//   else                      → mode "js"    (inline umbrella pullLatest)
//
// A "force JS fallback" checkbox lets you hear/measure both paths on a
// WASM-capable browser. The HUD shows the live decode µs the worklet reports.

import { Bridge, describeSchemaLayout } from "../../dist/index.js";
import {
  allocateWorkletMemory, buildFrameDescriptors, hasWasmConsumerSupport,
} from "../../dist/worklet/index.js";
import { makeSchema, N, CAPACITY } from "./schema.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status"), hudEl = $("hud");
const startBtn = $("start"), forceJs = $("forceJs"), freqSlider = $("freq");

const state = { ctx: null, node: null, worker: null, running: false };

function setStatus(s, cls = "") { statusEl.innerHTML = `<span class="${cls}">${s}</span>`; }

async function start() {
  if (state.running) return;
  if (typeof crossOriginIsolated === "undefined" || !crossOriginIsolated) {
    setStatus("FAILED — not crossOriginIsolated (serve with COOP/COEP)", "err"); return;
  }
  if (typeof SharedArrayBuffer === "undefined") { setStatus("FAILED — no SharedArrayBuffer", "err"); return; }
  startBtn.disabled = true;

  const schema = makeSchema();
  const layout = describeSchemaLayout(schema);
  const wasmOk = hasWasmConsumerSupport() && !forceJs.checked;
  const mode = wasmOk ? "wasm" : "js";

  // One shared memory: SAB ring + (wasm mode) descriptor table + decoded scratch.
  const sabBytes = Bridge.byteLength(CAPACITY, schema);
  let alloc, descPtr = 0, descCount = 0, decodedFields = null, wasmBytes = null;
  if (mode === "wasm") {
    const probe = buildFrameDescriptors(layout, 0);
    const descBytes = probe.descCount * 12;
    alloc = allocateWorkletMemory({ sabBytes, scratchBytes: descBytes + probe.totalDstBytes + 64 });
    descPtr = alloc.scratchByteOffset;
    const decodedBase = (descPtr + descBytes + 7) & ~7;
    const plan = buildFrameDescriptors(layout, decodedBase);
    new Int32Array(alloc.sab, descPtr, plan.words.length).set(plan.words);
    descCount = plan.descCount; decodedFields = plan.fields;
    wasmBytes = await (await fetch("/dist/worklet/decoder.wasm")).arrayBuffer();
  } else {
    alloc = allocateWorkletMemory(sabBytes);
  }

  // Producer.
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.postMessage({ type: "init", sab: alloc.sab });

  // AudioContext + worklet.
  state.ctx = new AudioContext();
  await state.ctx.resume();
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "wasm-decode-consumer", {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: {
      sab: alloc.sab, memory: alloc.memory, mode, wasmBytes, layout,
      n: N, capacity: CAPACITY, frameByteSize: schema.frameByteSize,
      descPtr, descCount, decodedFields,
    },
  });
  state.node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "diag") {
      hudEl.innerHTML =
        `<b>mode</b> <span class="${m.mode === "wasm" ? "ok" : ""}">${m.mode}</span>  ·  ` +
        `<b>decode</b> ${m.decodeUs.toFixed(0)} ns  ·  ` +
        `<b>pulls</b> ${m.pulls}  ·  <b>misses</b> ${m.misses}`;
    } else if (m.type === "error") {
      setStatus(`worklet: ${m.message}`, "err");
    } else if (m.type === "mode") {
      setStatus(`running — decode mode: ${m.mode}${m.mode === "js" && wasmOk ? "" : ""}`, "ok");
    }
  };
  state.node.connect(state.ctx.destination);
  state.running = true;
  setStatus(`running — decode mode: ${mode}`, "ok");
}

freqSlider.addEventListener("input", () => {
  $("freqval").textContent = `${freqSlider.value} Hz`;
  state.worker?.postMessage({ type: "fundamental", value: Number(freqSlider.value) });
});
startBtn.addEventListener("click", start);
setStatus(hasWasmConsumerSupport()
  ? "ready — WASM consumer supported. Press Start."
  : "ready — WASM unsupported here; will use the JS fallback. Press Start.");
