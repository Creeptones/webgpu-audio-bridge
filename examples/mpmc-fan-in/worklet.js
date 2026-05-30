// worklet.js — the SINGLE audio-rate consumer of the MP→SC fan-in demo.
//
// One AudioWorklet, three concurrent producers. The worklet `mountFanIn(
// role:'consumer')`s the shared MpmcRing (the SAB arrives in processorOptions),
// then each render quantum DRAINS every frame currently in the ring — updating a
// per-producer "latest freq/amp" — and synthesizes the sum of three sines.
//
// The wait-free `pull` is poll-only (no Atomics.wait — the audio thread must
// never block). Draining is O(1) per frame under the enforced envelope, and the
// per-quantum drain is bounded so a flood can never stall the render callback.
//
// The visible proof: three independent producers fan into ONE audio thread with
// `tornFrameCount() === 0` always, and under "Flood" `droppedFrames()` climbs
// while torn stays 0 — graceful drop-newest, never a torn read.

import { mountFanIn } from "../../dist/experimental/index.js";
import { makeFanInSchema, PRODUCER_COUNT } from "./schema.js";

const TWO_PI = Math.PI * 2;
const MASTER = 0.28;
const DRAIN_CAP = 2048; // max frames consumed per quantum (bounds flood work).

class FanInConsumer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { handle } = options.processorOptions;
    this.ring = mountFanIn(handle, { role: "consumer", schema: makeFanInSchema() });
    this.out = this.ring.createFrame();

    this.freq = new Float64Array(PRODUCER_COUNT);
    this.amp = new Float64Array(PRODUCER_COUNT);
    this.phase = new Float64Array(PRODUCER_COUNT);

    this.consumed = 0;
    this.framesSinceReport = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const sr = sampleRate;

    // ── Drain the ring: fold every buffered frame into per-producer latest ──
    let drained = 0;
    while (this.ring.pull(this.out)) {
      const pid = this.out.producerId;
      if (pid >= 0 && pid < PRODUCER_COUNT) {
        this.freq[pid] = this.out.freq;
        this.amp[pid] = this.out.amp;
      }
      this.consumed++;
      if (++drained >= DRAIN_CAP) break; // never let a flood stall the callback.
    }

    // ── Synthesize: sum of three independent sines ──────────────────────────
    const n = out.length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let p = 0; p < PRODUCER_COUNT; p++) {
        let ph = this.phase[p] + (TWO_PI * this.freq[p]) / sr;
        if (ph > TWO_PI) ph -= TWO_PI;
        this.phase[p] = ph;
        s += Math.sin(ph) * this.amp[p];
      }
      out[i] = (s / PRODUCER_COUNT) * MASTER;
    }

    // ── HUD diag ~20×/s ─────────────────────────────────────────────────────
    this.framesSinceReport += n;
    if (this.framesSinceReport >= sr / 20) {
      this.port.postMessage({
        type: "diag",
        consumed: this.consumed,
        dropped: this.ring.droppedFrames(),
        torn: this.ring.tornFrameCount(),
        overrunLost: this.ring.overrunLostFrames(),
        available: this.ring.available(),
        drainedLast: drained,
        freq: Array.from(this.freq),
        amp: Array.from(this.amp),
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("fan-in-consumer", FanInConsumer);
