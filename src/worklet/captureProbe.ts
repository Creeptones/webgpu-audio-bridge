/**
 * captureProbe — numerical-equivalence harness for consumer-side decoders.
 *
 * Harvested from the website's `simdCaptureProbe.ts` / `simdAbFlag.ts` pattern
 * (`../NewProject/website/src/lib/universe/devtools/`), generalized off modal
 * synthesis. The website renders 1 s of audio through each SIMD mode in an
 * isolated `OfflineAudioContext` and compares the buffers with RMS / max / first-
 * diff gates; this is the same idea applied to the bridge's decode paths:
 * decode the SAME frames through two strategies, flatten each to an f64 buffer,
 * and assert they agree within a tolerance band.
 *
 * Why a shared module rather than inline test code: three call sites want it —
 * the Node `wasmEquivalence` suite (WASM `decodeFrame` vs `Bridge.pull`), the
 * browser `decode-equivalence` spec (all three wired paths vs `Bridge.pull`
 * oracle), and the `examples/wasm-decode-worklet` self-check HUD. One tested
 * comparator, three consumers.
 *
 * The two functions here are PURE (no SAB, no WASM, no DOM), so they run
 * identically in Node and in a worklet/worker. The path-specific *capture*
 * (running a decoder over frames) is the caller's job — it needs the decoder;
 * this module only flattens + compares the results.
 *
 * ── Tolerance bands (mirroring the website's exit criteria) ──────────────────
 *
 *   - JS-vs-JS (e.g. `Bridge.pull` vs `emitWorkletReader`): BIT-EXACT. Both
 *     read the same little-endian bytes with the same width; `rms` and `max`
 *     must be 0. Use `TOLERANCE_EXACT`.
 *   - JS-vs-WASM whole-frame copy (`decodeFrame`): also bit-exact — the WASM
 *     path is a pure byte relocation, no arithmetic. Use `TOLERANCE_EXACT`.
 *   - JS-vs-WASM-SIMD trajectory eval (f32 lanes): NOT bit-exact — f32x4 math
 *     differs from scalar f64-promoted math by up to a few ULP. Use
 *     `TOLERANCE_F32_SIMD` (rms < 1e-4, max < 1e-3), the website's js-soa-vs-
 *     wasm band.
 */

/** Numeric/array field value as it appears on a decoded frame. */
type FieldValue = number | bigint | Float64Array | Float32Array
  | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array
  | BigInt64Array | BigUint64Array;

/**
 * Flatten a decoded frame's fields into one `Float64Array`, in the given field-
 * name order, for cross-path comparison. Scalars contribute one element;
 * arrays contribute their elements in order. BigInt values are coerced via
 * `Number(...)` — fine for the comparison (the bytes were already pinned
 * bit-exact upstream; this is about catching decode divergence, and frame
 * `seq`/timestamps stay well within `2^53`).
 *
 * Allocation: builds one output buffer sized to the total element count. The
 * caller can pass a pre-sized `out` to make it allocation-free across many
 * captures (the audio-thread discipline).
 */
export function flattenFrame(
  frame: Record<string, FieldValue>,
  fieldNames: readonly string[],
  out?: Float64Array,
): Float64Array {
  let total = 0;
  for (const name of fieldNames) {
    const v = frame[name];
    total += typeof v === "number" || typeof v === "bigint" ? 1 : (v as { length: number }).length;
  }
  const dst = out && out.length >= total ? out : new Float64Array(total);
  let i = 0;
  for (const name of fieldNames) {
    const v = frame[name];
    if (typeof v === "number") {
      dst[i++] = v;
    } else if (typeof v === "bigint") {
      dst[i++] = Number(v);
    } else {
      const arr = v as { length: number; [k: number]: number | bigint };
      for (let k = 0; k < arr.length; k++) {
        const e = arr[k];
        dst[i++] = typeof e === "bigint" ? Number(e) : (e as number);
      }
    }
  }
  return dst.length === total ? dst : dst.subarray(0, total);
}

/** Result of comparing two flattened captures. `firstDiffIndex` is -1 when the
 *  buffers are bit-identical, else the index of the first differing element. */
export interface CaptureComparison {
  /** Number of elements compared (min of the two lengths). */
  readonly length: number;
  /** Root-mean-square of the element-wise difference. 0 when bit-identical. */
  readonly rms: number;
  /** Max absolute element-wise difference. 0 when bit-identical. */
  readonly max: number;
  /** Index of the first element where `|a-b| > 0`, or -1 if none. */
  readonly firstDiffIndex: number;
  /** True iff the two buffers had the same length. A length mismatch is always
   *  a failure regardless of tolerance — it means the decoders disagree on
   *  shape, not just value. */
  readonly sameLength: boolean;
}

/**
 * Compare two flattened captures element-wise. Pure; NaN-aware (two NaNs at the
 * same index count as equal — a decoder faithfully relocating a NaN payload
 * shouldn't fail the gate).
 */
export function compareCaptures(a: Float64Array, b: Float64Array): CaptureComparison {
  const n = Math.min(a.length, b.length);
  let sumSq = 0;
  let max = 0;
  let firstDiff = -1;
  for (let i = 0; i < n; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av === bv || (Number.isNaN(av) && Number.isNaN(bv))) continue;
    const d = Math.abs(av - bv);
    if (firstDiff === -1) firstDiff = i;
    sumSq += d * d;
    if (d > max) max = d;
  }
  return {
    length: n,
    rms: n > 0 ? Math.sqrt(sumSq / n) : 0,
    max,
    firstDiffIndex: firstDiff,
    sameLength: a.length === b.length,
  };
}

/** Tolerance band: bit-exact. For JS-vs-JS and JS-vs-WASM-whole-frame-copy. */
export const TOLERANCE_EXACT = Object.freeze({ rms: 0, max: 0 });

/** Tolerance band: f32 SIMD vs scalar f64-promoted math (a few ULP). Mirrors
 *  the website's js-soa-vs-wasm exit criteria. */
export const TOLERANCE_F32_SIMD = Object.freeze({ rms: 1e-4, max: 1e-3 });

/** Decide whether a comparison passes a tolerance band. A length mismatch
 *  always fails. */
export function withinTolerance(
  cmp: CaptureComparison,
  tol: { rms: number; max: number },
): boolean {
  return cmp.sameLength && cmp.rms <= tol.rms && cmp.max <= tol.max;
}
