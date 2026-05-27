/**
 * Bridge — WASM consumer equivalence (Track 2 of the King roadmap, 0.7.5
 * scaffolding cut).
 *
 * The Track 2 thesis: an AudioWorklet that drains a Bridge SAB through a
 * WASM decoder (rather than the pure-JS path) eliminates the last
 * credible source of glitches — JS object allocation + V8 GC pauses.
 *
 * For that thesis to hold, the WASM module must see the SAB identically
 * to the JS Bridge — same bytes, same atomic-load semantics, same
 * happens-before discipline. This pin proves the smoke-test floor of
 * that guarantee:
 *
 *   (a) The packaged decoder.wasm loads in this runtime (Node 22 with
 *       SAB + WASM threads + WASM SIMD available).
 *   (b) Both feature probes (hasWasmSimd / hasWasmThreads) return true
 *       in the runtime where the WASM module subsequently loads. If
 *       either lies, the runtime contract is broken.
 *   (c) After every Bridge.push the WASM module's read_write_index()
 *       returns EXACTLY the same i32 value JS-side Atomics.load(int32,
 *       0) returns. Same after pull (read_read_index() vs lane 1).
 *   (d) The agreement holds across the full SPSC counter wrap window
 *       (we drive thousands of push/pulls; the i32 lane will eventually
 *       wrap mod 2^32 — both readers must agree across the wrap).
 *
 * Subsequent patches add the full pullLatest decode (schema-driven,
 * SIMD-vectorized for trajectory fields, CAS-aware on drop-oldest). The
 * equivalence corpus grows accordingly: the 63 single-thread Bridge
 * pins become the cross-language oracle that any new WASM decode must
 * match bit-for-bit.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "../src/Bridge.js";
import { defineSchema, f64, u64 } from "../src/schema.js";
import {
  allocateWorkletMemory,
  instantiateConsumer,
  hasWasmSimd,
  hasWasmThreads,
  hasWasmConsumerSupport,
} from "../src/worklet/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, "..", "dist", "worklet", "decoder.wasm");

function main(): void {
  // ── 1: Feature probes agree with one another ────────────────────────────
  // hasWasmConsumerSupport() is the conjunction. If either sub-probe is
  // false, the conjunction must be false. If both are true, the consumer
  // must load below.
  {
    const simd = hasWasmSimd();
    const threads = hasWasmThreads();
    const both = hasWasmConsumerSupport();
    assertEq(both, simd && threads, "consumer support = simd ∧ threads");
    ok(`feature-probes (simd=${simd} threads=${threads} both=${both})`);
  }

  // ── 2: WASM binary loads with shared memory ─────────────────────────────
  // Allocates a small SAB (capacity=4, payload header + 4 frames of a
  // tiny schema), instantiates the consumer over it, asserts both
  // exports are callable. Proves the build pipeline produced a WASM
  // module that THIS runtime accepts.
  let wasmBytes: Uint8Array<ArrayBuffer>;
  try {
    // readFileSync returns Node's `Buffer` (a `Uint8Array<ArrayBufferLike>`).
    // Re-wrap into a fresh `Uint8Array` whose backing buffer is explicitly
    // a plain ArrayBuffer so the type aligns with `BufferSource` —
    // WebAssembly.Module's constructor rejects SharedArrayBuffer-backed
    // views at the type level (and would in any case copy them).
    const fileBuf = readFileSync(wasmPath);
    wasmBytes = new Uint8Array(fileBuf.byteLength);
    wasmBytes.set(fileBuf);
  } catch (err) {
    throw new Error(
      `wasm equivalence: cannot read ${wasmPath} — run \`npm run build:wasm\` first (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  assert(wasmBytes.byteLength > 0, "decoder.wasm is not empty");
  ok(`wasm-binary-loaded (${wasmBytes.byteLength} bytes)`);

  // ── 3: Push/pull header equivalence ─────────────────────────────────────
  // The headline pin. Allocates a shared memory, wraps it as a Bridge,
  // instantiates the WASM consumer over the same memory, drives N
  // push/pull cycles, asserts the WASM atomic reads agree with the
  // JS Atomic reads at every step.
  const schema = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    value: f64(),
  });
  const CAPACITY = 16;
  const wantedBytes = Bridge.byteLength(CAPACITY, schema);
  const { memory, sab, pages, byteLength } = allocateWorkletMemory(wantedBytes);
  assert(
    byteLength >= wantedBytes,
    `allocator must reserve >= ${wantedBytes} bytes (got ${byteLength}, ${pages} pages)`,
  );

  const bridge = new Bridge(sab, CAPACITY, schema);
  const consumer = instantiateConsumer(wasmBytes, memory);

  // JS-side view of the SAB header. Lanes 0/1 are write_index/read_index;
  // we compare WASM's atomic reads against Atomics.load on these.
  const headerView = new Int32Array(sab, 0, 8);

  const scratchPush = bridge.scratchFrame();
  const scratchPull = bridge.scratchFrame();

  // Drive enough cycles to verify the agreement across many state
  // transitions. CAPACITY=16 so we fill / drain / fill again multiple
  // times. 200 cycles is roughly 3 ms — fast.
  const CYCLES = 200;
  for (let i = 0; i < CYCLES; i++) {
    scratchPush.seq = BigInt(i);
    scratchPush.tMacroNs = BigInt(i * 1_000_000);
    scratchPush.value = i * 0.5;
    const pushed = bridge.push(scratchPush);
    if (!pushed) {
      // Ring full — drain a few frames so the loop continues. This is
      // expected behavior for the smoke test (CAPACITY=16, no consumer
      // until below); we use the JS Bridge to drain rather than the
      // WASM consumer (which doesn't have a pull export yet).
      while (bridge.pull(scratchPull));
      const retried = bridge.push(scratchPush);
      assert(retried, `push retried after drain at cycle ${i}`);
    }

    // After the producer's atomic store on write_index, the WASM
    // read must match the JS read.
    const jsWrite = Atomics.load(headerView, 0);
    const wasmWrite = consumer.readWriteIndex();
    assertEq(
      wasmWrite,
      jsWrite,
      `cycle ${i} post-push: WASM read_write_index() = ${wasmWrite}, JS Atomics.load = ${jsWrite}`,
    );

    // Pull one frame back, then check read_index agreement.
    bridge.pull(scratchPull);
    assertEq(scratchPull.value, i * 0.5, `cycle ${i}: pull value`);

    const jsRead = Atomics.load(headerView, 1);
    const wasmRead = consumer.readReadIndex();
    assertEq(
      wasmRead,
      jsRead,
      `cycle ${i} post-pull: WASM read_read_index() = ${wasmRead}, JS Atomics.load = ${jsRead}`,
    );
  }
  ok(
    `wasm-js-header-equivalence (${CYCLES} push/pull cycles; ` +
      `final writeIdx=${Atomics.load(headerView, 0)} readIdx=${Atomics.load(headerView, 1)})`,
  );

  // ── 4: Memory page bounds + shared-buffer identity ──────────────────────
  // Defensive: confirm the runtime really did give us a SharedArrayBuffer
  // (not a regular ArrayBuffer) and that `memory.buffer === sab` — the
  // bedrock of the JS / WASM agreement.
  assert(sab instanceof SharedArrayBuffer, "allocator returned a SharedArrayBuffer");
  assert(
    (memory.buffer as unknown as SharedArrayBuffer) === sab,
    "memory.buffer is the same SAB object the bridge wraps",
  );
  ok(`memory-identity (${pages} pages, ${byteLength} bytes)`);

  // ── 5: FIFO peek+commit drains agree with JS Bridge.pull bytes (0.7.6) ──
  // The hot-path pin for the SPSC dance. Push N frames via the JS Bridge,
  // then drain via the WASM consumer's peek_pull / commit_pull cycle. For
  // each drained frame, read the slot bytes directly from the SAB and
  // verify they match what was pushed. The slot index returned by WASM
  // must equal `readIdx & mask` — same algebra the JS Bridge uses.
  //
  // The schema is { seq: u64, tMacroNs: u64, value: f64 } so the in-
  // slot field offsets are seq @ 0, tMacroNs @ 8, value @ 16 — easy to
  // index via DataView without reaching into the Bridge's private
  // umbrella views.
  {
    const frameBytes = schema.compiled.frameByteSize;
    const headerBytes = 32; // matches RING_HEADER_BYTES (the bridge's static)
    const mask = CAPACITY - 1;
    const dv = new DataView(sab);

    // Drain whatever's left over from pin 3 so we start with an empty ring.
    while (bridge.pull(scratchPull)) { /* drain */ }
    assertEq(
      consumer.peekPull(mask),
      -1,
      "peekPull on empty ring returns -1",
    );
    consumer.commitPull(); // no-op semantics on empty (idempotent store)
    assertEq(
      Atomics.load(headerView, 1),
      Atomics.load(headerView, 0),
      "commit_pull on empty ring leaves read_index === write_index",
    );

    const N = 150; // enough to wrap CAPACITY (=16) several times
    for (let i = 0; i < N; i++) {
      scratchPush.seq = BigInt(1_000_000_000 + i);
      scratchPush.tMacroNs = BigInt((1_000_000_000 + i) * 1_000);
      scratchPush.value = -3.14 + i * 0.01;
      assert(bridge.push(scratchPush), `pin5: push ${i}`);

      const expectedReadIdx = Atomics.load(headerView, 1);
      const expectedSlot = (expectedReadIdx >>> 0) & mask;
      const slot = consumer.peekPull(mask);
      assertEq(slot, expectedSlot, `pin5: peekPull slot at i=${i}`);

      // Read slot bytes via DataView — same bytes JS Bridge.pull would
      // surface through its umbrella views. Little-endian per the
      // bridge's SAB conventions.
      const slotOffset = headerBytes + slot * frameBytes;
      const seq = dv.getBigUint64(slotOffset + 0, true);
      const tMacroNs = dv.getBigUint64(slotOffset + 8, true);
      const value = dv.getFloat64(slotOffset + 16, true);
      assertEq(seq, BigInt(1_000_000_000 + i), `pin5: seq[${i}]`);
      assertEq(tMacroNs, BigInt((1_000_000_000 + i) * 1_000), `pin5: tMacroNs[${i}]`);
      assertEq(value, -3.14 + i * 0.01, `pin5: value[${i}]`);

      consumer.commitPull();
      // After commit, read_index advanced by exactly one.
      assertEq(
        Atomics.load(headerView, 1),
        (expectedReadIdx + 1) | 0,
        `pin5: read_index post-commit at i=${i}`,
      );
    }
    ok(`wasm-pull-fifo-equivalence (${N} frames drained, wrap covered ${Math.floor(N / CAPACITY)}×)`);
  }

  // ── 6: pullLatest peek+commit skips correctly (0.7.6) ──────────────────
  // The drain-to-newest contract. Push a burst of K frames without
  // draining, then a single WASM peek_pull_latest must return the slot
  // of the K-th frame and commit_pull_latest must advance read_index
  // ALL THE WAY to write_index (consuming the older K-1 in one shot).
  // Repeat several times to cover wraparound and varying burst sizes.
  {
    const frameBytes = schema.compiled.frameByteSize;
    const headerBytes = 32;
    const mask = CAPACITY - 1;
    const dv = new DataView(sab);

    // Drain leftover.
    while (bridge.pull(scratchPull)) { /* drain */ }
    assertEq(
      consumer.peekPullLatest(mask),
      -1,
      "peekPullLatest on empty ring returns -1",
    );
    consumer.commitPullLatest(); // idempotent on empty

    const bursts = [1, 2, 5, CAPACITY - 1, CAPACITY]; // last burst saturates the ring
    let pushSeqBase = 2_000_000_000;
    for (let bIdx = 0; bIdx < bursts.length; bIdx++) {
      const K = bursts[bIdx]!;
      const writeIdxBefore = Atomics.load(headerView, 0);

      for (let k = 0; k < K; k++) {
        scratchPush.seq = BigInt(pushSeqBase + k);
        scratchPush.tMacroNs = BigInt((pushSeqBase + k) * 1_000);
        scratchPush.value = 100 + k * 0.5;
        assert(bridge.push(scratchPush), `pin6: push burst ${bIdx} item ${k}`);
      }

      const writeIdxAfter = Atomics.load(headerView, 0);
      assertEq(
        (writeIdxAfter - writeIdxBefore) | 0,
        K,
        `pin6: burst ${bIdx} produced ${K} pushes`,
      );

      // WASM peek must return slot of the LAST pushed frame (writeIdx − 1).
      const expectedNewestSlot = ((writeIdxAfter - 1) >>> 0) & mask;
      const slot = consumer.peekPullLatest(mask);
      assertEq(slot, expectedNewestSlot, `pin6: peekPullLatest slot for burst ${bIdx}`);

      // The slot's contents must equal the LAST frame in the burst.
      const slotOffset = headerBytes + slot * frameBytes;
      const seq = dv.getBigUint64(slotOffset + 0, true);
      const tMacroNs = dv.getBigUint64(slotOffset + 8, true);
      const value = dv.getFloat64(slotOffset + 16, true);
      assertEq(seq, BigInt(pushSeqBase + K - 1), `pin6: newest seq for burst ${bIdx}`);
      assertEq(
        tMacroNs,
        BigInt((pushSeqBase + K - 1) * 1_000),
        `pin6: newest tMacroNs for burst ${bIdx}`,
      );
      assertEq(value, 100 + (K - 1) * 0.5, `pin6: newest value for burst ${bIdx}`);

      consumer.commitPullLatest();

      // After commit, read_index === writeIdxAfter (consumed everything).
      assertEq(
        Atomics.load(headerView, 1),
        writeIdxAfter,
        `pin6: read_index post-commit for burst ${bIdx}`,
      );
      // Ring must be empty for the next iteration.
      assertEq(
        consumer.peekPullLatest(mask),
        -1,
        `pin6: ring empty after drain for burst ${bIdx}`,
      );
      consumer.commitPullLatest();

      pushSeqBase += K;
    }
    ok(`wasm-pullLatest-skip-equivalence (${bursts.length} bursts ${bursts.join(",")})`);
  }

  console.log(
    "\nBridge.wasmEquivalence: WASM decoder reads SAB header + drives SPSC dance in agreement with JS atomics.",
  );
}

main();
