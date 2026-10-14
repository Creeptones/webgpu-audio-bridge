/**
 * Deprecated root shims (0.9.945) for the four God-Node APIs that moved to
 * `webgpu-audio-bridge/experimental` in the unversioned commit `3de1ef5`.
 *
 * Removing them from the root without notice was a breaking public-API change,
 * which this project's versioning policy reserves for a minor bump. These
 * re-exports restore source compatibility for the 0.9.x line; each carries a
 * `@deprecated` tag so editors flag every use. They are scheduled for removal
 * at the next minor (0.10.0). New code should import from
 * `webgpu-audio-bridge/experimental` (or the acorn-free
 * `webgpu-audio-bridge/experimental/core`).
 *
 * The modules re-exported here are plain heap math / orchestration with no
 * experimental-only dependencies, so the root's zero-runtime-dep import graph
 * is unchanged.
 */

import { crossfadeWeight as _crossfadeWeight, crossfadeInto as _crossfadeInto } from "./crossfade.js";
import type {
  CrossfadeContinuity as _CrossfadeContinuity,
  CrossfadeMode as _CrossfadeMode,
  CrossfadeOptions as _CrossfadeOptions,
} from "./crossfade.js";
import { HotSwapConsumer as _HotSwapConsumer } from "./HotSwapConsumer.js";
import type {
  HotSwapPhase as _HotSwapPhase,
  HotSwapConsumerOptions as _HotSwapConsumerOptions,
  HotSwapPullResult as _HotSwapPullResult,
} from "./HotSwapConsumer.js";
import { migratePlan as _migratePlan } from "./migratePlan.js";
import type {
  MigratePlan as _MigratePlan,
  MigratePlanOptions as _MigratePlanOptions,
  MigrateBlend as _MigrateBlend,
  MigrateCrossfadeField as _MigrateCrossfadeField,
  MigrateRampInField as _MigrateRampInField,
  MigrateDropField as _MigrateDropField,
} from "./migratePlan.js";
import type { FieldsObject, Schema } from "./schema.js";

/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export const crossfadeWeight = _crossfadeWeight;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export const crossfadeInto = _crossfadeInto;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type CrossfadeContinuity = _CrossfadeContinuity;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type CrossfadeMode = _CrossfadeMode;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type CrossfadeOptions = _CrossfadeOptions;

/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export const HotSwapConsumer = _HotSwapConsumer;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HotSwapConsumer<S extends Schema<FieldsObject, any>> = _HotSwapConsumer<S>;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type HotSwapPhase = _HotSwapPhase;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type HotSwapConsumerOptions = _HotSwapConsumerOptions;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type HotSwapPullResult = _HotSwapPullResult;

/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export const migratePlan = _migratePlan;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type MigratePlan = _MigratePlan;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type MigratePlanOptions = _MigratePlanOptions;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type MigrateBlend = _MigrateBlend;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type MigrateCrossfadeField = _MigrateCrossfadeField;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type MigrateRampInField = _MigrateRampInField;
/** @deprecated Moved to `webgpu-audio-bridge/experimental` (root shim removed at 0.10.0). */
export type MigrateDropField = _MigrateDropField;
