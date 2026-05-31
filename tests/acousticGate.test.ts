/**
 * acousticGate — Stage-2 pins (Apollo Frontier 6, gate #3).
 *
 * The third gate: run an equivalence-accepted IR over a fixed DETERMINISTIC probe,
 * extract an `AcousticProfile` fingerprint, ACCEPT iff finite + within sane bounds,
 * and attach the profile to the characterized kernel. Pure + Node-testable — NO wasm
 * for the acoustic pass (gate #2 already proved SIMD ≡ the IR reference, so profiling
 * `evalReference(ir, …)` is equivalent). The cache (`getOrCompile`) owns the gate.
 *
 * The pathological pins are the crux of gate #3: each kernel PASSES the equivalence
 * gate (#2) — `compileTokens` accepts it — yet gate #3 rejects it, because a
 * bit-exact vectorization of a numerically-insane spec is still insane. That gap is
 * exactly what gate #2 structurally cannot close.
 *
 * Run: tsx tests/acousticGate.test.ts
 *
 * Pins
 *  1  the palette is acoustically sane — every hand-authored kernel passes gate #3
 *     with a finite profile; the `gain` fingerprint is checked structurally (peak,
 *     rms, dc, crest, centroid, L1-normalized magnitude band).
 *  2  pathological kernels: a multiply-overflow ((x·3e38)·3e38) kernel PASSES gate #2
 *     but gate #3 rejects it `non-finite`; an enormous-gain (×1e9) kernel PASSES gate
 *     #2 but gate #3 rejects it `peak-out-of-bounds`. The cache returns
 *     `rejected-acoustic` and does NOT store them. (A div-by-0 kernel can't make this
 *     point — `f32x4.div(0,0)` and scalar `f32.div(0,0)` produce different NaN
 *     payloads, so it's gate-#2-rejected before gate #3 ever sees it. The pathologies
 *     here use only `mul`, which is bit-stable SIMD-vs-scalar even on the corpus's NaN
 *     edge input, so they reach gate #3.)
 *  3  determinism — the same kernel ⇒ the byte-identical profile (two runs deep-equal);
 *     `evalReference` reproduces the kernel math exactly.
 *  4  the cache attaches `acoustic` to the `CharacterizedKernel`; a HIT returns it
 *     without re-running gate #3 (object identity + the equivalence-gate report intact).
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  acousticGate, evalReference, compileTokens, KernelCache, kernelToTokens,
  type CompileResult, type LaneWidth,
} from "../src/jit/index.js";
import {
  type IrKernel, type IrNode, type IrStore, type LoopBound,
  type KernelParam, type ParamRole, type UnaryOp, type BinaryOp,
} from "../src/jit/ir.js";

// ── wabt-backed compileWat (identical to the rest of the JIT suite) ──────────
const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength);
  u.set(buffer);
  return u;
}

// ── IR builders (mirror compileTokens.test.ts) ───────────────────────────────
const C = (value: number): IrNode => ({ kind: "const", value });
const S = (name: string): IrNode => ({ kind: "scalar", name });
const L = (array: string, stride = 1, intercept = 0): IrNode => ({ kind: "load", array, stride, intercept });
const U = (op: UnaryOp, a: IrNode): IrNode => ({ kind: "unary", op, a });
const Bn = (op: BinaryOp, a: IrNode, b: IrNode): IrNode => ({ kind: "binary", op, a, b });
const ST = (array: string, value: IrNode, stride = 1, intercept = 0): IrStore => ({ array, stride, intercept, value });
const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
const pb = (name: string): LoopBound => ({ kind: "param", name });
function K(width: LaneWidth, params: KernelParam[], bound: LoopBound, stores: IrStore[]): IrKernel {
  return { width, bound, stores, signature: { params, width } };
}

// ── the deterministic palette (same six as compileTokens.test.ts) ────────────
interface Named { readonly name: string; readonly ir: IrKernel; }
const PALETTE: ReadonlyArray<Named> = [
  { name: "gain", ir: K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
    [ST("out", Bn("mul", L("x"), S("g")))]) },
  { name: "hardclip", ir: K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
    [ST("out", Bn("min", Bn("max", L("x"), C(-1)), C(1)))]) },
  { name: "cubic-softclip", ir: K("f64", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
    [ST("out", Bn("sub", L("x"), Bn("div", Bn("mul", Bn("mul", L("x"), L("x")), L("x")), C(3))))]) },
  { name: "ringmod", ir: K("f32", [P("n", "length"), P("out", "output"), P("a", "input"), P("b", "input")], pb("n"),
    [ST("out", Bn("mul", L("a"), L("b")))]) },
  { name: "mix", ir: K("f64", [P("n", "length"), P("out", "output"), P("a", "input"), P("b", "input"), P("g", "scalar")], pb("n"),
    [ST("out", Bn("add", Bn("mul", Bn("sub", C(1), S("g")), L("a")), Bn("mul", S("g"), L("b"))))]) },
  { name: "rectify-scale", ir: K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
    [ST("out", Bn("mul", U("abs", L("x")), S("g")))]) },
];

// ── pathological kernels (PASS gate #2, FAIL gate #3) ─────────────────────────
// out = (x * 3e38) * 3e38 → overflows f32 to ±Inf on the full-scale probe — yet uses
// only `mul` (bit-stable SIMD-vs-scalar even on the corpus NaN edge), so gate #2
// ACCEPTS; gate #3 rejects on `finite`.
const OVERFLOW: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("mul", Bn("mul", L("x"), C(3e38)), C(3e38)))]);
// out = x * 1e9 → a finite but enormous peak — gate #2 ACCEPTS; gate #3 rejects on peak.
const BLOWUP: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("mul", L("x"), C(1e9)))]);
// out = x / 0 → used ONLY for the pure-JS evalReference math pin (it never reaches the
// equivalence gate — it would be gate-#2-rejected on NaN payloads, see the header).
const DIVZERO: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("div", L("x"), C(0)))]);

function expectAccepted(r: CompileResult, label: string): void {
  if (r.status !== "accepted") {
    const detail = r.status === "rejected-source" ? JSON.stringify(r.diagnostic)
      : r.status === "rejected-gate" ? JSON.stringify(r.gate.mismatch ?? r.gate.reason)
        : JSON.stringify((r as { reason?: string }).reason);
    assert(false, `${label}: expected gate #2 accepted, got ${r.status} — ${detail}`);
  }
}

async function main(): Promise<void> {
  // ── Pin 1: the palette is acoustically sane ───────────────────────────────
  for (const { name, ir } of PALETTE) {
    const r = acousticGate(ir);
    assert(r.ok, `palette ${name}: acousticGate ok (reason: ${r.ok ? "" : r.reason})`);
    assert(r.profile.finite, `${name}: profile finite`);
    assert(Number.isFinite(r.profile.peak) && r.profile.peak >= 0, `${name}: finite peak`);
    assert(Number.isFinite(r.profile.rms) && r.profile.rms >= 0, `${name}: finite rms`);
    assert(Number.isFinite(r.profile.spectralCentroid), `${name}: finite centroid`);
    assertEq(r.profile.magnitude.length, 16, `${name}: 16-band fingerprint`);
    const sum = r.profile.magnitude.reduce((a, b) => a + b, 0);
    assert(Math.abs(sum - 1) < 1e-9, `${name}: fingerprint L1-normalized (sum ${sum})`);
  }
  // gain (g=0.5, full-scale sine in): peak 0.5, rms 0.5/√2, dc≈0, crest≈√2, centroid at
  // bin 8/512, and ALL energy in band 0 (bin 8 → floor(7*16/512)=0).
  {
    const gain = PALETTE.find((p) => p.name === "gain")!.ir;
    const r = acousticGate(gain);
    assert(r.ok, "gain: ok");
    if (!r.ok) return;
    const p = r.profile;
    assert(Math.abs(p.peak - 0.5) < 1e-3, `gain: peak ≈ 0.5 (got ${p.peak})`);
    assert(Math.abs(p.rms - 0.5 / Math.SQRT2) < 1e-3, `gain: rms ≈ 0.354 (got ${p.rms})`);
    assert(Math.abs(p.dcOffset) < 1e-3, `gain: dc ≈ 0 (got ${p.dcOffset})`);
    assert(Math.abs(p.crestFactor - Math.SQRT2) < 1e-2, `gain: crest ≈ 1.414 (got ${p.crestFactor})`);
    assert(Math.abs(p.spectralCentroid - 8 / 512) < 1e-3, `gain: centroid ≈ 0.0156 (got ${p.spectralCentroid})`);
    assert(p.magnitude[0]! > 0.99, `gain: fundamental energy in band 0 (got ${p.magnitude[0]})`);
  }
  ok(`1 palette (${PALETTE.length}) acoustically sane + gain fingerprint structurally pinned`);

  // ── Pin 2: pathological kernels pass gate #2 but fail gate #3 ──────────────
  {
    // First: BOTH pass the equivalence gate (the whole point — gate #2 cannot catch this).
    expectAccepted(compileTokens(kernelToTokens(OVERFLOW), { compileWat }), "overflow gate#2");
    expectAccepted(compileTokens(kernelToTokens(BLOWUP), { compileWat }), "blowup gate#2");

    // gate #3 standalone: overflow → non-finite, blowup → peak-out-of-bounds.
    const ro = acousticGate(OVERFLOW);
    assert(!ro.ok, "overflow: gate #3 rejects");
    if (!ro.ok) {
      assert(!ro.profile.finite, "overflow: profile.finite is false");
      assert(ro.reason.startsWith("non-finite"), `overflow: reason non-finite (${ro.reason})`);
    }
    const rb = acousticGate(BLOWUP);
    assert(!rb.ok, "blowup: gate #3 rejects");
    if (!rb.ok) {
      assert(rb.profile.finite, "blowup: profile.finite is true (the output is finite, just huge)");
      assert(rb.reason.startsWith("peak-out-of-bounds"), `blowup: reason peak (${rb.reason})`);
      assert(rb.profile.peak > 1e8, `blowup: peak is enormous (${rb.profile.peak})`);
    }

    // Through the cache: rejected-acoustic, and NOT stored.
    const cache = new KernelCache();
    const co = cache.getOrCompile(kernelToTokens(OVERFLOW), { compileWat });
    assertEq(co.status, "rejected-acoustic", "overflow: cache status rejected-acoustic");
    if (co.status === "rejected-acoustic") assert(co.reason.startsWith("non-finite"), "overflow: cache reason");
    const cb = cache.getOrCompile(kernelToTokens(BLOWUP), { compileWat });
    assertEq(cb.status, "rejected-acoustic", "blowup: cache status rejected-acoustic");
    assertEq(cache.size, 0, "cache: acoustically-rejected kernels are NOT stored");

    // Tightening/loosening a bound is live: a generous maxPeak lets the finite ×1e9
    // kernel through (it is finite, just loud — bounds are policy, not a hard NaN gate).
    const loose = acousticGate(BLOWUP, { maxPeak: 1e12 });
    assert(loose.ok, "blowup: a generous maxPeak (1e12) lets the finite ×1e9 kernel pass");
  }
  ok(`2 pathological: overflow→non-finite, blowup→peak-out-of-bounds (both pass gate #2, rejected by gate #3, not cached)`);

  // ── Pin 3: determinism + evalReference correctness ────────────────────────
  {
    const gain = PALETTE.find((p) => p.name === "gain")!.ir;
    const a = acousticGate(gain);
    const b = acousticGate(gain);
    assert(a.ok && b.ok, "determinism: gain ok twice");
    assertEq(JSON.stringify(a), JSON.stringify(b), "determinism: same kernel ⇒ byte-identical profile");

    // evalReference reproduces the math: gain x=[1,2,3,4], g=2 → [2,4,6,8].
    const out = evalReference(gain, { x: [1, 2, 3, 4] }, { g: 2 }, 4);
    assertEq(out["out"]!.join(","), "2,4,6,8", "evalReference: gain x*g");
    // divzero x=[1,-1,0] → [Inf, -Inf, NaN] (drives the non-finite verdict).
    const dz = evalReference(DIVZERO, { x: [1, -1, 0] }, {}, 3);
    assertEq(dz["out"]![0], Infinity, "evalReference: 1/0 = +Inf");
    assertEq(dz["out"]![1], -Infinity, "evalReference: -1/0 = -Inf");
    assert(Number.isNaN(dz["out"]![2]!), "evalReference: 0/0 = NaN");
  }
  ok(`3 determinism (byte-identical profile across runs) + evalReference math exact`);

  // ── Pin 4: the cache attaches `acoustic` + a hit returns it gate-free ──────
  {
    const cache = new KernelCache();
    const gainTokens = kernelToTokens(PALETTE.find((p) => p.name === "gain")!.ir);

    const r1 = cache.getOrCompile(gainTokens, { compileWat });
    assert(r1.status === "accepted", "cache: gain accepted");
    if (r1.status !== "accepted") return;
    // The characterized kernel carries the gate-#3 profile.
    assert(r1.kernel.acoustic !== undefined, "cache: acoustic profile attached");
    assert(r1.kernel.acoustic.finite, "cache: attached profile finite");
    assertEq(r1.kernel.acoustic.magnitude.length, 16, "cache: attached fingerprint width");
    // It equals a standalone gate run on the same IR (the cache ran the same gate).
    const standalone = acousticGate(PALETTE.find((p) => p.name === "gain")!.ir);
    assert(standalone.ok, "cache: standalone gate ok");
    if (standalone.ok) {
      assertEq(JSON.stringify(r1.kernel.acoustic), JSON.stringify(standalone.profile), "cache: attached == standalone profile");
    }

    // A HIT returns the SAME object (so the same profile) with NO recompile + NO
    // re-run of gate #3 (object identity is the proof — the profile is not recomputed).
    const r2 = cache.getOrCompile(gainTokens, { compileWat });
    assert(r2.status === "accepted" && r2.cached, "cache: second getOrCompile is a HIT");
    if (r2.status === "accepted") {
      assert(r1.kernel === r2.kernel, "cache: hit returns the SAME object");
      assert(r1.kernel.acoustic === r2.kernel.acoustic, "cache: hit returns the SAME profile (gate #3 not re-run)");
    }
    assertEq(cache.size, 1, "cache: hit does not grow the store");
  }
  ok(`4 cache attaches acoustic profile; hit returns it without re-running gate #3`);

  console.log("\nAll acousticGate (gate #3) pins passed.");
}

await main();
