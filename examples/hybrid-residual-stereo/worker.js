// worker.js — the STEREO residual producer (hybrid-residual-stereo demo).
//
// Same shape as examples/hybrid-residual/worker.js, but the kernel writes an
// INTERLEAVED stereo residual: the harmonic partials (k = 2..N_PARTIALS+1,
// 1/k roll-off, per-partial slow LFO) rendered TWICE — once for the left
// channel and once for the right with a small per-channel detune + phase
// offset so the upper-harmonic layer has an audible stereo width. The
// fundamental is NOT here (it's the CPU carrier in the worklet).
//
// Interleave convention: samples[2*i]   = L_i, samples[2*i+1] = R_i.
// BridgeBlockProducer copies the lone array's full 2*blockSize length as-is;
// "interleaved" is purely how this producer chooses to fill it.
//
// `width` (0..1, post-able from the page) scales the L/R detune + phase
// offset so the user can hear the stereo image widen / collapse to mono.
//
// Stall simulation identical to the mono demo.

import { Bridge, BridgeBlockProducer } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

const TICK_HZ = 50;
const TICK_MS = 1000 / TICK_HZ;
const REPORT_EVERY_MS = 250;
const SAMPLE_RATE = 48000;

const state = {
  ring: null,
  blockSize: 0,
  channels: 2,
  capacity: 0,
  nPartials: 0,
  carrierFreq: 220,
  width: 0.5,
  startTime: 0,
  pushedTotal: 0,
  pushRejects: 0,
  backend: "uninitialized",
  adapter: null,
  gpu: null,
  producer: null,
  scratch: null,
  lastReportAt: 0,
  lastReportPushed: 0,
  running: false,
  stallUntil: 0,
  stallSamples: 0,
};

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") return init(m).catch(fatal);
  if (m.type === "freq") { state.carrierFreq = m.value; return; }
  if (m.type === "width") { state.width = m.value; return; }
  if (m.type === "stall") {
    state.stallUntil = performance.now() + (m.durationMs ?? 200);
    return;
  }
  if (m.type === "stop") { stop(); return; }
};

function fatal(err) {
  self.postMessage({ type: "fatal", message: err?.message ?? String(err) });
}

async function init({ sab, capacity, blockSize, channels, nPartials, carrierFreq, width }) {
  const schema = makeSchema(blockSize, channels);
  state.ring = new Bridge(sab, capacity, schema);
  state.blockSize = blockSize;
  state.channels = channels;
  state.capacity = capacity;
  state.nPartials = nPartials;
  state.carrierFreq = carrierFreq ?? 220;
  state.width = width ?? 0.5;
  state.startTime = performance.now();

  if (typeof navigator !== "undefined" && navigator.gpu) {
    try { await initGPU(); state.backend = "webgpu"; }
    catch (e) {
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
  const channels = state.channels;
  const nPartials = state.nPartials;
  const flat = blockSize * channels;
  const outBytes = flat * 4;

  // Uniforms: blockStartSec, carrierFreq, sampleRate, lfoT, width, (pad).
  const uniformBuf = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const sampleBuf = device.createBuffer({
    size: outBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // One invocation per PER-CHANNEL sample i; writes both L (2*i) and R (2*i+1).
  // R is detuned + phase-offset by `width`-scaled amounts so the partial layer
  // is stereo-wide; width=0 collapses to identical L/R (mono image).
  const wgsl = /* wgsl */ `
    struct Uniforms {
      blockStartSec: f32,
      carrierFreq:   f32,
      sampleRate:    f32,
      lfoT:          f32,
      width:         f32,
      _pad0:         f32,
      _pad1:         f32,
      _pad2:         f32,
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;
    @group(0) @binding(1) var<storage, read_write> samples: array<f32, ${flat}>;

    const TWO_PI: f32 = 6.28318530718;

    fn renderResidual(t: f32, f0: f32, detune: f32, phaseOff: f32) -> f32 {
      var acc: f32 = 0.0;
      for (var k: u32 = 2u; k < ${nPartials + 2}u; k = k + 1u) {
        let fk = f0 * f32(k) * detune;
        let lfoPhase = u.lfoT + 0.13 * f32(k);
        let amp = (0.5 + 0.5 * sin(TWO_PI * 0.3 * lfoPhase)) / f32(k);
        acc = acc + sin(TWO_PI * fk * t + phaseOff * f32(k)) * amp;
      }
      return acc * 0.4;
    }

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i = gid.x;
      if (i >= ${blockSize}u) { return; }
      let t = u.blockStartSec + f32(i) / u.sampleRate;
      let f0 = u.carrierFreq;
      // Left: clean partials. Right: detuned + phase-shifted, width-scaled.
      let dt = 1.0 + 0.004 * u.width;     // up to +0.4% detune on the right
      let ph = 0.6 * u.width;             // up to ~0.6 rad/partial phase offset
      let l = renderResidual(t, f0, 1.0, 0.0);
      let r = renderResidual(t, f0, dt, ph);
      samples[2u * i]      = l;
      samples[2u * i + 1u] = r;
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
  });
}

function tickGPU(blockStartSec, lfoT) {
  const g = state.gpu;
  const dev = g.device;
  const producer = state.producer;

  if (producer.inFlight() >= producer.capacity()) return false;

  const u = new Float32Array([
    blockStartSec, state.carrierFreq, SAMPLE_RATE, lfoT, state.width, 0, 0, 0,
  ]);
  dev.queue.writeBuffer(g.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);

  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(g.pipeline);
  pass.setBindGroup(0, g.bindGroup);
  pass.dispatchWorkgroups(Math.ceil(state.blockSize / 64));
  pass.end();
  const scheduled = producer.scheduleReadback(g.sampleBuf, enc);
  if (!scheduled) return false;
  dev.queue.submit([enc.finish()]);
  producer.flushPending();
  return true;
}

function tickCPU(blockStartSec, lfoT) {
  const blockSize = state.blockSize;
  const nPartials = state.nPartials;
  const f0 = state.carrierFreq;
  const TWO_PI = Math.PI * 2;
  const samples = state.scratch.samples;
  const w = state.width;
  const dt = 1.0 + 0.004 * w;
  const ph = 0.6 * w;
  for (let i = 0; i < blockSize; i++) {
    const t = blockStartSec + i / SAMPLE_RATE;
    let accL = 0, accR = 0;
    for (let k = 2; k < nPartials + 2; k++) {
      const lfoPhase = lfoT + 0.13 * k;
      const amp = (0.5 + 0.5 * Math.sin(TWO_PI * 0.3 * lfoPhase)) / k;
      accL += Math.sin(TWO_PI * f0 * k * t) * amp;
      accR += Math.sin(TWO_PI * f0 * k * dt * t + ph * k) * amp;
    }
    samples[2 * i] = accL * 0.4;
    samples[2 * i + 1] = accR * 0.4;
  }
  state.scratch.blockIndex = BigInt(state.pushedTotal);
  return state.ring.push(state.scratch);
}

async function loop() {
  let nextTickTime = performance.now();
  let blockIdx = 0;

  while (state.running) {
    const stalled = performance.now() < state.stallUntil;

    if (stalled) {
      state.stallSamples += state.blockSize;
    } else {
      const blockStartSec = (blockIdx * state.blockSize) / SAMPLE_RATE;
      const lfoT = blockStartSec;

      if (state.backend === "webgpu") {
        const ok = tickGPU(blockStartSec, lfoT);
        if (ok) blockIdx++;
        const pushedNow = state.producer.pollCompleted();
        state.pushedTotal += pushedNow;
      } else {
        const ok = tickCPU(blockStartSec, lfoT);
        if (ok) { state.pushedTotal++; blockIdx++; }
        else state.pushRejects++;
      }
    }

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
        stalledNow: stalled,
        stallSamplesTotal: state.stallSamples,
      });
      state.lastReportAt = tNow;
      state.lastReportPushed = state.pushedTotal;
    }

    nextTickTime += TICK_MS;
    const wait = Math.max(0, nextTickTime - performance.now());
    await new Promise((r) => setTimeout(r, wait));
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
