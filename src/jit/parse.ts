/**
 * JIT parser — the ONLY file that imports `acorn` (Apollo Frontier 5, Stage 1a).
 *
 * Dependency quarantine (locked decision 2): `acorn` is an optional peer used
 * only by the experimental JIT parser. It is reachable ONLY from here, and `src/jit/` is reachable ONLY
 * from the `webgpu-audio-bridge/experimental` subpath and the background compile
 * worker — NEVER from `src/index.ts` (the zero-runtime-dep core) and NEVER from
 * the audio hot path.
 *
 * This module is a thin wrapper: parse the source to an ESTree `Program` with
 * source locations (so `lower.ts` can attach precise `line`/`col` to a
 * rejection). All grammar enforcement lives in `lower.ts`; here we only turn a
 * string into an AST (or an `E_PARSE` rejection if it is not valid JavaScript).
 */

import { parse } from "acorn";
import { reject } from "./diagnostics.js";

/** ESTree nodes are structurally typed; the JIT walks them with a small set of
 *  field accesses. We keep the type loose on purpose (acorn returns its own
 *  node shape) and never trust a field without checking `.type` first. */
export type EsNode = Record<string, unknown> & { type: string; loc?: { start?: { line?: number; column?: number } } | null };

/** Parse a kernel source string to an ESTree Program. Throws `JitRejection`
 *  (E_PARSE) on a syntax error. */
export function parseProgram(source: string): EsNode {
  try {
    return parse(source, {
      ecmaVersion: 2022,
      sourceType: "module",
      locations: true,
    }) as unknown as EsNode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reject("E_PARSE", `source is not valid JavaScript: ${message}`);
  }
}
