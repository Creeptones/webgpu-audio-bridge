// worklet.js — the `speaker` node: the audio-rate broadcast sink of the DAG.
//
// One AudioWorklet at the END of a three-hop graph
// (osc0,osc1 ─fan-in→ mixer ─spsc→ fx ─broadcast→ speaker,meter). It
// `mountGraph`s its own node — `inbound.bcast` is a real SpmcRing consumer whose
// `consumerIndex` (0) was DERIVED by `mountGraph` from the node's position in the
// broadcast edge's `to[]`. Each render quantum it DRAINS every frame currently in
// the broadcast ring — updating a per-voice latest freq/amp — and synthesizes the
// sum of two sines.
//
// The wait-free `pull` is poll-only (no Atomics.wait — the audio thread must never
// block), and the per-quantum drain is bounded, so nothing upstream can ever stall
// the render callback. The whole multi-hop, multi-realm graph terminates here, in
// real audio, with `tornGuarded() === 0`.
//
// Browser worklets CAN import the real `dist` facades; we import `mountGraph`
// straight from `dist/connectGraph.js` (NOT the experimental barrel, which pulls
// the JIT's bare `acorn` import).

import { mountGraph } from "../../dist/connectGraph.js";
import { makeSchemas } from "./schema.js";

const TWO_PI = Math.PI * 2;
const MASTER = 0.32;
const VOICES = 2;
const DRAIN_CAP = 4096; // max frames consumed per quantum (bounds flood work).

class SpeakerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { handle } = options.processorOptions;
    const mounted = mountGraph(handle, { node: "speaker", schemas: makeSchemas() });
    this.ring = mounted.inbound.bcast; // broadcast consumer (index 0, derived)
    this.out = this.ring.createFrame();

    this.freq = new Float64Array(VOICES);
    this.amp = new Float64Array(VOICES);
    this.phase = new Float64Array(VOICES);

    this.consumed = 0;
    this.framesSinceReport = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const sr = sampleRate;

    // ── Drain the broadcast: fold every buffered frame into per-voice latest ──
    let drained = 0;
    while (this.ring.pull(this.out)) {
      const pid = this.out.producerId;
      if (pid >= 0 && pid < VOICES) {
        this.freq[pid] = this.out.freq;
        this.amp[pid] = this.out.amp;
      }
      this.consumed++;
      if (++drained >= DRAIN_CAP) break;
    }

    // ── Synthesize: sum of two independent sines ────────────────────────────
    const n = out.length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let p = 0; p < VOICES; p++) {
        let ph = this.phase[p] + (TWO_PI * this.freq[p]) / sr;
        if (ph > TWO_PI) ph -= TWO_PI;
        this.phase[p] = ph;
        s += Math.sin(ph) * this.amp[p];
      }
      out[i] = (s / VOICES) * MASTER;
    }

    // ── HUD diag ~20×/s ─────────────────────────────────────────────────────
    this.framesSinceReport += n;
    if (this.framesSinceReport >= sr / 20) {
      this.port.postMessage({
        type: "diag", node: "speaker",
        consumed: this.consumed,
        available: this.ring.available(),
        dropped: this.ring.dropped(),
        tornGuarded: this.ring.tornGuarded(),
        drainedLast: drained,
        freq: Array.from(this.freq),
        amp: Array.from(this.amp),
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("dag-speaker", SpeakerProcessor);
