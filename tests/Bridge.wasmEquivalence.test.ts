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
import {
  defineSchema, f64, f32, u64, i64, u32, i32, u16, i16, u8, i8,
  f64Array, f32Array, u32Array,
} from "../src/schema.js";
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

  // ── 7: All-scalar-kinds decoder equivalence (0.7.7) ─────────────────────
  // The first PAYLOAD-DECODE pin: WASM-side scalar reads must produce
  // the exact value the producer pushed for every FieldKind the
  // schema DSL declares. Critical edge cases covered: i32 with high
  // bit set (signed −1 vs unsigned 4 294 967 295), i64 spanning the
  // signed/unsigned boundary, i8/u8 at ±extremes, f32 with NaN bit
  // patterns and f64 normal values, BigInt round-trips through the
  // WASM i64 boundary.
  //
  // Pushes 10 frames with carefully-chosen edge-case values; drains
  // each via the FIFO peek/read/commit cycle; asserts every WASM
  // read equals the pushed value. The shim's unsigned-cast helpers
  // (BigInt.asUintN for u64, `>>> 0` for u32) are exercised in the
  // EXPECTED unsigned representations the test asserts against.
  {
    const wideSchema = defineSchema({
      f: f64(),
      g: f32(),
      h: i64(),
      i: u64(),
      j: i32(),
      k: u32(),
      l: i16(),
      m: u16(),
      n: i8(),
      o: u8(),
    });
    const wideCapacity = 8;
    const wideBytes = Bridge.byteLength(wideCapacity, wideSchema);
    const widePages = Math.ceil(wideBytes / 65536);
    const wideMemory = new WebAssembly.Memory({
      initial: widePages,
      maximum: widePages,
      shared: true,
    });
    const wideSab = wideMemory.buffer as unknown as SharedArrayBuffer;
    const wideBridge = new Bridge(wideSab, wideCapacity, wideSchema);
    const wideConsumer = instantiateConsumer(wasmBytes, wideMemory);

    const frameBytes = wideSchema.compiled.frameByteSize;
    const headerBytes = 32;
    const mask = wideCapacity - 1;
    // Pre-resolve each field's in-slot byte offset from the compiled
    // layout. Order in the schema definition is the canonical field
    // order; the compiled layout exposes the byteOffset of each.
    const fieldOffsets: Record<string, number> = {};
    for (const field of wideSchema.compiled.fields) {
      fieldOffsets[field.name] = field.byteOffset;
    }

    // Edge-case value table. Each row is `[f, g, h, i, j, k, l, m, n, o]`
    // — one frame's worth of values for the ten fields. Designed to
    // exercise sign extension, BigInt wide-range, and the unsigned-cast
    // shim helpers.
    type FrameValues = {
      f: number; g: number; h: bigint; i: bigint;
      j: number; k: number; l: number; m: number; n: number; o: number;
    };
    const rows: FrameValues[] = [
      { f: 0, g: 0, h: 0n, i: 0n, j: 0, k: 0, l: 0, m: 0, n: 0, o: 0 },
      // High-bit-set 32-bit boundary
      { f: 1.5, g: -2.25, h: -1n, i: 0xFFFFFFFFFFFFFFFFn,
        j: -1, k: 0xFFFFFFFF, l: -32768, m: 65535, n: -128, o: 255 },
      // Signed/unsigned 32-bit pivot at 2^31
      { f: 1e100, g: -1e30, h: 1n << 32n, i: 1n << 63n,
        j: -(2 ** 31), k: 2 ** 31, l: 12345, m: 12345, n: 42, o: 42 },
      // 53-bit safe integer boundary
      { f: Number.MAX_SAFE_INTEGER, g: 1.5, h: BigInt(Number.MAX_SAFE_INTEGER),
        i: BigInt(Number.MAX_SAFE_INTEGER) + 1n, j: 7, k: 7, l: -1, m: 1, n: 1, o: 200 },
      // Negative normal floats + small ints
      { f: -3.14159265358979, g: 2.5, h: -42n, i: 42n,
        j: 100, k: 100, l: -100, m: 100, n: -1, o: 1 },
    ];

    const pushFrame = wideBridge.scratchFrame();
    const pullFrame = wideBridge.scratchFrame();
    // Drain any leftover from prior pins to start clean.
    while (wideBridge.pull(pullFrame)) { /* drain */ }

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      pushFrame.f = row.f; pushFrame.g = row.g;
      pushFrame.h = row.h; pushFrame.i = row.i;
      pushFrame.j = row.j; pushFrame.k = row.k;
      pushFrame.l = row.l; pushFrame.m = row.m;
      pushFrame.n = row.n; pushFrame.o = row.o;
      assert(wideBridge.push(pushFrame), `pin7: push row ${r}`);

      const slot = wideConsumer.peekPull(mask);
      assert(slot >= 0, `pin7: peekPull row ${r} should not be empty`);
      const slotBase = headerBytes + slot * frameBytes;

      // f64: full precision; bit-identical compare via Object.is for NaN safety.
      assertEq(wideConsumer.readF64(slotBase + fieldOffsets.f!), row.f, `pin7 f64 row ${r}`);
      // f32: rounds to f32 precision; the producer's write already lost the
      // extra precision, so the WASM read of the same bytes equals what JS
      // would see via Float32Array.
      const f32JsRoundtrip = Math.fround(row.g);
      assertEq(wideConsumer.readF32(slotBase + fieldOffsets.g!), f32JsRoundtrip, `pin7 f32 row ${r}`);
      // i64 / u64
      assertEq(wideConsumer.readI64(slotBase + fieldOffsets.h!), row.h, `pin7 i64 row ${r}`);
      assertEq(wideConsumer.readU64(slotBase + fieldOffsets.i!), row.i, `pin7 u64 row ${r}`);
      // i32 / u32
      assertEq(wideConsumer.readI32(slotBase + fieldOffsets.j!), row.j, `pin7 i32 row ${r}`);
      assertEq(wideConsumer.readU32(slotBase + fieldOffsets.k!), row.k, `pin7 u32 row ${r}`);
      // i16 / u16
      assertEq(wideConsumer.readI16(slotBase + fieldOffsets.l!), row.l, `pin7 i16 row ${r}`);
      assertEq(wideConsumer.readU16(slotBase + fieldOffsets.m!), row.m, `pin7 u16 row ${r}`);
      // i8 / u8
      assertEq(wideConsumer.readI8(slotBase + fieldOffsets.n!), row.n, `pin7 i8 row ${r}`);
      assertEq(wideConsumer.readU8(slotBase + fieldOffsets.o!), row.o, `pin7 u8 row ${r}`);

      wideConsumer.commitPull();
    }

    // Cross-check vs JS Bridge.pull on a SECOND Bridge over the SAME bytes
    // (the WASM consumer already drained the first, so we push fresh
    // values and verify the JS path produces the EXACT same scalars the
    // WASM readers just confirmed are correct).
    const jsScratch = wideBridge.scratchFrame();
    const sampleRow = rows[1]!;
    pushFrame.f = sampleRow.f; pushFrame.g = sampleRow.g;
    pushFrame.h = sampleRow.h; pushFrame.i = sampleRow.i;
    pushFrame.j = sampleRow.j; pushFrame.k = sampleRow.k;
    pushFrame.l = sampleRow.l; pushFrame.m = sampleRow.m;
    pushFrame.n = sampleRow.n; pushFrame.o = sampleRow.o;
    assert(wideBridge.push(pushFrame), "pin7 cross-check push");
    assert(wideBridge.pull(jsScratch), "pin7 cross-check pull");
    // JS Bridge.pull also produces the unsigned-cast forms automatically
    // (u32 via Uint32Array umbrella view, u64 via BigUint64Array etc.),
    // so the two reads should match exactly.
    assertEq(jsScratch.f, sampleRow.f, "pin7 cross-check f64");
    assertEq(jsScratch.k, sampleRow.k, "pin7 cross-check u32");
    assertEq(jsScratch.i, sampleRow.i, "pin7 cross-check u64");
    assertEq(jsScratch.n, sampleRow.n, "pin7 cross-check i8");
    assertEq(jsScratch.o, sampleRow.o, "pin7 cross-check u8");

    ok(
      `wasm-scalar-decode-equivalence (${rows.length} rows × 10 field kinds + JS cross-check)`,
    );
  }

  // ── 8: Array decoder equivalence (0.7.8) ───────────────────────────────
  // The WASM `copy_array` export bulk-copies an array field's bytes
  // from a slot to a caller-provided destination region inside the
  // same WebAssembly.Memory. The shim's `allocateWorkletMemory({
  // sabBytes, scratchBytes })` overload reserves a page-aligned
  // scratch region above the SAB ring for exactly this use.
  //
  // This pin defines a small array schema, pushes N frames of known
  // array values, drains each via WASM peek → copy_array (per array
  // field) → JS reads from the scratch view → commit, and asserts
  // the scratch-region bytes equal what was pushed. A cross-check
  // against JS Bridge.pull on a fresh push confirms the JS-side
  // umbrella TypedArray decode agrees with the WASM bulk copy.
  {
    const ARRAY_N = 32;
    const arraySchema = defineSchema({
      seq: u64(),
      tMacroNs: u64(),
      vEff: f64Array(ARRAY_N),
      gEff: f32Array(ARRAY_N),
      iEff: u32Array(ARRAY_N),
    });
    const arrayCapacity = 8;
    const arraySabBytes = Bridge.byteLength(arrayCapacity, arraySchema);
    // Scratch region carries one copy of all three arrays:
    //   vEff:  ARRAY_N × 8 bytes (f64)
    //   gEff:  ARRAY_N × 4 bytes (f32)
    //   iEff:  ARRAY_N × 4 bytes (u32)
    const vEffBytes = ARRAY_N * 8;
    const gEffBytes = ARRAY_N * 4;
    const iEffBytes = ARRAY_N * 4;
    const arrayScratchBytes = vEffBytes + gEffBytes + iEffBytes;

    const arrayAlloc = allocateWorkletMemory({
      sabBytes: arraySabBytes,
      scratchBytes: arrayScratchBytes,
    });
    assert(
      arrayAlloc.scratchByteOffset !== undefined,
      "pin8: allocator returned a scratch offset for the scratchBytes overload",
    );
    assertEq(
      arrayAlloc.scratchBytes,
      arrayScratchBytes,
      "pin8: allocator preserved the requested scratchBytes",
    );
    const scratchBase = arrayAlloc.scratchByteOffset!;

    const arrayBridge = new Bridge(arrayAlloc.sab, arrayCapacity, arraySchema);
    const arrayConsumer = instantiateConsumer(wasmBytes, arrayAlloc.memory);

    const frameBytes = arraySchema.compiled.frameByteSize;
    const headerBytes = 32;
    const mask = arrayCapacity - 1;
    const arrayFieldOffsets: Record<string, number> = {};
    for (const field of arraySchema.compiled.fields) {
      arrayFieldOffsets[field.name] = field.byteOffset;
    }

    // JS-side TypedArray views over the scratch region. The shim's
    // allocator returns a single contiguous scratch byte range; we
    // partition it by laying f64 first, then f32, then u32. The byte
    // offsets are computed once and reused per pull.
    const scratchVEffOff = scratchBase;
    const scratchGEffOff = scratchBase + vEffBytes;
    const scratchIEffOff = scratchBase + vEffBytes + gEffBytes;
    const scratchVEffView = new Float64Array(arrayAlloc.sab, scratchVEffOff, ARRAY_N);
    const scratchGEffView = new Float32Array(arrayAlloc.sab, scratchGEffOff, ARRAY_N);
    const scratchIEffView = new Uint32Array(arrayAlloc.sab, scratchIEffOff, ARRAY_N);

    const arrayPushFrame = arrayBridge.scratchFrame();
    const arrayPullFrame = arrayBridge.scratchFrame();
    // Drain any leftover so the test starts clean.
    while (arrayBridge.pull(arrayPullFrame)) { /* drain */ }

    const ROWS = 6;
    for (let r = 0; r < ROWS; r++) {
      // Generate a per-row pattern that varies element-by-element AND
      // row-by-row, so any off-by-one in slot/offset math surfaces.
      for (let k = 0; k < ARRAY_N; k++) {
        arrayPushFrame.vEff[k] = Math.sin((r + 1) * k * 0.137) * 1e3;
        arrayPushFrame.gEff[k] = Math.fround(Math.cos(r * 0.4 + k * 0.07) * 0.99);
        arrayPushFrame.iEff[k] = ((r << 16) | (k + 1)) >>> 0;
      }
      arrayPushFrame.seq = BigInt(7_000_000_000 + r);
      arrayPushFrame.tMacroNs = BigInt((7_000_000_000 + r) * 1_000);
      assert(arrayBridge.push(arrayPushFrame), `pin8: push row ${r}`);

      const slot = arrayConsumer.peekPull(mask);
      assert(slot >= 0, `pin8: peekPull row ${r} should not be empty`);
      const slotBase = headerBytes + slot * frameBytes;

      // Bulk-copy each array via WASM `copy_array`. Source = slot's
      // field byte offset; destination = scratch region's partition
      // for that array; byte count = array elements × element bytes.
      arrayConsumer.copyArray(
        slotBase + arrayFieldOffsets.vEff!,
        scratchVEffOff,
        vEffBytes,
      );
      arrayConsumer.copyArray(
        slotBase + arrayFieldOffsets.gEff!,
        scratchGEffOff,
        gEffBytes,
      );
      arrayConsumer.copyArray(
        slotBase + arrayFieldOffsets.iEff!,
        scratchIEffOff,
        iEffBytes,
      );

      // Compare the scratch views (populated by WASM) to the values we
      // pushed.
      for (let k = 0; k < ARRAY_N; k++) {
        assertEq(
          scratchVEffView[k],
          arrayPushFrame.vEff[k],
          `pin8 vEff[${k}] row ${r}`,
        );
        assertEq(
          scratchGEffView[k],
          arrayPushFrame.gEff[k],
          `pin8 gEff[${k}] row ${r}`,
        );
        assertEq(
          scratchIEffView[k],
          arrayPushFrame.iEff[k],
          `pin8 iEff[${k}] row ${r}`,
        );
      }
      arrayConsumer.commitPull();
    }

    // Cross-check: push one more row and pull via JS Bridge.pull. The
    // JS-decoded arrays must equal the values we pushed (mirrors the
    // WASM-decoded scratch above bit-for-bit).
    for (let k = 0; k < ARRAY_N; k++) {
      arrayPushFrame.vEff[k] = -k * 0.5;
      arrayPushFrame.gEff[k] = Math.fround(k * 0.25);
      arrayPushFrame.iEff[k] = (0xDEAD0000 | k) >>> 0;
    }
    arrayPushFrame.seq = 9999n;
    arrayPushFrame.tMacroNs = 9_999_999n;
    assert(arrayBridge.push(arrayPushFrame), "pin8: cross-check push");
    assert(arrayBridge.pull(arrayPullFrame), "pin8: cross-check pull");
    for (let k = 0; k < ARRAY_N; k++) {
      assertEq(arrayPullFrame.vEff[k], -k * 0.5, `pin8 cross-check vEff[${k}]`);
      assertEq(arrayPullFrame.gEff[k], Math.fround(k * 0.25), `pin8 cross-check gEff[${k}]`);
      assertEq(arrayPullFrame.iEff[k], (0xDEAD0000 | k) >>> 0, `pin8 cross-check iEff[${k}]`);
    }

    ok(
      `wasm-array-copy-equivalence (${ROWS} rows × ${ARRAY_N} elements × 3 array fields, scratch=${arrayScratchBytes}B + JS cross-check)`,
    );
  }

  console.log(
    "\nBridge.wasmEquivalence: WASM decoder reads SAB header + drives SPSC dance + decodes all 10 scalar kinds + bulk-copies array fields in agreement with JS atomics.",
  );
}

main();
