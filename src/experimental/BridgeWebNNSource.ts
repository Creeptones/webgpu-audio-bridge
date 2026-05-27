/**
 * BridgeWebNNSource<Schema> — experimental WebNN adapter (0.7.16, Track 5).
 *
 * Lives under `src/experimental/` to make the API-stability contract
 * explicit: the WebNN spec is volatile (W3C Candidate Recommendation as
 * of 2026-05, Chrome behind `chrome://flags/#web-machine-learning-api`,
 * Safari absent, Firefox in early stages). The shape of this helper
 * may change across MINOR version bumps as the spec stabilizes; the
 * `webgpu-audio-bridge/experimental` subpath is the explicit "outside
 * the 1.0 stability contract" signal.
 *
 * Pattern intent: bridge a WebNN model's output (an `MLTensor`-shaped
 * object, or a CPU `Float32Array` fallback) into a `Bridge<S>`
 * schema's lone `f32Array` field. Mirrors `BridgeBlockProducer` for the
 * WebGPU readback path — same schema constraint (exactly one
 * `f32Array`), same auto-increment block-index convention, same
 * `fillScalars` hook.
 *
 *   const bridge = new Bridge(sab, capacity, mySchema);
 *   const source = new BridgeWebNNSource(bridge, {
 *     blockIndexField: 'frameId',
 *   });
 *
 *   // Async path — MLTensor (requires a WebNN-enabled environment).
 *   // `pushFromTensor` reads the tensor's bytes via `tensor.read()`
 *   // (or the optional `tensorReader` override), copies into the
 *   // schema's samples field, and pushes through the bridge:
 *   await source.pushFromTensor(modelOutputTensor);
 *
 *   // Sync path — typed-array fallback. Works ANYWHERE (no WebNN
 *   // dependency on this code path); useful for CPU-side models or
 *   // transitional code while WebNN stabilizes:
 *   source.pushFromTypedArray(cpuFloat32Samples);
 *
 * ─── Construction gate ──────────────────────────────────────────────────
 *
 * The constructor throws when `globalThis.MLTensor` is not a function:
 *
 *     Error: BridgeWebNNSource: WebNN not available in this
 *     environment (globalThis.MLTensor is not a function). Enable
 *     `chrome://flags/#web-machine-learning-api` in Chrome, or check
 *     `BridgeWebNNSource.isAvailable()` before construction.
 *
 * The gate is interface-presence (`typeof globalThis.MLTensor ===
 * 'function'`), NOT UA detection. Use the static
 * `BridgeWebNNSource.isAvailable()` method as a non-throwing probe.
 * The 0.7.17 patch adds `webnn` + `mlTensor` capability flags to
 * `getEnvironmentReport()` for callers who want the report-style API.
 *
 * Note that the gate fires on the CLASS, not the `pushFromTypedArray`
 * method — if you only want the typed-array path, you don't need this
 * helper at all; `bridge.push({ samples: cpuFloat32, ... })` is the
 * direct call.
 *
 * ─── Schema constraint (mirrors BridgeBlockProducer) ────────────────────
 *
 * The bridge schema must declare EXACTLY ONE `f32Array` field — the
 * samples block. Additional scalar fields are honored:
 *
 *   - `opts.blockIndexField` resolves a `u64` scalar to auto-increment
 *     on every successful push. Resolution rules match
 *     `BridgeBlockProducer`:
 *
 *       null            — disable the auto-increment.
 *       'name'          — name of a u64 scalar; throws if absent / wrong kind.
 *       undefined       — default; uses 'blockIndex' iff present as a u64
 *                         scalar, otherwise no auto-increment.
 *
 *   - `opts.fillScalars` runs once per successful push, AFTER the
 *     samples are copied and AFTER the block index is incremented,
 *     so the hook sees the new index value.
 *
 * Multi-channel schemas are not supported by this helper. Pick a
 * downstream split (one bridge per channel) or layer a custom adapter.
 *
 * ─── Wire compatibility ─────────────────────────────────────────────────
 *
 * Zero. Heap-side helper that composes the public `Bridge<S>` push
 * surface (`beginPush` / `commitPush`); no SAB byte change, no schema
 * extension. A bridge fed via `BridgeWebNNSource` is bit-for-bit
 * interoperable with one fed by a hand-rolled push loop performing the
 * same `Float32Array.set` + scalar assignment + push.
 *
 * ─── Stability contract ─────────────────────────────────────────────────
 *
 * Outside the 1.0 stability contract. The class may break across
 * MINOR version bumps (e.g. `0.7.x → 0.8.0`) — and, while the WebNN
 * spec is still moving, across PATCH releases as well — as the spec
 * stabilizes. The export path is `webgpu-audio-bridge/experimental` to
 * make the opt-in explicit.
 *
 * Starting at 0.8.12 the constructor also emits a one-shot
 * `console.warn` to make the experimental status visible at runtime
 * (the `@experimental` JSDoc only fires in IDEs). The warn fires at
 * most once per process load via a module-global guard; the runtime
 * cost at steady state is one branch on a module-private boolean.
 *
 * Graduation criteria (when the experimental tag comes off, see
 * README §Experimental — WebNN for the canonical list):
 *
 *   - WebNN spec reaches W3C Recommendation status (the W3C-level
 *     stability commitment, beyond the current Candidate Recommendation).
 *   - At least two of {Chrome, Firefox, Safari/WebKit} ship `MLTensor`
 *     in a non-flagged stable channel.
 *   - The byte-read API (`tensor.read()` vs `context.readTensor(tensor)`)
 *     settles at a single shape in the spec text.
 *
 * Until all three trip, the export stays under `experimental/` and
 * the runtime warn fires.
 */

import type { Bridge } from "../Bridge.js";
import type { BridgeProducer } from "../BridgeProducer.js";
import type {
  FieldsObject,
  FrameFor,
  Schema,
} from "../schema.js";

// ── WebNN structural typing ─────────────────────────────────────────────
//
// The WebNN spec exposes `MLTensor` as a global class with a `read()`
// method that resolves to an `ArrayBuffer` (the precise spec text is
// evolving — some implementations expose the read on the
// `MLContext.readTensor(tensor)` instead). The structural type below
// matches the simplest shape and the user can pass a custom
// `tensorReader` to bridge implementations that put the read on the
// context.
//
// Importing `@webnn/types` would tie this file to a particular spec
// snapshot; we keep typing structural and accept the lossy-but-stable
// shape until the spec stabilizes.

/**
 * Structural shape for a WebNN `MLTensor` (or compatible). Imported as
 * an interface so consumers can pass real `MLTensor` instances or
 * test doubles without depending on a particular spec snapshot.
 *
 * @experimental — see file header. Shape may change across minor
 * versions as the WebNN spec stabilizes.
 */
export interface MLTensorLike {
  /** Resolve to an `ArrayBuffer` (or `ArrayBufferView`) carrying the
   *  tensor's current bytes. The shape mirrors what current WebGPU
   *  reference impls expose; if your impl puts the read on the context,
   *  pass `opts.tensorReader` instead and this method is unused. */
  read?: () => Promise<ArrayBuffer | ArrayBufferView>;
  /** Optional cleanup hook (WebNN exposes this on MLTensor). */
  destroy?: () => void;
}

/**
 * User-supplied tensor reader, for impls where the read lives on the
 * context rather than the tensor. The function receives the tensor
 * the caller passed to `pushFromTensor` and resolves to the bytes.
 *
 * @experimental — see file header.
 */
export type WebNNTensorReader = (
  tensor: MLTensorLike,
) => Promise<ArrayBuffer | ArrayBufferView>;

// ── Helper options ──────────────────────────────────────────────────────

/**
 * Construction options for {@link BridgeWebNNSource}.
 *
 * @experimental — see file header.
 */
export interface BridgeWebNNSourceOptions<S extends Schema<FieldsObject, any>> {
  /** Schema field auto-incremented as the block index on every
   *  successful push. Resolution mirrors `BridgeBlockProducer`:
   *
   *    `null`        — disable the auto-increment.
   *    `'name'`      — name of a `u64` scalar field on the schema. Throws
   *                    at construction if the field is missing or not a
   *                    u64 scalar.
   *    `undefined`   — default: use `'blockIndex'` iff the schema has a
   *                    `u64` scalar by that name; otherwise treat as
   *                    `null` (no auto-increment). */
  readonly blockIndexField?: string | null;
  /** Optional per-push hook the caller uses to fill non-sample scalar
   *  fields on the frame (e.g. a producer-side timestamp). Runs once
   *  per successful push, AFTER the samples are copied and AFTER the
   *  block index is incremented (so the hook sees the new value).
   *  Expected allocation-free. */
  readonly fillScalars?: ((frame: FrameFor<S>) => void) | null;
  /** Custom tensor reader for WebNN impls that put the byte-read on the
   *  `MLContext` (`context.readTensor(tensor)`) rather than the tensor
   *  itself. Default: call `tensor.read()`. */
  readonly tensorReader?: WebNNTensorReader;
  /** Escape hatch for testing: skip the `globalThis.MLTensor` presence
   *  gate at construction. Production callers should NOT pass this —
   *  the gate is there to surface a clear error on the wrong runtime.
   *  Test code that wants to exercise the schema-validation paths
   *  without a real WebNN runtime can opt in here. */
  readonly skipAvailabilityCheck?: boolean;
}

// ── Implementation ──────────────────────────────────────────────────────

/** Sniff whether WebNN's `MLTensor` is present on this thread's global. */
function hasMLTensor(): boolean {
  return typeof (globalThis as { MLTensor?: unknown }).MLTensor === "function";
}

const WEBNN_UNAVAILABLE_MESSAGE =
  "BridgeWebNNSource: WebNN not available in this environment " +
  "(globalThis.MLTensor is not a function). Enable " +
  "chrome://flags/#web-machine-learning-api in Chrome, or check " +
  "BridgeWebNNSource.isAvailable() before construction. The " +
  "typed-array fallback (pushFromTypedArray) is available on any " +
  "host, but requires a constructed BridgeWebNNSource instance — " +
  "pass { skipAvailabilityCheck: true } to opt out of the gate for " +
  "test code that needs the fallback path without a WebNN runtime.";

/** Module-global one-shot guard for the experimental-status runtime warning.
 *  Mirrors the pattern used by `Float64RingBuffer` (0.8.11): warn at most
 *  once per process load so an app that constructs multiple sources doesn't
 *  drown stderr; the `@experimental` JSDoc provides the IDE-time signal and
 *  this warn is the runtime backstop for anyone who imported via a
 *  non-typed path. Added 0.8.12 (pre-1.0 cohort, WebNN warning sharpening). */
let _bridgeWebNNSourceExperimentalWarned = false;

/**
 * WebNN MLTensor → Bridge<S> adapter. See file header for full docs.
 *
 * @experimental — lives under `webgpu-audio-bridge/experimental`
 * because the WebNN spec is volatile. Public shape may change across
 * minor versions until the spec stabilizes.
 */
export class BridgeWebNNSource<S extends Schema<FieldsObject, any>> {
  /** The bridge whose push-side this helper feeds. */
  public readonly bridge: Bridge<S> | BridgeProducer<S>;

  /** Samples per push — derived from the schema's lone `f32Array` field. */
  public readonly blockSize: number;

  /** Bytes copied from the tensor / typed array per push. Equal to
   *  `blockSize * 4`. */
  public readonly samplesByteSize: number;

  /** Name of the schema's `f32Array` samples field. */
  public readonly samplesField: string;

  /** Resolved auto-increment field (or `null` if disabled). */
  public readonly blockIndexField: string | null;

  /** Custom tensor reader (optional). When null, defaults to
   *  `tensor.read()`. */
  private readonly tensorReader: WebNNTensorReader | null;

  /** Optional per-push hook (or `null`). */
  private readonly fillScalars: ((frame: FrameFor<S>) => void) | null;

  /** Next block-index value to assign. Increments after each
   *  successful push when `blockIndexField !== null`. */
  private nextBlockIndex: bigint = 0n;

  /** Cumulative successful push counter. */
  private _pushedCount: number = 0;

  /** Cumulative dropped-push counter (ring full at commit time). */
  private _droppedCount: number = 0;

  /** Static non-throwing probe — `true` when `globalThis.MLTensor` is a
   *  function on this thread. Interface-presence sniff, NOT UA
   *  detection. Pairs with `getEnvironmentReport().mlTensor` (0.7.17). */
  static isAvailable(): boolean {
    return hasMLTensor();
  }

  constructor(
    bridge: Bridge<S> | BridgeProducer<S>,
    opts: BridgeWebNNSourceOptions<S> = {},
  ) {
    if (!_bridgeWebNNSourceExperimentalWarned) {
      _bridgeWebNNSourceExperimentalWarned = true;
      console.warn(
        "[webgpu-audio-bridge] BridgeWebNNSource is experimental and " +
        "outside the 1.0 stability contract. The adapter's API may break " +
        "across MINOR version bumps — and, while the WebNN spec is still " +
        "moving, across PATCH releases — until WebNN MLTensor ships in " +
        "≥ 2 stable browsers (Chrome/Firefox/WebKit) and the spec reaches " +
        "W3C Recommendation status. Track https://www.w3.org/TR/webnn/ " +
        "for spec progress; see README §Experimental — WebNN for the full " +
        "graduation criteria.",
      );
    }
    if (opts.skipAvailabilityCheck !== true && !hasMLTensor()) {
      throw new Error(WEBNN_UNAVAILABLE_MESSAGE);
    }

    this.bridge = bridge;
    this.tensorReader = opts.tensorReader ?? null;
    this.fillScalars = opts.fillScalars ?? null;

    // ── Schema validation: exactly one f32Array field ──────────────────
    const fields = bridge.schema.compiled.fields;
    let samplesName: string | null = null;
    let samplesLen = 0;
    let count = 0;
    const candidateNames: string[] = [];
    for (const f of fields) {
      if (f.isArray && f.kind === "f32") {
        count++;
        candidateNames.push(f.name);
        if (count === 1) { samplesName = f.name; samplesLen = f.length; }
      }
    }
    if (count === 0) {
      throw new Error(
        "BridgeWebNNSource: schema must declare exactly one f32Array " +
        "field (the samples block); none found.",
      );
    }
    if (count > 1) {
      throw new Error(
        "BridgeWebNNSource: schema must declare exactly one f32Array " +
        `field (the samples block); found ${count} (${candidateNames.join(", ")}). ` +
        "Multi-channel schemas are not supported by this helper.",
      );
    }
    this.samplesField = samplesName as string;
    this.blockSize = samplesLen;
    this.samplesByteSize = samplesLen * 4;

    // ── Block-index field resolution (mirrors BridgeBlockProducer) ─────
    let resolvedBif: string | null;
    if (opts.blockIndexField === null) {
      resolvedBif = null;
    } else if (typeof opts.blockIndexField === "string") {
      const f = fields.find((x) => x.name === opts.blockIndexField);
      if (f === undefined) {
        throw new Error(
          `BridgeWebNNSource: blockIndexField '${opts.blockIndexField}' ` +
          "not found on schema.",
        );
      }
      if (f.isArray || f.kind !== "u64") {
        throw new Error(
          `BridgeWebNNSource: blockIndexField '${opts.blockIndexField}' ` +
          `must be a u64 scalar (got ${f.kind}${f.isArray ? "Array" : ""}).`,
        );
      }
      resolvedBif = opts.blockIndexField;
    } else {
      const f = fields.find(
        (x) => x.name === "blockIndex" && !x.isArray && x.kind === "u64",
      );
      resolvedBif = f !== undefined ? "blockIndex" : null;
    }
    this.blockIndexField = resolvedBif;
  }

  /**
   * Async push from an `MLTensor`-shaped object. Reads the tensor's
   * bytes (via `tensor.read()` or the constructor-supplied
   * `tensorReader`), copies into the schema's samples field, optionally
   * bumps the block index, runs `fillScalars`, and pushes through the
   * bridge.
   *
   * Returns `true` if the frame was published, `false` if the ring was
   * full at commit time (consistent with `BridgeBlockProducer`'s
   * `pollCompleted` semantics — the failure is observable via
   * `droppedCount()`). Rejects when the tensor read itself fails.
   */
  async pushFromTensor(tensor: MLTensorLike): Promise<boolean> {
    const raw = await this._readTensor(tensor);
    return this._pushFromBytes(raw);
  }

  /**
   * Sync push from a CPU `Float32Array`. Skips the tensor read entirely.
   * Useful for CPU-side models or transitional code while WebNN
   * stabilizes; works on any host (no WebNN dependency on this code
   * path). The constructor's WebNN presence gate still fires on
   * instantiation — pass `{ skipAvailabilityCheck: true }` to opt out
   * if you only need this method.
   *
   * `samples.length` must be ≥ `blockSize`; samples beyond that index
   * are ignored. A smaller-than-blockSize array throws.
   */
  pushFromTypedArray(samples: Float32Array): boolean {
    if (samples.length < this.blockSize) {
      throw new Error(
        `BridgeWebNNSource.pushFromTypedArray: input length ${samples.length} ` +
        `< blockSize ${this.blockSize}.`,
      );
    }
    return this._pushFromSamples(samples);
  }

  /** Cumulative successful pushes (ring accepted the frame). */
  pushedCount(): number {
    return this._pushedCount;
  }

  /** Cumulative drops (push attempted but ring was full at commit). */
  droppedCount(): number {
    return this._droppedCount;
  }

  /** Current value of the auto-incremented block index (the NEXT
   *  index the helper will write on a successful push). Returns 0n
   *  when `blockIndexField === null`. */
  blockIndex(): bigint {
    return this.nextBlockIndex;
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private async _readTensor(
    tensor: MLTensorLike,
  ): Promise<ArrayBuffer | ArrayBufferView> {
    if (this.tensorReader !== null) {
      return this.tensorReader(tensor);
    }
    if (typeof tensor.read === "function") {
      return tensor.read();
    }
    throw new Error(
      "BridgeWebNNSource: tensor has no `read()` method and no " +
      "`tensorReader` was supplied. Pass `opts.tensorReader` when the " +
      "WebNN impl exposes the byte-read on `MLContext.readTensor` rather " +
      "than on `MLTensor` itself.",
    );
  }

  /** Push helper consuming an ArrayBuffer (or ArrayBufferView) of
   *  exactly `samplesByteSize` bytes of f32. The view is constructed
   *  once and handed to `_pushFromSamples`. */
  private _pushFromBytes(raw: ArrayBuffer | ArrayBufferView): boolean {
    let samples: Float32Array;
    if (raw instanceof Float32Array) {
      samples = raw;
    } else if (ArrayBuffer.isView(raw)) {
      // Some impls return e.g. a Uint8Array view over the bytes; wrap.
      const view = raw as ArrayBufferView;
      samples = new Float32Array(view.buffer, view.byteOffset, this.blockSize);
    } else {
      samples = new Float32Array(raw, 0, this.blockSize);
    }
    return this._pushFromSamples(samples);
  }

  /** Inner push: copies samples into the SAB-backed slot, optionally
   *  bumps blockIndex, runs fillScalars, commits. */
  private _pushFromSamples(samples: Float32Array): boolean {
    const frame = this.bridge.beginPush();
    if (frame === null) {
      this._droppedCount = (this._droppedCount + 1) | 0;
      return false;
    }
    const dst = (frame as unknown as Record<string, unknown>)[this.samplesField] as Float32Array;
    if (samples.length > this.blockSize) {
      // Subarray view limits the copy to the schema's declared length;
      // typed-array .set rejects oversize sources otherwise.
      dst.set(samples.subarray(0, this.blockSize));
    } else {
      dst.set(samples);
    }
    if (this.blockIndexField !== null) {
      (frame as unknown as Record<string, unknown>)[this.blockIndexField] = this.nextBlockIndex;
      this.nextBlockIndex = this.nextBlockIndex + 1n;
    }
    if (this.fillScalars !== null) this.fillScalars(frame);
    this.bridge.commitPush();
    this._pushedCount = (this._pushedCount + 1) | 0;
    return true;
  }
}
