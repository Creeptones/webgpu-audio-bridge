/**
 * BridgeBlockConsumer<Schema> — audio-rate / block-rate consumption helper
 * (0.7.13, Track 3 of the King roadmap, first patch).
 *
 * The companion to `Bridge<S>.pull` for "pure GPU synthesis" — the producer
 * runs a compute shader that writes a block of PCM samples (typically 1024
 * per frame) into the bridge, and the AudioWorklet consumer carves
 * 128-sample quanta from successive blocks on every `process()` call. This
 * helper owns the sample cursor inside the currently checked-out frame and
 * pulls the next frame from the ring on cursor exhaustion, so the worklet
 * never has to think about frame boundaries.
 *
 *   AudioWorklet (consumer side):
 *     const bridge   = new Bridge(sab, capacity, blockSchema);
 *     const consumer = new BridgeBlockConsumer(bridge);
 *     process(_, outputs) {
 *       consumer.process(outputs[0][0]); // 128-sample quantum
 *       return true;
 *     }
 *
 * ─── Schema constraint ───────────────────────────────────────────────────
 *
 * The bridge's schema must declare EXACTLY ONE `f32Array` field — the
 * samples block. Additional scalar fields (block index, timing, etc.) are
 * fine and ignored by the consumer. The block size is taken from the array
 * field's declared length. Schemas with zero or multiple `f32Array` fields
 * throw on construction with a descriptive message. Multi-channel audio
 * rides INSIDE that lone array as interleaved samples — see the "Stereo /
 * multi-channel (0.9.48)" section below; the one-f32Array contract is
 * unchanged.
 *
 *   const blockSchema = defineSchema({
 *     blockIndex: u64(),
 *     samples:    f32Array(1024),
 *   });
 *
 * ─── Underflow policy ────────────────────────────────────────────────────
 *
 * When the consumer is asked to produce N samples but the ring is empty
 * mid-call, two behaviors are configurable at construction:
 *
 *   'zero-fill' (default) — write zeros for the unfilled tail. Matches the
 *      AudioWorklet's standard "return true and emit silence" contract; the
 *      worklet stays alive across transient producer stalls.
 *
 *   'hold-last' — repeat the most recently produced sample for the
 *      unfilled tail. Smoother audible degradation under brief glitches at
 *      the cost of a flat-line artifact under prolonged underflow. On the
 *      very first call (no samples produced yet) `hold-last` repeats zero.
 *
 * Underflow events accumulate on `underflowSamples()` regardless of policy
 * for telemetry / diagnostics. Use `framesConsumed()` for the symmetric
 * "frames successfully pulled" counter.
 *
 * Note for callers porting from pre-0.9.0: the third policy `'throw'`
 * (deprecated at 0.8.11) was removed at 0.9.0. An unhandled throw from
 * AudioWorklet `process()` permanently terminates the processor — bug-
 * shaped semantics for a "production" policy choice. Tests that want
 * strict-fail-on-underflow should construct with `'zero-fill'` and observe
 * `underflowSamples()` after each `process()` call, throwing from caller
 * code when the counter advances. See CHANGELOG `[0.9.0]` for the
 * migration pattern.
 *
 * ─── Cursor + checkout discipline ─────────────────────────────────────────
 *
 * The consumer owns one scratch frame (allocated via `bridge.scratchFrame()`
 * at construction) and one integer cursor in `[0, blockSize]`. The
 * lifecycle is:
 *
 *   - `cursor < blockSize`: a frame is checked out and has samples left.
 *     The next `process()` call drains from the cursor without pulling.
 *   - `cursor === blockSize` (or no frame ever checked out): the next
 *     `process()` call pulls a fresh frame; on success cursor → 0 and
 *     `framesConsumed` increments, on failure the underflow path runs.
 *
 * `reset()` discards the in-flight frame and cursor — the next `process()`
 * call pulls fresh. This is the right shape for stop/restart events
 * (AudioContext.suspend / resume, transport rewind). The discarded frame's
 * unread tail is permanently lost from the consumer's perspective; the
 * ring keeps its next-newest frame for the upcoming pull.
 *
 * ─── Latency floor ───────────────────────────────────────────────────────
 *
 * Block-rate consumption is inherently higher-latency than control-rate.
 * A ring depth of D frames at blockSize B samples and sample rate R Hz
 * carries a worst-case input-to-audible delay of `D * B / R` seconds — at
 * D=3, B=1024, R=48000 that's 64 ms; at D=4 it's 85 ms. This is the
 * floor, not a target — use the smallest ring depth that survives your
 * producer-side jitter. The README's "Audio-rate mode" section documents
 * the math; this helper does not try to compensate for the floor.
 *
 * ─── Hybrid residual-on-carrier mode (0.9.41) ────────────────────────────
 *
 * `processAdd(out, gain?, count?)` is the additive sibling of `process()`.
 * Instead of REPLACING `out`, it SUMS `gain * sample[i]` into `out[i]`.
 * Pattern: the AudioWorklet generates a cheap CPU "carrier" (e.g. a
 * sawtooth at slider-controlled freq, zero latency by construction) into
 * `out`, then calls `processAdd` to fold the GPU-computed "residual" (a
 * spectrally rich layer that benefits from GPU parallelism) on top.
 *
 * The hybrid is **strictly more glitch-tolerant than `process()`**: when
 * the ring runs dry mid-call, `processAdd` LEAVES the unfilled tail of
 * `out` untouched (the carrier survives). Pure-replace `process()` has to
 * pick between zero-fill (audible click) and hold-last (audible flat-line).
 * Hybrid mode degrades by "the residual fades out" — audibly, the timbre
 * thins, the fundamental keeps going.
 *
 * Latency story: the carrier's latency is the AudioWorklet quantum
 * (~2.7 ms @ 128 samples + render-buffer headroom). The residual's
 * latency is the block-mode floor above (~85 ms at D=4). Combined: the
 * fundamental responds instantly to control changes; the residual lags.
 * Since the residual is typically a slow-varying spectral layer (drones,
 * pads, harmonic content), the human ear does not lock onto its phase
 * — the audible latency is the carrier's.
 *
 * Telemetry: `processAdd` updates `framesConsumed` and `underflowSamples`
 * identically to `process()`. The semantic difference is what happens to
 * `out` on underflow, not what gets counted.
 *
 * ─── Stereo / multi-channel (0.9.48) ──────────────────────────────────────
 *
 * Multi-channel audio is carried INTERLEAVED inside the lone `f32Array`:
 * for `channels = C` and per-channel `blockSize = B`, the frame is
 * `[ch0[0], ch1[0], …, ch{C-1}[0], ch0[1], …]` — i.e. `f32Array(C * B)`.
 * The sample for channel `c` at per-channel index `j` is at flat index
 * `j*C + c`. **The cursor walks per-channel-sample units in `[0, blockSize]`,
 * exactly as in mono** (mono is `C = 1`, where `j*1+0 = j`). `this.blockSize`
 * is therefore PER-CHANNEL.
 *
 * Because an interleaved schema still declares exactly one `f32Array`, the
 * construction contract, the wire format, and `BridgeBlockProducer` are all
 * unchanged — the producer copies the lone array's full `C*B` length and the
 * feature is entirely consumer-side cursor arithmetic. A `channels`-omitted /
 * `channels: 1` consumer is bit-for-bit the legacy mono path.
 *
 * Two additive methods consume channels:
 *
 *   - `processAddChannel(out, channelIndex, gain?, count?)` — mixes ONE
 *     channel and ADVANCES THE CURSOR. The right primitive for a one-channel-
 *     per-consumer topology or sequential consumption.
 *   - `processAddStereo(left, right, gain?, count?)` — mixes channel 0 → left
 *     AND channel 1 → right from the SAME window and advances the cursor ONCE.
 *     The atomic "render one stereo quantum" op.
 *
 * The cursor-advance contract is load-bearing: `processAddStereo` is NOT
 * `processAddChannel(left,0)` + `processAddChannel(right,1)` — the latter
 * advances the cursor twice and reads two consecutive windows, desyncing L
 * from R. To render multiple channels of one time window you MUST read them
 * from one window and advance once.
 *
 * Carrier survives PER CHANNEL: one interleaved frame is one ring pull, so
 * all channels underflow together. On ring-empty, both methods leave the
 * unfilled tail of EVERY output buffer untouched. `framesConsumed()` counts
 * ring pulls regardless of channel count; `underflowSamples()` counts
 * per-channel window samples (cursor units), so a stereo underflow of K
 * window samples adds K (not 2K).
 *
 * Legacy `process()` / `processAdd()` take no channel index and THROW under
 * `channels > 1` (no silent wrong-channel audio). `'planar'` layout and
 * `processAddChannels(outs[])` for N>2-in-one-quantum are reserved / deferred.
 *
 * ─── Underflow telemetry + graceful degradation (0.9.51) ─────────────────
 *
 * On top of the cumulative `underflowSamples()` / `framesConsumed()` counters,
 * three windowed, audio-domain getters surface HOW BADLY and HOW RECENTLY the
 * ring is starving — the observability half of "the residual thins before it
 * glitches":
 *
 *   - `underflowRate(windowMs)` — fraction in [0,1] of per-channel window
 *     samples that took the underflow path over the last `windowMs`.
 *   - `lastSuccessfulPullTime()` / `elapsedSeconds()` — the audio-domain time
 *     of the last successful pull and "now"; their difference is the stall age.
 *
 * All three are **pure polling getters**: no timer, no `Atomics.wait`, no
 * allocation on the audio thread — worklet-safe by construction (the role
 * lattice forbids timers on the worklet handle; this helper is role-agnostic,
 * so it stays getter-only). They derive from an audio-sample clock
 * (`samplesEmitted / sampleRate`), NOT `performance.now()` — which is not
 * reliably exposed in `AudioWorkletGlobalScope`. Pass `sampleRate` at
 * construction (it is in the worklet's global scope) to enable them.
 *
 * The producer side acts on these via `ResidualQualityController` (see
 * `src/ResidualQualityController.ts`): under sustained underflow it lowers a
 * `suggestedQualityScale` the GPU worker maps to its own knobs (harmonic count,
 * workgroup count, oversampling) so the residual SIMPLIFIES rather than
 * glitches. The first ship derives the controller's input from the existing
 * `flow_scale` backpressure lane (zero new wire); this getter's measured rate
 * is the more-faithful follow-up signal carried over a dedicated back-channel.
 *
 * ─── Wire compatibility ──────────────────────────────────────────────────
 *
 * Zero change. BridgeBlockConsumer composes a `Bridge<S>` instance via its
 * public API (`bridge.pull` + `bridge.scratchFrame`) and uses the SAB
 * layout exactly as the bridge does. No SAB byte change, no schema
 * extension, no protocol change. A bridge driven through `BridgeBlockConsumer`
 * is bit-for-bit interoperable with one driven through `bridge.pull`
 * directly.
 */

import type { Bridge } from "./Bridge.js";
import type {
  FieldsObject,
  FrameFor,
  Schema,
} from "./schema.js";

/** Behavior when `process()` asks for more samples than the ring can supply.
 *  See the file header "Underflow policy" section for the audible /
 *  operational tradeoffs of each. */
export type BlockUnderflowPolicy = "zero-fill" | "hold-last";

/** Channel memory layout within the lone `f32Array` samples field (0.9.48).
 *    'mono'        — channels === 1; the legacy path, byte-identical to ≤0.9.47.
 *    'interleaved' — channels ≥ 2 packed L,R,L,R… in ONE f32Array(channels*blockSize).
 *    'planar'      — DEFERRED (throws at construction in 0.9.48). Reserved in the
 *                    type for the future multi-field / multi-ring shape so adding
 *                    it later is non-breaking. */
export type BlockChannelLayout = "mono" | "interleaved" | "planar";

export interface BridgeBlockConsumerOptions {
  /** How `process()` handles a ring-empty event. Default `'zero-fill'`. */
  readonly underflowPolicy?: BlockUnderflowPolicy;
  /** Channel count. Default 1 (mono, legacy). Restricted to standard audio
   *  layouts. */
  readonly channels?: 1 | 2 | 4 | 6 | 8;
  /** Sample layout. Default 'mono' when channels===1, else 'interleaved'
   *  ('planar' throws in 0.9.48). */
  readonly layout?: BlockChannelLayout;
  /** Sample rate in Hz (0.9.51). Enables the ms-based underflow telemetry
   *  getters `underflowRate(windowMs)`, `lastSuccessfulPullTime()`, and
   *  `elapsedSeconds()`. Inside an `AudioWorkletGlobalScope` the global
   *  `sampleRate` is in scope — pass it here. When omitted, the consumer
   *  falls back to `globalThis.sampleRate` if present; if neither is
   *  available the three time-based getters throw a descriptive error.
   *  `framesConsumed()` / `underflowSamples()` / `remainingInFrame()` do
   *  NOT require it. */
  readonly sampleRate?: number;
  /** Maximum history window, in milliseconds, retained for
   *  `underflowRate(windowMs)` (0.9.51). `windowMs` queries are clamped to
   *  this. Default 1000. The history is a fixed-size, preallocated circular
   *  buffer of cumulative `(samplesEmitted, underflowSamples)` marks — no
   *  per-call allocation on the audio thread; the mark stride auto-scales so
   *  the buffer always spans the window regardless of `process()` quantum. */
  readonly underflowWindowMs?: number;
}

/** Number of circular-history mark slots for the underflow-rate window
 *  (0.9.51). Fixed + preallocated; the mark *stride* (in samples) scales to
 *  `underflowWindowMs` so this slot count always covers the window. */
const UNDERFLOW_MARK_CAPACITY = 256;

/** Default `underflowWindowMs` when the option is omitted (0.9.51). */
const DEFAULT_UNDERFLOW_WINDOW_MS = 1000;

export class BridgeBlockConsumer<S extends Schema<FieldsObject, any>> {
  /** The bridge whose pull-side this consumer drives. Exposed so callers can
   *  reach the full `Bridge<S>` surface (telemetry, evaluateInto, etc.)
   *  without holding a second reference. */
  public readonly bridge: Bridge<S>;

  /** PER-CHANNEL samples per block — `arrayLength / channels`. The cursor
   *  walks `[0, blockSize]` in per-channel-sample units (mono is `channels===1`,
   *  where per-channel and flat indices coincide). */
  public readonly blockSize: number;

  /** Name of the schema's `f32Array` samples field. Mostly a diagnostic
   *  surface — the consumer holds a direct typed-array view internally. */
  public readonly samplesField: string;

  /** Underflow policy as resolved at construction. */
  public readonly underflowPolicy: BlockUnderflowPolicy;

  /** Channel count as resolved at construction. Default 1 (mono). For
   *  `channels > 1` the lone `f32Array` is interpreted as interleaved
   *  L,R,… of `channels * blockSize` flat samples. */
  public readonly channels: number;

  /** Channel memory layout as resolved at construction. `'mono'` for
   *  `channels === 1`, `'interleaved'` for `channels > 1`. */
  public readonly layout: BlockChannelLayout;

  /** Sample rate in Hz as resolved at construction (0.9.51), or 0 when no
   *  rate was supplied (constructor opt nor `globalThis.sampleRate`). The
   *  ms-based telemetry getters throw when this is 0. */
  public readonly sampleRate: number;

  /** Max retained underflow-rate history window in ms as resolved at
   *  construction (0.9.51). `underflowRate(windowMs)` clamps to this. */
  public readonly underflowWindowMs: number;

  // ── Internal state ────────────────────────────────────────────────────
  private readonly frame: FrameFor<S>;
  /** Direct view into `frame[samplesField]`. Bound once at construction;
   *  `bridge.pull` mutates the typed array in place, never replaces it. */
  private readonly samples: Float32Array;
  /** Cursor in `[0, blockSize]`. blockSize means "current frame drained,
   *  next process() must pull". */
  private cursor: number;
  /** True iff a frame has been pulled into `this.frame` since the last
   *  reset(). When false, the next process() always enters the pull branch
   *  (even if cursor happens to be 0 from initial / reset state). */
  private hasFrame: boolean;
  /** Most recently produced sample value, used by the 'hold-last' policy.
   *  Initialized to 0 so first-call underflow under 'hold-last' emits silence. */
  private holdSample: number;
  /** Telemetry: total samples written via the underflow path since
   *  construction (or last reset). */
  private _underflowSamples: number;
  /** Telemetry: total frames successfully pulled since construction (or
   *  last reset). */
  private _framesConsumed: number;
  /** Reusable scratch for `_mixWindow`'s (channel → buffer) pairs. Sized for
   *  the max simultaneous outputs (stereo = 2); preallocated so the multi-
   *  channel hot path stays allocation-free on the audio thread. */
  private readonly _outs: (Float32Array | null)[];
  private readonly _chans: number[];

  // ── Underflow telemetry (0.9.51) ──────────────────────────────────────
  /** Cumulative per-channel window samples the consumer has been ASKED to
   *  produce since construction / last reset — i.e. the sum of every
   *  `count` across `process*()` calls. This is the consumer's monotonic
   *  audio-domain clock (it advances by exactly the requested quantum every
   *  call, underflow or not); `elapsedSeconds()` is `_samplesEmitted /
   *  sampleRate`. Same per-channel unit as `_underflowSamples`. */
  private _samplesEmitted: number;
  /** `_samplesEmitted` value at the moment of the most recent SUCCESSFUL
   *  ring pull. Advances on a pull; stalls across an underflow run.
   *  `lastSuccessfulPullTime()` is `_lastPullAtSample / sampleRate`. */
  private _lastPullAtSample: number;
  /** Circular history of cumulative `samplesEmitted` at each stamped mark
   *  (paired with `_marksUnderflow`). Preallocated; never reallocated. */
  private readonly _marksSamples: Float64Array;
  /** Circular history of cumulative `underflowSamples` at each stamped mark. */
  private readonly _marksUnderflow: Float64Array;
  /** Next write slot in the circular mark buffers. */
  private _markHead: number;
  /** Number of valid marks currently stored (≤ UNDERFLOW_MARK_CAPACITY). */
  private _markCount: number;
  /** `_samplesEmitted` at the last stamped mark — a new mark is stamped once
   *  `_samplesEmitted` has advanced by ≥ `_markStride` since this. */
  private _lastMarkSamples: number;
  /** Minimum sample advance between marks (0 when no sampleRate → windowing
   *  unavailable). Scaled so UNDERFLOW_MARK_CAPACITY marks span
   *  `underflowWindowMs`, decoupling buffer size from `process()` cadence. */
  private readonly _markStride: number;

  constructor(bridge: Bridge<S>, opts?: BridgeBlockConsumerOptions) {
    this.bridge = bridge;
    this.underflowPolicy = opts?.underflowPolicy ?? "zero-fill";

    // ── Schema validation: exactly one f32Array field ─────────────────
    const fields = bridge.schema.compiled.fields;
    let samplesField: { name: string; length: number } | null = null;
    let count = 0;
    const candidateNames: string[] = [];
    for (const f of fields) {
      if (f.isArray && f.kind === "f32") {
        count++;
        candidateNames.push(f.name);
        if (count === 1) samplesField = { name: f.name, length: f.length };
      }
    }
    if (count === 0) {
      throw new Error(
        "BridgeBlockConsumer: schema must declare exactly one f32Array " +
        "field (the samples block); none found.",
      );
    }
    if (count > 1) {
      throw new Error(
        `BridgeBlockConsumer: schema must declare exactly one f32Array ` +
        `field (the samples block); found ${count} (${candidateNames.join(", ")}). ` +
        `Multi-channel block schemas are not supported by this helper.`,
      );
    }
    // samplesField is non-null by construction here (count === 1).
    const resolved = samplesField as { name: string; length: number };
    this.samplesField = resolved.name;
    const arrayLength = resolved.length;

    // ── Channel / layout resolution + validation (0.9.48) ─────────────
    const channels = opts?.channels ?? 1;
    if (channels !== 1 && channels !== 2 && channels !== 4 &&
        channels !== 6 && channels !== 8) {
      throw new Error(
        `BridgeBlockConsumer: channels must be one of 1 | 2 | 4 | 6 | 8 ` +
        `(got ${channels}).`,
      );
    }
    const requestedLayout = opts?.layout;
    if (requestedLayout === "planar") {
      throw new Error(
        "BridgeBlockConsumer: planar layout is not implemented in 0.9.48; " +
        "use 'interleaved'.",
      );
    }
    let layout: BlockChannelLayout;
    if (channels === 1) {
      // 'interleaved' with channels:1 is harmless and equals mono — normalize.
      layout = "mono";
    } else {
      if (requestedLayout === "mono") {
        throw new Error(
          `BridgeBlockConsumer: channels>1 requires layout:'interleaved' ` +
          `(got 'mono' with channels ${channels}).`,
        );
      }
      // undefined defaults to 'interleaved'; 'interleaved' passes through.
      layout = "interleaved";
      if (arrayLength % channels !== 0) {
        throw new Error(
          `BridgeBlockConsumer: f32Array length ${arrayLength} is not ` +
          `divisible by channels ${channels}.`,
        );
      }
    }
    this.channels = channels;
    this.layout = layout;
    this.blockSize = arrayLength / channels;

    this.frame = bridge.scratchFrame();
    this.samples = (this.frame as unknown as Record<string, unknown>)[resolved.name] as Float32Array;

    this.cursor = 0;
    this.hasFrame = false;
    this.holdSample = 0;
    this._underflowSamples = 0;
    this._framesConsumed = 0;
    this._outs = [null, null];
    this._chans = [0, 0];

    // ── Underflow telemetry (0.9.51) ──────────────────────────────────
    // Resolve the sample rate: explicit opt wins; else the AudioWorklet
    // global (`globalThis.sampleRate`) if present; else 0 (the ms-based
    // getters throw, but the sample-count counters keep working).
    const optRate = opts?.sampleRate;
    let resolvedRate = 0;
    if (optRate !== undefined) {
      if (!Number.isFinite(optRate) || optRate <= 0) {
        throw new Error(
          `BridgeBlockConsumer: sampleRate must be a positive finite number ` +
          `(got ${optRate}).`,
        );
      }
      resolvedRate = optRate;
    } else {
      const globalRate = (globalThis as { sampleRate?: number }).sampleRate;
      if (typeof globalRate === "number" && Number.isFinite(globalRate) &&
          globalRate > 0) {
        resolvedRate = globalRate;
      }
    }
    this.sampleRate = resolvedRate;

    const windowMs = opts?.underflowWindowMs ?? DEFAULT_UNDERFLOW_WINDOW_MS;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(
        `BridgeBlockConsumer: underflowWindowMs must be a positive finite ` +
        `number (got ${windowMs}).`,
      );
    }
    this.underflowWindowMs = windowMs;

    this._samplesEmitted = 0;
    this._lastPullAtSample = 0;
    this._marksSamples = new Float64Array(UNDERFLOW_MARK_CAPACITY);
    this._marksUnderflow = new Float64Array(UNDERFLOW_MARK_CAPACITY);
    this._markHead = 0;
    this._markCount = 0;
    this._lastMarkSamples = 0;
    // Stride so UNDERFLOW_MARK_CAPACITY marks span `underflowWindowMs`.
    // 0 disables marking (no sampleRate → underflowRate throws anyway).
    this._markStride = resolvedRate > 0
      ? Math.max(
          1,
          Math.floor(
            (windowMs * resolvedRate) / 1000 / (UNDERFLOW_MARK_CAPACITY - 1),
          ),
        )
      : 0;
  }

  /**
   * Fill `out[0 .. count]` with the next `count` PCM samples (default
   * `out.length`). Crosses frame boundaries transparently: on cursor
   * exhaustion the next ring frame is pulled and consumption continues.
   * On ring-empty mid-call the unfilled tail is handled per the
   * configured `underflowPolicy`.
   *
   * Memory ordering matches `bridge.pull` exactly — each successful
   * pull is an acquire-load on the ring's `read_index` lane.
   *
   * Hot-path cost: one `bridge.pull` per `blockSize` samples (so for
   * 1024-sample blocks and 128-sample quanta, one pull per 8 calls);
   * the inter-pull calls are a single `Float32Array.prototype.set` from
   * an internal subarray view into the caller's buffer.
   */
  process(out: Float32Array, count: number = out.length): void {
    if (this.channels > 1) {
      throw new Error(
        `BridgeBlockConsumer.process: ambiguous for channels>1 (channels ` +
        `${this.channels}); use processAddChannel / processAddStereo for ` +
        `multichannel consumers.`,
      );
    }
    if (!Number.isFinite(count) || count < 0 || count > out.length) {
      throw new Error(
        `BridgeBlockConsumer.process: count ${count} out of range [0, ${out.length}]`,
      );
    }
    let written = 0;
    while (written < count) {
      if (!this.hasFrame || this.cursor >= this.blockSize) {
        const ok = this.bridge.pull(this.frame);
        if (!ok) {
          const remaining = count - written;
          this._underflowSamples += remaining;
          this._handleUnderflow(out, written, remaining);
          this._noteEmitted(count);
          return;
        }
        this.cursor = 0;
        this.hasFrame = true;
        this._framesConsumed++;
        this._lastPullAtSample = this._samplesEmitted + written;
      }
      const take = Math.min(count - written, this.blockSize - this.cursor);
      // 0.9.55 — explicit indexed copy instead of out.set(samples.subarray(...)).
      // subarray() allocates a typed-array view object per chunk inside the
      // render loop (≈8 per quantum for a 1024-block / 128-quantum split). The
      // cached-locals loop below is allocation-free, matches the additive paths
      // (processAdd / _mixWindow), and is byte-identical in output.
      const samples = this.samples;
      const cur = this.cursor;
      const off = written;
      for (let i = 0; i < take; i++) {
        out[off + i] = samples[cur + i] as number;
      }
      this.holdSample = samples[cur + take - 1] as number;
      this.cursor += take;
      written += take;
    }
    this._noteEmitted(count);
  }

  /**
   * Additive sibling of `process()`: SUM `gain * next_sample` into
   * `out[i]` rather than overwriting. Designed for the residual-on-carrier
   * hybrid (see file header "Hybrid residual-on-carrier mode").
   *
   * Underflow path: the unfilled tail of `out` is LEFT UNCHANGED — the
   * caller's carrier in that tail survives the GPU-side stall.
   * `underflowSamples()` still increments by the unfilled count for
   * telemetry symmetry with `process()`. The configured `underflowPolicy`
   * field is IGNORED by this method; "leave caller's data alone" is the
   * hybrid mode's underflow semantics by construction.
   *
   * Hot-path cost: one `bridge.pull` per `blockSize` samples (one per 8
   * calls for 1024-block / 128-quantum); the inter-pull body is a single
   * fused-multiply-add over `take` elements, fast path when `gain === 1.0`.
   *
   * @param out    Caller-supplied buffer carrying the carrier. Modified
   *               in place by `out[i] += gain * samples[cursor + i]`.
   * @param gain   Multiplier applied to the residual on the fly. Default 1.
   *               `gain = 0` is a no-op (still pulls + advances cursor +
   *               increments telemetry, which mirrors `process()` advancing
   *               the cursor even when the consumer ignores `out`).
   * @param count  Number of samples to mix. Default `out.length`.
   */
  processAdd(
    out: Float32Array,
    gain: number = 1.0,
    count: number = out.length,
  ): void {
    if (this.channels > 1) {
      throw new Error(
        `BridgeBlockConsumer.processAdd: ambiguous for channels>1 (channels ` +
        `${this.channels}); use processAddChannel / processAddStereo for ` +
        `multichannel consumers.`,
      );
    }
    if (!Number.isFinite(count) || count < 0 || count > out.length) {
      throw new Error(
        `BridgeBlockConsumer.processAdd: count ${count} out of range [0, ${out.length}]`,
      );
    }
    if (!Number.isFinite(gain)) {
      throw new Error(
        `BridgeBlockConsumer.processAdd: gain must be finite (got ${gain})`,
      );
    }
    let written = 0;
    while (written < count) {
      if (!this.hasFrame || this.cursor >= this.blockSize) {
        const ok = this.bridge.pull(this.frame);
        if (!ok) {
          const remaining = count - written;
          this._underflowSamples += remaining;
          // Hybrid mode: leave out[] untouched on underflow. Caller's
          // carrier in the unfilled tail survives the GPU stall.
          this._noteEmitted(count);
          return;
        }
        this.cursor = 0;
        this.hasFrame = true;
        this._framesConsumed++;
        this._lastPullAtSample = this._samplesEmitted + written;
      }
      const take = Math.min(count - written, this.blockSize - this.cursor);
      const samples = this.samples;
      const cur = this.cursor;
      const off = written;
      if (gain === 1.0) {
        for (let i = 0; i < take; i++) {
          out[off + i] = (out[off + i] as number) + (samples[cur + i] as number);
        }
      } else if (gain !== 0.0) {
        for (let i = 0; i < take; i++) {
          out[off + i] = (out[off + i] as number) + gain * (samples[cur + i] as number);
        }
      }
      // gain === 0 path: cursor still advances, telemetry still updates,
      // but `out` is untouched. Useful as a "drain the ring without
      // mixing" toggle (e.g. user mutes the GPU residual layer).
      this.holdSample = samples[cur + take - 1] as number;
      this.cursor += take;
      written += take;
    }
    this._noteEmitted(count);
  }

  /**
   * Additive per-channel mix (0.9.48). SUMS `gain * residual[channelIndex]`
   * into `out[i]` for `count` per-channel samples AT THE CURRENT CURSOR, then
   * advances the cursor by `count` per-channel samples. Returns the number of
   * per-channel samples actually mixed before any underflow (`== count` on a
   * full window).
   *
   * The interleaved frame is `[L0,R0,L1,R1,…]`; the sample for channel `c` at
   * per-channel index `j` lives at flat index `j*channels + c`. The cursor
   * walks per-channel-sample units exactly as in mono.
   *
   * **This advances the cursor on EVERY call.** It is the right primitive for
   * a one-channel-per-consumer topology or sequential consumption — NOT for
   * rendering multiple channels of the same time window. To render L and R of
   * one quantum together (advancing once, from one window) use
   * `processAddStereo` — it is NOT the same as two `processAddChannel` calls,
   * which would advance the cursor twice and desync L from R.
   *
   * Underflow leaves `out`'s unfilled tail UNTOUCHED (hybrid carrier-survives
   * semantics, same as `processAdd`). `underflowSamples()` increments by the
   * unfilled per-channel count.
   *
   * @param out          Caller buffer carrying the carrier; mixed in place.
   * @param channelIndex Integer channel in `[0, channels)`.
   * @param gain         Multiplier on the residual. Default 1. `gain = 0`
   *                     still pulls + advances + counts (drain-without-mix).
   * @param count        Per-channel samples to mix. Default `out.length`.
   */
  processAddChannel(
    out: Float32Array,
    channelIndex: number,
    gain: number = 1.0,
    count: number = out.length,
  ): number {
    if (!Number.isInteger(channelIndex) || channelIndex < 0 ||
        channelIndex >= this.channels) {
      throw new Error(
        `BridgeBlockConsumer.processAddChannel: channelIndex ${channelIndex} ` +
        `out of range [0, ${this.channels})`,
      );
    }
    if (!Number.isFinite(count) || count < 0 || count > out.length) {
      throw new Error(
        `BridgeBlockConsumer.processAddChannel: count ${count} out of range ` +
        `[0, ${out.length}]`,
      );
    }
    if (!Number.isFinite(gain)) {
      throw new Error(
        `BridgeBlockConsumer.processAddChannel: gain must be finite (got ${gain})`,
      );
    }
    this._outs[0] = out;
    this._chans[0] = channelIndex;
    return this._mixWindow(1, gain, count);
  }

  /**
   * Convenience for the common stereo case (0.9.48): mix channel 0 → `left`
   * and channel 1 → `right` from the SAME cursor window, advancing the cursor
   * ONCE by `count`. Requires `channels >= 2`. Returns per-channel samples
   * actually mixed before underflow.
   *
   * This is the atomic "render one stereo quantum" op — reading both channels
   * from a single window keeps L and R sample-locked. It is deliberately NOT
   * expressible as `processAddChannel(left, 0)` + `processAddChannel(right, 1)`,
   * which would advance the cursor twice and read two consecutive windows.
   *
   * Underflow leaves the unfilled tails of BOTH `left` and `right` UNTOUCHED
   * (carrier survives per channel — one interleaved frame is one ring pull, so
   * all channels underflow together). `underflowSamples()` increments by the
   * unfilled per-channel count (NOT doubled).
   *
   * @param left   Channel-0 carrier buffer; mixed in place.
   * @param right  Channel-1 carrier buffer; mixed in place.
   * @param gain   Multiplier on the residual. Default 1. `gain = 0` drains.
   * @param count  Per-channel samples to mix. Default
   *               `Math.min(left.length, right.length)`.
   */
  processAddStereo(
    left: Float32Array,
    right: Float32Array,
    gain: number = 1.0,
    count: number = Math.min(left.length, right.length),
  ): number {
    if (this.channels < 2) {
      throw new Error(
        `BridgeBlockConsumer.processAddStereo: requires channels >= 2 ` +
        `(channels ${this.channels})`,
      );
    }
    if (!Number.isFinite(count) || count < 0 ||
        count > left.length || count > right.length) {
      throw new Error(
        `BridgeBlockConsumer.processAddStereo: count ${count} out of range ` +
        `[0, ${Math.min(left.length, right.length)}]`,
      );
    }
    if (!Number.isFinite(gain)) {
      throw new Error(
        `BridgeBlockConsumer.processAddStereo: gain must be finite (got ${gain})`,
      );
    }
    this._outs[0] = left;
    this._chans[0] = 0;
    this._outs[1] = right;
    this._chans[1] = 1;
    return this._mixWindow(2, gain, count);
  }

  /**
   * Private cursor-advancing window-walker shared by `processAddChannel` and
   * `processAddStereo`. Mixes `nOuts` (channel → buffer) pairs from `this._outs`
   * / `this._chans` from the SAME cursor window, advancing the cursor ONCE by
   * `count` per-channel samples. Returns per-channel samples mixed before any
   * underflow.
   *
   * Crosses frame boundaries transparently. On ring-empty mid-call the
   * unfilled tail of every output buffer is left untouched (carrier survives
   * per channel) and `_underflowSamples` increments by the remaining
   * per-channel count.
   */
  private _mixWindow(nOuts: number, gain: number, count: number): number {
    const C = this.channels;
    let written = 0;
    while (written < count) {
      if (!this.hasFrame || this.cursor >= this.blockSize) {
        const ok = this.bridge.pull(this.frame);
        if (!ok) {
          // Carrier survives: leave every out[] tail untouched.
          this._underflowSamples += count - written;
          this._noteEmitted(count);
          return written;
        }
        this.cursor = 0;
        this.hasFrame = true;
        this._framesConsumed++;
        this._lastPullAtSample = this._samplesEmitted + written;
      }
      const take = Math.min(count - written, this.blockSize - this.cursor);
      const samples = this.samples;
      const cur = this.cursor;
      const off = written;
      if (gain !== 0.0) {
        for (let n = 0; n < nOuts; n++) {
          const out = this._outs[n] as Float32Array;
          const c = this._chans[n] as number;
          if (gain === 1.0) {
            for (let i = 0; i < take; i++) {
              out[off + i] = (out[off + i] as number) +
                (samples[(cur + i) * C + c] as number);
            }
          } else {
            for (let i = 0; i < take; i++) {
              out[off + i] = (out[off + i] as number) +
                gain * (samples[(cur + i) * C + c] as number);
            }
          }
        }
      }
      // gain === 0: cursor still advances, telemetry still updates, outs
      // untouched (drain-without-mix), matching processAdd's contract.
      this.holdSample =
        samples[(cur + take - 1) * C + (this._chans[0] as number)] as number;
      this.cursor += take;
      written += take;
    }
    this._noteEmitted(count);
    return written;
  }

  /** Discard the in-flight frame and reset the cursor. The next `process()`
   *  call pulls a fresh frame from the ring. Telemetry counters
   *  (framesConsumed, underflowSamples) — and the 0.9.51 underflow-rate
   *  history + audio-domain clock — are also zeroed. */
  reset(): void {
    this.cursor = 0;
    this.hasFrame = false;
    this.holdSample = 0;
    this._underflowSamples = 0;
    this._framesConsumed = 0;
    // 0.9.51 telemetry state.
    this._samplesEmitted = 0;
    this._lastPullAtSample = 0;
    this._markHead = 0;
    this._markCount = 0;
    this._lastMarkSamples = 0;
  }

  /** Telemetry: total frames successfully pulled since construction or
   *  last reset(). */
  framesConsumed(): number {
    return this._framesConsumed;
  }

  /** Telemetry: total samples written via the underflow path since
   *  construction or last reset(). */
  underflowSamples(): number {
    return this._underflowSamples;
  }

  /** Samples remaining in the currently checked-out frame, or 0 if no frame
   *  is in flight. Useful for tests / diagnostics; not a hot-path call. */
  remainingInFrame(): number {
    return this.hasFrame ? this.blockSize - this.cursor : 0;
  }

  /**
   * Fraction in `[0, 1]` of per-channel window samples written via the
   * underflow path over the last `windowMs` (0.9.51). `0` = the consumer is
   * keeping up; values toward `1` = the ring is starving and the residual is
   * thinning. Backed by a fixed-size circular history of cumulative
   * `(samplesEmitted, underflowSamples)` marks stamped from inside the
   * `process*()` calls — there is **no timer**; the cadence is the audio
   * quantum (worklet-safe, allocation-free).
   *
   * `windowMs` is clamped to the constructor's `underflowWindowMs`. Requires
   * a resolved `sampleRate` (constructor opt or `globalThis.sampleRate`);
   * throws otherwise. Returns `0` when no samples have been emitted yet or
   * the window contains zero emitted samples.
   *
   * This is the value the producer-side `ResidualQualityController` consumes
   * in Option 2 (the consumer's TRUE measured rate, carried back over a
   * dedicated SAB); Option 1 instead infers it from `flow_scale` saturation
   * without reading this getter. See `docs/underflow-quality-degradation-*`.
   */
  underflowRate(windowMs: number): number {
    const sr = this._requireSampleRate("underflowRate");
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(
        `BridgeBlockConsumer.underflowRate: windowMs must be a positive ` +
        `finite number (got ${windowMs}).`,
      );
    }
    if (this._markCount === 0) return 0;
    const clampedMs = Math.min(windowMs, this.underflowWindowMs);
    const windowSamples = (clampedMs * sr) / 1000;
    const curS = this._samplesEmitted;
    const curU = this._underflowSamples;
    const target = curS - windowSamples;
    // Marks are chronological starting at the oldest valid slot. Walk forward
    // and keep the latest mark still at/before `target` (so the measured span
    // is as close to `windowSamples` as the history allows); fall back to the
    // oldest available mark when the whole history is newer than `target`.
    const cap = UNDERFLOW_MARK_CAPACITY;
    const oldest = (this._markHead - this._markCount + cap) % cap;
    let chosenS = this._marksSamples[oldest] as number;
    let chosenU = this._marksUnderflow[oldest] as number;
    for (let k = 1; k < this._markCount; k++) {
      const idx = (oldest + k) % cap;
      const s = this._marksSamples[idx] as number;
      if (s <= target) {
        chosenS = s;
        chosenU = this._marksUnderflow[idx] as number;
      } else {
        break;
      }
    }
    const dS = curS - chosenS;
    if (dS <= 0) return 0;
    let rate = (curU - chosenU) / dS;
    if (rate < 0) rate = 0;
    else if (rate > 1) rate = 1;
    return rate;
  }

  /**
   * The consumer's audio-domain time, in SECONDS, of the most recent
   * SUCCESSFUL ring pull (0.9.51): `samplesEmittedAtThatPull / sampleRate`.
   * Monotonic from construction / `reset()`; resets to 0 on `reset()`.
   *
   * This is **NOT** a wall clock — the AudioWorklet scope has no reliable
   * `performance.now()` (see the handoff note), so staleness is measured in
   * the exact, monotonic audio-sample domain. Pair with `elapsedSeconds()`:
   * `elapsedSeconds() − lastSuccessfulPullTime()` is the stall age (how long,
   * in audio time, since the ring last delivered a frame). Requires a
   * resolved `sampleRate`; throws otherwise.
   */
  lastSuccessfulPullTime(): number {
    const sr = this._requireSampleRate("lastSuccessfulPullTime");
    return this._lastPullAtSample / sr;
  }

  /**
   * The consumer's audio-domain "now", in SECONDS (0.9.51): cumulative
   * per-channel samples emitted ÷ `sampleRate`. Advances by exactly the
   * `process*()` quantum every call (underflow or not). `elapsedSeconds() −
   * lastSuccessfulPullTime()` is the stall age — the value a
   * crossfade-on-stall policy would also key off. Requires a resolved
   * `sampleRate`; throws otherwise.
   */
  elapsedSeconds(): number {
    const sr = this._requireSampleRate("elapsedSeconds");
    return this._samplesEmitted / sr;
  }

  /** Advance the audio-domain clock by one `process*()` call's `count`
   *  per-channel samples and stamp a history mark if the stride has elapsed.
   *  Called on EVERY exit of EVERY consumption method (underflow paths too),
   *  so `_samplesEmitted` is the true emitted-sample count. */
  private _noteEmitted(count: number): void {
    this._samplesEmitted += count;
    if (this._markStride <= 0) return; // no sampleRate → windowing disabled.
    if (this._markCount === 0 ||
        this._samplesEmitted - this._lastMarkSamples >= this._markStride) {
      const slot = this._markHead;
      this._marksSamples[slot] = this._samplesEmitted;
      this._marksUnderflow[slot] = this._underflowSamples;
      this._markHead = (slot + 1) % UNDERFLOW_MARK_CAPACITY;
      if (this._markCount < UNDERFLOW_MARK_CAPACITY) this._markCount++;
      this._lastMarkSamples = this._samplesEmitted;
    }
  }

  /** Resolve the sample rate or throw a descriptive error naming the getter.
   *  The ms-based telemetry getters are unusable without a rate. */
  private _requireSampleRate(method: string): number {
    if (this.sampleRate > 0) return this.sampleRate;
    throw new Error(
      `BridgeBlockConsumer.${method}: requires a sample rate. Construct with ` +
      `{ sampleRate } (the AudioWorklet global \`sampleRate\` is in scope) to ` +
      `use the ms-based underflow telemetry getters.`,
    );
  }

  private _handleUnderflow(out: Float32Array, offset: number, count: number): void {
    switch (this.underflowPolicy) {
      case "zero-fill":
        out.fill(0, offset, offset + count);
        return;
      case "hold-last":
        out.fill(this.holdSample, offset, offset + count);
        return;
    }
  }
}
