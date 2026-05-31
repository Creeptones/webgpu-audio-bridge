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
 * `unsupported`, an equivalence-gate failure `rejected-gate`, an acoustic-gate
 * failure `rejected-acoustic`; none are cached as accepted.
 *
 * The cache layer OWNS gate #3 (the acoustic gate). After the equivalence gate
 * accepts, `acousticGate` runs the IR over a deterministic probe and ACCEPTs iff the
 * `AcousticProfile` is finite + within sane bounds — attaching the profile to the
 * `CharacterizedKernel` (so it is computed ONCE per content hash, free on a hit) and
 * rejecting a runaway/non-finite kernel as `rejected-acoustic`. Gate #3 lives only
 * here, not in `compileIr` / `compileTokens` (the equivalence layer is untouched).
 *
 * `@experimental` — exported from `webgpu-audio-bridge/experimental`.
 */

import { type IrKernel, type KernelSignature } from "./ir.js";
import { type Diagnostic } from "./diagnostics.js";
import { type CompileWat, type GateReport } from "./gate.js";
import { type CorpusOptions } from "./corpus.js";
import { compileIr, type CompileResult } from "./compileKernel.js";
import { emitJsKernel } from "./emitJsKernel.js";
import { acousticGate, type AcousticProfile, type AcousticGateOptions } from "./acousticGate.js";
import {
  validateTokens, kernelHash, kernelToTokens, type KernelToken,
} from "./kernelGrammar.js";

/** A kernel that has passed the syntax + equivalence + acoustic gates and been
 *  characterized. */
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
  /** The acoustic-gate (#3) fingerprint over a deterministic probe (level + spectral
   *  shape). PRESENT on every characterized kernel (gate #3 passed). Computed once per
   *  content hash; free on a cache hit. The Stage-3 model's feature vector + the
   *  basis for dedup-by-sound / "sounds-like" search. */
  readonly acoustic: AcousticProfile;
}

/** Options for `KernelCache.getOrCompile` — the injected WAT→bytes compiler plus the
 *  optional gate knobs (same surface as `compileTokens`). */
export interface GetOrCompileOptions {
  readonly compileWat: CompileWat;
  readonly exportName?: string;
  readonly corpus?: CorpusOptions;
  readonly maxUlpF32?: number;
  /** Tuning for gate #3 (the acoustic probe + sane bounds). Defaults are generous —
   *  they catch genuine blowups, not legitimate effects. */
  readonly acoustic?: AcousticGateOptions;
}

/** The result of `getOrCompile`: an `accepted` carrying the characterized kernel +
 *  a `cached` flag (true ⇒ returned from the store without recompiling), the failure
 *  variants of `CompileResult` (rejection is a value), or `rejected-acoustic` — the
 *  cache-layer-only gate-#3 verdict (the equivalence layer never emits it). */
export type GetOrCompileResult =
  | { readonly status: "accepted"; readonly kernel: CharacterizedKernel; readonly cached: boolean }
  | { readonly status: "rejected-acoustic"; readonly profile: AcousticProfile; readonly reason: string }
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
   * kernel free — assert it by object identity); the attached acoustic profile is
   * returned without re-running gate #3. On a miss the stream runs the full
   * three-gate stack (syntax → equivalence → acoustic); a syntax/support/equivalence/
   * acoustic failure returns the matching failure variant and nothing is stored.
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

    // Gate #3 (acoustic): the equivalence gate proved SIMD ≡ the IR; profile the IR
    // reference over a deterministic probe and reject a runaway/non-finite kernel.
    // A rejected kernel is NOT stored (rejection is a value).
    const acoustic = acousticGate(ir, opts.acoustic);
    if (!acoustic.ok) {
      return { status: "rejected-acoustic", profile: acoustic.profile, reason: acoustic.reason };
    }

    const characterized: CharacterizedKernel = {
      hash,
      tokens: kernelToTokens(ir),
      signature: ir.signature,
      exportName: result.exportName,
      gate: result.gate,
      wasm: result.wasm,
      jsSource: emitJsKernel(ir),
      acoustic: acoustic.profile,
    };
    this.store.set(hash, characterized);
    return { status: "accepted", kernel: characterized, cached: false };
  }
}

function tokenDiagnostic(message: string): Diagnostic {
  return { code: "E_TOKENS", message, line: 0, col: 0 };
}
