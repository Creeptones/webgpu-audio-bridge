// worklet.js — the four-tier hybrid audio consumer (the demo's centerpiece).
//
// Holds THREE consumer handles, one per non-CPU tier, all over distinct SABs:
//
//   TIER 1  this.inputLane   sample-accurate carrier-control events (~1 µs SAB
//                            writes from the page; drained + applied at each
//                            event's sampleOffset inside the carrier loop).
//   TIER 3  this.consumer    the interleaved stereo GPU residual block ring
//                            (processAddStereo — one atomic stereo quantum).
//   TIER 4  this.macro       a CONTROL-RATE Bridge<S> of SMOOTH macro fields
//                            pulled with pullPredictedLatest so each macro is
//                            rendered where it WILL BE once the block is heard.
//
// Tier 2 (the CPU carrier) is just the per-sample sawtooth loop this worklet
// already runs — it owns the latency-critical fundamental + pitch.
//
// ── The headline: tier 4 (predictive smooth macros) ───────────────────────
//
// Each quantum we pull the macro bridge ONCE with pullPredictedLatest, leading
// every trajectory field forward by the measured GPU-readback wall
// (lastReadbackMedianMs, fed from the worker via main.js → recordReadbackLatency).
// The result: the cutoff sweep and the spatial azimuth track the gesture with
// "<5 ms feel" even though the GPU residual the cutoff modulates is still ~85 ms
// behind — the PERCEIVED control surface (carrier pitch + macro envelopes) is
// current; only the spectral BODY lags, inside the perceptual integration window.
//
//   - cutoff  → a control-rate one-pole low-pass on the carrier+residual mix.
//   - azimuth → an equal-power L/R pan of the whole mix (tier-3 "space" driven
//               predictively by tier 4 — no GPU round-trip for the pan gesture).
//
// SAFE BY CONSTRUCTION. pullPredictedLatest only leads when the PLL is warm and
// confident; a cold/jittery clock collapses to a plain latest-frame hold. We
// pass consumerNs every quantum so this is the SOLE observe that warms the PLL,
// and a confidenceFloor so a contended thread holds rather than wobbles. The
// carrier (tiers 1+2) is unaffected either way — we NEVER predict pitch.

import {
  Bridge,
  BridgeBlockConsumer,
  BridgeInputLane,
  SpscRing,
} from "../../dist/index.js";
import {
  EVENT_DRAIN_PER_QUANTUM,
  EVT_FREQ,
  EVT_GAIN,
  makeBlockSchema,
  makeInputSchema,
  makeMacroSchema,
} from "./schema.js";

// Tier-4 predictive-pull tuning. The lead is sourced live from the readback
// median; these are the guardrails around it.
const MACRO_MAX_LEAD_MS = 20;      // hard horizon ceiling (≡ the method default)
const MACRO_CONFIDENCE_FLOOR = 0.25; // jittery clock → hold, don't wobble
const CUTOFF_MIN_HZ = 40;
const CUTOFF_MAX_HZ = 18000;

class HybridFourTierProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const {
      sab, capacity, blockSize, channels,
      inputSab, inputCapacity,
      macroSab, macroCapacity,
      carrierFreq,
    } = options.processorOptions;

    // ── Tier 3: stereo residual block consumer ──
    const schema = makeBlockSchema(blockSize, channels);
    const bridge = new Bridge(sab, capacity, schema);
    this.consumer = new BridgeBlockConsumer(bridge, {
      channels,
      layout: "interleaved",
    });

    // ── Tier 1: sample-accurate carrier-control input lane ──
    const inputSchema = makeInputSchema();
    this.inputRing = new SpscRing(inputSab, inputCapacity, inputSchema);
    this.inputLane = new BridgeInputLane(this.inputRing);
    this.events = this.inputLane.scratchEventBuffer(EVENT_DRAIN_PER_QUANTUM);
    this.inputDrained = 0;

    // ── Tier 4: smooth-macro predictive bridge ──
    this.macro = new Bridge(macroSab, macroCapacity, makeMacroSchema());
    this.macroOut = this.macro.scratchEvaluatedFrame();
    // Seed sensible defaults so a cold start (no macro frame yet — the empty
    // pull leaves `out` untouched) renders an OPEN filter, centered, not silence.
    this.macroOut.cutoff[0] = CUTOFF_MAX_HZ;
    this.macroOut.azimuth[0] = 0;
    this.macroOut.morph[0] = 0;
    // The live lead source, fed by main.js relaying the worker's lastReadbackUs.
    // 0 until the first sample lands → pullPredictedLatest behaves as pullLatest.
    this.macroLeadMs = 0;
    // One-pole low-pass state (cutoff macro), persisted across quanta.
    this.lpL = 0;
    this.lpR = 0;
    // Last tier-4 diagnostics for the status panel.
    this.macroPredicted = false;
    this.macroWeight = 0;

    // ── Tier 2: CPU carrier (sawtooth) state ──
    this.carrierFreq = isFinite(carrierFreq) ? carrierFreq : 220;
    this.carrierPhase = 0;
    this.carrierGain = 0.25;
    this.residualGain = 0.5;
    this.mode = "hybrid";
    // A/B switch for the headline: when false, force leadMs = 0 so tier 4
    // degrades to a plain pullLatest (the smooth macros lag the gesture). Toggle
    // it live to hear the cutoff sweep / pan "snap forward" onto the gesture.
    this.predictEnabled = true;

    this.framesSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      // The worker's measured GPU readback wall, relayed by main.js. This is
      // the lead source for tier 4 (handoff §3.3): readback latency is
      // producer-side-measured by construction; the PLL can't recover it.
      if (m.type === "readback") {
        const us = m.us;
        if (typeof us === "number" && isFinite(us) && us >= 0) {
          this.macro.recordReadbackLatency(us / 1000); // µs → ms
        }
        return;
      }
      if (m.type !== "config") return;
      // carrierFreq / residualGain ride the input lane (tier 1); only the
      // control-plane toggles are non-sample-timed and ride postMessage.
      if (typeof m.mode === "string") this.mode = m.mode;
      if (typeof m.predict === "boolean") this.predictEnabled = m.predict;
    };
  }

  // Drain + offset-sort the tier-1 carrier-control events (identical pattern to
  // examples/hybrid-residual/worklet.js). Allocation-free; scratch reused.
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
    const L = outputs[0][0];
    const R = outputs[0][1];
    const N = L.length;

    // ── TIER 4: predictive smooth-macro pull (ONCE per quantum) ──
    // This is the sole per-quantum observe of the macro bridge, so passing
    // consumerNs warms its PLL. leadMs is the live readback median; with a warm,
    // confident clock each macro is rendered leadMs into the future (cancelling
    // the perceived readback wall for the smooth layer).
    const macroLead = this.predictEnabled ? this.macroLeadMs : 0;
    const r = this.macro.pullPredictedLatest(this.macroOut, {
      leadMs: macroLead,
      maxLeadMs: MACRO_MAX_LEAD_MS,
      confidenceFloor: MACRO_CONFIDENCE_FLOOR,
      consumerNs: currentTime * 1e9,
    });
    this.macroPredicted = r.predicted;
    this.macroWeight = r.confidenceWeight;
    // Clamp the predicted cutoff to an audible, stable range. On a cold start
    // (out untouched) this is the seeded CUTOFF_MAX_HZ → open filter.
    let cutoffHz = this.macroOut.cutoff[0];
    if (!(cutoffHz >= CUTOFF_MIN_HZ)) cutoffHz = CUTOFF_MIN_HZ;
    if (cutoffHz > CUTOFF_MAX_HZ) cutoffHz = CUTOFF_MAX_HZ;
    let azimuth = this.macroOut.azimuth[0];
    if (!(azimuth >= -1)) azimuth = -1;
    if (azimuth > 1) azimuth = 1;

    // ── TIER 1: drain sample-accurate carrier-control events ──
    const evCount = this.drainEvents(N);

    // ── TIER 2: CPU carrier (mono fundamental into L + R), honoring freq
    //    changes at their sample offsets. "replace" zeroes both channels but
    //    still advances phase + consumes events so re-enabling resumes cleanly.
    let phase = this.carrierPhase;
    let freq = this.carrierFreq;
    let dphi = freq / sampleRate;
    let nextEv = 0;
    const writeCarrier = this.mode !== "replace";
    const g = this.carrierGain;
    for (let i = 0; i < N; i++) {
      while (nextEv < evCount && this.events[nextEv].sampleOffset <= i) {
        const ev = this.events[nextEv++];
        if (ev.eventType === EVT_FREQ) {
          freq = ev.value0;
          dphi = freq / sampleRate;
        } else if (ev.eventType === EVT_GAIN) {
          this.residualGain = ev.value0;
        }
      }
      const s = writeCarrier ? (2 * phase - 1) * g : 0;
      L[i] = s;
      R[i] = s;
      phase += dphi;
      if (phase >= 1) phase -= 1;
    }
    this.carrierPhase = phase;
    this.carrierFreq = freq;
    if (this.mode === "replace") { L.fill(0); R.fill(0); }

    // ── TIER 3: fold the interleaved stereo GPU residual on top (one atomic
    //    stereo quantum — cursor advances ONCE). "carrier-only" skips it.
    if (this.mode === "hybrid" || this.mode === "replace") {
      this.consumer.processAddStereo(L, R, this.residualGain);
    }

    // ── TIER 4 application: cutoff one-pole LPF, then equal-power azimuth pan.
    //    Control-rate: one coefficient + one pan gain per quantum (the macro is
    //    smooth, so per-quantum granularity is inaudible). The cutoff value is
    //    already led forward, so the timbre tracks the gesture predictively.
    const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
    let yL = this.lpL;
    let yR = this.lpR;
    // Equal-power pan: azimuth −1 (hard left) .. +1 (hard right); 0 = centered
    // at −3 dB per channel.
    const panAngle = (azimuth + 1) * (Math.PI / 4);
    const gainL = Math.cos(panAngle);
    const gainR = Math.sin(panAngle);
    for (let i = 0; i < N; i++) {
      yL += a * (L[i] - yL);
      yR += a * (R[i] - yR);
      L[i] = yL * gainL;
      R[i] = yR * gainR;
    }
    this.lpL = yL;
    this.lpR = yR;

    // ── Diagnostics ~4×/sec (incl. tier-4 telemetry so the panel shows the
    //    predictive layer engaging). ──
    this.framesSinceReport += N;
    if (this.framesSinceReport >= sampleRate / 4) {
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
        inputDrained: this.inputDrained,
        peakL,
        peakR,
        // Tier-4 observability.
        macroLeadMs: macroLead,
        macroPredicted: this.macroPredicted,
        macroWeight: this.macroWeight,
        cutoffHz,
        azimuth,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("hybrid-four-tier-consumer", HybridFourTierProcessor);
