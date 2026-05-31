/**
 * acousticGate — the third gate (Apollo Frontier 6, Stage 2).
 *
 * The equivalence gate (#2, `gate.ts`) proves the SIMD kernel equals its scalar
 * reference — *faithfulness*. It structurally CANNOT prove the kernel sounds sane,
 * because the IR is the spec and the gate only proves SIMD ≡ that spec. Gate #3 is
 * the deterministic acoustic layer that closes the last model-free gap.
 *
 * ─── Scope: acoustic SANITY + a FINGERPRINT, not TASTE ──────────────────────────
 *
 * This is NOT "is this the musically-correct kernel" — that is the model's / a
 * human's job (Stage 3). It is exactly:
 *   1. run the accepted kernel over a fixed DETERMINISTIC probe (a bin-aligned sine),
 *   2. extract a small `AcousticProfile` fingerprint (level + spectral shape),
 *   3. ACCEPT iff the fingerprint is finite + within declared sane bounds (no
 *      NaN/Inf, no peak/DC runaway, bounded crest factor),
 *   4. ATTACH the fingerprint for downstream use (dedup-by-sound, "sounds-like"
 *      search, the Stage-3 model's feature vector).
 * It deliberately does not overclaim: a kernel can be acoustically sane and still be
 * the wrong kernel.
 *
 * ─── No wasm: profiling the reference == profiling the SIMD ──────────────────────
 *
 * Gate #2 already proved the SIMD candidate equals the scalar reference bit-exactly
 * (f64) / within-ULP (f32), so profiling a faithful scalar evaluation of the IR is
 * equivalent to profiling the SIMD output — with ZERO `WebAssembly.Instance`
 * dependency. `evalReference` interprets the IR in JS, rounding every leaf and every
 * arithmetic result to the lane width (`Math.fround` for f32), so for an f32 kernel
 * it is BIT-IDENTICAL to the scalar WASM the gate compiled (which rounds every
 * f32.* result). That makes the whole gate pure + Node-testable.
 *
 * ─── Determinism ────────────────────────────────────────────────────────────────
 *
 * Like the rest of `src/jit`: NO `Date.now` / `Math.random`. The probe is a fixed
 * (optionally seeded) waveform; the FFT is a stock radix-2. So the same kernel ⇒ the
 * byte-identical profile ⇒ a cacheable, pinnable verdict. The profile is computed
 * ONCE per content hash (the cache attaches it to the `CharacterizedKernel`).
 *
 * ─── Multi-output note (v1) ──────────────────────────────────────────────────────
 *
 * The level/spectral fingerprint is read from the PRIMARY output (the first `output`
 * param) — the common single-output case the v1 palette uses. FINITENESS is checked
 * across ALL outputs (a NaN/Inf anywhere is unsafe). A non-primary, finite, but
 * large-magnitude secondary output is not peak-gated in v1; tighten when a
 * multi-output palette lands.
 *
 * Rejection is a VALUE (mirrors `compileTokens` / `KernelCache`) — `acousticGate`
 * never throws on a kernel. `@experimental` — exported from
 * `webgpu-audio-bridge/experimental`.
 */

import {
  type IrKernel, type IrNode, type UnaryOp, type BinaryOp,
  signatureWidth, paramsByRole, isStateful,
} from "./ir.js";

/** A small, deterministic acoustic fingerprint of a kernel's output over a fixed
 *  probe. Every field is finite-or-deterministic (NaN/Inf only appear when the
 *  kernel itself is non-finite, in which case `finite` is false and the gate
 *  rejects). Levels are linear (not dB); the spectral fields read the PRIMARY
 *  output. */
export interface AcousticProfile {
  /** True iff EVERY sample of EVERY output array is finite (no NaN / ±Inf). */
  readonly finite: boolean;
  /** Root-mean-square level of the primary output. */
  readonly rms: number;
  /** Peak |sample| of the primary output. */
  readonly peak: number;
  /** Mean (DC offset) of the primary output. */
  readonly dcOffset: number;
  /** peak / rms (0 when the output is silent — rms ≈ 0). */
  readonly crestFactor: number;
  /** Spectral centroid of the primary output, normalized to [0,1] of Nyquist
   *  (0 when there is no AC content). A timbre coordinate, not a gate. */
  readonly spectralCentroid: number;
  /** Low-resolution magnitude fingerprint of the primary output — `bands`
   *  L1-normalized energy bands over (DC, Nyquist]. Amplitude-invariant (a gain
   *  change leaves it unchanged), so it is a "sounds-like" shape vector. All zeros
   *  for a silent / non-finite output. */
  readonly magnitude: ReadonlyArray<number>;
}

/** Tuning for the probe + the sane-bounds gate. All optional — the defaults are
 *  intentionally generous (they catch genuine blowups, never legitimate effects). */
export interface AcousticGateOptions {
  /** Probe length in samples — MUST be a power of two (the FFT requires it).
   *  Default 1024. */
  readonly probeLength?: number;
  /** Fundamental frequency of the probe sine, in FFT bins (cycles per window).
   *  Bin-aligned ⇒ leakage-free, and a memoryless waveshaper's harmonics land on
   *  exact bins too. Default 8. */
  readonly fundamentalBin?: number;
  /** The value assigned to EVERY scalar param during the probe. A fixed neutral
   *  mid-value (the kernel body, not the runtime scalar, is what gate #3 judges —
   *  the scalar is a runtime input, not part of the content address). Default 0.5. */
  readonly probeScalar?: number;
  /** Number of bands in the magnitude fingerprint. Default 64 — fine enough to
   *  separate a fundamental from its low harmonics (so dedup/NN over the fingerprint
   *  discriminate genuinely-distinct distortions; a coarser split buckets them
   *  together). The sanity gate + `spectralCentroid` are band-count-independent. */
  readonly fingerprintBands?: number;
  /** Reject if the primary peak exceeds this (runaway magnitude). Default 1e3. */
  readonly maxPeak?: number;
  /** Reject if |dcOffset| exceeds this (runaway DC). Default 1e3. */
  readonly maxAbsDcOffset?: number;
  /** Reject if crestFactor exceeds this (degenerate spike), checked only when the
   *  output is not silent. Default 1e4. */
  readonly maxCrestFactor?: number;
  /** STATEFUL kernels only (Frontier 7): reject if the primary output's second-half
   *  RMS exceeds its first-half RMS by more than this ratio — a slow-divergence /
   *  marginally-unstable-pole net the fixed peak bound can miss over a short probe.
   *  A settling (decaying) transient has ratio < 1 and trivially passes. Default 8. */
  readonly maxGrowthRatio?: number;
}

/** The verdict: `ok` carries the profile; a rejection carries the profile (for
 *  diagnostics) plus a stable reason. Rejection is a VALUE — never thrown. */
export type AcousticGateResult =
  | { readonly ok: true; readonly profile: AcousticProfile }
  | { readonly ok: false; readonly profile: AcousticProfile; readonly reason: string };

const DEFAULT_PROBE_LENGTH = 1024;
/** Stateful kernels probe LONGER by default (Frontier 7 §3): a marginally-unstable
 *  pole (radius ~1.001) needs more samples to diverge past the peak bound, and the
 *  growth check wants a long enough run to be meaningful. Cheap (pure-JS reference). */
const DEFAULT_STATEFUL_PROBE_LENGTH = 4096;
const DEFAULT_FUNDAMENTAL_BIN = 8;
const DEFAULT_PROBE_SCALAR = 0.5;
const DEFAULT_BANDS = 64;
const DEFAULT_MAX_PEAK = 1e3;
const DEFAULT_MAX_ABS_DC = 1e3;
const DEFAULT_MAX_CREST = 1e4;
const DEFAULT_MAX_GROWTH = 8;
/** Below this rms the output is treated as silent (crest = 0, crest-bound skipped). */
const SILENCE_EPS = 1e-12;

function isPow2(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

// ── the IR reference interpreter ────────────────────────────────────────────────
//
// A faithful JS evaluation of the kernel loop. Width rounding makes it bit-identical
// to the scalar WASM reference for f32 (which gate #2 proved == SIMD), so profiling
// its output == profiling the deliverable SIMD. Exported for reuse (Stage 3 can probe
// candidate IR with it before ever touching wabt).

function applyUnary(op: UnaryOp, a: number): number {
  switch (op) {
    case "neg": return -a;
    case "abs": return Math.abs(a);
    case "sqrt": return Math.sqrt(a);
    case "floor": return Math.floor(a);
    case "ceil": return Math.ceil(a);
    case "trunc": return Math.trunc(a);
  }
}

function applyBinary(op: BinaryOp, a: number, b: number): number {
  switch (op) {
    case "add": return a + b;
    case "sub": return a - b;
    case "mul": return a * b;
    case "div": return a / b;
    // NOTE: JS Math.min/max differ from WASM f*.min/max only on NaN/-0; the probe is
    // a clean sine, so this is immaterial to the fingerprint (documented in gate.ts).
    case "min": return Math.min(a, b);
    case "max": return Math.max(a, b);
  }
}

/**
 * Interpret an `IrKernel` over the given input arrays + scalars for `n` iterations,
 * returning the written output arrays (one entry per distinct store array, each sized
 * to the max affine index it writes). Rounds every leaf + arithmetic result to the
 * kernel width — bit-identical to the scalar WASM reference for f32.
 */
export function evalReference(
  ir: IrKernel,
  inputs: Record<string, ArrayLike<number>>,
  scalars: Record<string, number>,
  n: number,
): Record<string, number[]> {
  const round = signatureWidth(ir.signature) === "f32" ? Math.fround : (x: number) => x;
  const last = Math.max(0, n - 1);

  const outputs: Record<string, number[]> = {};
  for (const s of ir.stores) {
    const need = s.stride * last + s.intercept + 1;
    const cur = outputs[s.array];
    if (!cur) outputs[s.array] = new Array<number>(Math.max(1, need)).fill(0);
    else if (cur.length < need) for (let k = cur.length; k < need; k++) cur[k] = 0;
  }

  // State registers (Frontier 7) — SIMULTANEOUS semantics: `readState` sees the value
  // committed at the END of the previous iteration; writes commit after the iteration.
  // Initialized to the declared inits (rounded to width). This is the SPEC the scalar
  // WASM is gated against (docs/frontier7-statefulness-semantics.md §6).
  const stateDecls = ir.stateDecls ?? [];
  const stateStores = ir.stateStores ?? [];
  const states: Record<string, number> = {};
  for (const d of stateDecls) states[d.name] = round(d.init);

  const evalNode = (node: IrNode, i: number): number => {
    switch (node.kind) {
      case "const": return round(node.value);
      case "scalar": return round(scalars[node.name] ?? 0);
      case "load": {
        const src = inputs[node.array];
        const idx = node.stride * i + node.intercept;
        return round((src && idx >= 0 && idx < src.length ? src[idx]! : 0));
      }
      case "readState": return round(states[node.name] ?? 0);
      case "unary": return round(applyUnary(node.op, evalNode(node.a, i)));
      case "binary": return round(applyBinary(node.op, evalNode(node.a, i), evalNode(node.b, i)));
    }
  };

  for (let i = 0; i < n; i++) {
    for (const s of ir.stores) {
      outputs[s.array]![s.stride * i + s.intercept] = round(evalNode(s.value, i));
    }
    // Compute every register's next value from the PRE-commit state, then commit all —
    // order-independent (simultaneous), so the two passes can never observe a partial
    // update.
    if (stateStores.length > 0) {
      const next: Record<string, number> = {};
      for (const ss of stateStores) next[ss.name] = round(evalNode(ss.value, i));
      for (const k in next) states[k] = next[k]!;
    }
  }
  return outputs;
}

// ── the deterministic probe ───────────────────────────────────────────────────

function collectLoads(node: IrNode, byArray: Map<string, number>, n: number): void {
  switch (node.kind) {
    case "const":
    case "scalar":
    case "readState":
      return;
    case "load": {
      const need = node.stride * Math.max(0, n - 1) + node.intercept + 1;
      byArray.set(node.array, Math.max(byArray.get(node.array) ?? 0, need));
      return;
    }
    case "unary":
      collectLoads(node.a, byArray, n);
      return;
    case "binary":
      collectLoads(node.a, byArray, n);
      collectLoads(node.b, byArray, n);
      return;
  }
}

interface Probe {
  readonly inputs: Record<string, number[]>;
  readonly scalars: Record<string, number>;
  readonly n: number;
}

/** Build the fixed probe for a kernel: each input array gets a full-scale sine at a
 *  distinct harmonic of the fundamental bin; every scalar gets `probeScalar`. */
function buildProbe(ir: IrKernel, n: number, fundamentalBin: number, probeScalar: number): Probe {
  const sig = ir.signature;
  const inputParams = paramsByRole(sig, "input").map((p) => p.name);
  const scalarParams = paramsByRole(sig, "scalar").map((p) => p.name);

  // Determine, per input array, the max element index any load touches, so a stride>1
  // load never reads past the end of its probe array.
  const need = new Map<string, number>();
  for (const name of inputParams) need.set(name, n);
  for (const s of ir.stores) collectLoads(s.value, need, n);
  for (const ss of ir.stateStores ?? []) collectLoads(ss.value, need, n);

  const nyquist = n >> 1;
  const inputs: Record<string, number[]> = {};
  inputParams.forEach((name, k) => {
    // Distinct, bin-aligned, sub-Nyquist fundamental per input → harmonics stay clean.
    const f = Math.min(Math.max(1, fundamentalBin * (k + 1)), Math.max(1, nyquist - 1));
    const len = Math.max(n, need.get(name) ?? n);
    const arr = new Array<number>(len);
    for (let i = 0; i < len; i++) arr[i] = Math.sin((2 * Math.PI * f * i) / n);
    inputs[name] = arr;
  });

  const scalars: Record<string, number> = {};
  for (const name of scalarParams) scalars[name] = probeScalar;

  return { inputs, scalars, n };
}

// ── radix-2 FFT (in-place, decimation-in-time) ──────────────────────────────────
//
// The same stock Cooley-Tukey the phase-lock test uses. Deterministic (Math.sin/cos
// are IEEE). `re`/`im` are length N (a power of two); on return they hold the DFT.

function fft(re: Float64Array, im: Float64Array): void {
  const N = re.length;
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < N; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = k * step;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        const uRe = re[i + k + half]!;
        const uIm = im[i + k + half]!;
        const tRe = uRe * wRe - uIm * wIm;
        const tIm = uRe * wIm + uIm * wRe;
        re[i + k + half] = re[i + k]! - tRe;
        im[i + k + half] = im[i + k]! - tIm;
        re[i + k] = re[i + k]! + tRe;
        im[i + k] = im[i + k]! + tIm;
      }
    }
  }
}

interface Spectral {
  readonly spectralCentroid: number;
  readonly magnitude: number[];
}

/** Spectral centroid + L1-normalized band fingerprint of a power-of-two signal.
 *  DC (bin 0) is excluded from both (it is reported separately as `dcOffset`). */
function spectralOf(signal: Float64Array, bands: number): Spectral {
  const N = signal.length;
  const re = Float64Array.from(signal);
  const im = new Float64Array(N);
  fft(re, im);

  const half = N >> 1; // Nyquist bin
  const mag = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) mag[k] = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);

  // Centroid over the AC bins 1..half, normalized to [0,1] of Nyquist.
  let num = 0;
  let den = 0;
  for (let k = 1; k <= half; k++) { num += k * mag[k]!; den += mag[k]!; }
  const spectralCentroid = den > 0 ? num / den / half : 0;

  // Band fingerprint over the AC bins 1..half, then L1-normalized (amplitude-invariant).
  const fp = new Array<number>(bands).fill(0);
  const acBins = half; // bins 1..half
  for (let k = 1; k <= half; k++) {
    const b = Math.min(bands - 1, Math.floor(((k - 1) * bands) / acBins));
    fp[b]! += mag[k]!;
  }
  let total = 0;
  for (const v of fp) total += v;
  const magnitude = total > 0 ? fp.map((v) => v / total) : fp;

  return { spectralCentroid, magnitude };
}

// ── the profile + the gate ──────────────────────────────────────────────────────

function profileOutputs(
  ir: IrKernel, outputs: Record<string, number[]>, probeLength: number, bands: number,
): AcousticProfile {
  const outParams = paramsByRole(ir.signature, "output").map((p) => p.name);

  // Finiteness across ALL outputs (the cross-output safety that always matters).
  let finite = true;
  for (const name of outParams) {
    const arr = outputs[name];
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i]!)) { finite = false; break; }
    }
    if (!finite) break;
  }

  // Level + spectral fingerprint on the PRIMARY output.
  const primary = outParams[0] ? (outputs[outParams[0]] ?? []) : [];
  const m = primary.length;
  let peak = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < m; i++) {
    const v = primary[i]!;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v;
    sumSq += v * v;
  }
  const rms = m > 0 ? Math.sqrt(sumSq / m) : 0;
  const dcOffset = m > 0 ? sum / m : 0;
  const crestFactor = rms > SILENCE_EPS ? peak / rms : 0;

  // Spectral fields require a finite power-of-two signal. Copy the dense prefix into a
  // length-`probeLength` (power-of-two) buffer; skip the FFT for a non-finite output
  // (its spectrum would be all-NaN and the gate already rejects on `finite`).
  let spectralCentroid = 0;
  let magnitude = new Array<number>(bands).fill(0);
  if (finite && m > 0) {
    const buf = new Float64Array(probeLength);
    const lim = Math.min(probeLength, m);
    for (let i = 0; i < lim; i++) buf[i] = primary[i]!;
    const s = spectralOf(buf, bands);
    spectralCentroid = s.spectralCentroid;
    magnitude = s.magnitude;
  }

  return { finite, rms, peak, dcOffset, crestFactor, spectralCentroid, magnitude };
}

/**
 * Run gate #3 over an accepted `IrKernel`. Builds the deterministic probe, evaluates
 * the IR reference (no wasm), extracts the `AcousticProfile`, and ACCEPTS iff the
 * profile is finite + within the sane bounds. Rejection is a VALUE (the profile is
 * attached either way). Pure + deterministic — same kernel ⇒ byte-identical verdict.
 */
export function acousticGate(ir: IrKernel, opts: AcousticGateOptions = {}): AcousticGateResult {
  const stateful = isStateful(ir);
  const probeLength = opts.probeLength ?? (stateful ? DEFAULT_STATEFUL_PROBE_LENGTH : DEFAULT_PROBE_LENGTH);
  if (!isPow2(probeLength)) {
    throw new Error(`acousticGate: probeLength must be a power of two, got ${probeLength}`);
  }
  const bands = opts.fingerprintBands ?? DEFAULT_BANDS;
  const fundamentalBin = opts.fundamentalBin ?? DEFAULT_FUNDAMENTAL_BIN;
  const probeScalar = opts.probeScalar ?? DEFAULT_PROBE_SCALAR;
  const maxPeak = opts.maxPeak ?? DEFAULT_MAX_PEAK;
  const maxAbsDc = opts.maxAbsDcOffset ?? DEFAULT_MAX_ABS_DC;
  const maxCrest = opts.maxCrestFactor ?? DEFAULT_MAX_CREST;
  const maxGrowth = opts.maxGrowthRatio ?? DEFAULT_MAX_GROWTH;

  const probe = buildProbe(ir, probeLength, fundamentalBin, probeScalar);
  const outputs = evalReference(ir, probe.inputs, probe.scalars, probe.n);
  const profile = profileOutputs(ir, outputs, probeLength, bands);

  if (!profile.finite) {
    return { ok: false, profile, reason: "non-finite: output contains NaN or Inf" };
  }
  if (profile.peak > maxPeak) {
    return { ok: false, profile, reason: `peak-out-of-bounds: peak ${profile.peak} > ${maxPeak}` };
  }
  if (Math.abs(profile.dcOffset) > maxAbsDc) {
    return { ok: false, profile, reason: `dc-out-of-bounds: |dc| ${Math.abs(profile.dcOffset)} > ${maxAbsDc}` };
  }
  if (profile.rms > SILENCE_EPS && profile.crestFactor > maxCrest) {
    return { ok: false, profile, reason: `crest-out-of-bounds: crest ${profile.crestFactor} > ${maxCrest}` };
  }
  // Stability net for stateful kernels (Frontier 7 §3): slow divergence the fixed peak
  // bound can miss over a short window. Free for stateless kernels (not run), so their
  // verdicts are byte-identical to pre-statefulness.
  if (stateful) {
    const growth = growthRatio(ir, outputs);
    if (growth > maxGrowth) {
      return { ok: false, profile, reason: `unstable-growth: 2nd/1st-half RMS ratio ${growth} > ${maxGrowth}` };
    }
  }
  return { ok: true, profile };
}

/** Second-half / first-half RMS of the primary output — the slow-divergence net.
 *  Returns 0 for an empty/silent first half (no growth to measure). */
function growthRatio(ir: IrKernel, outputs: Record<string, number[]>): number {
  const primaryName = paramsByRole(ir.signature, "output")[0]?.name;
  const y = primaryName ? outputs[primaryName] : undefined;
  if (!y || y.length < 2) return 0;
  const half = y.length >> 1;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < half; i++) s1 += y[i]! * y[i]!;
  for (let i = half; i < y.length; i++) s2 += y[i]! * y[i]!;
  const rms1 = Math.sqrt(s1 / Math.max(1, half));
  const rms2 = Math.sqrt(s2 / Math.max(1, y.length - half));
  return rms1 > SILENCE_EPS ? rms2 / rms1 : 0;
}
