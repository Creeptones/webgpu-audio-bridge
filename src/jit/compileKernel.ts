/**
 * compileKernel — the JIT pipeline entry (Apollo Frontier 5, Stage 1a).
 *
 *   source (naive scalar JS) + KernelSignature
 *     → parse (acorn)            [E_PARSE on bad JS]
 *     → lower/validate → IR      [rejected-source on any out-of-subset construct]
 *     → vectorize → plan         [unsupported if not v1-emittable, e.g. stride-2]
 *     → emit scalar + SIMD WAT
 *     → equivalence gate         [rejected-gate if SIMD ≠ scalar on the corpus]
 *     → accepted { wasm, … }
 *
 * The result is a DISCRIMINATED UNION — `compileKernel` NEVER throws on a user
 * program (rejection is a value). The caller (the Stage-1b hot-swap runtime)
 * swaps ONLY on `status === "accepted"`; every other status keeps the JS kernel
 * running. That is the safety contract: an out-of-subset program, a
 * gate-rejected candidate, and a SIMD-unavailable host all degrade to "the audio
 * keeps playing on the user's JS".
 *
 * `@experimental` — exported from `webgpu-audio-bridge/experimental`, NOT the
 * 1.0 core. A one-shot construction warning fires (mirrors MpmcRing/SpmcRing).
 */

import { parseProgram } from "./parse.js";
import { lowerKernel } from "./lower.js";
import { JitRejection, type Diagnostic } from "./diagnostics.js";
import { vectorize, type VectorizedKernelPlan } from "./vectorize.js";
import { emitScalarModule, emitSimdModule } from "./emitKernelWat.js";
import { buildCorpus, type CorpusOptions } from "./corpus.js";
import { runGate, type CompileWat, type GateReport } from "./gate.js";
import { type KernelSignature, type LaneWidth } from "./ir.js";

export interface CompileKernelOptions {
  /** Injected WAT→bytes compiler (wabt in tests/build; a binary encoder in the
   *  live browser worker). Required — the gate cannot run without it. */
  readonly compileWat: CompileWat;
  /** Override the signature width (default: signature.width ?? "f32"). */
  readonly width?: LaneWidth;
  readonly exportName?: string;
  readonly corpus?: CorpusOptions;
  /** f32 ULP budget for the gate (default 0 — v1 is bit-exact). */
  readonly maxUlpF32?: number;
}

export type CompileResult =
  | {
      readonly status: "accepted";
      readonly wasm: Uint8Array;
      readonly scalarWat: string;
      readonly simdWat: string;
      readonly plan: VectorizedKernelPlan;
      readonly exportName: string;
      readonly gate: GateReport;
    }
  | { readonly status: "rejected-source"; readonly diagnostic: Diagnostic }
  | { readonly status: "rejected-gate"; readonly gate: GateReport }
  | { readonly status: "unsupported"; readonly reason: string; readonly gate?: GateReport };

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[webgpu-audio-bridge] The Autonomous JIT (compileKernel) is EXPERIMENTAL " +
      "(0.9.913, Apollo Frontier 5, Stage 1a). Its API + the compilable sub-language " +
      "are outside the 1.0 stability contract and may change before promotion. A " +
      "generated kernel is only ever returned as `accepted` after passing the " +
      "bit-exact/within-ULP equivalence gate. See docs/frontier5-jit-handoff.md.",
  );
}

export function compileKernel(
  source: string,
  signature: KernelSignature,
  opts: CompileKernelOptions,
): CompileResult {
  warnOnce();
  const sig: KernelSignature = opts.width ? { ...signature, width: opts.width } : signature;
  const exportName = opts.exportName ?? "kernel";

  // parse + lower/validate — rejection is a value, not an exception.
  let ir;
  try {
    const program = parseProgram(source);
    ir = lowerKernel(program, sig);
  } catch (err) {
    if (err instanceof JitRejection) return { status: "rejected-source", diagnostic: err.diagnostic };
    throw err;
  }

  // vectorize — surfaces v1-non-emittable shapes as `unsupported` (→ JS fallback).
  const vec = vectorize(ir, exportName);
  if (!vec.ok) return { status: "unsupported", reason: vec.reason };

  const scalarWat = emitScalarModule(ir, exportName);
  const simdWat = emitSimdModule(ir, exportName);

  const corpus = buildCorpus(sig, opts.corpus);
  const gate = runGate({ ir, scalarWat, simdWat, corpus, compileWat: opts.compileWat, jsSource: source, maxUlpF32: opts.maxUlpF32 });

  if (gate.status === "unsupported") return { status: "unsupported", reason: gate.reason ?? "unsupported", gate };
  if (gate.status === "rejected-gate") return { status: "rejected-gate", gate };

  // accepted — produce the deliverable SIMD bytes.
  const wasm = opts.compileWat(simdWat, "simd");
  return { status: "accepted", wasm, scalarWat, simdWat, plan: vec.plan, exportName, gate };
}
