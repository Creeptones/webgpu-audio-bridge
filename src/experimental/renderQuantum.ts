/**
 * webgpu-audio-bridge / experimental — `renderSizeHint` probe (0.9.73).
 *
 * The Web Audio spec gained an `AudioContextOptions.renderSizeHint`
 * construction knob (`"default"` | `"hardware"` | a numeric frame count)
 * plus a `BaseAudioContext.renderQuantumSize` readback attribute. Blink has
 * been running an origin-trial-style experiment around it. The historical
 * render quantum has been fixed at **128 frames** since AudioWorklet shipped;
 * a smaller quantum (e.g. **64**) halves the worklet scheduling granularity —
 * ~1.33 ms vs ~2.67 ms at 48 kHz.
 *
 * For this bridge that granularity is the single largest *reducible* term in
 * the Turbo input-latency floor: a control frame pushed by the worker lands
 * somewhere inside the current quantum and is not consumed until the
 * AudioWorklet's next `process()` callback. Shrinking the quantum shrinks the
 * average wait. (It does NOT touch the SAB hop, which is already sub-µs, and
 * it does NOT touch the output buffer / DAC term — see `outputLatency`.)
 *
 * ── Why this lives under `/experimental` ─────────────────────────────────
 *
 *   - `renderSizeHint` is a **hint**, not a guarantee. A browser may clamp,
 *     round to a supported size, ignore it entirely, or expose the readback
 *     attribute while still rendering 128. Only a *measurement* tells you
 *     what you got — hence `measureRenderQuantum()` returns `renderQuantumSize`
 *     (the readback) alongside `honored` (did the readback match a numeric
 *     request).
 *   - The shape here may break across MINOR bumps as the spec settles. The
 *     `getEnvironmentReport().renderSizeHint` capability flag (main entry
 *     point) is the *stable* pre-construction sniff; this helper is the
 *     unstable, gesture-and-context-requiring measurement layer.
 *
 * ── Why this is NOT in `environment.ts` ──────────────────────────────────
 *
 * `getEnvironmentReport()` is contractually pure feature-detection — it MUST
 * NOT instantiate an `AudioContext` (costs hardware resources; needs a user
 * activation gesture). Measuring the *actual* quantum requires both. So the
 * sniff lives there; the measurement lives here.
 */

// ── Public types ──────────────────────────────────────────────────────────

/**
 * The `renderSizeHint` construction value. `"default"` keeps the UA default
 * (historically 128). `"hardware"` asks the UA to match the audio hardware's
 * native buffer size. A number requests that exact frame count (the UA may
 * clamp / round / ignore).
 */
export type RenderSizeHint = "default" | "hardware" | number;

/** Quantum-boundary scheduling latency, in milliseconds, for one quantum. */
export interface QuantumLatencyMs {
  /** Full quantum duration — worst case, when a push *just* missed a callback. */
  readonly worstCaseMs: number;
  /** Half the quantum — the expected wait for a uniformly-timed push. */
  readonly averageMs: number;
}

/**
 * Frozen, JSON-serializable result of one `measureRenderQuantum()` call.
 *
 * Every latency field is also surfaced in milliseconds (the raw Web Audio
 * attributes are in seconds) so a UI / report can render without arithmetic.
 * Fields that could not be read are `null` (never `NaN` / `undefined`), so
 * the object round-trips through `JSON.stringify` losslessly.
 */
export interface RenderQuantumReport {
  /** Exactly what was passed as the hint. */
  readonly requested: RenderSizeHint;
  /**
   * Whether `renderQuantumSize` was readable on the constructed context.
   * `false` means the browser predates the attribute — the hint was inert.
   */
  readonly supported: boolean;
  /** The UA's actual render quantum, read back from `ctx.renderQuantumSize`. */
  readonly renderQuantumSize: number | null;
  /**
   * `true` when the request was a number AND the readback equals it. For
   * `"default"` / `"hardware"` requests (no specific target to match)
   * `honored` mirrors `supported` — we cannot assert intent was met, only
   * that the attribute exists.
   */
  readonly honored: boolean;
  /** Raw `ctx.sampleRate` (Hz). */
  readonly sampleRate: number | null;
  /** Raw `ctx.baseLatency` (seconds) — quantum→audio-subsystem buffering. */
  readonly baseLatency: number | null;
  /** Raw `ctx.outputLatency` (seconds) — estimate, quantum→DAC, varies by HW. */
  readonly outputLatency: number | null;
  /** `baseLatency` in ms (null if unreadable). */
  readonly baseLatencyMs: number | null;
  /** `outputLatency` in ms (null if unreadable). */
  readonly outputLatencyMs: number | null;
  /** Quantum-boundary scheduling latency derived from size + sampleRate. */
  readonly quantumLatencyMs: QuantumLatencyMs | null;
  /**
   * A back-of-envelope input→audible floor for a control-lane push:
   * `quantumLatencyMs.averageMs + (outputLatencyMs ?? baseLatencyMs)`.
   * The SAB hop (sub-µs) is omitted as negligible. Informational — run
   * `bench/render-size-hint/` for a measured number on real hardware.
   */
  readonly estimatedInputToAudibleMs: number | null;
  /** Non-null if construction / measurement threw — the message, never the Error. */
  readonly error: string | null;
}

/** Options for `measureRenderQuantum()`. */
export interface MeasureRenderQuantumOptions {
  /** The `renderSizeHint` to request. Default `"default"`. */
  readonly hint?: RenderSizeHint;
  /** Passed through as `AudioContextOptions.latencyHint`. Default `"interactive"`. */
  readonly latencyHint?: "balanced" | "interactive" | "playback" | number;
  /** Passed through as `AudioContextOptions.sampleRate`. Omitted by default. */
  readonly sampleRate?: number;
  /**
   * Call `ctx.resume()` before reading latencies. A suspended context can
   * report a stale / zero `outputLatency`; resuming (needs a prior user
   * gesture) yields the realistic estimate. Default `true`.
   */
  readonly resume?: boolean;
  /**
   * Leave the context open and return it on `report`-adjacent state. Default
   * `false` — the helper closes the context it created so a sweep of many
   * hints does not leak hardware contexts (browsers cap concurrent contexts).
   */
  readonly keepOpen?: boolean;
  /**
   * Inject the constructor (for tests / non-DOM hosts). Defaults to
   * `globalThis.AudioContext`. The structural shape is all this helper reads.
   */
  readonly AudioContextCtor?: AudioContextCtorLike;
}

// ── Structural AudioContext shape ───────────────────────────────────────────
//
// Mirrors environment.ts's approach: this module compiles under Node (tsx
// tests) where lib.dom's AudioContext is absent, so we describe only the
// surface we touch rather than depending on the ambient DOM type.

interface AudioContextLike {
  readonly sampleRate: number;
  readonly state: string;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly renderQuantumSize?: number;
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** Constructor shape for an `AudioContext`-like, accepting the options bag. */
export type AudioContextCtorLike = new (
  options?: {
    latencyHint?: "balanced" | "interactive" | "playback" | number;
    sampleRate?: number;
    renderSizeHint?: RenderSizeHint;
  },
) => AudioContextLike;

// ── Pure helpers ────────────────────────────────────────────────────────────

const MS_PER_S = 1000;

/**
 * Quantum-boundary scheduling latency for a given quantum size and sample
 * rate. Pure — no AudioContext, safe to call anywhere. Worst case is one full
 * quantum (a push that just missed the callback); average is half (uniform
 * push timing within the quantum).
 *
 * @throws RangeError if `quantum` or `sampleRate` is not a positive finite number.
 */
export function quantumLatencyMs(quantum: number, sampleRate: number): QuantumLatencyMs {
  if (!Number.isFinite(quantum) || quantum <= 0) {
    throw new RangeError(`quantum must be a positive finite number, got ${quantum}`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be a positive finite number, got ${sampleRate}`);
  }
  const worstCaseMs = (MS_PER_S * quantum) / sampleRate;
  return Object.freeze({ worstCaseMs, averageMs: worstCaseMs / 2 });
}

/**
 * `true` when `BaseAudioContext.renderQuantumSize` (and therefore the
 * `renderSizeHint` construction option) is present on this host. Mirrors
 * `getEnvironmentReport().renderSizeHint`; provided here so experimental-
 * subpath callers do not have to import the main entry point. Interface-
 * presence sniff — does NOT construct a context.
 */
export function isRenderSizeHintSupported(): boolean {
  const g = globalThis as {
    BaseAudioContext?: { prototype?: object };
    AudioContext?: { prototype?: object };
  };
  const baseProto = g.BaseAudioContext?.prototype;
  if (baseProto && typeof baseProto === "object" && "renderQuantumSize" in baseProto) {
    return true;
  }
  const acProto = g.AudioContext?.prototype;
  if (acProto && typeof acProto === "object" && "renderQuantumSize" in acProto) {
    return true;
  }
  return false;
}

// ── Measurement ──────────────────────────────────────────────────────────────

function resolveCtor(opt?: AudioContextCtorLike): AudioContextCtorLike | null {
  if (opt) return opt;
  const g = globalThis as { AudioContext?: AudioContextCtorLike };
  return typeof g.AudioContext === "function" ? g.AudioContext : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function buildReport(args: {
  requested: RenderSizeHint;
  ctx: AudioContextLike | null;
  error: string | null;
}): RenderQuantumReport {
  const { requested, ctx, error } = args;
  const renderQuantumSize = ctx ? num(ctx.renderQuantumSize) : null;
  const sampleRate = ctx ? num(ctx.sampleRate) : null;
  const baseLatency = ctx ? num(ctx.baseLatency) : null;
  const outputLatency = ctx ? num(ctx.outputLatency) : null;
  const supported = renderQuantumSize !== null;

  const honored =
    typeof requested === "number" ? renderQuantumSize === requested : supported;

  const baseLatencyMs = baseLatency === null ? null : baseLatency * MS_PER_S;
  const outputLatencyMs = outputLatency === null ? null : outputLatency * MS_PER_S;

  const qLat =
    renderQuantumSize !== null && sampleRate !== null
      ? quantumLatencyMs(renderQuantumSize, sampleRate)
      : null;

  const outputTermMs = outputLatencyMs ?? baseLatencyMs;
  const estimatedInputToAudibleMs =
    qLat !== null && outputTermMs !== null ? qLat.averageMs + outputTermMs : null;

  return Object.freeze({
    requested,
    supported,
    renderQuantumSize,
    honored,
    sampleRate,
    baseLatency,
    outputLatency,
    baseLatencyMs,
    outputLatencyMs,
    quantumLatencyMs: qLat,
    estimatedInputToAudibleMs,
    error,
  });
}

/**
 * Construct an `AudioContext` with the requested `renderSizeHint`, read back
 * what the browser actually did, and return a frozen {@link RenderQuantumReport}.
 *
 * Requires a real (or injected) `AudioContext` constructor and — for a
 * realistic `outputLatency` — a prior user activation gesture so `resume()`
 * succeeds. Closes the context it created unless `keepOpen` is set.
 *
 * **Never throws** for the common failure modes (no constructor, construction
 * error, resume rejection): those surface in `report.error` so a sweep keeps
 * going. Compare `report.honored` / `report.renderQuantumSize` across hints to
 * see whether the browser is actually moving the quantum.
 *
 * @example
 * ```ts
 * import { measureRenderQuantum } from "webgpu-audio-bridge/experimental";
 * // inside a click handler (user gesture):
 * const r = await measureRenderQuantum({ hint: 64 });
 * console.log(r.renderQuantumSize, r.honored, r.estimatedInputToAudibleMs);
 * ```
 */
export async function measureRenderQuantum(
  options: MeasureRenderQuantumOptions = {},
): Promise<RenderQuantumReport> {
  const requested: RenderSizeHint = options.hint ?? "default";
  const Ctor = resolveCtor(options.AudioContextCtor);
  if (!Ctor) {
    return buildReport({
      requested,
      ctx: null,
      error: "AudioContext constructor is unavailable on this host.",
    });
  }

  let ctx: AudioContextLike | null = null;
  let error: string | null = null;
  try {
    ctx = new Ctor({
      latencyHint: options.latencyHint ?? "interactive",
      ...(options.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {}),
      renderSizeHint: requested,
    });
    if (options.resume !== false && typeof ctx.resume === "function") {
      try {
        await ctx.resume();
      } catch (e) {
        // A blocked resume (no user gesture) is non-fatal — baseLatency /
        // renderQuantumSize are still readable; only outputLatency may be stale.
        error = `resume() failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const report = buildReport({ requested, ctx, error });

  if (ctx && !options.keepOpen) {
    try {
      await ctx.close();
    } catch {
      /* context already closing / closed — nothing actionable */
    }
  }

  return report;
}

/**
 * Sweep several hints in sequence and return one report each. Sequential (not
 * `Promise.all`) on purpose: browsers cap concurrent `AudioContext`s, and each
 * helper call opens then closes one. Order of results matches `hints`.
 *
 * @example
 * ```ts
 * const reports = await sweepRenderQuantum(["default", 64, 128, 256, "hardware"]);
 * ```
 */
export async function sweepRenderQuantum(
  hints: ReadonlyArray<RenderSizeHint>,
  options: Omit<MeasureRenderQuantumOptions, "hint"> = {},
): Promise<RenderQuantumReport[]> {
  const out: RenderQuantumReport[] = [];
  for (const hint of hints) {
    out.push(await measureRenderQuantum({ ...options, hint }));
  }
  return out;
}
