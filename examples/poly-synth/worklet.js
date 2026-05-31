// worklet.js — the AUDIO realm for the poly-synth demo (Frontier 7, Stage 4).
//
// A VOICE-BATCHED AudioWorkletProcessor holding a `JitKernelConsumer` built for
// `voices = 8`. Each quantum it generates ONE saw oscillator PER VOICE (at that
// voice's keyboard pitch, gated by a click-free per-voice amplitude smoother),
// writes them into a fully VOICE-INTERLEAVED input slab `x[i·V + v]`, passes the
// per-voice cutoff ARRAY + the broadcast `fb` scalar, and runs the consumer — the
// developer's JS fallback first (audio is immediate), then the gate-verified
// VOICE-SIMD kernel once the page posts a `jit-install` (the consumer crossfades
// click-free, keeping each voice's lane-packed state across the swap). Finally it
// down-mixes the V voice-interleaved outputs to the single mono channel.
//
// `createJitConsumer` reconstitutes the JS fallback (here, `emitJsKernel`'s inversion
// of the token stream — a faithful simultaneous-state scalar kernel) and
// `handleJitInstallMessage` does all the install routing; this file is just the
// per-voice oscillator bank, the voice-interleaving, and the down-mix.
//
// CRITICAL: install happens ONLY in `port.onmessage`, NEVER in `process()`.

import { createJitConsumer, handleJitInstallMessage } from "../../dist/experimental/index.js";

const AMP = 0.16;            // master output gain (kept OUTSIDE the timed region)
const TWO_PI = Math.PI * 2;  // (unused — saw oscillator — kept for clarity)
void TWO_PI;

const nowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
  ? () => performance.now()
  : null;

class PolySynthProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions;
    this.consumer = createJitConsumer(opts);
    this.consumer.setSampleRate(sampleRate);
    this.maxBlock = opts.maxBlock;
    this.voices = opts.voices;

    const sig = opts.signature;
    this.inputName = sig.params.find((p) => p.role === "input").name;
    this.outputName = sig.params.find((p) => p.role === "output").name;

    // Voice-interleaved I/O slabs: [i·V + v].
    this.xInter = new Float32Array(this.maxBlock * this.voices);
    this.outInter = new Float32Array(this.maxBlock * this.voices);

    // Per-voice oscillator + envelope state.
    this.phase = new Float32Array(this.voices);
    this.freq = new Float32Array(this.voices);     // Hz, per voice
    this.gain = new Float32Array(this.voices);      // smoothed amplitude (click-free)
    this.gateTarget = new Float32Array(this.voices); // 0 (off) / 1 (on)
    // ~6 ms attack/release smoothing per voice (no clicks on note on/off).
    this.envCoef = 1 - Math.exp(-1 / (sampleRate * 0.006));

    // Kernel scalar params (from "params" messages).
    this.cutoffs = new Float32Array(this.voices).fill(0.5); // per-voice `c` array
    this.fb = 0.4;   // broadcast `fb` (feedback / space)
    this.level = 1.0; // oscillator drive

    this.transport = "none";
    this.jsEmaUs = 0;
    this.simdEmaUs = 0;
    this.framesSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "notes") {
        if (m.freqs) for (let v = 0; v < this.voices; v++) this.freq[v] = m.freqs[v] ?? 0;
        if (m.gates) for (let v = 0; v < this.voices; v++) this.gateTarget[v] = m.gates[v] ? 1 : 0;
        return;
      }
      if (m.type === "params") {
        if (m.cutoffs) for (let v = 0; v < this.voices; v++) this.cutoffs[v] = m.cutoffs[v] ?? 0.5;
        if (typeof m.fb === "number") this.fb = m.fb;
        if (typeof m.level === "number") this.level = m.level;
        return;
      }
      // jit-install / jit-force-js / jit-fallback → route to the consumer (SYNC,
      // between quanta — exactly where install belongs).
      if (m.type === "jit-install" || m.type === "jit-force-js" || m.type === "jit-fallback") {
        const r = handleJitInstallMessage(this.consumer, m);
        if (m.type === "jit-install") this.transport = r.transport;
        else if (m.type === "jit-force-js") this.transport = "none";
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const sr = sampleRate;
    const V = this.voices;

    // Generate one saw oscillator per voice into the voice-interleaved input slab,
    // applying each voice's click-free amplitude envelope. x[i·V + v].
    const xi = this.xInter;
    const env = this.envCoef;
    const lvl = this.level;
    for (let v = 0; v < V; v++) {
      let ph = this.phase[v];
      const dph = this.freq[v] / sr;
      const gt = this.gateTarget[v];
      let g = this.gain[v];
      for (let i = 0; i < n; i++) {
        ph += dph; if (ph >= 1) ph -= 1;
        g += (gt - g) * env;
        xi[i * V + v] = lvl * g * (2 * ph - 1); // saw, [-1, 1) × envelope
      }
      this.phase[v] = ph;
      this.gain[v] = g;
    }

    // Run the kernel (JS, or voice-SIMD once armed) — TIMED (when a clock exists).
    // Per-voice cutoff ARRAY `c`; broadcast number `fb`.
    const baseNs = currentTime * 1e9;
    const t0 = nowMs ? nowMs() : 0;
    const r = this.consumer.process(
      { [this.inputName]: xi },
      { c: this.cutoffs, fb: this.fb },
      { [this.outputName]: this.outInter },
      n, baseNs,
    );
    const dtUs = nowMs ? (nowMs() - t0) * 1000 : 0;

    // Down-mix the V voice-interleaved outputs to the mono channel + a safety clamp
    // (OUTSIDE the timed region).
    const oi = this.outInter;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      const base = i * V;
      for (let v = 0; v < V; v++) acc += oi[base + v];
      let s = acc * AMP;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i] = s;
    }

    // Bucket the kernel time by phase (skip "fading" — both kernels run then).
    if (nowMs) {
      const a = 0.05;
      if (r.phase === "idle" || r.phase === "priming") this.jsEmaUs = this.jsEmaUs ? this.jsEmaUs + a * (dtUs - this.jsEmaUs) : dtUs;
      else if (r.phase === "complete" && r.ranSimd) this.simdEmaUs = this.simdEmaUs ? this.simdEmaUs + a * (dtUs - this.simdEmaUs) : dtUs;
    }

    this.framesSinceReport += n;
    const reportEvery = r.phase === "fading" ? sr / 30 : sr / 6;
    if (this.framesSinceReport >= reportEvery) {
      this.port.postMessage({
        type: "diag",
        phase: r.phase,
        weight: r.weight,
        ranSimd: r.ranSimd,
        abortedToJs: r.abortedToJs,
        upgraded: this.consumer.isUpgraded(),
        transport: this.transport,
        jsUs: this.jsEmaUs,
        simdUs: this.simdEmaUs,
        activeVoices: this.countActive(),
      });
      this.framesSinceReport = 0;
    }
    return true;
  }

  countActive() {
    let k = 0;
    for (let v = 0; v < this.voices; v++) if (this.gateTarget[v] > 0 || this.gain[v] > 1e-3) k++;
    return k;
  }
}

registerProcessor("poly-synth", PolySynthProcessor);
