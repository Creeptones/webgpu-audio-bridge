// worklet.js — the audio-thread consumer, with the decode-path fallback ladder.
//
// This is the example that was missing: a runnable AudioWorklet that drains a
// Bridge SAB through the WASM decoder end-to-end (peek → decodeFrame → commit),
// proving the 0.7.x Track-2 WASM work in a real `process()` loop rather than a
// Node smoke test. Standalone (no library import on the audio thread).
//
// Decode-path ladder (decided in docs/decode-path-comparator.md):
//   mode "wasm" : peek_pull_latest → decode_frame (whole frame, 1 crossing,
//                 ~100 ns) → read scratch views → commit_pull_latest. Used when
//                 the main thread reports hasWasmConsumerSupport().
//   mode "js"   : inline umbrella-view pullLatest (no WASM). The graceful
//                 fallback for runtimes without WASM SIMD+threads — same audio,
//                 just the JS decode core (~200 ns). (The codegen-JS reader is
//                 the middle rung off-thread; this standalone worklet uses the
//                 umbrella path for the no-WASM case to stay import-free.)
//
// Either way the synth is identical: 8 partials, frequency from vEff[k], gain
// from gEff[k]. A BenchTimer-style rolling average reports decode µs to the HUD.

const HEADER = 32;

class WasmDecodeConsumer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.sab = o.sab;
    this.mode = o.mode; // "wasm" | "js"
    this.n = o.n;
    this.capacity = o.capacity;
    this.mask = o.capacity - 1;
    this.frameByteSize = o.frameByteSize;
    this.layout = o.layout;

    this.indices = new Int32Array(this.sab, 0, 8);
    this.freq = new Float64Array(this.n);
    this.gain = new Float64Array(this.n);
    this.phase = new Float64Array(this.n);
    this.haveFrame = false;

    // bench
    this.accMs = 0; this.benchN = 0; this.lastUs = 0; this.report = 0;
    this.pulls = 0; this.misses = 0;

    if (this.mode === "wasm") {
      try {
        const mod = new WebAssembly.Module(o.wasmBytes);
        const inst = new WebAssembly.Instance(mod, { env: { memory: o.memory } });
        this.peek = inst.exports.peek_pull_latest;
        this.commit = inst.exports.commit_pull_latest;
        this.decode = inst.exports.decode_frame;
        this.descPtr = o.descPtr; this.descCount = o.descCount;
        // scratch read views for the decoded vEff/gEff
        this.scFreq = new Float64Array(this.sab, o.decodedFields.vEff.byteOffset, this.n);
        this.scGain = new Float32Array(this.sab, o.decodedFields.gEff.byteOffset, this.n);
      } catch (err) {
        this.port.postMessage({ type: "error", message: `wasm-instantiate: ${err}` });
        this.mode = "js"; // degrade
      }
    }
    if (this.mode === "js") {
      const fo = this.layout.fields;
      this.f64 = new Float64Array(this.sab);
      this.f32 = new Float32Array(this.sab);
      this.stride8 = this.frameByteSize / 8;
      this.vEffElem = fo.vEff.byteOffset / 8;
      this.gEffByte = fo.gEff.byteOffset; // f32 base byte
    }

    this.port.postMessage({ type: "mode", mode: this.mode });
  }

  // WASM path: peek newest → decode whole frame to scratch → commit.
  pullWasm() {
    const slot = this.peek(this.mask);
    if (slot < 0) return false;
    const slotBase = HEADER + slot * this.frameByteSize;
    this.decode(slotBase, this.descPtr, this.descCount);
    this.commit();
    for (let k = 0; k < this.n; k++) { this.freq[k] = this.scFreq[k]; this.gain[k] = this.scGain[k]; }
    return true;
  }

  // JS path: inline umbrella pullLatest (mirrors examples/minimal/worklet.js).
  pullJs() {
    const readIdx = this.indices[1];
    const writeIdx = Atomics.load(this.indices, 0);
    if (writeIdx === readIdx) return false;
    const slot = ((writeIdx - 1) | 0) & this.mask;
    const base8 = slot * this.stride8;
    const gBase = (HEADER + slot * this.frameByteSize + this.gEffByte) / 4;
    for (let k = 0; k < this.n; k++) {
      this.freq[k] = this.f64[base8 + this.vEffElem + k];
      this.gain[k] = this.f32[gBase + k];
    }
    Atomics.store(this.indices, 1, writeIdx);
    Atomics.notify(this.indices, 1, 1);
    return true;
  }

  process(_in, outputs) {
    const t0 = performance.now();
    const got = this.mode === "wasm" ? this.pullWasm() : this.pullJs();
    const dt = performance.now() - t0;
    if (got) { this.haveFrame = true; this.pulls++; this.accMs += dt; this.benchN++; }
    else this.misses++;

    const out = outputs[0][0];
    if (!this.haveFrame) {
      out.fill(0);
    } else {
      const sr = sampleRate, twoPi = Math.PI * 2, len = out.length, n = this.n;
      for (let s = 0; s < len; s++) {
        let acc = 0;
        for (let k = 0; k < n; k++) {
          this.phase[k] += (twoPi * this.freq[k]) / sr;
          if (this.phase[k] > twoPi) this.phase[k] -= twoPi;
          acc += Math.sin(this.phase[k]) * this.gain[k];
        }
        out[s] = acc * 0.15;
      }
    }

    if ((this.report += out.length) >= sampleRate / 4) {
      this.report = 0;
      this.port.postMessage({
        type: "diag",
        mode: this.mode,
        decodeUs: this.benchN > 0 ? (this.accMs / this.benchN) * 1000 : 0,
        pulls: this.pulls, misses: this.misses,
      });
      this.accMs = 0; this.benchN = 0;
    }
    return true;
  }
}

registerProcessor("wasm-decode-consumer", WasmDecodeConsumer);
