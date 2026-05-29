// worklet.js — the hybrid-residual audio consumer.
//
// Carries a CPU SAWTOOTH at a fundamental frequency driven by SAMPLE-ACCURATE
// control events (0.9.49), then folds the GPU-computed harmonic-partial
// residual on top via BridgeBlockConsumer.processAdd. Three modes for A/B
// comparison:
//
// ── Sample-accurate carrier control (0.9.49) ──────────────────────────────
//
// Carrier frequency and residual gain are NOT driven by postMessage anymore.
// The main thread writes each slider tick straight into a dedicated input SAB
// via BridgeInputLane; this worklet drains every unread event at the top of
// each quantum (`inputLane.pullAll`) and applies each one at its sampleOffset
// inside the per-sample carrier loop. Result: the carrier's pitch follows the
// slider within ONE quantum (~2.7 ms), bounded by the audio output buffer
// alone — never by MessagePort delivery cadence. The GPU residual still rides
// the ~85 ms block-mode floor; that asymmetry is the headline claim made
// audible: "GPU residual may lag; carrier control does not."
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
  makeInputSchema,
  makeSchema,
} from "./schema.js";

class HybridResidualProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const {
      sab,
      capacity,
      blockSize,
      inputSab,
      inputCapacity,
      carrierFreq,
      residualGain,
    } = options.processorOptions;
    const schema = makeSchema(blockSize);
    const bridge = new Bridge(sab, capacity, schema);
    this.consumer = new BridgeBlockConsumer(bridge, {
      underflowPolicy: "zero-fill",
    });

    // Input lane: the sample-accurate carrier-control path. The main thread
    // holds the producer side over the same SAB; we hold the consumer side
    // and drain it per quantum. `events` is a fixed-size reusable scratch
    // buffer — zero allocation in process().
    const inputSchema = makeInputSchema();
    this.inputRing = new SpscRing(inputSab, inputCapacity, inputSchema);
    this.inputLane = new BridgeInputLane(this.inputRing);
    this.events = this.inputLane.scratchEventBuffer(EVENT_DRAIN_PER_QUANTUM);
    this.inputDrained = 0;

    // CPU carrier: simple anti-bandlimited (i.e. unfiltered, for demo
    // simplicity) sawtooth. Phase carried across process() calls so the
    // waveform is continuous regardless of how the upper layers behave.
    // Initial freq/gain come through processorOptions so the carrier starts
    // at the slider values; all subsequent changes arrive on the input lane.
    this.carrierFreq = isFinite(carrierFreq) ? carrierFreq : 220;
    this.carrierPhase = 0;
    this.carrierGain = 0.25;
    this.residualGain = isFinite(residualGain) ? residualGain : 0.5;
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
      // carrierFreq / residualGain are NO LONGER accepted here — they arrive
      // sample-accurately on the input lane (see process()). Only the
      // control-plane toggles (which aren't sample-timed) ride postMessage.
      if (typeof m.mode === "string") this.mode = m.mode;
      if (typeof m.enableRms === "boolean") this.enableRms = m.enableRms;
    };
  }

  // Drain every unread carrier-control event into this.events[], clamp each
  // event's sampleOffset into [0, N-1], and sort the batch by offset so the
  // carrier loop can apply changes in a single forward pass. Returns the
  // count drained. Allocation-free; the scratch buffer is reused every call.
  drainEvents(N) {
    const n = this.inputLane.pullAll(this.events);
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) {
      const ev = this.events[i];
      let off = ev.sampleOffset >>> 0;
      if (off >= N) off = N - 1;
      ev.sampleOffset = off;
    }
    // Insertion sort — n is bounded by EVENT_DRAIN_PER_QUANTUM and is tiny.
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

    // 0. Drain sample-accurate carrier-control events. Each freq event
    //    retunes the carrier mid-quantum at its sampleOffset; each gain event
    //    updates the residual mix (quantum-granular — the residual is a block
    //    layer, so the last gain in the quantum wins). No postMessage hop.
    const evCount = this.drainEvents(N);

    // 1. Carrier into out[], honoring frequency changes at their offsets.
    //    The per-sample loop walks the sorted event list in lockstep: when
    //    sample index i reaches an event's offset, the change applies before
    //    that sample is emitted. "replace" mode skips the write (process()
    //    below overwrites out anyway) but still advances phase + consumes
    //    events so re-enabling hybrid mode resumes cleanly.
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
      if (writeCarrier) out[i] = (2 * phase - 1) * g;
      phase += dphi;
      if (phase >= 1) phase -= 1;
    }
    this.carrierPhase = phase;
    this.carrierFreq = freq;

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
        inputDrained: this.inputDrained,
        rmsSqAccum: this.rmsSqAccum,
        rmsSinceReport: this.rmsSinceReport,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("hybrid-residual-consumer", HybridResidualProcessor);
