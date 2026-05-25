// e2e-latency / worklet.js — silent consumer that timestamps.
//
// On each process() call, pullLatest() the freshest frame, then compute
//   latencyNs = nowNs_workletThread - tMacroNs_from_header
// Histogram the result; report percentile summary back to main every ~250ms.
//
// Clock alignment:
//   - Each context (main, worker, AudioWorklet) has its OWN
//     performance.timeOrigin. A DedicatedWorker's origin is its creation
//     time, NOT the page's. So worker.performance.now() and
//     main.performance.now() share neither origin nor scale.
//   - To bridge: producer stamps tMacroNs in absolute Unix-epoch ns
//     (timeOrigin + now()) * 1e6. Main captures audioStartPerfMs in the same
//     absolute space immediately after `new AudioContext(...)` returns.
//   - This worklet receives audioStartPerfNs (audioStartPerfMs * 1e6) via
//     processorOptions and converts its per-quantum currentTime into the
//     same absolute space:
//        nowEpochNs = audioStartPerfNs + currentTime * 1e9
//        latencyNs  = nowEpochNs - tMacroNs
//     The remaining sub-ms slop is the constructor-execution time between
//     `new AudioContext()` returning and currentTime being clocked from 0;
//     well below audio-quantum scale.
//
// performance.now() is not exposed on AudioWorkletGlobalScope reliably across
// browsers, which is why we go through the AudioContext alignment instead of
// using performance.now() directly inside this file.

class BridgeLatencyConsumer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, capacity, n, audioStartPerfMs, layout } = options.processorOptions;
    this.n = n;
    this.capacity = capacity;
    this.mask = BigInt(capacity - 1);
    // Reconstruct umbrella + per-field offsets from the layout description.
    // The bench uses legacyPhysicsControlFrameSchema (all-f64), so a single
    // Float64Array umbrella view covers every field.
    this.indices = new BigInt64Array(sab, 0, 2);
    this.stride8 = layout.frameByteSize / 8;
    this.data = new Float64Array(sab, layout.headerBytes, capacity * this.stride8);
    this.seqElemOff = layout.fields.seq.byteOffset / 8;
    this.tMacroElemOff = layout.fields.tMacroNs.byteOffset / 8;

    // Clock-alignment baseline (see header comment). Stored in ns so the
    // per-quantum conversion is one multiply + one add.
    this.audioStartPerfNs = audioStartPerfMs * 1e6;

    this.samples = 0;
    this.samplesDelta = 0;
    this.workletQuanta = 0;
    this.workletMisses = 0;
    this.skippedTotal = 0;
    this.pulls = 0;
    this.pushRejects = 0;
    this.lastReportCt = currentTime;

    // Histogram: 1024 logarithmic bins from 100ns to 1s (7 decades).
    // The top of the range has to accommodate the output-buffer bias plus
    // worst-case main-thread / layout-thrash jitter; Chrome's interactive
    // outputLatency can be 30+ ms by itself, so a 100ms cap saturated.
    this.binCount = 1024;
    this.binMinNs = 100;
    this.binMaxNs = 1_000_000_000; // 1 s
    this.logRange = Math.log(this.binMaxNs / this.binMinNs);
    this.hist = new Uint32Array(this.binCount);
    this.maxNsObserved = 0;

    // Sliding window — we keep the cumulative hist and snapshot/reset every
    // report. Avoids unbounded memory growth across long runs.
  }

  pullLatest() {
    const readIdx = this.indices[1];
    const writeIdx = Atomics.load(this.indices, 0);
    if (writeIdx === readIdx) return null;
    const newestIdx = writeIdx - 1n;
    const skipped = Number(newestIdx - readIdx);
    const slot = Number(newestIdx & this.mask);
    const base = slot * this.stride8;
    const seq = this.data[base + this.seqElemOff];
    const tMacroNs = this.data[base + this.tMacroElemOff];
    Atomics.store(this.indices, 1, writeIdx);
    Atomics.notify(this.indices, 1, 1);
    return { seq, tMacroNs, skipped };
  }

  binFor(latencyNs) {
    if (latencyNs <= this.binMinNs) return 0;
    if (latencyNs >= this.binMaxNs) return this.binCount - 1;
    const f = Math.log(latencyNs / this.binMinNs) / this.logRange;
    return Math.min(this.binCount - 1, Math.max(0, Math.floor(f * this.binCount)));
  }

  binCenterNs(idx) {
    const f = (idx + 0.5) / this.binCount;
    return this.binMinNs * Math.exp(f * this.logRange);
  }

  percentile(total, target) {
    let cum = 0;
    for (let i = 0; i < this.binCount; i++) {
      cum += this.hist[i];
      if (cum >= total * target) return this.binCenterNs(i);
    }
    return this.binCenterNs(this.binCount - 1);
  }

  process(_inputs, outputs) {
    this.workletQuanta++;
    const got = this.pullLatest();
    if (got) {
      this.pulls++;
      this.skippedTotal += got.skipped;
      // Real end-to-end latency, in the producer's (performance.now()-origin)
      // clock. See header comment for the alignment derivation.
      //   nowPerfNs = audioStartPerfNs + currentTime * 1e9
      //   latencyNs = nowPerfNs - tMacroNs
      // AudioWorkletGlobalScope.currentTime represents the *playback* time of
      // the audio being rendered in this quantum, lagging wall-clock by the
      // output buffer (Chrome's "interactive" hint: ~10–40ms). That means our
      // reconstructed `nowEpochNs` is also behind real wall-clock at process()
      // call time by the same constant offset. The SIGNED diff (nowEpochNs -
      // tMacroNs) will therefore be NEGATIVE by approximately outputLatency;
      // the magnitude (and its dispersion across quanta) is what we actually
      // care about — that dispersion is the bridge's contribution plus
      // audio-thread scheduling jitter, which is what governs glitch behavior.
      const nowEpochNs = this.audioStartPerfNs + currentTime * 1e9;
      const signedNs = nowEpochNs - got.tMacroNs;
      const latencyNs = Math.abs(signedNs);
      this.lastLatencyNs = latencyNs;
      this.lastSignedNs = signedNs;
      // 10× headroom over the histogram top so genuine spikes get attributed
      // to the max-observed counter even if they fall outside the bin range.
      if (latencyNs < this.binMaxNs * 10) {
        const idx = this.binFor(latencyNs);
        this.hist[idx]++;
        this.samples++;
        this.samplesDelta++;
        if (latencyNs > this.maxNsObserved) this.maxNsObserved = latencyNs;
      }
    } else {
      this.workletMisses++;
    }

    // Output silence (downstream gain is 0; we keep an output so the worklet
    // is scheduled at sample rate).
    const out = outputs[0][0];
    out.fill(0);

    // Report ~4x/sec.
    if (currentTime - this.lastReportCt > 0.25) {
      this.emitReport();
      this.lastReportCt = currentTime;
    }
    return true;
  }

  emitReport() {
    let total = 0;
    for (let i = 0; i < this.binCount; i++) total += this.hist[i];
    const median = total > 0 ? this.percentile(total, 0.5) : 0;
    const p50 = median;
    const p95 = total > 0 ? this.percentile(total, 0.95) : 0;
    const p99 = total > 0 ? this.percentile(total, 0.99) : 0;
    this.port.postMessage({
      type: "report",
      backend: "(worklet-doesnt-know)",
      n: this.n,
      capacity: this.capacity,
      pushRateHz: 0, // worker fills this in via main if it wants; left 0 here
      workletQuanta: this.workletQuanta,
      samples: this.samples,
      samplesDelta: this.samplesDelta,
      medianNs: median,
      p50Ns: p50,
      p95Ns: p95,
      p99Ns: p99,
      maxNs: this.maxNsObserved,
      pushRejects: this.pushRejects,
      workletMisses: this.workletMisses,
      meanSkipped: this.pulls > 0 ? this.skippedTotal / this.pulls : 0,
      pulls: this.pulls,
      // Signed value of the most recent measurement, before abs(). Negative
      // by roughly outputLatency on Chrome; the absolute and its spread are
      // the metric.
      lastSignedNs: this.lastSignedNs ?? 0,
    });
    this.samplesDelta = 0;
  }
}

registerProcessor("bridge-latency-consumer", BridgeLatencyConsumer);
