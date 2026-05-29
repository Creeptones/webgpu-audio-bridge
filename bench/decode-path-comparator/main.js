// main.js — sets up the decode-path comparator and renders live results.
//
// Allocates ONE WebAssembly.Memory (whose buffer is the SAB) so the producer
// worker, the JS Bridge, and the WASM decoder in the worklet all see the same
// bytes. Builds the descriptor table (C path) and the emitWorkletReader source
// (B path) on the main thread, then hands everything to the worklet. A
// GC-pressure toggle churns main-thread allocations so we can watch the decode
// tail (p99) under real V8 GC — the condition the Node microbench can't create.

import { Bridge, emitWorkletReader, describeSchemaLayout } from "../../dist/index.js";
import {
  allocateWorkletMemory,
  buildFrameDescriptors,
} from "../../dist/worklet/index.js";
import { makeSchema, CAPACITY } from "./schema.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const tableEl = $("results");
const startBtn = $("start");
const gcBtn = $("gc");
const resetBtn = $("reset");

const state = { running: false, gc: false, gcTimer: null, ctx: null, node: null, worker: null };

function setStatus(s, cls = "") { statusEl.innerHTML = `<span class="${cls}">${s}</span>`; }
function fmtNs(ns) {
  if (!ns) return "—";
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1000).toFixed(2)} µs`;
  return `${(ns / 1e6).toFixed(2)} ms`;
}

function render(rep) {
  const rows = [
    ["A2  JS umbrella decode", rep.A],
    ["B   codegen-JS reader", rep.B],
    ["C   WASM decodeFrame", rep.C],
  ];
  // winner = lowest p50 among rows with samples
  let best = null;
  for (const [, s] of rows) if (s.count && (!best || s.p50Ns < best)) best = s.p50Ns;
  tableEl.innerHTML =
    `<tr><th>strategy</th><th>p50</th><th>p99</th><th>max</th><th>n</th></tr>` +
    rows.map(([name, s]) => {
      const win = s.count && s.p50Ns === best ? ' class="win"' : "";
      return `<tr${win}><td>${name}</td><td>${fmtNs(s.p50Ns)}</td><td>${fmtNs(s.p99Ns)}</td><td>${fmtNs(s.maxNs)}</td><td>${s.count}</td></tr>`;
    }).join("") +
    (rep.wasm ? "" : `<tr><td colspan="5" class="err">WASM unavailable — C path skipped (runtime lacks SIMD/threads)</td></tr>`);
}

async function start() {
  if (state.running) return;
  if (typeof crossOriginIsolated === "undefined" || !crossOriginIsolated) {
    setStatus("FAILED — page is not crossOriginIsolated (serve with COOP/COEP)", "err"); return;
  }
  if (typeof SharedArrayBuffer === "undefined") { setStatus("FAILED — no SharedArrayBuffer", "err"); return; }
  startBtn.disabled = true;
  setStatus("allocating…");

  const schema = makeSchema();
  const layout = describeSchemaLayout(schema);

  // Allocate the shared memory big enough for ring + descriptor table + scratch.
  const sabBytes = Bridge.byteLength(CAPACITY, schema);
  const probe = buildFrameDescriptors(layout, 0);
  const descBytes = probe.descCount * 12;
  const alloc = allocateWorkletMemory({ sabBytes, scratchBytes: descBytes + probe.totalDstBytes + 64 });
  const descPtr = alloc.scratchByteOffset;
  const decodedBase = (descPtr + descBytes + 7) & ~7;
  const plan = buildFrameDescriptors(layout, decodedBase);
  new Int32Array(alloc.sab, descPtr, plan.words.length).set(plan.words);

  // Producer worker.
  state.worker = new Worker(new URL("./producer.worker.js", import.meta.url), { type: "module" });
  state.worker.postMessage({ type: "init", sab: alloc.sab });

  // Emitted JS reader source for the B path.
  const readerSrc = emitWorkletReader(schema, { functionName: "readFrame", bodyOnly: false });

  // WASM bytes.
  const wasmBytes = await (await fetch("/dist/worklet/decoder.wasm")).arrayBuffer();

  // AudioContext + worklet.
  state.ctx = new AudioContext();
  await state.ctx.resume();
  await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  state.node = new AudioWorkletNode(state.ctx, "decode-comparator", {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: {
      sab: alloc.sab, memory: alloc.memory, wasmBytes, layout, readerSrc,
      descPtr, descCount: plan.descCount, decodedFields: plan.fields,
      capacity: CAPACITY, frameByteSize: schema.frameByteSize,
    },
  });
  state.node.port.onmessage = (e) => {
    if (e.data?.type === "report") render(e.data);
    else if (e.data?.type === "error") setStatus(`worklet error: ${e.data.message}`, "err");
  };
  state.node.connect(state.ctx.destination);
  state.running = true;
  setStatus("running — toggle GC pressure to stress the decode tail", "ok");
}

function toggleGc() {
  state.gc = !state.gc;
  gcBtn.textContent = state.gc ? "GC pressure: ON" : "GC pressure: OFF";
  gcBtn.classList.toggle("on", state.gc);
  if (state.gc) {
    // Churn allocations on the main thread to force frequent V8 GC.
    state.gcTimer = setInterval(() => {
      const junk = [];
      for (let i = 0; i < 2000; i++) junk.push({ a: Math.random(), b: new Array(16).fill(i) });
      // let it become garbage immediately
      junk.length = 0;
    }, 1);
  } else {
    clearInterval(state.gcTimer); state.gcTimer = null;
  }
}

startBtn.addEventListener("click", start);
gcBtn.addEventListener("click", toggleGc);
resetBtn.addEventListener("click", () => state.node?.port.postMessage({ type: "reset" }));
