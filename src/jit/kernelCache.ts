/**
 * kernelCache — the content-addressed characterized-kernel cache
 * (Apollo Frontier 6, Stage 1).
 *
 * A token stream → a CHARACTERIZED kernel: its content address (`kernelHash`), the
 * gate report that PROVED it (bit-exact / within-ULP), the deliverable SIMD bytes,
 * and the JS fallback the worklet runs while the swap fades. The cache is keyed by
 * the content address, so a repeated kernel is FREE — the gate + compile (~1.5 ms
 * per `bench:jit`) run once per distinct computation, never per request. This is
 * the exact object a Stage-3 SLM worker calls: emit tokens → `getOrCompile` →
 * either an instantly-returned cached kernel or a freshly gate-verified one.
 *
 * The address is over the kernel BODY (`kernelHash` → `kernelKey`), NOT the
 * signature — two token streams that compute the same thing with a different
 * calling convention share one cache entry (the intended identity). The hash is a
 * cache key / identity, NOT a security boundary: the equivalence gate is the
 * boundary, and every `accepted` entry has passed it.
 *
 * Pure + Node-testable: no I/O, no clock, no randomness. Rejection is a VALUE
 * (mirrors `compileTokens` / `compileKernel`) — a malformed stream returns
 * `rejected-source` (with the `E_TOKENS` diagnostic), an out-of-subset shape
 * `unsupported`, a gate failure `rejected-gate`; none are cached as accepted.
 *
 * `@experimental` — exported from `webgpu-audio-bridge/experimental`.
 */

import { type IrKernel, type KernelSignature } from "./ir.js";
import { type Diagnostic } from "./diagnostics.js";
import { type CompileWat, type GateReport } from "./gate.js";
import { type CorpusOptions } from "./corpus.js";
import { compileIr, type CompileResult } from "./compileKernel.js";
import { emitJsKernel } from "./emitJsKernel.js";
import {
  validateTokens, kernelHash, kernelToTokens, type KernelToken,
} from "./kernelGrammar.js";

/** A kernel that has passed the syntax + equivalence gates and been characterized.
 *  The `acoustic` field is RESERVED for Stage 2 (the third gate) — left open so the
 *  message format is forward-compatible. */
export interface CharacterizedKernel {
  /** Content address / identity — `kernelHash(ir)` (the cache key). */
  readonly hash: string;
  /** The canonical token serialization of the validated IR (the smaller language). */
  readonly tokens: ReadonlyArray<KernelToken>;
  /** The I/O shape (carried for the consumer; NOT part of the address). */
  readonly signature: KernelSignature;
  /** The export name the SIMD module exposes (default "kernel"). */
  readonly exportName: string;
  /** The equivalence-gate characterization (bit-exact / within-ULP, comparisons). */
  readonly gate: GateReport;
  /** The gate-PASSED deliverable SIMD bytes. */
  readonly wasm: Uint8Array;
  /** The naive scalar JS the worklet runs as the permanent fallback / fade source. */
  readonly jsSource: string;
  // readonly acoustic?: AcousticProfile;  // Stage 2 — the third (acoustic) gate.
}

/** Options for `KernelCache.getOrCompile` — the injected WAT→bytes compiler plus the
 *  optional gate knobs (same surface as `compileTokens`). */
export interface GetOrCompileOptions {
  readonly compileWat: CompileWat;
  readonly exportName?: string;
  readonly corpus?: CorpusOptions;
  readonly maxUlpF32?: number;
}

/** The result of `getOrCompile`: an `accepted` carrying the characterized kernel +
 *  a `cached` flag (true ⇒ returned from the store without recompiling), or exactly
 *  the failure variants of `CompileResult` (rejection is a value). */
export type GetOrCompileResult =
  | { readonly status: "accepted"; readonly kernel: CharacterizedKernel; readonly cached: boolean }
  | Exclude<CompileResult, { readonly status: "accepted" }>;

/**
 * A content-addressed store of characterized kernels. Hit → instant return; miss →
 * gate-verify + characterize + store. The store is a plain `Map<hash, …>`; no
 * eviction in Stage 1 (the kernel population is small + hand/SLM-curated).
 */
export class KernelCache {
  private readonly store = new Map<string, CharacterizedKernel>();

  /** Number of distinct characterized kernels held. */
  get size(): number {
    return this.store.size;
  }

  /** True iff a kernel with this content address is already characterized. */
  has(hash: string): boolean {
    return this.store.has(hash);
  }

  /** The characterized kernel for a content address, or undefined. */
  get(hash: string): CharacterizedKernel | undefined {
    return this.store.get(hash);
  }

  /** Drop every entry. */
  clear(): void {
    this.store.clear();
  }

  /**
   * Look up (or, on a miss, compile + characterize + store) the kernel for a token
   * stream. On a HIT the SAME `CharacterizedKernel` object is returned with
   * `cached: true` and NO recompile happens (the property that makes a repeated
   * kernel free — assert it by object identity). On a syntax/equivalence/support
   * failure the matching failure variant is returned and nothing is stored.
   */
  getOrCompile(tokens: ReadonlyArray<KernelToken>, opts: GetOrCompileOptions): GetOrCompileResult {
    const v = validateTokens(tokens);
    if (!v.ok) {
      const message = v.at !== undefined ? `${v.error} (at token ${v.at})` : v.error;
      return { status: "rejected-source", diagnostic: tokenDiagnostic(message) };
    }

    const ir: IrKernel = v.ir;
    const hash = kernelHash(ir);
    const hit = this.store.get(hash);
    if (hit) return { status: "accepted", kernel: hit, cached: true };

    const result = compileIr(ir, {
      compileWat: opts.compileWat,
      exportName: opts.exportName,
      corpus: opts.corpus,
      maxUlpF32: opts.maxUlpF32,
    });
    if (result.status !== "accepted") return result;

    const characterized: CharacterizedKernel = {
      hash,
      tokens: kernelToTokens(ir),
      signature: ir.signature,
      exportName: result.exportName,
      gate: result.gate,
      wasm: result.wasm,
      jsSource: emitJsKernel(ir),
    };
    this.store.set(hash, characterized);
    return { status: "accepted", kernel: characterized, cached: false };
  }
}

function tokenDiagnostic(message: string): Diagnostic {
  return { code: "E_TOKENS", message, line: 0, col: 0 };
}
