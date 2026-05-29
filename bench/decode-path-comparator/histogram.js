// histogram.js — log-binned duration histogram for the decode-path worklets.
//
// Same shape as bench/audio-pipeline-comparator/histogram.js, but records
// DECODE DURATIONS (ns/decode) instead of input-to-audible latencies. 1024 log
// bins from 10 ns to 100 µs (decode is far faster than end-to-end latency, so
// the window is shifted down two decades). p50/p99 are the headline; the p99
// spread is what predicts a glitch under GC.

export class DurationHistogram {
  constructor() {
    this.binCount = 1024;
    this.binMinNs = 10;
    this.binMaxNs = 100_000; // 100 µs
    this.logRange = Math.log(this.binMaxNs / this.binMinNs);
    this.hist = new Uint32Array(this.binCount);
    this.total = 0;
    this.maxNsObserved = 0;
  }

  binFor(ns) {
    if (ns <= this.binMinNs) return 0;
    if (ns >= this.binMaxNs) return this.binCount - 1;
    const f = Math.log(ns / this.binMinNs) / this.logRange;
    return Math.min(this.binCount - 1, Math.max(0, Math.floor(f * this.binCount)));
  }

  binCenterNs(idx) {
    const f = (idx + 0.5) / this.binCount;
    return this.binMinNs * Math.exp(f * this.logRange);
  }

  record(ns) {
    if (ns < 0) return;
    const idx = this.binFor(ns);
    this.hist[idx]++;
    this.total++;
    if (ns > this.maxNsObserved) this.maxNsObserved = ns;
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

  snapshot() {
    return {
      count: this.total,
      p50Ns: this.percentile(0.5),
      p99Ns: this.percentile(0.99),
      maxNs: this.maxNsObserved,
    };
  }

  reset() {
    this.hist.fill(0);
    this.total = 0;
    this.maxNsObserved = 0;
  }
}
