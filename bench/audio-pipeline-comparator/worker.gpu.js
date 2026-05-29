// worker.gpu.js — the SHARED GPU producer for the comparator bench.
//
// One WGSL kernel (from reference-signal.js) feeds three of the four
// pipelines. Two axes of configuration:
//
//   signal mode  — "full"     : fundamental (k=1) + partials → the whole
//                               signal. Used by paths B and C, which render
//                               everything on the GPU.
//                  "residual" : partials only (k≥2) → path G's GPU layer
//                               (the CPU carrier supplies the fundamental).
//
//   emit mode    — "bridge"   : push blocks through a Bridge<S> SAB ring via
//                               BridgeBlockProducer. Consumed by an
//                               AudioWorklet (paths C and G). Each block is
//                               tagged with the carrier frequency it was
//                               COMPUTED at (frame.carrierFreq), so path C's
//                               worklet can detect when new-freq samples land.
//                  "absn"     : the NAÏVE path B — manual mapAsync readback,
//                               then postMessage the Float32Array (transferred)
//                               back to the main thread, which schedules it on
//                               an AudioBufferSourceNode. No SAB, no worklet.
//                               This is deliberately the slow, no-process()
//                               transport; the bench measures exactly how much
//                               that costs.
//
// Controls (postMessage from the page):
//   { type:"init", … }
//   { type:"freq", value }            — retune the carrier (drives the uniform)
//   { type:"setPartials", n }         — change the spectral-richness knob N.
//                                       nPartials is a UNIFORM, so this is a
//                                       state write — no pipeline rebuild.
//   { type:"stall", durationMs }      — skip ticks for that long (GPU outage).
//   { type:"stop" }
//
// The WebGPU path falls back to a CPU loop computing the identical signal when
// no adapter is available, mirroring the other demos.

import { Bridge, BridgeBlockProducer } from "../../dist/index.js";
import { makeSchema } from "./schema.js";
import {
  fillSignal,
  K_FULL,
  K_RESIDUAL,
  SAMPLE_RATE,
  wgslKernelSource,
} from "./reference-signal.js";

const TICK_HZ = 50; // ~slightly above the 46.875 Hz block-consumption rate.
const TICK_MS = 1000 / TICK_HZ;
const REPORT_EVERY_MS = 250;

const state = {
  signalMode: "full", // "full" | "residual"
  emitMode: "bridge", // "bridge" | "absn"
  kStart: K_FULL,
  ring: null,
  blockSize: 0,
  capacity: 0,
  nPartials: 0,
  carrierFreq: 220,
  pushedTotal: 0,
  pushRejects: 0,
  backend: "uninitialized",
  adapter: null,
  gpu: null,
  producer: null, // bridge mode
  absnPool: null, // absn mode: array of { buffer, busy, blockStartSec, carrierFreq }
  scratch: null, // CPU-fallback bridge mode scratch frame
  // carrierFreq FIFO for bridge mode: pushed at scheduleReadback, shifted in
  // fillScalars so each decoded block carries the freq it was computed at,
  // accounting for the staging-buffer pipeline depth.
  pendingFreqs: [],
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
  if (m.type === "setPartials") { state.nPartials = m.n | 0; return; }
  if (m.type === "stall") {
    state.stallUntil = performance.now() + (m.durationMs ?? 200);
    return;
  }
  if (m.type === "stop") { stop(); return; }
};

function fatal(err) {
  self.postMessage({ type: "fatal", message: err?.message ?? String(err) });
}

async function init(m) {
  state.signalMode = m.signalMode ?? "full";
  state.emitMode = m.emitMode ?? "bridge";
  state.kStart = state.signalMode === "residual" ? K_RESIDUAL : K_FULL;
  state.blockSize = m.blockSize;
  state.capacity = m.capacity;
  state.nPartials = m.nPartials;
  state.carrierFreq = m.carrierFreq ?? 220;

  if (state.emitMode === "bridge") {
    const schema = makeSchema(m.blockSize);
    state.ring = new Bridge(m.sab, m.capacity, schema);
  }

  if (typeof navigator !== "undefined" && navigator.gpu) {
    try { await initGPU(); state.backend = "webgpu"; }
    catch (e) {
      console.warn("[worker.gpu] WebGPU init failed, CPU fallback:", e);
      state.backend = "cpu";
    }
  } else {
    state.backend = "cpu";
  }

  if (state.backend === "cpu" && state.emitMode === "bridge") {
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
  const outBytes = blockSize * 4;

  // Uniforms: see reference-signal.js wgslKernelSource() header for the layout.
  const uniformBuf = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const sampleBuf = device.createBuffer({
    size: outBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const shader = device.createShaderModule({ code: wgslKernelSource(blockSize) });
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

  if (state.emitMode === "bridge") {
    state.producer = new BridgeBlockProducer(device, state.ring, {
      stagingBufferCount: 3,
      // Tag every block with the carrier freq it was computed at. pendingFreqs
      // is filled FIFO at scheduleReadback time (see tickGPUBridge); shifting
      // here pairs each decoded block with the right freq across the staging
      // pipeline depth.
      fillScalars: (frame) => {
        frame.carrierFreq = state.pendingFreqs.length > 0
          ? state.pendingFreqs.shift()
          : state.carrierFreq;
      },
    });
  } else {
    // Manual staging-buffer pool for the naïve ABSN readback path.
    const POOL = 3;
    state.absnPool = [];
    for (let i = 0; i < POOL; i++) {
      state.absnPool.push({
        buffer: device.createBuffer({
          size: outBytes,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        busy: false,
        blockStartSec: 0,
        carrierFreq: 0,
      });
    }
  }
}

function writeUniforms() {
  const g = state.gpu;
  const u = new Float32Array([
    state._blockStartSec,
    state.carrierFreq,
    SAMPLE_RATE,
    state._lfoT,
    state.nPartials,
    state.kStart,
    0,
    0,
  ]);
  g.device.queue.writeBuffer(g.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);
}

// ── Bridge emit (paths C / G) ───────────────────────────────────────────────
function tickGPUBridge(blockStartSec, lfoT) {
  const g = state.gpu;
  const dev = g.device;
  const producer = state.producer;
  if (producer.inFlight() >= producer.capacity()) return false;
  // Keep the ring full via the bridge's 'reject' policy (matches the proven
  // audio-rate / hybrid-residual producer pacing). The ring's steady-state
  // depth (≈ capacity) IS path C's documented block-mode latency floor. We
  // deliberately do NOT throttle on ring occupancy — throttling there starves
  // the ring whenever GPU readback throughput is marginal.
  state._blockStartSec = blockStartSec;
  state._lfoT = lfoT;
  writeUniforms();

  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(g.pipeline);
  pass.setBindGroup(0, g.bindGroup);
  pass.dispatchWorkgroups(Math.ceil(state.blockSize / 64));
  pass.end();
  const scheduled = producer.scheduleReadback(g.sampleBuf, enc);
  if (!scheduled) return false;
  // Record the freq this block was computed at (FIFO, matched in fillScalars).
  state.pendingFreqs.push(state.carrierFreq);
  dev.queue.submit([enc.finish()]);
  producer.flushPending();
  return true;
}

// ── ABSN emit (path B) — naïve manual mapAsync → postMessage ────────────────
function tickGPUAbsn(blockStartSec, lfoT) {
  const g = state.gpu;
  const dev = g.device;
  const slot = state.absnPool.find((s) => !s.busy);
  if (!slot) return false; // all staging buffers in flight — skip this tick.

  state._blockStartSec = blockStartSec;
  state._lfoT = lfoT;
  writeUniforms();

  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(g.pipeline);
  pass.setBindGroup(0, g.bindGroup);
  pass.dispatchWorkgroups(Math.ceil(state.blockSize / 64));
  pass.end();
  enc.copyBufferToBuffer(g.sampleBuf, 0, slot.buffer, 0, g.outBytes);
  dev.queue.submit([enc.finish()]);

  slot.busy = true;
  slot.blockStartSec = blockStartSec;
  slot.carrierFreq = state.carrierFreq;
  const blockIndex = state.pushedTotal;
  slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
    const mapped = slot.buffer.getMappedRange();
    // Copy out of the mapped range into a fresh transferable Float32Array.
    const samples = new Float32Array(state.blockSize);
    samples.set(new Float32Array(mapped, 0, state.blockSize));
    slot.buffer.unmap();
    slot.busy = false;
    state.pushedTotal++;
    self.postMessage(
      {
        type: "block",
        samples,
        blockStartSec: slot.blockStartSec,
        carrierFreq: slot.carrierFreq,
        blockIndex,
      },
      [samples.buffer],
    );
  }).catch((err) => { slot.busy = false; fatal(err); });
  return true;
}

// ── CPU fallback (both emit modes) ──────────────────────────────────────────
function tickCPUBridge(blockStartSec, lfoT) {
  fillSignal(
    state.scratch.samples, state.blockSize, blockStartSec, lfoT,
    state.carrierFreq, state.nPartials, state.kStart,
  );
  state.scratch.blockIndex = BigInt(state.pushedTotal);
  state.scratch.carrierFreq = state.carrierFreq;
  return state.ring.push(state.scratch);
}

function tickCPUAbsn(blockStartSec, lfoT) {
  const samples = new Float32Array(state.blockSize);
  fillSignal(
    samples, state.blockSize, blockStartSec, lfoT,
    state.carrierFreq, state.nPartials, state.kStart,
  );
  const blockIndex = state.pushedTotal;
  state.pushedTotal++;
  self.postMessage(
    { type: "block", samples, blockStartSec, carrierFreq: state.carrierFreq, blockIndex },
    [samples.buffer],
  );
  return true;
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
        const ok = state.emitMode === "bridge"
          ? tickGPUBridge(blockStartSec, lfoT)
          : tickGPUAbsn(blockStartSec, lfoT);
        if (ok) blockIdx++;
        if (state.emitMode === "bridge") {
          state.pushedTotal += state.producer.pollCompleted();
        }
      } else {
        const ok = state.emitMode === "bridge"
          ? tickCPUBridge(blockStartSec, lfoT)
          : tickCPUAbsn(blockStartSec, lfoT);
        if (ok) { if (state.emitMode === "bridge") state.pushedTotal++; blockIdx++; }
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
        signalMode: state.signalMode,
        emitMode: state.emitMode,
        pushRateHz,
        pushRejects: state.pushRejects,
        pushedBlocks: state.pushedTotal,
        nPartials: state.nPartials,
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
