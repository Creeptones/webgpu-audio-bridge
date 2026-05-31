/*
 * JIT vectorizer — STAGE 0 THROWAWAY PROBE (Apollo Frontier 5, 0.9.912)
 * =============================================================================
 *
 * STATUS: throwaway correctness probe, NOT production code, NOT in src/. It is
 * deliberately a single dependency-free .mjs so it runs with bare `node` (no
 * build, no tsx, no acorn). It is the runnable half of the Stage 0 deliverable
 * described in docs/frontier5-jit-handoff.md, and the sibling of the ring
 * frontiers' bench/{mpmc,spmc}-probe.mjs — but the hazard, and therefore the
 * enumerated axis, is different: the ring probes explore THREAD INTERLEAVINGS
 * (a concurrency hazard); this probe explores (PROGRAMS × INPUTS) (a program-
 * transform hazard). It will be SUPERSEDED at Stage 1a by the in-CI fuzzer
 * tests/JitCompiler.interleaving.test.ts (which ports this DFS + adds the API
 * pins) and may be deleted once that lands.
 *
 *   Run:  node bench/jit-probe.mjs
 *
 * WHAT THIS PROBE SETTLES (the Stage-0 design questions):
 *
 *   The JIT auto-vectorizes a naive scalar per-sample loop into WASM SIMD by
 *   packing W consecutive iterations (W=4 for f32x4, W=2 for f64x2) into one
 *   register. The claim is LANE-WISE EQUIVALENCE: for every program P in the
 *   compilable sub-language (docs/frontier5-jit-semantics.md) and every input,
 *   the vectorized result equals the scalar result BIT-EXACTLY (f64) / WITHIN A
 *   DECLARED ULP BUDGET (f32). This probe is the executable check of that claim
 *   and the executable exhibition of the variants that BREAK it.
 *
 * THE TWO EVALUATORS UNDER TEST (deliberately separate code paths over a shared
 * set of IEEE primitive ops — exactly as a real SIMD lane op equals the scalar
 * op, the separateness is in the GATHER/TRAVERSAL structure):
 *
 *   evalScalar(expr, ins, k)        one index at a time   (the GROUND TRUTH
 *                                   denotation: left-to-right, NO FMA, no reassoc)
 *   runSimdModel(expr, ins, n)      W-lane chunks (gather → lane-wise op →
 *                                   scatter) + a SCALAR EPILOGUE for the n%W tail
 *                                   (models the wasm/decoder.wat simdEnd/tailEnd
 *                                   partition the vectorizer generates)
 *
 * THE FINDINGS (printed by the scenarios, mirroring the ring probes' shape —
 * state the sound design, prove it equivalent, exhibit the naive variant's
 * concrete failure):
 *
 *   FINDING 1 (SCENARIO B): a lowering that FUSES `a*b + c` into a single-
 *     rounding FMA (or reassociates) is UNSOUND for the bit-exact f64 claim. It
 *     rounds ONCE where the source rounds TWICE, so on an adversarial input the
 *     FMA'd kernel differs from the scalar reference in the last bit. The probe
 *     exhibits a concrete witness (a=b=1+EPS, c=-(a*b): scalar→0, fused→2^-104).
 *     => The non-reassociation / never-emit-relaxed_madd invariant is LOAD-
 *        BEARING. The gate (and the proof note) enforce it.
 *
 *   FINDING 2 (SCENARIO D, 'shuffle'): a lowering that SKIPS the deinterleave
 *     (reads a stride-2 AoS array as if it were SoA) produces wrong output; the
 *     differential gate catches it. => the deinterleave permutation is real.
 *
 * The four scenarios are the negative/positive controls:
 *   A  SOUND: runSimdModel ≡ evalScalar over the whole enumerated program×input
 *      space + 4 metamorphic relations (the positive proof).
 *   B  FMA candidate DIVERGES (FINDING 1 confirmed) while the SOUND model agrees.
 *   C  every OUT-OF-SUBSET program is REJECTED with the expected E_* diagnostic
 *      (the silent-mis-compile guard — a validator that accepts one is a FAIL).
 *   D  every deliberately-WRONG candidate is CAUGHT by the differential check
 *      (the gate's comparison is load-bearing — a gate that accepts one is a FAIL).
 *
 * See docs/frontier5-vectorization-correctness-proof.md for the written argument.
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// 1. IEEE-754 primitives, bit comparison, seeded PRNG, edge corpus
// ─────────────────────────────────────────────────────────────────────────────

const fr = Math.fround; // the explicit f64→f32 narrowing (Math.fround / f32.demote)

// Width-tagged IEEE ops. f32 results are rounded once via fr() (single f32.*
// op); f64 results are native doubles. Both evaluators call THESE — a real SIMD
// lane op IS the scalar op; the lowering's only freedom is the gather order.
const W_OF = { f32: 4, f64: 2 };
function rnd(v, w) { return w === "f32" ? fr(v) : v; }
function opAdd(a, b, w) { return rnd(a + b, w); }
function opSub(a, b, w) { return rnd(a - b, w); }
function opMul(a, b, w) { return rnd(a * b, w); }
function opDiv(a, b, w) { return rnd(a / b, w); }
function opNeg(a, w) { return rnd(-a, w); }
function opAbs(a, w) { return rnd(Math.abs(a), w); }
function opSqrt(a, w) { return rnd(Math.sqrt(a), w); }
// WASM f*.min / f*.max semantics: NaN propagates; -0 is less than +0.
function opMin(a, b, w) {
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  if (a === 0 && b === 0) return Object.is(a, -0) || Object.is(b, -0) ? -0 : 0;
  return rnd(a < b ? a : b, w);
}
function opMax(a, b, w) {
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  if (a === 0 && b === 0) return Object.is(a, -0) || Object.is(b, -0) ? 0 : 0;
  return rnd(a > b ? a : b, w);
}

// Exact bit patterns (so -0 ≠ +0, and a NaN equals a NaN with identical bits).
const _b8 = new DataView(new ArrayBuffer(8));
const _b4 = new DataView(new ArrayBuffer(4));
function bitsF64(x) { _b8.setFloat64(0, x); return _b8.getBigUint64(0); }
function bitsF32(x) { _b4.setFloat32(0, x); return _b4.getUint32(0) >>> 0; }
function bitEqual(a, b, w) {
  return w === "f32" ? bitsF32(a) === bitsF32(b) : bitsF64(a) === bitsF64(b);
}
// f32 ULP distance (ordered-int trick) — only for the within-ULP REPORT; the
// sound model is bit-exact so this is always 0 in SCENARIO A.
function ulpDistF32(a, b) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) === Number.isNaN(b) ? 0 : Infinity;
  let ia = bitsF32(a), ib = bitsF32(b);
  const order = (u) => (u & 0x80000000 ? (0x100000000 - u) >>> 0 : (u | 0x80000000) >>> 0);
  ia = order(ia); ib = order(ib);
  return Math.abs(ia - ib);
}

// Deterministic LCG (NO Math.random — the probe must be reproducible).
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}

// The IEEE edge classes a wrong lowering hides behind.
const EDGE = [
  0, -0, 1, -1, 0.5, -0.5, 2, -2, 3, -3,
  Math.PI, Math.E,
  Infinity, -Infinity, NaN,
  Number.MIN_VALUE, 5e-324, -5e-324, // denormals
  Number.MAX_VALUE, -Number.MAX_VALUE,
  1 + Number.EPSILON, 1 - Number.EPSILON / 2,
  8388609, // 2^23 + 1 (f32 rounding boundary)
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. The IR (a typed expression tree over the v1 sub-language)
// ─────────────────────────────────────────────────────────────────────────────
//
// Leaves carry their width. A whole enumerated program has ONE width (no mixed
// width in a VALID program — §2 of the semantics). Invalid programs (SCENARIO C)
// are constructed deliberately to trip validate().

const lit = (v, w) => ({ op: "lit", v, w });
const load = (arr, stride, intercept, w) => ({ op: "load", arr, stride, intercept, w });
const scalar = (name, w) => ({ op: "scalar", name, w });
const u = (op, a) => ({ op, a });
const b = (op, a, bb) => ({ op, a, b: bb });

const UNARY = new Set(["neg", "abs", "sqrt", "floor", "ceil", "trunc", "fround"]);
const BINARY = new Set(["add", "sub", "mul", "div", "min", "max"]);

// Canonical string for dedup + traces.
function key(n) {
  switch (n.op) {
    case "lit": return `${n.v}_${n.w}`;
    case "load": return `${n.arr}[${n.stride}i+${n.intercept}]`;
    case "scalar": return `$${n.name}`;
    default:
      // Tolerate deliberately-malformed nodes (SCENARIO C builds invalid shapes).
      if (n.a !== undefined && n.b !== undefined) return `${n.op}(${key(n.a)},${key(n.b)})`;
      if (n.a !== undefined) return `${n.op}(${key(n.a)})`;
      return `${n.op}()`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Validate — the reject-first classifier (models src/jit/validate.ts policy).
//    Returns null (ACCEPT) or an E_* code. Every code in the semantics table is
//    exercised by SCENARIO C. Syntactic-only codes (E_CONTROL/E_DYNAMIC/…) are
//    modelled via a top-level `illegal` tag, because acorn parsing is Stage 1a;
//    the probe pins the POLICY (each construct → its code, none silently OK).
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_MATH = new Set(["min", "max", "abs", "sqrt", "floor", "ceil", "trunc", "fround"]);
const SYNTACTIC = {
  control: "E_CONTROL", dynamic: "E_DYNAMIC", reassign: "E_REASSIGN",
  call: "E_CALL", shape: "E_SHAPE", useBeforeDef: "E_USE_BEFORE_DEF",
};

function validateExpr(n) {
  switch (n.op) {
    case "lit":
      if (!Number.isFinite(n.v)) return "E_NONFINITE_LITERAL";
      return null;
    case "load":
      if (n.stride !== 1 && n.stride !== 2) return "E_STRIDE";
      if (!Number.isInteger(n.intercept) || n.intercept < 0) return "E_STRIDE";
      return null;
    case "scalar": return null;
    // explicitly out-of-subset expression nodes:
    case "ternary": return "E_BRANCH";
    case "logicAnd": case "logicOr": return "E_BRANCH";
    case "loadPrev": return "E_LOOP_CARRY"; // reads index i-1
    case "accum": return "E_LOOP_CARRY";    // reads a value from a previous iteration
    case "mod": case "bitand": case "bitor": case "shl": case "cmp": return "E_OP";
    case "sin": case "cos": case "tan": case "exp": case "log": case "pow": return "E_TRANSCENDENTAL";
    default: break;
  }
  if (UNARY.has(n.op)) {
    const e = validateExpr(n.a); if (e) return e;
    // fround is the ONE width-changing node (f64→f32); others preserve width.
    return null;
  }
  if (BINARY.has(n.op)) {
    const ea = validateExpr(n.a); if (ea) return ea;
    const eb = validateExpr(n.b); if (eb) return eb;
    if (widthOf(n.a) !== widthOf(n.b)) return "E_MIXED_WIDTH";
    return null;
  }
  return "E_CALL"; // any unrecognized node kind: treat as a disallowed call
}

function widthOf(n) {
  switch (n.op) {
    case "fround": return "f32";
    case "lit": case "load": case "scalar": return n.w;
    default:
      return UNARY.has(n.op) ? widthOf(n.a) : widthOf(n.a); // binary: children equal (validated)
  }
}

function validate(prog) {
  if (prog.illegal) return SYNTACTIC[prog.illegal] || "E_SHAPE";
  return validateExpr(prog.expr);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The two evaluators (the heart of the probe)
// ─────────────────────────────────────────────────────────────────────────────

// Scalar: one output index k at a time. The ground-truth denotation.
function evalScalar(n, ins, k, w) {
  switch (n.op) {
    case "lit": return rnd(n.v, w);
    case "scalar": return ins.scalars[n.name];
    case "load": return ins.arrays[n.arr][n.stride * k + n.intercept];
    case "neg": return opNeg(evalScalar(n.a, ins, k, w), w);
    case "abs": return opAbs(evalScalar(n.a, ins, k, w), w);
    case "sqrt": return opSqrt(evalScalar(n.a, ins, k, w), w);
    case "floor": return Math.floor(evalScalar(n.a, ins, k, w));
    case "ceil": return Math.ceil(evalScalar(n.a, ins, k, w));
    case "trunc": return Math.trunc(evalScalar(n.a, ins, k, w));
    case "fround": return fr(evalScalar(n.a, ins, k, w));
    case "add": return opAdd(evalScalar(n.a, ins, k, w), evalScalar(n.b, ins, k, w), w);
    case "sub": return opSub(evalScalar(n.a, ins, k, w), evalScalar(n.b, ins, k, w), w);
    case "mul": return opMul(evalScalar(n.a, ins, k, w), evalScalar(n.b, ins, k, w), w);
    case "div": return opDiv(evalScalar(n.a, ins, k, w), evalScalar(n.b, ins, k, w), w);
    case "min": return opMin(evalScalar(n.a, ins, k, w), evalScalar(n.b, ins, k, w), w);
    case "max": return opMax(evalScalar(n.a, ins, k, w), evalScalar(n.b, ins, k, w), w);
    default: throw new Error("evalScalar: unhandled " + n.op);
  }
}

// Vector: evaluate over a set of `lanes` (output indices) at once — gather →
// lane-wise op → (caller) scatter. A SEPARATE traversal from evalScalar. `bug`
// optionally injects an unsound transform (SCENARIO D / FMA).
function evalVector(n, ins, lanes, w, bug) {
  const L = lanes.length;
  switch (n.op) {
    case "lit": { const c = rnd(n.v, w); return lanes.map(() => c); }
    case "scalar": { const c = ins.scalars[n.name]; return lanes.map(() => c); } // splat
    case "load": {
      let inter = n.intercept;
      if (bug === "shuffle" && n.stride === 2) inter = n.intercept ^ 1; // skip/scramble deinterleave
      const arr = ins.arrays[n.arr];
      return lanes.map((k) => arr[n.stride * k + inter]);
    }
    case "neg": return evalVector(n.a, ins, lanes, w, bug).map((x) => opNeg(x, w));
    case "abs": return evalVector(n.a, ins, lanes, w, bug).map((x) => opAbs(x, w));
    case "sqrt": return evalVector(n.a, ins, lanes, w, bug).map((x) => opSqrt(x, w));
    case "floor": return evalVector(n.a, ins, lanes, w, bug).map((x) => Math.floor(x));
    case "ceil": return evalVector(n.a, ins, lanes, w, bug).map((x) => Math.ceil(x));
    case "trunc": return evalVector(n.a, ins, lanes, w, bug).map((x) => Math.trunc(x));
    case "fround": return evalVector(n.a, ins, lanes, w, bug).map((x) => fr(x));
    case "add": {
      // FMA bug: fuse add(mul(p,q), c) — round ONCE instead of twice (f64 only).
      if (bug === "fma" && w === "f64") {
        if (n.a.op === "mul") return fuseFma(n.a, n.b, ins, lanes, w);
        if (n.b.op === "mul") return fuseFma(n.b, n.a, ins, lanes, w);
      }
      return zip(evalVector(n.a, ins, lanes, w, bug), evalVector(n.b, ins, lanes, w, bug), (x, y) => opAdd(x, y, w));
    }
    case "sub": return zip(evalVector(n.a, ins, lanes, w, bug), evalVector(n.b, ins, lanes, w, bug), (x, y) => opSub(x, y, w));
    case "mul": return zip(evalVector(n.a, ins, lanes, w, bug), evalVector(n.b, ins, lanes, w, bug), (x, y) => opMul(x, y, w));
    case "div": return zip(evalVector(n.a, ins, lanes, w, bug), evalVector(n.b, ins, lanes, w, bug), (x, y) => opDiv(x, y, w));
    case "min": return zip(evalVector(n.a, ins, lanes, w, bug), evalVector(n.b, ins, lanes, w, bug), (x, y) => opMin(x, y, w));
    case "max": return zip(evalVector(n.a, ins, lanes, w, bug), evalVector(n.b, ins, lanes, w, bug), (x, y) => opMax(x, y, w));
    default: throw new Error("evalVector: unhandled " + n.op);
  }
}
function zip(a, c, f) { return a.map((x, i) => f(x, c[i])); }

// Correctly-rounded(-ish) double-double FMA so the "fused" path rounds once.
const SPLIT = 134217729; // 2^27 + 1
function twoProduct(a, c) {
  const p = a * c;
  const ca = SPLIT * a, ah = ca - (ca - a), al = a - ah;
  const cb = SPLIT * c, bh = cb - (cb - c), bl = c - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  return [p, e];
}
function twoSum(a, c) { const s = a + c; const bb = s - a; const e = (a - (s - bb)) + (c - bb); return [s, e]; }
function fmaOnce(a, c, d) { const [p, e] = twoProduct(a, c); const [s, t] = twoSum(d, p); return s + (t + e); }
function fuseFma(mulNode, addend, ins, lanes, w) {
  const p = evalVector(mulNode.a, ins, lanes, w);
  const q = evalVector(mulNode.b, ins, lanes, w);
  const c = evalVector(addend, ins, lanes, w);
  return lanes.map((_, i) => fmaOnce(p[i], q[i], c[i]));
}

// Whole-kernel runners.
function runScalar(prog, ins, n, w) {
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = evalScalar(prog.expr, ins, k, w);
  return out;
}
function runSimdModel(prog, ins, n, w, bug) {
  const W = W_OF[w];
  const out = new Array(n);
  let k = 0;
  for (; k + W <= n; k += W) {            // SIMD body: full W-lane chunks
    const lanes = []; for (let j = 0; j < W; j++) lanes.push(k + j);
    const res = evalVector(prog.expr, ins, lanes, w, bug);
    for (let j = 0; j < W; j++) out[k + j] = res[j];
  }
  for (; k < n; k++) out[k] = evalScalar(prog.expr, ins, k, w); // scalar epilogue (tail)
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Corpus — inputs for a program at a given n + fill seed
// ─────────────────────────────────────────────────────────────────────────────

function fillEdges(len, offset) {
  const a = new Float64Array(len);
  for (let i = 0; i < len; i++) a[i] = EDGE[(i + offset) % EDGE.length];
  return a;
}
function fillRandom(len, rng) {
  const a = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const r = rng();
    a[i] = r < 0.1 ? EDGE[(rng() * EDGE.length) | 0]       // sprinkle edges
      : (rng() - 0.5) * Math.pow(2, ((rng() * 80) | 0) - 40); // wide dynamic range
  }
  return a;
}
// Arrays needed by a program (stride-aware length), filled per `mode`.
function makeInputs(prog, n, mode, rng) {
  const arrays = {};
  for (const name of prog.inputs) {
    const stride = prog.strideOf ? prog.strideOf[name] || 1 : 1;
    const len = stride * Math.max(n, 1);
    arrays[name] = mode === "edges" ? fillEdges(len, name.charCodeAt(0)) : fillRandom(len, rng);
  }
  const scalars = {};
  for (const name of prog.scalars || []) {
    scalars[name] = mode === "edges" ? EDGE[name.charCodeAt(0) % EDGE.length] : (rng() - 0.5) * 16;
  }
  return { arrays, scalars };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Program enumeration — exhaustive over depth ≤ 1 + curated realistic kernels
// ─────────────────────────────────────────────────────────────────────────────

function enumPrograms(w) {
  const leaves = [load("x", 1, 0, w), load("y", 1, 0, w), scalar("g", w), lit(0.5, w), lit(2, w)];
  const set = new Map();
  const add = (expr) => {
    const k = key(expr);
    if (!set.has(k)) set.set(k, { expr, inputs: collectArrays(expr), scalars: collectScalars(expr), w });
  };
  for (const l of leaves) add(l);
  for (const a of leaves) for (const op of ["neg", "abs", "sqrt"]) add(u(op, a));
  for (const a of leaves) for (const c of leaves) for (const op of ["add", "sub", "mul", "div", "min", "max"]) add(b(op, a, c));
  // Curated realistic deeper kernels (the shapes the JIT actually serves):
  const X = load("x", 1, 0, w), Y = load("y", 1, 0, w), G = scalar("g", w);
  add(b("add", X, b("mul", G, Y)));                                    // Taylor o2:  x + g*y
  add(b("add", b("mul", b("sub", lit(1, w), G), X), b("mul", G, Y)));  // lerp: (1-g)x + g*y
  add(b("max", b("min", X, lit(1, w)), lit(-1, w)));                   // hard-clip [-1,1]
  add(b("mul", G, b("add", X, b("mul", X, b("mul", X, lit(0.16666667, w)))))); // g*(x + x*x*(x/6))
  add(b("sub", b("mul", X, X), b("mul", Y, Y)));                       // x^2 - y^2
  for (const p of set.values()) { p.inputs = collectArrays(p.expr); p.scalars = collectScalars(p.expr); }
  return [...set.values()];
}
function collectArrays(n, acc = new Set()) {
  if (n.op === "load") acc.add(n.arr);
  if (n.a) collectArrays(n.a, acc);
  if (n.b) collectArrays(n.b, acc);
  return [...acc];
}
function collectScalars(n, acc = new Set()) {
  if (n.op === "scalar") acc.add(n.name);
  if (n.a) collectScalars(n.a, acc);
  if (n.b) collectScalars(n.b, acc);
  return [...acc];
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Differential + metamorphic comparison over the corpus
// ─────────────────────────────────────────────────────────────────────────────

const N_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16]; // covers every residue mod 4 and mod 2
const FILLS = 3;

// Returns { checks, worstUlp, mismatch:null | {n,k,mode} }.
function diffProgram(prog, w) {
  let checks = 0, worstUlp = 0;
  const rng = makeRng(0xC0FFEE ^ key(prog.expr).length);
  for (const n of N_VALUES) {
    for (let f = 0; f < FILLS + 1; f++) {
      const mode = f === 0 ? "edges" : "random";
      const ins = makeInputs(prog, n, mode, rng);
      const sc = runScalar(prog, ins, n, w);
      const si = runSimdModel(prog, ins, n, w);
      for (let k = 0; k < n; k++) {
        checks++;
        if (!bitEqual(sc[k], si[k], w)) return { checks, worstUlp, mismatch: { n, k, mode, sc: sc[k], si: si[k] } };
        if (w === "f32") worstUlp = Math.max(worstUlp, ulpDistF32(sc[k], si[k]));
      }
    }
  }
  return { checks, worstUlp, mismatch: null };
}

// Four metamorphic relations (no oracle needed — properties of the lowering).
function metamorphic(prog, w) {
  const rng = makeRng(0x5EED ^ key(prog.expr).length);
  const n = 8;
  // (1) commutativity of a root + / * under the lowering
  if ((prog.expr.op === "add" || prog.expr.op === "mul")) {
    const swapped = { expr: b(prog.expr.op, prog.expr.b, prog.expr.a), inputs: prog.inputs, scalars: prog.scalars, w };
    const ins = makeInputs(prog, n, "random", rng);
    const a = runSimdModel(prog, ins, n, w), c = runSimdModel(swapped, ins, n, w);
    for (let k = 0; k < n; k++) if (!bitEqual(a[k], c[k], w)) return { rel: "commutativity", k };
  }
  // (2) splat invariance: a constant-only subtree is identical in every lane
  {
    const constProg = { expr: b("add", lit(0.5, w), scalar("g", w)), inputs: [], scalars: ["g"], w };
    const ins = makeInputs(constProg, W_OF[w], "random", rng);
    const r = runSimdModel(constProg, ins, W_OF[w], w);
    for (let k = 1; k < r.length; k++) if (!bitEqual(r[0], r[k], w)) return { rel: "splat-invariance", k };
  }
  // (3) n-vs-padded-then-truncated: tail handling matches the body
  {
    const ins = makeInputs(prog, 8, "random", rng); // arrays long enough for n=7 and n=8
    const r7 = runSimdModel(prog, ins, 7, w);
    const r8 = runSimdModel(prog, ins, 8, w);
    for (let k = 0; k < 7; k++) if (!bitEqual(r7[k], r8[k], w)) return { rel: "n-vs-padded", k };
  }
  // (4) lane-permutation independence: permuting input rows permutes outputs identically
  {
    const ins = makeInputs(prog, n, "random", rng);
    const perm = [7, 6, 5, 4, 3, 2, 1, 0];
    const permIns = { arrays: {}, scalars: ins.scalars };
    for (const name of prog.inputs) {
      const src = ins.arrays[name], dst = new Float64Array(src.length);
      for (let k = 0; k < n; k++) dst[k] = src[perm[k]]; // stride-1 programs only in enum
      permIns.arrays[name] = dst;
    }
    const base = runSimdModel(prog, ins, n, w);
    const permd = runSimdModel(prog, permIns, n, w);
    for (let k = 0; k < n; k++) if (!bitEqual(base[perm[k]], permd[k], w)) return { rel: "lane-permutation", k };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Scenarios
// ─────────────────────────────────────────────────────────────────────────────

let allGreen = true;
function band(s) { console.log("\n" + "─".repeat(78) + "\n" + s + "\n" + "─".repeat(78)); }
function pass(s) { console.log("  ✓ " + s); }
function fail(s) { allGreen = false; console.log("  ✗ FAIL — " + s); }

function scenarioA() {
  band("SCENARIO A — SOUND lowering ≡ scalar over the enumerated program×input space");
  let progs = 0, totalChecks = 0, worstUlp = 0, accepted = 0;
  for (const w of ["f64", "f32"]) {
    const list = enumPrograms(w);
    for (const prog of list) {
      progs++;
      if (validate(prog) !== null) { fail(`enumerated program rejected by validate(): ${key(prog.expr)}`); continue; }
      accepted++;
      const d = diffProgram(prog, w);
      totalChecks += d.checks; worstUlp = Math.max(worstUlp, d.worstUlp);
      if (d.mismatch) { fail(`${w} ${key(prog.expr)} diverged at n=${d.mismatch.n} k=${d.mismatch.k} (${d.mismatch.mode}): scalar=${d.mismatch.sc} simd=${d.mismatch.si}`); return; }
      const m = metamorphic(prog, w);
      if (m) { fail(`${w} ${key(prog.expr)} broke metamorphic relation ${m.rel} at k=${m.k}`); return; }
    }
  }
  pass(`${progs} programs (f64+f32), all validate→ACCEPT (${accepted}), ${totalChecks} index comparisons bit-exact`);
  pass(`max observed f32 ULP distance = ${worstUlp} (bit-exact; production gate budget is a margin above this)`);
  pass(`metamorphic relations (commutativity, splat-invariance, n-vs-padded, lane-permutation) hold`);
}

function scenarioB() {
  band("SCENARIO B — FMA / reassociation candidate DIVERGES (FINDING 1)");
  const w = "f64";
  // out[i] = x[i]*y[i] + z[i]
  const prog = { expr: b("add", b("mul", load("x", 1, 0, w), load("y", 1, 0, w)), load("z", 1, 0, w)), inputs: ["x", "y", "z"], scalars: [], w };
  // Crafted witness: a=b=1+EPS, c=-(a*b). scalar two-round → 0; fused one-round → 2^-104.
  // Use n=W (=2) lanes so the SIMD body (where the FMA bug lives) actually runs —
  // n<W would fall entirely into the scalar epilogue and never exercise the fuse.
  const a = 1 + Number.EPSILON;
  const prod = a * a;
  const ins = { arrays: { x: Float64Array.of(a, a), y: Float64Array.of(a, a), z: Float64Array.of(-prod, -prod) }, scalars: {} };
  const sc = runScalar(prog, ins, 2, w)[0];
  const sound = runSimdModel(prog, ins, 2, w)[0];
  const fused = runSimdModel(prog, ins, 2, w, "fma")[0];
  if (!bitEqual(sc, sound, w)) { fail("sound model disagreed with scalar on the witness (probe bug)"); return; }
  pass(`sound lowering AGREES with scalar on the witness: ${sc}`);
  if (bitEqual(sc, fused, w)) { fail("FMA candidate did NOT diverge — finding not reproduced"); return; }
  pass(`FMA candidate DIVERGES: scalar(two-round)=${sc}  fused(one-round)=${fused}  (Δ=${fused - sc})`);
  // Corpus scan: how widely does the FMA candidate diverge?
  let scanned = 0, diverged = 0;
  const rng = makeRng(0xFEED);
  for (let t = 0; t < 4000; t++) {
    const n = 4;
    const p2 = { ...prog };
    const inputs = { arrays: { x: fillRandom(n, rng), y: fillRandom(n, rng), z: fillRandom(n, rng) }, scalars: {} };
    const s = runScalar(p2, inputs, n, w), fv = runSimdModel(p2, inputs, n, w, "fma");
    for (let k = 0; k < n; k++) { scanned++; if (!bitEqual(s[k], fv[k], w)) diverged++; }
  }
  pass(`corpus scan: FMA candidate diverged on ${diverged}/${scanned} random f64 samples (the gate rejects ALL of them)`);
  pass("FINDING 1 confirmed — never emit f64x2.relaxed_madd; never reassociate (the load-bearing invariant)");
}

function scenarioC() {
  band("SCENARIO C — every OUT-OF-SUBSET program is REJECTED with its diagnostic");
  const w = "f64";
  const X = load("x", 1, 0, w), Y = load("y", 1, 0, w);
  const cases = [
    ["E_BRANCH", { expr: { op: "ternary", a: X, b: Y }, w }],
    ["E_LOOP_CARRY", { expr: b("add", X, { op: "loadPrev", a: X }), w }],
    ["E_OP", { expr: { op: "mod", a: X, b: Y }, w }],
    ["E_OP", { expr: { op: "bitand", a: X, b: Y }, w }],
    ["E_TRANSCENDENTAL", { expr: { op: "sin", a: X }, w }],
    ["E_TRANSCENDENTAL", { expr: { op: "exp", a: X }, w }],
    ["E_STRIDE", { expr: load("x", 3, 0, w), w }],
    ["E_STRIDE", { expr: load("x", 1, -1, w), w }],
    ["E_MIXED_WIDTH", { expr: b("add", load("x", 1, 0, "f32"), load("y", 1, 0, "f64")), w: "f64" }],
    ["E_NONFINITE_LITERAL", { expr: b("add", X, lit(Infinity, w)), w }],
    ["E_CONTROL", { illegal: "control", w }],
    ["E_DYNAMIC", { illegal: "dynamic", w }],
    ["E_REASSIGN", { illegal: "reassign", w }],
    ["E_CALL", { illegal: "call", w }],
    ["E_USE_BEFORE_DEF", { illegal: "useBeforeDef", w }],
    ["E_SHAPE", { illegal: "shape", w }],
  ];
  const seen = new Set();
  for (const [expected, prog] of cases) {
    const got = validate(prog);
    seen.add(expected);
    if (got !== expected) { fail(`expected ${expected}, validate() returned ${got} for ${prog.illegal || key(prog.expr)}`); }
    else pass(`${expected.padEnd(20)} ⇐ ${prog.illegal ? "<" + prog.illegal + ">" : key(prog.expr)}`);
  }
  // Guard: an IN-subset program must NOT be rejected (no false positives).
  const ok = { expr: b("add", X, b("mul", scalar("g", w), Y)), w };
  if (validate(ok) !== null) fail("in-subset program wrongly rejected: " + key(ok.expr));
  else pass("in-subset control (x + g*y) ⇒ ACCEPT (no false rejection)");
  pass(`${seen.size} distinct diagnostics exercised`);
}

function scenarioD() {
  band("SCENARIO D — every deliberately-WRONG candidate is CAUGHT by the differential check");
  const w = "f64";
  const X = load("x", 1, 0, w), Y = load("y", 1, 0, w);
  // (i) negate-all bug on a generic program
  const p1 = { expr: b("add", X, Y), inputs: ["x", "y"], scalars: [], w };
  if (caughtBug(p1, w, "negate")) pass("negate-all candidate caught (differs on ≥1 input)");
  else fail("negate-all candidate NOT caught — gate comparison is not load-bearing");
  // (ii) drop-right-of-root-add bug
  if (caughtBug(p1, w, "dropRight")) pass("drop-addend candidate caught");
  else fail("drop-addend candidate NOT caught");
  // (iii) wrong-shuffle bug on a stride-2 (AoS) program: out[i] = s[2i] - s[2i+1].
  // Asymmetric on purpose — a symmetric kernel (s[2i]+s[2i+1]) would be invariant
  // under swapping the two deinterleaved lanes and would NOT expose the bug.
  const p2 = { expr: b("sub", load("s", 2, 0, w), load("s", 2, 1, w)), inputs: ["s"], scalars: [], w, strideOf: { s: 2 } };
  if (validate(p2) !== null) { fail("stride-2 control program wrongly rejected"); }
  if (caughtBug(p2, w, "shuffle")) pass("wrong-deinterleave (shuffle) candidate caught (FINDING 2)");
  else fail("wrong-shuffle candidate NOT caught — deinterleave permutation not validated");
}

// Run sound vs a bugged candidate over the corpus; return true if ANY input
// produces a bit-mismatch (i.e. the differential gate would REJECT the candidate).
function caughtBug(prog, w, bug) {
  const rng = makeRng(0xBADF00D ^ bug.length);
  for (const n of [2, 4, 5, 8]) {
    for (let f = 0; f < 4; f++) {
      const ins = makeInputs(prog, n, f === 0 ? "edges" : "random", rng);
      const sound = runScalar(prog, ins, n, w);
      const cand = bug === "negate"
        ? runScalar(prog, ins, n, w).map((v) => -v)
        : bug === "dropRight"
          ? runScalarDropRight(prog, ins, n, w)
          : runSimdModel(prog, ins, n, w, "shuffle");
      for (let k = 0; k < n; k++) if (!bitEqual(sound[k], cand[k], w)) return true;
    }
  }
  return false;
}
function runScalarDropRight(prog, ins, n, w) {
  const dropped = prog.expr.op === "add" ? prog.expr.a : prog.expr; // ignore the +right addend
  const p = { ...prog, expr: dropped };
  return runScalar(p, ins, n, w);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Main
// ─────────────────────────────────────────────────────────────────────────────

console.log("JIT vectorizer Stage-0 probe — Apollo Frontier 5 (0.9.912)");
scenarioA();
scenarioB();
scenarioC();
scenarioD();
band(allGreen ? "RESULT: ALL GREEN ✓  (sound lowering proven equivalent; findings + guards confirmed)"
              : "RESULT: FAILURES ✗  (see above)");
process.exit(allGreen ? 0 : 1);
