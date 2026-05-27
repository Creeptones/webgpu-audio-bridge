// worker.js — the producer side (audio-rate block mode).
//
// Runs in a DedicatedWorker. Tries to set up a WebGPU compute pipeline that
// emits a 1024-sample PCM block per tick (additive sine bank, N_VOICES
// partials, time-and-control-modulated frequencies). If WebGPU isn't
// available falls back to a CPU loop that computes the same block in JS.
//
// Demonstrates the canonical BridgeBlockProducer pattern: the user writes the
// compute shader, hands the producer's `scheduleReadback` the output
// GPUBuffer + a command encoder, and the helper handles
// `copyBufferToBuffer` + `mapAsync` + the decoder that copies the mapped
// samples into the bridge's f32Array slot.

import { Bridge, BridgeBlockProducer } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

// 50 Hz producer pacing — slightly above the 46.875 Hz consumption rate of
// the 1024-sample / 48 kHz audio worklet. Keeps the ring near 1-block
// occupancy in steady state with capacity 4 leaving plenty of headroom for
// transient jitter.
const TICK_HZ = 50;
const TICK_MS = 1000 / TICK_HZ;
const REPORT_EVERY_MS = 250;
const SAMPLE_RATE = 48000;

const state = {
  ring: null,
  blockSize: 0,
  capacity: 0,
  nVoices: 0,
  controlValue: 0.4,
  startTime: 0,
  pushedTotal: 0,
  pushRejects: 0,
  tickHandle: null,
  backend: "uninitialized",
  adapter: null,
  gpu: null,
  producer: null,
  scratch: null,        // for CPU fallback path
  lastReportAt: 0,
  lastReportPushed: 0,
  running: false,
  // GPU-only pacing: avoid scheduling a readback when staging buffers are
  // already saturated. We just check inFlight() before scheduling.
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

async function init({ sab, capacity, blockSize, nVoices, controlValue }) {
  const schema = makeSchema(blockSize);
  state.ring = new Bridge(sab, capacity, schema);
  state.blockSize = blockSize;
  state.capacity = capacity;
  state.nVoices = nVoices;
  state.controlValue = controlValue ?? 0.4;
  state.startTime = performance.now();

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

  if (state.backend === "cpu") {
    state.scratch = state.ring.scratchFrame();
  }

  self.postMessage({ type: "ready", backend: state.backend, adapter: state.adapter });
  state.running = true;
  loop();
}

async function initGPU() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  state.adapter = adapter.info?.vendor
    ? `${adapter.info.vendor} ${adapter.info.architecture ?? ""}`.trim()
    : "unknown";
  const device = await adapter.requestDevice();

  const blockSize = state.blockSize;
  const nVoices = state.nVoices;
  const outBytes = blockSize * 4;

  // Uniforms: blockStartSec, controlValue, sampleRate, _pad.
  const uniformBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Storage: blockSize × f32 samples. COPY_SRC because BridgeBlockProducer
  // copies from this into its staging buffer.
  const sampleBuf = device.createBuffer({
    size: outBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Compute shader: additive sine bank. Each thread writes one sample.
  // Per-sample time = blockStartSec + i / sampleRate. N_VOICES partials with
  // frequencies that spread out as controlValue → 1.
  const wgsl = /* wgsl */ `
    struct Uniforms {
      blockStartSec: f32,
      controlValue:  f32,
      sampleRate:    f32,
      _pad:          f32,
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;
    @group(0) @binding(1) var<storage, read_write> samples: array<f32, ${blockSize}>;

    const TWO_PI: f32 = 6.28318530718;

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i = gid.x;
      if (i >= ${blockSize}u) { return; }
      let t = u.blockStartSec + f32(i) / u.sampleRate;
      let baseFreq: f32 = 110.0;          // A2
      let spread: f32 = 1.0 + u.controlValue * 1.5;
      var acc: f32 = 0.0;
      for (var k: u32 = 0u; k < ${nVoices}u; k = k + 1u) {
        let f = baseFreq * (1.0 + f32(k) * spread);
        let gain = 0.6 / (1.0 + 0.5 * f32(k));
        acc = acc + sin(TWO_PI * f * t) * gain;
      }
      samples[i] = acc * 0.15;
    }
  `;

  const shader = device.createShaderModule({ code: wgsl });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: shader, entryPoint: "main" },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuf } },
      { binding: 1, resource: { buffer: sampleBuf } },
    ],
  });

  state.gpu = { device, uniformBuf, sampleBuf, pipeline, bindGroup, outBytes };
  state.producer = new BridgeBlockProducer(device, state.ring, {
    stagingBufferCount: 3,
    // 'blockIndex' is auto-detected (default behavior) — present on the
    // schema as a u64 scalar.
  });
}

function tickGPU(blockStartSec) {
  const g = state.gpu;
  const dev = g.device;
  const producer = state.producer;

  // Skip the tick if all staging buffers are in flight — the producer is
  // GPU-bound; we'll catch up on the next tick.
  if (producer.inFlight() >= producer.capacity()) {
    return false;
  }

  // Update uniforms.
  const u = new Float32Array([blockStartSec, state.controlValue, SAMPLE_RATE, 0]);
  dev.queue.writeBuffer(g.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);

  // Encode compute + readback (the BridgeBlockProducer handles the
  // copyBufferToBuffer into its staging-buffer ring).
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(g.pipeline);
  pass.setBindGroup(0, g.bindGroup);
  pass.dispatchWorkgroups(Math.ceil(state.blockSize / 64));
  pass.end();
  const scheduled = producer.scheduleReadback(g.sampleBuf, enc);
  if (!scheduled) {
    // Shouldn't happen — we just checked inFlight — but guard anyway.
    return false;
  }
  dev.queue.submit([enc.finish()]);
  producer.flushPending();

  return true;
}

function tickCPU(blockStartSec) {
  // Mirror of the WGSL kernel, in JS. Same outputs.
  const blockSize = state.blockSize;
  const nVoices = state.nVoices;
  const c = state.controlValue;
  const baseFreq = 110;
  const spread = 1 + c * 1.5;
  const TWO_PI = Math.PI * 2;
  const samples = state.scratch.samples;
  for (let i = 0; i < blockSize; i++) {
    const t = blockStartSec + i / SAMPLE_RATE;
    let acc = 0;
    for (let k = 0; k < nVoices; k++) {
      const f = baseFreq * (1 + k * spread);
      const gain = 0.6 / (1 + 0.5 * k);
      acc += Math.sin(TWO_PI * f * t) * gain;
    }
    samples[i] = acc * 0.15;
  }
  state.scratch.blockIndex = BigInt(state.pushedTotal);
  return state.ring.push(state.scratch);
}

async function loop() {
  // Producer-side `blockStartSec` advances by exactly `blockSize / sampleRate`
  // per tick (not by wall-clock) so the generated sine bank is continuous
  // across block boundaries. Wall-clock pacing just rate-limits the loop;
  // the audible signal stitches block-to-block without phase jumps.
  let nextTickTime = performance.now();
  let blockIdx = 0;

  while (state.running) {
    const blockStartSec = (blockIdx * state.blockSize) / SAMPLE_RATE;

    if (state.backend === "webgpu") {
      const ok = tickGPU(blockStartSec);
      if (ok) blockIdx++;
      // Poll completed readbacks (drives the push through the bridge).
      const pushedNow = state.producer.pollCompleted();
      state.pushedTotal += pushedNow;
    } else {
      const ok = tickCPU(blockStartSec);
      if (ok) {
        state.pushedTotal++;
        blockIdx++;
      } else {
        state.pushRejects++;
      }
    }

    // Periodic diag.
    const tNow = performance.now();
    if (tNow - state.lastReportAt > REPORT_EVERY_MS) {
      const elapsedSec = (tNow - state.lastReportAt) / 1000;
      const pushRateHz = (state.pushedTotal - state.lastReportPushed) / elapsedSec;
      self.postMessage({
        type: "diag",
        backend: state.backend,
        pushRateHz,
        pushRejects: state.pushRejects,
        pushedBlocks: state.pushedTotal,
        droppedReadbacks: state.producer?.droppedCount() ?? 0,
        lastReadbackUs: state.producer?.lastReadbackUs() ?? 0,
      });
      state.lastReportAt = tNow;
      state.lastReportPushed = state.pushedTotal;
    }

    // Sleep until next tick.
    nextTickTime += TICK_MS;
    const wait = Math.max(0, nextTickTime - performance.now());
    await new Promise((r) => setTimeout(r, wait));
    // If we fell badly behind (e.g. the tab was backgrounded), resync the
    // schedule rather than chasing a backlog of missed ticks.
    if (performance.now() - nextTickTime > TICK_MS * 4) {
      nextTickTime = performance.now();
    }
  }
}

function stop() {
  state.running = false;
  try { state.producer?.destroy(); } catch {}
  state.producer = null;
}
