/**
 * Float64RingBuffer — concurrent SPSC stress test (cross-thread).
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Float64RingBuffer.concurrent.test.ts
 *
 * ─── Scope of this file: REAL CONCURRENT SPSC MEMORY ORDERING ─────────────
 *
 * The sibling Float64RingBuffer.test.ts covers single-threaded API correctness
 * — queue algebra (push/pull/full/empty), FIFO, wrap, header+payload round-
 * trip, and a 10k seeded fuzz against an in-process oracle queue. All of that
 * runs on one thread, so the SPSC release/acquire memory-ordering protocol
 * (the release-store on `write_index`, the acquire-load on the consumer side)
 * is exercised only through `Atomics` calls within a single execution context,
 * never across real producer/consumer threads with real shared memory.
 *
 * This file fills that gap. A Node `worker_threads` child runs as the SPSC
 * producer, the main thread runs as the SPSC consumer, both views over the
 * same `SharedArrayBuffer`. Over 1,000,000 frames we assert:
 *
 *   1. The consumer receives EXACTLY TOTAL_FRAMES frames.
 *   2. `seq` is strictly monotonic +1 across the entire run (FIFO across
 *      threads, not just within one thread).
 *   3. Every header field (seq, tMacroNs, vMax, jMax) is bit-exact against
 *      the producer's deterministic recipe.
 *   4. Every payload f64 (vEff[k], jEff[k]) is bit-exact against the
 *      producer's deterministic recipe — `assertEq` (===), not `assertNear`.
 *   5. The producer completes (no deadlock under steady-state back-pressure).
 *
 * If the release/acquire protocol on either side were broken — e.g. the
 * producer's release-store on `write_index` was downgraded to a plain store,
 * or the consumer's acquire-load was elided — the inner payload reads would
 * observe stale or torn data and the bit-exact pin would fail.
 *
 * The load-bearing fact is the contention pattern, NOT the wall-clock or the
 * frame count by themselves. With CAPACITY=16 and TOTAL_FRAMES=1,000,000 the
 * producer fills the ring in microseconds and then has to wait for the
 * consumer (full-waits); the consumer drains in microseconds and then has to
 * wait for the producer (empty-waits). Each run's `ok()` line reports both
 * counts, and they're typically hundreds of thousands each — meaning the
 * threads spend more time waiting on each other than running, so the
 * release-store / acquire-load protocol is genuinely interleaved rather
 * than accidentally serialized. A test where one side ran to completion
 * before the other started would validate the same payload but exercise
 * no real cross-thread ordering. That's why the contention numbers in the
 * `ok()` output, not the wall-clock, are the evidence this test was
 * meaningful.
 *
 * ─── Park / wake protocol (Atomics.wait / Atomics.notify) ─────────────────
 *
 * Both sides park in the kernel instead of busy-spinning when blocked:
 *   - Producer (inline JS): on full, Atomics.wait on indices[1] (read_index)
 *     using the just-loaded readIdx as the expected value. Wakes when the
 *     consumer's pull() unconditionally Atomics.notify(1)s on lane 1 (see
 *     Float64RingBuffer.pull always-notify).
 *   - Consumer (main thread): on empty, ring.waitForData(...) with a short
 *     timeout so we periodically re-check the producer-error state and the
 *     stall watchdog. Wakes when the producer's push unconditionally
 *     Atomics.notify(1)s on lane 0 (see Float64RingBuffer.push always-notify,
 *     mirrored verbatim by the inline producer below).
 *
 * Earlier iteration (kept here as a warning): the notifies were originally
 * edge-triggered — only fired on empty→non-empty / full→non-full transitions.
 * Under 2-thread contention the producer's wasEmpty load almost always read
 * false (writeIdx > readIdx while the consumer was mid-drain), so notifies
 * were never sent and the consumer ground forward at ~110 frames/sec entirely
 * via Atomics.wait timeouts. Always-notify is correct by construction; the
 * syscall cost when no peer is parked is dominated by the write itself and
 * is dwarfed by the actual contention work. See the "Wall-clock vs CPU-shape
 * tradeoff" section in src/Float64RingBuffer.ts for the full rationale.
 *
 * Atomics.wait blocks the calling thread for up to `timeoutMs` — that's
 * fine on the test main thread (no audio rendering deadline) but would be
 * catastrophic in an AudioWorklet. The library's pullLatest path the
 * AudioWorklet uses does NOT call waitForData; it just polls and tolerates
 * misses.
 *
 * `fullWaitTimeouts` is asserted === 0 at the end of the run (producer
 * side, with the longer 1 s wait timeout). `emptyWaitTimeouts` is asserted
 * to be ≤ `TIMEOUT_TOLERANCE` (= ceil(TOTAL_FRAMES / 100_000), i.e. 10 for
 * the default 1 M-frame run) — relaxed from the pre-0.8.3 strict ===0 to
 * absorb CI scheduler jitter on the shorter 100 ms consumer-side wait
 * timeout. A non-zero value below the threshold means an Atomics.wait
 * reached its timeout without a notify, which the protocol then recovers
 * from — that pattern shows up under loaded-machine OS scheduling stalls
 * even when the producer is healthy. A regression that re-introduces the
 * lost-wakeup hole produces dozens to hundreds of timeouts across the run
 * and fires the threshold loudly. Set `STRICT_TIMING=1` in the environment
 * to restore the strict ===0 check for local debugging.
 *
 * ─── Why the producer source is inlined (eval: true) ──────────────────────
 *
 * The test runs under `tsx`, which doesn't trivially propagate its loader to
 * `worker_threads` children. Instead of spawning the worker with TypeScript
 * machinery, we inline a plain-JS producer source string and pass it to
 * `new Worker(PRODUCER_SOURCE, { eval: true })`. The inline producer
 * replicates `Float64RingBuffer.push` verbatim — same plain-read of own
 * `write_index`, same acquire-load on `read_index`, same non-atomic payload
 * stores, same release-store on `write_index + 1n`. That gives us a faithful
 * release-store producer on the worker side AND lets the consumer use the
 * actual production `Float64RingBuffer` class on the main thread, which is
 * the path that ships to consumers.
 *
 * If the production `push()` algorithm in src/Float64RingBuffer.ts changes
 * without this file being updated in lockstep, the producer and consumer will
 * desync — the bit-exact pin will fail loudly. That asymmetry is acceptable:
 * any code change to the push protocol must touch both sides.
 *
 * ─── Steady-state guarantees this stress test relies on ──────────────────
 *
 * With CAPACITY=16, the producer's `write_index - read_index >= capacity`
 * full-check guarantees `write_index` never exceeds `read_index + capacity`.
 * That means the slot the consumer is reading (offset `read_index & mask`)
 * cannot be the slot the producer is currently writing (offset
 * `write_index & mask`) while there's an unread frame — those two offsets
 * can only collide when `write_index - read_index >= capacity`, which the
 * push-check forbids. Any bit-exact mismatch on the consumer side therefore
 * implies a real memory-ordering hazard, not a slot collision.
 */

import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

import { assert, assertEq, ok } from "./_assert.js";
import {
  Float64RingBuffer,
  RING_FRAME_PRELUDE,
  RING_HEADER_BYTES,
  type RingFrameHeader,
} from "../src/Float64RingBuffer.js";

// ─── Run-shape constants ──────────────────────────────────────────────────
// Frame count chosen so the run completes in seconds on a laptop but is large
// enough to interleave many producer/consumer schedules. N=8 keeps per-frame
// payload small (8 + 32 + 64 = 104 bytes / frame, ~100MB total over the run).
const CAPACITY = 16;
const N = 8;
const TOTAL_FRAMES = 1_000_000;
const FRAME_LEN = RING_FRAME_PRELUDE + 2 * N;
const SAB_BYTES = RING_HEADER_BYTES + CAPACITY * FRAME_LEN * 8;

// Consumer-side stall watchdog. If the consumer goes more than this many ms
// without any successful pull, assume the producer has crashed or deadlocked.
// This is the only timeout-as-failure in the test — there are no heuristic
// delays.
const STALL_TIMEOUT_MS = 30_000;
// Chunk size for the consumer's inner pull loop between event-loop yields.
// Big enough to stay tight, small enough that the worker 'done' message and
// the watchdog tick can fire in reasonable time.
const PULL_CHUNK = 8192;
// Consumer-side Atomics.wait timeout — short enough that worker 'message'
// / 'error' events are processed within ~1 watchdog tick even if no notify
// arrives (defensive against any future producer-side notify bug).
const CONSUMER_WAIT_TIMEOUT_MS = 100;
// Producer-side Atomics.wait timeout — covers the same "lost notify" class
// of bugs from the producer's POV. 1s is generous; under a healthy consumer
// the wait wakes well under 1ms via the always-notify in pull().
const PRODUCER_WAIT_TIMEOUT_MS = 1_000;
// Heartbeat cadence. The whole point of the heartbeat is to make a stuck
// run distinguishable from a slow run at a glance — if the output file
// stops growing for more than this interval the test is definitively wedged.
const HEARTBEAT_INTERVAL_MS = 1_000;
// Producer worker emits a "heartbeat" message every this-many pushes. 100k
// over a 1M-frame run is 10 messages → negligible postMessage overhead.
const PRODUCER_HEARTBEAT_EVERY_N = 100_000;

// Consumer-side empty-wait timeout tolerance (see the file header rationale).
// Matches tests/Bridge.concurrent.test.ts: at ~1 timeout per 100k frames the
// threshold tolerates CI scheduler jitter — far below the regression
// signature (dozens-to-hundreds of consumer-side timeouts) and far above the
// typical healthy-machine count (0–3 on a 1 M-frame run).
const TIMEOUT_TOLERANCE = Math.ceil(TOTAL_FRAMES / 100_000);
const STRICT_TIMING = process.env.STRICT_TIMING === "1";

// ─── Producer source (runs in the worker via eval: true) ──────────────────
// Plain JS (not TS). Mirrors Float64RingBuffer.push verbatim — if push
// changes in src/Float64RingBuffer.ts, update this in lockstep or the bit-
// exact consumer pin will fire.
const PRODUCER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const {
    sab,
    capacity,
    n,
    totalFrames,
    headerBytes,
    framePrelude,
    waitTimeoutMs,
    heartbeatEveryN,
  } = workerData;

  const frameLen = framePrelude + 2 * n;
  const indices = new BigInt64Array(sab, 0, 2);
  const data = new Float64Array(sab, headerBytes, capacity * frameLen);
  const mask = BigInt(capacity - 1);
  const capacityBig = BigInt(capacity);

  let pushed = 0;
  // Wait/notify protocol counters. fullWaits is the number of kernel parks
  // the producer did when the ring was full (analogous to the old fullSpins
  // count but measuring real Atomics.wait calls instead of busy-spin iters).
  // fullWaitTimeouts is the subset that reached waitTimeoutMs without a
  // notify — should be 0 under a healthy consumer; non-zero indicates a
  // notify path bug. notifyCalls is the number of Atomics.notify(0, 1) we
  // issued — equals the number of successful pushes since we always-notify.
  let fullWaits = 0;
  let fullWaitTimeouts = 0;
  let notifyCalls = 0;
  let nextSeq = 0n;

  while (pushed < totalFrames) {
    // SPSC: own counter (write_index) is plain-read; peer counter (read_index)
    // is acquire-loaded. Mirrors Float64RingBuffer.push steps 1-2.
    const writeIdx = indices[0];
    const readIdx = Atomics.load(indices, 1);
    if (writeIdx - readIdx >= capacityBig) {
      // Ring is full — park in the kernel until the consumer advances
      // read_index. The consumer's pull() unconditionally Atomics.notify(1)s
      // on lane 1 after its release-store of read_index + 1 (see
      // Float64RingBuffer.pull always-notify), which wakes us.
      //
      // Atomics.wait performs an atomic compare-and-park against the value
      // at indices[1]: if the consumer already advanced readIdx between our
      // load and this wait call, it returns "not-equal" immediately rather
      // than parking forever — load-then-park race is closed by the spec.
      fullWaits++;
      const status = Atomics.wait(indices, 1, readIdx, waitTimeoutMs);
      if (status === "timed-out") {
        // No notify within the budget. Loop and re-check; the bit-exact
        // consumer pin downstream will fail loudly if this hides a stall.
        fullWaitTimeouts++;
      }
      continue;
    }
    const slot = Number(writeIdx & mask);
    const base = slot * frameLen;
    const seq = Number(nextSeq);
    // Non-atomic payload stores — published by the release-store below.
    // Deterministic recipe (must match the consumer-side validator):
    //   seq:       seq
    //   tMacroNs:  seq * 16_666_667     (~60Hz cadence in ns; exact in f64 ≤ 2^53)
    //   vMax:      seq
    //   jMax:      -seq
    //   vEff[k]:   seq + k * 0.001
    //   jEff[k]:   -seq + k * 0.001
    data[base + 0] = seq;
    data[base + 1] = seq * 16666667;
    data[base + 2] = seq;
    data[base + 3] = -seq;
    for (let k = 0; k < n; k++) {
      data[base + framePrelude + k] = seq + k * 0.001;
      data[base + framePrelude + n + k] = -seq + k * 0.001;
    }
    // Release-store: publishes the payload writes above to any subsequent
    // acquire-load on the consumer. Mirrors Float64RingBuffer.push step 4.
    Atomics.store(indices, 0, writeIdx + 1n);
    // Unconditional notify mirrors Float64RingBuffer.push. An earlier
    // edge-triggered version (notify only on wasEmpty) lost wakeups under
    // genuine contention because the producer's wasEmpty load almost always
    // read false while the consumer was mid-drain; see the always-notify
    // rationale in src/Float64RingBuffer.ts.
    notifyCalls++;
    Atomics.notify(indices, 0, 1);
    nextSeq++;
    pushed++;
    if (heartbeatEveryN > 0 && pushed % heartbeatEveryN === 0) {
      // Liveness ping for the consumer's watchdog log. Cheap (≤10 calls
      // for a 1M-frame run at heartbeatEveryN=100k) and gives us per-side
      // forward-progress visibility — without this, a worker stuck in
      // Atomics.wait is indistinguishable from a deadlocked one.
      parentPort.postMessage({ type: "heartbeat", pushed, fullWaits, notifyCalls });
    }
  }

  parentPort.postMessage({
    type: "done",
    fullWaits,
    fullWaitTimeouts,
    notifyCalls,
    totalPushed: pushed,
  });
`;

interface ProducerDoneMessage {
  type: "done";
  /** Number of times the producer parked on Atomics.wait (full ring). */
  fullWaits: number;
  /** Subset of fullWaits that hit waitTimeoutMs without a notify. Should be 0
   *  under a healthy consumer; non-zero indicates a notify path bug or a
   *  consumer stall and is therefore load-bearing telemetry. */
  fullWaitTimeouts: number;
  /** Number of Atomics.notify(lane=0, 1) issued by the producer — equals the
   *  number of successful pushes over the run with always-notify. */
  notifyCalls: number;
  totalPushed: number;
}

interface ProducerHeartbeatMessage {
  type: "heartbeat";
  pushed: number;
  fullWaits: number;
  notifyCalls: number;
}

type ProducerMessage = ProducerDoneMessage | ProducerHeartbeatMessage;

function newHeader(): RingFrameHeader {
  return { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };
}

async function runConcurrentStress(): Promise<void> {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const ring = new Float64RingBuffer(sab, CAPACITY, N);

  // Wrap mutable cross-callback state in a single object so tsc doesn't
  // control-flow-narrow `producerError`/`producerStats` to `never` inside
  // the consumer loop. Property access on a mutable object disables the
  // narrowing that bites plain `let` bindings here.
  const state: {
    producerDone: boolean;
    producerStats: ProducerDoneMessage | null;
    producerError: Error | null;
    /** Last heartbeat we received from the producer worker — the watchdog
     *  prints this so a stuck worker is visible (heartbeat stops advancing
     *  even though the main thread is still ticking). null until the first
     *  heartbeat lands. */
    lastProducerHeartbeat: ProducerHeartbeatMessage | null;
  } = {
    producerDone: false,
    producerStats: null,
    producerError: null,
    lastProducerHeartbeat: null,
  };

  const worker = new Worker(PRODUCER_SOURCE, {
    eval: true,
    workerData: {
      sab,
      capacity: CAPACITY,
      n: N,
      totalFrames: TOTAL_FRAMES,
      headerBytes: RING_HEADER_BYTES,
      framePrelude: RING_FRAME_PRELUDE,
      waitTimeoutMs: PRODUCER_WAIT_TIMEOUT_MS,
      heartbeatEveryN: PRODUCER_HEARTBEAT_EVERY_N,
    },
  });

  worker.on("message", (msg: ProducerMessage) => {
    if (!msg) return;
    if (msg.type === "done") {
      state.producerDone = true;
      state.producerStats = msg;
    } else if (msg.type === "heartbeat") {
      state.lastProducerHeartbeat = msg;
    }
  });
  worker.on("error", (err: Error) => {
    state.producerError = err;
  });

  const outV = new Float64Array(N);
  const outJ = new Float64Array(N);
  const outH = newHeader();
  let consumed = 0;
  let lastSeq = -1;
  let emptyPolls = 0;
  // Consumer-side park telemetry — analogous to the producer's fullWaits.
  let emptyWaits = 0;
  let emptyWaitTimeouts = 0;
  let lastProgressAt = Date.now();
  const startedAt = Date.now();
  let lastHeartbeatAt = startedAt;
  let lastHeartbeatConsumed = 0;
  // stderr (not stdout) so the heartbeat shows up immediately even when the
  // harness pipes stdout to a file — Node's stdout can full-buffer on a pipe
  // on some Windows builds; stderr is always line-buffered/synchronous.
  process.stderr.write(
    `[watchdog] t=0.0s starting concurrent-spsc-stress ` +
      `TOTAL_FRAMES=${TOTAL_FRAMES.toLocaleString()} CAPACITY=${CAPACITY} N=${N} ` +
      `PULL_CHUNK=${PULL_CHUNK.toLocaleString()}\n`,
  );

  while (consumed < TOTAL_FRAMES) {
    if (state.producerError !== null) {
      throw new Error(`producer worker failed: ${state.producerError.message}`);
    }
    let progressedThisChunk = false;
    for (let i = 0; i < PULL_CHUNK && consumed < TOTAL_FRAMES; i++) {
      const got = ring.pull(outV, outJ, outH);
      if (!got) {
        // Ring drained — break out and park via waitForData instead of
        // burning the chunk budget spinning. The earlier `continue` form
        // turned PULL_CHUNK iterations into ~8K Atomics.load syscalls per
        // chunk and dominated the consumer's wall-clock when the producer
        // was park-locked.
        emptyPolls++;
        break;
      }
      const expectedSeq = consumed;

      // Bit-exact header validation against the producer's deterministic
      // recipe. Any drift here implies a memory-ordering hazard slipping past
      // the release/acquire barriers (or the producer protocol diverged from
      // Float64RingBuffer.push — see header comment).
      if (outH.seq !== expectedSeq) {
        throw new Error(
          `FIFO violated at frame ${consumed}: expected seq ${expectedSeq}, got ${outH.seq} (lastSeq ${lastSeq})`,
        );
      }
      if (outH.seq !== lastSeq + 1) {
        throw new Error(
          `seq non-monotonic at frame ${consumed}: lastSeq ${lastSeq}, got ${outH.seq}`,
        );
      }
      const expectedTMacroNs = expectedSeq * 16_666_667;
      if (outH.tMacroNs !== expectedTMacroNs) {
        throw new Error(
          `tMacroNs mismatch at seq ${expectedSeq}: expected ${expectedTMacroNs}, got ${outH.tMacroNs}`,
        );
      }
      if (outH.vMax !== expectedSeq) {
        throw new Error(
          `vMax mismatch at seq ${expectedSeq}: expected ${expectedSeq}, got ${outH.vMax}`,
        );
      }
      if (outH.jMax !== -expectedSeq) {
        throw new Error(
          `jMax mismatch at seq ${expectedSeq}: expected ${-expectedSeq}, got ${outH.jMax}`,
        );
      }
      for (let k = 0; k < N; k++) {
        const wantV = expectedSeq + k * 0.001;
        const wantJ = -expectedSeq + k * 0.001;
        if (outV[k] !== wantV) {
          throw new Error(
            `vEff[${k}] mismatch at seq ${expectedSeq}: expected ${wantV}, got ${outV[k]}`,
          );
        }
        if (outJ[k] !== wantJ) {
          throw new Error(
            `jEff[${k}] mismatch at seq ${expectedSeq}: expected ${wantJ}, got ${outJ[k]}`,
          );
        }
      }
      lastSeq = outH.seq;
      consumed++;
      progressedThisChunk = true;
    }
    const nowMs = Date.now();
    // Always-on heartbeat. Prints once per HEARTBEAT_INTERVAL_MS regardless
    // of whether the chunk made progress — that asymmetry is the whole
    // point: a watcher tailing the output file can tell "advancing slowly"
    // (consumed climbs) from "wedged" (consumed flat across heartbeats).
    if (nowMs - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      const elapsed = (nowMs - startedAt) / 1000;
      const intervalSec = (nowMs - lastHeartbeatAt) / 1000;
      const rate = (consumed - lastHeartbeatConsumed) / Math.max(intervalSec, 1e-9);
      const hb = state.lastProducerHeartbeat;
      const producerLine = hb !== null
        ? `producer.pushed=${hb.pushed.toLocaleString()} fullWaits=${hb.fullWaits.toLocaleString()}`
        : state.producerDone
          ? "producer=done"
          : "producer=<no-heartbeat-yet>";
      process.stderr.write(
        `[watchdog] t=${elapsed.toFixed(1)}s ` +
          `consumed=${consumed.toLocaleString()}/${TOTAL_FRAMES.toLocaleString()} ` +
          `rate=${rate.toFixed(0)}f/s ` +
          `emptyPolls=${emptyPolls.toLocaleString()} ` +
          `emptyWaits=${emptyWaits.toLocaleString()} ` +
          producerLine +
          "\n",
      );
      lastHeartbeatAt = nowMs;
      lastHeartbeatConsumed = consumed;
    }
    if (progressedThisChunk) {
      lastProgressAt = nowMs;
    } else if (nowMs - lastProgressAt > STALL_TIMEOUT_MS) {
      // `state.producerError` was narrowed to `null` by the chunk-start
      // `!== null` check; cast back to widen so we can stringify whichever
      // value is current here (a producer error landing between chunks
      // would surface as `.message`; otherwise we report "null").
      const currentErr = state.producerError as Error | null;
      const errMsg = currentErr !== null ? currentErr.message : "null";
      throw new Error(
        `consumer stalled: ${consumed}/${TOTAL_FRAMES} frames after ${STALL_TIMEOUT_MS}ms with no progress (producerDone=${state.producerDone}, producerError=${errMsg})`,
      );
    }
    // Yield to the event loop so the worker's 'message' / 'error' handlers
    // can fire — Atomics.wait below would block them, so always drain the
    // microtask queue first.
    await new Promise<void>((r) => setImmediate(r));
    if (consumed < TOTAL_FRAMES) {
      // If we drained the ring (or never had any data), park in the kernel
      // until the producer pushes again. The producer's always-notify
      // (mirroring Float64RingBuffer.push) wakes us on every push, parked
      // or not. CONSUMER_WAIT_TIMEOUT_MS gives the outer loop a chance to
      // re-check producerError / the stall watchdog even if a notify is
      // somehow lost — if emptyWaitTimeouts climbs above 0 we've regressed.
      const status = ring.waitForData(CONSUMER_WAIT_TIMEOUT_MS);
      if (status === "ok" || status === "timed-out") {
        emptyWaits++;
        if (status === "timed-out") emptyWaitTimeouts++;
      }
      // "not-equal" means data was already available — no actual park
      // happened, so we don't count it as a wait.
    }
  }

  // Drain anything left, then make sure the producer signaled done. At
  // consumed === TOTAL_FRAMES the producer should also be done since both
  // sides use the same TOTAL_FRAMES count, but we wait up to 1s defensively
  // so the worker has time to flush its postMessage.
  const drainStart = Date.now();
  while (!state.producerDone && Date.now() - drainStart < 1_000) {
    await new Promise<void>((r) => setImmediate(r));
  }

  await worker.terminate();

  const elapsedMs = Date.now() - startedAt;
  assertEq(consumed, TOTAL_FRAMES, "consumed === TOTAL_FRAMES");
  assertEq(lastSeq, TOTAL_FRAMES - 1, "last seq equals TOTAL_FRAMES - 1");
  assert(state.producerDone, "producer signaled done before consumer finished");
  assertEq(
    state.producerStats?.totalPushed,
    TOTAL_FRAMES,
    "producer reports it pushed all frames",
  );
  assertEq(ring.available(), 0, "ring fully drained at end of run");

  const fullWaits = state.producerStats?.fullWaits ?? 0;
  const fullWaitTimeouts = state.producerStats?.fullWaitTimeouts ?? 0;
  const producerNotifies = state.producerStats?.notifyCalls ?? 0;
  // A timeout on either side means a notify was lost — the loop recovers
  // (we re-check the index), but it's a real bug signal worth surfacing
  // hard rather than burying in the log line. Any future regression that
  // re-introduces the edge-trigger-style lost-wakeup hole fires here.
  assertEq(
    fullWaitTimeouts,
    0,
    `producer Atomics.wait never times out under a healthy consumer (got ${fullWaitTimeouts})`,
  );
  if (STRICT_TIMING) {
    assertEq(
      emptyWaitTimeouts,
      0,
      `[STRICT_TIMING] consumer Atomics.wait never times out under a healthy producer (got ${emptyWaitTimeouts})`,
    );
  } else {
    assert(
      emptyWaitTimeouts <= TIMEOUT_TOLERANCE,
      `consumer Atomics.wait timeouts ${emptyWaitTimeouts} exceed tolerance ${TIMEOUT_TOLERANCE} ` +
        `(= ceil(${TOTAL_FRAMES}/100_000)); likely lost-notify regression. ` +
        `Set STRICT_TIMING=1 to require ===0 for local debugging.`,
    );
  }
  ok(
    `concurrent-spsc-stress (${TOTAL_FRAMES.toLocaleString()} frames in ${elapsedMs}ms; ` +
      `producer ${fullWaits.toLocaleString()} full-waits / ${producerNotifies.toLocaleString()} push-notifies; ` +
      `consumer ${emptyWaits.toLocaleString()} empty-waits, ${emptyWaitTimeouts}/${TIMEOUT_TOLERANCE} timeouts, ${emptyPolls.toLocaleString()} empty polls)`,
  );
}

async function main(): Promise<void> {
  // The worker spawns via eval:true and does NOT re-execute this file, so the
  // isMainThread branch is the only path that runs the test logic. The guard
  // is belt-and-suspenders against accidentally turning this file into the
  // worker entry point in the future.
  if (!isMainThread) {
    // Should be unreachable — worker_threads runs PRODUCER_SOURCE inline.
    // Bail rather than recursing into the consumer logic.
    parentPort?.postMessage({
      type: "error",
      message:
        "Float64RingBuffer.concurrent.test.ts loaded as worker entry — should not happen",
    });
    return;
  }
  // workerData should be undefined on the main thread; mention it to keep
  // tsc happy about the unused import.
  void workerData;

  await runConcurrentStress();
  console.log("\nAll Float64RingBuffer.concurrent tests passed.");
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
