/**
 * emitWasmDecoder — schema-derived, monomorphized WASM whole-frame decoder.
 *
 * Emits, as a SOURCE STRING, a WebAssembly Text (WAT) module that decodes one
 * ring slot's user payload into a caller-supplied scratch region, with every
 * field's source/destination byte offset and length baked in as an `i32.const`
 * literal. It is the WAT sibling of `emitWorkletReader` (DataView JS) and
 * `emitWgslStruct` (WGSL): the TS `Schema` is the single source of truth, and
 * the generated artifact is specialized to ONE exact layout.
 *
 *   (func $decode_frame (param $slotBase i32) (param $dstBase i32) … )
 *
 * ── Why this exists (the monomorphization thesis) ──────────────────────────
 *
 * The packaged `decoder.wasm` already ships a `decode_frame` export (0.9.74),
 * but it is GENERIC: one binary serves every schema by looping at runtime over
 * a `(srcRel, dstAbs, byteCount)` descriptor table that JS blits into memory
 * (`buildFrameDescriptors`). That genericity costs a per-field loop iteration,
 * three `i32.load`s per field, and a one-time descriptor blit at setup.
 *
 * A schema-generated decoder pays none of that. Each field becomes a
 * straight-line `memory.copy` with its offsets folded to literals — no
 * descriptor table, no loop, no `descPtr`/`descCount` params. The module is a
 * pure, monomorphized relocation function that knows exactly where every field
 * lives. When adjacent fields are contiguous in BOTH the source frame and the
 * destination region (the common case — the payload is one packed block), the
 * coalescing pass fuses them into a single `memory.copy`, so a typical frame
 * decodes in ONE bulk move.
 *
 * The output is byte-identical to the generic `decode_frame` for the same
 * schema (it uses the same descending-alignment destination packing as
 * `buildFrameDescriptors`), which is in turn bit-exact to `Bridge.pull` (pure
 * byte relocation, no arithmetic). That chain of oracles is what lets the
 * generated artifact be proven, not just asserted — see
 * `tests/emitWasmDecoder.test.ts`.
 *
 * ── Contracts / assumptions ────────────────────────────────────────────────
 *
 * • SHARED-MEMORY IMPORT. The module imports `env.memory` as a `shared`
 *   memory whose bytes ARE the Bridge SAB (plus the consumer scratch region) —
 *   the "SAB is the memory" architecture. The page bounds (`1 16384`) match the
 *   packaged decoder so one `WebAssembly.Memory` works for both.
 *
 * • DESTINATION PACKING matches `buildFrameDescriptors`: fields are packed into
 *   the scratch region in DESCENDING alignment order (8 → 4 → 2 → 1 byte
 *   element size, declared order within a class) so every field's destination
 *   is naturally aligned and a `new Float64Array(memory.buffer, dstBase + rel,
 *   n)` view never throws. The invariant lane is EXCLUDED (bridge-managed, like
 *   the generic path).
 *
 * • PURE RELOCATION. The decoder copies bytes; it performs no arithmetic, no
 *   trajectory evaluation, no endianness swap. Multi-byte lanes stay in the
 *   host-endian form the producer wrote (correct on every realistic WebAudio
 *   target; a big-endian host would mis-decode, same emit-time assumption as
 *   `emitWorkletReader`).
 *
 * • MONOMORPHIZED. Specialized to ONE frameByteSize/offset set. If the producer
 *   schema drifts, the decoder silently mis-decodes — the emitted banner
 *   records `frameByteSize` + field count so a caller can fingerprint the
 *   generation against `describeLayout()`.
 *
 * • NEEDS bulk_memory. `memory.copy` requires the bulk-memory proposal (enabled
 *   in `wasm/build.mjs`; universally available in modern engines). The emitted
 *   text is compiled by the caller (e.g. `wabt` at build time / in tests), the
 *   same boundary `emitWorkletReader` documents — this function returns a
 *   STRING and imports no compiler.
 *
 * Regenerate-on-drift: this is a build-time codegen. Re-run whenever the schema
 * changes; never hand-edit the emitted output (the banner says so).
 */

import {
  kindByteSize,
  type FieldKind,
  type Schema,
  type FieldsObject,
  type TimestampsConfig,
  type SchemaLayoutDescription,
  describeSchemaLayout,
} from "./schema.js";

/** Accept either a compiled `Schema` (normalized via `describeSchemaLayout`)
 *  or an already-postMessaged `SchemaLayoutDescription` — same input shape as
 *  `emitWorkletReader` / `emitWgslStruct`. */
export type EmitWasmDecoderInput =
  | Schema<FieldsObject, TimestampsConfig<FieldsObject> | null>
  | SchemaLayoutDescription;

export interface EmitWasmDecoderOptions {
  /** Emitted decode function name (also the export name). Default
   *  `"decode_frame"` — matches the packaged generic export so a generated
   *  module is a drop-in replacement at the call site. */
  readonly functionName?: string;
  /** Shared-memory page bounds emitted on the `(import "env" "memory" …)`
   *  declaration. Default `{ min: 1, max: 16384 }` — identical to the packaged
   *  decoder so the same `WebAssembly.Memory` instantiates both. */
  readonly memoryPages?: { readonly min: number; readonly max: number };
  /** Fuse adjacent fields that are contiguous in BOTH source and destination
   *  into a single `memory.copy`. Default true — the payload is usually one
   *  packed block, so this collapses a whole frame to one bulk move. Set false
   *  to emit one `memory.copy` per field (a faithful unroll of the generic
   *  loop), useful for diffing the two strategies. */
  readonly coalesceCopies?: boolean;
  /** Shape of the slot argument.
   *  - `"slotBase"` (default): the export takes `$slotBase` — the absolute
   *    byte offset of the slot (`headerBytes + slot*frameByteSize`). Matches
   *    the packaged generic `decode_frame` call shape; the caller does the
   *    stride math (or uses `slotByteBase`).
   *  - `"slotIndex"`: the export takes `$slot` — the ring slot INDEX — and
   *    computes `slotBase` internally from the baked `frameByteSize` +
   *    `headerBytes`. One fewer multiply at the call site, fully monomorphic. */
  readonly slotInput?: "slotBase" | "slotIndex";
  /** Destination base handling.
   *  - omitted (default): the export takes a `$dstBase` param (the scratch
   *    byte offset), so the same module can target any scratch region.
   *  - a number: BAKE the scratch base as a literal — every destination
   *    address becomes a single `i32.const`. Combined with
   *    `slotInput: "slotIndex"` the export collapses to a single-arg
   *    `decode_frame(slot)`. Must be a non-negative 8-aligned integer so the
   *    highest-alignment field lands aligned. */
  readonly dstBase?: number;
}

/** One field's place in the generated decoder: where it is read from in the
 *  slot (`srcRel`, relative to `slotBase`) and written to in the scratch
 *  region (`dstRel`, relative to `dstBase`). Mirrors `buildFrameDescriptors`'
 *  per-field destination so a caller can build identical read views. */
export interface WasmDecoderField {
  readonly name: string;
  readonly kind: FieldKind;
  /** Flat element count (1 for scalar). */
  readonly length: number;
  readonly isArray: boolean;
  /** Source byte offset within a frame slot (the schema's `byteOffset`). */
  readonly srcRel: number;
  /** Destination byte offset within the scratch region, relative to `dstBase`.
   *  Add `dstBase` to get the absolute WASM-memory offset for a typed view. */
  readonly dstRel: number;
  /** `kindByteSize(kind) * length`. */
  readonly byteCount: number;
}

/** One emitted `memory.copy`: a (possibly coalesced) contiguous byte move from
 *  `slotBase + srcRel` to `dstBase + dstRel`. `fieldNames` lists the field(s)
 *  it covers (more than one when coalesced). */
export interface WasmDecoderCopy {
  readonly srcRel: number;
  readonly dstRel: number;
  readonly byteCount: number;
  readonly fieldNames: ReadonlyArray<string>;
}

/** Structured plan behind the emitted text — the testable spine, analogous to
 *  `computeWgslLayout`. `emitWasmDecoder` renders this to WAT. */
export interface WasmDecoderPlan {
  /** Per-field source/destination map, in destination (descending-alignment)
   *  order. Keyed access via `.find`/a derived record at the call site. */
  readonly fields: ReadonlyArray<WasmDecoderField>;
  /** The `memory.copy` ops the decoder emits, after optional coalescing. */
  readonly copies: ReadonlyArray<WasmDecoderCopy>;
  /** Total bytes the decoded region occupies (reserve this much scratch above
   *  `dstBase`). Rounded up to 8 so stacked plans stay 8-aligned. */
  readonly totalDstBytes: number;
}

/** Discriminate the union: a `Schema` carries a `compiled` field; a
 *  `SchemaLayoutDescription` does not. Normalize to the postMessage-safe
 *  description so the rest of the emitter has one shape to consume. */
function normalizeLayout(input: EmitWasmDecoderInput): SchemaLayoutDescription {
  if ("compiled" in input) {
    return describeSchemaLayout(input);
  }
  return input;
}

/**
 * Compute the field source/destination map + coalesced copy list for `input`'s
 * schema. The destination packing is byte-identical to `buildFrameDescriptors`
 * (descending alignment, declared order within a class), so a decoder rendered
 * from this plan writes the exact bytes the generic `decode_frame` would — the
 * equivalence the test pins.
 */
export function planWasmDecoder(
  input: EmitWasmDecoderInput,
  opts: EmitWasmDecoderOptions = {},
): WasmDecoderPlan {
  const desc = normalizeLayout(input);
  const coalesce = opts.coalesceCopies ?? true;

  // Sort fields by descending element size, declared order within a class —
  // the SAME discipline as buildFrameDescriptors (and schema.compileLayout),
  // so destination offsets stay naturally aligned without padding.
  const entries = Object.entries(desc.fields).map(([name, f], declOrder) => ({
    name,
    field: f,
    declOrder,
    elemSize: kindByteSize(f.kind),
    length: f.length ?? 1,
    isArray: f.length !== undefined,
  }));
  entries.sort((a, b) =>
    a.elemSize !== b.elemSize ? b.elemSize - a.elemSize : a.declOrder - b.declOrder,
  );

  const fields: WasmDecoderField[] = [];
  let dstCursor = 0;
  for (const e of entries) {
    const byteCount = e.elemSize * e.length;
    fields.push({
      name: e.name,
      kind: e.field.kind,
      length: e.length,
      isArray: e.isArray,
      srcRel: e.field.byteOffset,
      dstRel: dstCursor,
      byteCount,
    });
    dstCursor += byteCount;
  }
  const totalDstBytes = (dstCursor + 7) & ~7;

  // Coalesce: fuse consecutive fields that are contiguous in BOTH the source
  // frame and the destination region into a single move. Fields are already in
  // destination order (dstRel is monotonic), so only the source side needs a
  // contiguity check. Without coalescing, one copy per field.
  const copies: WasmDecoderCopy[] = [];
  for (const f of fields) {
    const prev = copies[copies.length - 1];
    if (
      coalesce &&
      prev !== undefined &&
      prev.dstRel + prev.byteCount === f.dstRel &&
      prev.srcRel + prev.byteCount === f.srcRel
    ) {
      copies[copies.length - 1] = {
        srcRel: prev.srcRel,
        dstRel: prev.dstRel,
        byteCount: prev.byteCount + f.byteCount,
        fieldNames: [...prev.fieldNames, f.name],
      };
    } else {
      copies.push({
        srcRel: f.srcRel,
        dstRel: f.dstRel,
        byteCount: f.byteCount,
        fieldNames: [f.name],
      });
    }
  }

  return Object.freeze({
    fields: Object.freeze(fields) as ReadonlyArray<WasmDecoderField>,
    copies: Object.freeze(copies) as ReadonlyArray<WasmDecoderCopy>,
    totalDstBytes,
  });
}

/** Emit a `local.get $base (+ i32.const off + i32.add)` address expression,
 *  dropping the add when the offset is 0. */
function emitLocalAddr(base: string, off: number): string[] {
  if (off === 0) return [`    local.get ${base}`];
  return [`    local.get ${base}`, `    i32.const ${off}`, `    i32.add`];
}

/** Emit one `memory.copy` for a (possibly coalesced) copy. WAT stack order is
 *  dest, src, len — matching the packaged `decode_frame`. The destination is a
 *  single baked `i32.const` when `dstBase` was baked, otherwise `$dstBase +
 *  dstRel`. The source is always `$slotBase + srcRel` (`$slotBase` is either a
 *  param or a prologue-computed local). */
function emitCopy(copy: WasmDecoderCopy, bakedDstBase: number | undefined): string[] {
  const label =
    copy.fieldNames.length === 1
      ? copy.fieldNames[0]
      : `${copy.fieldNames.length} fields [${copy.fieldNames.join(", ")}]`;
  const dstOps =
    bakedDstBase !== undefined
      ? [`    i32.const ${bakedDstBase + copy.dstRel}`]
      : emitLocalAddr("$dstBase", copy.dstRel);
  return [
    `    ;; ${label}: ${copy.byteCount} byte(s) — slot+${copy.srcRel} -> dst+${copy.dstRel}`,
    ...dstOps,
    ...emitLocalAddr("$slotBase", copy.srcRel),
    `    i32.const ${copy.byteCount}`,
    `    memory.copy`,
  ];
}

/**
 * Emit a monomorphized whole-frame WASM decoder for `input`'s schema as a WAT
 * module SOURCE STRING. The single export
 * `(func $<functionName> (param $slotBase i32) (param $dstBase i32))` decodes
 * one slot into the scratch region at `dstBase` with all offsets baked in.
 *
 * Compile the returned text with any WAT→wasm compiler (e.g. the `wabt`
 * package at build time), then instantiate it against the same shared
 * `WebAssembly.Memory` the Bridge SAB lives in — see
 * `examples/wasm-decode-worklet/` and `tests/emitWasmDecoder.test.ts`.
 *
 * @param input  A compiled `Schema` (normalized internally) or a postMessage'd
 *               `SchemaLayoutDescription`.
 * @param opts   See `EmitWasmDecoderOptions`.
 * @returns      WAT module source for the monomorphized decoder.
 */
export function emitWasmDecoder(
  input: EmitWasmDecoderInput,
  opts: EmitWasmDecoderOptions = {},
): string {
  const desc = normalizeLayout(input);
  const fnName = opts.functionName ?? "decode_frame";
  const min = opts.memoryPages?.min ?? 1;
  const max = opts.memoryPages?.max ?? 16384;
  const slotInput = opts.slotInput ?? "slotBase";
  const bakedDstBase = opts.dstBase;
  if (
    bakedDstBase !== undefined &&
    (!Number.isInteger(bakedDstBase) || bakedDstBase < 0 || bakedDstBase % 8 !== 0)
  ) {
    throw new Error(
      `emitWasmDecoder: opts.dstBase must be a non-negative 8-aligned integer, got ${bakedDstBase}`,
    );
  }
  const plan = planWasmDecoder(input, opts);

  const fieldCount = plan.fields.length;
  // Param list + (for slotIndex) the prologue that derives $slotBase once.
  const slotParam = slotInput === "slotIndex" ? "$slot" : "$slotBase";
  const params =
    bakedDstBase !== undefined
      ? `(param ${slotParam} i32)`
      : `(param ${slotParam} i32) (param $dstBase i32)`;
  const sigNote =
    `${slotInput === "slotIndex" ? "slot index" : "slot base"} arg` +
    (bakedDstBase !== undefined ? `; dstBase baked @ ${bakedDstBase}` : "; dstBase param");

  const lines: string[] = [];
  lines.push(
    `;; ── GENERATED by emitWasmDecoder — DO NOT EDIT ──────────────────────`,
    `;; Monomorphized whole-frame decoder for one exact schema.`,
    `;;   frameByteSize=${desc.frameByteSize}, ${fieldCount} field(s), ` +
      `headerBytes=${desc.headerBytes}.`,
    `;;   ${plan.copies.length} memory.copy op(s); ` +
      `${plan.totalDstBytes} scratch byte(s); ` +
      `invariant lane EXCLUDED (bridge-managed).`,
    `;;   signature: ${fnName}(${sigNote}).`,
    `;; Byte-identical to the generic decode_frame; bit-exact to Bridge.pull.`,
    `;; Schema drift silently mis-decodes — regenerate on layout change.`,
    `(module`,
    `  ;; SAB-is-the-memory: the host imports the Bridge SAB as env.memory.`,
    `  (import "env" "memory" (memory ${min} ${max} shared))`,
    ``,
    `  ;; decode one slot -> scratch. All field offsets are baked literals.`,
    `  (func $${fnName} (export "${fnName}")`,
    `        ${params}`,
  );

  // slotIndex form: declare + compute $slotBase = headerBytes + slot*stride once.
  if (slotInput === "slotIndex") {
    lines.push(
      `    (local $slotBase i32)`,
      `    ;; slotBase = headerBytes(${desc.headerBytes}) + slot * frameByteSize(${desc.frameByteSize})`,
      `    local.get $slot`,
      `    i32.const ${desc.frameByteSize}`,
      `    i32.mul`,
      `    i32.const ${desc.headerBytes}`,
      `    i32.add`,
      `    local.set $slotBase`,
    );
  }

  if (plan.copies.length === 0) {
    // Degenerate schema with no user fields — emit an empty body (the slot is
    // header-only / invariant-only). A bare function is valid WAT.
    lines.push(`    ;; no user fields to decode`);
  } else {
    for (const copy of plan.copies) {
      lines.push(...emitCopy(copy, bakedDstBase));
    }
  }

  lines.push(`  )`, `)`);
  return lines.join("\n");
}
