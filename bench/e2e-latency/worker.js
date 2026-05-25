// e2e-latency / worker.js — producer for the latency bench.
//
// Pushes a frame every TICK_MS. The header's tMacroNs lane carries
// performance.now() * 1e6 at push time. The worklet aligns its currentTime
// against the same clock via audioStartPerfMs (captured by main at
// AudioContext creation) and subtracts to get real end-to-end latency.
// See worklet.js for the alignment derivation.

import { Bridge } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;

const state = {
  ring: null,
  scratch: null,
  n: 0,
  capacity: 0,
  startTime: 0,
  seq: 0,
  pushRejects: 0,
  backend: "cpu",
  gpu: null,
  load: "idle",
  running: false,
};

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") return init(m).catch(fatal);
  if (m.type === "stop") { state.running = false; return; }
};

function fatal(err) {
  self.postMessage({ type: "fatal", message: err?.message ?? String(err) });
}

async function init({ sab, capacity, n, backend, load }) {
  const schema = makeSchema(n);
  state.ring = new Bridge(sab, capacity, schema);
  state.scratch = state.ring.scratchFrame();
  state.n = n;
  state.capacity = capacity;
  state.load = load;
  state.startTime = performance.now();

  if (backend !== "cpu" && navigator.gpu) {
    try { await initGPU(n); state.backend = "webgpu"; }
    catch (e) { console.warn("[bench-worker] GPU init failed, CPU stub:", e); state.backend = "cpu"; }
  } else {
    state.backend = "cpu";
  }

  // Pre-fill V_eff / J_eff with stable values; the bench isn't about audio.
  // Writes into the scratch frame's slot-bound arrays — happens once at init.
  for (let i = 0; i < n; i++) {
    state.scratch.vEff[i] = 440 + i;
    state.scratch.jEff[i] = 1 / (1 + i);
  }

  self.postMessage({ type: "ready", backend: state.backend });
  state.running = true;
  loop();
}

async function initGPU(N) {
  // Trivial compute pass that we can fatten with extra loops for the
  // "gpu load" mode. Result is discarded — the bench just needs the GPU
  // bus contention.
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no adapter");
  const device = await adapter.requestDevice();
  const buf = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE });
  const shader = device.createShaderModule({
    code: /* wgsl */ `
      @group(0) @binding(0) var<storage, read_write> sink: array<f32, 64>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        var acc: f32 = 0.0;
        for (var k: u32 = 0u; k < 200000u; k = k + 1u) {
          acc = acc + sin(f32(k) * 0.001);
        }
        sink[gid.x] = acc;
      }
    `,
  });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: shader, entryPoint: "main" } });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: buf } }],
  });
  state.gpu = { device, pipeline, bind };
}

async function tickGPU() {
  const g = state.gpu;
  const enc = g.device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(g.pipeline);
  pass.setBindGroup(0, g.bind);
  pass.dispatchWorkgroups(1);
  pass.end();
  g.device.queue.submit([enc.finish()]);
  // Note: not awaiting mapAsync — we deliberately don't readback. The bench
  // measures bridge latency, not GPU readback latency. Readback is the
  // separate problem the bridge exists to *avoid* in the audio hot path.
}

async function loop() {
  // Per-context performance.timeOrigin captured once: each context (main,
  // worker, AudioWorklet) has its OWN timeOrigin in DOMHighResTimeStamp. The
  // worker's tNow values aren't directly comparable to main's. Adding the
  // origin gives an absolute Unix-epoch-based ms timestamp that DOES match
  // across contexts. Same trick on main when capturing audioStartPerfMs.
  const tOriginMs = performance.timeOrigin;
  while (state.running) {
    const tNowMs = tOriginMs + performance.now();
    if (state.backend === "webgpu" && state.load === "gpu") {
      try { await tickGPU(); } catch (e) { /* swallow — load is best-effort */ }
    }
    // Mutate the reusable scratch frame in place. vEff/jEff were filled at
    // init; only seq + tMacroNs change per tick. Note this uses the LEGACY
    // physics schema (f64 seq/tMacroNs) so the fractional part of
    // performance.now() * 1e6 survives the round-trip — that sub-µs
    // precision is what the latency measurement depends on.
    state.scratch.seq = state.seq++;
    state.scratch.tMacroNs = tNowMs * 1e6;   // absolute epoch ms → ns, fractional preserved
    state.scratch.vMax = 0;
    state.scratch.jMax = 0;
    const ok = state.ring.push(state.scratch);
    if (!ok) state.pushRejects++;

    const drift = (tOriginMs + performance.now()) - tNowMs;
    const wait = Math.max(0, TICK_MS - drift);
    await new Promise((r) => setTimeout(r, wait));
  }
}
