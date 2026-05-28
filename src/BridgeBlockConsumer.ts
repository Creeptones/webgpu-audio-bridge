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
 * throw on construction with a descriptive message — the helper is mono-
 * channel by design (multi-channel can layer on later via either repeated
 * fields with explicit channel naming or a single interleaved array; both
 * options are deferred until a real consumer asks for them).
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

export interface BridgeBlockConsumerOptions {
  /** How `process()` handles a ring-empty event. Default `'zero-fill'`. */
  readonly underflowPolicy?: BlockUnderflowPolicy;
}

export class BridgeBlockConsumer<S extends Schema<FieldsObject, any>> {
  /** The bridge whose pull-side this consumer drives. Exposed so callers can
   *  reach the full `Bridge<S>` surface (telemetry, evaluateInto, etc.)
   *  without holding a second reference. */
  public readonly bridge: Bridge<S>;

  /** Samples per block — derived from the schema's lone `f32Array` field.
   *  The cursor walks `[0, blockSize]`. */
  public readonly blockSize: number;

  /** Name of the schema's `f32Array` samples field. Mostly a diagnostic
   *  surface — the consumer holds a direct typed-array view internally. */
  public readonly samplesField: string;

  /** Underflow policy as resolved at construction. */
  public readonly underflowPolicy: BlockUnderflowPolicy;

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
    this.blockSize = resolved.length;

    this.frame = bridge.scratchFrame();
    this.samples = (this.frame as unknown as Record<string, unknown>)[resolved.name] as Float32Array;

    this.cursor = 0;
    this.hasFrame = false;
    this.holdSample = 0;
    this._underflowSamples = 0;
    this._framesConsumed = 0;
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
          return;
        }
        this.cursor = 0;
        this.hasFrame = true;
        this._framesConsumed++;
      }
      const take = Math.min(count - written, this.blockSize - this.cursor);
      out.set(this.samples.subarray(this.cursor, this.cursor + take), written);
      this.holdSample = this.samples[this.cursor + take - 1] as number;
      this.cursor += take;
      written += take;
    }
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
          return;
        }
        this.cursor = 0;
        this.hasFrame = true;
        this._framesConsumed++;
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
  }

  /** Discard the in-flight frame and reset the cursor. The next `process()`
   *  call pulls a fresh frame from the ring. Telemetry counters
   *  (framesConsumed, underflowSamples) are also zeroed. */
  reset(): void {
    this.cursor = 0;
    this.hasFrame = false;
    this.holdSample = 0;
    this._underflowSamples = 0;
    this._framesConsumed = 0;
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
