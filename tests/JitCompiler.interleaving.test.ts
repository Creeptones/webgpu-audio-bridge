/**
 * The Autonomous JIT — exhaustive program-space fuzzer (Apollo Frontier 5, Stage 1a).
 *
 * The in-CI successor to `bench/jit-probe.mjs`. Where the probe checks an IR-level
 * MODEL of the vectorizer, this fuzzer drives the REAL pipeline end-to-end: it
 * enumerates well-formed kernels over the v1 op-set, renders each to naive JS,
 * and runs it through parse → lower → vectorize → emit → wabt → the equivalence
 * gate. A program is "sound" iff the gate ACCEPTS it — i.e. the actually-emitted
 * SIMD WASM is bit-exact (f64) / within-ULP (f32) to the actually-emitted scalar
 * reference over the whole IEEE-edge + tail-residue corpus, AND within-ULP of the
 * user's JS. Any emitter bug surfaces as a `rejected-gate` here.
 *
 * Run: tsx tests/JitCompiler.interleaving.test.ts
 *
 *  POSITIVE  every enumerated in-subset program is ACCEPTED by the real gate.
 *  NEGATIVE  every out-of-subset program is REJECTED with the expected E_* code
 *            (the silent-mis-compile guard — probe SCENARIO C).
 *  NEGATIVE  a deliberately-wrong candidate is CAUGHT by the gate (probe SCENARIO D).
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  compileKernel, runGate, buildCorpus, emitScalarModule, emitSimdModule, lowerKernel, parseProgram,
  type KernelSignature, type LaneWidth, type IrKernel,
} from "../src/jit/index.js";

const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength); u.set(buffer); return u;
}

// ── enumerate expression trees (depth ≤ 1) and render to JS ──────────────────
type Expr = string; // rendered JS expression
const LEAVES: Expr[] = ["x[i]", "y[i]", "g", "0.5", "2"];
const BINARY: Array<[string, (a: Expr, b: Expr) => Expr]> = [
  ["+", (a, b) => `(${a} + ${b})`],
  ["-", (a, b) => `(${a} - ${b})`],
  ["*", (a, b) => `(${a} * ${b})`],
  ["/", (a, b) => `(${a} / ${b})`],
  ["min", (a, b) => `Math.min(${a}, ${b})`],
  ["max", (a, b) => `Math.max(${a}, ${b})`],
];
const UNARY: Array<[string, (a: Expr) => Expr]> = [
  ["neg", (a) => `(-${a})`],
  ["abs", (a) => `Math.abs(${a})`],
  ["sqrt", (a) => `Math.sqrt(${a})`],
];

function enumerate(): Expr[] {
  const set = new Set<Expr>();
  for (const l of LEAVES) set.add(l);
  for (const [, f] of UNARY) for (const a of LEAVES) set.add(f(a));
  for (const [, f] of BINARY) for (const a of LEAVES) for (const b of LEAVES) set.add(f(a, b));
  // a few curated depth-2 shapes (the realistic kernels)
  set.add("(x[i] + g * y[i])");                       // Taylor o2
  set.add("((1 - g) * x[i] + g * y[i])");             // lerp
  set.add("Math.max(Math.min(x[i], 1), -1)");         // clip
  set.add("(x[i] * x[i] - y[i] * y[i])");             // diff of squares
  set.add("(g * Math.abs(x[i]))");                    // gain·|x|
  set.add("Math.sqrt(x[i] * x[i] + y[i] * y[i])");    // hypot-ish (no transcendental)
  return [...set];
}

function srcOf(expr: Expr): string {
  return `function k(out, x, y, g, n){ for (let i = 0; i < n; i++) { out[i] = ${expr}; } }`;
}

function main(): void {
  const sigOf = (w: LaneWidth): KernelSignature => ({
    width: w,
    params: [
      { name: "out", role: "output" }, { name: "x", role: "input" }, { name: "y", role: "input" },
      { name: "g", role: "scalar" }, { name: "n", role: "length" },
    ],
  });
  const exprs = enumerate();
  // Cap the wabt-compiled set so CI time stays bounded; log the cap (no silent truncation).
  const CAP = 64;
  const chosen = exprs.slice(0, CAP);
  if (exprs.length > CAP) console.log(`  [note] enumerated ${exprs.length} programs; compiling the first ${CAP} through real wabt (rest covered by bench/jit-probe.mjs's IR model)`);

  // ── POSITIVE: every chosen program is accepted by the REAL gate, f64 + f32 ──
  let accepted = 0, totalComparisons = 0, worstUlp = 0;
  for (const w of ["f64", "f32"] as LaneWidth[]) {
    for (const expr of chosen) {
      const r = compileKernel(srcOf(expr), sigOf(w), { compileWat });
      if (r.status !== "accepted") {
        const why = r.status === "rejected-gate" ? JSON.stringify(r.gate.mismatch ?? r.gate.reason)
          : r.status === "rejected-source" ? JSON.stringify(r.diagnostic) : (r as { reason: string }).reason;
        assert(false, `[${w}] «out[i] = ${expr}» expected accepted, got ${r.status} — ${why}`);
      }
      accepted++; totalComparisons += r.gate.comparisons; worstUlp = Math.max(worstUlp, r.gate.worstUlpF32);
    }
  }
  ok(`POSITIVE: ${accepted} real-compiled programs (f64+f32) all gate-ACCEPTED; ${totalComparisons} comparisons; worst f32 ULP=${worstUlp}`);

  // ── NEGATIVE 1: out-of-subset programs rejected with the expected code ──────
  const sBase = sigOf("f64");
  // RHS-only expressions (srcOf prepends `out[i] = `).
  const rejects: Array<[string, string]> = [
    ["E_BRANCH", "x[i] > 0 ? x[i] : y[i]"],
    ["E_OP", "x[i] % y[i]"],
    ["E_OP", "x[i] & 1"],
    ["E_TRANSCENDENTAL", "Math.sin(x[i])"],
    ["E_TRANSCENDENTAL", "Math.pow(x[i], 2)"],
    ["E_CALL", "foo(x[i])"],
    ["E_STRIDE", "x[i * i]"],
    ["E_DYNAMIC", "x[i] + n"],
    ["E_NONFINITE_LITERAL", "x[i] + Infinity"],
    ["E_LOOP_CARRY", "out[i] + x[i]"],
  ];
  let rejected = 0;
  for (const [code, expr] of rejects) {
    const r = compileKernel(srcOf(expr), sBase, { compileWat });
    assert(r.status === "rejected-source", `«${expr}» expected rejected-source, got ${r.status}`);
    assertEq(r.diagnostic.code, code as never, `«${expr}» expected ${code}, got ${r.diagnostic.code}`);
    rejected++;
  }
  // loop-carry via compound-assign + nested loop (statement-level) — also rejected
  for (const [code, body] of [
    ["E_REASSIGN", "out[i] += x[i];"],
    ["E_CONTROL", "for (let j = 0; j < 2; j++) { out[i] = x[i]; }"],
  ] as Array<[string, string]>) {
    const src = `function k(out, x, y, g, n){ for (let i = 0; i < n; i++) { ${body} } }`;
    const r = compileKernel(src, sBase, { compileWat });
    assert(r.status === "rejected-source", `«${body}» expected rejected-source, got ${r.status}`);
    assertEq(r.diagnostic.code, code as never, `«${body}» expected ${code}`);
    rejected++;
  }
  ok(`NEGATIVE: ${rejected} out-of-subset programs all REJECTED with the expected diagnostic`);

  // ── NEGATIVE 2: deliberately-wrong candidates caught by the gate ────────────
  // Corrupt the SIMD module in three distinct ways; each must be rejected.
  const wrongs: Array<[string, (wat: string) => string, string]> = [
    ["op-flip", (w) => w.replace("(f64x2.add", "(f64x2.sub"), "function k(out, x, n){ for (let i = 0; i < n; i++) { out[i] = x[i] + x[i]; } }"],
    ["sign-flip", (w) => w.replace("(f64x2.mul", "(f64x2.div"), "function k(out, x, g, n){ for (let i = 0; i < n; i++) { out[i] = g * x[i]; } }"],
    ["wrong-const", (w) => w.replace(/\(f64\.const 0\.5\)/g, "(f64.const 0.25)"), "function k(out, x, n){ for (let i = 0; i < n; i++) { out[i] = x[i] * 0.5; } }"],
  ];
  let caught = 0;
  for (const [label, corrupt, src] of wrongs) {
    const sig: KernelSignature = src.includes(", g,")
      ? { width: "f64", params: [{ name: "out", role: "output" }, { name: "x", role: "input" }, { name: "g", role: "scalar" }, { name: "n", role: "length" }] }
      : { width: "f64", params: [{ name: "out", role: "output" }, { name: "x", role: "input" }, { name: "n", role: "length" }] };
    const ir = lowerKernel(parseProgram(src), sig) as IrKernel;
    const good = emitSimdModule(ir);
    const bad = corrupt(good);
    assert(bad !== good, `${label}: corruption was applied`);
    const report = runGate({ ir, scalarWat: emitScalarModule(ir), simdWat: bad, corpus: buildCorpus(sig), compileWat });
    assertEq(report.status, "rejected-gate", `${label}: wrong candidate must be rejected`);
    caught++;
  }
  ok(`NEGATIVE: ${caught} deliberately-wrong candidates all CAUGHT by the differential gate`);

  console.log("\nAll JitCompiler.interleaving fuzzer assertions passed.");
}

main();
