// lnn.js — the LIQUID neural cell — the "brain" of the spike. SHARED by
// worker.js (the producer realm) and selftest.mjs (headless verification), so
// the network the demo hears is byte-identical to the one the selftest asserts
// on. Pure: no DOM, no Worker, no audio API — just math + typed arrays.
//
// This is a Liquid Time-Constant (LTC) cell — a small continuous-time recurrent
// network whose neurons' effective time constants are MODULATED BY THE INPUT
// (Hasani et al., "Liquid Time-constant Networks", AAAI 2021). That input-
// dependence is the "liquid" part and is exactly why the commenter's framing —
// "instant understanding of context, no tokens, runs on a CPU" — is accurate:
// the state is a continuous vector integrated by an ODE, not a token buffer.
//
//   continuous ODE:   dx/dt = −[1/τ + f(x,I)]·x  +  f(x,I)·A
//   fused solver:     x ← (x + Δt·f·A) / (1 + Δt·(1/τ + f))
//
//   f = sigmoid(Wᵢ·I + Wᵣ·x + b) ∈ (0,1)   ← the input-dependent conductance
//   τ  > 0 per-neuron base time constants    ← so 1/τ + f is always > 0 (stable)
//   A    per-neuron reversal potentials      ← what each neuron relaxes toward
//   y  = tanh(Wₒ·x + bₒ) ∈ [−1,1]            ← the control read-out (K outputs)
//
// HONESTY: this network is UNTRAINED — a seeded random "liquid reservoir"
// (reservoir-computing flavour: fixed random recurrent weights, rich bounded
// dynamics). The spike's question is "do an LNN's continuous dynamics produce
// musically interesting modulation, and does the integration path hold up?",
// NOT "did a trained model compose this." Training a CfC/LTC to a musical
// objective is the obvious next layer — see README §Upgrade path. The fused
// solver's denominator is always > 1, so the map is contractive per step: the
// state cannot blow up (selftest asserts it), and the input oscillator keeps it
// continually excited so it doesn't decay to silence either.

/** Deterministic PRNG (mulberry32). Same seed → same network → reproducible
 *  audio + selftest. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * A small Liquid Time-Constant cell + linear read-out. Construct once; `step()`
 * allocates NOTHING (all buffers preallocated) so it is safe to run in a tight
 * control-rate loop. Default size (5 in → 24 hidden → 6 out) runs in well under
 * a microsecond per step on a CPU — the "2 GB / decent CPU" envelope the
 * commenter describes is met with several orders of magnitude to spare.
 */
export class LiquidCell {
  constructor({
    nIn = 5,
    nHid = 24,
    nOut = 6,
    seed = 1234,
    recurrentGain = 1.8, // reservoir spectral scaling — rich but bounded dynamics
    readoutGain = 1.6,   // scales the read-out so outputs use more of tanh's range
    tauMin = 0.08,       // fastest neuron time constant (s)
    tauMax = 1.5,        // slowest neuron time constant (s) → long memory + lag
  } = {}) {
    this.nIn = nIn;
    this.nHid = nHid;
    this.nOut = nOut;
    this.seed = seed >>> 0;

    const rnd = mulberry32(this.seed);
    // Box–Muller normal draw from the uniform PRNG.
    const randn = () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    // Weights. Input + read-out scaled 1/√fan-in; recurrent scaled by the
    // reservoir gain so the coupled dynamics are lively without diverging.
    this.Win = Float32Array.from({ length: nHid * nIn }, () => randn() / Math.sqrt(nIn));
    this.Wrec = Float32Array.from({ length: nHid * nHid }, () => (randn() * recurrentGain) / Math.sqrt(nHid));
    this.b = Float32Array.from({ length: nHid }, () => randn() * 0.1);
    this.Wout = Float32Array.from({ length: nOut * nHid }, () => (randn() * readoutGain) / Math.sqrt(nHid));
    this.bout = new Float32Array(nOut);

    // Per-neuron base time constants (positive) + reversal potentials.
    this.invTau = Float32Array.from({ length: nHid }, () => 1 / (tauMin + (tauMax - tauMin) * rnd()));
    this.A = Float32Array.from({ length: nHid }, () => randn() * 0.8);

    // State + scratch (preallocated; step() is allocation-free).
    this.x = new Float32Array(nHid);
    this._f = new Float32Array(nHid);
    this.out = new Float32Array(nOut);
  }

  /** Zero the hidden state (e.g. on reseed). */
  reset() {
    this.x.fill(0);
  }

  /**
   * Advance the ODE one fused solver step of `dt` seconds under `input`
   * (length ≥ nIn). Returns the reused read-out buffer (length nOut), each
   * value in [−1, 1]. The caller must consume/copy it before the next step.
   */
  step(input, dt) {
    const { nIn, nHid, nOut, Win, Wrec, b, invTau, A, x, _f } = this;

    // f = sigmoid(Win·input + Wrec·x + b) — the input-dependent conductance.
    // This is the term that makes the time constant "liquid": a large f shortens
    // the effective τ (the neuron reacts fast), a small f lengthens it.
    for (let i = 0; i < nHid; i++) {
      let z = b[i];
      const wiBase = i * nIn;
      for (let k = 0; k < nIn; k++) z += Win[wiBase + k] * input[k];
      const wrBase = i * nHid;
      for (let j = 0; j < nHid; j++) z += Wrec[wrBase + j] * x[j];
      _f[i] = sigmoid(z);
    }

    // Fused semi-implicit solver step. Denominator (1 + dt·(1/τ + f)) > 1 always
    // → contractive, so the state is provably bounded for bounded A.
    for (let i = 0; i < nHid; i++) {
      const fi = _f[i];
      x[i] = (x[i] + dt * fi * A[i]) / (1 + dt * (invTau[i] + fi));
    }

    // Read-out: y = tanh(Wout·x + bout) ∈ [−1, 1].
    const { Wout, bout, out } = this;
    for (let o = 0; o < nOut; o++) {
      let z = bout[o];
      const base = o * nHid;
      for (let j = 0; j < nHid; j++) z += Wout[base + j] * x[j];
      out[o] = Math.tanh(z);
    }
    return out;
  }

  /** L2 norm of the hidden state — a liveness/boundedness probe for diag + the
   *  selftest's "never blows up, never goes dead" assertions. */
  stateNorm() {
    let s = 0;
    const x = this.x;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s);
  }
}

// ── Drive input (shared, pure) ─────────────────────────────────────────────
//
// The 5-vector the worker AND the selftest feed the cell each tick, so the
// network the demo hears is driven exactly as the test asserts on:
//   [0,1] a slow clock (sin/cos) at CLOCK_HZ, scaled up so it swings the
//         sigmoid across its range; [2] energy [0,1]→[−1,1]; [3] mood [−1,1];
//         [4] bias.

export const CLOCK_HZ = 0.35; // the slow drive oscillator (Hz)
export const INPUT_GAIN = 2.2; // clock amplitude into the net

/** Fill `out` (length ≥ 5) with the drive vector for a given clock `phase`
 *  (turns, [0,1)) + UI drives. Returns `out`. Allocation-free. */
export function driveInput(out, phase, energy, mood) {
  const ang = 2 * Math.PI * phase;
  out[0] = INPUT_GAIN * Math.sin(ang);
  out[1] = INPUT_GAIN * Math.cos(ang);
  out[2] = energy * 2 - 1;
  out[3] = mood;
  out[4] = 1.0;
  return out;
}

// ── Musical mapping helper (shared, pure) ──────────────────────────────────
//
// Keeping the LNN's continuous pitch output musical: quantize a [−1,1] control
// value to a minor-pentatonic degree → Hz. The worklet inlines its own copy
// (it is import-free by design); this export lets the selftest report the note
// stream the same way the ear would hear it.

export const MINOR_PENTATONIC = [0, 3, 5, 7, 10];

/** Map a control value in [−1, 1] to a minor-pentatonic frequency (Hz). */
export function pentatonicHz(unit, { baseMidi = 57 /* A3 */, octaves = 2 } = {}) {
  const u = Math.min(0.9999, Math.max(0, (unit + 1) * 0.5));
  const steps = MINOR_PENTATONIC.length * octaves;
  const idx = Math.floor(u * steps);
  const oct = Math.floor(idx / MINOR_PENTATONIC.length);
  const deg = MINOR_PENTATONIC[idx % MINOR_PENTATONIC.length];
  const midi = baseMidi + oct * 12 + deg;
  return 440 * Math.pow(2, (midi - 69) / 12);
}
