/**
 * TimelineRecorder<S> / TimelinePlayer<S> — deterministic record / replay
 * and offline bounce (record-replay-timeline track).
 *
 * Turns the live bridge into a recordable, deterministic, re-renderable
 * MEDIUM. The live consumer's output is a function of (a) the frames the
 * producer pushed, each carrying a producer-stamped macro timestamp, and
 * (b) the consumer's wall-clock observation of those frames through the
 * PLL. (a) is fully captured by recording the pushed frames; (b) is the
 * ONLY non-determinism source — `performance.now()` / `AudioContext.currentTime`
 * jitter feeding `observeConsumerTime`, plus the PLL's stateful drift /
 * outlier estimation.
 *
 * The determinism contract here is therefore: REMOVE the PLL from the
 * replay loop entirely. Instead of phase-locking against a noisy wall
 * clock, the player synthesizes a perfectly deterministic consumer clock
 *
 *     consumerNs(n) = epochNs + (n / rate) * 1e9
 *
 * and feeds the pure IEEE-754 Taylor evaluator (`evaluateTrajectoryInto`,
 * `out = p + v·dt + ½·a·dt²`) the exact same `(rawFrame, dt)` math the live
 * `evaluateAtSampleOffset` uses — minus the `phaseLockedTime` step. Because
 * `evaluateTrajectoryInto`'s fast path is a fixed-order sequence of f64
 * multiplies/adds with no reduction reordering, two renders of the same
 * recording are bit-identical, and the render can run far faster than real
 * time (it is just arithmetic — no audio device, no Atomics, no waiting).
 *
 * ─── What gets captured ────────────────────────────────────────────────
 *
 * `TimelineRecorder<S>` captures each pushed frame as a
 * `(tMacroNs, frameSnapshot)` tuple into a growable heap buffer (zero SAB,
 * zero Atomics). `tMacroNs` is read from the schema's default timestamp
 * role (or a caller-named role), or supplied explicitly via `recordAt`.
 * Times must be monotonic-nondecreasing — the recorder is a step function
 * of producer time. `serialize()` packs the tuples into a compact,
 * schema-tagged `ArrayBuffer` container; `deserialize(buf, schema)` rebuilds
 * a `TimelinePlayer<S>` and rejects mismatched schemas up front.
 *
 * ─── Container format (formatVersion 1, little-endian) ─────────────────
 *
 *   byte 0   u32   magic 0x57414254  ("WABT")
 *   byte 4   u32   formatVersion = 1
 *   byte 8   u32   flags = 0          (bit0 reserved for an i64-times variant)
 *   byte 12  u32   schemaTag          (FNV-1a 32-bit over canonical
 *                                       describeSchemaLayout() JSON)
 *   byte 16  u32   frameByteSize      (cross-check gate vs schemaTag)
 *   byte 20  u32   tupleCount = K
 *   byte 24  f64   epochNs            (8-byte aligned)
 *   ── header is 32 bytes ──
 *   byte 32          K × f64   ascending tMacroNs values
 *   byte 32 + K*8    K × frameByteSize   contiguous frame snapshots
 *
 * All multi-byte fields are little-endian to match the platform-native
 * typed-array umbrella views the SAB path uses; the format documents the
 * LE assumption rather than probing host endianness.
 *
 * ─── Determinism caveats ───────────────────────────────────────────────
 *
 *   - Bit-identical replay depends on `evaluateTrajectoryInto` keeping a
 *     fixed IEEE-754 evaluation order. The fast path is bit-exact today
 *     (documented in trajectory.ts); pin 1 asserts two-render equality so a
 *     future SIMD/reordered path can't silently break the guarantee.
 *   - f64 macro times are exact only to 2^53 ns (~104 days). Recordings
 *     longer than that lose ns precision. The reserved flags bit0 is the
 *     future i64-times escape hatch; MVP1 documents the limit.
 *   - The schema tag is a 32-bit FNV-1a hash, so a crafted collision is
 *     possible in principle; the `frameByteSize` cross-check is a cheap
 *     second gate but does not fully eliminate one. Acceptable for a
 *     non-adversarial reproducibility artifact.
 *
 * ─── Scope ─────────────────────────────────────────────────────────────
 *
 * Standalone additive module. Zero changes to `Bridge.ts` / `SpscRing.ts`
 * / the wire format. Schemas built with `.withInvariant(...)` are rejected
 * at construction (consistent with `MessageChannelBridge`): the invariant
 * lane is a SAB-header concern with no meaning for an offline snapshot.
 *
 * The snapshot frame codec below is generalized from
 * `MessageChannelBridge._encodeFrame` / `_decodeFrame` (parameterized by a
 * base byte offset so snapshots pack contiguously without a per-frame
 * `ArrayBuffer` allocation on the player side). It is duplicated rather
 * than shared, following the project's documented duplicate-then-extract
 * idiom; a future `src/_frameCodec.ts` extraction is the obvious move once
 * a third consumer exists.
 *
 * NOTE: `record()` allocates one snapshot `ArrayBuffer` per call. This is
 * a capture-path cost, not an audio-hot-path regression — never call
 * `record()` inside an AudioWorklet `process()` loop.
 */

import {
  describeSchemaLayout,
  type CompiledField,
  type FieldKind,
  type FieldsObject,
  type FrameFor,
  type Schema,
  type SchemaTimestampsSpec,
  type TimestampRoleOf,
} from "./schema.js";
import { buildScratchFrame } from "./_heap.js";
import { evaluateTrajectoryInto } from "./trajectory.js";

// ─── Public types ──────────────────────────────────────────────────────────

/** Magic prefix "WABT" (WebAudioBridge Timeline), little-endian u32. */
const TIMELINE_MAGIC = 0x57414254;
/** Container format version. Bump on any header / layout change. */
const TIMELINE_FORMAT_VERSION = 1;
/** Header byte size: magic + version + flags + schemaTag + frameByteSize +
 *  tupleCount (6 × u32 = 24) then epochNs (f64, 8) = 32, 8-aligned. */
const TIMELINE_HEADER_BYTES = 32;

/** A single recorded control event: a producer macro timestamp (ns) and the
 *  raw frame bytes captured at that instant. `frame` is the decoded frame
 *  view; the serialized form stores the bytes contiguously. */
export interface TimelineTuple<S extends Schema<FieldsObject, any>> {
  readonly tMacroNs: number;
  readonly frame: FrameFor<S>;
}

/** Options for `new TimelineRecorder(schema, opts)`. */
export interface TimelineRecorderOptions<S extends Schema<FieldsObject, any>> {
  /** Initial tuple-buffer capacity (doubles on growth). Default 1024. */
  readonly initialCapacity?: number;
  /** Producer epoch in ns — the reference instant `consumerNs(0)` maps to on
   *  replay. Default 0. Stored verbatim in the container header. */
  readonly epochNs?: number;
  /** Timestamp role name to read `tMacroNs` from on `record(frame)`. Defaults
   *  to the schema's default role. Ignored by `recordAt(frame, tMacroNs)`. */
  readonly timestamp?: TimestampRoleOf<S>;
}

// ─── Errors ──────────────────────────────────────────────────────────────

/** Thrown by `deserialize` when the buffer is not a valid timeline container
 *  (bad magic or unsupported format version). */
export class TimelineFormatError extends Error {
  /** Magic / version that was actually read, for diagnostics. */
  readonly actualMagic: number;
  readonly actualVersion: number;
  constructor(message: string, actualMagic: number, actualVersion: number) {
    super(message);
    this.name = "TimelineFormatError";
    this.actualMagic = actualMagic;
    this.actualVersion = actualVersion;
  }
}

/** Thrown by `deserialize` when the container's schema tag (or frameByteSize
 *  cross-check) does not match the schema passed in. */
export class TimelineSchemaMismatchError extends Error {
  readonly expectedSchemaTag: number;
  readonly actualSchemaTag: number;
  readonly expectedFrameByteSize: number;
  readonly actualFrameByteSize: number;
  constructor(
    message: string,
    expectedSchemaTag: number,
    actualSchemaTag: number,
    expectedFrameByteSize: number,
    actualFrameByteSize: number,
  ) {
    super(message);
    this.name = "TimelineSchemaMismatchError";
    this.expectedSchemaTag = expectedSchemaTag;
    this.actualSchemaTag = actualSchemaTag;
    this.expectedFrameByteSize = expectedFrameByteSize;
    this.actualFrameByteSize = actualFrameByteSize;
  }
}

// ─── Schema tag (FNV-1a 32-bit over canonical describeSchemaLayout JSON) ────

/** Canonicalize the schema's layout to a stable string. `describeSchemaLayout`
 *  builds the field record in `compiled.fields` order, so `JSON.stringify` of
 *  it is already deterministic for a given schema. We hash that string. */
function canonicalSchemaJson(
  schema: Schema<FieldsObject, any>,
): string {
  return JSON.stringify(describeSchemaLayout(schema));
}

/** FNV-1a 32-bit hash of a UTF-16-as-bytes view of the string. Endianness of
 *  the per-char split is irrelevant — the hash is internal-only and only ever
 *  compared against itself (the same function recomputed on the read side). */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h ^= c & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (c >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function schemaTagOf(schema: Schema<FieldsObject, any>): number {
  return fnv1a32(canonicalSchemaJson(schema));
}

// ─── Internal frame snapshot codec ─────────────────────────────────────────
//
// Generalized from MessageChannelBridge._encodeFrame / _decodeFrame: the same
// DataView little-endian field walk, but parameterized by a base byte offset
// so K snapshots pack contiguously into one ArrayBuffer with no per-frame
// allocation on the read side.

function writeScalar(
  dv: DataView,
  off: number,
  kind: FieldKind,
  val: unknown,
): void {
  switch (kind) {
    case "u64": dv.setBigUint64(off, val as bigint, true); break;
    case "i64": dv.setBigInt64(off, val as bigint, true); break;
    case "f64": dv.setFloat64(off, val as number, true); break;
    case "u32": dv.setUint32(off, val as number, true); break;
    case "i32": dv.setInt32(off, val as number, true); break;
    case "f32": dv.setFloat32(off, val as number, true); break;
    case "u16": dv.setUint16(off, val as number, true); break;
    case "i16": dv.setInt16(off, val as number, true); break;
    case "u8":  dv.setUint8(off, val as number); break;
    case "i8":  dv.setInt8(off, val as number); break;
  }
}

function readScalar(
  dv: DataView,
  off: number,
  kind: FieldKind,
): bigint | number {
  switch (kind) {
    case "u64": return dv.getBigUint64(off, true);
    case "i64": return dv.getBigInt64(off, true);
    case "f64": return dv.getFloat64(off, true);
    case "u32": return dv.getUint32(off, true);
    case "i32": return dv.getInt32(off, true);
    case "f32": return dv.getFloat32(off, true);
    case "u16": return dv.getUint16(off, true);
    case "i16": return dv.getInt16(off, true);
    case "u8":  return dv.getUint8(off);
    case "i8":  return dv.getInt8(off);
  }
}

/** Encode `frame`'s fields into `buf` at `base + field.byteOffset`. */
function encodeFrameInto(
  fields: readonly CompiledField[],
  frame: Record<string, unknown>,
  buf: ArrayBuffer,
  base: number,
): void {
  const dv = new DataView(buf);
  for (const f of fields) {
    if (f.isArray) {
      const src = frame[f.name] as ArrayBufferView;
      const dst = new Uint8Array(buf, base + f.byteOffset, src.byteLength);
      const srcBytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
      dst.set(srcBytes);
    } else {
      writeScalar(dv, base + f.byteOffset, f.kind, frame[f.name]);
    }
  }
}

/** Decode fields from `buf` at `base + field.byteOffset` into `frame`. */
function decodeFrameInto(
  fields: readonly CompiledField[],
  frame: Record<string, unknown>,
  buf: ArrayBuffer,
  base: number,
): void {
  const dv = new DataView(buf);
  for (const f of fields) {
    if (f.isArray) {
      const dst = frame[f.name] as ArrayBufferView;
      const srcBytes = new Uint8Array(buf, base + f.byteOffset, dst.byteLength);
      const dstBytes = new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength);
      dstBytes.set(srcBytes);
    } else {
      frame[f.name] = readScalar(dv, base + f.byteOffset, f.kind);
    }
  }
}

/** Read a frame's `tMacroNs` from a resolved timestamp role, Number()-coercing
 *  bigint roles (u64/i64) the same way Bridge does. */
function readRoleNs(
  frame: Record<string, unknown>,
  timestamps: SchemaTimestampsSpec,
  roleName: string,
): number {
  const role = timestamps.roles[roleName];
  if (role === undefined) {
    throw new Error(
      `TimelineRecorder: schema has no timestamp role '${roleName}'. ` +
        `Available roles: ${Object.keys(timestamps.roles).join(", ") || "(none)"}`,
    );
  }
  const raw = frame[role.field];
  return role.isBigInt ? Number(raw as bigint) : (raw as number);
}

// ─── TimelineRecorder ──────────────────────────────────────────────────────

export class TimelineRecorder<S extends Schema<FieldsObject, any>> {
  /** The schema being recorded. */
  readonly schema: S;
  /** Producer epoch (ns) written to the container header. */
  readonly epochNs: number;

  private readonly fields: readonly CompiledField[];
  private readonly frameByteSize: number;
  private readonly roleName: string | null;

  // Growable parallel arrays: ascending times + one snapshot ArrayBuffer per
  // tuple. Heap-only — no SAB, no Atomics.
  private times: number[];
  private snapshots: ArrayBuffer[];
  private _length: number;

  constructor(schema: S, opts: TimelineRecorderOptions<S> = {}) {
    if (schema.invariant !== null) {
      throw new TypeError(
        "TimelineRecorder: schemas with .withInvariant(...) are not supported. " +
          "The invariant lane is a SAB-header concern with no meaning for an " +
          "offline snapshot. Use a plain schema (without .withInvariant).",
      );
    }
    const initialCapacity = opts.initialCapacity ?? 1024;
    if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
      throw new RangeError(
        `TimelineRecorder: initialCapacity must be a positive integer, got ${initialCapacity}`,
      );
    }
    this.schema = schema;
    this.epochNs = opts.epochNs ?? 0;
    this.fields = schema.compiled.fields;
    this.frameByteSize = schema.frameByteSize;

    if (opts.timestamp !== undefined) {
      if (schema.timestamps === null || schema.timestamps.roles[opts.timestamp] === undefined) {
        throw new Error(
          `TimelineRecorder: schema has no timestamp role '${opts.timestamp}'.`,
        );
      }
      this.roleName = opts.timestamp;
    } else {
      this.roleName = schema.timestamps !== null ? schema.timestamps.defaultRole : null;
    }

    this.times = new Array<number>(initialCapacity);
    this.snapshots = new Array<ArrayBuffer>(initialCapacity);
    this._length = 0;
  }

  /** Number of recorded tuples. */
  get length(): number {
    return this._length;
  }

  /**
   * Capture a pushed frame, reading its macro timestamp from the configured
   * (or default) timestamp role. Throws if the schema carries no timestamp
   * role — use `recordAt(frame, tMacroNs)` for schemas without one.
   *
   * Allocates one snapshot `ArrayBuffer` per call — capture-path cost only.
   * Never call inside an AudioWorklet `process()` loop.
   */
  record(frame: FrameFor<S>): void {
    if (this.roleName === null || this.schema.timestamps === null) {
      throw new Error(
        "TimelineRecorder.record: schema has no timestamp role; pass tMacroNs " +
          "explicitly via recordAt(frame, tMacroNs).",
      );
    }
    const tMacroNs = readRoleNs(
      frame as unknown as Record<string, unknown>,
      this.schema.timestamps,
      this.roleName,
    );
    this.recordAt(frame, tMacroNs);
  }

  /**
   * Capture a pushed frame at an explicit macro timestamp (ns). Times must be
   * monotonic-nondecreasing across calls (the recorder is a step function of
   * producer time); a strictly-decreasing time throws.
   */
  recordAt(frame: FrameFor<S>, tMacroNs: number): void {
    if (!Number.isFinite(tMacroNs)) {
      throw new Error(`TimelineRecorder.recordAt: tMacroNs must be finite, got ${tMacroNs}`);
    }
    if (this._length > 0 && tMacroNs < this.times[this._length - 1]!) {
      throw new Error(
        `TimelineRecorder.recordAt: tMacroNs must be monotonic-nondecreasing; ` +
          `got ${tMacroNs} after ${this.times[this._length - 1]}`,
      );
    }
    if (this._length === this.times.length) this._grow();
    const buf = new ArrayBuffer(this.frameByteSize);
    encodeFrameInto(
      this.fields,
      frame as unknown as Record<string, unknown>,
      buf,
      0,
    );
    this.times[this._length] = tMacroNs;
    this.snapshots[this._length] = buf;
    this._length++;
  }

  /** Discard all recorded tuples (capacity is retained). */
  reset(): void {
    this._length = 0;
  }

  /**
   * Pack the recorded tuples into a compact schema-tagged `ArrayBuffer`
   * container. See the file header for the byte layout. Allocates exactly one
   * `ArrayBuffer` of `32 + K*8 + K*frameByteSize` bytes.
   */
  serialize(): ArrayBuffer {
    const K = this._length;
    const fbs = this.frameByteSize;
    const total = TIMELINE_HEADER_BYTES + K * 8 + K * fbs;
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    dv.setUint32(0, TIMELINE_MAGIC, true);
    dv.setUint32(4, TIMELINE_FORMAT_VERSION, true);
    dv.setUint32(8, 0, true); // flags
    dv.setUint32(12, schemaTagOf(this.schema), true);
    dv.setUint32(16, fbs, true);
    dv.setUint32(20, K, true);
    dv.setFloat64(24, this.epochNs, true);
    const timesBase = TIMELINE_HEADER_BYTES;
    const snapsBase = TIMELINE_HEADER_BYTES + K * 8;
    for (let k = 0; k < K; k++) {
      dv.setFloat64(timesBase + k * 8, this.times[k]!, true);
      const dst = new Uint8Array(buf, snapsBase + k * fbs, fbs);
      dst.set(new Uint8Array(this.snapshots[k]!, 0, fbs));
    }
    return buf;
  }

  private _grow(): void {
    const next = this.times.length * 2;
    this.times.length = next;
    this.snapshots.length = next;
  }
}

// ─── deserialize → TimelinePlayer ──────────────────────────────────────────

/**
 * Parse a timeline container and return a `TimelinePlayer<S>` ready to render.
 * Validates magic + format version (throws `TimelineFormatError`), then
 * recomputes the schema tag from `schema` and cross-checks `frameByteSize`
 * (throws `TimelineSchemaMismatchError` on mismatch). Asserts the stored times
 * are monotonic-nondecreasing.
 */
export function deserialize<S extends Schema<FieldsObject, any>>(
  buf: ArrayBuffer,
  schema: S,
): TimelinePlayer<S> {
  if (buf.byteLength < TIMELINE_HEADER_BYTES) {
    throw new TimelineFormatError(
      `deserialize: buffer too small (${buf.byteLength} bytes) for a timeline header`,
      0,
      0,
    );
  }
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  if (magic !== TIMELINE_MAGIC) {
    throw new TimelineFormatError(
      `deserialize: bad magic 0x${magic.toString(16)} (expected 0x${TIMELINE_MAGIC.toString(16)})`,
      magic,
      version,
    );
  }
  if (version !== TIMELINE_FORMAT_VERSION) {
    throw new TimelineFormatError(
      `deserialize: unsupported format version ${version} (this build reads ${TIMELINE_FORMAT_VERSION})`,
      magic,
      version,
    );
  }

  const actualSchemaTag = dv.getUint32(12, true);
  const actualFrameByteSize = dv.getUint32(16, true);
  const expectedSchemaTag = schemaTagOf(schema);
  const expectedFrameByteSize = schema.frameByteSize;
  if (
    actualSchemaTag !== expectedSchemaTag ||
    actualFrameByteSize !== expectedFrameByteSize
  ) {
    throw new TimelineSchemaMismatchError(
      `deserialize: schema tag / frameByteSize mismatch — the container was ` +
        `recorded against a different schema (expected tag ` +
        `0x${expectedSchemaTag.toString(16)} / ${expectedFrameByteSize}B, got ` +
        `0x${actualSchemaTag.toString(16)} / ${actualFrameByteSize}B)`,
      expectedSchemaTag,
      actualSchemaTag,
      expectedFrameByteSize,
      actualFrameByteSize,
    );
  }

  const K = dv.getUint32(20, true);
  const epochNs = dv.getFloat64(24, true);
  const fbs = actualFrameByteSize;
  const expectedBytes = TIMELINE_HEADER_BYTES + K * 8 + K * fbs;
  if (buf.byteLength < expectedBytes) {
    throw new TimelineFormatError(
      `deserialize: buffer truncated — ${buf.byteLength} bytes, expected ${expectedBytes} ` +
        `for ${K} tuples of ${fbs}B`,
      magic,
      version,
    );
  }

  const fields = schema.compiled.fields;
  const timesBase = TIMELINE_HEADER_BYTES;
  const snapsBase = TIMELINE_HEADER_BYTES + K * 8;
  const tuples: Array<TimelineTuple<S>> = new Array(K);
  let prevT = -Infinity;
  for (let k = 0; k < K; k++) {
    const t = dv.getFloat64(timesBase + k * 8, true);
    if (t < prevT) {
      throw new TimelineFormatError(
        `deserialize: times not monotonic-nondecreasing at tuple ${k} (${t} < ${prevT})`,
        magic,
        version,
      );
    }
    prevT = t;
    const frame = buildScratchFrame(fields) as FrameFor<S>;
    decodeFrameInto(
      fields,
      frame as unknown as Record<string, unknown>,
      buf,
      snapsBase + k * fbs,
    );
    tuples[k] = { tMacroNs: t, frame };
  }

  return new TimelinePlayer<S>(schema, tuples, epochNs);
}

// ─── TimelinePlayer ────────────────────────────────────────────────────────

export class TimelinePlayer<S extends Schema<FieldsObject, any>> {
  /** The schema being replayed. */
  readonly schema: S;
  /** Producer epoch (ns); `consumerNs(0)` maps to this instant. */
  readonly epochNs: number;
  /** The recorded tuples in ascending-time order. */
  readonly tuples: ReadonlyArray<TimelineTuple<S>>;

  private readonly fields: readonly CompiledField[];
  private _rate: number;

  constructor(schema: S, tuples: ReadonlyArray<TimelineTuple<S>>, epochNs: number) {
    this.schema = schema;
    this.tuples = tuples;
    this.epochNs = epochNs;
    this.fields = schema.compiled.fields;
    this._rate = 48000;
  }

  /** Set the replay sample rate (Hz). Determines `consumerNs(n)` spacing. */
  setSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`TimelinePlayer.setSampleRate: rate must be positive finite, got ${rate}`);
    }
    this._rate = rate;
  }

  /** The current replay sample rate (Hz). */
  get sampleRate(): number {
    return this._rate;
  }

  /**
   * Build a reusable evaluated-frame view. Trajectory array fields are sized to
   * their evaluated sample count (`trajectory.sampleCount`), NOT the stored
   * flat length (`sampleCount * order`); non-trajectory arrays keep their
   * declared length; scalars are zero-initialized. Allocate once, reuse across
   * `evaluateAtSample` / `renderInto` calls.
   */
  scratchFrame(): FrameFor<S> {
    const out: Record<string, unknown> = {};
    for (const f of this.fields) {
      if (f.isArray) {
        const len = f.trajectory ? f.trajectory.sampleCount : f.length;
        out[f.name] = newTypedArrayOfKind(f.kind, len);
      } else {
        out[f.name] = isBigIntKind(f.kind) ? 0n : 0;
      }
    }
    return out as FrameFor<S>;
  }

  /** Total number of samples spanned by the recording at the current rate:
   *  `ceil((tMacroNs_last - epochNs)/1e9 * rate) + 1`. Zero tuples → 0. */
  totalSamples(): number {
    if (this.tuples.length === 0) return 0;
    const last = this.tuples[this.tuples.length - 1]!.tMacroNs;
    const span = (last - this.epochNs) * 1e-9 * this._rate;
    return Math.max(0, Math.ceil(span)) + 1;
  }

  /** The deterministic synthesized consumer clock: `epochNs + (n/rate)*1e9`. */
  consumerNs(n: number): number {
    return this.epochNs + (n / this._rate) * 1e9;
  }

  /**
   * Deterministically evaluate the control signal at sample `n` into `out`.
   * Selects the newest tuple with `tMacroNs <= consumerNs(n)` (step-function
   * hold), computes `dt_s = (consumerNs(n) - tMacroNs_k) * 1e-9`, and runs the
   * pure Taylor evaluator per trajectory field — exactly the live
   * `evaluateAtSampleOffset` math minus the PLL `phaseLockedTime` step. Before
   * the first tuple's time, the first tuple is held (dt may be negative,
   * which the evaluator extrapolates backward deterministically).
   *
   * Non-trajectory fields (scalars, plain arrays, order-1 trajectories) are
   * copied verbatim from the selected snapshot.
   */
  evaluateAtSample(out: FrameFor<S>, n: number): void {
    const idx = this._selectTuple(this.consumerNs(n));
    this._evaluateTupleInto(out, idx, this.consumerNs(n));
  }

  /**
   * Render `sampleCount` samples starting at `startSample` into the reusable
   * `frame`, invoking `callback(absoluteSampleIndex, frame)` once per sample.
   * Uses a monotone cursor over the tuples so the whole render is
   * O(sampleCount + tuplesCrossed), not O(sampleCount · log tuples).
   */
  renderInto(
    frame: FrameFor<S>,
    startSample: number,
    sampleCount: number,
    callback: (sampleIdx: number, frame: FrameFor<S>) => void,
  ): void {
    const tuples = this.tuples;
    if (tuples.length === 0) return;
    // Advance the cursor to the newest tuple at or before startSample.
    let cursor = this._selectTuple(this.consumerNs(startSample));
    for (let i = 0; i < sampleCount; i++) {
      const n = startSample + i;
      const cNs = this.consumerNs(n);
      // Monotone forward advance: pull cursor up as consumer time crosses
      // later tuples. Times are nondecreasing so this never moves backward.
      while (cursor + 1 < tuples.length && tuples[cursor + 1]!.tMacroNs <= cNs) {
        cursor++;
      }
      this._evaluateTupleInto(frame, cursor, cNs);
      callback(n, frame);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Newest tuple index with `tMacroNs <= cNs`, or 0 if cNs precedes the
   *  first tuple (the first tuple is held). Binary search. */
  private _selectTuple(cNs: number): number {
    const tuples = this.tuples;
    let lo = 0;
    let hi = tuples.length - 1;
    if (hi < 0) return 0;
    if (cNs < tuples[0]!.tMacroNs) return 0;
    // Find rightmost index with tMacroNs <= cNs.
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (tuples[mid]!.tMacroNs <= cNs) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Evaluate tuple `idx`'s snapshot at consumer time `cNs` into `out`. */
  private _evaluateTupleInto(out: FrameFor<S>, idx: number, cNs: number): void {
    const tuple = this.tuples[idx];
    if (tuple === undefined) return;
    const srcFrame = tuple.frame as unknown as Record<string, unknown>;
    const dstFrame = out as unknown as Record<string, unknown>;
    const dtS = (cNs - tuple.tMacroNs) * 1e-9;
    for (const f of this.fields) {
      const src = srcFrame[f.name];
      if (f.trajectory && f.trajectory.order >= 2) {
        // Forward-in-time Taylor extrapolation, bit-identical across runs.
        // f32 vs f64 dispatch keeps the evaluator's element-write truncation
        // matched to the field's storage kind.
        if (f.kind === "f32") {
          evaluateTrajectoryInto(
            src as Float32Array,
            f.trajectory,
            dtS,
            dstFrame[f.name] as Float32Array,
          );
        } else {
          evaluateTrajectoryInto(
            src as Float64Array,
            f.trajectory,
            dtS,
            dstFrame[f.name] as Float64Array,
          );
        }
      } else if (f.isArray) {
        // Order-1 trajectory or plain array — hold the stored samples.
        const dst = dstFrame[f.name] as ArrayBufferView;
        const srcView = src as ArrayBufferView;
        const dstBytes = new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength);
        const srcBytes = new Uint8Array(srcView.buffer, srcView.byteOffset, Math.min(srcView.byteLength, dst.byteLength));
        dstBytes.set(srcBytes);
      } else {
        // Scalar — hold the stored value.
        dstFrame[f.name] = src;
      }
    }
  }
}

// ─── Small local typed-array helpers (player scratch sizing) ───────────────

function isBigIntKind(kind: FieldKind): boolean {
  return kind === "u64" || kind === "i64";
}

function newTypedArrayOfKind(kind: FieldKind, length: number): ArrayBufferView {
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
