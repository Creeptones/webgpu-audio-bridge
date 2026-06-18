// worklet.js — the AUDIO realm: the consumer + a tiny synth voice.
//
// Hard real-time: process() never blocks, never awaits, never allocates in the
// steady state. Intentionally import-free (works across browsers regardless of
// module-worklet support) — main.js hands it the schema's byte-offset table via
// processorOptions.layout (from Bridge.describeLayout()) and it rebuilds the
// typed-array views itself.
//
// Each quantum it pullLatest()'s the newest LNN control vector and maps the six
// values to synth parameters:
//
//   control[0] → pitch     (quantized to a minor-pentatonic degree, then glided)
//   control[1] → cutoff    (one-pole low-pass, exp-mapped 200 Hz … 6 kHz)
//   control[2] → amplitude (voice level)
//   control[3] → vibrato   (depth of a ~5.5 Hz pitch wobble)
//   control[4] → detune    (osc 2 offset → chorus/beating)
//   control[5] → tilt      (sine ↔ saw morph → brightness)
//
// Every parameter is SLEWED per-sample (one-pole, ~25 ms) so a 100 Hz control
// stream drives 48 kHz audio with no zipper noise — the cheap stand-in for the
// bridge's StatePredictor/Hermite layer (README §Upgrade path).
//
// SAB header mirrors src/SpscRing.ts: a 32-byte header viewed as Int32Array(8).
// Only lanes 0 (write_index) and 1 (read_index) are touched; the other six
// (flow_scale, torn_frame, PLL lanes) MUST NOT be written.

const RING_HEADER_INT32_LANES = 8;
const TWO_PI = Math.PI * 2;
const MINOR_PENTATONIC = [0, 3, 5, 7, 10];

// Inlined twin of lnn.js's pentatonicHz (the worklet imports nothing).
function pentatonicHz(unit) {
  const u = Math.min(0.9999, Math.max(0, (unit + 1) * 0.5));
  const baseMidi = 57; // A3
  const octaves = 2;
  const steps = MINOR_PENTATONIC.length * octaves;
  const idx = Math.floor(u * steps);
  const oct = Math.floor(idx / MINOR_PENTATONIC.length);
  const deg = MINOR_PENTATONIC[idx % MINOR_PENTATONIC.length];
  const midi = baseMidi + oct * 12 + deg;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

class LiquidVoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, capacity, k, layout } = options.processorOptions;
    this.k = k;
    this.mask = capacity - 1;

    // Umbrella views over the payload region (after the 32-byte header).
    const f32Elems = (capacity * layout.frameByteSize) / 4;
    const u64Elems = (capacity * layout.frameByteSize) / 8;
    this.indices = new Int32Array(sab, 0, RING_HEADER_INT32_LANES);
    this.f32View = new Float32Array(sab, layout.headerBytes, f32Elems);
    this.u64View = new BigUint64Array(sab, layout.headerBytes, u64Elems);

    // Per-frame element strides + field offsets, in the right element units.
    this.stride4 = layout.frameByteSize / 4;
    this.stride8 = layout.frameByteSize / 8;
    this.controlElemOff = layout.fields.control.byteOffset / 4;
    this.seqElemOff = layout.fields.seq.byteOffset / 8;

    // Latest control vector (held last-known-good when the ring is momentarily
    // empty — rare given producer @100 Hz, consumer @~375 Hz).
    this.control = new Float32Array(k);
    this.haveFrame = false;
    this.lastSeq = 0n;

    // Synth state.
    this.phase1 = 0;
    this.phase2 = 0;
    this.vibPhase = 0;
    this.lpf = 0; // one-pole low-pass memory

    // Smoothed (slewed) parameter values.
    this.sFreq = 220;
    this.sCutoff = 1200;
    this.sAmp = 0;
    this.sVib = 0;
    this.sDetune = 0;
    this.sTilt = 0;
    // One-pole slew coefficient for ~25 ms params (pitch glides a touch slower).
    this.slew = 1 - Math.exp(-1 / (0.025 * sampleRate));
    this.slewPitch = 1 - Math.exp(-1 / (0.040 * sampleRate));

    this.masterGain = 0.22;

    // Diag.
    this.pulls = 0;
    this.misses = 0;
    this.framesSinceReport = 0;

    this.port.onmessage = () => {};
  }

  // Bare pullLatest: returns frames-skipped, or −1 when empty.
  pullLatest() {
    const readIdx = this.indices[1];
    const writeIdx = Atomics.load(this.indices, 0);
    if (writeIdx === readIdx) return -1;
    const newestIdx = (writeIdx - 1) | 0;
    const skipped = (newestIdx - readIdx) | 0;
    const slot = newestIdx & this.mask;
    const base4 = slot * this.stride4 + this.controlElemOff;
    for (let i = 0; i < this.k; i++) this.control[i] = this.f32View[base4 + i];
    this.lastSeq = this.u64View[slot * this.stride8 + this.seqElemOff];
    Atomics.store(this.indices, 1, writeIdx);
    Atomics.notify(this.indices, 1, 1);
    return skipped;
  }

  process(_inputs, outputs) {
    const skipped = this.pullLatest();
    if (skipped >= 0) {
      this.haveFrame = true;
      this.pulls++;
    } else {
      this.misses++;
    }

    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;

    if (!this.haveFrame) {
      out.fill(0);
    } else {
      const c = this.control;
      // Targets from the latest control vector.
      const tFreq = pentatonicHz(c[0]);
      const tCutoff = 200 * Math.pow(30, (c[1] + 1) * 0.5); // 200 Hz … 6 kHz, exp
      const tAmp = (c[2] + 1) * 0.5; // [0,1]
      const tVib = ((c[3] + 1) * 0.5) * 0.03; // up to ±3% pitch
      const tDetune = c[4] * 0.03; // ±3%
      const tTilt = (c[5] + 1) * 0.5; // 0 sine … 1 saw

      const sr = sampleRate;
      for (let s = 0; s < n; s++) {
        // Slew params toward targets (one-pole) → no zipper noise.
        this.sFreq += this.slewPitch * (tFreq - this.sFreq);
        this.sCutoff += this.slew * (tCutoff - this.sCutoff);
        this.sAmp += this.slew * (tAmp - this.sAmp);
        this.sVib += this.slew * (tVib - this.sVib);
        this.sDetune += this.slew * (tDetune - this.sDetune);
        this.sTilt += this.slew * (tTilt - this.sTilt);

        // Vibrato LFO (~5.5 Hz).
        this.vibPhase += (TWO_PI * 5.5) / sr;
        if (this.vibPhase > TWO_PI) this.vibPhase -= TWO_PI;
        const vib = 1 + this.sVib * Math.sin(this.vibPhase);

        const f1 = this.sFreq * vib;
        const f2 = f1 * (1 + this.sDetune);

        // Two oscillators, each morphing sine↔saw by tilt.
        this.phase1 += (TWO_PI * f1) / sr;
        if (this.phase1 > TWO_PI) this.phase1 -= TWO_PI;
        this.phase2 += (TWO_PI * f2) / sr;
        if (this.phase2 > TWO_PI) this.phase2 -= TWO_PI;

        const saw1 = this.phase1 / Math.PI - 1; // [−1,1] ramp
        const saw2 = this.phase2 / Math.PI - 1;
        const o1 = (1 - this.sTilt) * Math.sin(this.phase1) + this.sTilt * saw1;
        const o2 = (1 - this.sTilt) * Math.sin(this.phase2) + this.sTilt * saw2;
        let v = 0.5 * (o1 + o2);

        // One-pole low-pass at the smoothed cutoff.
        const a = 1 - Math.exp((-TWO_PI * this.sCutoff) / sr);
        this.lpf += a * (v - this.lpf);
        v = this.lpf;

        v *= this.sAmp * this.masterGain;
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        out[s] = v;
      }
    }

    this.framesSinceReport += n;
    if (this.framesSinceReport >= sampleRate / 4) {
      this.port.postMessage({
        type: "diag",
        workletPulls: this.pulls,
        workletMisses: this.misses,
        lastSeq: Number(this.lastSeq),
        freq: this.sFreq,
        cutoff: this.sCutoff,
      });
      this.framesSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("liquid-control-voice", LiquidVoiceProcessor);
