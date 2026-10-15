/**
 * webgpu-audio-bridge / experimental — opt-in entry point for APIs that
 * sit OUTSIDE the project's 1.0 stability contract.
 *
 * The full surface lives in `./core.ts` (also published as the acorn-free
 * `webgpu-audio-bridge/experimental/core` subpath, 0.9.946). This barrel adds
 * one side-effect import that registers the optional `acorn` peer as the JIT's
 * JS-source parser, so `compileKernel(source)` / `connectJit({ kernel })`
 * keep working unchanged from this path.
 *
 * If you do NOT compile JS-source kernels — fan rings, `connectGraph`,
 * hot-swap, WebNN, the token-path JIT, anything inside an AudioWorklet or a
 * no-bundler module worker — import from `webgpu-audio-bridge/experimental/core`
 * instead and `acorn` is never loaded.
 */

import "../jit/acornParser.js";
export * from "./core.js";
