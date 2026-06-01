import { assert, assertEq } from "./_assert.js";
import wabtInit from "wabt";
import { defineSchema, f64, f64Array, u32 } from "../src/schema.js";
import { MpmcWorkQueue } from "../src/MpmcWorkQueue.js";
import { WasmMpmcWorkQueue } from "../src/WasmMpmcWorkQueue.js";
import { emitWasmMpmc } from "../src/emitWasmMpmc.js";
import { allocateWasmSharedMemory } from "../src/wasm/memory.js";

const schema = defineSchema({
  producerId: u32(),
  seq: u32(),
  checksum: f64(),
  fill: f64Array(4),
});

async function compileWat(wat: string): Promise<Uint8Array<ArrayBuffer>> {
  const wabt = await wabtInit();
  const mod = wabt.parseWat("mpmc-claim.wat", wat, { threads: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}

async function makeQueue(capacity: number, producerCount: number) {
  const byteLength = MpmcWorkQueue.byteLength(schema, capacity);
  const alloc = allocateWasmSharedMemory(byteLength);
  assert(alloc.sab.byteLength >= byteLength, "WASM memory covers queue byteLength");
  const bytes = await compileWat(emitWasmMpmc({ memoryPages: { min: alloc.pages, max: alloc.pages } }));
  const result = await WebAssembly.instantiate(bytes, { env: { memory: alloc.memory } });
  const queue = new WasmMpmcWorkQueue(
    alloc.sab,
    schema,
    capacity,
    result.instance,
    { producerCount },
  );
  queue.initLayout();
  return { queue, sab: alloc.sab, memory: alloc.memory };
}

async function main(): Promise<void> {
  const { queue } = await makeQueue(8, 2);
  const frame = {
    producerId: 7,
    seq: 0,
    checksum: 1.25,
    fill: new Float64Array([1, 2, 3, 4]),
  };
  const out = queue.createFrame();

  assert(!queue.pull(out), "empty WASM pull returns false");
  for (let i = 0; i < 6; i++) {
    frame.seq = i;
    frame.checksum = i + 0.5;
    frame.fill[0] = i * 10;
    assert(queue.push(frame), `push ${i}`);
  }
  assertEq(queue.available(), 6, "all frames claimable");

  for (let i = 0; i < 6; i++) {
    assert(queue.pull(out), `pull ${i}`);
    assertEq(out.producerId, 7, "producerId preserved");
    assertEq(out.seq, i, "FIFO seq through WASM claim");
    assertEq(out.checksum, i + 0.5, "checksum preserved");
    assertEq(out.fill[0], i * 10, "array payload preserved");
  }
  assertEq(queue.available(), 0, "drained");
  assert(!queue.pull(out), "empty after drain");

  const cap = 4;
  const { queue: held, sab } = await makeQueue(cap, 2);
  const header = new Int32Array(sab, 0, 8);
  const gen = new Int32Array(sab, 32, cap);
  Atomics.store(header, 0, 1);
  assert(!held.pull(held.createFrame()), "claimed unpublished ticket rides");
  assert(held.isHolding(), "WASM claim participates in held-claim state");
  Atomics.store(gen, 0, 1);
  assert(held.pull(held.createFrame()), "held claim delivers once published");

  console.log("ok: WasmMpmcWorkQueue API parity");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

