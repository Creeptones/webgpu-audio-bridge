/**
 * webgpu-audio-bridge / experimental — opt-in entry point for APIs that
 * sit OUTSIDE the project's 1.0 stability contract.
 *
 * The shapes exported here may break across MINOR version bumps as the
 * underlying browser specs (WebNN as of 0.7.16; future entries as they
 * land) stabilize. Patch bumps within a minor preserve compatibility.
 *
 * Import path is the `webgpu-audio-bridge/experimental` subpath:
 *
 *   import { BridgeWebNNSource } from "webgpu-audio-bridge/experimental";
 *
 * Production code that wants pre-construction capability checks should
 * use `getEnvironmentReport()` from the main entry point (the 0.7.17
 * patch adds `webnn` + `mlTensor` capability flags) — that report-
 * shape API is stable; the helpers under this subpath are not.
 */

export { BridgeWebNNSource } from "./BridgeWebNNSource.js";
export type {
  BridgeWebNNSourceOptions,
  MLTensorLike,
  WebNNTensorReader,
} from "./BridgeWebNNSource.js";
