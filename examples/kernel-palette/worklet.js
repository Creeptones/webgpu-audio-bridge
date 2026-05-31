// worklet.js — the AUDIO realm for the kernel-palette demo.
//
// A SIGNATURE-DRIVEN AudioWorkletProcessor holding a `JitKernelConsumer`. The
// processor reads the selected kernel's SIGNATURE from `processorOptions` and, each
// quantum, generates one band-unlimited oscillator per input array (a saw for the
// first input, a sine for the second), reads the scalar params from the live params
// map, and runs the consumer — the developer's JS fallback first (audio is
// immediate), then the gate-verified SIMD kernel once the page posts a `jit-install`
// (the consumer crossfades click-free). `createJitConsumer` reconstitutes the JS
// fallback (here, `emitJsKernel`'s inversion of the token stream) and
// `handleJitInstallMessage` does all the install routing; this file is just the
// oscillator bank + the HUD.
//
// CRITICAL: install happens ONLY in `port.onmessage`, NEVER in `process()` — a
// synchronous `new WebAssembly.Instance`/bytes-compile is microseconds, but an async
// compile on the audio thread could blow a render quantum.

import { createJitConsumer, handleJitInstallMessage } from "../../dist/experimental/index.js";

const AMP = 0.25; // master output gain (kept OUTSIDE the timed region)
const TWO_PI = Math.PI * 2;

// `performance` is not guaranteed in AudioWorkletGlobalScope; guard it (the
// kernel-time HUD reads "—" when absent, the rest is unaffected).
const nowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
  ? () => performance.now()
  : null;

class KernelPaletteProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions;
    this.consumer = createJitConsumer(opts);
    this.consumer.setSampleRate(sampleRate);
    this.maxBlock = opts.maxBlock;

    const sig = opts.signature;
    this.inputNames = sig.params.filter((p) => p.role === "input").map((p) => p.name);
    this.outputName = sig.params.find((p) => p.role === "output").name;

    // One input block + an independent phase per input oscillator.
    this.blocks = {};
    this.phases = {};
    for (const name of this.inputNames) {
      this.blocks[name] = new Float32Array(this.maxBlock);
      this.phases[name] = 0;
    }

    this.freq = 110;     // oscillator fundamental (Hz)
    this.level = 1.3;    // input amplitude (>1 so the clip / rectify kernels bite)
    this.scalars = {};   // scalar-param name → value (from "params" messages)

    // Live HUD state.
    this.transport = "none";
    this.jsEmaUs = 0;
    this.simdEmaUs = 0;
    this.framesSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "params") {
        if (typeof m.freq === "number") this.freq = m.freq;
        if (typeof m.level === "number") this.level = m.level;
        if (m.scalars) this.scalars = m.scalars;
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

    // Generate one oscillator per input array: index 0 = saw, index 1 = sine, both
    // at `freq`, scaled by `level`. (Band-unlimited — the point is the kernel.)
    const dphase = this.freq / sr;
    const inputsObj = {};
    for (let idx = 0; idx < this.inputNames.length; idx++) {
      const name = this.inputNames[idx];
      const blk = this.blocks[name];
      let ph = this.phases[name];
      if (idx === 1) {
        for (let i = 0; i < n; i++) { ph += dphase; if (ph >= 1) ph -= 1; blk[i] = this.level * Math.sin(TWO_PI * ph); }
      } else {
        for (let i = 0; i < n; i++) { ph += dphase; if (ph >= 1) ph -= 1; blk[i] = this.level * (2 * ph - 1); }
      }
      this.phases[name] = ph;
      inputsObj[name] = blk;
    }

    // Run the kernel (JS, or SIMD once armed) — TIMED (when a clock is available).
    const baseNs = currentTime * 1e9;
    const t0 = nowMs ? nowMs() : 0;
    const r = this.consumer.process(inputsObj, this.scalars, { [this.outputName]: out }, n, baseNs);
    const dtUs = nowMs ? (nowMs() - t0) * 1000 : 0;

    // Master gain + a safety clamp (some kernels can exceed unity) — OUTSIDE timing.
    for (let i = 0; i < n; i++) {
      let v = out[i] * AMP;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      out[i] = v;
    }

    // Bucket the kernel time by phase (skip "fading" — both kernels run then).
    if (nowMs) {
      const a = 0.05;
      if (r.phase === "idle" || r.phase === "priming") this.jsEmaUs = this.jsEmaUs ? this.jsEmaUs + a * (dtUs - this.jsEmaUs) : dtUs;
      else if (r.phase === "complete" && r.ranSimd) this.simdEmaUs = this.simdEmaUs ? this.simdEmaUs + a * (dtUs - this.simdEmaUs) : dtUs;
    }

    // Report ~30×/s while fading (so the weight bar animates), ~6×/s otherwise.
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
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("kernel-palette", KernelPaletteProcessor);
