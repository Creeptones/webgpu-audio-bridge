// e2e-latency / worker.js — producer for the latency bench.
//
// Pushes a frame every tick into the shared ring. The bench keeps the frame
// payload deterministic and stamps `tMacroNs` as `performance.now() * 1e6` so
// the worklet can do end-to-end timing from the producer push to audio-thread
// consume.
//
// The producer can run three hot-path variants for benchmarking:
//   - `push` (default): schema-dispatched encode + publish.
//   - `beginCommit`: zero-copy write into the slot, commit once per tick.
//   - `pushRaw`: one native memcpy per frame (`pushRaw`).
//
// The producer notify path is also configurable (`always` / `waiter-flag`) and
// tick frequency is controlled by `producerTickHz` so load/spacing effects can
// be part of the benchmark matrix.

import { Bridge } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

const RAW_SEQ_INDEX = 0;
const RAW_T_MACRO_INDEX = 1;
const RAW_V_MAX_INDEX = 2;
const RAW_J_MAX_INDEX = 3;

const state = {
  ring: null,
  scratch: null,
  rawScratch: null,
  beginPushSeenFrames: null,
  n: 0,
  capacity: 0,
  tickHz: 60,
  tickIntervalMs: 1000 / 60,
  startTime: 0,
  seq: 0,
  backend: "cpu",
  notifyMode: "always",
  producerPushMode: "push",
  pushRejects: 0,
  gpu: null,
  load: "idle",
  running: false,
};

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") return init(m).catch(fatal);
  if (m.type === "stop") {
    state.running = false;
    return;
  }
};

function fatal(err) {
  self.postMessage({ type: "fatal", message: err?.message ?? String(err) });
}

function normalizePushMode(mode) {
  if (mode === "beginCommit" || mode === "pushRaw") return mode;
  return "push";
}

async function init({
  sab,
  capacity,
  n,
  backend,
  load,
  notifyMode,
  producerPushMode,
  producerTickHz,
}) {
  const schema = makeSchema(n);
  const ringNotify = notifyMode === "waiter-flag" ? "waiter-flag" : "always";
  const pushMode = normalizePushMode(producerPushMode);
  const loadMode = load === "gpu" || load === "main" ? load : "idle";
  const tickHz = Math.max(
    1,
    Math.round(Number.isFinite(Number(producerTickHz)) ? Number(producerTickHz) : 60),
  );

  state.ring = new Bridge(sab, capacity, schema, { notify: ringNotify });
  state.scratch = state.ring.scratchFrame();
  state.rawScratch = null;
  state.beginPushSeenFrames = null;
  state.n = n;
  state.capacity = capacity;
  state.tickHz = tickHz;
  state.tickIntervalMs = 1000 / tickHz;
  state.seq = 0;
  state.startTime = performance.now();
  state.load = loadMode;
  state.notifyMode = ringNotify;
  state.producerPushMode = pushMode;
  state.pushRejects = 0;
  if (pushMode === "beginCommit") {
    state.beginPushSeenFrames = new WeakSet();
  }

  // The frame layout used by this bench is all-f64 and therefore f64-aligned.
  if ((state.ring.frameByteSize & 7) !== 0) {
    throw new Error(`bench worker: unsupported non-aligned frameByteSize=${state.ring.frameByteSize}`);
  }

  if (backend === "cpu" || !navigator.gpu) {
    state.backend = "cpu";
  } else {
    try {
      await initGPU(n);
      state.backend = "webgpu";
    } catch (e) {
      console.warn("[bench-worker] GPU init failed, CPU stub:", e);
      state.backend = "cpu";
    }
  }

  // Pre-fill V_eff / J_eff with stable values once; the bench is not about audio.
  for (let i = 0; i < n; i++) {
    state.scratch.vEff[i] = 440 + i;
    state.scratch.jEff[i] = 1 / (1 + i);
  }

  if (pushMode === "pushRaw") {
    const raw = new Float64Array(state.ring.frameByteSize / 8);
    raw[RAW_SEQ_INDEX] = 0;
    raw[RAW_T_MACRO_INDEX] = 0;
    raw[RAW_V_MAX_INDEX] = 0;
    raw[RAW_J_MAX_INDEX] = 0;
    const vEffStart = 4;
    const jEffStart = vEffStart + n;
    for (let i = 0; i < n; i++) {
      raw[vEffStart + i] = state.scratch.vEff[i];
      raw[jEffStart + i] = state.scratch.jEff[i];
    }
    state.rawScratch = raw;
  }

  self.postMessage({
    type: "ready",
    backend: state.backend,
    notifyMode: state.notifyMode,
  });
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

async function loop() {
  // Per-context performance.timeOrigin captured once: each context
  // (main, worker, AudioWorklet) has its own timeOrigin.
  const tOriginMs = performance.timeOrigin;
  let nextTickMs = tOriginMs + performance.now();

  while (state.running) {
    const tNowMs = tOriginMs + performance.now();
    if (state.backend === "webgpu" && state.load === "gpu") {
      try {
        await tickGPU();
      } catch (e) {
        // load is best-effort
      }
    }

    const tMacroNs = tNowMs * 1e6;
    if (state.producerPushMode === "beginCommit") {
      const frame = state.ring.beginPush();
      if (!frame) {
        state.pushRejects += 1;
      } else {
        if (state.beginPushSeenFrames && !state.beginPushSeenFrames.has(frame)) {
          frame.vEff.set(state.scratch.vEff);
          frame.jEff.set(state.scratch.jEff);
          state.beginPushSeenFrames.add(frame);
        }
        frame.seq = state.seq++;
        frame.tMacroNs = tMacroNs;
        frame.vMax = 0;
        frame.jMax = 0;
        state.ring.commitPush();
      }
    } else if (state.producerPushMode === "pushRaw" && state.rawScratch) {
      state.rawScratch[RAW_SEQ_INDEX] = state.seq++;
      state.rawScratch[RAW_T_MACRO_INDEX] = tMacroNs;
      const ok = state.ring.pushRaw(state.rawScratch);
      if (!ok) state.pushRejects++;
    } else {
      state.scratch.seq = state.seq++;
      state.scratch.tMacroNs = tMacroNs;
      state.scratch.vMax = 0;
      state.scratch.jMax = 0;
      const ok = state.ring.push(state.scratch);
      if (!ok) state.pushRejects++;
    }

    nextTickMs += state.tickIntervalMs;
    const nowMs = tOriginMs + performance.now();
    const waitMs = nextTickMs - nowMs;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    } else {
      nextTickMs = nowMs;
    }
  }
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
  // Note: not awaiting mapAsync — we deliberately don't readback.
}
