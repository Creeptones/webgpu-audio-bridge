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
 * The cache is symmetric: it memoizes REJECTIONS too (the negative cache). A repeated
 * bad token stream returns its prior verdict with `cached: true` instead of re-running
 * the gates — killing the reroll waste of a generative emitter (and the read the
 * Stage-3 SLM's reward loop wants: "I already tried this and it failed, skip"). Two
 * memos, because the gates fail at two different addressabilities:
 *   • a SYNTAX reject (`rejected-source`) has no IR, so it is keyed by the flat
 *     token-stream text (`tokensToString`) — the only stable pre-validation key;
 *   • a BODY reject (`unsupported` / `rejected-gate` / `rejected-acoustic`) has a
 *     validated IR, so it is keyed by `kernelHash` — the SAME content address as the
 *     positive store. The two can never collide on a key (a body reject implies a
 *     valid IR; a syntax reject has none) and a hash can never be both rejected and
 *     accepted (the gates are deterministic), so the negative cache cannot shadow a
 *     later accept. EVERY result carries a `cached` flag (true ⇒ returned from a memo).
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
  validateTokens, kernelHash, kernelToTokens, tokensToString, type KernelToken,
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

/** A rejection verdict (sans the `cached` flag): every non-accepted outcome of
 *  `getOrCompile` — the failure variants of `CompileResult` (`rejected-source` /
 *  `rejected-gate` / `unsupported`) plus `rejected-acoustic`, the cache-layer-only
 *  gate-#3 verdict (the equivalence layer never emits it). This is the shape the
 *  negative cache memoizes. */
export type RejectVerdict =
  | { readonly status: "rejected-acoustic"; readonly profile: AcousticProfile; readonly reason: string }
  | Exclude<CompileResult, { readonly status: "accepted" }>;

/** The result of `getOrCompile`: an `accepted` carrying the characterized kernel, or
 *  a `RejectVerdict` (rejection is a value). EVERY variant carries a `cached` flag —
 *  true ⇒ returned from a memo (the positive store for an accept, the negative cache
 *  for a reject) without re-running the gates. */
export type GetOrCompileResult =
  | { readonly status: "accepted"; readonly kernel: CharacterizedKernel; readonly cached: boolean }
  | (RejectVerdict & { readonly cached: boolean });

/**
 * A content-addressed store of characterized kernels. Hit → instant return; miss →
 * gate-verify + characterize + store. The store is a plain `Map<hash, …>`; no
 * eviction in Stage 1 (the kernel population is small + hand/SLM-curated).
 */
export class KernelCache {
  private readonly store = new Map<string, CharacterizedKernel>();
  /** Negative cache, SYNTAX rejects (no IR) — keyed by the flat token-stream text. */
  private readonly rejectsByStream = new Map<string, RejectVerdict>();
  /** Negative cache, BODY rejects (valid IR; failed gate #2/#3 or unsupported) —
   *  keyed by `kernelHash`, the same content address as the positive store. */
  private readonly rejectsByHash = new Map<string, RejectVerdict>();

  /** Number of distinct characterized (accepted) kernels held. */
  get size(): number {
    return this.store.size;
  }

  /** Number of distinct memoized rejections (across both negative-cache maps). */
  get rejectedSize(): number {
    return this.rejectsByStream.size + this.rejectsByHash.size;
  }

  /** True iff a kernel with this content address is already characterized. */
  has(hash: string): boolean {
    return this.store.has(hash);
  }

  /** The characterized kernel for a content address, or undefined. */
  get(hash: string): CharacterizedKernel | undefined {
    return this.store.get(hash);
  }

  /** Drop every entry — both the positive store and the negative cache. */
  clear(): void {
    this.store.clear();
    this.rejectsByStream.clear();
    this.rejectsByHash.clear();
  }

  /**
   * Look up (or, on a miss, compile + characterize + store) the kernel for a token
   * stream. On a HIT the SAME `CharacterizedKernel` object is returned with
   * `cached: true` and NO recompile happens (the property that makes a repeated
   * kernel free — assert it by object identity); the attached acoustic profile is
   * returned without re-running gate #3. On a miss the stream runs the full
   * three-gate stack (syntax → equivalence → acoustic); a syntax/support/equivalence/
   * acoustic failure returns the matching failure variant and nothing is stored in
   * the POSITIVE store.
   *
   * Rejections are memoized too (the negative cache): a repeated bad stream returns
   * its prior verdict with `cached: true` without re-running the gates. A syntax
   * reject is memoized by the token-stream text; a body reject (unsupported / gate /
   * acoustic) by `kernelHash`. The positive store is checked before the body-reject
   * memo, but the two are mutually exclusive on a key by construction (a deterministic
   * gate gives one verdict per content address), so order is for clarity, not
   * correctness.
   */
  getOrCompile(tokens: ReadonlyArray<KernelToken>, opts: GetOrCompileOptions): GetOrCompileResult {
    // Negative cache, syntax layer: a malformed stream has no IR, so its only stable
    // key is the flat text. Check it BEFORE `validateTokens` so a repeat skips even
    // the re-validation.
    const streamKey = tokensToString(tokens);
    const memoSyntax = this.rejectsByStream.get(streamKey);
    if (memoSyntax) return { ...memoSyntax, cached: true };

    const v = validateTokens(tokens);
    if (!v.ok) {
      const message = v.at !== undefined ? `${v.error} (at token ${v.at})` : v.error;
      const verdict: RejectVerdict = { status: "rejected-source", diagnostic: tokenDiagnostic(message) };
      this.rejectsByStream.set(streamKey, verdict);
      return { ...verdict, cached: false };
    }

    const ir: IrKernel = v.ir;
    const hash = kernelHash(ir);
    const hit = this.store.get(hash);
    if (hit) return { status: "accepted", kernel: hit, cached: true };

    // Negative cache, body layer: a valid-IR stream that already failed gate #2/#3 or
    // is unsupported — skip the (expensive) recompile.
    const memoBody = this.rejectsByHash.get(hash);
    if (memoBody) return { ...memoBody, cached: true };

    const result = compileIr(ir, {
      compileWat: opts.compileWat,
      exportName: opts.exportName,
      corpus: opts.corpus,
      maxUlpF32: opts.maxUlpF32,
    });
    if (result.status !== "accepted") {
      this.rejectsByHash.set(hash, result);
      return { ...result, cached: false };
    }

    // Gate #3 (acoustic): the equivalence gate proved SIMD ≡ the IR; profile the IR
    // reference over a deterministic probe and reject a runaway/non-finite kernel.
    // A rejected kernel is NOT stored as accepted — it is memoized as a body reject.
    const acoustic = acousticGate(ir, opts.acoustic);
    if (!acoustic.ok) {
      const verdict: RejectVerdict = { status: "rejected-acoustic", profile: acoustic.profile, reason: acoustic.reason };
      this.rejectsByHash.set(hash, verdict);
      return { ...verdict, cached: false };
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
