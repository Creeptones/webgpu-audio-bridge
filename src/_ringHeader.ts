/**
 * The SPSC ring header size — single source of truth (0.9.951).
 *
 * Bytes in the SAB ring header preceding slot 0: eight Int32 lanes (write /
 * read counters, flow_scale, torn-frame counter, PLL offset lo/hi, drift,
 * status). A dependency-free leaf module so the worklet entry
 * (`webgpu-audio-bridge/worklet`) can share it without importing SpscRing.
 * Previously `SpscRing.ts` and `worklet/index.ts` each declared their own
 * `32`, a silent-drift hazard. `SchemaLayoutDescription.headerBytes` is the
 * literal type `32` and is pinned against this constant in the tests.
 */
export const RING_HEADER_BYTES = 32;
