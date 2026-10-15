/**
 * The Autonomous JIT — internal barrel WITH the `acorn` JS parser registered.
 *
 * Since 0.9.946 the JIT's acorn-free surface lives in `./core.ts`; this file
 * adds the one side-effect import that registers `acorn.parse` (see
 * `acornParser.ts`) so `compileKernel(source)` works out of the box, exactly
 * as before the split.
 */

import "./acornParser.js";
export * from "./core.js";
