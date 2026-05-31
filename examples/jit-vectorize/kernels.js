// kernels.js — the developer's NAIVE scalar DSP kernel + its declared I/O shape.
//
// This is ALL a developer writes. `connectJit` snapshots `softClip.toString()`
// and ships the SAME source string to BOTH off-thread realms — the compile worker
// (→ auto-vectorized WASM SIMD) and the AudioWorklet (→ the permanent JS fallback)
// — because a function CLOSURE cannot cross `postMessage`.
//
// `softClip` is a cubic waveshaper (a classic analog-style saturator): scale the
// input by `drive`, hard-limit to [-1, 1], then apply the odd cubic `1.5t − 0.5t³`.
// It lives entirely inside the JIT's compilable sub-language — one counted loop,
// affine array loads, and only `Math.min`/`Math.max` from the exactly-reproducible
// whitelist — so the compiler auto-vectorizes it to f32x4 and the equivalence gate
// proves the SIMD output BIT-EXACT to this scalar source (worst ULP = 0) before a
// single sample of it is ever allowed near the audio thread.

export function softClip(out, x, drive, n) {
  for (let i = 0; i < n; i++) {
    const t = Math.max(Math.min(x[i] * drive, 1), -1);
    out[i] = 1.5 * t - 0.5 * t * t * t;
  }
}

/** The kernel I/O shape, in the source function's parameter order. */
export const SIGNATURE = {
  width: "f32",
  params: [
    { name: "out", role: "output" },
    { name: "x", role: "input" },
    { name: "drive", role: "scalar" },
    { name: "n", role: "length" },
  ],
};

/** Maximum block size per quantum (sizes the consumer's scratch slabs). */
export const MAX_BLOCK = 128;
