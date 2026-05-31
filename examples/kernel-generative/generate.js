// generate.js — the MODEL-FREE kernel generator + acoustic curator.
//
// Apollo Frontier 6, Stage 3a put the constrained-decoder mask (`legalNextTokens`)
// in place; this demo uses it WITHOUT a model. A tiny seeded LCG plays the role of
// the Stage-3b SLM: at every position it picks ONLY from the kinds the mask offers
// and fills operands from the fixed declared signature, so — by the no-invalid-stream
// property proven in tests/legalNextTokens.test.ts — it can NEVER emit a structurally
// invalid stream. The three gates (syntax → equivalence → acoustic) then decide
// whether the kernel is safe + sane to hear; `curate()` adds an "is it audibly
// interesting" filter on top of gate #3's sanity floor.
//
// Every generated kernel shares ONE signature (two inputs in0/in1, one scalar g, one
// output) so the audio graph can be built once and successive kernels installed over
// it (the consumer crossfades SIMD→SIMD — a click-free morph between kernels).

import {
  legalNextTokens, validateTokens, tokensToString, kernelHash,
} from "../../dist/experimental/index.js";

// ── the fixed generated-kernel signature (the "model's" I/O contract) ───────────
export const GEN_SIGNATURE = {
  params: [
    { name: "n", role: "length" },
    { name: "out", role: "output" },
    { name: "in0", role: "input" },   // the arpeggio voice
    { name: "in1", role: "input" },   // the rhythmic voice
    { name: "g", role: "scalar" },    // a live-modulated knob
  ],
  width: "f32",
};

// A trivial bootstrap kernel (out = in0 · g) so audio starts immediately before the
// first generated kernel installs. Same signature as every generated kernel.
export const BOOTSTRAP_TOKENS = [
  { t: "width", width: "f32" },
  { t: "param", name: "n", role: "length" },
  { t: "param", name: "out", role: "output" },
  { t: "param", name: "in0", role: "input" },
  { t: "param", name: "in1", role: "input" },
  { t: "param", name: "g", role: "scalar" },
  { t: "bound", bound: { kind: "param", name: "n" } },
  { t: "load", array: "in0", stride: 1, intercept: 0 },
  { t: "scalar", name: "g" },
  { t: "binary", op: "mul" },
  { t: "store", array: "out", stride: 1, intercept: 0 },
];

// The generative VOCABULARY. The grammar supports div + sqrt, but they readily
// produce NaN/±Inf (div-by-≈0, sqrt of a negative saw sample) that the gates safely
// reject — so excluding them from the *emitter's* choices keeps the audible hit-rate
// high while the gates still stand guard. (The mask permits them; the model simply
// doesn't pick them — a legitimate emitter policy.)
const UN_OPS = ["neg", "abs", "floor", "ceil", "trunc"];
const BIN_OPS = ["add", "sub", "mul", "min", "max"];
const CONSTS = [-2, -1, -0.5, 0.5, 1, 2, 3];
const INPUTS = ["in0", "in1"];

function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// Build ONE mask-driven stream. Depth-aware so it always terminates at a complete,
// valid kernel; every chosen kind is taken from `legalNextTokens(...).kinds`.
function buildStream(seed) {
  const rng = lcg(seed);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const stream = [
    { t: "width", width: "f32" },
    { t: "param", name: "n", role: "length" },
    { t: "param", name: "out", role: "output" },
    { t: "param", name: "in0", role: "input" },
    { t: "param", name: "in1", role: "input" },
    { t: "param", name: "g", role: "scalar" },
    { t: "bound", bound: { kind: "param", name: "n" } },
  ];
  let depth = 0;
  let stores = 0;
  let guard = 0;
  for (;;) {
    if (++guard > 2000) break; // safety net — unreachable in practice
    const { kinds, done } = legalNextTokens(stream);
    if (done && stores >= 1 && (rng() < 0.45 || guard > 70)) break;

    let choice;
    if (depth === 0) {
      // value-pushers only; bias toward `load` so kernels actually shape the source
      const r = rng();
      choice = r < 0.62 ? "load" : r < 0.82 ? "scalar" : "const";
    } else if (depth >= 4) {
      choice = depth >= 2 ? "binary" : "store"; // reduce hard past the cap
    } else if (depth === 1 && rng() < 0.45) {
      choice = "store"; // finish the statement
    } else {
      const opts = ["const", "scalar", "load", "unary", "binary", "store"].filter((k) => kinds.has(k));
      choice = pick(opts);
    }
    if (!kinds.has(choice)) {
      // defensive: never escape the mask
      const body = [...kinds].filter((k) => k !== "width" && k !== "param" && k !== "bound");
      choice = pick(body);
    }

    switch (choice) {
      case "const": stream.push({ t: "const", value: pick(CONSTS) }); depth++; break;
      case "scalar": stream.push({ t: "scalar", name: "g" }); depth++; break;
      case "load": stream.push({ t: "load", array: pick(INPUTS), stride: 1, intercept: 0 }); depth++; break;
      case "unary": stream.push({ t: "unary", op: pick(UN_OPS) }); break; // depth unchanged
      case "binary": stream.push({ t: "binary", op: pick(BIN_OPS) }); depth--; break;
      case "store": stream.push({ t: "store", array: "out", stride: 1, intercept: 0 }); depth--; stores++; break;
      default: break;
    }
  }
  return stream;
}

/**
 * Generate a valid kernel from a seed. Retries with a perturbed seed on the (rare)
 * chance the depth-cap safety net cut a stream off mid-expression — so the returned
 * stream is ALWAYS `validateTokens`-accepted. Returns { tokens, signature, text, hash, seed }.
 */
export function generateKernel(seedBase) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const seed = (seedBase + attempt * 7919) >>> 0;
    const stream = buildStream(seed);
    const v = validateTokens(stream);
    if (v.ok) {
      return { tokens: stream, signature: v.ir.signature, text: tokensToString(stream), hash: kernelHash(stream), seed };
    }
  }
  // Astronomically unlikely fallback: the bootstrap gain kernel.
  const v = validateTokens(BOOTSTRAP_TOKENS);
  return { tokens: BOOTSTRAP_TOKENS, signature: v.ir.signature, text: tokensToString(BOOTSTRAP_TOKENS), hash: kernelHash(BOOTSTRAP_TOKENS), seed: seedBase >>> 0 };
}

/**
 * The CURATION filter — "is this acoustically interesting", layered on top of gate
 * #3's sanity floor (which already guaranteed finite + bounded peak/dc/crest). Pure
 * function of the `AcousticProfile` so the page and the headless self-test share it.
 * Returns { ok, why }.
 */
export function curate(acoustic, opts = {}) {
  const minRms = opts.minRms ?? 0.02;   // reject near-silent / constant outputs
  const maxRms = opts.maxRms ?? 40;     // reject ear-splitting outputs (gate #3 allows up to 1e3)
  const maxDc = opts.maxDc ?? 0.6;      // reject heavy DC offset (a thump, not a tone)
  if (!acoustic) return { ok: false, why: "no profile" };
  if (!acoustic.finite) return { ok: false, why: "non-finite" };
  if (acoustic.rms < minRms) return { ok: false, why: "too quiet / constant" };
  if (acoustic.rms > maxRms) return { ok: false, why: "too loud" };
  if (Math.abs(acoustic.dcOffset) > maxDc) return { ok: false, why: "heavy DC offset" };
  return { ok: true, why: "musical" };
}
