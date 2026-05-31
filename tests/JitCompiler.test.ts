/**
 * The Autonomous JIT — single-thread API pins (Apollo Frontier 5, Stage 1a).
 *
 * Numbered pins exercising the full pipeline through REAL wabt compilation +
 * execution: parse → lower/validate → vectorize → emit → equivalence gate →
 * accepted WASM. Mirrors the wasmEquivalence convention (bit-exact f64 /
 * within-ULP f32) and the ring frontiers' numbered-pin style.
 *
 * Run: tsx tests/JitCompiler.test.ts
 *
 * Pins
 *  1  identity out[i]=x[i] (f32) accepts; the returned SIMD wasm reproduces input
 *  2  Taylor o2 out[i]=x[i]+dt*v[i] (f64) accepts, bit-exact vs scalar + JS
 *  3  f32 Taylor o2 accepts, within-ULP (worst ULP reported, expect 0)
 *  4  curated kernel library (lerp / hard-clip / poly / x^2-y^2) all accept
 *  5  every loop-tail residue n%W is gated (the corpus sweeps them)
 *  6  rejection pins — one per E_* diagnostic, exact code
 *  7  the gate REJECTS a deliberately-wrong candidate (negate-all simdWat)
 *  8  determinism — same source ⇒ byte-identical scalar+simd WAT ⇒ same verdict
 *  9  stride-2 (valid language, not v1-emittable) ⇒ unsupported (JS fallback)
 * 10  import-graph guard — the core (src/index.ts) never imports `acorn`
 */

import { assert, assertEq, ok } from "./_assert.js";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import wabtInit from "wabt";
import {
  compileKernel, emitSimdModule, lowerKernel, parseProgram,
  type KernelSignature, type CompileResult, type LaneWidth, type IrKernel,
} from "../src/jit/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ── wabt-backed compileWat (the injected WAT→bytes compiler) ─────────────────
const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength);
  u.set(buffer);
  return u;
}

// ── signature helpers ────────────────────────────────────────────────────────
function sig(width: LaneWidth, ...spec: Array<[string, "input" | "output" | "scalar" | "length"]>): KernelSignature {
  return { width, params: spec.map(([name, role]) => ({ name, role })) };
}

function expectAccepted(r: CompileResult, label: string): Extract<CompileResult, { status: "accepted" }> {
  if (r.status !== "accepted") {
    const detail = r.status === "rejected-source" ? JSON.stringify(r.diagnostic)
      : r.status === "rejected-gate" ? JSON.stringify(r.gate.mismatch ?? r.gate.reason)
        : JSON.stringify((r as { reason?: string }).reason);
    assert(false, `${label}: expected accepted, got ${r.status} — ${detail}`);
  }
  return r as Extract<CompileResult, { status: "accepted" }>;
}

// Instantiate an accepted SIMD module and run it over a small input, returning
// the output — an INDEPENDENT execution of the deliverable (the gate already
// proved equivalence; this confirms the returned bytes run).
function runModule(wasm: Uint8Array, width: LaneWidth, n: number, inputs: number[][], scalars: number[]): number[] {
  const TA = width === "f32" ? Float32Array : Float64Array;
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 16384, shared: true });
  const buf = new Uint8Array(wasm.byteLength); buf.set(wasm);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(buf), { env: { memory } });
  const kernel = inst.exports["kernel"] as (...a: number[]) => void;
  const slot = 1024;
  // layout: out at 16, inputs at 16+slot, 16+2*slot, …
  const outOff = 16;
  const inOffs = inputs.map((_, k) => 16 + (k + 1) * slot);
  inputs.forEach((row, k) => { const v = new TA(memory.buffer, inOffs[k]!, n); row.forEach((x, i) => (v[i] = x)); });
  const args = [n, outOff, ...inOffs, ...scalars.map((s) => (width === "f32" ? Math.fround(s) : s))];
  kernel(...args);
  return Array.from(new TA(memory.buffer, outOff, n));
}

async function main(): Promise<void> {
  // ── Pin 1: identity (f32) ─────────────────────────────────────────────────
  {
    const s = sig("f32", ["out", "output"], ["x", "input"], ["n", "length"]);
    const r = compileKernel("function k(out, x, n){ for (let i = 0; i < n; i++) { out[i] = x[i]; } }", s, { compileWat });
    const acc = expectAccepted(r, "identity");
    const out = runModule(acc.wasm, "f32", 6, [[1, 2, 3, 4, 5, 6]], []);
    assertEq(out.join(","), "1,2,3,4,5,6", "identity output matches input");
    ok(`1 identity f32 accepts (${acc.gate.comparisons} comparisons) + reruns`);
  }

  // ── Pin 2: Taylor order-2 (f64) — out[i] = x[i] + dt*v[i] ──────────────────
  {
    const s = sig("f64", ["out", "output"], ["x", "input"], ["v", "input"], ["dt", "scalar"], ["n", "length"]);
    const src = "function k(out, x, v, dt, n){ for (let i = 0; i < n; i++) { out[i] = x[i] + dt * v[i]; } }";
    const r = compileKernel(src, s, { compileWat });
    const acc = expectAccepted(r, "taylor-f64");
    assertEq(acc.gate.status, "accepted", "taylor gate accepted");
    // independent run: x=[1,1,1], v=[2,4,6], dt=0.5 → [2,3,4]
    const out = runModule(acc.wasm, "f64", 3, [[1, 1, 1], [2, 4, 6]], [0.5]);
    assertEq(out.join(","), "2,3,4", "taylor f64 output matches hand calc");
    ok(`2 Taylor o2 f64 accepts bit-exact (${acc.gate.comparisons} comparisons)`);
  }

  // ── Pin 3: Taylor order-2 (f32) within-ULP ────────────────────────────────
  {
    const s = sig("f32", ["out", "output"], ["x", "input"], ["v", "input"], ["dt", "scalar"], ["n", "length"]);
    const src = "function k(out, x, v, dt, n){ for (let i = 0; i < n; i++) { out[i] = x[i] + dt * v[i]; } }";
    const acc = expectAccepted(compileKernel(src, s, { compileWat }), "taylor-f32");
    assertEq(acc.gate.worstUlpF32, 0, "f32 Taylor SIMD≡scalar bit-exact (worst ULP 0)");
    ok(`3 Taylor o2 f32 accepts, worst ULP = ${acc.gate.worstUlpF32}`);
  }

  // ── Pin 4: curated kernel library ─────────────────────────────────────────
  {
    const lib: Array<[string, KernelSignature, string]> = [
      ["lerp", sig("f64", ["out", "output"], ["x", "input"], ["y", "input"], ["g", "scalar"], ["n", "length"]),
        "function k(out, x, y, g, n){ for (let i = 0; i < n; i++) { out[i] = (1 - g) * x[i] + g * y[i]; } }"],
      ["hard-clip", sig("f32", ["out", "output"], ["x", "input"], ["n", "length"]),
        "function k(out, x, n){ for (let i = 0; i < n; i++) { out[i] = Math.max(Math.min(x[i], 1), -1); } }"],
      ["poly", sig("f64", ["out", "output"], ["x", "input"], ["g", "scalar"], ["n", "length"]),
        "function k(out, x, g, n){ for (let i = 0; i < n; i++) { let t = x[i]; out[i] = g * (t + t * t * (t / 6)); } }"],
      ["diffsq", sig("f32", ["out", "output"], ["x", "input"], ["y", "input"], ["n", "length"]),
        "function k(out, x, y, n){ for (let i = 0; i < n; i++) { out[i] = x[i] * x[i] - y[i] * y[i]; } }"],
      ["gain-abs", sig("f64", ["out", "output"], ["x", "input"], ["g", "scalar"], ["n", "length"]),
        "function k(out, x, g, n){ for (let i = 0; i < n; i++) { out[i] = g * Math.abs(x[i]); } }"],
    ];
    for (const [name, s, src] of lib) {
      const acc = expectAccepted(compileKernel(src, s, { compileWat }), name);
      assert(acc.gate.comparisons > 0, `${name} gate ran comparisons`);
    }
    ok(`4 curated kernel library (${lib.length}: lerp/hard-clip/poly/diffsq/gain-abs) all accept`);
  }

  // ── Pin 5: tail residues — the corpus sweeps every n%W; accept implies all OK
  {
    const s = sig("f32", ["out", "output"], ["x", "input"], ["v", "input"], ["g", "scalar"], ["n", "length"]);
    const acc = expectAccepted(compileKernel(
      "function k(out, x, v, g, n){ for (let i = 0; i < n; i++) { out[i] = x[i] + g * v[i]; } }", s, { compileWat }), "tail");
    // independent run at n=5 (W=4 → 1 simd chunk + 1 scalar tail)
    const out = runModule(acc.wasm, "f32", 5, [[1, 1, 1, 1, 1], [1, 1, 1, 1, 1]], [2]);
    assertEq(out.join(","), "3,3,3,3,3", "f32 W=4 body+tail correct at n=5");
    ok(`5 loop-tail residues gated across the corpus (${acc.gate.casesChecked} cases)`);
  }

  // ── Pin 6: rejection diagnostics (one per E_*) ────────────────────────────
  {
    const sBase = sig("f64", ["out", "output"], ["x", "input"], ["y", "input"], ["n", "length"]);
    const cases: Array<[string, string, KernelSignature]> = [
      ["E_BRANCH", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = x[i] > 0 ? x[i] : y[i]; } }", sBase],
      ["E_BRANCH", "function k(out,x,y,n){ for(let i=0;i<n;i++){ if (i) { out[i] = x[i]; } } }", sBase],
      ["E_LOOP_CARRY", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = out[i] + x[i]; } }", sBase],
      ["E_CONTROL", "function k(out,x,y,n){ for(let i=0;i<n;i++){ for(let j=0;j<2;j++){ out[i]=x[i]; } } }", sBase],
      ["E_CALL", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = foo(x[i]); } }", sBase],
      ["E_TRANSCENDENTAL", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = Math.sin(x[i]); } }", sBase],
      ["E_OP", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = x[i] % y[i]; } }", sBase],
      ["E_OP", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = x[i] & y[i]; } }", sBase],
      ["E_STRIDE", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = x[i*i]; } }", sBase],
      ["E_REASSIGN", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] += x[i]; } }", sBase],
      ["E_NONFINITE_LITERAL", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = x[i] + Infinity; } }", sBase],
      ["E_DYNAMIC", "function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = x[i] + n; } }", sBase],
      ["E_SHAPE", "function k(out,x,y,n){ let z = 0; for(let i=0;i<n;i++){ out[i] = x[i]; } }", sBase],
      ["E_PARSE", "function k(out,x,y,n){ for(let i=0;i<n;i++ { out[i] = x[i]; } }", sBase],
    ];
    const seen = new Set<string>();
    for (const [code, src, s] of cases) {
      const r = compileKernel(src, s, { compileWat });
      assert(r.status === "rejected-source", `${code}: expected rejected-source, got ${r.status}`);
      assertEq(r.diagnostic.code, code as never, `${code}: code mismatch for src «${src.slice(0, 48)}…»`);
      seen.add(code);
    }
    // an in-subset control must NOT be rejected
    const okR = compileKernel("function k(out,x,y,n){ for(let i=0;i<n;i++){ out[i] = x[i] + y[i]; } }", sBase, { compileWat });
    assertEq(okR.status, "accepted", "in-subset control accepts (no false rejection)");
    ok(`6 rejection diagnostics: ${seen.size} distinct E_* codes pinned + no false rejection`);
  }

  // ── Pin 7: the gate rejects a deliberately-wrong candidate ────────────────
  {
    // Build a real IR + scalar/simd, then HAND-CORRUPT the simd module (negate
    // every stored value) and feed both to the gate directly. It MUST reject.
    const s = sig("f64", ["out", "output"], ["x", "input"], ["n", "length"]);
    const src = "function k(out, x, n){ for (let i = 0; i < n; i++) { out[i] = x[i] + x[i]; } }";
    const ir = lowerKernel(parseProgram(src), s) as IrKernel;
    const goodSimd = emitSimdModule(ir);
    const wrongSimd = goodSimd.replace("(f64x2.add", "(f64x2.sub"); // x+x → x-x = 0: wrong
    assert(wrongSimd !== goodSimd, "corruption applied");
    const { runGate } = await import("../src/jit/index.js");
    const { buildCorpus } = await import("../src/jit/index.js");
    const { emitScalarModule } = await import("../src/jit/index.js");
    const corpus = buildCorpus(s);
    const report = runGate({ ir, scalarWat: emitScalarModule(ir), simdWat: wrongSimd, corpus, compileWat });
    assertEq(report.status, "rejected-gate", "wrong candidate (x+x→x-x) rejected by the gate");
    assert(report.mismatch != null, "rejection carries a mismatch witness");
    ok(`7 gate rejects a deliberately-wrong candidate (mismatch at ${report.mismatch!.array}[${report.mismatch!.index}])`);
  }

  // ── Pin 8: determinism ─────────────────────────────────────────────────────
  {
    const s = sig("f64", ["out", "output"], ["x", "input"], ["v", "input"], ["dt", "scalar"], ["n", "length"]);
    const src = "function k(out, x, v, dt, n){ for (let i = 0; i < n; i++) { out[i] = x[i] + dt * v[i]; } }";
    const a = expectAccepted(compileKernel(src, s, { compileWat }), "det-a");
    const b = expectAccepted(compileKernel(src, s, { compileWat }), "det-b");
    assertEq(a.simdWat, b.simdWat, "same source ⇒ identical SIMD WAT");
    assertEq(a.scalarWat, b.scalarWat, "same source ⇒ identical scalar WAT");
    assertEq(Buffer.from(a.wasm).toString("hex"), Buffer.from(b.wasm).toString("hex"), "same source ⇒ identical wasm bytes");
    ok("8 determinism: identical WAT + wasm bytes across two compiles");
  }

  // ── Pin 9: stride-2 is valid language but not v1-emittable ⇒ unsupported ──
  {
    const s = sig("f64", ["out", "output"], ["s", "input"], ["n", "length"]);
    // out[i] = s[2*i] + s[2*i+1] — affine stride-2 loads, allowed by the grammar.
    const r = compileKernel("function k(out, s, n){ for (let i = 0; i < n; i++) { out[i] = s[2*i] + s[2*i+1]; } }", s, { compileWat });
    assertEq(r.status, "unsupported", "stride-2 load ⇒ unsupported (JS fallback), not rejected-source");
    ok(`9 stride-2 lowers but is unsupported by the v1 emitter (reason: ${(r as { reason: string }).reason})`);
  }

  // ── Pin 10: import-graph guard — core never reaches acorn ─────────────────
  {
    const coreReaches = transitiveImports(resolve(repoRoot, "src", "index.ts"));
    const importsAcorn = [...coreReaches].some((f) => fileImports(f, "acorn"));
    assert(!importsAcorn, "src/index.ts transitively imports acorn — the dependency quarantine is broken");
    // sanity: the JIT parser DOES import acorn (the quarantine is real, not vacuous)
    assert(fileImports(resolve(repoRoot, "src", "jit", "parse.ts"), "acorn"), "parse.ts should import acorn");
    ok(`10 import-graph guard: core reaches ${coreReaches.size} files, none import acorn; parse.ts does`);
  }

  console.log("\nAll JitCompiler API pins passed.");
}

// ── a tiny relative-import crawler (mirrors readme-imports.test.ts spirit) ───
function transitiveImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const spec of relativeSpecifiers(text)) {
      const resolved = resolveImport(dirname(file), spec);
      if (resolved) stack.push(resolved);
    }
  }
  return seen;
}
function relativeSpecifiers(text: string): string[] {
  const out: string[] = [];
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!);
  return out;
}
function resolveImport(fromDir: string, spec: string): string | null {
  const base = resolve(fromDir, spec.replace(/\.js$/, ""));
  for (const cand of [base + ".ts", join(base, "index.ts"), base + ".tsx"]) {
    try { readFileSync(cand, "utf8"); return cand; } catch { /* next */ }
  }
  return null;
}
function fileImports(file: string, pkg: string): boolean {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return false; }
  return new RegExp(`from\\s+["']${pkg}["']`).test(text);
}

void readdirSync; // (reserved for future directory pins)
await main();
