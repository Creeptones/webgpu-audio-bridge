/**
 * The ONE file in the package that imports `acorn` (0.9.946 parser injection).
 *
 * A side-effect module: importing it registers `acorn.parse` as the JIT's
 * JS-source parser (see `parse.ts` → `registerJsParser`). It is imported by
 * `src/jit/index.ts` and the `webgpu-audio-bridge/experimental` barrel, so
 * those entry points behave exactly as before 0.9.946. The acorn-free
 * `webgpu-audio-bridge/experimental/core` subpath does NOT import it.
 */

import { parse } from "acorn";
import { registerJsParser, type JsParseFn } from "./parse.js";

registerJsParser(parse as unknown as JsParseFn);
