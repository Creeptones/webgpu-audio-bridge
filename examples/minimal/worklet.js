// worklet.js — the audio-rate consumer.
//
// Runs on the audio rendering thread. Hard-real-time constraints: process()
// must never block, never allocate in the steady state, never await.
//
// This file is intentionally standalone (no imports) so it works across
// browsers regardless of their ES-module-worklet support. The main thread
// passes the schema's byte-offset table in via processorOptions.layout
// (produced by Bridge.describeLayout()); the worklet reconstructs the umbrella
// typed-array views and reads frames inline. No library code runs on the
// audio thread.
//
// Consumer protocol (mirrors src/Bridge.ts):
//   - indices : BigInt64Array view over the first 32 bytes of the SAB.
//   - umbrella views: one per element-size family present in the schema.
//     For physicsControlFrameSchema(n) we need:
//       u64View : BigUint64Array (for seq + tMacroNs)
//       f64View : Float64Array   (for vMax + jMax + vEff + jEff)
//   - On each process() call:
//       writeIdx = Atomics.load(indices, 0)   // acquire
//       if (writeIdx === readIdx) → empty; hold last-known-good.
//       newestIdx = writeIdx - 1
//       slot = Number(newestIdx & mask)
//       read fields at slot * stride + elemOffset per layout
//       Atomics.store(indices, 1, writeIdx)   // release (consume up to writeIdx)
//       Atomics.notify(indices, 1, 1)         // wake any producer parked
//
// No torn-frame re-check needed — the producer push contract guarantees the
// slot the consumer reads is not being written.

class BridgeConsumer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, capacity, n, layout } = options.processorOptions;
    this.n = n;
    this.capacity = capacity;
    this.mask = BigInt(capacity - 1);

    // Reconstruct umbrella views from the layout description.
    const payloadElems8 = (capacity * layout.frameByteSize) / 8;
    this.indices = new BigInt64Array(sab, 0, 2);
    this.u64View = new BigUint64Array(sab, layout.headerBytes, payloadElems8);
    this.f64View = new Float64Array(sab, layout.headerBytes, payloadElems8);

    // Per-field offsets within a single frame, converted to element indices
    // for the relevant umbrella view.
    this.stride8 = layout.frameByteSize / 8;
    this.seqElemOff = layout.fields.seq.byteOffset / 8;
    this.vEffByteOff = layout.fields.vEff.byteOffset;
    this.jEffByteOff = layout.fields.jEff.byteOffset;

    // Last-known-good macro state. Held when the ring is momentarily empty
    // (which should be rare given producer @60Hz, consumer @375Hz).
    this.vEff = new Float64Array(n);
    this.jEff = new Float64Array(n);
    this.haveFirstFrame = false;

    // Per-partial oscillator phases (one per harmonic).
    this.phase = new Float64Array(n);

    // Diagnostics.
    this.pulls = 0;
    this.misses = 0;
    this.skippedTotal = 0;
    this.lastSeq = 0n;
    this.framesSinceReport = 0;

    this.port.onmessage = (e) => { /* no live config in the minimal demo */ };
  }

  // pullLatest, inlined and bare. Returns frames-skipped, or -1 if empty.
  pullLatest() {
    const readIdx = this.indices[1];          // single-consumer; plain read
    const writeIdx = Atomics.load(this.indices, 0); // acquire
    if (writeIdx === readIdx) return -1;
    const newestIdx = writeIdx - 1n;
    const skipped = Number(newestIdx - readIdx);
    const slot = Number(newestIdx & this.mask);
    const base = slot * this.stride8;
    this.lastSeq = this.u64View[base + this.seqElemOff];
    // Skip tMacroNs/vMax/jMax in this minimal demo — we don't surface them here.
    const vEffElemOff = this.vEffByteOff / 8;
    const jEffElemOff = this.jEffByteOff / 8;
    for (let i = 0; i < this.n; i++) this.vEff[i] = this.f64View[base + vEffElemOff + i];
    for (let i = 0; i < this.n; i++) this.jEff[i] = this.f64View[base + jEffElemOff + i];
    Atomics.store(this.indices, 1, writeIdx); // release: consume up to writeIdx
    Atomics.notify(this.indices, 1, 1);
    return skipped;
  }

  process(_inputs, outputs) {
    const skipped = this.pullLatest();
    if (skipped >= 0) {
      this.haveFirstFrame = true;
      this.pulls++;
      this.skippedTotal += skipped;
    } else {
      this.misses++;
    }

    const out = outputs[0][0];
    if (!this.haveFirstFrame) {
      out.fill(0);
    } else {
      // Additive synthesis. n harmonics, gain from jEff, freq from vEff.
      // 0.15 master gain to keep summed partials well under clip.
      const sr = sampleRate;
      const len = out.length;
      const twoPi = Math.PI * 2;
      for (let s = 0; s < len; s++) {
        let acc = 0;
        for (let i = 0; i < this.n; i++) {
          this.phase[i] += (twoPi * this.vEff[i]) / sr;
          if (this.phase[i] > twoPi) this.phase[i] -= twoPi;
          acc += Math.sin(this.phase[i]) * this.jEff[i];
        }
        out[s] = acc * 0.15;
      }
    }

    // Report ~4x/sec to main, without postMessaging per quantum.
    this.framesSinceReport += out.length;
    if (this.framesSinceReport >= sampleRate / 4) {
      this.port.postMessage({
        type: "diag",
        workletPulls: this.pulls,
        workletMisses: this.misses,
        meanSkipped: this.pulls > 0 ? this.skippedTotal / this.pulls : 0,
        // bigint → number for JSON-friendly diag (only used in the on-page panel).
        lastSeq: Number(this.lastSeq),
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("bridge-consumer", BridgeConsumer);
