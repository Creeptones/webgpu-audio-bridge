import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import { emitWasmMpmc, emitWasmMpmcBytes } from "../src/emitWasmMpmc.js";

async function compileWat(wat: string): Promise<Uint8Array<ArrayBuffer>> {
  const wabt = await wabtInit();
  const mod = wabt.parseWat("mpmc-claim.wat", wat, { threads: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}

async function main(): Promise<void> {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const bytes = await compileWat(emitWasmMpmc({ memoryPages: { min: 1, max: 1 } }));
  const result = await WebAssembly.instantiate(bytes, { env: { memory } });
  const instance = result.instance;
  const claim = instance.exports.claim_ticket;
  assert(typeof claim === "function", "claim_ticket export present");

  const header = new Int32Array(memory.buffer, 0, 8);
  assertEq((claim as () => number)(), -1, "empty queue returns -1");
  Atomics.store(header, 0, 2);
  assertEq((claim as () => number)(), 0, "first claim returns old dequeue ticket");
  assertEq((claim as () => number)(), 1, "second claim returns next ticket");
  assertEq((claim as () => number)(), -1, "claim stops at enqueue frontier");
  assertEq(Atomics.load(header, 1), 2, "dequeue ticket advanced only for claims");

  Atomics.store(header, 0, -2_147_483_648);
  Atomics.store(header, 1, 2_147_483_647);
  assertEq((claim as () => number)(), 2_147_483_647, "signed diff wraps like JS Int32");
  assertEq(Atomics.load(header, 1), -2_147_483_648, "fetch-add wraps Int32");

  const paddedBytes = await compileWat(emitWasmMpmc({
    memoryPages: { min: 1, max: 1 },
    headerOffsets: { enqueueTicket: 0, dequeueTicket: 64 },
  }));
  const paddedMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const padded = await WebAssembly.instantiate(paddedBytes, { env: { memory: paddedMemory } });
  const paddedClaim = padded.instance.exports.claim_ticket as () => number;
  const paddedHeader = new Int32Array(paddedMemory.buffer, 0, 32);
  Atomics.store(paddedHeader, 0, 1);
  assertEq(paddedClaim(), 0, "padded dequeue offset claims ticket 0");
  assertEq(Atomics.load(paddedHeader, 16), 1, "padded dequeue lane advanced at byte 64");

  const binary = await WebAssembly.instantiate(emitWasmMpmcBytes({
    memoryPages: { min: 1, max: 1 },
    headerOffsets: { enqueueTicket: 0, dequeueTicket: 64 },
  }), { env: { memory: paddedMemory } });
  const binaryClaim = binary.instance.exports.claim_ticket as () => number;
  Atomics.store(paddedHeader, 0, 2);
  assertEq(binaryClaim(), 1, "binary emitter matches padded WAT semantics");

  assert(/i32\.atomic\.rmw\.add/.test(emitWasmMpmc()), "emitted WAT contains atomic add");
  ok("emitWasmMpmc emitted atomic add");
  console.log("ok: emitWasmMpmc claim semantics");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
