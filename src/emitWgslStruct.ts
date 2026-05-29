/**
 * emitWgslStruct — schema-derived WGSL struct generator.
 *
 * Emits, as a SOURCE STRING, a WGSL `struct` definition whose memory layout is
 * byte-for-byte identical to the SAB frame that `Bridge` reads/writes for the
 * same `Schema`. Makes the TS `Schema` the single source of truth for the
 * GPU-side struct, eliminating the "alignment trap": hand-writing a WGSL struct
 * that silently drifts from the TS layout by a padding byte, after which the
 * AudioWorklet decodes plausible garbage and never crashes.
 *
 *   struct <StructName> { ...members... };
 *
 * ── Why the layout is isomorphic (the load-bearing invariant) ──────────────
 *
 * `compileLayout` (schema.ts) sorts fields by DESCENDING alignment class
 * (8 → 4 → 2 → 1), packs them densely, and asserts every field's byteOffset is
 * a multiple of its element size. Once sub-32-bit kinds are rejected (see
 * below), the surviving kinds are exactly WGSL's host-shareable 32-/64-bit
 * scalars, whose AlignOf/SizeOf match `kindByteSize` one-for-one. A struct
 * whose members are emitted in that same compiled order therefore has the SAME
 * natural WGSL member offsets as the schema's byteOffsets — no per-member
 * `@align`/`@size` overrides needed. `computeWgslLayout` re-derives those
 * offsets from WGSL rules so a test can assert `member.offset === byteOffset`
 * and `structSize === frameByteSize` arithmetically (no naga/tint needed).
 *
 * ── Contracts / constraints ────────────────────────────────────────────────
 *
 * • SUB-32-BIT REJECTED. WGSL storage buffers have no native u8/i8/u16/i16
 *   (absent the unassumable `16bit` extension). The emitter fail-fasts with
 *   `WgslUnsupportedKindError` rather than emit invalid shader code. Bridged
 *   WGSL schemas must be composed strictly of 32-bit and 64-bit kinds.
 *
 * • 64-BIT IS BYTE TRANSPORT. WGSL has no concrete 64-bit scalar, so f64/u64/
 *   i64 map to `vec2<u32>` (align/size 8) — the GPU moves the 8 bytes losslessly
 *   and the TS reader decodes them. NOT native 64-bit arithmetic on the GPU.
 *
 * • TRAILING PADDING IS FORCED. An all-32-bit schema rounds its WGSL struct
 *   size to 4, but the schema pads frames to 8 (`userEnd = (offset+7) & ~7`).
 *   A trailing `_wab_pad: array<u32, k>` member stretches the struct to the
 *   schema's exact `frameByteSize` so `array<Struct>` element stride matches the
 *   SAB slot stride. The same pad covers the hidden invariant lane when the
 *   schema has one and `includeInvariant` is false.
 *
 * • INVARIANT LANE IS OPT-IN. The hidden `__invariant: f64` lane is bridge-
 *   managed (computed on push, verified on pull); the producing shader should
 *   not write it. By default it is folded into `_wab_pad`; pass
 *   `includeInvariant` to expose it as a named `vec2<u32>` member.
 *
 * Regenerate-on-drift: this is a build-time codegen. Re-run whenever the schema
 * changes; never hand-edit the emitted output (the banner says so).
 */

import {
  type FieldKind,
  type Schema,
  type FieldsObject,
  type TimestampsConfig,
  type SchemaLayoutDescription,
  type SchemaLayoutFieldDescription,
  describeSchemaLayout,
} from "./schema.js";

/** Accept either a compiled `Schema` (normalized via `describeSchemaLayout`)
 *  or an already-postMessaged `SchemaLayoutDescription` — same input shape as
 *  `emitWorkletReader`. */
export type EmitWgslStructInput =
  | Schema<FieldsObject, TimestampsConfig<FieldsObject> | null>
  | SchemaLayoutDescription;

export interface EmitWgslStructOptions {
  /** Emitted struct name. Default `"BridgeFrame"`. */
  readonly structName?: string;
  /** When true, emit `fn <Struct>_set_<field>(...)` tuple-writer helpers for
   *  f32 trajectory fields (interleaved [p, v, [a]] writes). Default true. */
  readonly includeHelpers?: boolean;
  /** When true, expose the hidden `__invariant: f64` lane as a named
   *  `vec2<u32>` member instead of folding it into the trailing pad. Default
   *  false — the lane is bridge-managed and the shader should not write it. */
  readonly includeInvariant?: boolean;
  /** Mapping strategy for 64-bit kinds. Only `"vec2u32"` ships today; reserved
   *  so a future `f64`-extension path can opt in without a breaking change. */
  readonly mode64?: "vec2u32";
}

/** Thrown when a schema contains a kind WGSL storage buffers cannot represent
 *  natively (u8/i8/u16/i16). */
export class WgslUnsupportedKindError extends Error {
  readonly fieldName: string;
  readonly kind: FieldKind;
  constructor(fieldName: string, kind: FieldKind) {
    super(
      `emitWgslStruct: field '${fieldName}' has kind '${kind}', which WGSL ` +
        `storage buffers cannot represent natively (no 8-/16-bit scalars ` +
        `without the unassumable 16bit extension). Bridged WGSL schemas must ` +
        `use only 32-bit (f32/u32/i32) and 64-bit (f64/u64/i64 → vec2<u32>) ` +
        `kinds.`,
    );
    this.name = "WgslUnsupportedKindError";
    this.fieldName = fieldName;
    this.kind = kind;
  }
}

/** One emitted WGSL struct member with its WGSL-rule-derived layout. */
export interface WgslMember {
  readonly name: string;
  /** Rendered WGSL type, e.g. `f32`, `vec2<u32>`, `array<f32, 64>`. */
  readonly wgslType: string;
  readonly align: number;
  readonly size: number;
  readonly offset: number;
  /** True for the synthetic trailing `_wab_pad` member. */
  readonly isPad: boolean;
}

/** Structured WGSL layout — the testable spine `emitWgslStruct` renders. */
export interface WgslLayout {
  readonly members: ReadonlyArray<WgslMember>;
  readonly structAlign: number;
  readonly structSize: number;
}

/** WGSL host-shareable type + align/size for one schema element kind.
 *  Throws `WgslUnsupportedKindError` for sub-32-bit kinds. */
function wgslElem(
  fieldName: string,
  kind: FieldKind,
): { type: string; align: number; size: number } {
  switch (kind) {
    case "f32":
      return { type: "f32", align: 4, size: 4 };
    case "u32":
      return { type: "u32", align: 4, size: 4 };
    case "i32":
      return { type: "i32", align: 4, size: 4 };
    // 64-bit kinds are byte-transported as vec2<u32> (align/size 8).
    case "f64":
    case "u64":
    case "i64":
      return { type: "vec2<u32>", align: 8, size: 8 };
    case "u8":
    case "i8":
    case "u16":
    case "i16":
      throw new WgslUnsupportedKindError(fieldName, kind);
  }
}

/** Discriminate the union: a `Schema` carries a `compiled` field; a
 *  `SchemaLayoutDescription` does not. Normalize to the postMessage-safe
 *  description so the rest of the emitter has one shape to consume. */
function normalizeLayout(input: EmitWgslStructInput): SchemaLayoutDescription {
  if ("compiled" in input) {
    return describeSchemaLayout(input);
  }
  return input;
}

const roundUp = (n: number, align: number): number =>
  (n + (align - 1)) & ~(align - 1);

/**
 * Derive the WGSL struct layout from a normalized schema description using
 * WGSL alignment rules. The member offsets it computes are asserted (by tests)
 * to equal the schema's `byteOffset`s, and `structSize` to equal
 * `frameByteSize` — that equality IS the alignment-trap guarantee.
 */
export function computeWgslLayout(
  input: EmitWgslStructInput,
  opts: EmitWgslStructOptions = {},
): WgslLayout {
  const desc = normalizeLayout(input);
  const includeInvariant = opts.includeInvariant ?? false;
  const members: WgslMember[] = [];
  let offset = 0;
  let structAlign = 4; // WGSL struct alignment is at least its largest member.

  for (const name of Object.keys(desc.fields)) {
    const field: SchemaLayoutFieldDescription = desc.fields[name]!;
    const elem = wgslElem(name, field.kind);
    const isArray = field.length !== undefined;
    const align = elem.align;
    // Element stride = roundUp(SizeOf, AlignOf); for our kinds size === align,
    // so the stride is just elem.size and the array size is size * length.
    const size = isArray ? elem.size * field.length! : elem.size;
    const wgslType = isArray ? `array<${elem.type}, ${field.length!}>` : elem.type;
    offset = roundUp(offset, align);
    members.push({ name, wgslType, align, size, offset, isPad: false });
    offset += size;
    if (align > structAlign) structAlign = align;
  }

  // Hidden invariant lane (f64 → vec2<u32>, align 8). Either expose it as a
  // named member or let the trailing pad below cover its 8 bytes.
  if (includeInvariant && desc.invariantByteOffset !== null) {
    offset = roundUp(offset, 8);
    members.push({
      name: "__invariant",
      wgslType: "vec2<u32>",
      align: 8,
      size: 8,
      offset,
      isPad: false,
    });
    offset += 8;
    if (structAlign < 8) structAlign = 8;
  }

  // Force the struct size to the schema's exact frameByteSize. The gap is
  // always a multiple of 4 (every field size is), so a u32 array closes it
  // without needing an @size override. Covers both the all-32-bit 8-byte
  // frame padding and an un-exposed invariant lane.
  const gap = desc.frameByteSize - offset;
  if (gap > 0) {
    members.push({
      name: "_wab_pad",
      wgslType: `array<u32, ${gap / 4}>`,
      align: 4,
      size: gap,
      offset,
      isPad: true,
    });
    offset += gap;
  }

  return Object.freeze({
    members: Object.freeze(members) as ReadonlyArray<WgslMember>,
    structAlign,
    structSize: offset,
  });
}

/** Emit the `fn <Struct>_set_<field>(...)` tuple writer for one f32 trajectory
 *  field (interleaved [p, v, [a]] layout, matching schema.ts trajectory order). */
function emitTrajectoryHelper(
  structName: string,
  fieldName: string,
  order: number,
): string {
  const comps = ["p", "v", "a"].slice(0, order);
  const params = comps.map((c) => `${c}: f32`).join(", ");
  const base = order === 1 ? "idx" : `idx * ${order}u`;
  const lines = [
    `fn ${structName}_set_${fieldName}(state: ptr<function, ${structName}>, idx: u32, ${params}) {`,
  ];
  comps.forEach((c, i) => {
    const idx = i === 0 ? base : `${base} + ${i}u`;
    lines.push(`  (*state).${fieldName}[${idx}] = ${c};`);
  });
  lines.push(`}`);
  return lines.join("\n");
}

/**
 * Emit a WGSL `struct` whose layout is byte-isomorphic to the SAB frame for
 * `input`'s schema. Returns the struct (and optional trajectory helpers) as a
 * SOURCE STRING ready to paste/interpolate into a compute shader.
 *
 * @param input  A compiled `Schema` (normalized internally) or a postMessage'd
 *               `SchemaLayoutDescription`.
 * @param opts   See `EmitWgslStructOptions`.
 * @throws       `WgslUnsupportedKindError` if any field uses a sub-32-bit kind.
 */
export function emitWgslStruct(
  input: EmitWgslStructInput,
  opts: EmitWgslStructOptions = {},
): string {
  const desc = normalizeLayout(input);
  const structName = opts.structName ?? "BridgeFrame";
  const includeHelpers = opts.includeHelpers ?? true;
  const layout = computeWgslLayout(input, opts);

  const fieldCount = Object.keys(desc.fields).length;
  const lines: string[] = [];

  // Banner — fingerprint + DO-NOT-EDIT, mirroring emitWorkletReader's banner.
  lines.push(
    `// ── GENERATED by emitWgslStruct — DO NOT EDIT ──────────────`,
    `// Monomorphized to: frameByteSize=${desc.frameByteSize}, ${fieldCount} field(s).`,
    `// Byte-isomorphic to the TS Schema SAB frame (descending-align packing).`,
    `// 64-bit kinds (f64/u64/i64) are byte-transported as vec2<u32>.`,
    `// Schema drift silently mis-decodes on the GPU — regenerate on layout change.`,
    `struct ${structName} {`,
  );

  for (const m of layout.members) {
    const note = m.isPad
      ? `  // pad to frameByteSize (${desc.frameByteSize}) — keeps array<${structName}> stride exact`
      : "";
    lines.push(`  ${m.name}: ${m.wgslType},${note}`);
  }
  lines.push(`};`);

  // Trajectory tuple-writer helpers (f32 trajectory fields only — f64
  // trajectories are vec2<u32> byte transport and cannot take f32 tuples).
  if (includeHelpers) {
    const helpers: string[] = [];
    for (const name of Object.keys(desc.fields)) {
      const field = desc.fields[name]!;
      if (field.trajectory && field.kind === "f32") {
        helpers.push(emitTrajectoryHelper(structName, name, field.trajectory.order));
      }
    }
    if (helpers.length > 0) {
      lines.push(``, `// ── Trajectory tuple writers ──────────────────────────────`);
      lines.push(...helpers);
    }
  }

  return lines.join("\n");
}
