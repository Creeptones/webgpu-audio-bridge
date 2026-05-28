/**
 * emitWorkletReader — schema-derived, zero-import worklet frame-reader codegen.
 *
 * Emits, as a SOURCE STRING, a monomorphized DataView/typed-array reader
 * specialized to one exact schema. The emitted function decodes a single ring
 * slot into a caller-supplied `out` object with every field byte-offset baked
 * in as a numeric literal — no runtime offset math, no `kindByteSize` call, no
 * library import on the audio thread.
 *
 *   reader(view: DataView, slot: number, out: Frame) => void
 *
 * Address formula (inlined per field at emit time):
 *
 *     b    = RING_HEADER_BYTES(32) + slot * frameByteSize
 *     addr = b + field.byteOffset + i * elemSize          // i = array index
 *
 * matching SpscRing's `RING_HEADER_BYTES + slot*frameByteSize + field.byteOffset`
 * (SpscRing.ts:683). The 32 and the per-field byteOffset/elemSize are folded
 * into the emitted string as literals so the worklet runs pure byte decode.
 *
 * ── Contracts / assumptions ────────────────────────────────────────────────
 *
 * • ZERO-IMPORT. The emitted string references only `DataView`, `BigInt`-free
 *   getter methods, and the three parameters. It imports nothing — paste it
 *   straight into a built AudioWorklet module. (The convenience `new Function`
 *   eval path in the tests is CSP-blocked under `script-src` without
 *   `unsafe-eval`; the emitted STRING is unaffected.)
 *
 * • LITTLE-ENDIAN. Multi-byte lanes are decoded with the DataView LE flag
 *   (`, true`) to match SpscRing's host-endian umbrella typed-array views.
 *   This is an emit-time assumption, NOT a runtime check — a big-endian host
 *   would silently mis-decode. Correct on every realistic WebAudio target.
 *   u8/i8 getters take NO endianness argument, so the LE flag is omitted for
 *   1-byte kinds (emitting it would be malformed / inconsistent).
 *
 * • MONOMORPHIZED. The reader is specialized to ONE frameByteSize/offset set.
 *   If the producer schema drifts, the reader silently mis-decodes — there is
 *   no runtime validation (zero-import precludes importing the schema). The
 *   emitted banner records `frameByteSize` + field count so a caller can
 *   fingerprint the generation against `describeLayout()`.
 *
 * • ALLOCATION-FREE — only if the caller pre-allocates `out` and its typed
 *   arrays (mirrors `Bridge.pull`'s `dst.set` contract). A fresh `{}` with no
 *   typed array throws on the first array write. Pass a `scratchFrame()`-shaped
 *   object.
 *
 * • PURE PEEK. The emitted reader decodes a slot by index without touching
 *   read_index — unlike `Bridge.pull`, which consumes the slot. Bit-exactness
 *   vs `Bridge.pull` is total (no rounding, no smoothing): the decode is the
 *   inverse of SpscRing's payload write.
 *
 * Regenerate-on-drift: this is a build-time codegen. Re-run whenever the
 * schema changes; never hand-edit the emitted output (the banner says so).
 */

import {
  kindByteSize,
  type FieldKind,
  type Schema,
  type FieldsObject,
  type TimestampsConfig,
  type SchemaLayoutDescription,
  type SchemaLayoutFieldDescription,
  describeSchemaLayout,
} from "./schema.js";

/** Accept either a compiled `Schema` (normalized via `describeSchemaLayout`)
 *  or an already-postMessaged `SchemaLayoutDescription`. The latter is the
 *  dependency-free input that actually crosses to the worklet. */
export type EmitWorkletReaderInput =
  | Schema<FieldsObject, TimestampsConfig<FieldsObject> | null>
  | SchemaLayoutDescription;

export interface EmitWorkletReaderOptions {
  /** Emitted function name. Default `"readFrame"`. */
  readonly functionName?: string;
  /** Name of the `DataView` parameter. Default `"view"`. */
  readonly viewParam?: string;
  /** Name of the slot-index parameter. Default `"slot"`. */
  readonly slotParam?: string;
  /** Name of the output-frame parameter. Default `"out"`. */
  readonly outParam?: string;
  /** When true, also emit a read of the hidden `__invariant: f64` lane into
   *  `out.__invariant` (only if the schema actually has one). Default false —
   *  the invariant lane is bridge-managed and excluded from `FrameFor<S>`. */
  readonly includeInvariant?: boolean;
  /** When true, emit only the function BODY (statements), not the wrapping
   *  `function name(...) { ... }`. Useful for splicing into an existing class
   *  method. Default false. */
  readonly bodyOnly?: boolean;
}

/** Per-kind DataView accessor method. Codegen-local: `kindTsType` only
 *  distinguishes bigint vs number, not the specific getter, so the table is
 *  built here. */
const DATAVIEW_GETTER: Record<FieldKind, string> = {
  f64: "getFloat64",
  f32: "getFloat32",
  u64: "getBigUint64",
  i64: "getBigInt64",
  u32: "getUint32",
  i32: "getInt32",
  u16: "getUint16",
  i16: "getInt16",
  u8: "getUint8",
  i8: "getInt8",
};

/** Discriminate the union: a `Schema` carries a `compiled` field; a
 *  `SchemaLayoutDescription` does not. Normalize to the postMessage-safe
 *  description so the rest of the emitter has one shape to consume. */
function normalizeLayout(input: EmitWorkletReaderInput): SchemaLayoutDescription {
  if ("compiled" in input) {
    return describeSchemaLayout(input);
  }
  return input;
}

/** Emit one scalar read: `out.<name> = view.<getter>(b + <off>, true);`.
 *  The LE flag is dropped for 1-byte kinds whose getters take no endianness
 *  argument (`getUint8`/`getInt8`). */
function emitScalarRead(
  name: string,
  kind: FieldKind,
  byteOffset: number,
  view: string,
  out: string,
): string {
  const getter = DATAVIEW_GETTER[kind];
  const le = kindByteSize(kind) === 1 ? "" : ", true";
  return `  ${out}.${name} = ${view}.${getter}(b + ${byteOffset}${le});`;
}

/** Emit one array read: a braced for-loop walking `length` elements at a
 *  folded `elemSize` stride. The destination typed array is hoisted to a local
 *  so the per-iteration write is a plain indexed store. */
function emitArrayRead(
  name: string,
  kind: FieldKind,
  byteOffset: number,
  length: number,
  view: string,
  out: string,
): string {
  const getter = DATAVIEW_GETTER[kind];
  const elemSize = kindByteSize(kind);
  const le = elemSize === 1 ? "" : ", true";
  const stride = elemSize === 1 ? "i" : `i * ${elemSize}`;
  return [
    `  {`,
    `    const a = ${out}.${name};`,
    `    for (let i = 0; i < ${length}; i++) {`,
    `      a[i] = ${view}.${getter}(b + ${byteOffset} + ${stride}${le});`,
    `    }`,
    `  }`,
  ].join("\n");
}

/**
 * Emit a zero-import, monomorphized DataView frame reader specialized to
 * `input`'s exact schema. Returns the reader as a SOURCE STRING.
 *
 * @param input  A compiled `Schema` (normalized internally) or a postMessage'd
 *               `SchemaLayoutDescription`.
 * @param opts   See `EmitWorkletReaderOptions`.
 * @returns      JavaScript source for `function <functionName>(view, slot, out)`
 *               (or just the body when `opts.bodyOnly`).
 */
export function emitWorkletReader(
  input: EmitWorkletReaderInput,
  opts: EmitWorkletReaderOptions = {},
): string {
  const desc = normalizeLayout(input);
  const fnName = opts.functionName ?? "readFrame";
  const view = opts.viewParam ?? "view";
  const slot = opts.slotParam ?? "slot";
  const out = opts.outParam ?? "out";
  const includeInvariant = opts.includeInvariant ?? false;
  const bodyOnly = opts.bodyOnly ?? false;

  const fieldNames = Object.keys(desc.fields);

  const lines: string[] = [];

  // Banner — fingerprint + DO-NOT-EDIT + endianness + monomorphization caveat.
  lines.push(
    `  // ── GENERATED by emitWorkletReader — DO NOT EDIT ──────────────`,
    `  // Monomorphized to: frameByteSize=${desc.frameByteSize}, ` +
      `${fieldNames.length} field(s), headerBytes=${desc.headerBytes}.`,
    `  // Little-endian (matches SpscRing host-endian umbrella views).`,
    `  // Schema drift silently mis-decodes — regenerate on layout change.`,
    `  const b = ${desc.headerBytes} + ${slot} * ${desc.frameByteSize};`,
  );

  // Fields in insertion order (matches compileLayout's field order).
  for (const name of fieldNames) {
    const field: SchemaLayoutFieldDescription = desc.fields[name]!;
    if (field.length !== undefined) {
      // Array-ness inferred from `length` presence (scalars omit it).
      lines.push(
        emitArrayRead(name, field.kind, field.byteOffset, field.length, view, out),
      );
    } else {
      lines.push(emitScalarRead(name, field.kind, field.byteOffset, view, out));
    }
  }

  // Hidden invariant lane — opt-in only, and only if the schema has one.
  if (includeInvariant && desc.invariantByteOffset !== null) {
    lines.push(
      `  // hidden __invariant: f64 lane (opt-in)`,
      emitScalarRead("__invariant", "f64", desc.invariantByteOffset, view, out),
    );
  }

  const body = lines.join("\n");
  if (bodyOnly) {
    return body;
  }
  return `function ${fnName}(${view}, ${slot}, ${out}) {\n${body}\n}`;
}
