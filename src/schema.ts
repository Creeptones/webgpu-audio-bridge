/**
 * Schema DSL — describes the byte layout of a single frame in a Bridge ring.
 *
 * A schema is built from named field constructors:
 *
 *   const s = defineSchema({
 *     seq:  u64(),
 *     tNs:  u64(),
 *     vMax: f64(),
 *     vEff: f64Array(64),
 *   });
 *
 * Each field has a kind (one of f64/f32/u64/i64/u32/i32/u16/i16/u8/i8) and an
 * optional `length` (omitted = scalar; positive integer = fixed-length array).
 *
 * `defineSchema` validates the field set, computes a packed layout grouped by
 * alignment class (8-aligned types first, then 4-, then 2-, then 1-aligned),
 * and returns a frozen Schema<F> that the Bridge class consumes. Alignment
 * grouping is required because SAB-backed typed-array constructors
 * (`new Float32Array(sab, byteOffset, length)`) throw if `byteOffset` is not
 * aligned to the element size. Sorting by alignment class lets us pack tightly
 * without padding between fields of the same class.
 *
 * The frame size is padded to 8 bytes so the next ring slot starts 8-aligned
 * (the f64/u64/i64 umbrella view of the SAB requires it; the ring header is
 * already 32 bytes = 8-aligned, so slot 0 starts aligned too).
 *
 * Field-level TypeScript inference is driven by the phantom `_t?: T` slot on
 * `FieldSpec<T>`. Each constructor returns `FieldSpec<T>` for the concrete TS
 * type that field carries on a frame (e.g. `u64()` returns `FieldSpec<bigint>`,
 * `f64Array(n)` returns `FieldSpec<Float64Array>`). The `FrameFor<S>` mapped
 * type extracts those `T`s into the shape `Bridge.push`/`pull` accept.
 *
 * ─── Schema invariants (0.6.0) ─────────────────────────────────────────────
 *
 * `defineSchema(...).withInvariant(fn)` builds a new schema with a hidden
 * `__invariant: f64` lane appended at the end of each frame slot. The Bridge
 * auto-computes the invariant on push (caller-supplied fn) and verifies on
 * pull; mismatches are classified as soft (smoother recovery) or hard
 * (last-known-good fallback + lane-3 tornFrameCounter increment). See the
 * `Schema invariants` section of `src/Bridge.ts` for the runtime protocol
 * and recovery thresholds.
 *
 * The invariant fn must be O(payload size), allocation-free, and pure (same
 * input → same output bit-exactly). Sum-of-squares is the canonical choice
 * for f64-dominant schemas; xxhash / CRC32 work for byte-oriented payloads.
 * BigInt and integer fields can be coerced into the sum or run through a
 * separate accumulator — the bridge doesn't constrain the choice.
 *
 * Type erasure: schemas with and without invariants share the `Schema<F>`
 * type. `FrameFor<S>` does NOT include the hidden `__invariant` field — it's
 * bridge-managed, never exposed to user-side reads/writes.
 */

export type FieldKind =
  | "u64" | "i64"
  | "u32" | "i32"
  | "u16" | "i16"
  | "u8"  | "i8"
  | "f64" | "f32";

/** Byte size of one element of `kind`. Exhaustive over FieldKind. */
export function kindByteSize(kind: FieldKind): number {
  switch (kind) {
    case "u64": case "i64": case "f64": return 8;
    case "u32": case "i32": case "f32": return 4;
    case "u16": case "i16": return 2;
    case "u8":  case "i8":  return 1;
  }
}

/** Runtime `typeof` tag of values of `kind` — used by pushChecked validation. */
export function kindTsType(kind: FieldKind): "bigint" | "number" {
  switch (kind) {
    case "u64": case "i64": return "bigint";
    default: return "number";
  }
}

export interface FieldSpec<T = unknown> {
  readonly kind: FieldKind;
  /** Omitted = scalar; positive integer = fixed-length array. */
  readonly length?: number;
  /** Total bytes occupied by this field within a frame. */
  readonly byteSize: number;
  /** Phantom type tag — drives FrameFor<S> inference; never set at runtime. */
  readonly _t?: T;
}

// ─── Scalar field constructors ─────────────────────────────────────────────

function scalar<T>(kind: FieldKind): FieldSpec<T> {
  return Object.freeze({ kind, byteSize: kindByteSize(kind) }) as FieldSpec<T>;
}

export const u64 = (): FieldSpec<bigint> => scalar<bigint>("u64");
export const i64 = (): FieldSpec<bigint> => scalar<bigint>("i64");
export const f64 = (): FieldSpec<number> => scalar<number>("f64");
export const u32 = (): FieldSpec<number> => scalar<number>("u32");
export const i32 = (): FieldSpec<number> => scalar<number>("i32");
export const f32 = (): FieldSpec<number> => scalar<number>("f32");
export const u16 = (): FieldSpec<number> => scalar<number>("u16");
export const i16 = (): FieldSpec<number> => scalar<number>("i16");
export const u8  = (): FieldSpec<number> => scalar<number>("u8");
export const i8  = (): FieldSpec<number> => scalar<number>("i8");

// ─── Array field constructors ──────────────────────────────────────────────

function array<T>(kind: FieldKind, n: number): FieldSpec<T> {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Schema: array length must be a positive integer, got ${n}`,
    );
  }
  return Object.freeze({
    kind,
    length: n,
    byteSize: kindByteSize(kind) * n,
  }) as FieldSpec<T>;
}

export const u64Array = (n: number): FieldSpec<BigUint64Array> => array<BigUint64Array>("u64", n);
export const i64Array = (n: number): FieldSpec<BigInt64Array>  => array<BigInt64Array>("i64", n);
export const f64Array = (n: number): FieldSpec<Float64Array>   => array<Float64Array>("f64", n);
export const f32Array = (n: number): FieldSpec<Float32Array>   => array<Float32Array>("f32", n);
export const u32Array = (n: number): FieldSpec<Uint32Array>    => array<Uint32Array>("u32", n);
export const i32Array = (n: number): FieldSpec<Int32Array>     => array<Int32Array>("i32", n);
export const u16Array = (n: number): FieldSpec<Uint16Array>    => array<Uint16Array>("u16", n);
export const i16Array = (n: number): FieldSpec<Int16Array>     => array<Int16Array>("i16", n);
export const u8Array  = (n: number): FieldSpec<Uint8Array>     => array<Uint8Array>("u8",  n);
export const i8Array  = (n: number): FieldSpec<Int8Array>      => array<Int8Array>("i8",  n);

// ─── Schema container + inference ──────────────────────────────────────────

export type FieldsObject = Record<string, FieldSpec<unknown>>;

/** Compiled per-field layout consumed by Bridge — internal but exposed for tests. */
export interface CompiledField {
  readonly name: string;
  readonly kind: FieldKind;
  /** 1 for scalar, ≥1 for array. */
  readonly length: number;
  readonly isArray: boolean;
  /** Byte offset within a single frame (not within the SAB). */
  readonly byteOffset: number;
}

export interface CompiledLayout {
  readonly frameByteSize: number;
  readonly typesPresent: ReadonlyArray<FieldKind>;
  readonly fields: ReadonlyArray<CompiledField>;
  /** Byte offset of the hidden `__invariant: f64` field within a frame, or
   *  null if the schema has no invariant attached. When non-null the
   *  bridge writes the f64 invariant here on push and reads/verifies on
   *  pull. Always 8-aligned. */
  readonly invariantByteOffset: number | null;
}

/** Caller-supplied invariant function. Receives a user-shaped frame object
 *  (no `__invariant` field exposed) and returns a finite f64 scalar that the
 *  bridge stores per-frame for verification on pull. Must be O(payload size),
 *  allocation-free, and pure. */
export type InvariantFn<F extends FieldsObject> = (
  frame: { -readonly [K in keyof F]: F[K] extends FieldSpec<infer T> ? T : never },
) => number;

/** Type-erased invariant spec consumed by Bridge. */
export interface SchemaInvariantSpec {
  /** Type-erased invariant compute fn (Bridge passes Record<string, unknown>). */
  readonly compute: (frame: Record<string, unknown>) => number;
  /** Byte offset of the hidden `__invariant: f64` field within a frame. */
  readonly byteOffset: number;
}

export interface Schema<F extends FieldsObject = FieldsObject> {
  readonly fields: F;
  readonly frameByteSize: number;
  readonly compiled: CompiledLayout;
  readonly _brand: "wab/Schema";
  /** Attached invariant spec, or null if none. */
  readonly invariant: SchemaInvariantSpec | null;
  /** Builder: returns a new Schema with the invariant attached. The frame
   *  byte size grows by 8 to accommodate the hidden `__invariant: f64`
   *  field; the f64 type-family is added to `compiled.typesPresent` if not
   *  already present. */
  withInvariant(fn: InvariantFn<F>): Schema<F>;
}

/** Map a Schema to the frame object shape used by Bridge push/pull.
 *  Does NOT include the hidden `__invariant` field — that's bridge-managed
 *  and never exposed to user-side reads/writes. */
export type FrameFor<S> = S extends Schema<infer F>
  ? { -readonly [K in keyof F]: F[K] extends FieldSpec<infer T> ? T : never }
  : never;

// ─── Layout description (postMessageable; consumed by worklet inliners) ────

export interface SchemaLayoutFieldDescription {
  readonly kind: FieldKind;
  readonly byteOffset: number;
  readonly length?: number;
}

export interface SchemaLayoutDescription {
  readonly headerBytes: 32;
  readonly frameByteSize: number;
  readonly fields: Readonly<Record<string, SchemaLayoutFieldDescription>>;
}

// ─── Validation + compile ──────────────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isFieldKind(x: unknown): x is FieldKind {
  return (
    x === "u64" || x === "i64" ||
    x === "u32" || x === "i32" ||
    x === "u16" || x === "i16" ||
    x === "u8"  || x === "i8"  ||
    x === "f64" || x === "f32"
  );
}

function compileLayout(
  fields: FieldsObject,
  options: { invariant: boolean },
): CompiledLayout {
  const names = Object.keys(fields);
  // Stable sort by alignment class descending: 8-byte first, then 4, then 2, then 1.
  // Within an alignment class preserve declared order. Dense packing within
  // class then guarantees every field's byteOffset is a multiple of its
  // element size — no SAB typed-array constructor will reject the alignment.
  const decl = names.map((name, i) => {
    const spec = fields[name]!;
    return { name, spec, declOrder: i, align: kindByteSize(spec.kind) };
  });
  decl.sort((a, b) => {
    if (a.align !== b.align) return b.align - a.align;
    return a.declOrder - b.declOrder;
  });

  const compiledFields: CompiledField[] = [];
  const typesPresentSet = new Set<FieldKind>();
  let offset = 0;
  for (const { name, spec } of decl) {
    const length = spec.length ?? 1;
    const isArray = spec.length !== undefined;
    const align = kindByteSize(spec.kind);
    if (offset % align !== 0) {
      throw new Error(
        `Schema: internal alignment error for field '${name}' (offset ${offset} not aligned to ${align})`,
      );
    }
    compiledFields.push(
      Object.freeze({
        name,
        kind: spec.kind,
        length,
        isArray,
        byteOffset: offset,
      }),
    );
    typesPresentSet.add(spec.kind);
    offset += spec.byteSize;
  }

  // Pad user-fields end up to 8 so the next slot starts 8-aligned (matches
  // the ring header which is also 32 = multiple of 8).
  const userEnd = (offset + 7) & ~7;

  if (!options.invariant) {
    return Object.freeze({
      frameByteSize: userEnd,
      typesPresent: Object.freeze([...typesPresentSet]) as ReadonlyArray<FieldKind>,
      fields: Object.freeze(compiledFields) as ReadonlyArray<CompiledField>,
      invariantByteOffset: null,
    });
  }

  // Append the hidden __invariant: f64 field at userEnd. userEnd is already
  // 8-aligned. Frame size grows by 8. f64 must be in typesPresent so the
  // Bridge has a Float64 umbrella view to read/write the lane through.
  typesPresentSet.add("f64");
  return Object.freeze({
    frameByteSize: userEnd + 8,
    typesPresent: Object.freeze([...typesPresentSet]) as ReadonlyArray<FieldKind>,
    fields: Object.freeze(compiledFields) as ReadonlyArray<CompiledField>,
    invariantByteOffset: userEnd,
  });
}

function makeSchema<F extends FieldsObject>(
  fields: F,
  compiled: CompiledLayout,
  invariantFn: InvariantFn<F> | null,
): Schema<F> {
  const invariant: SchemaInvariantSpec | null =
    invariantFn === null || compiled.invariantByteOffset === null
      ? null
      : Object.freeze({
          compute: invariantFn as unknown as (
            frame: Record<string, unknown>,
          ) => number,
          byteOffset: compiled.invariantByteOffset,
        });
  return Object.freeze({
    fields,
    frameByteSize: compiled.frameByteSize,
    compiled,
    _brand: "wab/Schema" as const,
    invariant,
    withInvariant(fn: InvariantFn<F>): Schema<F> {
      if (typeof fn !== "function") {
        throw new TypeError(
          "Schema.withInvariant: argument must be a function (frame → number)",
        );
      }
      const newCompiled = compileLayout(fields, { invariant: true });
      return makeSchema(fields, newCompiled, fn);
    },
  }) as Schema<F>;
}

export function defineSchema<F extends FieldsObject>(fields: F): Schema<F> {
  const names = Object.keys(fields);
  if (names.length === 0) {
    throw new Error("Schema: must declare at least one field");
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`Schema: duplicate field name '${name}'`);
    }
    seen.add(name);
    if (!IDENT_RE.test(name)) {
      throw new Error(
        `Schema: field name '${name}' is not a valid JS identifier`,
      );
    }
    const spec = fields[name];
    if (!spec || typeof spec !== "object" || !("kind" in spec)) {
      throw new Error(
        `Schema: field '${name}' is not a FieldSpec — use u64() / f64Array(n) / etc.`,
      );
    }
    if (!isFieldKind(spec.kind)) {
      throw new Error(
        `Schema: field '${name}' has unknown kind '${String(spec.kind)}'`,
      );
    }
    if (
      spec.length !== undefined &&
      (!Number.isInteger(spec.length) || spec.length <= 0)
    ) {
      throw new Error(
        `Schema: field '${name}' has invalid length ${spec.length}`,
      );
    }
  }

  const compiled = compileLayout(fields, { invariant: false });
  return makeSchema(fields, compiled, null);
}

/** Produce a postMessage-safe layout description for worklet inliners. */
export function describeSchemaLayout(schema: Schema): SchemaLayoutDescription {
  const fields: Record<string, SchemaLayoutFieldDescription> = {};
  for (const f of schema.compiled.fields) {
    fields[f.name] = f.isArray
      ? { kind: f.kind, byteOffset: f.byteOffset, length: f.length }
      : { kind: f.kind, byteOffset: f.byteOffset };
  }
  return Object.freeze({
    headerBytes: 32,
    frameByteSize: schema.frameByteSize,
    fields: Object.freeze(fields),
  });
}
