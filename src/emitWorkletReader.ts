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
 *   inverse of SpscRing's payload write. Use `emitWorkletProcessorModule` when
 *   you want the generated code to include a commit-aware `pullLatest` helper.
 *
 * Regenerate-on-drift: this is a build-time codegen. Re-run whenever the
 * schema changes; never hand-edit the emitted output (the banner says so).
 */

import {
  kindByteSize,
  kindTsType,
  type FieldKind,
  type Schema,
  type FieldsObject,
  type TimestampsConfig,
  type FrameFor,
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

// ─── Convenience layer (additive — `emitWorkletReader` above is the primitive) ─
//
// `emitWorkletReader` hands back a bare `function readFrame(...) {}` SOURCE
// STRING. To actually run it on the audio thread the caller has to do the
// plumbing themselves (eval / Blob+addModule / build step), and each path has a
// footgun (CSP `unsafe-eval`; `addModule` of a bare fn does nothing; build-step
// friction). The three helpers below ship that plumbing:
//
//   • emitWorkletProcessorModule — wrap the reader in a self-registering
//     `AudioWorkletProcessor` module string ready for a Blob / build step.
//   • toWorkletModuleURL          — Blob + object URL ready for `addModule`.
//   • compileWorkletReader        — `new Function` the reader for tests /
//     Standard-mode main-thread consumers (NOT the audio thread).
//
// ── The unavoidable boundary + CSP posture (documented, not hidden) ──────────
//
// Source MUST cross into the `AudioWorkletGlobalScope` realm; `addModule` takes
// a URL and `toWorkletModuleURL` makes that URL from a Blob — the helper removes
// the keystrokes, not the boundary. CSP: `blob:` in `script-src` / `worker-src`
// is required for `toWorkletModuleURL` + `addModule`; `unsafe-eval` for
// `compileWorkletReader`. Apps with strict CSP must use the BUILD-STEP path:
// write `emitWorkletProcessorModule(...)` output to a `.js` file the bundler
// serves. See README §codegen "Getting the reader into the worklet".

/** Per-kind typed-array constructor name. Codegen-local — used to pre-allocate
 *  the reusable `out` frame's array fields in the emitted processor ctor. */
const TYPED_ARRAY_CTOR: Record<FieldKind, string> = {
  f64: "Float64Array",
  f32: "Float32Array",
  u64: "BigUint64Array",
  i64: "BigInt64Array",
  u32: "Uint32Array",
  i32: "Int32Array",
  u16: "Uint16Array",
  i16: "Int16Array",
  u8: "Uint8Array",
  i8: "Int8Array",
};

/** Literal initializer for a scalar field of `kind` in the pre-allocated `out`
 *  frame: `0n` for the bigint kinds, `0` otherwise. */
function scalarInit(kind: FieldKind): string {
  return kindTsType(kind) === "bigint" ? "0n" : "0";
}

export interface EmitWorkletProcessorOptions extends EmitWorkletReaderOptions {
  /** Name for `registerProcessor(name, …)` + the `AudioWorkletNode` ctor. */
  readonly processorName: string;
  /** The per-quantum body. Runs inside `process(inputs, outputs, parameters)`.
   *  In scope when it runs: the emitted reader fn (default `readFrame`), a
   *  reusable `out` frame object (pre-allocated in the ctor — NOT per quantum),
   *  the `DataView` over the SAB (`this._view`), `this._capacity`, a
   *  `slotOf(writeIndexMinus1)` helper, and a commit-aware `pullLatest(target?)`
   *  helper. The body returns `true`/`false` like a normal processor. */
  readonly processBody: string;
  /** Optional capacity baked into the module as the fallback when
   *  `processorOptions.capacity` is absent. When omitted the ctor requires
   *  `processorOptions.capacity`. */
  readonly capacity?: number;
}

/**
 * Wrap the emitted reader in a self-registering AudioWorklet PROCESSOR module.
 * Returns a complete, import-free ES module source string ready for a Blob
 * (`toWorkletModuleURL`) or a build step. The ctor reads the SAB + capacity from
 * `processorOptions` (`new AudioWorkletNode(ctx, name, { processorOptions: {
 * sab, capacity, policy? } })`), builds the `DataView`, and pre-allocates the
 * reusable `out` frame (typed arrays for array fields) so `process()` is
 * allocation-free. The generated `pullLatest(target?)` helper mirrors the
 * realtime-safe Bridge hot path: acquire-load `write_index`, decode newest,
 * release-store `read_index`, notify a parked producer, and return skipped
 * frames (`-1` on empty). When `processorOptions.policy === "drop-oldest"`, it
 * uses a CAS commit/retry loop so a producer-side overrun cannot publish a
 * suspect slot to the audio graph.
 *
 * CSP: the resulting module is loaded via `addModule(blobURL)` which needs
 * `blob:` in `script-src`/`worker-src`, OR written to a file for the build-step
 * path. See the convenience-layer banner above.
 */
export function emitWorkletProcessorModule(
  input: EmitWorkletReaderInput,
  opts: EmitWorkletProcessorOptions,
): string {
  if (typeof opts.processorName !== "string" || opts.processorName.length === 0) {
    throw new Error(
      "emitWorkletProcessorModule(): opts.processorName must be a non-empty string",
    );
  }
  if (typeof opts.processBody !== "string") {
    throw new Error("emitWorkletProcessorModule(): opts.processBody must be a string");
  }
  if (
    opts.capacity !== undefined &&
    (!Number.isInteger(opts.capacity) || opts.capacity < 1)
  ) {
    throw new Error(
      `emitWorkletProcessorModule(): opts.capacity must be a positive integer, got ${opts.capacity}`,
    );
  }

  const desc = normalizeLayout(input);
  const fnName = opts.functionName ?? "readFrame";
  const includeInvariant = opts.includeInvariant ?? false;

  // The reader primitive — always the full `function …(view, slot, out) {}`
  // form (never bodyOnly) so the module can call it by name.
  const readerSrc = emitWorkletReader(input, { ...opts, bodyOnly: false });

  // Pre-allocate the reusable `out` frame: a typed array per array field, a
  // zero literal per scalar. Mirrors `scratchFrame()` so the reader's per-field
  // writes (`out.x = …`, `a[i] = …`) never allocate on the audio thread.
  const allocLines: string[] = [];
  for (const name of Object.keys(desc.fields)) {
    const field: SchemaLayoutFieldDescription = desc.fields[name]!;
    if (field.length !== undefined) {
      allocLines.push(
        `      ${name}: new ${TYPED_ARRAY_CTOR[field.kind]}(${field.length}),`,
      );
    } else {
      allocLines.push(`      ${name}: ${scalarInit(field.kind)},`);
    }
  }
  if (includeInvariant && desc.invariantByteOffset !== null) {
    allocLines.push(`      __invariant: 0,`);
  }

  const capacityFallback =
    opts.capacity !== undefined ? String(opts.capacity) : "undefined";

  // Anonymous class expression keeps `processorName` free of identifier rules
  // (it can contain `-`); the module stays import-free.
  return [
    `// ── GENERATED by emitWorkletProcessorModule — DO NOT EDIT ─────────────`,
    `// Self-registering AudioWorkletProcessor "${opts.processorName}".`,
    `// frameByteSize=${desc.frameByteSize}, headerBytes=${desc.headerBytes}.`,
    `// Import-free — load via addModule(blobURL) or a build step. See README §codegen.`,
    ``,
    readerSrc,
    ``,
    `registerProcessor(${JSON.stringify(opts.processorName)}, class extends AudioWorkletProcessor {`,
    `  constructor(options) {`,
    `    super();`,
    `    const po = (options && options.processorOptions) || {};`,
    `    this._sab = po.sab;`,
    `    this._capacity = po.capacity != null ? po.capacity : ${capacityFallback};`,
    `    this._policy = po.policy || "reject";`,
    `    if (this._sab == null) {`,
    `      throw new Error(${JSON.stringify(
      `${opts.processorName}: processorOptions.sab (SharedArrayBuffer) is required`,
    )});`,
    `    }`,
    `    if (this._capacity == null) {`,
    `      throw new Error(${JSON.stringify(
      `${opts.processorName}: processorOptions.capacity is required`,
    )});`,
    `    }`,
    `    this._view = new DataView(this._sab);`,
    `    this._indices = new Int32Array(this._sab, 0, 8);`,
    `    this._out = {`,
    ...allocLines,
    `    };`,
    `    this.pullLatest = (target) => {`,
    `      const frame = target || this._out;`,
    `      const indices = this._indices;`,
    `      const cap = this._capacity;`,
    `      for (let tries = 0; tries <= cap; tries++) {`,
    `        const readIdx = Atomics.load(indices, 1);`,
    `        const writeIdx = Atomics.load(indices, 0);`,
    `        if (writeIdx === readIdx) return -1;`,
    `        const newestIdx = (writeIdx - 1) | 0;`,
    `        const skipped = (newestIdx - readIdx) | 0;`,
    `        const slot = ((newestIdx % cap) + cap) % cap;`,
    `        ${fnName}(this._view, slot, frame);`,
    `        if (this._policy === "drop-oldest") {`,
    `          if (Atomics.compareExchange(indices, 1, readIdx, writeIdx | 0) !== readIdx) continue;`,
    `        } else {`,
    `          Atomics.store(indices, 1, writeIdx | 0);`,
    `        }`,
    `        Atomics.notify(indices, 1, 1);`,
    `        return skipped;`,
    `      }`,
    `      return -1;`,
    `    };`,
    `  }`,
    `  process(inputs, outputs, parameters) {`,
    `    const out = this._out;`,
    `    const slotOf = (w) => { const c = this._capacity; return ((w % c) + c) % c; };`,
    `    const pullLatest = this.pullLatest;`,
    `    ${fnName}; out; slotOf; pullLatest;` + ` // keep in scope for the spliced body`,
    `${opts.processBody}`,
    `  }`,
    `});`,
  ].join("\n");
}

/**
 * Wrap ANY emitted source (a reader or a processor module) in a `Blob` and
 * return an object URL ready for `audioWorklet.addModule(url)` (or dynamic
 * `import(url)`). The caller calls `revoke()` after `addModule` resolves (or on
 * teardown) to release the URL.
 *
 * Throws a clear error when `Blob` / `URL.createObjectURL` are absent (SSR /
 * Node): there is no audio thread there, so use the build-step path instead.
 *
 * CSP: `addModule(blobURL)` requires `blob:` in `script-src`/`worker-src`.
 */
export function toWorkletModuleURL(source: string): {
  url: string;
  revoke: () => void;
} {
  if (
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    throw new Error(
      "toWorkletModuleURL(): Blob / URL.createObjectURL are unavailable in this " +
        "environment (SSR / Node). Use the build-step path: write the emitted " +
        "source to a .js file your bundler serves.",
    );
  }
  const blob = new Blob([source], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  return {
    url,
    revoke: () => URL.revokeObjectURL(url),
  };
}

/**
 * Compile the emitted reader to a live function via `new Function`. For
 * NON-worklet threads only — tests + Standard-mode (main-thread) consumers.
 *
 * NOT for the audio thread: `new Function` is `eval`, which is unavailable in
 * `AudioWorkletGlobalScope` and blocked by CSP without `unsafe-eval`. On the
 * audio thread, use `emitWorkletProcessorModule` + `toWorkletModuleURL` (or a
 * build step) instead.
 */
export function compileWorkletReader<
  S extends Schema<FieldsObject, TimestampsConfig<FieldsObject> | null>,
>(
  input: S | SchemaLayoutDescription,
  opts: EmitWorkletReaderOptions = {},
): (view: DataView, slot: number, out: FrameFor<S>) => void {
  const fnName = opts.functionName ?? "readFrame";
  // Force the full `function …() {}` form so the factory can return it by name.
  const src = emitWorkletReader(input, { ...opts, bodyOnly: false });
  const factory = new Function(`${src}\nreturn ${fnName};`);
  return factory() as (view: DataView, slot: number, out: FrameFor<S>) => void;
}
