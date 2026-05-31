// worklet.js — the AUDIO realm for the generative demo.
//
// Generates the SOURCE the kernels shape — a melodic arpeggio (a saw stepping through
// a scale) on the first input, and a rhythmic pluck (a fast-decaying tone+noise pulse
// retriggered each beat) on the second — then runs a `JitKernelConsumer`. Every
// generated kernel shares one signature (in0 = arp, in1 = rhythm, scalar g, out), so
// this processor is built ONCE and successive gate-verified kernels are installed over
// it; the consumer crossfades SIMD→SIMD, so each new kernel MORPHS in click-free.
//
// CRITICAL: install happens ONLY in `port.onmessage`, never in `process()`.

import { createJitConsumer, handleJitInstallMessage } from "../../dist/experimental/index.js";

const AMP = 0.28;        // master output gain (outside the timed region)
const TWO_PI = Math.PI * 2;

const nowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
  ? () => performance.now()
  : null;

// A minor-pentatonic-ish arpeggio (Hz). Stepping through it gives an immediately
// "musical" melodic source for the kernels to distort / fold / ring-modulate.
const ARP = [220.0, 261.63, 329.63, 392.0, 440.0, 523.25, 392.0, 329.63];

class GenerativeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions;
    this.consumer = createJitConsumer(opts);
    this.consumer.setSampleRate(sampleRate);
    this.maxBlock = opts.maxBlock;

    const sig = opts.signature;
    this.inputNames = sig.params.filter((p) => p.role === "input").map((p) => p.name);
    this.outputName = sig.params.find((p) => p.role === "output").name;

    this.blocks = {};
    for (const name of this.inputNames) this.blocks[name] = new Float32Array(this.maxBlock);

    // Source state.
    this.frame = 0;          // global sample counter
    this.arpPhase = 0;       // saw phase
    this.rhyPhase = 0;       // pluck tone phase
    this.noiseState = 0x9e3779b9 >>> 0;
    this.stepSec = 0.16;     // arpeggio step length (set by tempo)
    this.beatSec = 0.32;     // rhythmic pulse period
    this.level = 1.25;       // source amplitude (>1 so clip/fold kernels bite)
    this.scalars = { g: 1.0 };

    // HUD state.
    this.jsEmaUs = 0;
    this.simdEmaUs = 0;
    this.framesSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "params") {
        if (typeof m.level === "number") this.level = m.level;
        if (typeof m.stepSec === "number") this.stepSec = m.stepSec;
        if (typeof m.beatSec === "number") this.beatSec = m.beatSec;
        if (m.scalars) this.scalars = m.scalars;
        return;
      }
      if (m.type === "jit-install" || m.type === "jit-force-js" || m.type === "jit-fallback") {
        handleJitInstallMessage(this.consumer, m);
      }
    };
  }

  // Cheap deterministic white noise in [-1, 1] (xorshift32).
  noise() {
    let x = this.noiseState;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.noiseState = x >>> 0;
    return (this.noiseState / 0xffffffff) * 2 - 1;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const sr = sampleRate;

    const stepSamples = Math.max(1, Math.floor(this.stepSec * sr));
    const beatSamples = Math.max(1, Math.floor(this.beatSec * sr));
    const arp = this.blocks[this.inputNames[0]];
    const rhy = this.inputNames.length > 1 ? this.blocks[this.inputNames[1]] : null;

    for (let i = 0; i < n; i++) {
      const f = this.frame + i;
      const note = ARP[Math.floor(f / stepSamples) % ARP.length];

      // in0 — arpeggiated saw (the melodic voice).
      this.arpPhase += note / sr; if (this.arpPhase >= 1) this.arpPhase -= 1;
      if (arp) arp[i] = this.level * (2 * this.arpPhase - 1);

      // in1 — rhythmic pluck: a fast-decaying envelope (retriggered each beat) over a
      // tone an octave below the note + a little noise → a percussive, pitched layer.
      if (rhy) {
        const posInBeat = (f % beatSamples) / sr;
        const env = Math.exp(-posInBeat * 16);
        this.rhyPhase += (note * 0.5) / sr; if (this.rhyPhase >= 1) this.rhyPhase -= 1;
        const tone = Math.sin(TWO_PI * this.rhyPhase);
        rhy[i] = this.level * env * (0.75 * tone + 0.25 * this.noise());
      }
    }
    this.frame += n;

    const inputsObj = {};
    for (const name of this.inputNames) inputsObj[name] = this.blocks[name];

    const baseNs = currentTime * 1e9;
    const t0 = nowMs ? nowMs() : 0;
    const r = this.consumer.process(inputsObj, this.scalars, { [this.outputName]: out }, n, baseNs);
    const dtUs = nowMs ? (nowMs() - t0) * 1000 : 0;

    // Master gain + safety clamp (generated kernels can swing past unity).
    for (let i = 0; i < n; i++) {
      let v = out[i] * AMP;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      out[i] = v;
    }

    if (nowMs) {
      const a = 0.05;
      if (r.phase === "idle" || r.phase === "priming") this.jsEmaUs = this.jsEmaUs ? this.jsEmaUs + a * (dtUs - this.jsEmaUs) : dtUs;
      else if (r.phase === "complete" && r.ranSimd) this.simdEmaUs = this.simdEmaUs ? this.simdEmaUs + a * (dtUs - this.simdEmaUs) : dtUs;
    }

    this.framesSinceReport += n;
    const reportEvery = r.phase === "fading" ? sr / 30 : sr / 8;
    if (this.framesSinceReport >= reportEvery) {
      this.port.postMessage({
        type: "diag", phase: r.phase, weight: r.weight, ranSimd: r.ranSimd,
        abortedToJs: r.abortedToJs, jsUs: this.jsEmaUs, simdUs: this.simdEmaUs,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("kernel-generative", GenerativeProcessor);
