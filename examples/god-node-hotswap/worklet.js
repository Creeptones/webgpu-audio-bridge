// worklet.js — the audio-rate consumer that performs the live cross-schema swap.
//
// This is the end-to-end composition of God-Node Stages 1–3, running on the
// audio thread:
//
//   • HotSwapConsumer (Stage 2) holds bridge A (old patch) and bridge B (new
//     patch), reconstructs BOTH per quantum via `pullHermiteLatest`, runs the
//     idle → priming → fading → complete state machine, and anchors the fade
//     window to *B-ready* (not arm-time — the one critical timing law).
//   • Its weight schedule is the Stage-1 `crossfadeWeight` (C² quintic); we read
//     `weightAt(perSampleNs)` PER SAMPLE for a sample-accurate, click-free seam.
//   • migratePlan (Stage 3, computed on the main thread, posted in here) tells us
//     `res` and `detune` are NEW b-only fields → they RAMP IN from their default
//     (0) to B's value across the same window, so B's timbre eases in instead of
//     popping. This worklet is the first real *executor* of a migration plan.
//
// The blend itself is `crossfadeInto`'s equal-power law (A and B are distinct
// timbres → uncorrelated → cos/sin keeps summed power flat). We inline the two-
// MAC law per sample because the weight moves every sample; `crossfadeInto` is
// the buffer-level form of the exact same math (see src/crossfade.ts).
//
// Pitch motion is identical in A and B (same freq trajectory), so what you HEAR
// is a pure timbre morph — the seam continuity is the only audible variable.

import { Bridge, HotSwapConsumer } from "../../dist/index.js";
import { makeSchemaA, makeSchemaB, CAP } from "./schema.js";

const TWO_PI = Math.PI * 2;
const AMP = 0.18;

class GodNodeConsumer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sabA, sabB } = options.processorOptions;
    this.a = new Bridge(sabA, CAP, makeSchemaA());
    this.b = new Bridge(sabB, CAP, makeSchemaB());
    this.a.setSampleRate(sampleRate);
    this.b.setSampleRate(sampleRate);

    this.swap = new HotSwapConsumer(this.a, this.b, {
      continuity: "quintic",
      windowSeconds: 0.18,
      minBFramesForReady: 2,
    });

    this.outA = this.a.scratchEvaluatedFrame();
    this.outB = this.b.scratchEvaluatedFrame();

    // Synthesis phase accumulators.
    this.phaseA = 0;
    this.phaseB = 0;   // B's primary oscillator
    this.phaseB2 = 0;  // B's detuned second oscillator
    this.lastFreqA = 0;
    this.lastFreqB = 0;

    // Ramp-in defaults from the migration plan (filled on "config"). Default 0
    // until told otherwise — the safe "field appears from silence" baseline.
    this.rampResFrom = 0;
    this.rampDetuneFrom = 0;
    this.planSummary = "(awaiting plan)";

    // diag
    this.framesSinceReport = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "config") {
        if (m.windowSeconds != null) this.windowSeconds = m.windowSeconds;
        if (m.plan) this.applyPlan(m.plan);
      } else if (m.type === "arm") {
        try { this.swap.armSwap(m.windowSeconds ?? this.windowSeconds); } catch (_) {}
      } else if (m.type === "reset") {
        this.swap.reset();
        this.phaseB = 0; this.phaseB2 = 0;
      }
    };
    this.windowSeconds = 0.18;
  }

  // Read the ramp-in defaults the plan assigned to B's added fields.
  applyPlan(plan) {
    for (const f of plan.rampIn ?? []) {
      const d = typeof f.default === "number" ? f.default : 0; // "hold" → start at b
      if (f.to === "res") this.rampResFrom = d;
      if (f.to === "detune") this.rampDetuneFrom = d;
    }
    const xf = (plan.crossfade ?? []).map((f) => f.to).join(",");
    const ri = (plan.rampIn ?? []).map((f) => `${f.to}:${f.reason}`).join(",");
    const dr = (plan.drop ?? []).map((f) => f.from).join(",");
    this.planSummary = `crossfade[${xf}] rampIn[${ri}] drop[${dr || "—"}]`;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const sr = sampleRate;
    const nsPerSample = 1e9 / sr;
    const baseNs = currentTime * 1e9;

    const r = this.swap.pullLatest(this.outA, this.outB, baseNs);

    const freqA = this.outA.freq[0];
    const ampA = this.outA.amp;
    const freqB = this.outB.freq[0];
    const ampB = this.outB.amp;
    if (Number.isFinite(freqA)) this.lastFreqA = freqA;
    if (Number.isFinite(freqB)) this.lastFreqB = freqB;

    const n = out.length;
    for (let i = 0; i < n; i++) {
      const w = this.swap.weightAt(baseNs + i * nsPerSample);

      // ── A: bare carrier ─────────────────────────────────────────────────
      this.phaseA += (TWO_PI * this.lastFreqA) / sr;
      if (this.phaseA > TWO_PI) this.phaseA -= TWO_PI;
      const aSample = Math.sin(this.phaseA) * ampA;

      // ── B: richer timbre, with res/detune RAMPED IN per the plan ─────────
      // effRes / effDetune fade from the plan's default (0) to B's value as the
      // window weight w sweeps 0→1, so B's extra colour eases in click-free.
      const effRes = this.rampResFrom + (this.outB.res - this.rampResFrom) * w;
      const effDetune = this.rampDetuneFrom + (this.outB.detune - this.rampDetuneFrom) * w;

      this.phaseB += (TWO_PI * this.lastFreqB) / sr;
      if (this.phaseB > TWO_PI) this.phaseB -= TWO_PI;
      this.phaseB2 += (TWO_PI * (this.lastFreqB + effDetune)) / sr;
      if (this.phaseB2 > TWO_PI) this.phaseB2 -= TWO_PI;
      // primary + detuned partner + a res-weighted upper octave (brightness)
      const bBase =
        0.5 * Math.sin(this.phaseB) +
        0.5 * Math.sin(this.phaseB2) +
        0.45 * effRes * Math.sin(2 * this.phaseB);
      const bSample = bBase * ampB;

      // ── equal-power blend (crossfadeInto law, per-sample) ────────────────
      let gA, gB;
      if (w <= 0) { gA = 1; gB = 0; }
      else if (w >= 1) { gA = 0; gB = 1; }
      else { const th = 0.5 * Math.PI * w; gA = Math.cos(th); gB = Math.sin(th); }

      out[i] = (gA * aSample + gB * bSample) * AMP;
    }

    // Report ~60×/s while the fade is moving (so the weight bar animates), and
    // a relaxed ~4×/s otherwise.
    this.framesSinceReport += n;
    const reportEvery = r.phase === "fading" ? sr / 60 : sr / 4;
    if (this.framesSinceReport >= reportEvery) {
      this.port.postMessage({
        type: "diag",
        phase: r.phase,
        weight: this.swap.weightAt(baseNs + (n - 1) * nsPerSample),
        bReady: r.bReady,
        windowStartNs: r.windowStartNs,
        planSummary: this.planSummary,
        freqA: this.lastFreqA,
        freqB: this.lastFreqB,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("god-node-consumer", GodNodeConsumer);
