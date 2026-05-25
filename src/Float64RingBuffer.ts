/**
 * Float64RingBuffer — lock-free SPSC ring over SharedArrayBuffer.
 *
 * Bridges a single producer (typically a DedicatedWorker driving a WebGPU
 * compute pipeline at control rate, e.g. ~60Hz) to a single consumer (an
 * AudioWorklet running at audio rate, e.g. 48kHz / 128-sample render
 * quanta) without postMessage and without locks.
 *
 * This is the reference primitive for the "control-rate GPU, audio-rate CPU"
 * (macro/micro) pattern documented at:
 *   https://github.com/<org>/webgpu-audio-bridge#the-macromicro-pattern
 *
 * It extends Paul Adenot's `ringbuf.js` (2018) — see ATTRIBUTION at the
 * bottom of this file — with four use-case-specific design choices:
 *
 *   1. Float64Array payload (physics control data, not audio samples).
 *   2. Frame-oriented slot layout (header + V_eff + J_eff) — consumer never
 *      sees half-frames.
 *   3. BigInt64 monotonic-forever indices — `available() = write - read`
 *      with no phase bit, no wrap aliasing across a session.
 *   4. `pullLatest()` drain-to-newest semantic alongside FIFO `pull()`.
 *
 * ─── Layout ──────────────────────────────────────────────────────────────
 *
 *   Header (32 bytes, BigInt64 lanes via Atomics):
 *     [0..7]    write_index   producer monotonic counter (Atomics, release)
 *     [8..15]   read_index    consumer monotonic counter (Atomics, release)
 *     [16..23]  reserved
 *     [24..31]  reserved
 *
 *   Payload (Float64Array view at byte offset 32):
 *     CAPACITY slots × FRAME_LEN floats
 *
 *   Frame layout (FRAME_LEN = 4 + 2 * N):
 *     [0]            seq          monotonic frame number (mirrors producer counter)
 *     [1]            tMacroNs     producer timestamp at push (best-effort)
 *     [2]            vMax         precomputed max(|V_eff|) for HUD
 *     [3]            jMax         precomputed max(|J_eff|) for HUD
 *     [4 .. 4+N)     V_eff[N]
 *     [4+N .. 4+2N)  J_eff[N]
 *
 * ─── Memory ordering ─────────────────────────────────────────────────────
 *
 * Producer push:
 *   1. Plain-read own write_index (single-producer guarantee).
 *   2. Acquire-load read_index. If write_index - read_index >= CAPACITY → full.
 *   3. Write payload (non-atomic stores).
 *   4. Release-store write_index + 1. The release barrier guarantees the
 *      non-atomic payload stores happen-before any consumer acquire-load.
 *
 * Consumer pull:
 *   1. Plain-read own read_index (single-consumer guarantee).
 *   2. Acquire-load write_index. If equal → empty.
 *   3. Read payload (non-atomic loads).
 *   4. Re-acquire write_index. If producer lapped us (delta > CAPACITY)
 *      payload may be torn → return false; do not advance read_index.
 *   5. Release-store read_index + 1.
 *
 * The torn-frame re-check is the standard SPSC "verify tail after copy"
 * idiom. Under this library's strict push contract (`push()` rejects at
 * `delta >= CAPACITY`) the re-check is unreachable: a conforming producer
 * never laps an in-flight reader. It is retained as defense-in-depth and
 * to document the protocol. The strict `> CAPACITY` boundary (not `>=`)
 * is the correct dual of the producer's `>= CAPACITY` push-check —
 * at `delta == CAPACITY` the buffer is exactly full with the oldest slot
 * still intact, so the consumer must accept. Flipping to `>=` regresses
 * testFullPush. See README "Memory ordering" for the full boundary
 * analysis.
 *
 * ─── Attribution ─────────────────────────────────────────────────────────
 *
 * The underlying lock-free SPSC-over-SharedArrayBuffer technique is
 * established by Paul Adenot's `ringbuf.js` and his blog post
 * "A wait-free SPSC ringbuffer for the Web":
 *   https://github.com/padenot/ringbuf.js
 *   https://blog.paul.cx/post/a-wait-free-spsc-ringbuffer-for-the-web/
 *
 * This library is a variant of that pattern shaped for the WebGPU →
 * AudioWorklet streaming use case. We cite ringbuf.js as direct precedent.
 */

export const RING_HEADER_BYTES = 32;
export const RING_HEADER_LANES = 2; // write_index, read_index (rest reserved)
export const RING_FRAME_PRELUDE = 4; // seq, tMacroNs, vMax, jMax

export interface RingFrameHeader {
  /** Monotonic frame number; equals producer write_index at push time. */
  seq: number;
  /** Producer timestamp in nanoseconds (best-effort; ≤ 2^53). */
  tMacroNs: number;
  /** Precomputed max(|V_eff|), surfaced to HUD without scanning the array. */
  vMax: number;
  /** Precomputed max(|J_eff|), surfaced to HUD without scanning the array. */
  jMax: number;
}

export interface RingAllocation {
  sab: SharedArrayBuffer;
  capacity: number;
  n: number;
}

function isPowerOfTwo(x: number): boolean {
  return x > 0 && (x & (x - 1)) === 0;
}

export class Float64RingBuffer {
  public readonly capacity: number;
  public readonly n: number;
  public readonly frameLen: number;
  private readonly indices: BigInt64Array;
  private readonly data: Float64Array;
  private readonly mask: bigint;
  private readonly capacityBig: bigint;

  constructor(sab: SharedArrayBuffer, capacity: number, n: number) {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(
        `Float64RingBuffer: capacity must be power of two, got ${capacity}`,
      );
    }
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `Float64RingBuffer: n must be a positive integer, got ${n}`,
      );
    }
    const frameLen = RING_FRAME_PRELUDE + 2 * n;
    const expectedBytes = RING_HEADER_BYTES + capacity * frameLen * 8;
    if (sab.byteLength < expectedBytes) {
      throw new Error(
        `Float64RingBuffer: SAB too small (${sab.byteLength} bytes, need ${expectedBytes} for capacity=${capacity}, n=${n})`,
      );
    }
    this.capacity = capacity;
    this.n = n;
    this.frameLen = frameLen;
    this.indices = new BigInt64Array(sab, 0, RING_HEADER_LANES);
    this.data = new Float64Array(sab, RING_HEADER_BYTES, capacity * frameLen);
    this.mask = BigInt(capacity - 1);
    this.capacityBig = BigInt(capacity);
  }

  /** Compute byte size for a ring of the given (capacity, n). */
  static byteLength(capacity: number, n: number): number {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(`Float64RingBuffer.byteLength: capacity must be power of two`);
    }
    const frameLen = RING_FRAME_PRELUDE + 2 * n;
    return RING_HEADER_BYTES + capacity * frameLen * 8;
  }

  /** Allocate a SAB sized for the requested ring. */
  static allocate(capacity: number, n: number): RingAllocation {
    const sab = new SharedArrayBuffer(Float64RingBuffer.byteLength(capacity, n));
    return { sab, capacity, n };
  }

  /**
   * Producer side. Returns false if the ring is full (caller decides whether
   * to drop, retry, or overwrite via a separate pop-and-push).
   * `vEff` and `jEff` must each have length === `n`.
   */
  push(
    vEff: Float64Array,
    jEff: Float64Array,
    header: RingFrameHeader,
  ): boolean {
    if (vEff.length !== this.n) {
      throw new Error(
        `Float64RingBuffer.push: vEff.length ${vEff.length} !== n ${this.n}`,
      );
    }
    if (jEff.length !== this.n) {
      throw new Error(
        `Float64RingBuffer.push: jEff.length ${jEff.length} !== n ${this.n}`,
      );
    }
    const writeIdx = this.indices[0]!; // plain-read own counter (SPSC)
    const readIdx = Atomics.load(this.indices, 1); // acquire
    if (writeIdx - readIdx >= this.capacityBig) {
      return false; // full
    }
    const slot = Number(writeIdx & this.mask);
    const base = slot * this.frameLen;
    // Non-atomic payload stores — published by the release store below.
    this.data[base + 0] = header.seq;
    this.data[base + 1] = header.tMacroNs;
    this.data[base + 2] = header.vMax;
    this.data[base + 3] = header.jMax;
    this.data.set(vEff, base + RING_FRAME_PRELUDE);
    this.data.set(jEff, base + RING_FRAME_PRELUDE + this.n);
    Atomics.store(this.indices, 0, writeIdx + 1n); // release
    return true;
  }

  /**
   * Consumer side. Returns false on empty or on torn-frame detection (caller
   * uses last-known-good or zeros).
   * `outV` / `outJ` must each have length === `n`.
   */
  pull(
    outV: Float64Array,
    outJ: Float64Array,
    outHeader: RingFrameHeader,
  ): boolean {
    if (outV.length !== this.n) {
      throw new Error(
        `Float64RingBuffer.pull: outV.length ${outV.length} !== n ${this.n}`,
      );
    }
    if (outJ.length !== this.n) {
      throw new Error(
        `Float64RingBuffer.pull: outJ.length ${outJ.length} !== n ${this.n}`,
      );
    }
    const readIdx = this.indices[1]!; // plain-read own counter (SPSC)
    const writeIdx = Atomics.load(this.indices, 0); // acquire
    if (writeIdx === readIdx) {
      return false; // empty
    }
    const slot = Number(readIdx & this.mask);
    const base = slot * this.frameLen;
    outHeader.seq = this.data[base + 0]!;
    outHeader.tMacroNs = this.data[base + 1]!;
    outHeader.vMax = this.data[base + 2]!;
    outHeader.jMax = this.data[base + 3]!;
    outV.set(
      this.data.subarray(
        base + RING_FRAME_PRELUDE,
        base + RING_FRAME_PRELUDE + this.n,
      ),
    );
    outJ.set(
      this.data.subarray(
        base + RING_FRAME_PRELUDE + this.n,
        base + RING_FRAME_PRELUDE + 2 * this.n,
      ),
    );
    // Torn-frame check: did producer lap us between the initial load and now?
    // `>` (not `>=`) is the correct dual of push()'s `>= capacityBig` check —
    // delta == capacity means "exactly full, oldest slot still intact" → accept.
    // Flipping to `>=` deadlocks the ring (regresses testFullPush). Under the
    // strict push contract this branch is unreachable; defense-in-depth only.
    const writeIdxAfter = Atomics.load(this.indices, 0);
    if (writeIdxAfter - readIdx > this.capacityBig) {
      return false; // payload may be torn; do not advance read_index
    }
    Atomics.store(this.indices, 1, readIdx + 1n); // release
    return true;
  }

  /**
   * Drain to the newest available frame. Skipped older frames are discarded.
   * Returns the number of frames skipped (0 if a single frame was waiting,
   * N if N+1 frames were buffered), or -1 if the ring was empty or torn.
   *
   * This is the AudioWorklet's expected per-quantum call: take the freshest
   * macro-rate frame, drop staleness, minimize control→audio lag.
   */
  pullLatest(
    outV: Float64Array,
    outJ: Float64Array,
    outHeader: RingFrameHeader,
  ): number {
    if (outV.length !== this.n) {
      throw new Error(
        `Float64RingBuffer.pullLatest: outV.length ${outV.length} !== n ${this.n}`,
      );
    }
    if (outJ.length !== this.n) {
      throw new Error(
        `Float64RingBuffer.pullLatest: outJ.length ${outJ.length} !== n ${this.n}`,
      );
    }
    const readIdx = this.indices[1]!;
    const writeIdx = Atomics.load(this.indices, 0);
    if (writeIdx === readIdx) return -1;
    const newestIdx = writeIdx - 1n;
    const skipped = Number(newestIdx - readIdx); // ≥ 0
    const slot = Number(newestIdx & this.mask);
    const base = slot * this.frameLen;
    outHeader.seq = this.data[base + 0]!;
    outHeader.tMacroNs = this.data[base + 1]!;
    outHeader.vMax = this.data[base + 2]!;
    outHeader.jMax = this.data[base + 3]!;
    outV.set(
      this.data.subarray(
        base + RING_FRAME_PRELUDE,
        base + RING_FRAME_PRELUDE + this.n,
      ),
    );
    outJ.set(
      this.data.subarray(
        base + RING_FRAME_PRELUDE + this.n,
        base + RING_FRAME_PRELUDE + 2 * this.n,
      ),
    );
    // Torn-frame check on the newest slot — same boundary logic as pull():
    // `>` (not `>=`) is the correct dual of push()'s `>= capacityBig` check.
    // Unreachable under the strict push contract; defense-in-depth only.
    const writeIdxAfter = Atomics.load(this.indices, 0);
    if (writeIdxAfter - newestIdx > this.capacityBig) {
      return -1; // torn / lapped; do not advance
    }
    Atomics.store(this.indices, 1, writeIdx); // consume everything up to writeIdx
    return skipped;
  }

  /** Number of frames currently buffered (≤ capacity). */
  available(): number {
    const writeIdx = Atomics.load(this.indices, 0);
    const readIdx = Atomics.load(this.indices, 1);
    return Number(writeIdx - readIdx);
  }
}
