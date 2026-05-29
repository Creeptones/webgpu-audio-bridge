// worklet.js — the STEREO hybrid-residual audio consumer.
//
// Carries a CPU SAWTOOTH at slider-controlled fundamental frequency into BOTH
// output channels (with a tiny L/R detune for carrier width), then folds the
// GPU-computed INTERLEAVED stereo residual on top via
// BridgeBlockConsumer.processAddStereo(out[0], out[1], gain).
//
// Three modes for A/B comparison (same as the mono demo):
//
//   "hybrid"       — carrier into L+R, then processAddStereo (residual on top).
//                    Mode-default; the headline.
//   "replace"      — zero L+R, then processAddStereo onto the zeroed buffers
//                    (residual layer alone — recognizably the same notes with
//                    the bass missing). Open-decision-C: no separate replacing
//                    stereo method; zero-then-add is the documented pattern.
//   "carrier-only" — carrier sawtooth, no residual call.
//
// Stall handling: "hybrid" keeps emitting the carrier on BOTH channels when
// the producer pauses (upper harmonics fade, fundamental survives, no click);
// "replace" goes silent. processAddStereo's underflow contract leaves BOTH
// L and R untouched on ring-empty — the carrier survives per channel.

import { Bridge, BridgeBlockConsumer } from "../../dist/index.js";
import { makeSchema } from "./schema.js";

class HybridResidualStereoProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, capacity, blockSize, channels } = options.processorOptions;
    const schema = makeSchema(blockSize, channels);
    const bridge = new Bridge(sab, capacity, schema);
    this.consumer = new BridgeBlockConsumer(bridge, {
      channels,
      layout: "interleaved",
    });

    // CPU carrier: sawtooth with a tiny L/R detune for carrier-side width.
    this.carrierFreq = 220;
    this.carrierPhaseL = 0;
    this.carrierPhaseR = 0;
    this.carrierGain = 0.25;
    this.carrierDetune = 1.0015;   // right channel ~0.15% sharp → subtle width
    this.residualGain = 0.5;
    this.mode = "hybrid";

    this.framesSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type !== "config") return;
      if (typeof m.carrierFreq === "number" && isFinite(m.carrierFreq)) {
        this.carrierFreq = m.carrierFreq;
      }
      if (typeof m.residualGain === "number" && isFinite(m.residualGain)) {
        this.residualGain = m.residualGain;
      }
      if (typeof m.mode === "string") this.mode = m.mode;
    };
  }

  process(_inputs, outputs) {
    const L = outputs[0][0];
    const R = outputs[0][1];
    const N = L.length;

    // 1. Carrier into L + R (skipped/zeroed for "replace").
    const dphiL = this.carrierFreq / sampleRate;
    const dphiR = (this.carrierFreq * this.carrierDetune) / sampleRate;
    let pL = this.carrierPhaseL;
    let pR = this.carrierPhaseR;
    if (this.mode === "replace") {
      // Zero both channels, then processAddStereo below overwrites-by-adding.
      L.fill(0);
      R.fill(0);
      // Still advance phase so re-enabling hybrid resumes cleanly.
      pL = (pL + dphiL * N) % 1;
      pR = (pR + dphiR * N) % 1;
    } else {
      const g = this.carrierGain;
      for (let i = 0; i < N; i++) {
        L[i] = (2 * pL - 1) * g;
        R[i] = (2 * pR - 1) * g;
        pL += dphiL; if (pL >= 1) pL -= 1;
        pR += dphiR; if (pR >= 1) pR -= 1;
      }
    }
    this.carrierPhaseL = pL;
    this.carrierPhaseR = pR;

    // 2. Residual — one atomic stereo quantum (channel 0 → L, channel 1 → R,
    //    cursor advances ONCE). "carrier-only" skips it.
    if (this.mode === "hybrid" || this.mode === "replace") {
      this.consumer.processAddStereo(L, R, this.residualGain);
    }

    // 3. Diagnostics ~4×/sec.
    this.framesSinceReport += N;
    if (this.framesSinceReport >= sampleRate / 4) {
      // Cheap per-channel peak for the L/R meter.
      let peakL = 0, peakR = 0;
      for (let i = 0; i < N; i++) {
        const al = L[i] < 0 ? -L[i] : L[i];
        const ar = R[i] < 0 ? -R[i] : R[i];
        if (al > peakL) peakL = al;
        if (ar > peakR) peakR = ar;
      }
      this.port.postMessage({
        type: "diag",
        mode: this.mode,
        framesConsumed: this.consumer.framesConsumed(),
        underflowSamples: this.consumer.underflowSamples(),
        carrierFreq: this.carrierFreq,
        residualGain: this.residualGain,
        peakL,
        peakR,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("hybrid-residual-stereo-consumer", HybridResidualStereoProcessor);
