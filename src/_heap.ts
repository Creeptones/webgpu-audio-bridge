/**
 * Heap-side typed-array + scratch-frame helpers (module-private utility).
 *
 * Extracted at 0.9.1 from four identical copies — one each on
 * `Bridge<S>`, `BridgeProducer<S>`, `BridgeConsumer<S>`, and
 * `BridgeInputLane<S>`. The duplication had grown by accident: every
 * facade that exposes a `scratchFrame()` method needs the same two
 * primitives, and the bodies were copy-pasted instead of shared. This
 * module is the single source of truth.
 *
 * Module-private by convention — not re-exported from `src/index.ts`,
 * so callers do not depend on the helper directly. The underscore
 * prefix mirrors the `_pullNoNotify` / `_notifyReadAdvance` convention
 * that flags "internal cross-module surface, may change without a
 * minor bump."
 *
 * ─── Wire compatibility ─────────────────────────────────────────────────
 *
 * Zero. The helpers produce bit-identical scratch objects to the
 * inlined versions they replace (same field-iteration order from
 * `schema.compiled.fields`, same per-kind constructor selection, same
 * scalar zero-initialization). `BridgeFacades.test.ts`'s
 * facade-vs-Bridge symmetry pin verifies this end-to-end.
 */

import {
  kindTsType,
  type CompiledField,
  type FieldKind,
} from "./schema.js";

/** Union of every typed-array view the schema DSL can produce as an
 *  `*Array(n)` field. Mirrors the 10 `FieldKind` values one-for-one. */
export type AnyTypedArray =
  | Float64Array
  | Float32Array
  | Uint32Array
  | Int32Array
  | Uint16Array
  | Int16Array
  | Uint8Array
  | Int8Array
  | BigInt64Array
  | BigUint64Array;

/** Allocate a fresh heap-side typed array of the given kind and length.
 *  Used by every facade's `scratchFrame()` factory + by
 *  `Bridge.scratchEvaluatedFrame()` for trajectory-array allocation. */
export function newHeapTypedArray(
  kind: FieldKind,
  length: number,
): AnyTypedArray {
  switch (kind) {
    case "u64": return new BigUint64Array(length);
    case "i64": return new BigInt64Array(length);
    case "f64": return new Float64Array(length);
    case "u32": return new Uint32Array(length);
    case "i32": return new Int32Array(length);
    case "f32": return new Float32Array(length);
    case "u16": return new Uint16Array(length);
    case "i16": return new Int16Array(length);
    case "u8":  return new Uint8Array(length);
    case "i8":  return new Int8Array(length);
  }
}

/** Build a reusable scratch frame from a schema's compiled-field list.
 *  Array fields get a fresh heap typed-array of the right kind +
 *  declared length; scalar fields are zero-initialized (`0n` for u64 /
 *  i64, `0` for everything else).
 *
 *  Returns a plain `Record` keyed by field name; callers cast to
 *  `FrameFor<S>` at the boundary. The cast is safe because the schema's
 *  type-level `FrameFor<S>` is derived from the same compiled fields the
 *  loop iterates. */
export function buildScratchFrame(
  fields: readonly CompiledField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.isArray) {
      out[field.name] = newHeapTypedArray(field.kind, field.length);
    } else {
      out[field.name] = kindTsType(field.kind) === "bigint" ? 0n : 0;
    }
  }
  return out;
}
