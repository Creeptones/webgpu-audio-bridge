import {
  MpmcWorkQueue,
  type MpmcWorkQueueOptions,
} from "./MpmcWorkQueue.js";
import {
  type FieldsObject,
  type Schema,
} from "./schema.js";

export type WasmMpmcClaimTicket = () => number;

export type WasmMpmcClaimSource =
  | WebAssembly.Instance
  | { readonly exports: { readonly claim_ticket?: unknown } }
  | { readonly claim_ticket?: unknown };

function resolveClaimTicket(source: WasmMpmcClaimSource): WasmMpmcClaimTicket {
  const exportsOrSource =
    "exports" in source ? source.exports : source;
  const claim = exportsOrSource.claim_ticket;
  if (typeof claim !== "function") {
    throw new Error("WasmMpmcWorkQueue: wasm export 'claim_ticket' must be a function");
  }
  return claim as WasmMpmcClaimTicket;
}

/** Experimental WASM-backed MpmcWorkQueue variant.
 *
 * This class replaces only the contended dequeue claim with a WASM
 * `i32.atomic.rmw.add` kernel. Since 0.9.947 the kernel is an UNCONDITIONAL
 * fetch-add (no `-1` "empty" sentinel — every i32 is a valid ticket); the
 * emptiness pre-check stays in `MpmcWorkQueue.pull`. **Do not pair this class
 * with a module emitted before 0.9.947**: such a module can return `-1`
 * WITHOUT claiming (if the queue drains between `pull`'s check and its own),
 * which this class would treat as a real ticket. `connectWorkQueue` /
 * `connectGraph` emit the module at allocation time, so they always match. The SAB must be the `.buffer` of the same shared
 * `WebAssembly.Memory` used to instantiate the kernel; allocate it with
 * `allocateWasmSharedMemory(MpmcWorkQueue.byteLength(...))`.
 */
export class WasmMpmcWorkQueue<S extends Schema<FieldsObject, any>>
  extends MpmcWorkQueue<S> {
  private readonly wasmClaimTicket: WasmMpmcClaimTicket;

  constructor(
    sab: SharedArrayBuffer,
    schema: S,
    capacity: number,
    claimSource: WasmMpmcClaimSource,
    opts?: MpmcWorkQueueOptions,
  ) {
    super(sab, schema, capacity, opts);
    this.wasmClaimTicket = resolveClaimTicket(claimSource);
  }

  protected override claimTicket(): number {
    return this.wasmClaimTicket() | 0;
  }
}

