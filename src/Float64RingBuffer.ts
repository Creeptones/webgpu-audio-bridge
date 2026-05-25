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
 *   5. Atomics.notify(write_index, 1) wakes any consumer that may have
 *      parked via waitForData (or inline Atomics.wait on lane 0).
 *      Unconditional — see the "Park / wake protocol" note below.
 *
 * Consumer pull:
 *   1. Plain-read own read_index (single-consumer guarantee).
 *   2. Acquire-load write_index. If equal → empty.
 *   3. Read payload (non-atomic loads).
 *   4. Release-store read_index + 1.
 *   5. Atomics.notify(read_index, 1) wakes any producer that may have parked
 *      via waitForSpace (or inline Atomics.wait on lane 1). Unconditional.
 *
 * No torn-frame re-check is needed. The strict push contract guarantees
 * the producer cannot be writing the slot the consumer is reading: push()
 * rejects when `write_index - read_index >= CAPACITY`, so the producer's
 * write_index cannot advance past read_index + CAPACITY, and the slot
 * indices `(write_index & mask)` and `(read_index & mask)` cannot collide
 * while there is an unread frame. The producer's release-store on
 * write_index establishes happens-before for the payload writes; the
 * consumer's acquire-load on write_index observes them. That is the full
 * synchronization the protocol needs.
 *
 * ─── Park / wake protocol (Atomics.wait / Atomics.notify) ─────────────────
 *
 * Always-notify (not edge-triggered). Push and pull unconditionally issue
 * Atomics.notify on the peer's lane after the release-store. An earlier
 * iteration of this protocol used an edge-trigger (notify only on the
 * empty→non-empty / full→non-full transition); under genuine 2-thread
 * contention that protocol misses wake-ups because the producer's wasEmpty
 * check almost always reads false (write_index > read_index while the
 * consumer is mid-drain), so the consumer ends up reliant on its
 * Atomics.wait timeout to make any progress at all. Always-notify is
 * correct by construction: a parked peer is guaranteed to be woken on the
 * next state change, and the syscall cost when nobody is parked is
 * dominated by the write itself (~100ns on Windows / Linux per
 * Atomics.notify with zero waiters). In the canonical production path
 * (60Hz control-rate producer → AudioWorklet, ~375Hz pull at 48kHz/128q)
 * that's a few hundred extra notify-syscalls per second total — invisible
 * against everything else.
 *
 * Atomics.wait correctness under the load-then-park race is provided by the
 * spec itself: Atomics.wait atomically compare-and-parks against the
 * expected value, so a producer that observed readIdx = X and then issues
 * Atomics.wait(indices, 1, X) is safe even if the consumer advances readIdx
 * between the two operations — the wait sees the new value and returns
 * "not-equal" immediately rather than parking forever.
 *
 * waitForData is NOT real-time safe (it blocks the calling thread up to the
 * timeout) and MUST NOT be called from an AudioWorklet's process() method.
 * The AudioWorklet always polls via pullLatest() and tolerates misses. The
 * notify on push is still emitted for the benefit of non-realtime consumers
 * (concurrent stress tests, bench harnesses, non-audio downstream readers).
 *
 * ─── Wall-clock vs CPU-shape tradeoff ─────────────────────────────────────
 *
 * Adding the park/wake protocol made the 1M-frame concurrent stress test
 * ~1.6× slower in wall-clock (277ms busy-spin → 454ms wait/wake on a dev
 * laptop) and pushed the single-thread microbench from ~150ns/op to
 * ~1.1μs/op. Both numbers are real and worth naming so future readers don't
 * read them as a regression:
 *
 *   - The microbench cost is ~1μs of Atomics.notify syscall per push and
 *     per pull. The bench is single-threaded so there's no thread to park
 *     and no contention to amortize against — every op pays the syscall.
 *   - The stress-test cost is ~500K kernel parks × ~1μs/park ≈ ~500ms of
 *     park overhead distributed across both threads. Wall-clock only shows
 *     +180ms because the threads overlap.
 *
 * The protocol is still the right choice because the axis production cares
 * about is CPU SHAPE, not CPU TIME:
 *
 *   - Busy-spin pins two cores at 100% for the duration of any back-pressure.
 *     Wait/notify parks them; the cores are available for other work
 *     (the audio thread itself, message handling, page JS).
 *   - If the AudioWorklet stalls (browser GC, layout thrash) the busy-spin
 *     producer would burn full-core CPU competing with the very thread it's
 *     waiting for, amplifying the stall. Wait/notify degrades gracefully.
 *   - Production push/pull rates (60Hz × 375Hz) burn the syscall ~435 times
 *     per second total → <0.05% of one CPU. Invisible.
 *   - With edge-trigger notify there was no way to observe a lost wakeup —
 *     the symptom was just "slow forever." Always-notify + the heartbeat in
 *     the concurrent stress test + emptyWaitTimeouts === 0 assertion turns
 *     any future protocol break (V8 update, OS change, capacity tweak) into
 *     a loud test failure within seconds.
 *
 * Wasted-iteration counters dropped 3 orders of magnitude (millions of
 * busy-spin iters → a few hundred thousand kernel parks for the same 1M-
 * frame run). The slower wall-clock on a benchmark designed to maximize
 * the operation we pay for is the price of admission for a protocol that
 * behaves correctly under the conditions the previous one ignored.
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
    // Unconditional notify: zero-waiter notify is ~100ns and the edge-
    // trigger (wasEmpty) approach lost wakeups under 2-thread contention
    // because the producer's wasEmpty check usually reads false while the
    // consumer is mid-drain. Always-notify is correct by construction.
    Atomics.notify(this.indices, 0, 1);
    return true;
  }

  /**
   * Consumer side. Returns false on empty (caller uses last-known-good or
   * zeros). `outV` / `outJ` must each have length === `n`.
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
    Atomics.store(this.indices, 1, readIdx + 1n); // release
    // Unconditional notify — see the matching note in push().
    Atomics.notify(this.indices, 1, 1);
    return true;
  }

  /**
   * Drain to the newest available frame. Skipped older frames are discarded.
   * Returns the number of frames skipped (0 if a single frame was waiting,
   * N if N+1 frames were buffered), or -1 if the ring was empty.
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
    Atomics.store(this.indices, 1, writeIdx); // consume everything up to writeIdx
    // Unconditional notify — see the matching note in push().
    Atomics.notify(this.indices, 1, 1);
    return skipped;
  }

  /** Number of frames currently buffered (≤ capacity). */
  available(): number {
    const writeIdx = Atomics.load(this.indices, 0);
    const readIdx = Atomics.load(this.indices, 1);
    return Number(writeIdx - readIdx);
  }

  /**
   * Producer-side park: block until the consumer advances read_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has space.
   *
   * Use this when push() returned false and you want to wait for capacity
   * rather than busy-spin / drop. The caller is responsible for re-issuing
   * push() after this returns — spurious wakeups (and brief readIdx churn
   * that lands back at the previously-observed value) are possible.
   *
   * Atomics.wait performs an atomic compare-and-park against the value at
   * indices[1] (read_index) — if the consumer advanced read_index between
   * our load and the wait, the wait returns "not-equal" immediately rather
   * than parking forever. This closes the load-then-park race window.
   *
   * NOTE: Atomics.wait blocks the calling thread. On the browser main thread
   * the spec forbids it (TypeError). On a Worker / Node main / Node worker
   * it is permitted. Do NOT call from an AudioWorklet process() method —
   * that is hard-real-time and must never block.
   */
  waitForSpace(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    const writeIdx = this.indices[0]!;
    const readIdx = Atomics.load(this.indices, 1);
    if (writeIdx - readIdx < this.capacityBig) return "not-equal"; // already has space
    return Atomics.wait(this.indices, 1, readIdx, timeoutMs);
  }

  /**
   * Consumer-side park: block until the producer advances write_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has data. Mirror of waitForSpace.
   *
   * NOT real-time safe — see waitForSpace for the threading rules. An
   * AudioWorklet's per-quantum read path MUST NOT call this; it should
   * poll via pullLatest() and tolerate misses. This method exists for
   * non-realtime consumers (tests, bench harnesses, non-audio downstream
   * readers that can afford to block).
   */
  waitForData(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    const readIdx = this.indices[1]!;
    const writeIdx = Atomics.load(this.indices, 0);
    if (writeIdx !== readIdx) return "not-equal"; // already has data
    return Atomics.wait(this.indices, 0, writeIdx, timeoutMs);
  }
}
