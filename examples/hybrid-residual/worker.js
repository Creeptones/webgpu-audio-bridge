// worker.js — the residual producer (hybrid-residual demo).
//
// Same shape as examples/audio-rate/worker.js, but the WGSL kernel
// generates the HARMONIC RESIDUAL of the carrier fundamental — partials
// k = 2..(N_PARTIALS + 1), 1/k amplitude roll-off, each partial
// independently amplitude-modulated by a slow LFO. The fundamental is
// NOT included here — it's the CPU carrier that lives in the worklet.
//
// Why partials only? The hybrid pattern's whole point is that the
// FUNDAMENTAL (pitch-defining, latency-critical) lives on the CPU at
// zero latency, while the SPECTRAL RICHNESS (upper harmonics, slow LFO
// envelope) lives on the GPU and tolerates the ~85 ms block-mode
// latency floor because the ear can't localize amplitude envelopes on
// upper harmonics that tightly. Toggling the residual off and on is
// audible as "the timbre thins" — not "the pitch drops."
//
// Stall simulation: the page can post `{ type: "stall", durationMs: N }`
// and we skip ticks for that long. Lets the user hear (and the bench
// page measure) the difference between processAdd's "carrier survives"
// underflow path and process()'s zero-fill click.

import { Bridge, BridgeBlockProducer } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

const TICK_HZ = 50;
const TICK_MS = 1000 / TICK_HZ;
const REPORT_EVERY_MS = 250;
const SAMPLE_RATE = 48000;

const state = {
  ring: null,
  blockSize: 0,
  capacity: 0,
  nPartials: 0,
  carrierFreq: 220,
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
  stallUntil: 0,        // performance.now() timestamp; skip ticks while < this
  stallSamples: 0,      // diag: cumulative samples NOT produced due to stall
};

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") return init(m).catch(fatal);
  if (m.type === "freq") { state.carrierFreq = m.value; return; }
  if (m.type === "stall") {
    state.stallUntil = performance.now() + (m.durationMs ?? 200);
    return;
  }
  if (m.type === "stop") { stop(); return; }
};

function fatal(err) {
  self.postMessage({ type: "fatal", message: err?.message ?? String(err) });
}

async function init({ sab, capacity, blockSize, nPartials, carrierFreq }) {
  const schema = makeSchema(blockSize);
  state.ring = new Bridge(sab, capacity, schema);
  state.blockSize = blockSize;
  state.capacity = capacity;
  state.nPartials = nPartials;
  state.carrierFreq = carrierFreq ?? 220;
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
  const nPartials = state.nPartials;
  const outBytes = blockSize * 4;

  // Uniforms: blockStartSec, carrierFreq, sampleRate, lfoT.
  const uniformBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const sampleBuf = device.createBuffer({
    size: outBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Harmonics 2..(nPartials + 1). 1/k roll-off, per-partial slow LFO on
  // amplitude (phase-offset 0.13*k per partial so they don't beat in lock-
  // step). LFO frequency is sub-Hz (0.3 Hz).
  const wgsl = /* wgsl */ `
    struct Uniforms {
      blockStartSec: f32,
      carrierFreq:   f32,
      sampleRate:    f32,
      lfoT:          f32,
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;
    @group(0) @binding(1) var<storage, read_write> samples: array<f32, ${blockSize}>;

    const TWO_PI: f32 = 6.28318530718;

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i = gid.x;
      if (i >= ${blockSize}u) { return; }
      let t = u.blockStartSec + f32(i) / u.sampleRate;
      let f0 = u.carrierFreq;
      var acc: f32 = 0.0;
      // Partials k = 2..(2 + nPartials - 1). Skip k=1 — the CPU fundamental.
      for (var k: u32 = 2u; k < ${nPartials + 2}u; k = k + 1u) {
        let fk = f0 * f32(k);
        let lfoPhase = u.lfoT + 0.13 * f32(k);
        // 1/k roll-off + LFO 50% depth around 0.5 (so amp in [0.0, 1.0]).
        let amp = (0.5 + 0.5 * sin(TWO_PI * 0.3 * lfoPhase)) / f32(k);
        acc = acc + sin(TWO_PI * fk * t) * amp;
      }
      // Aggregate scale so the residual is audible but does not clip when
      // summed with the carrier. The worklet applies an additional gain
      // slider on top of this.
      samples[i] = acc * 0.4;
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

  const u = new Float32Array([blockStartSec, state.carrierFreq, SAMPLE_RATE, lfoT]);
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
  for (let i = 0; i < blockSize; i++) {
    const t = blockStartSec + i / SAMPLE_RATE;
    let acc = 0;
    for (let k = 2; k < nPartials + 2; k++) {
      const fk = f0 * k;
      const lfoPhase = lfoT + 0.13 * k;
      const amp = (0.5 + 0.5 * Math.sin(TWO_PI * 0.3 * lfoPhase)) / k;
      acc += Math.sin(TWO_PI * fk * t) * amp;
    }
    samples[i] = acc * 0.4;
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
      // Skip this tick — count the samples we'd have produced for diag.
      state.stallSamples += state.blockSize;
    } else {
      const blockStartSec = (blockIdx * state.blockSize) / SAMPLE_RATE;
      const lfoT = blockStartSec; // LFO drives off the same wall-time tick.

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
