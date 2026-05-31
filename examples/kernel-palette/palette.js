// palette.js — a hand-authored palette of TOKEN kernels (the Stage-3 SLM stand-in).
//
// Apollo Frontier 6 turns the JIT into a language→music engine: a model emits DSP
// kernels as kernel-grammar TOKEN STREAMS, each content-addressed, gate-verified,
// and live-swapped into a running AudioWorklet. There is no model yet — Stage 1
// proved the *model-free* chain (tokens → IR → gate → install → audio) with a
// hand-authored palette in the model's seat. This file IS that palette.
//
// Each kernel is built as an `IrKernel` via the same inline builders the Stage-1
// test (tests/compileTokens.test.ts) uses, then serialized to a SELF-CONTAINED
// token stream with `kernelToTokens` (the `param` tokens carry the signature). The
// page ships the stream to the compile+cache worker; the worker `getOrCompile`s it
// (syntax gate → equivalence gate → characterize, or an instant cache hit) and the
// gate-verified SIMD bytes fade into the worklet click-free.
//
// These six are exactly the palette pinned bit-exact by tests/compileTokens.test.ts
// (gain / hardclip / cubic-softclip / ringmod / mix / rectify-scale), so the browser
// compile is known to pass the equivalence gate. All names are JS-safe identifiers
// (out/x/a/b/g/n) so `emitJsKernel`'s fallback source is plain valid JS.

import { kernelToTokens, tokensToString, kernelHash } from "../../dist/experimental/index.js";

// ── inline IR builders (mirror tests/compileTokens.test.ts) ────────────────────
const C  = (value) => ({ kind: "const", value });
const S  = (name) => ({ kind: "scalar", name });
const L  = (array, stride = 1, intercept = 0) => ({ kind: "load", array, stride, intercept });
const U  = (op, a) => ({ kind: "unary", op, a });
const Bn = (op, a, b) => ({ kind: "binary", op, a, b });
const ST = (array, value, stride = 1, intercept = 0) => ({ array, stride, intercept, value });
const P  = (name, role) => ({ name, role });
const pb = (name) => ({ kind: "param", name });
const K  = (width, params, bound, stores) => ({ width, bound, stores, signature: { params, width } });

// ── the palette (IR) ───────────────────────────────────────────────────────────
const KERNELS = [
  {
    id: "gain",
    label: "Gain — out = x · g",
    blurb: "Scalar multiply: the canonical kernel. Its content hash is the cache key.",
    ir: K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
      [ST("out", Bn("mul", L("x"), S("g")))]),
    scalars: { g: { label: "gain", min: 0, max: 3, value: 1.4, step: 0.01 } },
  },
  {
    id: "hardclip",
    label: "Hard clip — out = clamp(x, −1, 1)",
    blurb: "min(max(x, −1), 1). Raise the input level above 1 and the saw clips to a buzzy square.",
    ir: K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
      [ST("out", Bn("min", Bn("max", L("x"), C(-1)), C(1)))]),
    scalars: {},
  },
  {
    id: "cubic-softclip",
    label: "Cubic soft clip — out = x − x³⁄3   (f64)",
    blurb: "An odd cubic saturator computed in f64; the gate proves the SIMD f64x2 path bit-exact.",
    ir: K("f64", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
      [ST("out", Bn("sub", L("x"), Bn("div", Bn("mul", Bn("mul", L("x"), L("x")), L("x")), C(3))))]),
    scalars: {},
  },
  {
    id: "ringmod",
    label: "Ring mod — out = a · b",
    blurb: "Two inputs: a saw (a) times a sine (b). Classic metallic amplitude modulation.",
    ir: K("f32", [P("n", "length"), P("out", "output"), P("a", "input"), P("b", "input")], pb("n"),
      [ST("out", Bn("mul", L("a"), L("b")))]),
    scalars: {},
  },
  {
    id: "mix",
    label: "Crossfade — out = (1−g)·a + g·b   (f64)",
    blurb: "Linear crossfade between a saw (a) and a sine (b). Sweep g to morph the timbre.",
    ir: K("f64", [P("n", "length"), P("out", "output"), P("a", "input"), P("b", "input"), P("g", "scalar")], pb("n"),
      [ST("out", Bn("add", Bn("mul", Bn("sub", C(1), S("g")), L("a")), Bn("mul", S("g"), L("b"))))]),
    scalars: { g: { label: "mix (a→b)", min: 0, max: 1, value: 0.5, step: 0.01 } },
  },
  {
    id: "rectify-scale",
    label: "Rectify + scale — out = |x| · g",
    blurb: "Full-wave rectifier with gain — an octave-up buzz (abs auto-vectorizes to f32x4.abs).",
    ir: K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
      [ST("out", Bn("mul", U("abs", L("x")), S("g")))]),
    scalars: { g: { label: "gain", min: 0, max: 3, value: 1.6, step: 0.01 } },
  },
];

// ── serialize each kernel to a self-contained token stream + display metadata ──
export const PALETTE = KERNELS.map((k) => {
  const tokens = kernelToTokens(k.ir);
  const params = k.ir.signature.params;
  return {
    id: k.id,
    label: k.label,
    blurb: k.blurb,
    tokens,                         // the self-contained stream shipped to the worker
    signature: k.ir.signature,      // passed to connectJit (consistent with the stream)
    width: k.ir.width,
    scalars: k.scalars,             // UI slider config, per scalar name
    text: tokensToString(tokens),   // the copy-pasteable flat grammar form
    hash: kernelHash(k.ir),         // content address (matches the worker's cache key)
    inputs: params.filter((p) => p.role === "input").map((p) => p.name),
    scalarNames: params.filter((p) => p.role === "scalar").map((p) => p.name),
    outputName: params.find((p) => p.role === "output").name,
  };
});

/** Maximum block size per quantum (sizes the consumer's scratch slabs). */
export const MAX_BLOCK = 128;
