/**
 * JitKernelConsumer — the worklet-side live-swap runtime
 * (0.9.914 — Apollo Frontier 5, The Autonomous JIT, Stage 1b).
 *
 * The SECOND half of the runtime (after `JitKernelSwap`, the pure schedule). This
 * is the audio-thread object that actually runs the developer's naive JS kernel,
 * accepts a gate-PASSED SIMD `WebAssembly.Module`, instantiates it BETWEEN quanta,
 * and crossfades the live signal from the JS kernel onto the SIMD kernel without
 * a click — degrading to the JS kernel on EVERY failure.
 *
 * ─── The two kernels + the disjoint scratch ────────────────────────────────
 *
 * A JIT kernel is the ABI `emitKernelWat.paramLayout` defines:
 *   (func $kernel (param $trip i32) (param $arr i32)… (param $scalar f32|f64)…)
 *   over (import "env" "memory" (memory 1 16384 shared)).
 * Arg order: trip count → arrays (i32 byte offsets, SIGNATURE order) → scalars
 * (width type, signature order). The kernel reads input arrays + writes output
 * arrays at those byte offsets in the SHARED memory; it allocates nothing.
 *
 * The developer's JS fallback is the SAME function, called with typed-array
 * VIEWS over the same byte ranges (so both kernels see byte-identical, width-
 * rounded inputs — the JS fallback therefore reproduces exactly the "naive JS"
 * stream the gate's third oracle compared against, which is what makes the
 * failure-degrade invariant well-defined: on any failure the output equals the
 * pure-JS-kernel stream).
 *
 * During a fade BOTH kernels run every quantum, so their outputs MUST land in
 * disjoint byte ranges or the blend silently corrupts. This consumer owns the
 * offset allocator and lays out, pairwise-disjoint:
 *   - one input slab per input array (the pull-scratch the kernel reads),
 *   - an output slab for generation A (the current kernel), and
 *   - an output slab for generation B (the incoming kernel).
 * The kernel ABI takes `outPtr` as a param precisely so each generation writes
 * its own slab. The constructor runs an explicit disjointness assertion over the
 * whole layout (`describeLayout()` exposes it for an independent test).
 *
 * ─── Synchronous instantiation, never `process()` ──────────────────────────
 *
 * `installCompiledKernel(module)` does a SYNCHRONOUS
 * `new WebAssembly.Instance(module, { env: { memory } })`. That is microseconds —
 * parse/validate/codegen already happened off-thread in `WebAssembly.compile`.
 * It MUST be called from the worklet's `port.onmessage` (between quanta), NEVER
 * inside `process()`. Async `WebAssembly.instantiate`/`compile` on the audio
 * thread is FORBIDDEN (it can block a render quantum). `installCompiledKernel`
 * arms the swap; the first subsequent `process()` anchors the fade window.
 *
 * ─── The failure envelope (audio MUST keep running on the JS kernel) ────────
 *
 *   - no shared memory / no WASM-SIMD+threads → JIT disabled; install is a no-op,
 *     process always runs JS.
 *   - `new Instance` throws → caught; the swap is NOT armed; current stays JS.
 *   - a runtime non-finite value from the incoming kernel DURING a fade → abort
 *     the fade, drop the SIMD instance(s), snap back to the JS fallback for that
 *     quantum and onward.
 * In every case the emitted stream equals the pure-JS-kernel stream. (The other
 * envelope cases — parse/compile error, gate rejection, a non-cloneable Module —
 * are upstream: the background worker simply never sends a Module, so this object
 * never sees one. The bytes-clone fallback for the Module-transport case is
 * `installCompiledKernelFromBytes`.)
 *
 * ─── Per-generation state slabs (Apollo Frontier 7, Stage 2) ───────────────
 *
 * A stateful kernel carries single-sample state registers (a `z⁻¹`, a biquad's
 * delay line, IIR feedback). Persisting that state click-free across `process()`
 * quanta is what Stage 2 adds — a kernel that reset its `z⁻¹` every 128 samples
 * would click once per quantum.
 *
 * The slab is the WASM ABI's `$__state` arg (`emitKernelWat.paramLayout`): a
 * contiguous run of `stateDecls.length` width-sized values (declaration order)
 * the kernel LOADS at entry + STORES at exit, never initializes. The JS fallback
 * takes the same slab as a TRAILING typed-array arg (`emitJsKernel`). Persistence
 * is therefore automatic once the slab is never zeroed between quanta — the only
 * rule is "seed exactly once, at install (per generation), never mid-stream".
 *
 * During a fade kernel A (current) and kernel B (incoming) are DIFFERENT
 * recurrences, so each keeps its OWN slab (slab-A / slab-B): B reading A's filter
 * memory would corrupt its recurrence. Each generation fills its own output slab
 * from its own state, and the consumer amplitude-blends the two OUTPUTS exactly
 * as it blends two stateless outputs — so the blend is untouched. A freshly
 * installed kernel starts cold (slab seeded to inits); the rising crossfade gain
 * masks the short settling transient. On promotion B's accrued state is copied
 * into the current slab (continuity, not a re-seed). On a non-finite abort the
 * consumer snaps to current-A, whose slab has been advancing every quantum and is
 * live — B's slab is NOT seeded from A's.
 *
 * TODO (bumpless transfer, deferred): for a swap that changes only a COEFFICIENT
 * on the SAME topology — predicate: outgoing and incoming kernels have identical
 * ordered `(name, init)` `stateDecls` — seeding slab-B from slab-A at the swap
 * instant would give click-free continuity with no cold transient. v1 ships
 * cold-start + crossfade (correct + sufficient); the predicate is noted, not built.
 *
 * A stateless kernel (`stateDecls` absent/empty) reserves NO slab and takes every
 * pre-Stage-2 code path bit-for-bit (the frontier gate).
 *
 * @experimental — exported from `webgpu-audio-bridge/experimental`, NOT the 1.0
 * core. Mirrors the `compileKernel` / `JitKernelSwap` surface.
 */

import {
  type KernelSignature, type LaneWidth, type IrStateDecl,
  ELEM_BYTES, signatureWidth,
} from "./ir.js";
import { JitKernelSwap, type JitKernelSwapOptions, type JitSwapPhase } from "./JitKernelSwap.js";
import { hasWasmConsumerSupport } from "../worklet/wasmSimdSupport.js";

/** Maximum state registers a single stateful generation can carry (sizes the
 *  reserved per-generation state slab). Matches the `SpmcRing` consumer cap
 *  precedent. A kernel declaring more registers than this is not installable
 *  (`installCompiledKernel*` returns false). The reservation is FIXED so the
 *  layout, the disjointness assertion, and `jitMemoryPages` stay independent of
 *  the live register count (which is only known when a kernel is installed). */
export const MAX_STATE_REGISTERS = 64;

/** The developer's naive scalar kernel, called with the SAME positional argument
 *  order as the source function (signature order): `length → n`, `scalar →
 *  rounded value`, array → a typed-array VIEW over the shared-memory slab. */
export type JitJsKernel = (...args: unknown[]) => void;

/** Construction options for `JitKernelConsumer`. */
export interface JitKernelConsumerOptions extends JitKernelSwapOptions {
  /** The shared WebAssembly.Memory the kernels operate over. In the live worklet
   *  this is the same `Memory` whose `.buffer` is the Bridge SAB. */
  readonly memory: WebAssembly.Memory;
  /** The kernel I/O shape (the same `KernelSignature` passed to `compileKernel`). */
  readonly signature: KernelSignature;
  /** The developer's permanent JS fallback kernel. Retained forever. */
  readonly jsKernel: JitJsKernel;
  /** Maximum block size `n` per `process()` quantum (sizes every slab). */
  readonly maxBlock: number;
  /** Byte offset in `memory` where this consumer's working region begins
   *  (everything below is the Bridge's / caller's). Default 16 (a null-guard
   *  gap). Must be a multiple of 16. */
  readonly baseOffset?: number;
  /** Audio sample rate (Hz). Used to convert per-sample offsets to ns for the
   *  fade clock. May be omitted here and supplied per `process()` call. */
  readonly sampleRate?: number;
  /** The WASM export name the compiled module exposes. Default `"kernel"`
   *  (matches `compileKernel`). */
  readonly exportName?: string;
  /** The kernel's declared state registers (Apollo Frontier 7, Stage 2),
   *  declaration order. Absent/empty ⇒ a STATELESS consumer — every code path is
   *  the pre-Stage-2 path, bit-for-bit (the frontier gate). When present the
   *  consumer reserves two disjoint per-generation state slabs (current-A +
   *  incoming-B), seeds them to the declared `init`s, threads each generation's
   *  slab offset into its kernel args, and keeps state continuous across quanta
   *  (load-at-entry / store-at-exit, never re-seeded mid-stream). This is the
   *  JS-fallback / current-A state shape; an incoming SIMD kernel's state shape
   *  rides on the install message and must match it (v1: `connectJit` derives
   *  both from the same kernel, so they always do). */
  readonly stateDecls?: ReadonlyArray<IrStateDecl>;
}

/** One memory region in the consumer's layout (for the disjointness test). */
export interface JitMemoryRegion {
  readonly label: string; // e.g. "in:x", "outA:y", "outB:y"
  readonly offset: number;
  readonly bytes: number;
}

/** Result of one `process()` quantum (diagnostics + test assertions). */
export interface JitProcessResult {
  readonly phase: JitSwapPhase;
  /** Crossfade weight at the quantum base (0 idle/priming, 0→1 fading, 1 complete). */
  readonly weight: number;
  /** Whether the SIMD/WASM kernel contributed to the output this quantum. */
  readonly ranSimd: boolean;
  /** Whether a non-finite incoming output snapped the consumer back to JS this
   *  quantum (the failure-degrade path). */
  readonly abortedToJs: boolean;
}

type TypedArray = Float32Array | Float64Array;
type WritableBuffer = { length: number; [i: number]: number };

interface ArrayParam {
  readonly name: string;
  readonly role: "input" | "output";
}

export class JitKernelConsumer {
  private readonly memory: WebAssembly.Memory;
  private readonly signature: KernelSignature;
  private readonly jsKernel: JitJsKernel;
  private readonly width: LaneWidth;
  private readonly elemBytes: number;
  private readonly maxBlock: number;
  private readonly exportName: string;
  private readonly round: (v: number) => number;
  private readonly TA: Float32ArrayConstructor | Float64ArrayConstructor;
  private readonly swap: JitKernelSwap;
  private readonly defaultWindowSeconds: number;
  private _sampleRate: number;

  /** True iff the runtime supports the WASM consumer AND `memory` is shared. */
  readonly jitEnabled: boolean;

  // ── layout (byte offsets in `memory`) ──────────────────────────────────────
  private readonly inOff: Record<string, number> = {};
  private readonly outOffA: Record<string, number> = {};
  private readonly outOffB: Record<string, number> = {};
  private readonly arrayParams: ArrayParam[] = []; // signature order
  private readonly inputNames: string[] = [];
  private readonly outputNames: string[] = [];
  private readonly scalarNames: string[] = []; // signature order
  private readonly regions: JitMemoryRegion[] = [];
  private readonly regionEnd: number;

  // ── per-generation state slabs (Frontier 7, Stage 2) ────────────────────────
  // `stateful` is fixed at construction (the JS fallback's state shape). When
  // true, two disjoint slabs are reserved — slab-A (current generation) and
  // slab-B (incoming generation). Each generation reads/writes ONLY its own slab
  // so two different recurrences never corrupt each other mid-fade (§3.6); the
  // output blend is the SAME amplitude crossfade as the stateless case. The live
  // register count per generation rides on `_stateDecls{A,B}` (≤ MAX_STATE_REGISTERS).
  private readonly stateful: boolean;
  private stateOffA = 0;
  private stateOffB = 0;
  private _stateDeclsA: ReadonlyArray<IrStateDecl> = [];
  private _stateDeclsB: ReadonlyArray<IrStateDecl> = [];
  private _stateViewA: TypedArray | null = null;
  private _stateViewB: TypedArray | null = null;
  private _jsStateSlot = -1; // trailing state-slab arg index in _jsArgsA/_jsArgsB

  // ── cached views over `memory.buffer` (rebuilt if the buffer identity moves) ─
  private _viewBuffer: ArrayBufferLike | null = null;
  private _inViews: Record<string, TypedArray> = {};
  private _outViewsA: Record<string, TypedArray> = {};
  private _outViewsB: Record<string, TypedArray> = {};

  // ── prebuilt WASM/JS arg arrays (alloc-free steady state) ───────────────────
  // wasm: [n, ...arrayOffsets(sig order), ...scalars(sig order)]. Offsets are
  // generation-specific (A = current slab, B = incoming slab).
  private readonly _wasmArgsA: number[] = [];
  private readonly _wasmArgsB: number[] = [];
  private readonly _wasmScalarSlots: Array<{ index: number; name: string }> = [];
  // js: full signature order; views are filled in refreshViews().
  private _jsArgsA: unknown[] = [];
  private _jsArgsB: unknown[] = [];
  private _jsLengthSlot = -1;
  private readonly _jsScalarSlots: Array<{ index: number; name: string }> = [];
  private readonly _jsArraySlots: Array<{ index: number; name: string; role: "input" | "output" }> = [];

  // ── kernel lifetimes ────────────────────────────────────────────────────────
  // current = the audible kernel (null ⇒ the JS fallback; else a promoted SIMD).
  private _currentWasm: WebAssembly.Instance | null = null;
  private _currentKernelFn: ((...a: number[]) => void) | null = null;
  // incoming = the SIMD kernel being faded in.
  private _incoming: WebAssembly.Instance | null = null;
  private _incomingKernelFn: ((...a: number[]) => void) | null = null;
  // retiring = a superseded SIMD instance, dropped `complete + retireCountdown`.
  private _retiring: WebAssembly.Instance | null = null;
  private _retireCountdown = 0;

  constructor(opts: JitKernelConsumerOptions) {
    this.memory = opts.memory;
    this.signature = opts.signature;
    this.jsKernel = opts.jsKernel;
    this.width = signatureWidth(opts.signature);
    this.elemBytes = ELEM_BYTES[this.width];
    this.exportName = opts.exportName ?? "kernel";
    this.round = this.width === "f32" ? Math.fround : (v: number) => v;
    this.TA = this.width === "f32" ? Float32Array : Float64Array;
    if (!Number.isInteger(opts.maxBlock) || opts.maxBlock <= 0) {
      throw new Error(`JitKernelConsumer: maxBlock must be a positive integer, got ${opts.maxBlock}`);
    }
    this.maxBlock = opts.maxBlock;
    this._sampleRate = opts.sampleRate ?? 0;
    this.defaultWindowSeconds = opts.windowSeconds ?? 0.01;
    this.swap = new JitKernelSwap({ continuity: opts.continuity, windowSeconds: this.defaultWindowSeconds });

    // ── statefulness (Frontier 7) — fixed at construction (the JS fallback shape) ─
    const ctorDecls = opts.stateDecls ?? [];
    if (ctorDecls.length > MAX_STATE_REGISTERS) {
      throw new Error(`JitKernelConsumer: ${ctorDecls.length} state registers exceeds the max of ${MAX_STATE_REGISTERS}`);
    }
    this.stateful = ctorDecls.length > 0;
    this._stateDeclsA = ctorDecls.slice();
    this._stateDeclsB = ctorDecls.slice();

    // ── classify params + lay out the disjoint slabs ──────────────────────────
    for (const p of this.signature.params) {
      if (p.role === "input") { this.arrayParams.push({ name: p.name, role: "input" }); this.inputNames.push(p.name); }
      else if (p.role === "output") { this.arrayParams.push({ name: p.name, role: "output" }); this.outputNames.push(p.name); }
      else if (p.role === "scalar") { this.scalarNames.push(p.name); }
    }
    if (this.outputNames.length === 0) {
      throw new Error("JitKernelConsumer: signature declares no output array");
    }

    const base = opts.baseOffset ?? 16;
    if (!Number.isInteger(base) || base < 0 || base % 16 !== 0) {
      throw new Error(`JitKernelConsumer: baseOffset must be a non-negative multiple of 16, got ${base}`);
    }
    const slot = align16(this.maxBlock * this.elemBytes);
    let cursor = base;
    const place = (label: string, table: Record<string, number>, name: string): void => {
      table[name] = cursor;
      this.regions.push({ label, offset: cursor, bytes: slot });
      cursor += slot;
    };
    for (const name of this.inputNames) place(`in:${name}`, this.inOff, name);
    for (const name of this.outputNames) place(`outA:${name}`, this.outOffA, name);
    for (const name of this.outputNames) place(`outB:${name}`, this.outOffB, name);
    // Two per-generation state slabs (Frontier 7) — fixed-max so the layout +
    // disjointness + page budget are independent of the live register count. Only
    // reserved for a stateful kernel, so a stateless layout is byte-identical to
    // pre-Stage-2 (the frontier gate).
    if (this.stateful) {
      const stateSlot = align16(MAX_STATE_REGISTERS * this.elemBytes);
      this.stateOffA = cursor;
      this.regions.push({ label: "stateA", offset: cursor, bytes: stateSlot });
      cursor += stateSlot;
      this.stateOffB = cursor;
      this.regions.push({ label: "stateB", offset: cursor, bytes: stateSlot });
      cursor += stateSlot;
    }
    this.regionEnd = cursor;
    assertDisjoint(this.regions);

    if (this.regionEnd > this.memory.buffer.byteLength) {
      throw new Error(
        `JitKernelConsumer: layout needs ${this.regionEnd} bytes but memory has only ` +
          `${this.memory.buffer.byteLength} (grow the WebAssembly.Memory)`,
      );
    }

    // ── prebuild the WASM arg arrays (offsets are stable across quanta) ────────
    this._wasmArgsA.push(0); // n slot (index 0)
    this._wasmArgsB.push(0);
    for (const ap of this.arrayParams) {
      if (ap.role === "input") {
        this._wasmArgsA.push(this.inOff[ap.name]!);
        this._wasmArgsB.push(this.inOff[ap.name]!);
      } else {
        this._wasmArgsA.push(this.outOffA[ap.name]!);
        this._wasmArgsB.push(this.outOffB[ap.name]!);
      }
    }
    // The `$__state` arg goes AFTER arrays, BEFORE scalars (matching paramLayout).
    // Its value is the generation's slab base offset — a constant (never updated
    // per-quantum), so it sits outside the scalar-slot index map below.
    if (this.stateful) {
      this._wasmArgsA.push(this.stateOffA);
      this._wasmArgsB.push(this.stateOffB);
    }
    for (const name of this.scalarNames) {
      this._wasmScalarSlots.push({ index: this._wasmArgsA.length, name });
      this._wasmArgsA.push(0);
      this._wasmArgsB.push(0);
    }

    // ── precompute the JS arg slot map (views are filled in refreshViews) ──────
    for (const p of this.signature.params) {
      const idx = this._jsArgsA.length;
      if (p.role === "length") { this._jsLengthSlot = idx; this._jsArgsA.push(0); this._jsArgsB.push(0); }
      else if (p.role === "scalar") { this._jsScalarSlots.push({ index: idx, name: p.name }); this._jsArgsA.push(0); this._jsArgsB.push(0); }
      else { this._jsArraySlots.push({ index: idx, name: p.name, role: p.role as "input" | "output" }); this._jsArgsA.push(null); this._jsArgsB.push(null); }
    }
    // The stateful JS fallback takes a TRAILING typed-array state slab arg
    // (`emitJsKernel`'s convention) — generation A's view in _jsArgsA, B's in
    // _jsArgsB. Bound to the actual views in refreshViews().
    if (this.stateful) {
      this._jsStateSlot = this._jsArgsA.length;
      this._jsArgsA.push(null);
      this._jsArgsB.push(null);
    }

    this.jitEnabled = hasWasmConsumerSupport() && isShared(this.memory);
    this.refreshViews();

    // Seed both generations cold (the declared inits) — exactly once, off the
    // audio thread. Persistence across quanta then follows from never re-seeding.
    if (this.stateful) {
      this.seedSlab(this._stateViewA!, this._stateDeclsA);
      this.seedSlab(this._stateViewB!, this._stateDeclsB);
    }
  }

  /** Seed a state slab's live prefix to the declared cold-start `init`s (the
   *  typed array rounds each to width on store, matching the WASM/JS kernels). */
  private seedSlab(view: TypedArray, decls: ReadonlyArray<IrStateDecl>): void {
    const len = Math.min(decls.length, view.length);
    for (let k = 0; k < len; k++) view[k] = decls[k]!.init;
  }

  /** Current swap phase. */
  phase(): JitSwapPhase {
    return this.swap.phase();
  }

  /** True while a SIMD kernel is being faded in (priming or fading). */
  isSwapping(): boolean {
    return this.swap.isSwapping();
  }

  /** True once a SIMD kernel has fully taken over (the steady upgraded state). */
  isUpgraded(): boolean {
    return this._currentWasm !== null && !this.swap.isSwapping();
  }

  /** Set / update the audio sample rate (Hz). */
  setSampleRate(sr: number): void {
    if (!Number.isFinite(sr) || sr <= 0) throw new Error(`JitKernelConsumer.setSampleRate: bad sampleRate ${sr}`);
    this._sampleRate = sr;
  }

  /** The consumer's owned memory regions (input slabs + both output generations),
   *  pairwise disjoint by construction. Exposed for an independent disjointness
   *  pin. */
  describeLayout(): { regions: JitMemoryRegion[]; baseEnd: number; width: LaneWidth } {
    return { regions: this.regions.map((r) => ({ ...r })), baseEnd: this.regionEnd, width: this.width };
  }

  /**
   * Synchronously instantiate a gate-PASSED SIMD `WebAssembly.Module` over this
   * consumer's shared memory and arm the swap. MUST be called from the worklet's
   * `port.onmessage` (between quanta), never inside `process()`.
   *
   * Returns true if the kernel was armed; false on every failure (JIT disabled,
   * instantiation threw, missing export) — in which case the current kernel keeps
   * running unchanged. Never throws.
   */
  installCompiledKernel(module: WebAssembly.Module, stateDecls?: ReadonlyArray<IrStateDecl>): boolean {
    if (!this.jitEnabled) return false;
    let inst: WebAssembly.Instance;
    try {
      inst = new WebAssembly.Instance(module, { env: { memory: this.memory } });
    } catch {
      return false; // `new Instance` threw → do NOT arm; current kernel stays.
    }
    return this.armInstance(inst, stateDecls);
  }

  /**
   * The bytes-clone fallback for the Module-transport path: synchronously
   * `new WebAssembly.Module(bytes)` (universally structured-cloneable) then
   * instantiate + arm. Use when a `WebAssembly.Module` could not be cloned into
   * the worklet realm. Compiling bytes synchronously is more expensive than
   * instantiating a pre-compiled Module — still microseconds for a kernel-sized
   * module, but keep it in `port.onmessage`, never in `process()`.
   */
  installCompiledKernelFromBytes(bytes: Uint8Array, stateDecls?: ReadonlyArray<IrStateDecl>): boolean {
    if (!this.jitEnabled) return false;
    let inst: WebAssembly.Instance;
    try {
      // Copy into a fresh ArrayBuffer-backed view (a SAB-backed Uint8Array is not
      // accepted by the Module ctor type).
      const buf = new Uint8Array(bytes.byteLength);
      buf.set(bytes);
      const mod = new WebAssembly.Module(buf);
      inst = new WebAssembly.Instance(mod, { env: { memory: this.memory } });
    } catch {
      return false;
    }
    return this.armInstance(inst, stateDecls);
  }

  private armInstance(inst: WebAssembly.Instance, stateDecls?: ReadonlyArray<IrStateDecl>): boolean {
    const fn = inst.exports[this.exportName];
    if (typeof fn !== "function") return false; // not a valid kernel module
    // State-shape compatibility: a stateless consumer reserved no slab, so it
    // cannot host a stateful kernel; a stateful consumer cannot host a kernel with
    // more registers than it reserved. Either ⇒ refuse the arm (current stays). In
    // v1 `connectJit` derives the JS fallback + the SIMD kernel from the same
    // source, so the shapes always match and neither guard fires.
    const incomingDecls = stateDecls ?? (this.stateful ? this._stateDeclsA : []);
    if (incomingDecls.length > 0 && !this.stateful) return false;
    if (incomingDecls.length > MAX_STATE_REGISTERS) return false;
    // Replace any in-flight incoming: abandon it, snap the swap, re-arm fresh.
    if (this.swap.isSwapping()) {
      this.swap.reset();
      this._incoming = null;
      this._incomingKernelFn = null;
    }
    // Seed slab-B cold for the incoming generation (its OWN recurrence memory —
    // NEVER copied from slab-A; §3.6). A freshly-installed kernel starts cold; the
    // rising crossfade gain masks the short settling transient.
    if (this.stateful) {
      this._stateDeclsB = incomingDecls;
      this.seedSlab(this._stateViewB!, incomingDecls);
    }
    this._incoming = inst;
    this._incomingKernelFn = fn as (...a: number[]) => void;
    this.swap.armSwap(this.defaultWindowSeconds);
    return true;
  }

  /**
   * Abandon any SIMD kernel and revert to the permanent JS fallback (the "Force
   * JS" path + the internal non-finite abort). Drops all WASM instances; the next
   * `process()` runs pure JS.
   */
  revertToFallback(): void {
    this.swap.reset();
    this._currentWasm = null;
    this._currentKernelFn = null;
    this._incoming = null;
    this._incomingKernelFn = null;
    this._retiring = null;
    this._retireCountdown = 0;
  }

  /**
   * Run one audio quantum. Copies `inputs` into the input slabs, advances the
   * swap, runs the appropriate kernel(s), and writes each output array's result
   * into `outs[name]`.
   *
   * @param inputs  input-array name → this quantum's `n` source samples.
   * @param scalars scalar-param name → this quantum's value (rounded to width).
   * @param outs    output-array name → destination buffer (length ≥ n). For the
   *                single-output audio case this is `{ [outName]: channel }`.
   * @param n       block size (1 ≤ n ≤ maxBlock).
   * @param baseConsumerNs audio-clock time of the quantum base (e.g. currentTime*1e9).
   * @param sampleRate optional override of the configured sample rate.
   */
  process(
    inputs: Record<string, ArrayLike<number>>,
    scalars: Record<string, number>,
    outs: Record<string, WritableBuffer>,
    n: number,
    baseConsumerNs: number,
    sampleRate?: number,
  ): JitProcessResult {
    if (!Number.isInteger(n) || n < 0 || n > this.maxBlock) {
      throw new Error(`JitKernelConsumer.process: n must be in [0, ${this.maxBlock}], got ${n}`);
    }
    const sr = sampleRate ?? this._sampleRate;
    if (!Number.isFinite(sr) || sr <= 0) {
      throw new Error(`JitKernelConsumer.process: sampleRate must be set (got ${sr})`);
    }
    for (const name of this.outputNames) {
      const buf = outs[name];
      if (!buf || buf.length < n) throw new Error(`JitKernelConsumer.process: outs["${name}"] missing or shorter than n=${n}`);
    }

    this.refreshViews();

    // Retire a superseded instance once its grace quantum elapses.
    if (this._retiring !== null && --this._retireCountdown <= 0) {
      this._retiring = null;
      this._retireCountdown = 0;
    }

    // Copy inputs into the input slabs (rounds to width on store — both kernels
    // then read byte-identical inputs).
    for (const name of this.inputNames) {
      const src = inputs[name];
      if (!src || src.length < n) throw new Error(`JitKernelConsumer.process: inputs["${name}"] missing or shorter than n=${n}`);
      const view = this._inViews[name]!;
      for (let i = 0; i < n; i++) view[i] = src[i]!;
    }

    // Fill the per-quantum scalar slots (n + rounded scalars).
    this._wasmArgsA[0] = n;
    this._wasmArgsB[0] = n;
    for (const s of this._wasmScalarSlots) {
      const v = this.round(scalars[s.name] ?? 0);
      this._wasmArgsA[s.index] = v;
      this._wasmArgsB[s.index] = v;
    }
    if (this._jsLengthSlot >= 0) { this._jsArgsA[this._jsLengthSlot] = n; this._jsArgsB[this._jsLengthSlot] = n; }
    for (const s of this._jsScalarSlots) {
      const v = this.round(scalars[s.name] ?? 0);
      this._jsArgsA[s.index] = v;
      this._jsArgsB[s.index] = v;
    }

    const q = this.swap.beginQuantum(baseConsumerNs);

    // ── idle / priming: run ONLY the current kernel into generation A ──────────
    // (priming is armed-but-window-not-open: output stays exactly the current
    // kernel — weight 0 — until the first quantum anchors the fade.)
    if (q.phase === "idle" || q.phase === "priming") {
      this.runCurrentA();
      this.copyAtoOuts(outs, n);
      return { phase: q.phase, weight: 0, ranSimd: this._currentWasm !== null, abortedToJs: false };
    }

    // ── fading: run BOTH into disjoint slabs, amplitude-blend per sample ───────
    if (q.phase === "fading") {
      this.runCurrentA();
      this.runIncomingB();
      if (!this.outputsFiniteB(n)) {
        // Non-finite incoming → abort the fade and snap to current-A, whose output
        // is ALREADY in outA (it ran just above) and whose state slab is live (it
        // has advanced every quantum). Project outA + drop the incoming; do NOT
        // re-run current-A — re-running a STATEFUL kernel would double-advance its
        // state for this quantum. (For a stateless kernel the re-run was idempotent,
        // so this is bit-identical to the prior behavior.)
        this.copyAtoOuts(outs, n);
        this.revertToFallback();
        return { phase: this.swap.phase(), weight: 0, ranSimd: false, abortedToJs: true };
      }
      this.blendAtoBintoOuts(outs, n, baseConsumerNs, sr);
      return { phase: q.phase, weight: q.weight, ranSimd: true, abortedToJs: false };
    }

    // ── complete: promote the incoming kernel once, then run it alone ──────────
    if (q.justCompleted) {
      this._retiring = this._currentWasm; // old SIMD (or null if current was JS)
      this._retireCountdown = this._retiring ? 1 : 0;
      this._currentWasm = this._incoming;
      this._currentKernelFn = this._incomingKernelFn;
      this._incoming = null;
      this._incomingKernelFn = null;
      // Promotion (§3.6): B's slab BECOMES the current slab. The incoming kernel
      // ran into slab-B all through the fade, so slab-B holds its live recurrence
      // state; current now runs via slab-A, so copy B's state across (a tiny
      // ≤MAX-register copy) — continuity, NOT a re-seed. The retiring instance
      // does not run again, so overwriting slab-A is safe.
      if (this.stateful) {
        const len = Math.min(this._stateDeclsB.length, MAX_STATE_REGISTERS);
        const a = this._stateViewA!;
        const b = this._stateViewB!;
        for (let k = 0; k < len; k++) a[k] = b[k]!;
        this._stateDeclsA = this._stateDeclsB;
      }
    }
    this.runCurrentA();
    this.copyAtoOuts(outs, n);
    return { phase: q.phase, weight: 1, ranSimd: true, abortedToJs: false };
  }

  // ── kernel runners (the per-quantum n + scalars already live in the prebuilt
  //    arg arrays, set at the top of `process`) ────────────────────────────────

  /** Run the current kernel (JS fallback, or a promoted SIMD) into generation A. */
  private runCurrentA(): void {
    if (this._currentWasm !== null && this._currentKernelFn !== null) {
      this._currentKernelFn(...this._wasmArgsA);
    } else {
      this.runJsFallbackA();
    }
  }

  /** Run the developer's JS fallback into generation A (output views A). */
  private runJsFallbackA(): void {
    this.bindJsArrayViews(this._jsArgsA, "A");
    this.jsKernel(...this._jsArgsA);
  }

  /** Run the incoming SIMD kernel into generation B. */
  private runIncomingB(): void {
    this._incomingKernelFn!(...this._wasmArgsB);
  }

  /** Point the JS arg array's array slots at the generation's views. */
  private bindJsArrayViews(jsArgs: unknown[], gen: "A" | "B"): void {
    for (const slot of this._jsArraySlots) {
      if (slot.role === "input") jsArgs[slot.index] = this._inViews[slot.name]!;
      else jsArgs[slot.index] = gen === "A" ? this._outViewsA[slot.name]! : this._outViewsB[slot.name]!;
    }
  }

  // ── output projection / blend ────────────────────────────────────────────────

  /** Copy generation A's output slabs into the caller's `outs`. */
  private copyAtoOuts(outs: Record<string, WritableBuffer>, n: number): void {
    for (const name of this.outputNames) {
      const a = this._outViewsA[name]!;
      const dst = outs[name]!;
      for (let i = 0; i < n; i++) dst[i] = a[i]!;
    }
  }

  /** Per-sample AMPLITUDE crossfade A→B into `outs` (the per-sample form of
   *  `crossfadeInto(a, b, w, out, { mode: "amplitude" })`). Uses the EXACT-LERP
   *  form `a + w·(b−a)`, NOT `(1−w)·a + w·b`: when the JS and SIMD kernels agree
   *  bit-for-bit (the f64 case the gate proves, and the f32 no-cancellation
   *  case), `b−a` is exactly 0 and the output is bit-exactly `a` for every `w` —
   *  so the entire fade is acoustically transparent, not merely ≤1 ULP close. No
   *  power notch (the two kernels are ULP-correlated). */
  private blendAtoBintoOuts(outs: Record<string, WritableBuffer>, n: number, baseNs: number, sr: number): void {
    const nsPerSample = 1e9 / sr;
    for (const name of this.outputNames) {
      const a = this._outViewsA[name]!;
      const b = this._outViewsB[name]!;
      const dst = outs[name]!;
      for (let i = 0; i < n; i++) {
        const w = this.swap.weightAt(baseNs + i * nsPerSample);
        dst[i] = a[i]! + w * (b[i]! - a[i]!);
      }
    }
  }

  /** True iff every generation-B output sample over [0, n) is finite. */
  private outputsFiniteB(n: number): boolean {
    for (const name of this.outputNames) {
      const b = this._outViewsB[name]!;
      for (let i = 0; i < n; i++) if (!Number.isFinite(b[i]!)) return false;
    }
    return true;
  }

  // ── views ─────────────────────────────────────────────────────────────────

  /** Rebuild the typed-array views if the underlying buffer identity changed
   *  (a defensive guard — with a fixed-max non-growing memory it never does). */
  private refreshViews(): void {
    if (this._viewBuffer === this.memory.buffer) return;
    const buf = this.memory.buffer;
    this._viewBuffer = buf;
    for (const name of this.inputNames) this._inViews[name] = new this.TA(buf, this.inOff[name]!, this.maxBlock);
    for (const name of this.outputNames) {
      this._outViewsA[name] = new this.TA(buf, this.outOffA[name]!, this.maxBlock);
      this._outViewsB[name] = new this.TA(buf, this.outOffB[name]!, this.maxBlock);
    }
    // The two per-generation state slabs (a fixed-max window each). The trailing
    // JS state-slab arg points at the matching generation's view.
    if (this.stateful) {
      this._stateViewA = new this.TA(buf, this.stateOffA, MAX_STATE_REGISTERS);
      this._stateViewB = new this.TA(buf, this.stateOffB, MAX_STATE_REGISTERS);
      this._jsArgsA[this._jsStateSlot] = this._stateViewA;
      this._jsArgsB[this._jsStateSlot] = this._stateViewB;
    }
    // Bind the stable (input) JS array views; output views are re-bound per-gen
    // at call time (cheap, and keeps the A/B arg arrays correct after a rebuild).
    this.bindJsArrayViews(this._jsArgsA, "A");
    this.bindJsArrayViews(this._jsArgsB, "B");
  }
}

function align16(n: number): number { return (n + 15) & ~15; }

function isShared(memory: WebAssembly.Memory): boolean {
  if (typeof SharedArrayBuffer === "undefined") return false;
  return memory.buffer instanceof SharedArrayBuffer;
}

/** Throw if any two regions overlap (the load-bearing disjointness assertion). */
function assertDisjoint(regions: ReadonlyArray<JitMemoryRegion>): void {
  for (let i = 0; i < regions.length; i++) {
    const a = regions[i]!;
    for (let j = i + 1; j < regions.length; j++) {
      const b = regions[j]!;
      const overlap = a.offset < b.offset + b.bytes && b.offset < a.offset + a.bytes;
      if (overlap) {
        throw new Error(
          `JitKernelConsumer: scratch regions overlap — ${a.label}[${a.offset},${a.offset + a.bytes}) ` +
            `vs ${b.label}[${b.offset},${b.offset + b.bytes}); the blend would be corrupted`,
        );
      }
    }
  }
}
