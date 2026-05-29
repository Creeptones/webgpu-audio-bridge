// worklet.hybrid.js — PATH G: hybrid carrier + GPU residual (the pattern
// under test).
//
// The CPU synthesises the fundamental (k=1 sine, phase-accumulated, retuned
// SAMPLE-ACCURATELY from the input lane) straight into `out`, then folds the
// GPU-computed residual (partials k≥2, worker.gpu.js "residual" mode) on top
// via BridgeBlockConsumer.processAdd. By construction the sum reproduces the
// SAME full signal paths A and C render monolithically (carrier = FUND_AMP·sin,
// residual already carries OUT_SCALE, so the carrier is pre-scaled by
// FUND_AMP·OUT_SCALE and processAdd's gain is 1).
//
// The headline: G is the only path that wins BOTH columns at once.
//   - Control latency: the carrier retunes within one quantum (input lane),
//     so G's latency matches path A's — the audio-buffer floor, NOT the block
//     floor. We record (appliedEpochNs − tInputNs) at each event's offset,
//     exactly like path A. (The GPU residual still lags ~85 ms, but the
//     residual's pitch isn't the control-latency the ear locks onto.)
//   - Stall continuity: processAdd leaves out[]'s tail UNTOUCHED on underflow,
//     so the carrier survives a GPU stall — RMS stays near the carrier floor
//     instead of collapsing to zero like path C.

import { Bridge, BridgeBlockConsumer, BridgeInputLane, SpscRing } from "../../dist/index.js";
import {
  EVENT_DRAIN_PER_QUANTUM,
  EVT_FREQ,
  EVT_GAIN,
  makeInputSchema,
  makeSchema,
} from "./schema.js";
import { FUND_AMP, OUT_SCALE } from "./reference-signal.js";
import { LatencyHistogram } from "./histogram.js";

const TWO_PI = Math.PI * 2;

class HybridProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const {
      sab, capacity, blockSize, inputSab, inputCapacity, audioStartPerfMs, carrierFreq,
    } = options.processorOptions;

    const schema = makeSchema(blockSize);
    const bridge = new Bridge(sab, capacity, schema);
    this.consumer = new BridgeBlockConsumer(bridge, { underflowPolicy: "zero-fill" });

    const inputSchema = makeInputSchema();
    this.inputRing = new SpscRing(inputSab, inputCapacity, inputSchema);
    this.inputLane = new BridgeInputLane(this.inputRing);
    this.events = this.inputLane.scratchEventBuffer(EVENT_DRAIN_PER_QUANTUM);
    this.inputDrained = 0;

    this.f0 = isFinite(carrierFreq) ? carrierFreq : 220;
    this.phase = 0; // carrier (k=1) phase accumulator, cycles.
    this.carrierGain = FUND_AMP * OUT_SCALE;
    this.residualGain = 1.0; // residual already includes OUT_SCALE.

    this.audioStartPerfNs = audioStartPerfMs * 1e6;
    this.hist = new LatencyHistogram();
    this.hasPerf = typeof performance !== "undefined" && typeof performance.now === "function";
    this.procHist = new LatencyHistogram();

    this.enableRms = false;
    this.rmsSqAccum = 0;
    this.rmsSinceReport = 0;
    this.framesSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "rms-reset") { this.rmsSqAccum = 0; this.rmsSinceReport = 0; return; }
      if (m.type === "latency-reset") { this.hist.reset(); return; }
      if (m.type !== "config") return;
      if (typeof m.enableRms === "boolean") this.enableRms = m.enableRms;
    };
  }

  drainEvents(N) {
    const n = this.inputLane.pullAll(this.events);
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) {
      const ev = this.events[i];
      let off = ev.sampleOffset >>> 0;
      if (off >= N) off = N - 1;
      ev.sampleOffset = off;
    }
    for (let i = 1; i < n; i++) {
      const ev = this.events[i];
      let j = i;
      while (j > 0 && this.events[j - 1].sampleOffset > ev.sampleOffset) {
        this.events[j] = this.events[j - 1];
        j--;
      }
      this.events[j] = ev;
    }
    this.inputDrained += n;
    return n;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const N = out.length;
    const tProc0 = this.hasPerf ? performance.now() : 0;
    const evCount = this.drainEvents(N);

    // 1. Carrier (fundamental sine) into out[], retuning at event offsets.
    let phase = this.phase;
    let f0 = this.f0;
    let dphi = f0 / sampleRate;
    let nextEv = 0;
    const g = this.carrierGain;
    for (let i = 0; i < N; i++) {
      while (nextEv < evCount && this.events[nextEv].sampleOffset <= i) {
        const ev = this.events[nextEv++];
        if (ev.eventType === EVT_FREQ) {
          f0 = ev.value0;
          dphi = f0 / sampleRate;
          const appliedEpochNs =
            this.audioStartPerfNs + (currentTime + i / sampleRate) * 1e9;
          this.hist.record(appliedEpochNs - Number(ev.tInputNs));
        } else if (ev.eventType === EVT_GAIN) {
          this.residualGain = ev.value0;
        }
      }
      out[i] = Math.sin(TWO_PI * phase) * g;
      phase += dphi;
      if (phase >= 1) phase -= 1;
    }
    this.phase = phase;
    this.f0 = f0;

    // 2. Fold the GPU residual on top (carrier survives underflow).
    this.consumer.processAdd(out, this.residualGain);

    if (this.hasPerf) this.procHist.record((performance.now() - tProc0) * 1e6);

    if (this.enableRms) {
      let sq = 0;
      for (let i = 0; i < N; i++) { const x = out[i]; sq += x * x; }
      this.rmsSqAccum += sq;
      this.rmsSinceReport += N;
    }

    this.framesSinceReport += N;
    if (this.framesSinceReport >= sampleRate / 4) {
      const h = this.hist.snapshot();
      this.port.postMessage({
        type: "diag",
        path: "G",
        carrierFreq: this.f0,
        framesConsumed: this.consumer.framesConsumed(),
        underflowSamples: this.consumer.underflowSamples(),
        inputDrained: this.inputDrained,
        latency: h,
        procDuration: this.hasPerf ? this.procHist.snapshot() : null,
        rmsSqAccum: this.rmsSqAccum,
        rmsSinceReport: this.rmsSinceReport,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("comparator-hybrid", HybridProcessor);
