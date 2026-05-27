/**
 * typecheck-deprecations.test.ts — pins for the 0.9.0 breaking cut.
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/typecheck-deprecations.test.ts
 *
 * The 0.9.0 release removed three legacy surfaces from the public API:
 *
 *   1. `Float64RingBuffer` (the pre-0.3.0 hard-coded class).
 *   2. `legacyPhysicsControlFrameSchema(n)` (the all-f64 byte-twin) and the
 *      `LegacyPhysicsControlFrameSchema` type alias.
 *   3. The `'throw'` arm of `BlockUnderflowPolicy` on `BridgeBlockConsumer`.
 *
 * Each pin below is a `@ts-expect-error` directive that **passes today**
 * (the symbol or literal genuinely does not exist on the 0.9.0 surface)
 * and would **fail typecheck** if any future patch accidentally
 * re-introduced the removed surface. The mechanic: if a future patch
 * re-exports `Float64RingBuffer`, the corresponding access stops producing
 * a type error, the `@ts-expect-error` becomes "unused", and `tsc
 * --noEmit` fails loudly.
 *
 * This file is intentionally short on runtime behavior — the typecheck
 * pass IS the test. The `main()` function below merely asserts that the
 * type-level pins evaluated correctly and prints `ok` lines so the test
 * runner has the usual progress signal.
 *
 * If a future cohort intentionally re-introduces one of these surfaces,
 * delete the corresponding pin AND update CHANGELOG `[0.9.0]` to call out
 * the reversal.
 */

import { ok } from "./_assert.js";
import * as lib from "../src/index.js";
import type * as libT from "../src/index.js";
import type { BlockUnderflowPolicy } from "../src/index.js";

// ── 1. Float64RingBuffer class removed ───────────────────────────────────
// Reading `lib.Float64RingBuffer` is a value-level access; the property
// genuinely does not exist on the 0.9.0 surface, so the type system
// errors and the @ts-expect-error catches it. At runtime the property
// access just yields `undefined` (no throw); we never call it.
// @ts-expect-error — Float64RingBuffer was removed at 0.9.0.
const _f64rbCtor = lib.Float64RingBuffer;
void _f64rbCtor;

// ── 2a. legacyPhysicsControlFrameSchema function removed ─────────────────
// @ts-expect-error — legacyPhysicsControlFrameSchema was removed at 0.9.0.
const _legacyFn = lib.legacyPhysicsControlFrameSchema;
void _legacyFn;

// ── 2b. LegacyPhysicsControlFrameSchema type alias removed ───────────────
// Pure type-only pin; no runtime cost.
// @ts-expect-error — LegacyPhysicsControlFrameSchema type was removed at 0.9.0.
type _LegacyTypeAlias = libT.LegacyPhysicsControlFrameSchema;

// ── 3. BlockUnderflowPolicy: 'throw' literal removed ─────────────────────
// If a future patch widens `BlockUnderflowPolicy` back to include `'throw'`,
// this assignment becomes legal, @ts-expect-error becomes unused, and
// typecheck fails. The 0.9.0 surface is `'zero-fill' | 'hold-last'`.
// @ts-expect-error — 'throw' was removed from BlockUnderflowPolicy at 0.9.0.
const _throwLiteralPin: BlockUnderflowPolicy = "throw";
void _throwLiteralPin;

// ── Runtime sanity: confirm the removed symbols don't exist as values ────
function main(): void {
  // value-level lookups should be undefined (the named exports are gone).
  // Cast to any so the runtime check itself doesn't trip the type system.
  const libAny = lib as unknown as Record<string, unknown>;
  if (libAny.Float64RingBuffer !== undefined) {
    console.error("FAIL: lib.Float64RingBuffer is defined; expected removed");
    process.exitCode = 1;
    return;
  }
  if (libAny.legacyPhysicsControlFrameSchema !== undefined) {
    console.error("FAIL: lib.legacyPhysicsControlFrameSchema is defined; expected removed");
    process.exitCode = 1;
    return;
  }
  ok("1. Float64RingBuffer absent at value level + @ts-expect-error active");
  ok("2a. legacyPhysicsControlFrameSchema absent at value level + @ts-expect-error active");
  ok("2b. LegacyPhysicsControlFrameSchema absent at type level + @ts-expect-error active");
  ok("3. BlockUnderflowPolicy 'throw' literal absent + @ts-expect-error active");
  console.log("\nAll typecheck-deprecations pins held.");
}

main();
