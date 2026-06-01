const WASM_PAGE_BYTES = 65_536;

export interface WasmSharedMemoryAllocation {
  readonly memory: WebAssembly.Memory;
  readonly sab: SharedArrayBuffer;
  readonly pages: number;
}

/** Allocate shared WebAssembly memory large enough to hold `byteLength` bytes.
 *  WebAssembly memories are page-granular (64 KiB), so callers should still use
 *  their own logical byteLength for layout validation and ignore the padded tail. */
export function allocateWasmSharedMemory(byteLength: number): WasmSharedMemoryAllocation {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`allocateWasmSharedMemory: byteLength must be a safe non-negative integer, got ${byteLength}`);
  }
  const pages = Math.max(1, Math.ceil(byteLength / WASM_PAGE_BYTES));
  const memory = new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
  return {
    memory,
    sab: memory.buffer as unknown as SharedArrayBuffer,
    pages,
  };
}
