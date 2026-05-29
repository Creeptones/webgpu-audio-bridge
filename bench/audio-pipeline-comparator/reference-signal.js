// reference-signal.js — the fairness contract for the comparator bench.
//
// Every one of the four pipelines (A / B / C / G) MUST render the IDENTICAL
// musical content so the scorecard is apples-to-apples. This module is the
// single source of truth for that content. The CPU paths (A full, G carrier)
// import the JS helpers; the GPU paths (B / C full, G residual) compile the
// WGSL string emitted by `wgslKernelSource()`. The two implementations are
// kept bit-for-bit aligned by deriving both from the same constants below.
//
// ── The signal ────────────────────────────────────────────────────────────
//
//   fundamental  k = 1          : amplitude FUND_AMP, NO LFO (steady pitch).
//                                  This is the latency-critical "carrier".
//   partials     k = 2 .. N+1   : amplitude (0.5 + 0.5·sin(2π·LFO_HZ·(lfoT +
//                                  0.13·k))) / k  — 1/k roll-off, each partial
//                                  amplitude-modulated by a slow per-partial-
//                                  phase-offset LFO. The "residual": the
//                                  spectral richness that benefits from GPU
//                                  parallelism and tolerates block latency.
//
//   sample(i) for block starting at blockStartSec, LFO clock lfoT, fund f0:
//     t        = blockStartSec + i / SAMPLE_RATE
//     fund     = FUND_AMP · sin(2π · f0 · t)                       (k = 1)
//     partials = Σ_{k=2}^{N+1} sin(2π · f0·k · t) · partialAmp(k, lfoT)
//     full     = (fund + partials) · OUT_SCALE
//     residual = partials          · OUT_SCALE
//     carrier  = fund              · OUT_SCALE
//
//   By construction  full = carrier + residual  exactly, which is what makes
//   path G (CPU carrier + GPU residual) reproduce the same content path A
//   renders monolithically on the CPU and path C renders monolithically on
//   the GPU.
//
// The partial math mirrors examples/hybrid-residual/worker.js so the
// comparator is comparable with the existing hybrid-residual demo + bench.
// The one intentional deviation: the hybrid demo's CPU carrier is a sawtooth;
// here the carrier (k = 1) is a SINE, so that path A's monolithic full render
// and path G's split carrier+residual render are the same signal. Documented
// in README §"The reference signal".

export const SAMPLE_RATE = 48000;
export const LFO_HZ = 0.3; // sub-Hz amplitude LFO on each partial.
export const FUND_AMP = 0.6; // fundamental (carrier) amplitude pre-OUT_SCALE.
export const OUT_SCALE = 0.4; // overall scale so the summed signal won't clip.
export const DEFAULT_PARTIALS = 16; // harmonics 2..17 — the spectral-richness knob's default.
export const PARTIAL_PHASE_STEP = 0.13; // per-partial LFO phase offset multiplier.

// k-start selectors for `wgslKernelSource` / `fillSignal`.
export const K_FULL = 1; // include the fundamental (paths A/B/C).
export const K_RESIDUAL = 2; // partials only (path G's GPU layer).

const TWO_PI = Math.PI * 2;

// Amplitude of partial k at LFO clock lfoT. k must be >= 2.
export function partialAmp(k, lfoT) {
  const lfoPhase = lfoT + PARTIAL_PHASE_STEP * k;
  return (0.5 + 0.5 * Math.sin(TWO_PI * LFO_HZ * lfoPhase)) / k;
}

// Fill `out[0..blockSize)` with the reference signal for one block.
//   kStart === K_FULL (1)     → fundamental + partials.
//   kStart === K_RESIDUAL (2) → partials only (no fundamental).
// `out` is a Float32Array of length >= blockSize. Allocation-free.
export function fillSignal(out, blockSize, blockStartSec, lfoT, f0, nPartials, kStart) {
  const kEnd = nPartials + 2; // partials k = 2 .. nPartials+1.
  for (let i = 0; i < blockSize; i++) {
    const t = blockStartSec + i / SAMPLE_RATE;
    let acc = 0;
    if (kStart <= 1) {
      acc += FUND_AMP * Math.sin(TWO_PI * f0 * t);
    }
    for (let k = 2; k < kEnd; k++) {
      const fk = f0 * k;
      acc += Math.sin(TWO_PI * fk * t) * partialAmp(k, lfoT);
    }
    out[i] = acc * OUT_SCALE;
  }
}

// WGSL compute-shader source for the same signal. `blockSize` is baked as the
// storage-array length; `nPartials` and `kStart` ride uniforms so the producer
// can change the partial count and switch full↔residual without recompiling.
//
// Uniform layout (must match worker.gpu.js's Float32Array writes):
//   [0] blockStartSec
//   [1] carrierFreq (f0)
//   [2] sampleRate
//   [3] lfoT
//   [4] nPartials   (cast to u32)
//   [5] kStart      (cast to u32: 1 = full, 2 = residual)
//   [6] _pad0
//   [7] _pad1
export function wgslKernelSource(blockSize) {
  return /* wgsl */ `
    struct Uniforms {
      blockStartSec: f32,
      carrierFreq:   f32,
      sampleRate:    f32,
      lfoT:          f32,
      nPartials:     f32,
      kStart:        f32,
      _pad0:         f32,
      _pad1:         f32,
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;
    @group(0) @binding(1) var<storage, read_write> samples: array<f32, ${blockSize}>;

    const TWO_PI:   f32 = 6.28318530718;
    const LFO_HZ:   f32 = ${LFO_HZ};
    const FUND_AMP: f32 = ${FUND_AMP};
    const OUT_SCALE:f32 = ${OUT_SCALE};
    const PHASE_STEP: f32 = ${PARTIAL_PHASE_STEP};

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i = gid.x;
      if (i >= ${blockSize}u) { return; }
      let t = u.blockStartSec + f32(i) / u.sampleRate;
      let f0 = u.carrierFreq;
      let kStart = u32(u.kStart);
      let kEnd = u32(u.nPartials) + 2u;
      var acc: f32 = 0.0;
      // Fundamental (k = 1) only when rendering the full signal.
      if (kStart <= 1u) {
        acc = acc + FUND_AMP * sin(TWO_PI * f0 * t);
      }
      // Partials k = 2 .. nPartials+1. 1/k roll-off + per-partial slow LFO.
      for (var k: u32 = 2u; k < kEnd; k = k + 1u) {
        let fk = f0 * f32(k);
        let lfoPhase = u.lfoT + PHASE_STEP * f32(k);
        let amp = (0.5 + 0.5 * sin(TWO_PI * LFO_HZ * lfoPhase)) / f32(k);
        acc = acc + sin(TWO_PI * fk * t) * amp;
      }
      samples[i] = acc * OUT_SCALE;
    }
  `;
}
