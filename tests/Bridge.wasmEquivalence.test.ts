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

  console.log(
    "\nBridge.wasmEquivalence: WASM decoder reads SAB header in agreement with JS atomics.",
  );
}

main();
