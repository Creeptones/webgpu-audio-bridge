/**
 * voiceKernel — Apollo Frontier 7, Stage 4 pins (SIMD across voices).
 *
 * Proves a STATEFUL kernel compiled along the VOICE axis (W independent voices packed
 * per v128, lane j = voice j) is gate-verified bit-exact: lane j ≡ an independent scalar
 * `evalReference` run of voice j — through REAL wabt compilation + execution. The
 * recurrence stays sequential WITHIN a lane and goes parallel ACROSS lanes; soundness is
 * that no IrNode references another voice (§2 of the handoff). Mirrors the wabt harness +
 * numbered-pin style of tests/delayKernel.test.ts / tests/stateKernel.test.ts.
 *
 * Run: tsx tests/voiceKernel.test.ts
 *
 * Pins (compiler + gate; the runtime/cross-quantum pin lives in stateKernelConsumer)
 *  1  voice-batched one-pole ≡ W scalar one-poles (f32, W=4, bit-exact): 4 DISTINCT
 *     per-voice inputs + 4 DISTINCT cutoffs; each output lane ≡ evalReference(voice j).
 *     The headline soundness gate — the distinct-per-voice corpus catches a lane cross.
 *  2  voice-batched delay line ≡ W scalar delays (the shared-cursor pin): a pure delay
 *     batched across voices, run long enough to WRAP the ring; lane j ≡ evalReference(j).
 *  3  f64 → W = 2 voices: pin 1 in f64 (W=2), bit-exact — the lane count tracks width.
 *  4  the voice gate REJECTS a deliberately lane-crossed module (broadcast lane 0 to all
 *     lanes) — `rejected-gate`, `voice-vs-ref`, with the offending lane index ≥ 1.
 *  6  voices===1 + stateless paths untouched (the frontier gate): a voices=1 stateful
 *     kernel compiles to the byte-identical Stage-3 scalar module (mode "scalar"); a
 *     stateless kernel still takes time-axis SIMD (mode "simd-time", voices ignored).
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  compileIr, evalReference, emitScalarModule, runGate, buildCorpus, CORPUS_N_VALUES,
  voiceParamLayout, stateLayout,
  type CompileResult, type LaneWidth,
} from "../src/jit/index.js";
import {
  type IrKernel, type IrNode, type IrStore, type IrStateDecl, type IrStateStore,
  type IrStateBufferDecl, type IrStateBufferStore,
  type LoopBound, type KernelParam, type ParamRole, type BinaryOp,
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

// ── IR builders ───────────────────────────────────────────────────────────────
const C = (value: number): IrNode => ({ kind: "const", value });
const S = (name: string): IrNode => ({ kind: "scalar", name });
const L = (array: string, stride = 1, intercept = 0): IrNode => ({ kind: "load", array, stride, intercept });
const RS = (name: string): IrNode => ({ kind: "readState", name });
const RD = (buffer: string, delay: number): IrNode => ({ kind: "readDelay", buffer, delay });
const Bn = (op: BinaryOp, a: IrNode, b: IrNode): IrNode => ({ kind: "binary", op, a, b });
const ST = (array: string, value: IrNode, stride = 1, intercept = 0): IrStore => ({ array, stride, intercept, value });
const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
const SD = (name: string, init = 0): IrStateDecl => ({ name, init });
const SW = (name: string, value: IrNode): IrStateStore => ({ name, value });
const SB = (name: string, length: number): IrStateBufferDecl => ({ name, length });
const WD = (buffer: string, value: IrNode): IrStateBufferStore => ({ buffer, value });
const pb = (name: string): LoopBound => ({ kind: "param", name });

function K(
  width: LaneWidth, params: KernelParam[], bound: LoopBound, stores: IrStore[],
  opts: { stateDecls?: IrStateDecl[]; stateStores?: IrStateStore[]; stateBuffers?: IrStateBufferDecl[]; stateBufferStores?: IrStateBufferStore[] } = {},
): IrKernel {
  const out: IrKernel = { width, bound, stores, signature: { params, width } };
  if (opts.stateDecls || opts.stateStores) { (out as { stateDecls?: IrStateDecl[] }).stateDecls = opts.stateDecls ?? []; (out as { stateStores?: IrStateStore[] }).stateStores = opts.stateStores ?? []; }
  if (opts.stateBuffers || opts.stateBufferStores) { (out as { stateBuffers?: IrStateBufferDecl[] }).stateBuffers = opts.stateBuffers ?? []; (out as { stateBufferStores?: IrStateBufferStore[] }).stateBufferStores = opts.stateBufferStores ?? []; }
  return out;
}

// ── run a voice-SIMD WASM kernel over a lane-packed batch of W voices ──────────
// Lays out one voice-interleaved I/O slab per array, a lane-packed state slab, and a
// lane-packed scalar slab; seeds state cold; calls via voiceParamLayout's arg order;
// de-interleaves each lane of the PRIMARY output. Returns lane → output[n].
function runVoiceKernel(
  wasm: Uint8Array, ir: IrKernel, W: number, n: number,
  perVoiceInputs: Array<Record<string, number[]>>,
  perVoiceScalars: Array<Record<string, number>>,
): number[][] {
  const TA = ir.width === "f32" ? Float32Array : Float64Array;
  const round = (v: number): number => (ir.width === "f32" ? Math.fround(v) : v);
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 16384, shared: true });
  const buf = new Uint8Array(wasm.byteLength); buf.set(wasm);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(buf), { env: { memory } });
  const kernel = inst.exports["kernel"] as (...a: number[]) => void;

  const slot = 256 * 1024; // generous, 16-aligned per-region slab (bytes)
  const inputs = ir.signature.params.filter((p) => p.role === "input").map((p) => p.name);
  const outputs = ir.signature.params.filter((p) => p.role === "output").map((p) => p.name);
  const scalarNames = ir.signature.params.filter((p) => p.role === "scalar").map((p) => p.name);
  const slabElements = Math.max(1, stateLayout(ir).elements);

  let off = 16;
  const offsets: Record<string, number> = {};
  for (const p of ir.signature.params) if (p.role === "input" || p.role === "output") { offsets[p.name] = off; off += slot; }
  const stateOff = off; off += slot;
  const scalarOff = off; off += slot;

  // inputs lane-packed: view[i·W + j] = voice j's row
  for (const name of inputs) {
    const v = new TA(memory.buffer, offsets[name]!, n * W);
    for (let j = 0; j < W; j++) { const row = perVoiceInputs[j]![name]!; for (let i = 0; i < n; i++) v[i * W + j] = row[i]!; }
  }
  // scalar slab lane-packed: sv[s·W + j] = voice j's value of scalar s
  if (scalarNames.length > 0) {
    const sv = new TA(memory.buffer, scalarOff, scalarNames.length * W);
    for (let s = 0; s < scalarNames.length; s++) for (let j = 0; j < W; j++) sv[s * W + j] = round(perVoiceScalars[j]![scalarNames[s]!] ?? 0);
  }
  // seed the lane-packed state slab COLD: zero, then each reg's init into all W lanes
  {
    const stv = new TA(memory.buffer, stateOff, slabElements * W);
    stv.fill(0);
    for (const r of stateLayout(ir).regs) for (let j = 0; j < W; j++) stv[r.offset * W + j] = r.init;
  }

  // args in voiceParamLayout order
  const args: number[] = [n];
  for (const p of ir.signature.params) if (p.role === "input" || p.role === "output") args.push(offsets[p.name]!);
  args.push(stateOff);
  if (scalarNames.length > 0) args.push(scalarOff);
  void voiceParamLayout; // shape asserted below
  kernel(...args);

  const outName = outputs[0]!;
  const ov = new TA(memory.buffer, offsets[outName]!, n * W);
  const lanes: number[][] = [];
  for (let j = 0; j < W; j++) { const a = new Array<number>(n); for (let i = 0; i < n; i++) a[i] = ov[i * W + j]!; lanes.push(a); }
  return lanes;
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

function maxAbsDiff(a: number[], b: number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

function sineRow(n: number, freq: number, amp = 0.8): number[] {
  return Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / n));
}

// ── the kernels ────────────────────────────────────────────────────────────────
// one-pole lowpass: out[i] = (1-c)*x[i] + c*s; s := out[i].
const onePoleExpr = Bn("add", Bn("mul", Bn("sub", C(1), S("c")), L("x")), Bn("mul", S("c"), RS("s")));
function onePole(width: LaneWidth): IrKernel {
  return K(width, [P("n", "length"), P("out", "output"), P("x", "input"), P("c", "scalar")], pb("n"),
    [ST("out", onePoleExpr)], { stateDecls: [SD("s", 0)], stateStores: [SW("s", onePoleExpr)] });
}

// pure delay: out[i] = readDelay(d, N); writeDelay(d, x[i]).  ⇒ out[i] = x[i−N].
const DELAY_N = 4;
const pureDelay = K("f32",
  [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", RD("d", DELAY_N))],
  { stateBuffers: [SB("d", DELAY_N)], stateBufferStores: [WD("d", L("x"))] });

// one-sample register delay (z⁻¹): out[i] = readState(s); s := x[i].  ⇒ out[i] = x[i−1].
const z1 = K("f32",
  [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", RS("s"))],
  { stateDecls: [SD("s", 0)], stateStores: [SW("s", L("x"))] });

// stateless gain (the "stateless untouched" witness).
const gain = K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
  [ST("out", Bn("mul", L("x"), S("g")))]);

async function main(): Promise<void> {
  // ── Pin 1: voice-batched one-pole ≡ 4 scalar one-poles (f32, W=4, bit-exact) ──
  {
    const ir = onePole("f32");
    const acc = expectAccepted(compileIr(ir, { compileWat, voices: 4 }), "voice one-pole f32");
    assertEq(acc.plan.mode, "simd-voice", "one-pole: plan.mode = simd-voice");
    assertEq(acc.plan.laneWidth, 4, "one-pole: W = 4 (f32)");
    assertEq(acc.voices, 4, "one-pole: accepted.voices = 4");
    assertEq(acc.gate.status, "accepted", "one-pole: voice gate accepted");
    assert(acc.gate.comparisons > 0, "one-pole: voice gate ran comparisons");
    assertEq(acc.gate.worstUlpF32, 0, "one-pole: lane ≡ scalar voice BIT-EXACT (worst ULP 0)");
    assert(acc.simdWat.includes("f32x4"), "one-pole: voice module is f32x4");
    assert(acc.simdWat.includes("$__scalars"), "one-pole: voice module threads a per-voice scalar slab");
    assert(!acc.scalarWat.includes("f32x4"), "one-pole: the scalar reference is single-lane");

    const W = 4; const n = 200;
    const cutoffs = [0.3, 0.5, 0.6, 0.72];
    const inputs = Array.from({ length: W }, (_, j) => ({ x: sineRow(n, j + 2) }));
    const scalars = cutoffs.map((c) => ({ c }));
    const lanes = runVoiceKernel(acc.wasm, ir, W, n, inputs, scalars);
    for (let j = 0; j < W; j++) {
      const ref = evalReference(ir, inputs[j]!, scalars[j]!, n)["out"]!;
      assertEq(maxAbsDiff(lanes[j]!, ref), 0, `one-pole: lane ${j} ≡ evalReference(voice ${j}) bit-exact (c=${cutoffs[j]})`);
    }
    // the voices are genuinely independent (distinct inputs/cutoffs ⇒ distinct lanes)
    assert(maxAbsDiff(lanes[0]!, lanes[1]!) > 0.01, "one-pole: lane 0 ≠ lane 1 (no broadcast)");
    assert(maxAbsDiff(lanes[1]!, lanes[2]!) > 0.01, "one-pole: lane 1 ≠ lane 2 (no broadcast)");
    ok("1 voice one-pole: 4 lanes each bit-exact to an independent scalar voice (the soundness gate)");
  }

  // ── Pin 2: voice-batched delay ≡ 4 scalar delays (the shared-cursor pin) ───────
  {
    const acc = expectAccepted(compileIr(pureDelay, { compileWat, voices: 4 }), "voice delay f32");
    assertEq(acc.plan.mode, "simd-voice", "delay: simd-voice");
    assertEq(acc.gate.worstUlpF32, 0, "delay: voice gate bit-exact (shared cursor over a lane-packed ring)");
    assertEq(acc.stateBuffers.length, 1, "delay: buffer surfaced");

    const W = 4; const n = 23; // > N=4, wraps the ring 5×+
    const inputs = Array.from({ length: W }, (_, j) => ({ x: Array.from({ length: n }, (_, i) => (i + 1) * (j + 1) * 0.01) }));
    const lanes = runVoiceKernel(acc.wasm, pureDelay, W, n, inputs, []);
    for (let j = 0; j < W; j++) {
      const ref = evalReference(pureDelay, inputs[j]!, {}, n)["out"]!;
      assertEq(maxAbsDiff(lanes[j]!, ref), 0, `delay: lane ${j} ≡ evalReference(voice ${j}) across the ring wrap`);
      for (let i = 0; i < n; i++) {
        const want = i < DELAY_N ? 0 : Math.fround(inputs[j]!.x[i - DELAY_N]!);
        assertEq(Math.fround(lanes[j]![i]!), want, `delay: lane ${j} out[${i}] = x[${i - DELAY_N}]`);
      }
    }
    ok("2 voice delay: ONE shared cursor over a lane-packed ring — each lane is its own scalar delay");
  }

  // ── Pin 3: f64 → W = 2 voices (bit-exact, lane count tracks width) ─────────────
  {
    const ir = onePole("f64");
    const acc = expectAccepted(compileIr(ir, { compileWat, voices: 2 }), "voice one-pole f64");
    assertEq(acc.plan.mode, "simd-voice", "f64: simd-voice");
    assertEq(acc.plan.laneWidth, 2, "f64: W = 2");
    assertEq(acc.voices, 2, "f64: accepted.voices = 2");
    assertEq(acc.gate.status, "accepted", "f64: voice gate accepted");
    assert(acc.simdWat.includes("f64x2"), "f64: voice module is f64x2");

    const W = 2; const n = 256;
    const cutoffs = [0.4, 0.66];
    const inputs = Array.from({ length: W }, (_, j) => ({ x: sineRow(n, j + 3) }));
    const scalars = cutoffs.map((c) => ({ c }));
    const lanes = runVoiceKernel(acc.wasm, ir, W, n, inputs, scalars);
    for (let j = 0; j < W; j++) {
      const ref = evalReference(ir, inputs[j]!, scalars[j]!, n)["out"]!;
      assertEq(maxAbsDiff(lanes[j]!, ref), 0, `f64: lane ${j} ≡ evalReference(voice ${j}) bit-exact`);
    }
    assert(maxAbsDiff(lanes[0]!, lanes[1]!) > 0.01, "f64: the two lanes are independent");
    ok("3 f64 voice: W = 2 lanes, each bit-exact to an independent scalar voice");
  }

  // ── Pin 4: the voice gate REJECTS a deliberately lane-crossed module ───────────
  {
    // A correct z⁻¹ voice kernel compiles + gate-verifies.
    const good = expectAccepted(compileIr(z1, { compileWat, voices: 4 }), "z1 voice");
    assertEq(good.gate.status, "accepted", "lane-cross: the correct z⁻¹ voice kernel passes");

    // A hand-written z⁻¹ voice module that BROADCASTS lane 0 to all four lanes
    // (f32x4.splat(extract_lane 0 …)) — lanes 1..3 then emit voice 0's delayed sample,
    // so they diverge from their own evalReference. Same ABI as voiceParamLayout(z1).
    const crossed = `(module
  (import "env" "memory" (memory 1 16384 shared))
  (func $kernel (export "kernel") (param $n i32) (param $out i32) (param $x i32) (param $__state i32)
    (local $i i32) (local $__st_s v128) (local $__next_s v128)
    (local.set $__st_s (v128.load (i32.add (local.get $__state) (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $exit (loop $loop
      (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
      (v128.store (i32.add (local.get $out) (i32.mul (i32.mul (local.get $i) (i32.const 4)) (i32.const 4)))
                  (f32x4.splat (f32x4.extract_lane 0 (local.get $__st_s))))
      (local.set $__next_s (v128.load (i32.add (local.get $x) (i32.mul (i32.mul (local.get $i) (i32.const 4)) (i32.const 4)))))
      (local.set $__st_s (local.get $__next_s))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (v128.store (i32.add (local.get $__state) (i32.const 0)) (local.get $__st_s))))`;

    const W = 4;
    const nValues = [...CORPUS_N_VALUES, 64];
    const voiceCorpora = Array.from({ length: W }, (_, j) => buildCorpus(z1.signature, { nValues, seed: 0xc0ffee + j * 0x9e3779b1 }));
    const report = runGate({
      ir: z1, scalarWat: emitScalarModule(z1), simdWat: crossed,
      corpus: voiceCorpora[0]!, voiceCorpora, compileWat, voiceMode: true,
    });
    assertEq(report.status, "rejected-gate", "lane-cross: broadcast module is rejected");
    assert(report.mismatch !== undefined, "lane-cross: a mismatch is reported");
    assertEq(report.mismatch!.kind, "voice-vs-ref", "lane-cross: mismatch kind is voice-vs-ref");
    assert((report.mismatch!.lane ?? 0) >= 1, `lane-cross: the offending lane index is ≥ 1 (got ${report.mismatch!.lane})`);
    ok("4 voice gate rejects a lane-crossed module (broadcast lane 0) with the offending lane index");
  }

  // ── Pin 6: voices===1 + stateless paths untouched (the frontier gate) ──────────
  {
    const ir = onePole("f32");
    // voices===1 stateful ⇒ the byte-identical Stage-3 scalar path.
    const def = expectAccepted(compileIr(ir, { compileWat }), "one-pole default");
    const v1 = expectAccepted(compileIr(ir, { compileWat, voices: 1 }), "one-pole voices=1");
    assertEq(def.plan.mode, "scalar", "frontier: default stateful is mode scalar");
    assertEq(v1.plan.mode, "scalar", "frontier: voices=1 stateful is mode scalar");
    assertEq(def.voices, 1, "frontier: default accepted.voices = 1");
    assertEq(v1.voices, 1, "frontier: voices=1 accepted.voices = 1");
    assertEq(v1.scalarWat, def.scalarWat, "frontier: voices=1 scalar module is byte-identical to default");
    assert(!v1.scalarWat.includes("f32x4"), "frontier: the voices=1 module is single-lane (no SIMD)");

    // a voices=2 (not a multiple of W=4) f32 kernel falls back to scalar (no half-batch).
    const v2 = expectAccepted(compileIr(ir, { compileWat, voices: 2 }), "one-pole voices=2 f32");
    assertEq(v2.plan.mode, "scalar", "frontier: voices=2 (not a multiple of W=4) falls back to scalar");

    // stateless gain: voices is IGNORED — still the time-axis SIMD path.
    const g4 = expectAccepted(compileIr(gain, { compileWat, voices: 4 }), "gain voices=4");
    assertEq(g4.plan.mode, "simd-time", "frontier: stateless kernel stays time-axis SIMD (voices ignored)");
    assertEq(g4.plan.scalarOnly, false, "frontier: stateless is NOT scalarOnly");
    assertEq(g4.voices, 1, "frontier: stateless accepted.voices = 1");
    ok("6 frontier gate: voices=1 byte-identical scalar; non-multiple-of-W falls back; stateless untouched");
  }

  console.log("\nAll voiceKernel (Frontier 7, Stage 4) compiler/gate pins passed.");
}

await main();
