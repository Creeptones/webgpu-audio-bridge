/**
 * BridgeWebNNSource — pins for the 0.7.16 experimental WebNN adapter
 * (Track 5, first patch).
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/BridgeWebNNSource.test.ts
 *
 * The 0.7.16 patch ships `BridgeWebNNSource<S>` under
 * `src/experimental/` with construction gated on
 * `typeof globalThis.MLTensor === 'function'`. CI runs in the
 * "MLTensor absent" branch — the constructor is expected to throw a
 * descriptive `"WebNN not available"` error. Local manual runs with a
 * WebNN-enabled Chrome (or Node with `--experimental-webnn`) exercise
 * the present-WebNN path via the same file (the branching is on the
 * presence sniff, not a build-time flag).
 *
 * Pins:
 *   1.  `BridgeWebNNSource.isAvailable()` is `false` on current Node —
 *       the static probe doesn't throw and reflects the global state.
 *   2.  Default constructor throws with a descriptive WebNN-absent
 *       error when `globalThis.MLTensor` isn't a function. No frame
 *       allocations leaked into the bridge.
 *   3.  `skipAvailabilityCheck: true` bypasses the gate — useful for
 *       test code that needs to exercise the schema-validation paths
 *       without a real WebNN runtime.
 *   4.  Schema validation: zero-`f32Array` schema throws on construction;
 *       multi-`f32Array` schema throws too. Errors mention the count.
 *   5.  Block-index field resolution mirrors `BridgeBlockProducer`:
 *       (a) default → 'blockIndex' if present as u64 scalar, else null;
 *       (b) explicit string → resolved + validated;
 *       (c) explicit null → disabled;
 *       (d) explicit string pointing at wrong kind throws.
 *   6.  `pushFromTypedArray` round-trip: pushes a known sample buffer,
 *       pulls the next frame from the bridge, asserts samples + auto-
 *       increment `blockIndex` are bit-exact. Increments `pushedCount`,
 *       leaves `droppedCount` at 0.
 *   7.  `pushFromTypedArray` size mismatch: input shorter than blockSize
 *       throws; longer input is accepted and copies only the first
 *       blockSize samples (`.set(samples.subarray(0, blockSize))`).
 *   8.  `pushFromTypedArray` against a full ring returns false and
 *       increments `droppedCount`.
 *   9.  `pushFromTensor` (present-WebNN branch): when MLTensor is
 *       installed via the test's mutable-global shim, the constructor
 *       succeeds; `pushFromTensor` invokes `tensor.read()` and lands
 *       the bytes in the bridge.
 *  10.  `pushFromTensor` `tensorReader` override: when the caller
 *       supplies a custom reader (the WebNN context-side variant), it
 *       is invoked instead of `tensor.read()`.
 *
 * Pins 1-8 + 10 run in any environment; pin 9 exercises the
 * present-WebNN branch via an `MLTensor` shim installed on
 * `globalThis` for the test's duration.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  Bridge,
  defineSchema,
  f32Array,
  f64,
  u64,
  type FieldsObject,
  type Schema,
} from "../src/index.js";
import {
  BridgeWebNNSource,
  type MLTensorLike,
} from "../src/experimental/index.js";

// ── Mutable-global harness for the MLTensor presence sniff ──────────────

const MLTENSOR_KEY = "MLTensor";

function withMLTensorInstalled<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = MLTENSOR_KEY in g;
  const prev = g[MLTENSOR_KEY];
  // Constructor function with a prototype — exactly what the sniff
  // (`typeof globalThis.MLTensor === 'function'`) is looking for.
  const Shim = function (this: object): void { /* never instantiated */ };
  g[MLTENSOR_KEY] = Shim;
  try {
    return fn();
  } finally {
    if (had) {
      g[MLTENSOR_KEY] = prev;
    } else {
      delete g[MLTENSOR_KEY];
    }
  }
}

function withMLTensorAbsent<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = MLTENSOR_KEY in g;
  const prev = g[MLTENSOR_KEY];
  delete g[MLTENSOR_KEY];
  try {
    return fn();
  } finally {
    if (had) g[MLTENSOR_KEY] = prev;
  }
}

// ── Schema fixtures ─────────────────────────────────────────────────────

const samplesOnlySchema = defineSchema({
  samples: f32Array(8),
});

const fullSchema = defineSchema({
  blockIndex: u64(),
  samples:    f32Array(8),
});

const noF32ArraySchema = defineSchema({
  timestamp: f64(),
});

const twoF32ArraysSchema = defineSchema({
  left:  f32Array(4),
  right: f32Array(4),
});

const wrongIndexKindSchema = defineSchema({
  timestamp: f64(),
  samples:   f32Array(8),
});

function makeBridge<
  F extends FieldsObject,
  T extends import("../src/schema.js").TimestampsConfig<F> | null,
>(schema: Schema<F, T>): Bridge<Schema<F, T>> {
  const { sab, capacity } = Bridge.allocate(4, schema);
  return new Bridge(sab, capacity, schema);
}

// ── 1. isAvailable() reflects current globalThis ────────────────────────
function testIsAvailableProbe(): void {
  withMLTensorAbsent(() => {
    assertEq(
      BridgeWebNNSource.isAvailable(),
      false,
      "isAvailable() false with MLTensor absent",
    );
  });
  withMLTensorInstalled(() => {
    assertEq(
      BridgeWebNNSource.isAvailable(),
      true,
      "isAvailable() true with MLTensor installed",
    );
  });
  ok("1. isAvailable() reflects current globalThis");
}

// ── 2. Default constructor throws when MLTensor is absent ───────────────
function testConstructorGate(): void {
  withMLTensorAbsent(() => {
    const bridge = makeBridge(fullSchema);
    let threw = false;
    let msg = "";
    try {
      new BridgeWebNNSource(bridge);
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    assert(threw, "constructor throws when MLTensor absent");
    assert(
      msg.includes("WebNN not available"),
      `error names 'WebNN not available': "${msg}"`,
    );
    assert(
      msg.includes("MLTensor"),
      `error mentions MLTensor: "${msg}"`,
    );
    assert(
      msg.includes("isAvailable"),
      `error points at isAvailable() probe: "${msg}"`,
    );
  });
  ok("2. constructor gate fires with descriptive error");
}

// ── 3. skipAvailabilityCheck bypasses the gate ──────────────────────────
function testSkipAvailabilityCheck(): void {
  withMLTensorAbsent(() => {
    const bridge = makeBridge(fullSchema);
    const source = new BridgeWebNNSource(bridge, {
      skipAvailabilityCheck: true,
    });
    assertEq(source.blockSize, 8, "blockSize derived from schema");
    assertEq(source.samplesField, "samples", "samplesField named correctly");
    assertEq(
      source.blockIndexField,
      "blockIndex",
      "default blockIndexField resolves to 'blockIndex'",
    );
  });
  ok("3. skipAvailabilityCheck bypasses the gate");
}

// ── 4. Schema validation: zero / multi f32Array ─────────────────────────
function testSchemaValidation(): void {
  // Zero f32Array fields
  withMLTensorAbsent(() => {
    const bridge = makeBridge(noF32ArraySchema);
    let threw = false;
    let msg = "";
    try {
      new BridgeWebNNSource(bridge, { skipAvailabilityCheck: true });
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    assert(threw, "zero f32Array schema throws");
    assert(
      msg.includes("none found"),
      `error mentions 'none found': "${msg}"`,
    );
  });

  // Two f32Array fields
  withMLTensorAbsent(() => {
    const bridge = makeBridge(twoF32ArraysSchema);
    let threw = false;
    let msg = "";
    try {
      new BridgeWebNNSource(bridge, { skipAvailabilityCheck: true });
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    assert(threw, "two-f32Array schema throws");
    assert(msg.includes("2"), `error mentions count '2': "${msg}"`);
    assert(msg.includes("left"), `error names 'left': "${msg}"`);
    assert(msg.includes("right"), `error names 'right': "${msg}"`);
  });

  ok("4. schema validation: zero/multi f32Array");
}

// ── 5. Block-index field resolution ─────────────────────────────────────
function testBlockIndexFieldResolution(): void {
  withMLTensorAbsent(() => {
    // (a) Default: 'blockIndex' present → resolved.
    {
      const bridge = makeBridge(fullSchema);
      const s = new BridgeWebNNSource(bridge, { skipAvailabilityCheck: true });
      assertEq(s.blockIndexField, "blockIndex", "default resolves to 'blockIndex'");
    }

    // (a') Default: 'blockIndex' absent → null.
    {
      const bridge = makeBridge(samplesOnlySchema);
      const s = new BridgeWebNNSource(bridge, { skipAvailabilityCheck: true });
      assertEq(
        s.blockIndexField,
        null,
        "default null when 'blockIndex' absent",
      );
    }

    // (b) Explicit string → resolved.
    {
      const bridge = makeBridge(fullSchema);
      const s = new BridgeWebNNSource(bridge, {
        skipAvailabilityCheck: true,
        blockIndexField: "blockIndex",
      });
      assertEq(s.blockIndexField, "blockIndex", "explicit string resolves");
    }

    // (c) Explicit null → disabled.
    {
      const bridge = makeBridge(fullSchema);
      const s = new BridgeWebNNSource(bridge, {
        skipAvailabilityCheck: true,
        blockIndexField: null,
      });
      assertEq(s.blockIndexField, null, "explicit null disables");
    }

    // (d) Explicit name → wrong kind → throws.
    {
      const bridge = makeBridge(wrongIndexKindSchema);
      let threw = false;
      let msg = "";
      try {
        new BridgeWebNNSource(bridge, {
          skipAvailabilityCheck: true,
          blockIndexField: "timestamp",
        });
      } catch (e) {
        threw = true;
        msg = (e as Error).message;
      }
      assert(threw, "wrong-kind blockIndexField throws");
      assert(msg.includes("u64 scalar"), `error mentions u64 scalar: "${msg}"`);
    }

    // (d') Explicit name → missing → throws.
    {
      const bridge = makeBridge(fullSchema);
      let threw = false;
      let msg = "";
      try {
        new BridgeWebNNSource(bridge, {
          skipAvailabilityCheck: true,
          blockIndexField: "nonexistent",
        });
      } catch (e) {
        threw = true;
        msg = (e as Error).message;
      }
      assert(threw, "missing blockIndexField throws");
      assert(msg.includes("nonexistent"), `error names field: "${msg}"`);
    }
  });

  ok("5. block-index field resolution");
}

// ── 6. pushFromTypedArray round-trip + counters + auto-increment ────────
function testTypedArrayRoundTrip(): void {
  withMLTensorAbsent(() => {
    const bridge = makeBridge(fullSchema);
    const source = new BridgeWebNNSource(bridge, {
      skipAvailabilityCheck: true,
    });

    const input = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const ok1 = source.pushFromTypedArray(input);
    assertEq(ok1, true, "first push returns true");
    assertEq(source.pushedCount(), 1, "pushedCount = 1");
    assertEq(source.droppedCount(), 0, "droppedCount = 0");
    assertEq(source.blockIndex(), 1n, "blockIndex advanced to 1");

    // Pull and verify.
    const scratch = bridge.scratchFrame();
    const pulled = bridge.pull(scratch);
    assertEq(pulled, true, "bridge has the pushed frame");
    assertEq(scratch.blockIndex, 0n, "pulled frame's blockIndex = 0");
    for (let i = 0; i < input.length; i++) {
      assertEq(scratch.samples[i], input[i], `samples[${i}] matches`);
    }

    // Second push to verify the index keeps advancing.
    source.pushFromTypedArray(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]));
    assertEq(source.blockIndex(), 2n, "blockIndex advanced to 2");

    bridge.pull(scratch);
    assertEq(scratch.blockIndex, 1n, "second pull blockIndex = 1");
  });

  ok("6. pushFromTypedArray round-trip + counters + auto-increment");
}

// ── 7. pushFromTypedArray size mismatch handling ────────────────────────
function testTypedArraySizeMismatch(): void {
  withMLTensorAbsent(() => {
    const bridge = makeBridge(fullSchema);
    const source = new BridgeWebNNSource(bridge, {
      skipAvailabilityCheck: true,
    });

    // Too short → throws.
    let threw = false;
    let msg = "";
    try {
      source.pushFromTypedArray(new Float32Array(4));
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    assert(threw, "shorter-than-blockSize throws");
    assert(msg.includes("blockSize"), `error mentions blockSize: "${msg}"`);

    // Longer → only first blockSize samples are copied.
    const longer = new Float32Array(16);
    for (let i = 0; i < 16; i++) longer[i] = i + 1;
    source.pushFromTypedArray(longer);
    const scratch = bridge.scratchFrame();
    bridge.pull(scratch);
    for (let i = 0; i < 8; i++) {
      assertEq(scratch.samples[i], i + 1, `truncated samples[${i}] matches`);
    }
  });

  ok("7. pushFromTypedArray size mismatch handling");
}

// ── 8. Full ring → droppedCount increments ──────────────────────────────
function testFullRingDrops(): void {
  withMLTensorAbsent(() => {
    const bridge = makeBridge(fullSchema);
    const source = new BridgeWebNNSource(bridge, {
      skipAvailabilityCheck: true,
    });

    // Capacity = 4 (from makeBridge). Push 4 successfully, 5th fails.
    const samples = new Float32Array(8);
    for (let i = 0; i < 4; i++) {
      const ok_ = source.pushFromTypedArray(samples);
      assertEq(ok_, true, `push ${i + 1} succeeds (ring has space)`);
    }
    const okOverflow = source.pushFromTypedArray(samples);
    assertEq(okOverflow, false, "push 5 fails (ring full)");
    assertEq(source.pushedCount(), 4, "pushedCount = 4");
    assertEq(source.droppedCount(), 1, "droppedCount = 1");
    // The blockIndex should only have advanced on successful pushes.
    assertEq(source.blockIndex(), 4n, "blockIndex = 4 (no advance on drop)");
  });

  ok("8. full ring → droppedCount + no blockIndex advance");
}

// ── 9. pushFromTensor exercises the present-WebNN branch ────────────────
async function testPushFromTensorPresent(): Promise<void> {
  // The constructor gate accepts the install shim; the actual MLTensor
  // we pass is a hand-rolled object whose `.read()` resolves to an
  // ArrayBuffer of f32 bytes.
  await withMLTensorInstalled(async () => {
    const bridge = makeBridge(fullSchema);
    const source = new BridgeWebNNSource(bridge);
    assertEq(source.blockSize, 8, "constructed under installed MLTensor");

    const bytes = new ArrayBuffer(8 * 4);
    const view = new Float32Array(bytes);
    for (let i = 0; i < 8; i++) view[i] = (i + 1) * 0.125;

    const tensor: MLTensorLike = {
      read: () => Promise.resolve(bytes),
    };
    const ok_ = await source.pushFromTensor(tensor);
    assertEq(ok_, true, "pushFromTensor returned true");

    const scratch = bridge.scratchFrame();
    bridge.pull(scratch);
    for (let i = 0; i < 8; i++) {
      assertEq(scratch.samples[i], view[i], `tensor sample[${i}] matches`);
    }
  });

  ok("9. pushFromTensor lands MLTensor bytes through the bridge");
}

// ── 10. pushFromTensor tensorReader override ────────────────────────────
async function testTensorReaderOverride(): Promise<void> {
  await withMLTensorAbsent(async () => {
    const bridge = makeBridge(fullSchema);
    let readerInvoked = 0;
    const customReader = (tensor: MLTensorLike): Promise<ArrayBuffer> => {
      readerInvoked++;
      // The "tensor" carries our payload inline for this test.
      const carrier = tensor as MLTensorLike & { _payload?: ArrayBuffer };
      return Promise.resolve(carrier._payload!);
    };

    const source = new BridgeWebNNSource(bridge, {
      skipAvailabilityCheck: true,
      tensorReader: customReader,
    });

    const bytes = new ArrayBuffer(8 * 4);
    const view = new Float32Array(bytes);
    for (let i = 0; i < 8; i++) view[i] = 100 + i;

    const tensor = { _payload: bytes } as unknown as MLTensorLike;
    const ok_ = await source.pushFromTensor(tensor);
    assertEq(ok_, true, "pushFromTensor with override returned true");
    assertEq(readerInvoked, 1, "custom reader invoked exactly once");

    const scratch = bridge.scratchFrame();
    bridge.pull(scratch);
    for (let i = 0; i < 8; i++) {
      assertEq(scratch.samples[i], 100 + i, `override sample[${i}] matches`);
    }
  });

  ok("10. tensorReader override path");
}

async function main(): Promise<void> {
  testIsAvailableProbe();
  testConstructorGate();
  testSkipAvailabilityCheck();
  testSchemaValidation();
  testBlockIndexFieldResolution();
  testTypedArrayRoundTrip();
  testTypedArraySizeMismatch();
  testFullRingDrops();
  await testPushFromTensorPresent();
  await testTensorReaderOverride();
  console.log("\nAll BridgeWebNNSource.test.ts pins passed.");
}

main();
