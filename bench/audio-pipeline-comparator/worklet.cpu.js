// worklet.cpu.js — PATH A: pure-CPU AudioWorklet additive synth.
//
// No SAB block ring, no worker, no GPU. The entire reference signal
// (fundamental + N LFO-modulated partials, reference-signal.js) is synthesised
// per-sample inside process(). Carrier frequency is driven SAMPLE-ACCURATELY
// through the same BridgeInputLane the hybrid demo uses, so path A's control
// latency is the audio-quantum floor — its weakness is NOT latency, it is the
// O(N) per-sample CPU cost that caps the sustainable partial count.
//
// Latency metric: each freq event carries tInputNs (absolute Unix-epoch ns).
// When the per-sample loop applies the change at its sampleOffset, we convert
// that apply instant into the same epoch space (audioStartPerfNs + (currentTime
// + sampleOffset/sampleRate)·1e9) and record (applied − tInput) in a shared
// LatencyHistogram. See bench/e2e-latency for the clock-alignment derivation;
// performance.now() is NOT called inside the worklet (not reliably exposed).
//
// Phase handling: each partial is a phase accumulator, so a freq change retunes
// continuously (no phase discontinuity). The partial AMPLITUDES (1/k · LFO) are
// computed once per quantum — the 0.3 Hz LFO is sub-quantum-static — leaving the
// per-sample inner loop at exactly N sines, which is the cost the bench measures.

import { BridgeInputLane, SpscRing } from "../../dist/index.js";
import {
  EVENT_DRAIN_PER_QUANTUM,
  EVT_FREQ,
  makeInputSchema,
} from "./schema.js";
import { FUND_AMP, OUT_SCALE, partialAmp } from "./reference-signal.js";
import { LatencyHistogram } from "./histogram.js";

const MAX_PARTIALS = 4096; // phase/amp/dphi array sizing ceiling.
const TWO_PI = Math.PI * 2;

class CpuAdditiveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const {
      inputSab, inputCapacity, audioStartPerfMs, carrierFreq, nPartials,
    } = options.processorOptions;

    const inputSchema = makeInputSchema();
    this.inputRing = new SpscRing(inputSab, inputCapacity, inputSchema);
    this.inputLane = new BridgeInputLane(this.inputRing);
    this.events = this.inputLane.scratchEventBuffer(EVENT_DRAIN_PER_QUANTUM);
    this.inputDrained = 0;

    this.f0 = isFinite(carrierFreq) ? carrierFreq : 220;
    this.nPartials = nPartials | 0;
    // Index k runs 1..nPartials+1. Element 0 unused.
    this.phase = new Float64Array(MAX_PARTIALS + 2);
    this.dphi = new Float64Array(MAX_PARTIALS + 2);
    this.amps = new Float64Array(MAX_PARTIALS + 2);
    this.frameCounter = 0; // absolute sample index, drives the LFO clock.
    this._recomputeDphi();

    this.audioStartPerfNs = audioStartPerfMs * 1e6;
    this.hist = new LatencyHistogram();

    // process() wall-time histogram (metric 4.4). Feature-detected:
    // performance.now() is exposed in worklets on Chrome/V8 but historically
    // not on Firefox/Safari — degrade to null there and lean on the
    // partial-count cap as the CPU-cost proxy (handoff §4.4/4.5).
    this.hasPerf = typeof performance !== "undefined" && typeof performance.now === "function";
    this.procHist = new LatencyHistogram();

    // RMS instrumentation (continuity metric), opt-in.
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
      if (typeof m.nPartials === "number") {
        this.nPartials = Math.max(0, Math.min(MAX_PARTIALS, m.nPartials | 0));
        this._recomputeDphi();
      }
    };
  }

  _recomputeDphi() {
    const kEnd = this.nPartials + 1;
    for (let k = 1; k <= kEnd; k++) this.dphi[k] = (this.f0 * k) / sampleRate;
  }

  _recomputeAmps(lfoT) {
    this.amps[1] = FUND_AMP;
    const kEnd = this.nPartials + 1;
    for (let k = 2; k <= kEnd; k++) this.amps[k] = partialAmp(k, lfoT);
  }

  // Drain + clamp + insertion-sort carrier events (mirrors the hybrid worklet).
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

    const lfoT = this.frameCounter / sampleRate;
    this._recomputeAmps(lfoT);

    const kEnd = this.nPartials + 1;
    const phase = this.phase;
    const dphi = this.dphi;
    const amps = this.amps;
    let nextEv = 0;

    for (let i = 0; i < N; i++) {
      while (nextEv < evCount && this.events[nextEv].sampleOffset <= i) {
        const ev = this.events[nextEv++];
        if (ev.eventType === EVT_FREQ) {
          this.f0 = ev.value0;
          this._recomputeDphi();
          // Record control latency at this sample offset.
          const appliedEpochNs =
            this.audioStartPerfNs + (currentTime + i / sampleRate) * 1e9;
          this.hist.record(appliedEpochNs - Number(ev.tInputNs));
        }
      }
      let acc = 0;
      for (let k = 1; k <= kEnd; k++) {
        acc += Math.sin(TWO_PI * phase[k]) * amps[k];
        phase[k] += dphi[k];
      }
      out[i] = acc * OUT_SCALE;
    }
    // Reduce phases mod 1 once per quantum (cheap, keeps f64 precision).
    for (let k = 1; k <= kEnd; k++) phase[k] -= Math.floor(phase[k]);
    this.frameCounter += N;

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
        path: "A",
        nPartials: this.nPartials,
        carrierFreq: this.f0,
        inputDrained: this.inputDrained,
        latency: h,
        procDuration: this.hasPerf ? this.procHist.snapshot() : null,
        rmsSqAccum: this.rmsSqAccum,
        rmsSinceReport: this.rmsSinceReport,
        // A has no transport: "drop" is a process() overrun, which we cannot
        // observe from inside; main detects A's cap via produced-output silence
        // / underflow proxy is N/A. We report 0 and let the partial-ramp phase
        // use audio-thread continuity (no glitch) as the sustain signal.
        underflowSamples: 0,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("comparator-cpu", CpuAdditiveProcessor);
