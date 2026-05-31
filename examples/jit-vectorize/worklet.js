// worklet.js — the AUDIO realm (one of the three JIT realms).
//
// An AudioWorkletProcessor that holds a `JitKernelConsumer`. From the very first
// quantum it generates a naive sawtooth into an input block and runs the
// developer's kernel over it — on the JS fallback at first (audio is immediate).
// When the background compile worker finishes and the main thread forwards a
// gate-PASSED kernel, `port.onmessage` calls `handleJitInstallMessage`, which
// installs the SIMD `Instance` SYNCHRONOUSLY (between quanta, ~microseconds) and
// arms the swap. Over the next few ms the consumer CROSSFADES the live signal from
// the JS kernel onto the SIMD kernel with the exact-lerp amplitude blend — zero
// audible glitch (for this f32 kernel the two are bit-exact, so the fade is
// acoustically a no-op; only the per-quantum kernel TIME changes).
//
// `createJitConsumer` reconstructs the developer's JS fallback from the SOURCE
// STRING in `processorOptions` (the `Function` constructor — permitted here under
// CSP-free serving). All install routing + the JS reconstitution lives in the
// library's `connectJit` helpers; this file is just the audio loop + the HUD.
//
// CRITICAL: install happens ONLY in `port.onmessage`, NEVER in `process()` — a
// synchronous `new WebAssembly.Instance` is microseconds, but an async
// compile/instantiate on the audio thread could blow a render quantum.

import { createJitConsumer, handleJitInstallMessage } from "../../dist/experimental/index.js";

const AMP = 0.22; // output gain (kept OUTSIDE the timed region — we time the kernel only)

// `performance` is NOT guaranteed in AudioWorkletGlobalScope (it is in some
// engines, absent in others). Guard it: when absent the kernel-time HUD reads "—"
// but the phase / upgrade / transport indicators — the primary demonstration —
// are unaffected. (The rigorous timing is `npm run bench:jit`.)
const nowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
  ? () => performance.now()
  : null;

class JitVectorizeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions;
    this.consumer = createJitConsumer(opts);
    this.consumer.setSampleRate(sampleRate);
    this.maxBlock = opts.maxBlock;

    // The naive saw the kernel shapes (the kernel's only input array, name "x").
    this.xBlock = new Float32Array(this.maxBlock);
    this.phase = 0;
    this.freq = 110;   // saw fundamental (Hz)
    this.drive = 3.0;  // the kernel's "drive" scalar (saturation amount)

    // Live state for the HUD.
    this.transport = "none";
    this.lastInstalled = false;

    // Per-quantum kernel-time, bucketed JS (idle/priming) vs SIMD (complete) —
    // an exponential moving average each. The worklet clock is coarse under
    // isolation, so this is INDICATIVE; the rigorous numbers are `npm run bench:jit`.
    this.jsEmaUs = 0;
    this.simdEmaUs = 0;
    this.framesSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "params") {
        if (typeof m.freq === "number") this.freq = m.freq;
        if (typeof m.drive === "number") this.drive = m.drive;
        return;
      }
      // jit-install / jit-force-js / jit-fallback → route to the consumer (SYNC,
      // between quanta — exactly where install belongs).
      if (m.type === "jit-install" || m.type === "jit-force-js" || m.type === "jit-fallback") {
        const r = handleJitInstallMessage(this.consumer, m);
        if (m.type === "jit-install") { this.transport = r.transport; this.lastInstalled = r.installed; }
        else if (m.type === "jit-force-js") { this.transport = "none"; this.lastInstalled = false; }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const sr = sampleRate;

    // Generate a naive sawtooth into the input block (band-unlimited — the point
    // is the kernel, not the oscillator).
    const dphase = this.freq / sr;
    for (let i = 0; i < n; i++) {
      this.phase += dphase;
      if (this.phase >= 1) this.phase -= 1;
      this.xBlock[i] = 2 * this.phase - 1;
    }

    // Run the kernel (JS, or SIMD once armed) — TIMED (when a clock is available).
    const baseNs = currentTime * 1e9;
    const t0 = nowMs ? nowMs() : 0;
    const r = this.consumer.process({ x: this.xBlock }, { drive: this.drive }, { out }, n, baseNs);
    const dtUs = nowMs ? (nowMs() - t0) * 1000 : 0;

    // Output gain — OUTSIDE the timed region.
    for (let i = 0; i < n; i++) out[i] *= AMP;

    // Bucket the kernel time by phase (skip "fading" — both kernels run then).
    if (nowMs) {
      const a = 0.05; // EMA smoothing
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

registerProcessor("jit-vectorize", JitVectorizeProcessor);
