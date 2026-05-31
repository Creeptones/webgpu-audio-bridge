/**
 * JIT diagnostics — the closed set of rejection codes (Apollo Frontier 5, Stage 1a).
 *
 * The validator (`lower.ts`) returns the FIRST out-of-subset construct as a
 * `Diagnostic` carrying a stable `code`, a human message, and the acorn source
 * `line`/`col`. There is NO fallthrough that compiles an unrecognized node — a
 * program outside the sub-language is REJECTED, never silently mis-compiled
 * (the silent-mis-compile guard the Stage-0 probe's SCENARIO C pins).
 *
 * The Frontier-5 codes mirror `docs/frontier5-jit-semantics.md` §3 one-for-one.
 * Each is exercised by a pin in `tests/JitCompiler.test.ts` and by the in-CI
 * fuzzer's reject half (`tests/JitCompiler.interleaving.test.ts`). The Frontier-6
 * addition `E_TOKENS` (the kernel-grammar syntax-gate bridge) is pinned in
 * `tests/compileTokens.test.ts`.
 */

export type DiagnosticCode =
  | "E_BRANCH"            // if / ?: / && / || / switch — data-dependent control flow
  | "E_LOOP_CARRY"        // accumulator / out[i-1] / cross-iteration read
  | "E_CONTROL"           // nested loop / while / do / break / continue / return-in-loop
  | "E_CALL"              // recursion / non-whitelist call / method call / closure
  | "E_DYNAMIC"           // new / literal object|array / dynamic (non-affine) index / member access
  | "E_REASSIGN"          // assign to a bound name / ++ / -- / compound assign / var
  | "E_OP"                // bitwise / % / comparison / logical-not
  | "E_MIXED_WIDTH"       // f32 ⊙ f64 without an explicit Math.fround boundary
  | "E_STRIDE"            // affine slope ∉ {1,2}, non-const slope/intercept, negative intercept
  | "E_USE_BEFORE_DEF"    // an SSA temp read before it is bound in this iteration
  | "E_NONFINITE_LITERAL" // NaN / Infinity / non-finite literal baked into the source
  | "E_SHAPE"             // not one counted for(let i=0;i<bound;i++){…}; signature/body mismatch
  | "E_TRANSCENDENTAL"    // Math.sin/cos/tan/exp/log/pow/atan2/… — no SIMD intrinsic, no exact lowering
  | "E_PARSE"             // acorn failed to parse the source as JavaScript
  | "E_TOKENS";           // kernel-grammar token stream failed the SYNTAX gate (validateTokens); Frontier 6 Stage 1

/** A precise, machine-stable rejection. `line`/`col` are 1-based acorn locations
 *  (0 when the offending construct has no source location, e.g. a signature
 *  mismatch). `node` names the offending AST node kind for debugging. */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly line: number;
  readonly col: number;
  readonly node?: string;
}

/** Thrown internally by `lower.ts` to unwind to the nearest `Result` boundary.
 *  Never escapes the JIT subsystem — `compileKernel` catches it and turns it
 *  into a `{ status: "rejected-source" }` result (rejection is a value, not an
 *  exception, at the public boundary). */
export class JitRejection extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message} (${diagnostic.line}:${diagnostic.col})`);
    this.name = "JitRejection";
  }
}

/** Build a Diagnostic from an acorn-located node (any object that may carry a
 *  `loc: { start: { line, column } }`). */
export function makeDiagnostic(
  code: DiagnosticCode,
  message: string,
  node?: { loc?: { start?: { line?: number; column?: number } } | null; type?: string },
): Diagnostic {
  const start = node?.loc?.start;
  return {
    code,
    message,
    line: start?.line ?? 0,
    // acorn columns are 0-based; present as 1-based to match editors.
    col: start?.column != null ? start.column + 1 : 0,
    node: node?.type,
  };
}

/** Reject: build the diagnostic and throw the unwinding error. */
export function reject(
  code: DiagnosticCode,
  message: string,
  node?: { loc?: { start?: { line?: number; column?: number } } | null; type?: string },
): never {
  throw new JitRejection(makeDiagnostic(code, message, node));
}
