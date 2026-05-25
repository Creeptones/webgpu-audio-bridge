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
 * consumer (full spins); the consumer drains in microseconds and then has to
 * wait for the producer (empty polls). Each run's `ok()` line reports both
 * counts, and they're typically millions each — meaning the threads spend
 * more time waiting on each other than running, so the release-store /
 * acquire-load protocol is genuinely interleaved rather than accidentally
 * serialized. A test where one side ran to completion before the other
 * started would validate the same payload but exercise no real cross-thread
 * ordering. That's why the contention numbers in the `ok()` output, not the
 * wall-clock, are the evidence this test was meaningful.
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
// This is the only timeout in the test — there are no heuristic delays.
const STALL_TIMEOUT_MS = 30_000;
// Chunk size for the consumer's inner pull loop between event-loop yields.
// Big enough to stay tight, small enough that the worker 'done' message and
// the watchdog tick can fire in reasonable time.
const PULL_CHUNK = 8192;

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
  } = workerData;

  const frameLen = framePrelude + 2 * n;
  const indices = new BigInt64Array(sab, 0, 2);
  const data = new Float64Array(sab, headerBytes, capacity * frameLen);
  const mask = BigInt(capacity - 1);
  const capacityBig = BigInt(capacity);

  let pushed = 0;
  let fullSpins = 0;
  let nextSeq = 0n;

  while (pushed < totalFrames) {
    // SPSC: own counter (write_index) is plain-read; peer counter (read_index)
    // is acquire-loaded. Mirrors Float64RingBuffer.push steps 1-2.
    const writeIdx = indices[0];
    const readIdx = Atomics.load(indices, 1);
    if (writeIdx - readIdx >= capacityBig) {
      // Ring is full — yield briefly so the consumer can drain. Light spin
      // instead of Atomics.wait to keep the producer responsive (the consumer
      // drains in microseconds; a notify/wait round-trip would be overkill).
      fullSpins++;
      for (let i = 0; i < 64; i++) { /* spin */ }
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
    // acquire-load on the consumer. Mirrors Float64RingBuffer.push step 5.
    Atomics.store(indices, 0, writeIdx + 1n);
    nextSeq++;
    pushed++;
  }

  parentPort.postMessage({ type: "done", fullSpins, totalPushed: pushed });
`;

interface ProducerDoneMessage {
  type: "done";
  fullSpins: number;
  totalPushed: number;
}

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
  } = {
    producerDone: false,
    producerStats: null,
    producerError: null,
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
    },
  });

  worker.on("message", (msg: ProducerDoneMessage) => {
    if (msg && msg.type === "done") {
      state.producerDone = true;
      state.producerStats = msg;
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
  let lastProgressAt = Date.now();
  const startedAt = Date.now();

  while (consumed < TOTAL_FRAMES) {
    if (state.producerError !== null) {
      throw new Error(`producer worker failed: ${state.producerError.message}`);
    }
    let progressedThisChunk = false;
    for (let i = 0; i < PULL_CHUNK && consumed < TOTAL_FRAMES; i++) {
      const got = ring.pull(outV, outJ, outH);
      if (!got) {
        emptyPolls++;
        continue;
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
    if (progressedThisChunk) {
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
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
    // Yield to the event loop so the worker 'message' handler can fire and
    // (more importantly) so we don't pin a single core if the producer is
    // briefly idle. setImmediate is the cheapest possible yield.
    await new Promise<void>((r) => setImmediate(r));
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

  ok(
    `concurrent-spsc-stress (${TOTAL_FRAMES.toLocaleString()} frames in ${elapsedMs}ms; ` +
      `${emptyPolls.toLocaleString()} empty polls, ${state.producerStats?.fullSpins.toLocaleString() ?? "?"} producer-full spins)`,
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
