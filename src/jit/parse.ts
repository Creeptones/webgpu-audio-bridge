/**
 * JIT parser front-end (Apollo Frontier 5, Stage 1a; parser injection 0.9.946).
 *
 * Dependency quarantine (locked decision 2): `acorn` is an optional peer used
 * only by the experimental JIT's JS-SOURCE path. Since 0.9.946 this file no
 * longer imports `acorn` itself — the parser is INJECTED via
 * `registerJsParser(parse)`. The one file that imports `acorn` is
 * `acornParser.ts`, a side-effect module that registers it; it is reached ONLY
 * from the `webgpu-audio-bridge/experimental` barrel (and `src/jit/index.ts`),
 * NEVER from `src/index.ts`, NEVER from `webgpu-audio-bridge/experimental/core`,
 * and NEVER from the audio hot path. That split is what lets a fan-ring /
 * hot-swap / token-path consumer import the experimental surface (including
 * inside an AudioWorklet or a no-bundler module worker) without `acorn`.
 *
 * This module is a thin wrapper: parse the source to an ESTree `Program` with
 * source locations (so `lower.ts` can attach precise `line`/`col` to a
 * rejection). All grammar enforcement lives in `lower.ts`; here we only turn a
 * string into an AST (or an `E_PARSE` rejection if it is not valid JavaScript,
 * or if no parser has been registered).
 */

import { reject } from "./diagnostics.js";

/** The subset of `acorn.parse`'s signature the JIT uses. `acorn.parse` itself
 *  satisfies it, so `registerJsParser(acorn.parse)` type-checks without this
 *  module depending on acorn's types. */
export type JsParseFn = (
  source: string,
  options: { ecmaVersion: 2022; sourceType: "module"; locations: true },
) => unknown;

let jsParser: JsParseFn | null = null;

/** Register the ESTree parser used by the JS-source JIT path (`compileKernel`,
 *  `lowerKernel(parseProgram(...))`, `connectJit({ kernel })`). The
 *  `webgpu-audio-bridge/experimental` barrel registers `acorn.parse`
 *  automatically; consumers of the acorn-free
 *  `webgpu-audio-bridge/experimental/core` subpath call this once if they
 *  need the JS-source path. Idempotent; the last registration wins. */
export function registerJsParser(parse: JsParseFn): void {
  jsParser = parse;
}

/** True once a JS parser has been registered (see `registerJsParser`). */
export function hasJsParser(): boolean {
  return jsParser !== null;
}

/** ESTree nodes are structurally typed; the JIT walks them with a small set of
 *  field accesses. We keep the type loose on purpose (acorn returns its own
 *  node shape) and never trust a field without checking `.type` first. */
export type EsNode = Record<string, unknown> & { type: string; loc?: { start?: { line?: number; column?: number } } | null };

/** Parse a kernel source string to an ESTree Program. Throws `JitRejection`
 *  (E_PARSE) on a syntax error. */
export function parseProgram(source: string): EsNode {
  if (jsParser === null) {
    reject(
      "E_PARSE",
      "JS-source kernels need a JavaScript parser: import from \"webgpu-audio-bridge/experimental\" " +
        "(registers the optional `acorn` peer), or call registerJsParser(acorn.parse) when using " +
        "\"webgpu-audio-bridge/experimental/core\". The token path (compileTokens / connectJit({ tokens })) needs no parser.",
    );
  }
  try {
    return jsParser(source, {
      ecmaVersion: 2022,
      sourceType: "module",
      locations: true,
    }) as unknown as EsNode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reject("E_PARSE", `source is not valid JavaScript: ${message}`);
  }
}
