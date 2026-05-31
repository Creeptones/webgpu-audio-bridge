// voices.js — the ONE fixed stateful per-voice kernel + the keyboard/voice config
// for the poly-synth demo (Apollo Frontier 7, Stage 4 — SIMD across voices).
//
// The headline of Stage 4: a STATEFUL kernel re-engages SIMD along the VOICE axis.
// Polyphony hands us V independent voices, each running the SAME kernel with its OWN
// state + per-voice scalars; pack W voices per v128 (lane j = voice j) and one
// sequential time loop advances all W recurrences lane-parallel. The single kernel
// here is deliberately STATEFUL on BOTH state kinds so the demo exercises the whole
// Frontier-7 stack at once:
//
//   • a one-pole lowpass (a single-sample state REGISTER `s` — Stage 1/2), and
//   • a feedback comb / echo (a delay-line RING BUFFER `d` of length D — Stage 3),
//
// batched across V = 8 voices (Stage 4). Per sample, per voice v:
//
//     lp   = (1 − c)·x + c·s        // one-pole lowpass; c = per-voice cutoff coef
//     echo = lp + fb·d[i − D]       // feedback comb; fb = shared decay/space
//     out  = echo
//     s   := lp                     // commit the register at iteration end
//     d   <- echo                   // write the ring at the cursor
//
// `x` is a per-voice saw oscillator the worklet generates at each voice's keyboard
// pitch; `c` is a PER-VOICE scalar (an array — each voice its own timbre); `fb` is a
// BROADCAST scalar (one number → all voices). That mix is the point: the demo shows
// both the per-voice-array AND the broadcast scalar conventions. No IrNode references
// another voice, so lane j is bit-for-bit a scalar run of voice j — which is exactly
// what the voice-equivalence gate proves before these bytes can reach the audio
// thread.
//
// The kernel is built as an `IrKernel` (the same inline builders the Stage-4 test
// tests/voiceKernel.test.ts uses) and serialized to a SELF-CONTAINED token stream
// with `kernelToTokens` (the `param`/`state`/`stateBuffer` tokens carry the whole
// shape). The page ships the stream to a background compile worker (`runJitCompile`,
// which runs `compileTokens` with `voices: 8` → the syntax + equivalence gates +
// emits the voice-SIMD module); `connectJit({ tokens, voices })` builds the worklet
// plumbing and the gate-verified voice-SIMD bytes live-swap in click-free.

import { kernelToTokens, tokensToString, kernelHash } from "../../dist/experimental/index.js";

// ── inline IR builders (mirror tests/voiceKernel.test.ts) ──────────────────────
const C  = (value) => ({ kind: "const", value });
const S  = (name) => ({ kind: "scalar", name });
const L  = (array, stride = 1, intercept = 0) => ({ kind: "load", array, stride, intercept });
const RS = (name) => ({ kind: "readState", name });
const RD = (buffer, delay) => ({ kind: "readDelay", buffer, delay });
const Bn = (op, a, b) => ({ kind: "binary", op, a, b });
const ST = (array, value, stride = 1, intercept = 0) => ({ array, stride, intercept, value });
const P  = (name, role) => ({ name, role });

// ── the kernel (f32 ⇒ W = 4 lanes per v128) ────────────────────────────────────

/** Delay length of the feedback comb, in samples (a fixed compile-time integer —
 *  v1 delays are fixed `z⁻N`; D ≈ 21 ms at 48 kHz gives an audible shimmer/echo). */
export const COMB_D = 1024;

// lp = (1−c)·x + c·s. Shared subtree (reused by the output store AND the writeState —
// reusing one object reference is fine; the IR is only ever read, never mutated).
const lp = Bn("add", Bn("mul", Bn("sub", C(1), S("c")), L("x")), Bn("mul", S("c"), RS("s")));
// echo = lp + fb·d[i−D]. Reused by the output store AND the writeDelay.
const echo = Bn("add", lp, Bn("mul", S("fb"), RD("d", COMB_D)));

/** The kernel IR: a per-voice lowpass + feedback comb. Stateful on a register (`s`)
 *  AND a delay buffer (`d`); per-voice scalar `c`, broadcast scalar `fb`. */
export const KERNEL_IR = {
  width: "f32",
  bound: { kind: "param", name: "n" },
  signature: {
    width: "f32",
    params: [
      P("n", "length"),
      P("out", "output"),
      P("x", "input"),
      P("c", "scalar"),
      P("fb", "scalar"),
    ],
  },
  stores: [ST("out", echo)],
  stateDecls: [{ name: "s", init: 0 }],
  stateStores: [{ name: "s", value: lp }],
  stateBuffers: [{ name: "d", length: COMB_D }],
  stateBufferStores: [{ buffer: "d", value: echo }],
};

/** The self-contained token stream shipped to the compile worker + connectJit. */
export const KERNEL_TOKENS = kernelToTokens(KERNEL_IR);
/** The copy-pasteable flat grammar form (for the on-page display). */
export const KERNEL_TEXT = tokensToString(KERNEL_TOKENS);
/** The content address (cache key / identity — informational in this demo). */
export const KERNEL_HASH = kernelHash(KERNEL_IR);
/** The KernelSignature passed to connectJit (consistent with the embedded stream). */
export const SIGNATURE = KERNEL_IR.signature;

// ── the fixed voice batch + the keyboard map ───────────────────────────────────

/** Polyphonic voice count. f32 ⇒ W = 4 lanes per v128 ⇒ V = 8 is 2 batches of 4.
 *  Fixed at allocation (v1 has no dynamic voice allocation / stealing — that is the
 *  synth layer, a deferred follow-up; here key N drives voice N directly). */
export const VOICES = 8;

/** Maximum block size per quantum (sizes the consumer's scratch slabs). */
export const MAX_BLOCK = 128;

/** Equal-tempered note table — one C-major octave, one note per voice slot. Each
 *  entry maps a computer key + a label to a fundamental frequency (Hz). Voice v ↔
 *  NOTES[v] (the trivial fixed mapping; key N → voice N, no stealing). */
export const NOTES = [
  { key: "a", label: "C4", freq: 261.63 },
  { key: "s", label: "D4", freq: 293.66 },
  { key: "d", label: "E4", freq: 329.63 },
  { key: "f", label: "F4", freq: 349.23 },
  { key: "g", label: "G4", freq: 392.00 },
  { key: "h", label: "A4", freq: 440.00 },
  { key: "j", label: "B4", freq: 493.88 },
  { key: "k", label: "C5", freq: 523.25 },
];

/**
 * Per-voice lowpass cutoff coefficients for the kernel's `c` scalar ARRAY, derived
 * from a global "tone" base + the voice index so higher voices are progressively
 * brighter (a smaller coefficient = less smoothing = brighter). This is the
 * per-voice-scalar-array convention made tangible — each lane gets its own value.
 * @param tone base coefficient in [0, 1) from the Tone slider (higher = darker).
 */
export function cutoffsForTone(tone) {
  const out = new Array(VOICES);
  for (let v = 0; v < VOICES; v++) {
    // brighter (smaller c) for higher voices: scale the base down across the octave.
    out[v] = Math.max(0, Math.min(0.97, tone * (1 - 0.55 * (v / (VOICES - 1)))));
  }
  return out;
}
