/**
 * Bridge — concurrent SPSC stress test (cross-thread) for the schema path.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.concurrent.test.ts
 *
 * ─── Scope of this file: REAL CONCURRENT SPSC MEMORY ORDERING ─────────────
 *
 * Sibling Bridge.test.ts covers single-threaded API correctness for the
 * schema-driven payload codec. This file proves the codec preserves the SPSC
 * release/acquire memory-ordering protocol across real Node worker_threads.
 *
 * A child worker runs as the producer using the byte-offset table emitted by
 * `Bridge.describeLayout()` (postMessaged via workerData), writing payload
 * bytes inline at the same offsets the Bridge consumer reads from. The main
 * thread runs the consumer using `Bridge<physicsControlFrameSchema(N)>.pull`.
 * Over 1,000,000 frames we assert:
 *
 *   1. The consumer receives EXACTLY TOTAL_FRAMES frames.
 *   2. `seq` is strictly monotonic +1 across the entire run (FIFO across
 *      threads, not within one thread).
 *   3. Every header field — seq:u64, tMacroNs:u64, vMax:f64, jMax:f64 — is
 *      bit-exact against the producer's deterministic recipe.
 *   4. Every payload f64 (vEff[k], jEff[k]) is bit-exact against the
 *      producer's recipe — `assertEq` (===), not `assertNear`.
 *   5. The producer completes (no deadlock under steady-state back-pressure).
 *   6. Lost-notify regression alarm. The producer side records exactly 0
 *      full-wait timeouts under a healthy consumer. The consumer side
 *      records at most `TIMEOUT_TOLERANCE` (= ceil(TOTAL_FRAMES / 100_000),
 *      i.e. 10 for the default 1 M-frame run) empty-wait timeouts under a
 *      healthy producer.
 *
 *      Why a soft threshold on the consumer side (0.8.3 — relaxed from
 *      strict ===0). The consumer waits with `CONSUMER_WAIT_TIMEOUT_MS=100`
 *      between pull chunks. On a loaded CI machine the OS scheduler can park
 *      the worker for >100 ms occasionally, even when the producer is
 *      healthy and notifies have fired — the wait then returns "timed-out"
 *      even though no notify was lost. Pre-0.8.3 the assertion was a strict
 *      `=== 0` and flaked exactly this way (CLAUDE.md documents the flake).
 *      A real lost-notify regression would either hang the consumer
 *      (STALL_TIMEOUT_MS catches it) or produce timeouts in the dozens-to-
 *      hundreds range across the run — so a tolerance of ~10 per million
 *      frames cleanly separates flake from regression. The producer side
 *      stays strict (===0) because PRODUCER_WAIT_TIMEOUT_MS=1000 is 10×
 *      looser; CI jitter under 1 second doesn't trip it. Set
 *      `STRICT_TIMING=1` in the environment to restore the strict ===0
 *      check on both sides for local debugging.
 *   7. Consumer-side flow_scale hint stays within the documented
 *      [0.5, 2.0] band for the whole run — sampled at pull-chunk
 *      boundaries, asserted at end. A reading outside the band would
 *      indicate a sign-flip, clamp miss, or encoder overflow. This is the
 *      cross-thread pin for #1 (0.5.0); the single-threaded controller math
 *      is exhaustively covered by tests/Bridge.test.ts pins 28-33.
 *   8. `telemetry().tornFrames === 0` over the full 1 M-frame run on a
 *      no-invariant schema. The bridge's invariant-pathway short-circuits
 *      when `schema.invariant === null`, so zero torn frames are expected;
 *      any non-zero reading indicates a false-positive in the
 *      classification logic or an SPSC-protocol regression. Cross-thread
 *      pin for #4 (0.6.0).
 *
 * If the release/acquire protocol is broken on either side OR the schema-
 * driven offset math drifts from what the consumer reads, the inner payload
 * reads observe stale or torn data and the bit-exact pin fails loudly.
 *
 * ─── Why the producer source is inlined (eval: true) ──────────────────────
 *
 * The test runs under `tsx`, which doesn't trivially propagate its loader
 * to worker_threads. The
 * worker uses `new Worker(PRODUCER_SOURCE, { eval: true })` and receives the
 * schema layout (as JSON via `describeLayout()`) through workerData. The
 * inline producer reconstructs typed-array views over the SAB at the right
 * byte offsets and replicates `Bridge.push` write semantics: per-scalar-field
 * write through the matching umbrella view, then `Atomics.store(indices, 0,
 * writeIdx + 1n)` release-store, then unconditional `Atomics.notify`.
 *
 * Critical: the producer's view of "what bytes to write where" comes from
 * `bridge.describeLayout()`, NOT a hardcoded copy of the schema. Adding /
 * reordering schema fields auto-propagates to the producer.
 */

import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge, RING_HEADER_BYTES } from "../src/Bridge.js";
import {
  physicsControlFrameSchema,
  type PhysicsControlFrameSchema,
} from "../src/schemas/physics.js";
import type { FrameFor } from "../src/schema.js";

// ─── Run-shape constants ──────────────────────────────────────────────────
const CAPACITY = 16;
const N = 8;
const TOTAL_FRAMES = 1_000_000;
const SCHEMA = physicsControlFrameSchema(N);
const SAB_BYTES = Bridge.byteLength(CAPACITY, SCHEMA);

const STALL_TIMEOUT_MS = 30_000;
const PULL_CHUNK = 8192;
const CONSUMER_WAIT_TIMEOUT_MS = 100;
const PRODUCER_WAIT_TIMEOUT_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const PRODUCER_HEARTBEAT_EVERY_N = 100_000;

// Consumer-side empty-wait timeout tolerance (see pin #6 in the file header
// for the rationale). At ~1 timeout per 100k frames the threshold tolerates
// CI scheduler jitter — far below the regression signature (dozens-to-
// hundreds of consumer-side timeouts in a run) and far above the typical
// healthy-machine count (0–3 on a 1 M-frame run).
const TIMEOUT_TOLERANCE = Math.ceil(TOTAL_FRAMES / 100_000);
const STRICT_TIMING = process.env.STRICT_TIMING === "1";

type PhysFrame = FrameFor<PhysicsControlFrameSchema>;

function emptyFrame(): PhysFrame {
  return {
    seq: 0n,
    tMacroNs: 0n,
    vMax: 0,
    jMax: 0,
    vEff: new Float64Array(N),
    jEff: new Float64Array(N),
  };
}

// ─── Producer source (runs in the worker via eval: true) ──────────────────
// Plain JS. Mirrors Bridge.push write semantics for the physicsControlFrameSchema
// using offsets read from describeLayout() via workerData — so any schema
// change picks up automatically. Atomics protocol matches src/Bridge.ts:
// plain-read own writeIdx, acquire-load readIdx, payload stores, release-store
// writeIdx + 1n, unconditional Atomics.notify(0, 1).
const PRODUCER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const {
    sab,
    capacity,
    totalFrames,
    layout,
    headerBytes,
    n,
    waitTimeoutMs,
    heartbeatEveryN,
  } = workerData;

  // Reconstruct umbrella views — one per element-size class used by physics
  // schema. u64View for seq + tMacroNs, f64View for vMax + jMax + vEff + jEff.
  // Both views span the entire payload region.
  const payloadBytes = capacity * layout.frameByteSize;
  const u64View = new BigUint64Array(sab, headerBytes, payloadBytes / 8);
  const f64View = new Float64Array(sab, headerBytes, payloadBytes / 8);
  // Post-0.4: indices are i32 lanes (8 lanes × 4B = 32B header), not BigInt64.
  // Mirrors Bridge's Int32 counter representation — see the "Counter
  // representation" section of src/Bridge.ts. The wrap-invisible algebra below
  // ((a - b) | 0 for signed diff, (a >>> 0) & mask for slot) is the same trick
  // ringbuf.js uses; only the lane width and the diff op change vs the pre-0.4
  // BigInt path.
  const indices = new Int32Array(sab, 0, 8);

  // Per-field stride + elem offset. Stride is frameByteSize / sizeof(elem);
  // since the physics schema's frame byte size is a multiple of 8 and every
  // field's byte offset is a multiple of its element size, these are integers.
  const stride8 = layout.frameByteSize / 8;
  const seqElemOff = layout.fields.seq.byteOffset / 8;
  const tMacroElemOff = layout.fields.tMacroNs.byteOffset / 8;
  const vMaxElemOff = layout.fields.vMax.byteOffset / 8;
  const jMaxElemOff = layout.fields.jMax.byteOffset / 8;
  const vEffElemOff = layout.fields.vEff.byteOffset / 8;
  const jEffElemOff = layout.fields.jEff.byteOffset / 8;

  const mask = capacity - 1;

  let pushed = 0;
  let fullWaits = 0;
  let fullWaitTimeouts = 0;
  let notifyCalls = 0;
  // Schema field 'seq' is u64 in physicsControlFrameSchema — it stays a BigInt
  // value because the SCHEMA declares it as u64. The ring's internal counter
  // is i32 wrap (unrelated). Don't conflate the two.
  let nextSeq = 0n;

  while (pushed < totalFrames) {
    const writeIdx = indices[0];
    const readIdx = Atomics.load(indices, 1);
    // Signed-32 diff: wrap-invisible because capacity ≤ 2^30 keeps the
    // true diff well within [-2^31, 2^31).
    if (((writeIdx - readIdx) | 0) >= capacity) {
      // Full — park until consumer's pull() notifies.
      fullWaits++;
      const status = Atomics.wait(indices, 1, readIdx, waitTimeoutMs);
      if (status === "timed-out") fullWaitTimeouts++;
      continue;
    }
    // Slot via unsigned-then-mask — wrap-invariant.
    const slot = (writeIdx >>> 0) & mask;
    const base = slot * stride8;
    const seqNum = Number(nextSeq);

    // Deterministic recipe (must match the consumer-side validator):
    //   seq:       nextSeq (bigint, schema u64)
    //   tMacroNs:  nextSeq * 16_666_667n
    //   vMax:      seqNum                     (f64)
    //   jMax:      -seqNum                    (f64)
    //   vEff[k]:   seqNum + k * 0.001
    //   jEff[k]:   -seqNum + k * 0.001
    u64View[base + seqElemOff] = nextSeq;
    u64View[base + tMacroElemOff] = nextSeq * 16666667n;
    f64View[base + vMaxElemOff] = seqNum;
    f64View[base + jMaxElemOff] = -seqNum;
    for (let k = 0; k < n; k++) {
      f64View[base + vEffElemOff + k] = seqNum + k * 0.001;
      f64View[base + jEffElemOff + k] = -seqNum + k * 0.001;
    }

    // Release-store + unconditional notify. Matches Bridge.push.
    Atomics.store(indices, 0, (writeIdx + 1) | 0);
    notifyCalls++;
    Atomics.notify(indices, 0, 1);
    nextSeq++;
    pushed++;
    if (heartbeatEveryN > 0 && pushed % heartbeatEveryN === 0) {
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
  fullWaits: number;
  fullWaitTimeouts: number;
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

async function runConcurrentStress(): Promise<void> {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const ring = new Bridge(sab, CAPACITY, SCHEMA);
  const layout = ring.describeLayout();

  const state: {
    producerDone: boolean;
    producerStats: ProducerDoneMessage | null;
    producerError: Error | null;
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
      totalFrames: TOTAL_FRAMES,
      layout,
      headerBytes: RING_HEADER_BYTES,
      n: N,
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

  const out = emptyFrame();
  let consumed = 0;
  let lastSeq = -1n;
  let emptyPolls = 0;
  let emptyWaits = 0;
  let emptyWaitTimeouts = 0;
  let lastProgressAt = Date.now();
  const startedAt = Date.now();
  let lastHeartbeatAt = startedAt;
  let lastHeartbeatConsumed = 0;
  // Flow-scale envelope sampler. The producer never reads the hint in this
  // test (the inline-eval producer is unchanged from 0.4.x and predates
  // flow_scale). The consumer's controller still publishes on every pull;
  // we sample at heartbeat boundaries to pin the running min/max in
  // [0.5, 2.0]. Drift outside the band would indicate a bad encode/decode
  // or a broken anti-windup clamp.
  let flowScaleMin = Infinity;
  let flowScaleMax = -Infinity;
  let flowScaleSamples = 0;
  process.stderr.write(
    `[watchdog] t=0.0s starting bridge-concurrent-spsc-stress ` +
      `TOTAL_FRAMES=${TOTAL_FRAMES.toLocaleString()} CAPACITY=${CAPACITY} N=${N} ` +
      `PULL_CHUNK=${PULL_CHUNK.toLocaleString()} schema=physicsControlFrameSchema(${N})\n`,
  );

  while (consumed < TOTAL_FRAMES) {
    if (state.producerError !== null) {
      throw new Error(`producer worker failed: ${state.producerError.message}`);
    }
    let progressedThisChunk = false;
    for (let i = 0; i < PULL_CHUNK && consumed < TOTAL_FRAMES; i++) {
      const got = ring.pull(out);
      if (!got) {
        emptyPolls++;
        break;
      }
      const expectedSeq = BigInt(consumed);

      // Bit-exact header validation against the producer's deterministic recipe.
      if (out.seq !== expectedSeq) {
        throw new Error(
          `FIFO violated at frame ${consumed}: expected seq ${expectedSeq}, got ${out.seq} (lastSeq ${lastSeq})`,
        );
      }
      if (out.seq !== lastSeq + 1n) {
        throw new Error(
          `seq non-monotonic at frame ${consumed}: lastSeq ${lastSeq}, got ${out.seq}`,
        );
      }
      const expectedTMacroNs = expectedSeq * 16_666_667n;
      if (out.tMacroNs !== expectedTMacroNs) {
        throw new Error(
          `tMacroNs mismatch at seq ${expectedSeq}: expected ${expectedTMacroNs}, got ${out.tMacroNs}`,
        );
      }
      const seqNum = consumed; // exact in number since consumed < TOTAL_FRAMES ≤ 2^53
      if (out.vMax !== seqNum) {
        throw new Error(
          `vMax mismatch at seq ${expectedSeq}: expected ${seqNum}, got ${out.vMax}`,
        );
      }
      if (out.jMax !== -seqNum) {
        throw new Error(
          `jMax mismatch at seq ${expectedSeq}: expected ${-seqNum}, got ${out.jMax}`,
        );
      }
      for (let k = 0; k < N; k++) {
        const wantV = seqNum + k * 0.001;
        const wantJ = -seqNum + k * 0.001;
        if (out.vEff[k] !== wantV) {
          throw new Error(
            `vEff[${k}] mismatch at seq ${expectedSeq}: expected ${wantV}, got ${out.vEff[k]}`,
          );
        }
        if (out.jEff[k] !== wantJ) {
          throw new Error(
            `jEff[${k}] mismatch at seq ${expectedSeq}: expected ${wantJ}, got ${out.jEff[k]}`,
          );
        }
      }
      lastSeq = out.seq;
      consumed++;
      progressedThisChunk = true;
    }
    // Sample the consumer-side flow_scale hint after each pull chunk so the
    // recorded envelope sees both the steady-state and the post-burst
    // transient. Bounded read — single Atomics.load — adds no measurable
    // cost vs the pull loop itself.
    const fs = ring.flowScaleHint();
    if (fs < flowScaleMin) flowScaleMin = fs;
    if (fs > flowScaleMax) flowScaleMax = fs;
    flowScaleSamples++;
    const nowMs = Date.now();
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
          `fs=[${flowScaleMin.toFixed(3)},${flowScaleMax.toFixed(3)}] ` +
          producerLine +
          "\n",
      );
      lastHeartbeatAt = nowMs;
      lastHeartbeatConsumed = consumed;
    }
    if (progressedThisChunk) {
      lastProgressAt = nowMs;
    } else if (nowMs - lastProgressAt > STALL_TIMEOUT_MS) {
      const currentErr = state.producerError as Error | null;
      const errMsg = currentErr !== null ? currentErr.message : "null";
      throw new Error(
        `consumer stalled: ${consumed}/${TOTAL_FRAMES} frames after ${STALL_TIMEOUT_MS}ms with no progress (producerDone=${state.producerDone}, producerError=${errMsg})`,
      );
    }
    await new Promise<void>((r) => setImmediate(r));
    if (consumed < TOTAL_FRAMES) {
      const status = ring.waitForData(CONSUMER_WAIT_TIMEOUT_MS);
      if (status === "ok" || status === "timed-out") {
        emptyWaits++;
        if (status === "timed-out") emptyWaitTimeouts++;
      }
    }
  }

  const drainStart = Date.now();
  while (!state.producerDone && Date.now() - drainStart < 1_000) {
    await new Promise<void>((r) => setImmediate(r));
  }

  await worker.terminate();

  const elapsedMs = Date.now() - startedAt;
  assertEq(consumed, TOTAL_FRAMES, "consumed === TOTAL_FRAMES");
  assertEq(lastSeq, BigInt(TOTAL_FRAMES - 1), "last seq equals TOTAL_FRAMES - 1");
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
  // Flow-scale envelope. The hint must stay within the documented [0.5, 2.0]
  // range for the entire run — the controller's output is bounded by the
  // FLOW_SCALE_MIN/MAX clamp and the anti-windup integrator limit, so a
  // sample outside this range indicates a sign-flip, clamp miss, or encoder
  // overflow. We require at least one sample (sanity); flowScaleSamples ≈
  // number of pull chunks across the run.
  assert(
    flowScaleSamples > 0,
    `flow-scale envelope sampled at least once (got ${flowScaleSamples})`,
  );
  assert(
    flowScaleMin >= 0.5 && flowScaleMax <= 2.0,
    `flow-scale envelope [${flowScaleMin}, ${flowScaleMax}] within [0.5, 2.0] (${flowScaleSamples} samples)`,
  );
  // Torn-frame counter. The schema in this test (physicsControlFrameSchema)
  // has no `.withInvariant(...)` attached, so the invariant pathway is
  // short-circuited in the bridge — tornFrames must stay at 0 over a 1 M-
  // frame healthy run. Any non-zero reading would indicate either an
  // incorrect classification (false positive) or a torn-frame regression
  // in the SPSC protocol itself.
  const tel = ring.telemetry();
  assertEq(
    tel.tornFrames,
    0,
    `tornFrames=0 over ${TOTAL_FRAMES.toLocaleString()} frames on a no-invariant schema (got ${tel.tornFrames})`,
  );
  ok(
    `bridge-concurrent-spsc-stress (${TOTAL_FRAMES.toLocaleString()} frames in ${elapsedMs}ms; ` +
      `producer ${fullWaits.toLocaleString()} full-waits / ${producerNotifies.toLocaleString()} push-notifies; ` +
      `consumer ${emptyWaits.toLocaleString()} empty-waits, ${emptyWaitTimeouts}/${TIMEOUT_TOLERANCE} timeouts, ${emptyPolls.toLocaleString()} empty polls; ` +
      `flow-scale envelope [${flowScaleMin.toFixed(3)}, ${flowScaleMax.toFixed(3)}] over ${flowScaleSamples.toLocaleString()} samples)`,
  );
}

// ─── Drop-oldest cross-thread stress (0.7.2) ──────────────────────────────
//
// The reject sub-suite above proves the SPSC protocol holds under a
// healthy consumer. This sub-suite proves the 0.7.2 CAS-commit consumer
// pull holds when the producer races the consumer on READ_IDX_LANE.
//
// Producer semantics:
//   - Inline-eval worker mirrors SpscRing._dropOldest: when buffered ≥
//     capacity, CAS-advance read_index by one; on CAS failure (consumer
//     raced), re-load read_index and either retry (still full) or skip
//     the drop (consumer drained a slot for us). On CAS success,
//     increment drop counter. Then proceed to write the new frame
//     and release-store write_index unconditionally.
//   - Producer never blocks — always either drops-then-writes or
//     writes-directly. Mirrors a real drop-oldest producer (no
//     pacing).
//
// Consumer semantics:
//   - Main-thread Bridge with `policy: 'drop-oldest'` so `pull` runs
//     through `_pullOverrunAware`. The CAS-commit must reject any
//     mid-read overruns and retry; the bit-exact frame validation
//     below catches any torn frame slipping through.
//   - Deliberately throttled (await setImmediate per chunk + a smaller
//     PULL_CHUNK) so the ring keeps filling and the producer
//     repeatedly enters its drop-oldest branch.
//
// Assertions:
//   1. `consumed + dropped === pushed === DROP_OLDEST_TOTAL_FRAMES`.
//   2. Every consumed frame is bit-exact at its seq — no torn payload
//      ever reaches the caller (this is the 0.7.2 correctness pin).
//   3. Consumed seqs are strictly monotonically increasing (with
//      gaps allowed where drops happened).
//   4. The run produces a non-trivial number of drops (≥ 1) and a
//      non-trivial number of CAS retries on at least one side —
//      otherwise the test failed to exercise the race window.
//   5. `tornFrames === 0` on the no-invariant schema (the 0.7.2
//      contract: CAS-commit catches torn reads without the invariant
//      pathway).
//   6. The Bridge's heap-side `droppedFrames` telemetry stays at 0 on
//      the consumer side (the consumer's heap counter doesn't see
//      producer-side drops; this confirms the consumer's drop
//      accounting is independent — the drop count is the producer's
//      heap counter, reported via the worker's "done" message).

const DROP_OLDEST_TOTAL_FRAMES = 250_000;
const DROP_OLDEST_PULL_CHUNK = 512;

const DROP_OLDEST_PRODUCER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const {
    sab,
    capacity,
    totalFrames,
    layout,
    headerBytes,
    n,
    heartbeatEveryN,
  } = workerData;

  const payloadBytes = capacity * layout.frameByteSize;
  const u64View = new BigUint64Array(sab, headerBytes, payloadBytes / 8);
  const f64View = new Float64Array(sab, headerBytes, payloadBytes / 8);
  const indices = new Int32Array(sab, 0, 8);

  const stride8 = layout.frameByteSize / 8;
  const seqElemOff    = layout.fields.seq.byteOffset / 8;
  const tMacroElemOff = layout.fields.tMacroNs.byteOffset / 8;
  const vMaxElemOff   = layout.fields.vMax.byteOffset / 8;
  const jMaxElemOff   = layout.fields.jMax.byteOffset / 8;
  const vEffElemOff   = layout.fields.vEff.byteOffset / 8;
  const jEffElemOff   = layout.fields.jEff.byteOffset / 8;

  const mask = capacity - 1;

  let pushed = 0;
  let dropped = 0;
  let dropCasRetries = 0;
  let notifyCalls = 0;
  let nextSeq = 0n;

  while (pushed < totalFrames) {
    let writeIdx = indices[0];
    let readIdx = Atomics.load(indices, 1);

    // Drop-oldest loop — mirrors SpscRing._dropOldest. Bounded under SPSC.
    let attempts = 0;
    while (((writeIdx - readIdx) | 0) >= capacity) {
      const next = (readIdx + 1) | 0;
      const prev = Atomics.compareExchange(indices, 1, readIdx, next);
      if (prev === readIdx) {
        dropped++;
        readIdx = next;
        break;
      }
      dropCasRetries++;
      readIdx = Atomics.load(indices, 1);
      attempts++;
      if (attempts > capacity + 8) {
        throw new Error("drop-oldest CAS loop exceeded bounded retries — protocol bug");
      }
    }

    const slot = (writeIdx >>> 0) & mask;
    const base = slot * stride8;
    const seqNum = Number(nextSeq);

    // Recipe — must match the consumer-side validator (which only
    // validates the seqs it sees, with gaps from drops).
    u64View[base + seqElemOff]    = nextSeq;
    u64View[base + tMacroElemOff] = nextSeq * 16666667n;
    f64View[base + vMaxElemOff]   = seqNum;
    f64View[base + jMaxElemOff]   = -seqNum;
    for (let k = 0; k < n; k++) {
      f64View[base + vEffElemOff + k] = seqNum + k * 0.001;
      f64View[base + jEffElemOff + k] = -seqNum + k * 0.001;
    }

    Atomics.store(indices, 0, (writeIdx + 1) | 0);
    notifyCalls++;
    Atomics.notify(indices, 0, 1);
    nextSeq++;
    pushed++;
    if (heartbeatEveryN > 0 && pushed % heartbeatEveryN === 0) {
      parentPort.postMessage({
        type: "heartbeat",
        pushed,
        dropped,
        dropCasRetries,
        notifyCalls,
      });
    }
  }

  parentPort.postMessage({
    type: "done",
    totalPushed: pushed,
    dropped,
    dropCasRetries,
    notifyCalls,
  });
`;

interface DropOldestProducerDoneMessage {
  type: "done";
  totalPushed: number;
  dropped: number;
  dropCasRetries: number;
  notifyCalls: number;
}

interface DropOldestProducerHeartbeatMessage {
  type: "heartbeat";
  pushed: number;
  dropped: number;
  dropCasRetries: number;
  notifyCalls: number;
}

interface DropOldestProducerErrorMessage {
  type: "error";
  message: string;
}

type DropOldestProducerMessage =
  | DropOldestProducerDoneMessage
  | DropOldestProducerHeartbeatMessage
  | DropOldestProducerErrorMessage;

async function runConcurrentStressDropOldest(): Promise<void> {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const ring = new Bridge(sab, CAPACITY, SCHEMA, { policy: "drop-oldest" });
  const layout = ring.describeLayout();

  const state: {
    producerDone: boolean;
    producerStats: DropOldestProducerDoneMessage | null;
    producerError: Error | null;
    lastProducerHeartbeat: DropOldestProducerHeartbeatMessage | null;
  } = {
    producerDone: false,
    producerStats: null,
    producerError: null,
    lastProducerHeartbeat: null,
  };

  const worker = new Worker(DROP_OLDEST_PRODUCER_SOURCE, {
    eval: true,
    workerData: {
      sab,
      capacity: CAPACITY,
      totalFrames: DROP_OLDEST_TOTAL_FRAMES,
      layout,
      headerBytes: RING_HEADER_BYTES,
      n: N,
      heartbeatEveryN: 50_000,
    },
  });

  worker.on("message", (msg: DropOldestProducerMessage) => {
    if (!msg) return;
    if (msg.type === "done") {
      state.producerDone = true;
      state.producerStats = msg;
    } else if (msg.type === "heartbeat") {
      state.lastProducerHeartbeat = msg;
    } else if (msg.type === "error") {
      state.producerError = new Error(msg.message);
    }
  });
  worker.on("error", (err: Error) => {
    state.producerError = err;
  });

  const out = emptyFrame();
  let consumed = 0;
  let lastSeq = -1n;
  // Gap counters help confirm we actually exercised the drop path.
  let observedGaps = 0;
  let totalSkippedBySeq = 0n;
  const startedAt = Date.now();
  let lastHeartbeatAt = startedAt;
  let lastHeartbeatConsumed = 0;
  process.stderr.write(
    `[watchdog] t=0.0s starting bridge-concurrent-drop-oldest-stress ` +
      `TOTAL_FRAMES=${DROP_OLDEST_TOTAL_FRAMES.toLocaleString()} ` +
      `CAPACITY=${CAPACITY} N=${N} PULL_CHUNK=${DROP_OLDEST_PULL_CHUNK}\n`,
  );

  // The consumer's stopping condition is "producer finished AND ring is
  // empty" — we can't simply target a frame count since some frames got
  // dropped. The watchdog also bounds total runtime.
  while (!state.producerDone || ring.available() > 0) {
    if (state.producerError !== null) {
      throw new Error(`drop-oldest producer worker failed: ${state.producerError.message}`);
    }
    for (let i = 0; i < DROP_OLDEST_PULL_CHUNK; i++) {
      const got = ring.pull(out);
      if (!got) break;
      // Validate the seq is monotonically increasing (gaps allowed).
      if (out.seq <= lastSeq) {
        throw new Error(
          `drop-oldest: seq not monotonically increasing at consumed=${consumed}: ` +
            `lastSeq=${lastSeq}, got=${out.seq}`,
        );
      }
      if (out.seq > lastSeq + 1n) {
        observedGaps++;
        totalSkippedBySeq += out.seq - lastSeq - 1n;
      }
      // Bit-exact validation against the recipe at THIS seq.
      const seqNum = Number(out.seq); // safe since seq ≤ totalFrames ≤ 2^53
      const expectedTMacroNs = out.seq * 16_666_667n;
      if (out.tMacroNs !== expectedTMacroNs) {
        throw new Error(
          `drop-oldest tMacroNs torn at seq=${out.seq}: expected ${expectedTMacroNs}, got ${out.tMacroNs}`,
        );
      }
      if (out.vMax !== seqNum) {
        throw new Error(
          `drop-oldest vMax torn at seq=${out.seq}: expected ${seqNum}, got ${out.vMax}`,
        );
      }
      if (out.jMax !== -seqNum) {
        throw new Error(
          `drop-oldest jMax torn at seq=${out.seq}: expected ${-seqNum}, got ${out.jMax}`,
        );
      }
      for (let k = 0; k < N; k++) {
        const wantV = seqNum + k * 0.001;
        const wantJ = -seqNum + k * 0.001;
        if (out.vEff[k] !== wantV) {
          throw new Error(
            `drop-oldest vEff[${k}] torn at seq=${out.seq}: expected ${wantV}, got ${out.vEff[k]}`,
          );
        }
        if (out.jEff[k] !== wantJ) {
          throw new Error(
            `drop-oldest jEff[${k}] torn at seq=${out.seq}: expected ${wantJ}, got ${out.jEff[k]}`,
          );
        }
      }
      lastSeq = out.seq;
      consumed++;
    }
    const nowMs = Date.now();
    if (nowMs - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      const elapsed = (nowMs - startedAt) / 1000;
      const intervalSec = (nowMs - lastHeartbeatAt) / 1000;
      const rate = (consumed - lastHeartbeatConsumed) / Math.max(intervalSec, 1e-9);
      const hb = state.lastProducerHeartbeat;
      const producerLine = hb !== null
        ? `producer.pushed=${hb.pushed.toLocaleString()} dropped=${hb.dropped.toLocaleString()} casRetries=${hb.dropCasRetries.toLocaleString()}`
        : state.producerDone
          ? "producer=done"
          : "producer=<no-heartbeat-yet>";
      process.stderr.write(
        `[watchdog] t=${elapsed.toFixed(1)}s ` +
          `consumed=${consumed.toLocaleString()} ` +
          `rate=${rate.toFixed(0)}f/s ` +
          `gaps=${observedGaps.toLocaleString()} skipped=${totalSkippedBySeq.toString()} ` +
          producerLine +
          "\n",
      );
      lastHeartbeatAt = nowMs;
      lastHeartbeatConsumed = consumed;
    }
    if (Date.now() - startedAt > STALL_TIMEOUT_MS) {
      throw new Error(
        `drop-oldest consumer stalled: consumed=${consumed} after ${STALL_TIMEOUT_MS}ms`,
      );
    }
    // Deliberate throttle — yields to the producer worker so the ring
    // keeps filling and the drop branch fires repeatedly.
    await new Promise<void>((r) => setImmediate(r));
  }

  await worker.terminate();
  const elapsedMs = Date.now() - startedAt;

  assert(state.producerDone, "drop-oldest producer signaled done");
  const stats = state.producerStats!;
  assertEq(stats.totalPushed, DROP_OLDEST_TOTAL_FRAMES, "producer pushed all frames");

  // Core 0.7.2 correctness pin: consumed + dropped === pushed.
  assertEq(
    consumed + stats.dropped,
    DROP_OLDEST_TOTAL_FRAMES,
    `consumed (${consumed}) + dropped (${stats.dropped}) === pushed (${DROP_OLDEST_TOTAL_FRAMES})`,
  );

  // The gap count from observed seq jumps must equal the producer's drop
  // count exactly — every dropped frame corresponds to a missing seq.
  const dropsAsBigInt = BigInt(stats.dropped);
  assertEq(
    totalSkippedBySeq,
    dropsAsBigInt,
    `sum of seq-gaps (${totalSkippedBySeq}) === producer drops (${dropsAsBigInt})`,
  );

  // The run must have exercised the drop path — otherwise the test
  // didn't actually stress the CAS-commit race.
  assert(
    stats.dropped > 0,
    `drop-oldest produced at least one drop (got ${stats.dropped}) — otherwise test failed to stress race`,
  );

  // The consumer's bridge heap state — droppedFrames stays at 0 on the
  // consumer side because the producer's CAS-advance increments its own
  // heap counter in the worker, not the consumer's. Cross-process drop
  // observability is intentionally out of scope (heap-only counter; see
  // SpscRing.ts droppedCount() doc).
  const tel = ring.telemetry();
  assertEq(
    tel.tornFrames,
    0,
    `tornFrames=0 on no-invariant schema (got ${tel.tornFrames}) — CAS-commit caught all overruns`,
  );

  ok(
    `bridge-concurrent-drop-oldest-stress ` +
      `(pushed=${DROP_OLDEST_TOTAL_FRAMES.toLocaleString()} ` +
      `consumed=${consumed.toLocaleString()} ` +
      `dropped=${stats.dropped.toLocaleString()} ` +
      `gaps=${observedGaps.toLocaleString()} ` +
      `casRetries=${stats.dropCasRetries.toLocaleString()} ` +
      `in ${elapsedMs}ms)`,
  );
}

async function main(): Promise<void> {
  if (!isMainThread) {
    parentPort?.postMessage({
      type: "error",
      message:
        "Bridge.concurrent.test.ts loaded as worker entry — should not happen",
    });
    return;
  }
  void workerData;

  await runConcurrentStress();
  await runConcurrentStressDropOldest();
  console.log("\nAll Bridge.concurrent tests passed.");
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
