// worklet.js — the hybrid-residual audio consumer.
//
// Carries a CPU SAWTOOTH at slider-controlled fundamental frequency,
// then folds the GPU-computed harmonic-partial residual on top via
// BridgeBlockConsumer.processAdd. Three modes for A/B comparison:
//
//   "hybrid"       — carrier first, then processAdd (residual sums on top).
//                    Mode-default; the headline.
//   "replace"      — no carrier; process() overwrites out with ring contents.
//                    The pure block-mode comparator. With residual-only
//                    output (no fundamental), the signal is the partial
//                    layer alone — recognizable as the SAME notes but
//                    with the bass missing.
//   "carrier-only" — carrier sawtooth, no residual call. Useful as a
//                    reference for what the CPU layer alone sounds like.
//
// Stall handling: when the producer pauses (user clicks "Simulate GPU
// stall"), "hybrid" mode keeps emitting the carrier (audible degradation:
// the upper harmonics fade out, the fundamental keeps going), while
// "replace" mode zero-fills (audible click / silence). The diag counter
// `underflowSamples` ticks identically in both — semantic difference is
// what `out` looks like during the stall, not what the counter shows.

import { Bridge, BridgeBlockConsumer } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

class HybridResidualProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, capacity, blockSize } = options.processorOptions;
    const schema = makeSchema(blockSize);
    const bridge = new Bridge(sab, capacity, schema);
    this.consumer = new BridgeBlockConsumer(bridge, {
      underflowPolicy: "zero-fill",
    });

    // CPU carrier: simple anti-bandlimited (i.e. unfiltered, for demo
    // simplicity) sawtooth. Phase carried across process() calls so the
    // waveform is continuous regardless of how the upper layers behave.
    this.carrierFreq = 220;
    this.carrierPhase = 0;
    this.carrierGain = 0.25;
    this.residualGain = 0.5;
    this.mode = "hybrid";

    // Diagnostics.
    this.framesSinceReport = 0;
    // Output RMS instrumentation — sums x² across `rmsSinceReport` samples
    // and is consumed by the bench page to demonstrate "carrier survives
    // GPU stall" quantitatively. Zero-cost in steady state (one mul-add
    // per sample), opt-in via `enableRms` config.
    this.enableRms = false;
    this.rmsSqAccum = 0;
    this.rmsSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "rms-reset") {
        this.rmsSqAccum = 0;
        this.rmsSinceReport = 0;
        return;
      }
      if (m.type !== "config") return;
      if (typeof m.carrierFreq === "number" && isFinite(m.carrierFreq)) {
        this.carrierFreq = m.carrierFreq;
      }
      if (typeof m.residualGain === "number" && isFinite(m.residualGain)) {
        this.residualGain = m.residualGain;
      }
      if (typeof m.mode === "string") this.mode = m.mode;
      if (typeof m.enableRms === "boolean") this.enableRms = m.enableRms;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const N = out.length;

    // 1. Carrier into out[].
    const dphi = this.carrierFreq / sampleRate;
    let phase = this.carrierPhase;
    if (this.mode === "replace") {
      // Pure block-mode comparator: no carrier write. process() below
      // overwrites out anyway. Still advance phase so re-enabling hybrid
      // mode resumes cleanly.
      phase = (phase + dphi * N) % 1;
    } else {
      const g = this.carrierGain;
      for (let i = 0; i < N; i++) {
        out[i] = (2 * phase - 1) * g;
        phase += dphi;
        if (phase >= 1) phase -= 1;
      }
    }
    this.carrierPhase = phase;

    // 2. Residual.
    if (this.mode === "replace") {
      this.consumer.process(out);
    } else if (this.mode === "hybrid") {
      this.consumer.processAdd(out, this.residualGain);
    }
    // "carrier-only" mode: skip both — carrier alone is the output.

    // 2b. Optional RMS accumulation (bench-side instrumentation).
    if (this.enableRms) {
      let sq = 0;
      for (let i = 0; i < N; i++) {
        const x = out[i];
        sq += x * x;
      }
      this.rmsSqAccum += sq;
      this.rmsSinceReport += N;
    }

    // 3. Diagnostics ~4×/sec.
    this.framesSinceReport += N;
    if (this.framesSinceReport >= sampleRate / 4) {
      this.port.postMessage({
        type: "diag",
        mode: this.mode,
        framesConsumed: this.consumer.framesConsumed(),
        underflowSamples: this.consumer.underflowSamples(),
        carrierFreq: this.carrierFreq,
        residualGain: this.residualGain,
        rmsSqAccum: this.rmsSqAccum,
        rmsSinceReport: this.rmsSinceReport,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("hybrid-residual-consumer", HybridResidualProcessor);
