// worker.js — the producer side.
//
// Runs in a DedicatedWorker. Tries to set up a WebGPU compute pipeline that
// emits four harmonic frequencies per tick. If WebGPU isn't available (CI
// headless, Safari without the flag, etc.) falls back to a CPU loop that
// computes the same harmonics in JS. Either way, the bridge upstream of this
// file doesn't change.
//
// The point of the demo isn't the kernel; it's that the GPU compute → SAB →
// AudioWorklet path moves data without postMessage and without blocking the
// audio thread.

import { Bridge } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
const REPORT_EVERY_MS = 250;

const state = {
  ring: null,
  scratch: null,    // reused FrameFor<schema> object — allocated once at init
  n: 0,
  capacity: 0,
  controlValue: 0.3,
  startTime: 0,
  seq: 0n,
  pushRejects: 0,
  tickHandle: null,
  backend: "uninitialized",
  adapter: null,
  gpu: null,        // GPU resources, if available
  lastReportAt: 0,
  lastReportSeq: 0n,
  running: false,
};

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") return init(m).catch(fatal);
  if (m.type === "control") { state.controlValue = m.value; return; }
  if (m.type === "stop") { stop(); return; }
};

function fatal(err) {
  self.postMessage({ type: "fatal", message: err?.message ?? String(err) });
}

async function init({ sab, capacity, n, controlValue }) {
  const schema = makeSchema(n);
  state.ring = new Bridge(sab, capacity, schema);
  // Allocate once, reuse across all pushes — zero GC pressure on the hot loop.
  state.scratch = state.ring.scratchFrame();
  state.n = n;
  state.capacity = capacity;
  state.controlValue = controlValue ?? 0.3;
  state.startTime = performance.now();

  // Try WebGPU. Fall back to CPU on any failure.
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      await initGPU();
      state.backend = "webgpu";
    } catch (e) {
      console.warn("[worker] WebGPU init failed, falling back to CPU:", e);
      state.backend = "cpu";
    }
  } else {
    state.backend = "cpu";
  }

  self.postMessage({ type: "ready", backend: state.backend, adapter: state.adapter });
  state.running = true;
  loop();
}

async function initGPU() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  state.adapter = adapter.info?.vendor ? `${adapter.info.vendor} ${adapter.info.architecture ?? ""}`.trim() : "unknown";
  const device = await adapter.requestDevice();

  // Uniforms: timeSec, controlValue, _pad0, _pad1 (vec4 align).
  const uniformBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Outputs: vEff[N], jEff[N] as f32.
  const N = state.n;
  const outBytes = N * 4;
  const vBuf = device.createBuffer({
    size: outBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const jBuf = device.createBuffer({
    size: outBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const stagingV = device.createBuffer({
    size: outBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const stagingJ = device.createBuffer({
    size: outBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const shader = device.createShaderModule({
    code: /* wgsl */ `
      struct Uniforms {
        timeSec: f32,
        controlValue: f32,
        _pad0: f32,
        _pad1: f32,
      };
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;
      @group(0) @binding(1) var<storage, read_write> vEff: array<f32, ${N}>;
      @group(0) @binding(2) var<storage, read_write> jEff: array<f32, ${N}>;

      @compute @workgroup_size(${N})
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i = gid.x;
        if (i >= ${N}u) { return; }
        let t = uniforms.timeSec;
        let c = uniforms.controlValue;
        // Harmonic series whose spread is modulated by control + time.
        let baseFreq = 220.0 + 220.0 * c;
        let spread = 1.0 + 0.3 * sin(t * 0.5);
        vEff[i] = baseFreq * (1.0 + f32(i) * spread);
        // jEff is a per-partial gain envelope that fades the higher harmonics.
        jEff[i] = 0.6 / (1.0 + 0.5 * f32(i));
      }
    `,
  });

  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: shader, entryPoint: "main" },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuf } },
      { binding: 1, resource: { buffer: vBuf } },
      { binding: 2, resource: { buffer: jBuf } },
    ],
  });

  state.gpu = { device, uniformBuf, vBuf, jBuf, stagingV, stagingJ, pipeline, bindGroup, outBytes };
}

async function tickGPU(tSec) {
  const g = state.gpu;
  const dev = g.device;

  // Update uniforms.
  const u = new Float32Array([tSec, state.controlValue, 0, 0]);
  dev.queue.writeBuffer(g.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);

  // Encode: dispatch, copy to staging.
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(g.pipeline);
  pass.setBindGroup(0, g.bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();
  enc.copyBufferToBuffer(g.vBuf, 0, g.stagingV, 0, g.outBytes);
  enc.copyBufferToBuffer(g.jBuf, 0, g.stagingJ, 0, g.outBytes);
  dev.queue.submit([enc.finish()]);

  // Readback. mapAsync is the 5–15ms tax the README is built around — fine
  // at 60Hz, fatal at audio rate, which is the whole point of the bridge.
  await Promise.all([g.stagingV.mapAsync(GPUMapMode.READ), g.stagingJ.mapAsync(GPUMapMode.READ)]);
  const vF32 = new Float32Array(g.stagingV.getMappedRange().slice(0));
  const jF32 = new Float32Array(g.stagingJ.getMappedRange().slice(0));
  g.stagingV.unmap();
  g.stagingJ.unmap();

  // Widen f32 → f64 for the bridge's payload, writing directly into the
  // reusable scratch frame's typed-array fields.
  const vEff = state.scratch.vEff;
  const jEff = state.scratch.jEff;
  let vMax = 0, jMax = 0;
  for (let i = 0; i < state.n; i++) {
    const v = vF32[i], j = jF32[i];
    vEff[i] = v;
    jEff[i] = j;
    if (Math.abs(v) > vMax) vMax = Math.abs(v);
    if (Math.abs(j) > jMax) jMax = Math.abs(j);
  }
  return { vMax, jMax };
}

function tickCPU(tSec) {
  // Mirror of the WGSL kernel, in JS. Same outputs.
  const c = state.controlValue;
  const baseFreq = 220 + 220 * c;
  const spread = 1 + 0.3 * Math.sin(tSec * 0.5);
  const vEff = state.scratch.vEff;
  const jEff = state.scratch.jEff;
  let vMax = 0, jMax = 0;
  for (let i = 0; i < state.n; i++) {
    const v = baseFreq * (1 + i * spread);
    const j = 0.6 / (1 + 0.5 * i);
    vEff[i] = v;
    jEff[i] = j;
    if (Math.abs(v) > vMax) vMax = Math.abs(v);
    if (Math.abs(j) > jMax) jMax = Math.abs(j);
  }
  return { vMax, jMax };
}

async function loop() {
  while (state.running) {
    const tNow = performance.now();
    const tSec = (tNow - state.startTime) / 1000;
    let stats;
    try {
      stats = state.backend === "webgpu" ? await tickGPU(tSec) : tickCPU(tSec);
    } catch (e) {
      // GPU error mid-run — fall back to CPU rather than killing the demo.
      console.warn("[worker] GPU tick failed, falling back to CPU:", e);
      state.backend = "cpu";
      stats = tickCPU(tSec);
    }

    // Populate scalar fields on the scratch frame in place; vEff/jEff were
    // already written by tickGPU / tickCPU. Then push the same scratch
    // object every tick (zero allocations).
    state.scratch.seq = state.seq;
    state.scratch.tMacroNs = BigInt(Math.floor(tNow * 1e6));
    state.scratch.vMax = stats.vMax;
    state.scratch.jMax = stats.jMax;
    const ok = state.ring.push(state.scratch);
    if (!ok) state.pushRejects++;
    state.seq++;

    // Periodic diag back to main.
    if (tNow - state.lastReportAt > REPORT_EVERY_MS) {
      const elapsedSec = (tNow - state.lastReportAt) / 1000;
      const pushRateHz = Number(state.seq - state.lastReportSeq) / elapsedSec;
      self.postMessage({
        type: "diag",
        backend: state.backend,
        pushRateHz,
        pushRejects: state.pushRejects,
        available: state.ring.available(),
        // Cast bigint → number for JSON-friendly diag (within 2^53 for any
        // sane run duration; this is for the on-page status panel, not for
        // bit-exact downstream consumption).
        lastSeq: Number(state.seq - 1n),
      });
      state.lastReportAt = tNow;
      state.lastReportSeq = state.seq;
    }

    // Pace at TICK_MS. Don't try to be too clever about drift — at 60Hz
    // the audio side tolerates ±1 tick of jitter trivially.
    const drift = performance.now() - tNow;
    const wait = Math.max(0, TICK_MS - drift);
    await new Promise((r) => setTimeout(r, wait));
  }
}

function stop() {
  state.running = false;
}
