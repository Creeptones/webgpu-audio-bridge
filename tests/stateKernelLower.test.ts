/**
 * stateKernelLower — JS-source authoring for stateful kernels.
 *
 * Pins the follow-up to Frontier 7 Stage 1: `lower.ts` now accepts conservative
 * pre-loop state declarations (`let s = 0; for (...) { ...; s = next; }`) and lowers
 * them to the same simultaneous-state IR as the token path.
 *
 * Run: tsx tests/stateKernelLower.test.ts
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  compileKernel, connectJit, evalReference, kernelHash, kernelToTokens, lowerKernel,
  parseProgram, runJitCompile, tokensToKernel, paramLayout,
  type CompileResult, type LaneWidth,
} from "../src/jit/index.js";
import {
  kernelKey,
  type BinaryOp, type IrKernel, type IrNode, type IrStateDecl, type IrStateStore,
  type IrStore, type KernelParam, type KernelSignature, type LoopBound, type ParamRole,
} from "../src/jit/ir.js";

const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength);
  u.set(buffer);
  return u;
}

const C = (value: number): IrNode => ({ kind: "const", value });
const S = (name: string): IrNode => ({ kind: "scalar", name });
const L = (array: string): IrNode => ({ kind: "load", array, stride: 1, intercept: 0 });
const RS = (name: string): IrNode => ({ kind: "readState", name });
const Bn = (op: BinaryOp, a: IrNode, b: IrNode): IrNode => ({ kind: "binary", op, a, b });
const ST = (array: string, value: IrNode): IrStore => ({ array, stride: 1, intercept: 0, value });
const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
const SD = (name: string, init = 0): IrStateDecl => ({ name, init });
const SW = (name: string, value: IrNode): IrStateStore => ({ name, value });
const pb = (name: string): LoopBound => ({ kind: "param", name });

function sig(width: LaneWidth, ...spec: Array<[string, ParamRole]>): KernelSignature {
  return { width, params: spec.map(([name, role]) => ({ name, role })) };
}

function K(
  width: LaneWidth,
  params: KernelParam[],
  bound: LoopBound,
  stores: IrStore[],
  stateDecls?: IrStateDecl[],
  stateStores?: IrStateStore[],
): IrKernel {
  const base = { width, bound, stores, signature: { params, width } };
  return stateDecls || stateStores ? { ...base, stateDecls: stateDecls ?? [], stateStores: stateStores ?? [] } : base;
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

function runStateful(
  wasm: Uint8Array,
  ir: IrKernel,
  n: number,
  inputRows: Record<string, number[]>,
  scalarVals: Record<string, number>,
  stateSlab: Float32Array | Float64Array,
): number[] {
  const TA = ir.width === "f32" ? Float32Array : Float64Array;
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 16384, shared: true });
  const buf = new Uint8Array(wasm.byteLength); buf.set(wasm);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(buf), { env: { memory } });
  const kernel = inst.exports["kernel"] as (...a: number[]) => void;
  const layout = paramLayout(ir);
  const offsets: Record<string, number> = {};
  const args: number[] = [];
  let off = 16;
  const slot = 8192;
  for (let k = 0; k < layout.length; k++) {
    const p = layout[k]!;
    if (k === 0) { args.push(n); continue; }
    if (p.wasm === "i32") { offsets[p.name] = off; args.push(off); off += slot; }
    else { args.push(ir.width === "f32" ? Math.fround(scalarVals[p.name] ?? 0) : (scalarVals[p.name] ?? 0)); }
  }
  for (const name of Object.keys(inputRows)) {
    const v = new TA(memory.buffer, offsets[name]!, n);
    inputRows[name]!.forEach((x, i) => (v[i] = x));
  }
  if (offsets["__state"] !== undefined) new TA(memory.buffer, offsets["__state"]!, stateSlab.length).set(stateSlab as never);
  kernel(...args);
  if (offsets["__state"] !== undefined) stateSlab.set(new TA(memory.buffer, offsets["__state"]!, stateSlab.length) as never);
  const outName = ir.signature.params.find((p) => p.role === "output")!.name;
  return Array.from(new TA(memory.buffer, offsets[outName]!, n));
}

const onePoleExpr = Bn("add", Bn("mul", Bn("sub", C(1), S("c")), L("x")), Bn("mul", S("c"), RS("s")));
const onePoleParams = [P("n", "length"), P("out", "output"), P("x", "input"), P("c", "scalar")];
const onePole = K("f32", onePoleParams, pb("n"), [ST("out", onePoleExpr)], [SD("s")], [SW("s", onePoleExpr)]);
const onePoleSource = `
function k(n, out, x, c) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const y = (1 - c) * x[i] + c * s;
    out[i] = y;
    s = y;
  }
}`;

const biquadParams = [
  P("n", "length"), P("out", "output"), P("x", "input"),
  P("b0", "scalar"), P("b1", "scalar"), P("b2", "scalar"), P("a1", "scalar"), P("a2", "scalar"),
];
const biquadY = Bn("sub",
  Bn("add", Bn("add", Bn("mul", S("b0"), L("x")), Bn("mul", S("b1"), RS("x1"))), Bn("mul", S("b2"), RS("x2"))),
  Bn("add", Bn("mul", S("a1"), RS("y1")), Bn("mul", S("a2"), RS("y2"))));
const biquad = K("f32", biquadParams, pb("n"), [ST("out", biquadY)],
  [SD("x1"), SD("x2"), SD("y1"), SD("y2")],
  [SW("x1", L("x")), SW("x2", RS("x1")), SW("y1", biquadY), SW("y2", RS("y1"))]);
const biquadSource = `
function k(n, out, x, b0, b1, b2, a1, a2) {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < n; i++) {
    const y = ((b0 * x[i] + b1 * x1) + b2 * x2) - (a1 * y1 + a2 * y2);
    out[i] = y;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
  }
}`;

async function main(): Promise<void> {
  {
    const jsIr = lowerKernel(parseProgram(onePoleSource), onePole.signature);
    assertEq(kernelKey(jsIr), kernelKey(onePole), "one-pole JS lowers to the token/IR one-pole shape");
    assertEq(kernelHash(jsIr), kernelHash(kernelToTokens(onePole)), "one-pole JS and token path share content hash");
    const x = Array.from({ length: 64 }, (_, i) => Math.sin(0.07 * i));
    const a = evalReference(jsIr, { x }, { c: 0.6 }, x.length)["out"]!;
    const b = evalReference(tokensToKernel(kernelToTokens(onePole)), { x }, { c: 0.6 }, x.length)["out"]!;
    assertEq(maxAbsDiff(a, b), 0, "one-pole JS IR behavior matches token IR behavior");
    ok("1 JS one-pole lowers to the same stateful IR behavior as the token one-pole");
  }

  {
    const acc = expectAccepted(compileKernel(biquadSource, biquad.signature, { compileWat }), "JS biquad");
    assertEq(acc.plan.mode, "scalar", "JS biquad: stateful single-voice path");
    assertEq(acc.gate.status, "accepted", "JS biquad: gate accepted");
    assertEq(acc.stateDecls.length, 4, "JS biquad: four state registers");
    const n = 256;
    const x = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / n));
    const sc = { b0: 0.2, b1: 0.1, b2: 0.05, a1: -0.4, a2: 0.2 };
    const ref = evalReference(biquad, { x }, sc, n)["out"]!;
    const out = runStateful(acc.wasm, biquad, n, { x }, sc, new Float32Array(4));
    assertEq(maxAbsDiff(out, ref), 0, "JS biquad deliverable matches evalReference");
    ok("2 JS biquad compiles, gate-verifies, and matches evalReference");
  }

  {
    const unsafe = `
function k(n, out, x) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    s = x[i];
    out[i] = s;
  }
}`;
    const r = compileKernel(unsafe, sig("f32", ["n", "length"], ["out", "output"], ["x", "input"]), { compileWat });
    assertEq(r.status, "rejected-source", "unsafe read-after-state-write is rejected");
    if (r.status === "rejected-source") {
      assertEq(r.diagnostic.code, "E_LOOP_CARRY", "unsafe diagnostic code");
      assert(/read after being assigned/.test(r.diagnostic.message), `unsafe diagnostic should explain same-iteration state ordering, got: ${r.diagnostic.message}`);
    }
    ok("3 unsafe sequential state dependency is rejected with a clear diagnostic");
  }

  {
    const source = `
function k(n, out, x, c) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const y = (1 - c) * x[i] + c * s;
    out[i] = y;
    s = y;
  }
}`;
    // eslint-disable-next-line no-new-func
    const kernel = new Function(`"use strict"; return (${source});`)() as (...args: never[]) => void;
    const signature = sig("f64", ["n", "length"], ["out", "output"], ["x", "input"], ["c", "scalar"]);
    const c = connectJit({ kernel, signature, voices: 2, maxBlock: 128, sampleRate: 48_000 });
    assertEq(c.processorOptions.voices, 2, "connectJit JS stateful path keeps requested f64 W=2 voices");
    assertEq(c.processorOptions.stateDecls.length, 1, "connectJit JS stateful path exposes stateDecls");
    assert(c.compileRequest.kind !== "tokens", "connectJit JS stateful path sends a JS compile request");
    assertEq((c.compileRequest as { voices?: number }).voices, 2, "connectJit JS compile request carries voices");
    assert(c.kernelSource !== kernel.toString(), "connectJit stateful JS fallback is IR-emitted so it can take the persistent state slab");
    const resp = await runJitCompile(c.compileRequest, { compileWat });
    assertEq(resp.status, "accepted", "connectJit JS stateful compile accepts");
    if (resp.status === "accepted") {
      assertEq(resp.voices, 2, "connectJit JS stateful result is compiled for W voices");
      assertEq(resp.stateDecls.length, 1, "connectJit JS stateful result carries stateDecls");
    }
    ok("4 connectJit({ kernel, voices: W }) over stateful JS routes to voice-SIMD");
  }

  {
    const source = "function k(n, out, x, g) { for (let i = 0; i < n; i++) { out[i] = x[i] * g; } }";
    const signature = sig("f32", ["n", "length"], ["out", "output"], ["x", "input"], ["g", "scalar"]);
    const jsIr = lowerKernel(parseProgram(source), signature);
    const tokenIr = K("f32", [...signature.params], pb("n"), [ST("out", Bn("mul", L("x"), S("g")))]);
    assertEq(kernelHash(jsIr), kernelHash(tokenIr), "stateless JS hash/path stays state-free");
    const acc = expectAccepted(compileKernel(source, signature, { compileWat, voices: 4 }), "stateless JS gain");
    assertEq(acc.plan.mode, "simd-time", "stateless JS still takes time-axis SIMD");
    assertEq(acc.voices, 1, "stateless JS ignores voices");
    assertEq(acc.stateDecls.length, 0, "stateless JS result has no stateDecls");
    ok("5 stateless JS kernels keep the state-free hash/path/behavior");
  }

  console.log("\nAll stateKernelLower pins passed.");
}

await main();
