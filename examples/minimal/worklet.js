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
// SAB header layout (mirrors src/SpscRing.ts — the canonical protocol):
//
//   The 32-byte header is viewed as Int32Array(sab, 0, 8) — 8 lanes total.
//   This worklet only touches the first two:
//     lane 0: write_index (producer monotonic Int32 wrap counter)
//     lane 1: read_index  (consumer monotonic Int32 wrap counter)
//   The other six lanes (flow_scale Q16.16, torn_frame_counter, PLL
//   offset/drift/status) are not used by this minimal demo and MUST NOT be
//   touched — corrupting them would break the producer's back-pressure
//   controller and the consumer's PLL.
//
//   Earlier versions of this file viewed the header as
//   BigInt64Array(sab, 0, 2). That was wrong against the post-0.4 Int32
//   protocol (the v0.1.x Float64RingBuffer used Int64 counters, but the
//   schema-driven Bridge<S> uses Int32). The Int64 view collapsed lanes
//   0+1 into a single 64-bit word and aliased the consumer's `read_index`
//   updates onto lanes 2+3 (flow_scale + torn_frame), corrupting them
//   silently. Fixed at 0.9.3.
//
// Consumer protocol (mirrors src/SpscRing.ts):
//   - indices : Int32Array view over the first 32 bytes of the SAB.
//   - umbrella views: one per element-size family present in the schema.
//     For physicsControlFrameSchema(n) we need:
//       u64View : BigUint64Array (for seq + tMacroNs)
//       f64View : Float64Array   (for vMax + jMax + vEff + jEff)
//   - On each process() call:
//       writeIdx = Atomics.load(indices, 0)   // acquire, Int32 lane 0
//       if (writeIdx === readIdx) → empty; hold last-known-good.
//       newestIdx = (writeIdx - 1) | 0        // Int32 wrap subtract
//       slot = newestIdx & mask
//       read fields at slot * stride + elemOffset per layout
//       Atomics.store(indices, 1, writeIdx)   // release, Int32 lane 1
//       Atomics.notify(indices, 1, 1)         // wake any parked producer
//
// No torn-frame re-check needed — the producer push contract guarantees the
// slot the consumer reads is not being written.

const RING_HEADER_INT32_LANES = 8; // mirror of src/SpscRing.ts constant

class BridgeConsumer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, capacity, n, layout } = options.processorOptions;
    this.n = n;
    this.capacity = capacity;
    this.mask = capacity - 1; // Number, not BigInt — Int32 protocol.

    // Reconstruct umbrella views from the layout description.
    const payloadElems8 = (capacity * layout.frameByteSize) / 8;
    this.indices = new Int32Array(sab, 0, RING_HEADER_INT32_LANES);
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
    const readIdx = this.indices[1];          // single-consumer; plain read, Int32 lane 1
    const writeIdx = Atomics.load(this.indices, 0); // acquire, Int32 lane 0
    if (writeIdx === readIdx) return -1;
    const newestIdx = (writeIdx - 1) | 0;     // Int32 wrap arithmetic
    const skipped = (newestIdx - readIdx) | 0;
    const slot = newestIdx & this.mask;
    const base = slot * this.stride8;
    this.lastSeq = this.u64View[base + this.seqElemOff];
    // Skip tMacroNs/vMax/jMax in this minimal demo — we don't surface them here.
    const vEffElemOff = this.vEffByteOff / 8;
    const jEffElemOff = this.jEffByteOff / 8;
    for (let i = 0; i < this.n; i++) this.vEff[i] = this.f64View[base + vEffElemOff + i];
    for (let i = 0; i < this.n; i++) this.jEff[i] = this.f64View[base + jEffElemOff + i];
    Atomics.store(this.indices, 1, writeIdx); // release: consume up to writeIdx, Int32 lane 1
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
