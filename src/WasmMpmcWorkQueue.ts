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
 * `i32.atomic.rmw.add` kernel. The SAB must be the `.buffer` of the same shared
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

