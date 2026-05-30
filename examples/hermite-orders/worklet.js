// worklet.js — the audio-rate consumer + A/B reconstructor.
//
// ─── Why this demo reconstructs MANUALLY, not via pullHermiteLatest ─────────
//
// 0.9.84 shipped `Bridge.pullHermiteLatest` — the one-call convenience path. It
// is a MINIMUM-LATENCY *freshest-interpolation* primitive: it always pulls the
// newest frame, drives the PLL, and interpolates between the two NEWEST frames
// with `t` clamped to [0, 1]. For a fast consumer (375 Hz quanta) against a
// slow producer (24–60 Hz control), the PLL locks the consumer "now" to the
// newest producer frame, so `t` pins to the segment BOUNDARY (≈ 1) — and at a
// boundary cubic, quintic, and septic all return the same endpoint value. The
// C²/C³ benefit lives strictly on the segment INTERIOR (`t ∈ (0, 1)`), so
// pullHermiteLatest structurally can't expose it. (Verified empirically: a
// constant interpolation lag is absorbed by the PLL within its lock time, so no
// lag fraction rescues it.)
//
// To make the order difference audible we deliberately add ~1.35 control
// periods of INTERPOLATION LATENCY: we render the producer time
// `phaseLockedTime(now) − LATENCY`, then interpolate the COMPLETED segment that
// brackets it — `t` sweeps the full interior. This is exactly the regime the
// 0.9.85 FFT spectral pin measures (cubic −44 dB → quintic −78 dB → septic
// −111 dB image-band rolloff). The PLL still does its real job: aligning the
// producer's wall clock to the audio-render clock (different origins).
//
// ─── Signal path ────────────────────────────────────────────────────────────
//
// The reconstructed value IS the instantaneous frequency of a sine carrier
// (classic FM zipper territory). A phase accumulator integrates it per sample;
// the only thing the A/B toggle changes is which Hermite evaluator fills the
// per-sample frequency, so the seam-continuity order is the sole variable you
// hear (and see, in main.js's spectrum).

import {
  Bridge,
  evaluateHermiteTrajectoryInto,
  evaluateQuinticHermiteTrajectoryInto,
  evaluateSepticHermiteTrajectoryInto,
} from "../../dist/index.js";
import { makeSchema, CAPACITY } from "./schema.js";

const TWO_PI = Math.PI * 2;
const SPEC = { order: 4, sampleCount: 1 };
const HISTORY_MAX = 8;          // newest few control frames kept for bracketing
const LATENCY_PERIODS = 1.35;   // interpolation latency, in control periods
const AMP = 0.18;

// activeOrder: 0 = cubic (C¹), 1 = quintic (C²), 2 = septic (C³).
const EVALUATORS = [
  evaluateHermiteTrajectoryInto,
  evaluateQuinticHermiteTrajectoryInto,
  evaluateSepticHermiteTrajectoryInto,
];

class HermiteOrderConsumer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab } = options.processorOptions;
    this.bridge = new Bridge(sab, CAPACITY, makeSchema());
    this.temp = this.bridge.scratchFrame();

    // Frame history: parallel arrays of producer-clock timestamps (ns) and the
    // flat order-4 payloads, newest last. Pre-allocated; no per-quantum alloc.
    this.histTs = [];
    this.histSig = [];

    this.out = new Float64Array(1);
    this.phase = 0;
    this.lastFreq = 0;
    this.activeOrder = 2; // start on septic (cleanest)

    // diag
    this.framesSinceReport = 0;
    this.interiorHits = 0;
    this.totalHits = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "order" && m.order >= 0 && m.order <= 2) {
        this.activeOrder = m.order;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const sr = sampleRate;
    const quantumStartNs = currentTime * 1e9;

    // Drain newly-arrived control frames; drive the PLL once per fresh frame
    // (pairing the producer timestamp with the quantum-start consumer time) and
    // append to the bracketing history.
    while (this.bridge.pull(this.temp)) {
      const ts = Number(this.temp.tMacroNs);
      this.bridge.observeConsumerTime(quantumStartNs, ts);
      this.histTs.push(ts);
      this.histSig.push(Float64Array.from(this.temp.freq));
      if (this.histTs.length > HISTORY_MAX) {
        this.histTs.shift();
        this.histSig.shift();
      }
    }

    const n = out.length;
    const h = this.histTs.length;
    if (h < 2) {
      // Not enough frames to interpolate a segment yet — emit silence.
      out.fill(0);
      return true;
    }

    // Adaptive latency = a fixed number of CURRENT control periods, so the
    // demo stays interior across the whole control-rate slider range.
    const newestSeg = this.histTs[h - 1] - this.histTs[h - 2];
    const latencyNs = LATENCY_PERIODS * newestSeg;
    const evalInto = EVALUATORS[this.activeOrder];

    for (let i = 0; i < n; i++) {
      const consumerNs = quantumStartNs + (i / sr) * 1e9;
      const renderTime = this.bridge.phaseLockedTime(consumerNs) - latencyNs;

      // Bracket renderTime in the history → the completed segment [A, B].
      let s = -1;
      for (let k = 0; k + 1 < h; k++) {
        if (this.histTs[k] <= renderTime && renderTime < this.histTs[k + 1]) {
          s = k;
          break;
        }
      }

      let freq = this.lastFreq;
      if (s >= 0) {
        const tsA = this.histTs[s];
        const seg = this.histTs[s + 1] - tsA;
        let t = (renderTime - tsA) / seg;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        evalInto(this.histSig[s], this.histSig[s + 1], SPEC, t, seg * 1e-9, this.out);
        freq = this.out[0];
        this.totalHits++;
        if (t > 0.05 && t < 0.95) this.interiorHits++;
      }
      this.lastFreq = freq;

      // Integrate instantaneous frequency → carrier phase → sample.
      this.phase += (TWO_PI * freq) / sr;
      if (this.phase > TWO_PI) this.phase -= TWO_PI;
      out[i] = Math.sin(this.phase) * AMP;
    }

    this.framesSinceReport += n;
    if (this.framesSinceReport >= sr / 4) {
      this.port.postMessage({
        type: "diag",
        activeOrder: this.activeOrder,
        interiorFrac: this.totalHits ? this.interiorHits / this.totalHits : 0,
        latencyMs: latencyNs * 1e-6,
        historyDepth: h,
      });
      this.framesSinceReport = 0;
      this.interiorHits = 0;
      this.totalHits = 0;
    }
    return true;
  }
}

registerProcessor("hermite-order-consumer", HermiteOrderConsumer);
