// histogram.js — shared latency histogram for the comparator worklets.
//
// Lifted verbatim in shape from bench/e2e-latency/worklet.js (binFor /
// binCenterNs / percentile / 1024 log bins from 100 ns to 1 s). Pulled into
// its own module so paths A, C, and G share one implementation instead of
// three copy-pastes. The worklets import it; ES-module AudioWorklets are
// supported in every evergreen browser in 2026 (the same import the
// demo worklets already rely on).
//
// All latencies are recorded as the ABSOLUTE magnitude of the signed
// (appliedEpochNs − tInputNs) difference. As bench/e2e-latency documents, the
// signed value is biased negative by the audio output-buffer latency; the
// magnitude and — more importantly — its spread (p99 − median) are the
// glitch-governing metric. See README §"Why the latency number is a spread".

export class LatencyHistogram {
  constructor() {
    this.binCount = 1024;
    this.binMinNs = 100;
    this.binMaxNs = 1_000_000_000; // 1 s
    this.logRange = Math.log(this.binMaxNs / this.binMinNs);
    this.hist = new Uint32Array(this.binCount);
    this.total = 0;
    this.maxNsObserved = 0;
    this.lastSignedNs = 0;
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

  // Record one signed measurement (appliedEpochNs − tInputNs). Returns the
  // |magnitude| binned, or null if it fell outside the 10× headroom window.
  record(signedNs) {
    this.lastSignedNs = signedNs;
    const latencyNs = Math.abs(signedNs);
    if (latencyNs >= this.binMaxNs * 10) return null;
    const idx = this.binFor(latencyNs);
    this.hist[idx]++;
    this.total++;
    if (latencyNs > this.maxNsObserved) this.maxNsObserved = latencyNs;
    return latencyNs;
  }

  percentile(target) {
    if (this.total === 0) return 0;
    let cum = 0;
    const want = this.total * target;
    for (let i = 0; i < this.binCount; i++) {
      cum += this.hist[i];
      if (cum >= want) return this.binCenterNs(i);
    }
    return this.binCenterNs(this.binCount - 1);
  }

  // Percentile bundle for a report. Does not reset.
  snapshot() {
    return {
      count: this.total,
      p50Ns: this.percentile(0.5),
      p95Ns: this.percentile(0.95),
      p99Ns: this.percentile(0.99),
      maxNs: this.maxNsObserved,
      lastSignedNs: this.lastSignedNs,
    };
  }

  reset() {
    this.hist.fill(0);
    this.total = 0;
    this.maxNsObserved = 0;
  }
}
