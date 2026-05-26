/**
 * Bridge<Schema> — schema-driven lock-free SPSC SAB ring.
 *
 * Generalization of Float64RingBuffer. The ring protocol, memory ordering,
 * and park/wake semantics are identical — only the payload codec is now
 * driven by a user-supplied `Schema` (see ./schema.ts) instead of the
 * hard-coded `[seq, tMacroNs, vMax, jMax] + V_eff[N] + J_eff[N]` frame.
 *
 * ─── Layout ──────────────────────────────────────────────────────────────
 *
 *   Header (32 bytes, Int32 lanes via Atomics):
 *     [byte 0..3]    write_index   producer counter (Atomics, release; wraps mod 2^32)
 *     [byte 4..7]    read_index    consumer counter (Atomics, release; wraps mod 2^32)
 *     [byte 8..11]   flow_scale    consumer→producer PI hint (Q16.16; 0.5..2.0)
 *                                  default 65536 = 1.0 (no scaling). Independent
 *                                  atomic — best-effort, no ordering vs the
 *                                  counter lanes. See "Adaptive backpressure"
 *                                  section below.
 *     [byte 12..15]  torn_frame_counter  monotonic Int32 wrap-counter; consumer
 *                                  increments on hard-error invariant failure.
 *                                  Read via bridge.telemetry().tornFrames. See
 *                                  "Schema invariants" section below.
 *                                  Reserved-lane table:
 *                                    lane 0: write_index            (active, 0.4.0)
 *                                    lane 1: read_index             (active, 0.4.0)
 *                                    lane 2: flow_scale             (active, 0.5.0)
 *                                    lane 3: torn_frame_counter     (active, 0.6.0)
 *                                    lanes 4-7: reserved
 *     [byte 16..31]  reserved (16 bytes — earmarked for soft-error counter etc.)
 *
 *   Payload region (typed-array umbrella views at SAB byte 32):
 *     For each FieldKind present in the schema, one umbrella view spanning
 *     the entire payload region:
 *       new Float64Array(sab, 32, capacity * frameByteSize / 8)
 *       new Uint32Array (sab, 32, capacity * frameByteSize / 4)
 *       ... etc per type-family present
 *     Plus, per array field per slot, a precomputed typed-array view sized
 *     to the field's length pointing at that slot's bytes. These are used
 *     for zero-allocation .set()-style copies on push/pull.
 *
 *   Frame layout per slot:
 *     Fields are sorted by alignment class (8-byte first, then 4, then 2,
 *     then 1) with declared order preserved within a class — see
 *     defineSchema in ./schema.ts. Frame size is padded up to 8 so slot
 *     boundaries stay 8-aligned for the BigInt64/Float64 umbrella views.
 *
 * ─── Memory ordering ─────────────────────────────────────────────────────
 *
 * Producer push:
 *   1. Plain-read own write_index (single-producer guarantee).
 *   2. Acquire-load read_index. If write_index - read_index >= CAPACITY → full.
 *   3. Write payload (non-atomic typed-array stores via per-field writers
 *      and per-slot array views).
 *   4. Release-store write_index + 1. The release barrier guarantees the
 *      non-atomic payload stores happen-before any consumer acquire-load.
 *   5. Atomics.notify(write_index, 1) wakes any consumer parked via
 *      waitForData. Unconditional — see "Park / wake protocol" below.
 *
 * Consumer pull:
 *   1. Plain-read own read_index (single-consumer guarantee).
 *   2. Acquire-load write_index. If equal → empty.
 *   3. Read payload (non-atomic typed-array loads).
 *   4. Release-store read_index + 1.
 *   5. Atomics.notify(read_index, 1) wakes any producer parked via
 *      waitForSpace. Unconditional.
 *
 * No torn-frame re-check is needed. The strict push contract guarantees the
 * producer cannot be writing the slot the consumer is reading: push()
 * rejects when `write_index - read_index >= CAPACITY`, so the producer's
 * write_index cannot advance past read_index + CAPACITY, and the slot
 * indices `(write_index & mask)` and `(read_index & mask)` cannot collide
 * while there is an unread frame. The producer's release-store on
 * write_index establishes happens-before for the payload writes; the
 * consumer's acquire-load on write_index observes them. That is the full
 * synchronization the protocol needs.
 *
 * ─── Counter representation (0.4.0) ──────────────────────────────────────
 *
 * Pre-0.4 the counters were BigInt64. The Atomics path then paid both the
 * notify syscall AND BigInt boxing on every push/pull. The boxing was a
 * smaller cost than the notify (we measured ~40 ns/op extra on Windows + V8),
 * but it pushed the pure atomic load+store+notify sequence to ~160 ns vs
 * ~100 ns on i32 — a ~25 % gap against the ringbuf.js-class floor.
 *
 * Post-0.4 the counters are plain Int32 wrapping mod 2^32, computed via the
 * standard SPSC modular trick:
 *
 *   diff = (writeIdx - readIdx) | 0       // signed-32 subtraction
 *   slot = (idx >>> 0) & mask              // unsigned-then-mask
 *
 * The signed-32 diff is correct for any |true_diff| < 2^31. Capacity is
 * power-of-two and bounded (default: 16; max: 2^30), so the diff is always
 * small and the wrap is invisible. Slot mask is wrap-correct because the low
 * log2(capacity) bits don't depend on signed-ness.
 *
 * The wire format changes: write_index occupies bytes [0..3] (was [0..7])
 * and read_index occupies bytes [4..7] (was [8..15]). v0.3.x and v0.4.0
 * SABs cannot be opened by the other version; this is the breaking change
 * the minor bump tracks. `Float64RingBuffer` is untouched and continues to
 * carry the v0.1.x byte format for users on the deprecated path.
 *
 * Wrap clock: 2^32 / 48000 ≈ 24h at audio rate; 2^32 / 60 ≈ 2.27 years at a
 * 60 Hz control-rate producer. The SEMANTIC monotonic seq is whatever your
 * schema declares (e.g. `physicsControlFrameSchema(n)` declares `seq: u64`
 * which is exact through 2^64) — the ring's INTERNAL counter only needs to
 * indicate "which slot is next" and "how full is the ring," both of which
 * are wrap-invariant operations. Conceptual inspiration: small lanes with
 * proven algebra replace the boxed wide type — see also the wavefunction-
 * synth project's `doubleSingle.ts` (Knuth two-sum on f32 pairs) for the
 * floating-point analog of the same move.
 *
 * ─── Park / wake protocol (Atomics.wait / Atomics.notify) ─────────────────
 *
 * Always-notify (not edge-triggered). Push and pull unconditionally issue
 * Atomics.notify on the peer's lane after the release-store. An earlier
 * iteration of this protocol used an edge-trigger (notify only on the
 * empty→non-empty / full→non-full transition); under genuine 2-thread
 * contention that protocol misses wake-ups because the producer's wasEmpty
 * check almost always reads false (write_index > read_index while the
 * consumer is mid-drain), so the consumer ends up reliant on its
 * Atomics.wait timeout to make any progress at all. Always-notify is
 * correct by construction: a parked peer is guaranteed to be woken on the
 * next state change, and the syscall cost when nobody is parked is
 * dominated by the write itself (~100ns on Windows / Linux per
 * Atomics.notify with zero waiters). In the canonical production path
 * (60Hz control-rate producer → AudioWorklet, ~375Hz pull at 48kHz/128q)
 * that's a few hundred extra notify-syscalls per second total — invisible
 * against everything else.
 *
 * Atomics.wait correctness under the load-then-park race is provided by the
 * spec itself: Atomics.wait atomically compare-and-parks against the
 * expected value, so a producer that observed readIdx = X and then issues
 * Atomics.wait(indices, 1, X) is safe even if the consumer advances readIdx
 * between the two operations — the wait sees the new value and returns
 * "not-equal" immediately rather than parking forever.
 *
 * waitForData is NOT real-time safe (it blocks the calling thread up to the
 * timeout) and MUST NOT be called from an AudioWorklet's process() method.
 * The AudioWorklet always polls via pullLatest() and tolerates misses. The
 * notify on push is still emitted for the benefit of non-realtime consumers
 * (concurrent stress tests, bench harnesses, non-audio downstream readers).
 *
 * ─── Smoothed pulls (α-smoother as first-class API) ─────────────────────
 *
 * `pullSmoothed` / `pullLatestSmoothed` are opt-in variants of `pull` /
 * `pullLatest` that blend the freshly-read frame with the previous
 * smoothed-call output using a one-pole low-pass:
 *
 *   out_i ← α_eff · curr_i + (1 − α_eff) · prev_i
 *
 * For `pullLatestSmoothed`, the skip-scaling of `α_eff` is selected per call
 * by `opts.skipPolicy` (`SmootherSkipPolicy`, default `'stall-smooth'`):
 *
 *   'stall-smooth' (default, 0.4.1..present, bit-exact-preserved at 0.6.6):
 *     `α_eff = α_base · 2^(−skipped)`. A big jump (producer stalled then
 *     caught up) gets MORE smoothing; the steady-state case with no skips
 *     gets `α_eff = α_base`. Click-suppression-first.
 *
 *   'catch-up' (opt-in, 0.6.6):
 *     `α_eff = 1 − (1 − α_base)^(skipped + 1)` — closed form of applying
 *     the one-pole filter (skipped + 1) times in a row. Large skips drive
 *     α→1, snapping to the new frame. Chase-latency-first. For skipped=0
 *     this reduces to `α_eff = α_base` exactly (no behavioral change
 *     unless a stall actually occurred).
 *
 * For `pullSmoothed`, skipped is always 0, so both policies yield
 * `α_eff = α_base` — the option is accepted for API symmetry but is a no-op.
 *
 * Lineage: the wavefunction-synth project's 60 → 48 kHz boundary smoother
 * (`wfEvolve.js:145-146,361-362`); same one-pole shape, lifted into the
 * ring as a first-class consumer-side primitive. BigInt-typed fields are
 * passed through verbatim — there is no meaningful blend on monotonic
 * sequence counters or timestamps. Integer-typed numeric fields (u8…u32,
 * i8…i32) blend in floating-point then `Math.round` back to integer.
 *
 * Trajectory fields (`f{32,64}TrajectoryArray(n, { order })`): the smoother
 * blends ONLY the position lanes and copies derivative lanes (velocity,
 * acceleration) verbatim from curr. Velocity is a derivative — time-
 * averaging it across frames collapses the very signal the trajectory ships
 * to preserve (a perfectly linear ramp would yield velocity → 0 under a
 * naive elementwise blend). For order=1 the layout is positions-only and
 * the rule reduces to plain array blending; for order=2 the smoother
 * blends elements at indices 0, 2, 4, … and copies 1, 3, 5, …; for
 * order=3 it blends 0, 3, 6, … and copies the other six per triple. The
 * compiled `arrayTrajectoryOrder` table drives the dispatch — no per-call
 * branch on field metadata.
 *
 * The smoother's `prev` is held heap-side on the Bridge instance. It is
 * lazily allocated on the first smoothed call and persists across calls.
 * Any non-smoothed `pull` / `pullLatest` invalidates the prev (the next
 * smoothed call behaves as a first-call: no blending, seed prev with the
 * fresh frame). `resetSmoother()` is the explicit equivalent.
 *
 * Memory ordering matches `pull` / `pullLatest`: acquire-load writeIdx,
 * read payload, release-store readIdx, notify. The blend math runs AFTER
 * the release-store — blend touches only heap-side `out` and `prev`, never
 * the SAB, so the slot can be released back to the producer as early as
 * possible (the smoother adds no critical-section length to the SPSC
 * handoff).
 *
 * ─── Adaptive backpressure (CFL-style, 0.5.0) ─────────────────────────────
 *
 * The bridge exposes a soft rate-control signal on lane 2 (`flow_scale`,
 * Q16.16 fixed-point in [0.5, 2.0]; default 1.0 = no scaling). The consumer
 * runs a PI controller against pre-pull occupancy (`(write - read) /
 * capacity`) on every successful pull and stores the controller's output
 * into the lane. The producer reads it via `flowScaleHint()` and may
 * voluntarily honor it — by scaling its `dt`, dropping frames, sleeping a
 * fraction of its interval, etc. The bridge does NOT enforce: the lane is a
 * hint, not a gate. The existing capacity-based push reject (`push` returns
 * false when full) is the hard contract; `flow_scale` is the soft layer
 * that, when honored, keeps the producer/consumer rate match continuous so
 * the hard reject is reached only under genuine overload.
 *
 * Math. With `err = occupancy - 0.5`, controller state `integral += err`
 * (clamped to ±20 for anti-windup), and gains `Kp = 0.5`, `Ki = 0.05`:
 *
 *   scale = clamp(1 - Kp·err - Ki·integral, 0.5, 2.0)
 *
 * Sign: positive err (consumer is overfull) gives `scale < 1` (producer
 * should slow down); negative err (consumer is starved) gives `scale > 1`
 * (producer should speed up). The integrator removes steady-state offset
 * — without it, a sustained producer/consumer mismatch would leave a
 * residual occupancy error.
 *
 * Gain rationale. Designed for ~10 ms settling at the canonical 375 Hz
 * consumer cadence (≈4 controller cycles per settling time). Bode-style
 * argument: occupancy_dot = (push_rate - pull_rate) / capacity, PI closes
 * the loop with crossover well below the audio rate. The 0.5 / 0.05
 * starting point is conservative; faster gains are possible but ring when
 * the rate mismatch reverses. Anti-windup limit `INT_LIMIT = (range/2)/Ki =
 * 1.0/0.05 = 20`: integral contribution alone can drive `scale` across the
 * full range, but cannot drive it past saturation — long stalls don't trap
 * the controller in a permanent over-correction.
 *
 * Where it runs. `_updateFlowScale(write, read)` is called from `pull`,
 * `pullLatest`, `pullSmoothed`, `pullLatestSmoothed` AFTER the release-
 * store on read_index but only on the successful path (an empty-pull
 * early-return does NOT update the lane; its "occupancy = 0" reading would
 * misleadingly say "producer too slow" when in fact the consumer hasn't
 * actually consumed). `available()` is a pure observer and never touches
 * the lane. The lane is a separate atomic from the counters — no acquire/
 * release ordering with the payload, no compare-exchange needed; plain
 * `Atomics.store` / `Atomics.load` suffice because the producer's reading
 * is best-effort.
 *
 * Cost. Adds ~10 ns to the hot path (one multiply, one add, two clamps,
 * one `Math.floor`, one `Atomics.store`). Bench cell `flowScaleRecovery`
 * pins the settling-time signal as a separate measurement.
 *
 * ─── Schema invariants (0.6.0, opt-in via `.withInvariant(fn)`) ───────────
 *
 * Cross-IPC bit-rot detection as a protocol concern. When a schema is built
 * with `.withInvariant(fn)`, the schema layout grows by 8 bytes per slot
 * for a hidden `__invariant: f64` field. The Bridge auto-computes the
 * invariant via `fn(frame)` on every push (right before the release-store
 * on write_index) and verifies on every pull (right after payload read,
 * before recovery + release-store on read_index).
 *
 * Recovery classification, against `ratio = computed / stored`:
 *
 *   |ratio − 1| < INVARIANT_OK_THRESHOLD       (1e-3): ok, pass through
 *   |ratio − 1| < INVARIANT_SOFT_THRESHOLD     (1.0):  soft error
 *   otherwise:                                         hard error
 *
 * Soft errors invoke `_applySmoother` against the unified `consumerPrev`
 * buffer with `α = clamp(INVARIANT_SOFT_ALPHA_BASE / |ratio−1|, 0, 1)`. The
 * curve picks α near the OK boundary so tiny deviations pass through
 * essentially raw, and α near 0 at the hard boundary so the smoother
 * basically trusts prev when the corruption is severe. The smoother is the
 * same primitive as for `pullSmoothed` (lifted from 0.4.1) — single field-
 * type-dispatched blend loop, no extra surface.
 *
 * Hard errors copy `consumerPrev` into `out` (last-known-good fallback) and
 * increment the torn_frame_counter on lane 3. The producer is unaffected;
 * the consumer's downstream sees a stale-but-trusted frame instead of a
 * corrupt one. If `consumerPrev` is not yet valid (first pull ever was a
 * hard error), the raw payload passes through and tornFrames still
 * increments so the failure is visible in telemetry.
 *
 * On smoothed pulls under an invariant-enabled schema, the smoother always
 * fires with the user's α on ok / soft, and hard-error fallback returns
 * `consumerPrev` (which itself is the most recent blended output, exactly
 * what the consumer would have used).
 *
 * Lineage: wavefunction-synth's `wfNormGuard.js:46-80` (Σ|ψ|² invariant
 * with ratio-band recovery). The bridge generalizes "norm guard" to any
 * caller-supplied scalar — sum-of-squares for f64-dominant frames,
 * xxhash/CRC32 for byte-oriented payloads, your choice. The invariant fn
 * must be O(payload size) and allocation-free; it runs on every push AND
 * every pull, so it sits on the hot path.
 *
 * Cost when not opted in. Zero. Schemas without `.withInvariant(...)` have
 * `schema.invariant === null`; the push/pull paths short-circuit the
 * invariant block in a single null-check. The unified `consumerPrev`
 * buffer is also not allocated for no-invariant schemas (raw pulls keep
 * the 0.4.1 "flip valid=false" behavior; the smoother allocates lazily on
 * its own first call as before).
 *
 * Cost when opted in. One invariant fn call on push (caller's complexity),
 * one f64 SAB store. One invariant fn call on pull, one f64 SAB load, one
 * division, one classification branch, one `_copyFrameInto` (consumerPrev
 * update on the ok / soft branches; on the hard branch the copy direction
 * reverses but the cost is the same). For the canonical `Σ|f|²` invariant
 * on `physicsControlFrameSchema(1000)`: ~5 μs/push and ~5 μs/pull added
 * over baseline. Tolerable for control-rate frames; not a fit for audio-
 * rate or high-Hz telemetry — those callers should leave invariants off.
 *
 * ─── Phase-locked loop (0.6.2, Pillar 2 first cut — offset only) ────────
 *
 * Consumer-side PLL that tracks the offset between the producer's
 * `tMacroNs` (the timestamp the producer writes into each frame) and the
 * consumer's wall-clock (typically `AudioContext.currentTime * 1e9`).
 * Once locked, the consumer knows the sub-microsecond elapsed time
 * between a pulled frame's stamp and any audio-rate evaluation point —
 * the prerequisite for Pillar 3's `pullEvaluated` and the FFT phase-lock
 * marketing claim ("60 Hz GPU physics drives 48 kHz audio with no
 * observable 60 Hz alias").
 *
 * Why a PLL and not a single subtraction:
 * - `mapAsync`/postMessage latency between producer and consumer has
 *   high variance (5–10 ms typical, 30 ms+ stalls under GPU load).
 * - `AudioContext.currentTime` and the producer's clock can drift at
 *   tens of ppm even on the same machine (NTP correction, thermal).
 * - A single `(producerNs - consumerNs)` subtraction captures both the
 *   true offset AND the per-observation jitter; the PLL low-pass
 *   filters out the jitter while tracking the drift.
 *
 * Storage: heap-only on the consumer's Bridge instance — three numbers
 * (`pllOffsetNs`, `pllIntegral`, `pllLocked`). The header lanes 4-7
 * stay reserved. Cross-process observability of the PLL state (so the
 * producer side can see the consumer's offset estimate for telemetry)
 * is a deferred follow-up; the 0.6.2 cut keeps the wire format
 * byte-for-byte identical to 0.6.1.
 *
 * API:
 *   observeConsumerTime(consumerNs, producerNs) — run one PI cycle pairing
 *     a producer-stamped time with the consumer's wall-clock at the
 *     observation moment. Typical pattern: call once per pull. The first
 *     call seeds the offset exactly (`pllOffsetNs = producerNs - consumerNs`,
 *     `pllLocked = true`); subsequent calls run the PI math:
 *       residual = (producerNs - consumerNs) - pllOffsetNs
 *       integral = clamp(integral + residual, ±PLL_INT_LIMIT_NS)
 *       pllOffsetNs += PLL_KP · residual + PLL_KI · integral
 *
 *   phaseLockedTime(consumerNs) — returns `consumerNs + pllOffsetNs` once
 *     locked, else `consumerNs` unchanged. Safe at audio rate.
 *
 *   resetPll() — flip back to unlocked. Use after suspend/resume, an
 *     AudioContext epoch change, or when the producer reconnects with
 *     a different `tMacroNs` epoch.
 *
 *   telemetry().pllLocked / .pllOffsetNs — point-in-time snapshot.
 *
 * Convergence: with `PLL_KP = 0.2`, a fresh constant offset converges to
 * within 1 μs in ~30 observations (geometric residual decay at 80 % per
 * cycle, log-base-1.25 of (initial / 1μs)). With `PLL_KI = 0.01`, a
 * constant drift (e.g. 50 ppm) settles within a few seconds — exactly
 * the regime where Ki contributes more than Kp's decaying-residual term.
 *
 * Anti-windup: `pllIntegral` is clamped to ±`PLL_INT_LIMIT_NS` (1 ms in
 * residual units). Past that, Ki·integral alone would dominate and any
 * short-term residual spike (a stalled producer, a paused consumer)
 * could take an arbitrarily long time to drain. Same shape as 0.5.0's
 * `FLOW_SCALE_INT_LIMIT` (anti-windup is the same pattern in both
 * controllers).
 *
 * Deferred to follow-ups (still in the Pillar 2 plan, not in 0.6.2):
 *   - Drift estimator: second integrator over residuals normalized by
 *     dt-between-observations, tracking ppm. Improves long-term lock
 *     quality on drifting clocks.
 *   - Mahalanobis outlier gate against recent residual variance. Rejects
 *     `mapAsync` stalls so a single 30 ms residual spike doesn't poison
 *     the offset estimate.
 *   - Cross-process observability via lanes 4-5. Producer can read the
 *     consumer's offset for unified telemetry / DevTools dashboards.
 *
 * ─── Per-frame evaluator (0.6.3, Pillar 3 first cut) ─────────────────────
 *
 * `bridge.evaluateInto(srcFrame, dt, outFrame)` is the consumer-side
 * primitive that closes the trajectory-evaluation story. With Pillar 1
 * (0.6.1) the consumer had to loop over trajectory fields manually,
 * calling `evaluateTrajectoryInto` per field; with Pillar 3 the bridge
 * walks `compiled.fields` and applies the per-field evaluator across the
 * whole frame in one call.
 *
 * Field dispatch:
 *   - Trajectory field → evaluateTrajectoryInto with the field's spec.
 *   - Non-trajectory array → outFrame[name].set(srcFrame[name]).
 *   - Scalar → outFrame[name] = srcFrame[name].
 *
 * Heap-only. Never touches the SAB. The producer can be writing the
 * *next* frame in shared memory while the consumer re-evaluates the
 * *current* one in its private heap copy at audio rate — no cache-line
 * pingpong, no atomic ops.
 *
 * Shape contract on `outFrame`:
 *   - Trajectory fields: length ≥ `spec.sampleCount` (positions only;
 *     NOT sampleCount * order — the source carries derivatives, the
 *     output is post-Taylor-evaluation positions).
 *   - Non-trajectory arrays: length ≥ srcFrame's length.
 *   - Scalars: any value of the matching type (will be overwritten).
 *
 * `scratchEvaluatedFrame()` allocates an outFrame with the correct shape
 * for any schema. Call once at consumer init, reuse on every evaluateInto.
 *
 * `dt` is unit-agnostic — same contract as evaluateTrajectoryInto.
 * Velocity / acceleration units chosen at the producer; the caller
 * supplies a matching `dt`. The canonical AudioWorklet pattern combines
 * pullLatest + observeConsumerTime + per-sample dt + evaluateInto:
 *
 *     this.bridge.pullLatest(this.rawFrame);
 *     this.bridge.observeConsumerTime(quantumNs, Number(this.rawFrame.tMacroNs));
 *     for (let i = 0; i < 128; i++) {
 *       const cNs = quantumNs + (i / sampleRate) * 1e9;
 *       const dtNs = this.bridge.phaseLockedTime(cNs) - Number(this.rawFrame.tMacroNs);
 *       this.bridge.evaluateInto(this.rawFrame, dtNs * 1e-9, this.evalFrame);
 *       block[i] = this.synth.step(this.evalFrame.vEff);
 *     }
 *
 * ─── Per-frame evaluator sugar (0.6.5, Pillar 3 second cut) ──────────────
 *
 * `pullEvaluatedLatest` + `evaluateAtSampleOffset` collapse the canonical
 * pull + observe + per-sample dt + evaluate loop into two method calls per
 * quantum. The hand-rolled five-line inner pattern above becomes:
 *
 *     const skipped = this.bridge.pullEvaluatedLatest(
 *       this.evalFrame, quantumNs, sampleRate,
 *     );
 *     if (skipped < 0) return true;  // first quantum, nothing pulled yet
 *     for (let i = 1; i < 128; i++) {
 *       this.bridge.evaluateAtSampleOffset(this.evalFrame, i);
 *       block[i] = this.synth.step(this.evalFrame.vEff);
 *     }
 *
 * (Sample 0 is already evaluated by `pullEvaluatedLatest`.)
 *
 * Three building blocks make this work:
 *
 *   1. **Timestamp roles** (`.withTimestamps(...)` on the schema). The
 *      schema declares which field carries the producer's timestamp and
 *      what unit it's in (ns / us / ms / s / samples). One field can be
 *      tagged with multiple roles if the producer ships multiple clocks
 *      (macro / GPU / audio-frame). Each consumer picks the role most
 *      natural for its math via `{ timestamp: 'roleName' }` (compile-time
 *      checked against the declared role names); omitting the option uses
 *      the schema's default role.
 *   2. **Internal cache** (`cachedRawFrame` + `cachedTimestampNs` +
 *      `cachedBaseConsumerNs` + `cachedSampleRate`). `pullEvaluatedLatest`
 *      pulls into the cache once per quantum; `evaluateAtSampleOffset`
 *      reads from it for the remaining 127 samples without touching the
 *      SAB. Lazily allocated on first call; survives across calls.
 *   3. **Unit conversion** (`_resolveTimestampNs`). The timestamp value
 *      is read, coerced from BigInt → Number if needed, multiplied by
 *      the per-unit factor (samples uses the per-call sampleRate), and
 *      stored in ns for the PLL + dt math. dt is delivered to
 *      `evaluateInto` in seconds — the canonical Pillar 1 contract.
 *
 * `sampleRate` is per-call by default; callers who want to omit it can
 * register a default once via `setSampleRate(rate)` and pass `undefined`
 * (or omit the arg). The bridge throws a clear error if neither is set.
 *
 * `resetEvalCache()` invalidates the cache (use on `AudioContext`
 * suspend/resume or whenever the producer's timestamp epoch jumps).
 * Independent of `resetPll()` and `resetSmoother()` — three orthogonal
 * caches.
 *
 * Deferred Pillar 3 follow-ups (still in the plan):
 *   - `EvalMode` dispatch (step / alpha / trajectory / catmull) chosen
 *     once at construction so the hot path is one precompiled branch.
 *   - Per-quantum batch API that writes all 128 samples in one call.
 *
 * ─── Schema-dispatch overhead ─────────────────────────────────────────────
 *
 * Compared to the hand-rolled Float64RingBuffer code path, Bridge<S> pays a
 * small dispatch cost on the hot path: a per-scalar-field closure call (each
 * closure captures one umbrella view + one offset + one stride + the field
 * name). Closures are precomputed at construction; the call site is an
 * indexed-loop over a small array of writer closures. For typical schemas
 * (5-10 scalars + a handful of arrays) the overhead is ~50-150ns/op on top
 * of the ~1.1μs Atomics.notify-dominated baseline. Users wanting absolute
 * peak performance on the legacy [seq,t,vMax,jMax,vEff,jEff] f64 shape can
 * still import Float64RingBuffer directly — it stays exported in this
 * release and is the lower-overhead path for that one specialization.
 *
 * ─── Attribution ─────────────────────────────────────────────────────────
 *
 * Same lineage as Float64RingBuffer — Paul Adenot's `ringbuf.js` (2018) is
 * the canonical SPSC-over-SAB technique that this library extends. See
 * src/Float64RingBuffer.ts for full attribution and the README's
 * Acknowledgments.
 */

import {
  describeSchemaLayout,
  kindByteSize,
  kindTsType,
  type CompiledField,
  type FieldKind,
  type FieldsObject,
  type FrameFor,
  type Schema,
  type SchemaLayoutDescription,
  type TimestampRoleOf,
  type TimestampUnit,
} from "./schema.js";
import { evaluateTrajectoryInto } from "./trajectory.js";

export const RING_HEADER_BYTES = 32;
export const RING_HEADER_LANES = 2; // active counter lanes: write_index (Int32 lane 0), read_index (Int32 lane 1). Other active control lanes (flow_scale on lane 2) are accounted for separately — this constant counts only SPSC counters.
export const RING_HEADER_INT32_LANES = 8; // 32-byte header viewed as Int32 = 8 lanes total

// Internal lane indices into the Int32 header view.
//   lanes 0-1: SPSC counters (acquire/release ordering, wrap-mod-2^32)
//   lane 2:    flow_scale — Q16.16 consumer→producer hint (0.5.0)
//   lane 3:    torn_frame_counter — Int32 monotonic wrap-counter (0.6.0)
//   lanes 4-7: reserved
const WRITE_IDX_LANE = 0;
const READ_IDX_LANE = 1;
const FLOW_SCALE_LANE = 2;
const TORN_FRAME_LANE = 3;

// Flow-scale fixed-point + PI controller constants.
//
// Q16.16: store(scale) = floor(scale * 65536). Range [0.5, 2.0] maps to
// [32768, 131072], all within positive signed-32 → Atomics.load on Int32Array
// returns the stored value bit-for-bit (no sign weirdness).
const FLOW_SCALE_Q = 65536;
const FLOW_SCALE_MIN = 0.5;
const FLOW_SCALE_MAX = 2.0;
const FLOW_SCALE_DEFAULT_Q = FLOW_SCALE_Q; // 1.0 * Q

// PI gains. See file header "Adaptive backpressure" for the derivation.
// Conservative starting point: Kp dominates the transient, Ki removes
// steady-state offset under sustained rate mismatch.
const FLOW_SCALE_KP = 0.5;
const FLOW_SCALE_KI = 0.05;
// Anti-windup: cap |integral| so Ki·integral alone covers the full half-extent
// of scale's range (1.0). Past this, the integrator would saturate the output
// and recovery from a long stall would be unable to back off.
const FLOW_SCALE_INT_LIMIT = 20; // = 1.0 / FLOW_SCALE_KI

// Schema-invariant recovery thresholds. See the "Schema invariants" section
// of the file header for the classification semantics and the smoother α
// curve. All three are exported on the Bridge class as static readonly
// constants so tests / callers can pin against them without reaching into
// private state.
const INVARIANT_OK_THRESHOLD = 1e-3;
const INVARIANT_SOFT_THRESHOLD = 1.0;
const INVARIANT_SOFT_ALPHA_BASE = 0.1; // α ≈ INVARIANT_SOFT_ALPHA_BASE / |ratio−1|

// PLL controller gains. See file header "Phase-locked loop" for the
// derivation; same shape as FLOW_SCALE_KP/KI but tuned for the offset
// signal (residuals are nanoseconds-scale where flow-scale residuals are
// occupancy-fraction-scale, so absolute gains differ).
//
// Kp dominates the transient response — at Kp=0.2 a single observation
// closes 20 % of the residual gap, so a fresh constant offset converges
// to within 1 μs in ~30 cycles. Ki removes residual bias from drift
// (e.g. a producer clock running 50 ppm fast) over a few seconds.
const PLL_KP = 0.2;
const PLL_KI = 0.01;
// Anti-windup: cap |integral| at 1 ms (= 1e6 ns) in residual-units.
// Past this, Ki·integral alone would dominate the offset estimate and
// any short-term residual spike would take an arbitrarily long time
// to drain. 1 ms is large enough to handle multi-second drift error
// accumulating before Ki notices, small enough that recovery from a
// trapped integrator takes at most a few seconds.
const PLL_INT_LIMIT_NS = 1e6;

export interface BridgeAllocation<S extends Schema<FieldsObject, any>> {
  sab: SharedArrayBuffer;
  capacity: number;
  schema: S;
}

/** Skip-scaling policy for `pullLatestSmoothed` (0.6.6). Controls how the
 *  effective α responds when the consumer drains more than one frame in a
 *  single call (i.e. `skipped > 0`). For `pullSmoothed` (always
 *  `skipped === 0`) both policies yield `α_eff = α_base`; the option is
 *  accepted for API symmetry but has no behavioral effect.
 *
 *  - `'stall-smooth'` (default — preserves 0.4.1..0.6.5 behavior bit-exact):
 *    `α_eff = α_base · 2^(-skipped)`. Large skips drive α→0, so the smoother
 *    mostly trusts `prev` and drifts slowly toward the post-stall value.
 *    Right when audible click-suppression matters more than chase latency.
 *
 *  - `'catch-up'` (0.6.6, opt-in): `α_eff = 1 - (1 - α_base)^(skipped + 1)`,
 *    the closed form of applying the one-pole filter `skipped + 1` times
 *    in a row (the math behind why a compounded-EMA "should" use a larger
 *    α after a stall). Large skips drive α→1, so the smoother snaps to the
 *    new frame. Right when minimizing chase latency matters more than
 *    click-suppression, or when the producer's post-stall value is a
 *    discontinuous correction that should be reflected immediately.
 *
 *  See file header "Smoothed pulls" for the per-policy curve rationale and
 *  the 0.6.6 CHANGELOG for the derivation. */
export type SmootherSkipPolicy = "stall-smooth" | "catch-up";

/** Optional opts bag accepted by `pullSmoothed` / `pullLatestSmoothed` from
 *  0.6.6 onward. `skipPolicy` selects how `α_eff` responds to drained
 *  backlog; omit (or pass `undefined`) for the legacy `'stall-smooth'`
 *  default that preserves all pre-0.6.6 behavior bit-exact. */
export interface SmoothedPullOptions {
  readonly skipPolicy?: SmootherSkipPolicy;
}

type AnyTypedArray =
  | Float64Array
  | Float32Array
  | Uint32Array
  | Int32Array
  | Uint16Array
  | Int16Array
  | Uint8Array
  | Int8Array
  | BigInt64Array
  | BigUint64Array;

interface TypedArrayCtor<T extends AnyTypedArray> {
  new (sab: SharedArrayBuffer, byteOffset: number, length: number): T;
  readonly BYTES_PER_ELEMENT: number;
  readonly name: string;
}

function ctorForKind(kind: FieldKind): TypedArrayCtor<AnyTypedArray> {
  switch (kind) {
    case "u64": return BigUint64Array as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i64": return BigInt64Array  as unknown as TypedArrayCtor<AnyTypedArray>;
    case "f64": return Float64Array   as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u32": return Uint32Array    as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i32": return Int32Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "f32": return Float32Array   as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u16": return Uint16Array    as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i16": return Int16Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u8":  return Uint8Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i8":  return Int8Array      as unknown as TypedArrayCtor<AnyTypedArray>;
  }
}

function newHeapTypedArray(kind: FieldKind, length: number): AnyTypedArray {
  switch (kind) {
    case "u64": return new BigUint64Array(length);
    case "i64": return new BigInt64Array(length);
    case "f64": return new Float64Array(length);
    case "u32": return new Uint32Array(length);
    case "i32": return new Int32Array(length);
    case "f32": return new Float32Array(length);
    case "u16": return new Uint16Array(length);
    case "i16": return new Int16Array(length);
    case "u8":  return new Uint8Array(length);
    case "i8":  return new Int8Array(length);
  }
}

function isPowerOfTwo(x: number): boolean {
  return x > 0 && (x & (x - 1)) === 0;
}

type ScalarOp = (slot: number, frame: Record<string, unknown>) => void;

export class Bridge<S extends Schema<FieldsObject, any>> {
  public readonly capacity: number;
  public readonly schema: S;
  /** Frame size in bytes; matches schema.frameByteSize. */
  public readonly frameByteSize: number;

  private readonly indices: Int32Array;
  private readonly mask: number;

  /** Per array field per slot: a typed-array view pointing at that slot's
   *  bytes for that field. Used for zero-alloc .set() on push/pull. */
  private readonly arrayViews: AnyTypedArray[][];
  /** Compiled array fields, in order — index matches arrayViews. */
  private readonly arrayLayout: ReadonlyArray<CompiledField>;
  /** Compiled scalar fields, in order — index matches scalarWriters/Readers. */
  private readonly scalarLayout: ReadonlyArray<CompiledField>;

  /** Per-scalar-field write closure: writes frame[name] into the slot. */
  private readonly scalarWriters: ReadonlyArray<ScalarOp>;
  /** Per-scalar-field read closure: copies slot value into outFrame[name]. */
  private readonly scalarReaders: ReadonlyArray<ScalarOp>;

  /** Active beginPush/commitPush handle, or null. */
  private pendingPushFrame: Record<string, unknown> | null = null;
  private pendingPushSlot: number = -1;

  /** Unified consumer-side cached prev frame, used by both the α-smoother
   *  (pullSmoothed / pullLatestSmoothed) and the schema-invariant hard-
   *  error recovery path (pull-family under `.withInvariant` schemas).
   *  Lazily allocated on first use; persists across calls.
   *
   *  Lifecycle:
   *   - Raw pull (no invariant): valid → false on every call. Buffer
   *     retained for the next smoothed call to re-seed without allocation.
   *   - Raw pull (with invariant): on ok, out is copied into consumerPrev
   *     (valid=true). On soft error, smoother runs (consumerPrev gets the
   *     blended output). On hard error, consumerPrev → out, valid unchanged.
   *   - Smoothed pull: smoother runs every time, consumerPrev = blended
   *     output. On invariant hard error, consumerPrev → out, valid unchanged.
   *
   *  See file headers "Smoothed pulls" + "Schema invariants". */
  private consumerPrev: FrameFor<S> | null = null;
  private consumerPrevValid: boolean = false;
  /** Precomputed per-scalar/per-array smoother classification. Computed in
   *  the constructor in `scalarLayout` / `arrayLayout` order so the blend
   *  loops are a tight indexed walk. `isBigInt` ⇒ verbatim pass-through;
   *  `isInteger` ⇒ Math.round after blend; otherwise float-domain blend. */
  private readonly scalarIsBigInt: ReadonlyArray<boolean>;
  private readonly scalarIsInteger: ReadonlyArray<boolean>;
  private readonly arrayIsBigInt: ReadonlyArray<boolean>;
  private readonly arrayIsInteger: ReadonlyArray<boolean>;
  /** Per-array-field trajectory order, in `arrayLayout` order. 0 for
   *  non-trajectory arrays and order=1 trajectories (both blend every
   *  element identically — order=1 is byte-compatible with a plain array
   *  of positions). 2 / 3 for higher-order trajectories: the smoother
   *  blends only the position lanes (every Nth element starting at 0) and
   *  copies derivative lanes (velocity, acceleration) verbatim from curr.
   *  Blending derivatives across frames is mathematically meaningless —
   *  velocity is a snapshot, not a quantity to time-average. See file
   *  header "Smoothed pulls" for the trajectory-aware rule. */
  private readonly arrayTrajectoryOrder: ReadonlyArray<number>;

  /** PI controller integral state. Persists across pull calls; clamped to
   *  ±FLOW_SCALE_INT_LIMIT for anti-windup. Reset to 0 on construction (no
   *  external invalidation path — the controller is a feedback loop that
   *  re-converges within a few cycles after any disturbance). */
  private piIntegral: number = 0;

  /** PLL state — consumer-side phase-locked loop tracking the offset between
   *  the producer's `tMacroNs` clock and the consumer's wall clock (typically
   *  AudioContext.currentTime in ns). Heap-only; lanes 4-7 of the header
   *  remain reserved in this release.
   *
   *  Lifecycle:
   *   - Constructor sets `pllLocked=false`, `pllOffsetNs=0`, `pllIntegral=0`.
   *   - First `observeConsumerTime(c, p)` seeds `pllOffsetNs = p - c` and flips
   *     `pllLocked=true`. No PI math runs on the seeding call.
   *   - Subsequent calls run one PI cycle each, updating `pllOffsetNs` and
   *     `pllIntegral` (the latter clamped to ±PLL_INT_LIMIT_NS for anti-windup).
   *   - `resetPll()` flips back to the unlocked state — re-call on suspend/resume
   *     or whenever the consumer's clock epoch jumps.
   *
   *  The offset is consumer-clock → producer-clock: `producerNs ≈ consumerNs +
   *  pllOffsetNs` once locked. `phaseLockedTime(consumerNs)` returns that sum.
   *  Pre-lock, `phaseLockedTime` returns `consumerNs` unchanged (the caller's
   *  best fallback is just trust the consumer clock until the first
   *  observation arrives).
   *
   *  See file header "Phase-locked loop (0.6.2, Pillar 2 first cut)" for the
   *  PI derivation and the deferred items (drift estimator, outlier gate,
   *  cross-process observability lanes). */
  private pllOffsetNs: number = 0;
  private pllIntegral: number = 0;
  private pllLocked: boolean = false;

  /** Cached raw frame for `pullEvaluatedLatest` / `evaluateAtSampleOffset`.
   *  Lazily allocated on first `pullEvaluatedLatest`. Persists across calls.
   *  Independent of `consumerPrev` — that field has its own lifecycle for
   *  the α-smoother and invariant fallback. (0.6.5) */
  private cachedRawFrame: FrameFor<S> | null = null;
  /** True iff `cachedRawFrame` holds a valid pulled frame and the
   *  cachedTimestampNs / cachedBaseConsumerNs / cachedSampleRate triple is
   *  set. `evaluateAtSampleOffset` throws if false. `resetEvalCache`
   *  flips it false; `pullEvaluatedLatest` flips it true on success. */
  private cachedEvalValid: boolean = false;
  /** Producer timestamp from the most recent successful `pullEvaluatedLatest`,
   *  converted to nanoseconds via the active role's unit. Used by
   *  `evaluateAtSampleOffset` to compute `dt` against `phaseLockedTime(...)`. */
  private cachedTimestampNs: number = 0;
  /** Consumer wall-clock (ns) at the start of the active quantum.
   *  Sample-offset times are computed as `base + sampleOffset / sampleRate * 1e9`. */
  private cachedBaseConsumerNs: number = 0;
  /** Active sample rate for the current quantum's evaluations. Resolved
   *  at `pullEvaluatedLatest` time from the per-call arg or `defaultSampleRate`. */
  private cachedSampleRate: number = 0;
  /** Optional default sample rate registered via `setSampleRate(rate)`.
   *  When `pullEvaluatedLatest`'s `sampleRate` arg is omitted/undefined,
   *  this value is used. 0 = unset; the bridge throws in that case to
   *  surface the misconfiguration explicitly. */
  private defaultSampleRate: number = 0;

  /** F64 umbrella view used to read/write the hidden `__invariant` lane on
   *  invariant-enabled schemas. Null when `schema.invariant === null`, in
   *  which case the invariant block in push/pull is a single null-check. */
  private readonly invariantView: Float64Array | null;
  /** Per-slot stride in f64 elements (= `frameByteSize / 8`). Used only
   *  when `invariantView` is non-null. */
  private readonly invariantSlotStrideF64: number;
  /** Element offset within a slot of the `__invariant` lane in f64 units.
   *  Used only when `invariantView` is non-null. */
  private readonly invariantElemOffsetF64: number;
  /** Lower floor on the classifier's OK band — `_classifyInvariant` uses
   *  `max(invariantAbsoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)`. Set
   *  from `schema.invariant.absoluteEpsilon` at construction (defaulting to
   *  `DEFAULT_INVARIANT_ABSOLUTE_EPSILON` for no-invariant schemas, where it
   *  is never read). See file header "Schema invariants" + 0.6.6 CHANGELOG. */
  private readonly invariantAbsoluteEpsilon: number;

  /** Public, frozen recovery thresholds — exported for tests and callers
   *  that want to pin against the exact boundaries. */
  static readonly INVARIANT_OK_THRESHOLD = INVARIANT_OK_THRESHOLD;
  static readonly INVARIANT_SOFT_THRESHOLD = INVARIANT_SOFT_THRESHOLD;
  static readonly INVARIANT_SOFT_ALPHA_BASE = INVARIANT_SOFT_ALPHA_BASE;

  constructor(sab: SharedArrayBuffer, capacity: number, schema: S) {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(
        `Bridge: capacity must be power of two, got ${capacity}`,
      );
    }
    // Cap at 2^30 so the signed-32 diff used by the counter algebra never
    // approaches 2^31 even under malformed peers — the wrap-invisible
    // subtraction needs headroom. (Practically, capacity is small: the
    // canonical control-rate ring is 16.)
    if (capacity > (1 << 30)) {
      throw new Error(
        `Bridge: capacity must be ≤ 2^30 (signed-32 diff headroom), got ${capacity}`,
      );
    }
    const expectedBytes = Bridge.byteLength(capacity, schema);
    if (sab.byteLength < expectedBytes) {
      throw new Error(
        `Bridge: SAB too small (${sab.byteLength} bytes, need ${expectedBytes} for capacity=${capacity}, schema.frameByteSize=${schema.frameByteSize})`,
      );
    }

    this.capacity = capacity;
    this.schema = schema;
    this.frameByteSize = schema.frameByteSize;
    this.indices = new Int32Array(sab, 0, RING_HEADER_INT32_LANES);
    this.mask = capacity - 1;
    // Seed flow_scale = 1.0 so any producer that reads `flowScaleHint()`
    // before the consumer has issued a single pull sees "no scaling." Both
    // peers construct their own Bridge over the SAB; this CAS sets the lane
    // ONLY if it's still 0 (fresh SAB), so a late-constructed peer cannot
    // clobber a consumer's already-running controller state.
    Atomics.compareExchange(
      this.indices,
      FLOW_SCALE_LANE,
      0,
      FLOW_SCALE_DEFAULT_Q,
    );

    // Build one umbrella view per type-family present in the schema. These
    // are captured by the per-scalar-field writer/reader closures below; we
    // don't keep them on `this` because nothing else uses them.
    const payloadBytes = capacity * schema.frameByteSize;
    const umbrellas: Partial<Record<FieldKind, AnyTypedArray>> = {};
    for (const kind of schema.compiled.typesPresent) {
      const Ctor = ctorForKind(kind);
      const elemSize = kindByteSize(kind);
      umbrellas[kind] = new Ctor(sab, RING_HEADER_BYTES, payloadBytes / elemSize);
    }

    // Split compiled fields into scalars and arrays, preserve order.
    const scalars: CompiledField[] = [];
    const arrays: CompiledField[] = [];
    for (const f of schema.compiled.fields) {
      if (f.isArray) arrays.push(f);
      else scalars.push(f);
    }
    this.scalarLayout = Object.freeze(scalars);
    this.arrayLayout = Object.freeze(arrays);

    // Precompute per-array-field, per-slot typed-array views.
    const arrayViews: AnyTypedArray[][] = arrays.map((field) => {
      const Ctor = ctorForKind(field.kind);
      const views: AnyTypedArray[] = new Array(capacity);
      for (let s = 0; s < capacity; s++) {
        const byteOffset =
          RING_HEADER_BYTES + s * schema.frameByteSize + field.byteOffset;
        views[s] = new Ctor(sab, byteOffset, field.length);
      }
      return views;
    });
    this.arrayViews = arrayViews;

    // Invariant umbrella + stride / offset. Schema's invariant spec guarantees
    // byteOffset is 8-aligned and frameByteSize is a multiple of 8 (compile
    // step pads userEnd up to 8 before appending the f64 invariant lane).
    if (schema.invariant !== null) {
      // F64 umbrella was added to typesPresent by compileLayout for invariant
      // schemas, so umbrellas['f64'] is guaranteed populated.
      this.invariantView = umbrellas.f64 as Float64Array;
      this.invariantSlotStrideF64 = schema.frameByteSize / 8;
      this.invariantElemOffsetF64 = schema.invariant.byteOffset / 8;
      this.invariantAbsoluteEpsilon = schema.invariant.absoluteEpsilon;
    } else {
      this.invariantView = null;
      this.invariantSlotStrideF64 = 0;
      this.invariantElemOffsetF64 = 0;
      this.invariantAbsoluteEpsilon = 0;
    }

    // Build per-scalar-field writer / reader closures. Each closure captures
    // its umbrella view, stride, in-frame element offset, and field name.
    // The closures are per-(schema instance) monomorphic; V8 keeps them
    // inline-cached per call site.
    const writers: ScalarOp[] = [];
    const readers: ScalarOp[] = [];
    for (const field of scalars) {
      const elemSize = kindByteSize(field.kind);
      const stride = schema.frameByteSize / elemSize; // integer; frame is padded to 8
      const elemOffsetInFrame = field.byteOffset / elemSize; // integer; field is class-aligned
      const view = umbrellas[field.kind]!;
      const name = field.name;
      if (kindTsType(field.kind) === "bigint") {
        const v = view as BigInt64Array | BigUint64Array;
        writers.push((slot, frame) => {
          v[slot * stride + elemOffsetInFrame] = frame[name] as bigint;
        });
        readers.push((slot, outFrame) => {
          outFrame[name] = v[slot * stride + elemOffsetInFrame]!;
        });
      } else {
        // All number-typed kinds: Float64/Float32/Uint32/Int32/Uint16/Int16/Uint8/Int8.
        // The TypedArray subscript-assign coerces / clamps appropriately at the runtime layer.
        const v = view as Exclude<AnyTypedArray, BigInt64Array | BigUint64Array>;
        writers.push((slot, frame) => {
          v[slot * stride + elemOffsetInFrame] = frame[name] as number;
        });
        readers.push((slot, outFrame) => {
          outFrame[name] = v[slot * stride + elemOffsetInFrame]!;
        });
      }
    }
    this.scalarWriters = Object.freeze(writers);
    this.scalarReaders = Object.freeze(readers);

    // Precompute smoother classification flags. f64 / f32 ⇒ float-domain
    // blend; integer-typed numeric kinds ⇒ blend in float then Math.round;
    // BigInt kinds (u64 / i64) ⇒ skip blending, pass through verbatim.
    this.scalarIsBigInt = Object.freeze(
      scalars.map((f) => kindTsType(f.kind) === "bigint"),
    );
    this.scalarIsInteger = Object.freeze(
      scalars.map((f) => f.kind !== "f64" && f.kind !== "f32" && kindTsType(f.kind) !== "bigint"),
    );
    this.arrayIsBigInt = Object.freeze(
      arrays.map((f) => kindTsType(f.kind) === "bigint"),
    );
    this.arrayIsInteger = Object.freeze(
      arrays.map((f) => f.kind !== "f64" && f.kind !== "f32" && kindTsType(f.kind) !== "bigint"),
    );
    // Trajectory order per array field. 0 means "blend every element" — used
    // for non-trajectory arrays and for order=1 trajectories (positions only,
    // byte-identical to a plain array). ≥2 selects the strided-blend path in
    // `_applySmoother` so velocity / acceleration lanes pass through verbatim.
    this.arrayTrajectoryOrder = Object.freeze(
      arrays.map((f) => {
        const order = f.trajectory?.order ?? 0;
        return order >= 2 ? order : 0;
      }),
    );
  }

  /** Byte size needed for a ring of `(capacity, schema)`. */
  static byteLength<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
  ): number {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(`Bridge.byteLength: capacity must be power of two`);
    }
    return RING_HEADER_BYTES + capacity * schema.frameByteSize;
  }

  /** Allocate a SAB sized for the requested ring. */
  static allocate<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
  ): BridgeAllocation<S> {
    const sab = new SharedArrayBuffer(Bridge.byteLength(capacity, schema));
    return { sab, capacity, schema };
  }

  /**
   * Allocate a reusable frame view. Array fields are pre-allocated heap-side
   * typed arrays of the right kind and length; scalar fields are initialized
   * to 0 / 0n. Use this once outside hot loops and reuse the returned object
   * on every push/pull call.
   */
  scratchFrame(): FrameFor<S> {
    const out: Record<string, unknown> = {};
    for (const field of this.schema.compiled.fields) {
      if (field.isArray) {
        out[field.name] = newHeapTypedArray(field.kind, field.length);
      } else {
        out[field.name] = kindTsType(field.kind) === "bigint" ? 0n : 0;
      }
    }
    return out as FrameFor<S>;
  }

  /**
   * Producer side. Copies `view`'s fields into the next free slot, advances
   * write_index, and notifies any parked consumer. Returns false if the ring
   * is full.
   *
   * Hot path: per scalar field, one closure call (precomputed at construction);
   * per array field, one typed-array .set() into the slot's pre-cached view.
   * No per-call allocations.
   */
  push(view: FrameFor<S>): boolean {
    // SPSC: own counter is plain-read (sole producer), peer counter
    // acquire-loaded. Both i32, wrap-mod-2^32; the signed-32 subtraction
    // `(a - b) | 0` gives the correct true diff for |true_diff| < 2^31.
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) >= this.capacity) {
      return false; // full
    }
    // Unsigned-then-mask: the low log2(capacity) bits don't depend on
    // signed-ness, so this is wrap-invariant.
    const slot = (writeIdx >>> 0) & this.mask;
    const sw = this.scalarWriters;
    const frame = view as unknown as Record<string, unknown>;
    for (let i = 0; i < sw.length; i++) sw[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      // Each av[i][slot] is the precomputed per-slot view for field al[i].
      // The .set() copies from the user's view into the SAB slot.
      (av[i]![slot] as { set: (src: ArrayLike<number> | ArrayLike<bigint>) => void })
        .set(frame[al[i]!.name] as ArrayLike<number> | ArrayLike<bigint>);
    }
    // Compute + store invariant BEFORE release-store so the consumer's
    // acquire-load on writeIdx observes both the payload and the invariant
    // bytes as a single happens-before unit. See "Schema invariants" in
    // the file header for the protocol detail.
    if (this.invariantView !== null && this.schema.invariant !== null) {
      this.invariantView[
        slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
      ] = this.schema.invariant.compute(frame);
    }
    Atomics.store(this.indices, WRITE_IDX_LANE, (writeIdx + 1) | 0); // release
    // Unconditional notify — see file header on the always-notify protocol.
    Atomics.notify(this.indices, WRITE_IDX_LANE, 1);
    return true;
  }

  /**
   * Same as `push` but validates `view` per the schema first. Throws TypeError
   * on the first field mismatch. Use in tests / debug builds; the production
   * hot path should call `push` and trust caller-side construction (typically
   * via `scratchFrame()` reuse).
   */
  pushChecked(view: FrameFor<S>): boolean {
    this._validateFrame(view, "push");
    return this.push(view);
  }

  /**
   * Two-step zero-copy push. Returns a frame view whose array fields point
   * directly at the next free slot in the SAB; mutate the fields in place
   * (scalar assigns + array `.set(...)` calls), then call `commitPush()` to
   * publish (advance write_index + notify). Returns null if the ring is full.
   *
   * Use this when the producer wants to compute payload values directly into
   * the slot to skip the one .set() copy that `push(view)` would do. Only one
   * begin/commit pair can be in flight at a time per Bridge instance.
   */
  beginPush(): FrameFor<S> | null {
    if (this.pendingPushFrame !== null) {
      throw new Error(
        "Bridge.beginPush: a previous beginPush is still pending; call commitPush or abortPush first",
      );
    }
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) >= this.capacity) {
      return null;
    }
    const slot = (writeIdx >>> 0) & this.mask;
    const frame: Record<string, unknown> = {};
    for (let i = 0; i < this.arrayLayout.length; i++) {
      frame[this.arrayLayout[i]!.name] = this.arrayViews[i]![slot]!;
    }
    for (const f of this.scalarLayout) {
      frame[f.name] = kindTsType(f.kind) === "bigint" ? 0n : 0;
    }
    this.pendingPushFrame = frame;
    this.pendingPushSlot = slot;
    return frame as FrameFor<S>;
  }

  /** Publish the frame opened by beginPush. */
  commitPush(): void {
    if (this.pendingPushFrame === null) {
      throw new Error("Bridge.commitPush: no beginPush in flight");
    }
    const slot = this.pendingPushSlot;
    const frame = this.pendingPushFrame;
    const sw = this.scalarWriters;
    for (let i = 0; i < sw.length; i++) sw[i]!(slot, frame);
    // Array writes happened in place via the user's `.set(...)` calls into
    // the SAB-backed views handed out by beginPush. Nothing to copy here.
    if (this.invariantView !== null && this.schema.invariant !== null) {
      this.invariantView[
        slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
      ] = this.schema.invariant.compute(frame);
    }
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    Atomics.store(this.indices, WRITE_IDX_LANE, (writeIdx + 1) | 0);
    Atomics.notify(this.indices, WRITE_IDX_LANE, 1);
    this.pendingPushFrame = null;
    this.pendingPushSlot = -1;
  }

  /** Discard the frame opened by beginPush without publishing. */
  abortPush(): void {
    this.pendingPushFrame = null;
    this.pendingPushSlot = -1;
  }

  /**
   * Consumer side. Reads the oldest unread frame into `out` and advances
   * read_index. Returns false on empty.
   */
  pull(out: FrameFor<S>): boolean {
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE); // acquire
    if (writeIdx === readIdx) {
      return false; // empty — exact i32 equality is wrap-correct
    }
    const slot = (readIdx >>> 0) & this.mask;
    const frame = out as unknown as Record<string, unknown>;
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
      dst.set(av[i]![slot]!);
    }
    // Read stored invariant BEFORE release-store so the slot bytes are still
    // ours. The classification/recovery math below only touches heap state
    // so it can safely run AFTER release.
    const invariantStored = this.invariantView !== null
      ? this.invariantView[
          slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
        ]!
      : 0;
    Atomics.store(this.indices, READ_IDX_LANE, (readIdx + 1) | 0); // release
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    if (this.schema.invariant !== null) {
      this._invariantHandleRaw(frame, invariantStored);
    } else {
      // No invariant: raw pull invalidates the smoother's prev — next
      // smoothed call re-seeds. Allocation-free; prev buffer retained.
      this.consumerPrevValid = false;
    }
    this._updateFlowScale(writeIdx, readIdx);
    return true;
  }

  /**
   * Drain to the newest available frame into `out`. Skipped older frames are
   * discarded. Returns the number of frames skipped (0 if a single frame was
   * waiting, N if N+1 frames were buffered), or -1 if the ring was empty.
   *
   * This is the AudioWorklet's expected per-quantum call: take the freshest
   * macro-rate frame, drop staleness, minimize control→audio lag.
   */
  pullLatest(out: FrameFor<S>): number {
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    if (writeIdx === readIdx) return -1;
    const newestIdx = (writeIdx - 1) | 0;
    const skipped = ((newestIdx - readIdx) | 0); // ≥ 0 by the empty-check above
    const slot = (newestIdx >>> 0) & this.mask;
    const frame = out as unknown as Record<string, unknown>;
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
      dst.set(av[i]![slot]!);
    }
    const invariantStored = this.invariantView !== null
      ? this.invariantView[
          slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
        ]!
      : 0;
    Atomics.store(this.indices, READ_IDX_LANE, writeIdx | 0); // consume everything up to writeIdx
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    if (this.schema.invariant !== null) {
      this._invariantHandleRaw(frame, invariantStored);
    } else {
      // No invariant: raw pullLatest invalidates the smoother's prev — next
      // smoothed call re-seeds. Allocation-free; prev buffer is retained.
      this.consumerPrevValid = false;
    }
    this._updateFlowScale(writeIdx, readIdx);
    return skipped;
  }

  /**
   * Consumer-side smoothed single-frame pull. Equivalent to `pull` but blends
   * the freshly-read frame against the previously-returned smoothed frame
   * using a one-pole low-pass:
   *
   *   out_i ← α_base · curr_i + (1 − α_base) · prev_i
   *
   * α_base ∈ [0, 1]: 1.0 = no smoothing (≡ raw pull); smaller = more inertia.
   * On the first smoothed call (or the first after any non-smoothed pull /
   * `resetSmoother()`) there is no prev — the fresh frame is returned
   * verbatim and stored as the new prev.
   *
   * BigInt-typed fields (u64 / i64) are passed through verbatim regardless of
   * α — there is no meaningful blend on monotonic sequence counters /
   * timestamps. Integer-typed numeric fields are blended in float then
   * `Math.round`-ed back. Float fields blend in float.
   *
   * Returns false on empty (no payload read; smoother state untouched).
   *
   * `opts.skipPolicy` (0.6.6) is accepted for API symmetry with
   * `pullLatestSmoothed` but has no behavioral effect: `pullSmoothed` always
   * has `skipped === 0`, where both policies degenerate to `α_eff = α_base`.
   *
   * Memory ordering matches `pull`. See file header "Smoothed pulls".
   */
  pullSmoothed(
    out: FrameFor<S>,
    alphaBase: number,
    _opts?: SmoothedPullOptions,
  ): boolean {
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    if (writeIdx === readIdx) return false;
    const slot = (readIdx >>> 0) & this.mask;
    const frame = out as unknown as Record<string, unknown>;
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
      dst.set(av[i]![slot]!);
    }
    const invariantStored = this.invariantView !== null
      ? this.invariantView[
          slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
        ]!
      : 0;
    Atomics.store(this.indices, READ_IDX_LANE, (readIdx + 1) | 0);
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    this._invariantHandleSmoothed(frame, invariantStored, alphaBase);
    this._updateFlowScale(writeIdx, readIdx);
    return true;
  }

  /**
   * Consumer-side smoothed drain-to-latest. Equivalent to `pullLatest` but
   * blends the freshly-read newest frame against the previously-returned
   * smoothed frame using a skip-scaled one-pole low-pass.
   *
   * `α_eff` is selected by `opts.skipPolicy` (default `'stall-smooth'`,
   * preserves 0.4.1..0.6.5 behavior bit-exact):
   *
   *   'stall-smooth':  α_eff = α_base · 2^(−skipped)
   *   'catch-up'    :  α_eff = 1 − (1 − α_base)^(skipped + 1)
   *
   * Then `out_i ← α_eff · curr_i + (1 − α_eff) · prev_i`.
   *
   * Under `'stall-smooth'` a single-frame catch-up uses `α_eff = α_base`
   * (steady-state smoothing); a large drain (producer stalled, consumer
   * caught a backlog) uses an exponentially smaller α_eff (mostly trust
   * prev, drift slowly toward the catch-up state). This masks producer
   * hiccups click-free at the cost of lag during big jumps — appropriate
   * when the producer's recent post-stall values are correct but the jump
   * itself would audibly click if applied raw.
   *
   * Under `'catch-up'` the same skipped-frame stall drives α_eff → 1, so
   * the smoother snaps to the new frame. Right when the producer's post-
   * stall value is a discontinuous correction that should be reflected
   * immediately (control surfaces, UI parameter changes), or when chase
   * latency matters more than click-suppression. See `SmootherSkipPolicy`.
   *
   * Returns -1 on empty, else the number of frames skipped (0 if a single
   * frame was waiting). Same field-type rules as `pullSmoothed`. Memory
   * ordering matches `pullLatest`. See file header "Smoothed pulls".
   */
  pullLatestSmoothed(
    out: FrameFor<S>,
    alphaBase: number,
    opts?: SmoothedPullOptions,
  ): number {
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    if (writeIdx === readIdx) return -1;
    const newestIdx = (writeIdx - 1) | 0;
    const skipped = ((newestIdx - readIdx) | 0);
    const slot = (newestIdx >>> 0) & this.mask;
    const frame = out as unknown as Record<string, unknown>;
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
      dst.set(av[i]![slot]!);
    }
    // Read stored invariant BEFORE release so the slot bytes are still ours.
    const invariantStored = this.invariantView !== null
      ? this.invariantView[
          slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
        ]!
      : 0;
    Atomics.store(this.indices, READ_IDX_LANE, writeIdx | 0);
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    // Skip-scaling policy (0.6.6 — see SmootherSkipPolicy). Default
    // 'stall-smooth' is bit-exact equal to the pre-0.6.6 formula on every
    // skipped value: at skipped=0 both branches yield alphaBase exactly;
    // for skipped>0 only the explicit 'catch-up' option diverges.
    let alphaEff: number;
    if (opts !== undefined && opts.skipPolicy === "catch-up") {
      // Closed form of (skipped + 1) applications of the one-pole filter.
      // At skipped=0 this is `1 - (1 - alphaBase)` = alphaBase exactly.
      alphaEff = 1 - Math.pow(1 - alphaBase, skipped + 1);
    } else {
      // 2^(-skipped) via Math.pow; V8 special-cases integer exponents.
      // For skipped=0 this is 1.0 → alphaEff = alphaBase exactly.
      alphaEff = alphaBase * Math.pow(2, -skipped);
    }
    this._invariantHandleSmoothed(frame, invariantStored, alphaEff);
    this._updateFlowScale(writeIdx, readIdx);
    return skipped;
  }

  /**
   * Forget the consumer-side cached prev frame. The buffer is used by both
   * the α-smoother (`pullSmoothed` / `pullLatestSmoothed`) and the schema-
   * invariant hard-error recovery path (under `.withInvariant` schemas):
   *
   *   - Next `pullSmoothed` / `pullLatestSmoothed` behaves as a first-call:
   *     no blending, fresh frame returned verbatim and stored as the new
   *     prev.
   *   - Next invariant hard-error has no last-known-good to fall back to,
   *     so the raw (possibly corrupt) payload passes through. `tornFrames`
   *     still increments so the failure is visible in `telemetry()`.
   *
   * Use this at quiescence boundaries (producer just started, consumer
   * just woke from suspend) to avoid blending or fallback against a
   * possibly-stale prev. Under a no-invariant schema, raw `pull` /
   * `pullLatest` already invalidate implicitly; call this only if you need
   * to invalidate without consuming a frame, or to wipe the invariant
   * fallback buffer.
   */
  resetSmoother(): void {
    this.consumerPrevValid = false;
  }

  /**
   * PLL observation — consumer-side. Pair the timestamp the producer wrote
   * into a recently-pulled frame (`producerNs`, typically `Number(frame.tMacroNs)`
   * or `Number(frame.tMacroNs - epochNs)` depending on the consumer's frame
   * of reference) with the consumer's wall-clock reading at the moment
   * that frame was pulled or evaluated (`consumerNs`, typically
   * `AudioContext.currentTime * 1e9`).
   *
   * The first call seeds the offset estimate exactly (`pllOffsetNs =
   * producerNs - consumerNs`) and flips `pllLocked=true`. Subsequent calls
   * run one PI cycle each:
   *
   *     residual = (producerNs - consumerNs) - pllOffsetNs
   *     pllIntegral = clamp(pllIntegral + residual, ±PLL_INT_LIMIT_NS)
   *     pllOffsetNs += PLL_KP · residual + PLL_KI · pllIntegral
   *
   * `consumerNs` and `producerNs` are user-supplied scalars; the bridge has
   * no opinion on which clocks they came from as long as the pairing is
   * consistent (same observation event). Calling once per `pull` is the
   * canonical pattern; calling more often is harmless (the PI converges
   * faster); calling less often is fine (the PI is just slower to settle).
   *
   * Cost: ~5 arithmetic ops + 2 compares. Allocation-free. Safe to call
   * from an AudioWorklet's `process()` loop.
   *
   * NOT exposed via the SAB header — the offset estimate lives only on the
   * caller's Bridge instance. A second Bridge instance (e.g. the producer
   * side observing PLL state) cannot read it. Cross-process observability
   * is a deferred Pillar 2 follow-up (lanes 4-5 will publish the offset).
   */
  observeConsumerTime(consumerNs: number, producerNs: number): void {
    if (!Number.isFinite(consumerNs) || !Number.isFinite(producerNs)) {
      throw new Error(
        `observeConsumerTime: arguments must be finite (consumerNs=${consumerNs}, producerNs=${producerNs})`,
      );
    }
    if (!this.pllLocked) {
      this.pllOffsetNs = producerNs - consumerNs;
      this.pllIntegral = 0;
      this.pllLocked = true;
      return;
    }
    const residual = (producerNs - consumerNs) - this.pllOffsetNs;
    let integral = this.pllIntegral + residual;
    if (integral > PLL_INT_LIMIT_NS) integral = PLL_INT_LIMIT_NS;
    else if (integral < -PLL_INT_LIMIT_NS) integral = -PLL_INT_LIMIT_NS;
    this.pllIntegral = integral;
    this.pllOffsetNs += PLL_KP * residual + PLL_KI * integral;
  }

  /**
   * PLL evaluation — map a consumer-clock reading to the producer-clock
   * frame of reference using the current offset estimate. Returns
   * `consumerNs + pllOffsetNs` once `observeConsumerTime` has been called
   * at least once; before that, returns `consumerNs` unchanged (the safest
   * fallback: trust the consumer clock until the loop has any data).
   *
   * Typical use inside an AudioWorklet's per-sample loop:
   *
   *     for (let i = 0; i < 128; i++) {
   *       const consumerNs = (currentTime + i / sampleRate) * 1e9;
   *       const dtNs = bridge.phaseLockedTime(consumerNs) - Number(frame.tMacroNs);
   *       evaluateTrajectoryInto(frame.vEff, spec, dtNs * 1e-9, out);
   *       synth.step(out[i]);
   *     }
   *
   * Cost: one add + one boolean check. Safe at audio rate.
   */
  phaseLockedTime(consumerNs: number): number {
    if (!this.pllLocked) return consumerNs;
    return consumerNs + this.pllOffsetNs;
  }

  /**
   * Reset the PLL to the unlocked state. The next `observeConsumerTime`
   * call seeds the offset from scratch. Call when the consumer's clock
   * epoch jumps (suspend/resume, AudioContext close/reopen) or when the
   * producer reconnects with a different `tMacroNs` epoch.
   *
   * Does not touch `consumerPrev` or `piIntegral` — the PLL, α-smoother,
   * and flow-scale controller are independent state machines. Use
   * `resetSmoother()` alongside this if you also want to drop the
   * α-smoother's history.
   */
  resetPll(): void {
    this.pllLocked = false;
    this.pllOffsetNs = 0;
    this.pllIntegral = 0;
  }

  /**
   * Per-frame trajectory evaluator (0.6.3, Pillar 3 first cut). Walks every
   * field of the schema and applies the Pillar 1 evaluator to trajectory
   * fields; everything else passes through into `outFrame` verbatim. Heap-
   * only — no SAB access, no internal state — so safe to call repeatedly
   * at audio rate without cache-line pingpong against the producer.
   *
   * Field dispatch (compiled.fields order):
   *   - trajectory field → evaluateTrajectoryInto(srcFrame[name], spec, dt,
   *     outFrame[name]). outFrame's field must be a typed-array of length
   *     ≥ spec.sampleCount (NOT sampleCount * order — the output is the
   *     extrapolated positions only). Pre-allocate via scratchEvaluatedFrame().
   *   - non-trajectory array → outFrame[name].set(srcFrame[name]). Lengths
   *     must match.
   *   - scalar (number or BigInt) → outFrame[name] = srcFrame[name].
   *
   * `dt` is unit-agnostic — same contract as evaluateTrajectoryInto. The
   * producer chose the velocity / acceleration units when packing the
   * trajectory; the caller supplies a matching `dt`. Combined with Pillar
   * 2's PLL, the canonical AudioWorklet pattern is:
   *
   *     this.bridge.pullLatest(this.rawFrame);
   *     this.bridge.observeConsumerTime(quantumNs, Number(this.rawFrame.tMacroNs));
   *     for (let i = 0; i < 128; i++) {
   *       const cNs = quantumNs + (i / sampleRate) * 1e9;
   *       const dtNs = this.bridge.phaseLockedTime(cNs) - Number(this.rawFrame.tMacroNs);
   *       this.bridge.evaluateInto(this.rawFrame, dtNs * 1e-9, this.evalFrame);
   *       block[i] = this.synth.step(this.evalFrame.vEff);
   *     }
   *
   * Cost scales with field count. ~5-10 ns per trajectory sample at
   * order=2; a couple of ns per scalar field; one typed-array .set() per
   * non-trajectory array. Allocation-free against caller-owned buffers.
   *
   * Pillar 3 deferred (still in the plan, queued for follow-ups):
   *   - bridge.pullEvaluated(out, sampleOffset, sampleRate) sugar wrapping
   *     pull + observe + evaluate into a single hot-path call.
   *   - EvalMode dispatch (step / alpha / trajectory / catmull) — needs
   *     design discussion about composition with pullSmoothed.
   *   - Per-quantum batch API (write all 128 samples in one call).
   */
  evaluateInto(srcFrame: FrameFor<S>, dt: number, outFrame: FrameFor<S>): void {
    if (!Number.isFinite(dt)) {
      throw new Error(`evaluateInto: dt must be finite, got ${dt}`);
    }
    const src = srcFrame as unknown as Record<string, unknown>;
    const out = outFrame as unknown as Record<string, unknown>;
    const fields = this.schema.compiled.fields;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const name = field.name;
      if (field.trajectory) {
        // Trajectory field. evaluateTrajectoryInto throws on length
        // mismatch — we don't pre-validate, the helper's message is clearer.
        if (field.kind === "f64") {
          evaluateTrajectoryInto(
            src[name] as Float64Array,
            field.trajectory,
            dt,
            out[name] as Float64Array,
          );
        } else if (field.kind === "f32") {
          evaluateTrajectoryInto(
            src[name] as Float32Array,
            field.trajectory,
            dt,
            out[name] as Float32Array,
          );
        } else {
          // Defensive — the DSL only allows trajectory tags on f64/f32.
          throw new Error(
            `evaluateInto: trajectory field '${name}' has unexpected kind '${field.kind}'`,
          );
        }
      } else if (field.isArray) {
        // Non-trajectory array — verbatim .set(). TypedArray.set throws
        // RangeError if out is shorter than src; we let that surface.
        (out[name] as { set(s: ArrayLike<unknown>): void }).set(
          src[name] as ArrayLike<unknown>,
        );
      } else {
        // Scalar (number or BigInt) — direct copy.
        out[name] = src[name];
      }
    }
  }

  /**
   * Allocate a reusable output frame shaped for evaluateInto. Trajectory
   * fields are sized to `sampleCount` (post-Taylor-evaluation positions);
   * everything else matches scratchFrame() — non-trajectory arrays at
   * their full length, scalars zero-initialized.
   *
   * Call once at consumer init outside the hot loop; reuse the returned
   * object on every evaluateInto call.
   */
  scratchEvaluatedFrame(): FrameFor<S> {
    const out: Record<string, unknown> = {};
    for (const field of this.schema.compiled.fields) {
      if (field.trajectory) {
        // Post-evaluation: extrapolated positions only, length = sampleCount.
        out[field.name] = newHeapTypedArray(
          field.kind,
          field.trajectory.sampleCount,
        );
      } else if (field.isArray) {
        out[field.name] = newHeapTypedArray(field.kind, field.length);
      } else {
        out[field.name] = kindTsType(field.kind) === "bigint" ? 0n : 0;
      }
    }
    return out as FrameFor<S>;
  }

  /**
   * Register a default sample rate so subsequent `pullEvaluatedLatest` /
   * `evaluateAtSampleOffset` calls can omit the per-call sample-rate
   * argument. Typical AudioWorklet pattern: call once at consumer init
   * with `sampleRate` (the worklet's lifetime-fixed audio rate).
   *
   * The per-call arg still takes precedence if both are supplied — useful
   * for the rare sample-rate-change scenarios. (0.6.5)
   */
  setSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        `setSampleRate: rate must be a positive finite number, got ${rate}`,
      );
    }
    this.defaultSampleRate = rate;
  }

  /**
   * Drain to the newest available frame, observe its producer-stamped
   * timestamp against the consumer wall-clock, evaluate sample 0 of the
   * quantum into `out`, and cache state so subsequent
   * `evaluateAtSampleOffset(out, i)` calls reconstruct samples 1..N − 1
   * without further SAB access. The canonical AudioWorklet entry point
   * for Pillars 1 + 2 + 3 stacked.
   *
   * Returns:
   *  - skipped-frame count (≥ 0): a fresh frame was pulled; PLL observed;
   *    cache + `out` updated.
   *  - −1: ring was empty. If the cache was previously valid (any earlier
   *    successful `pullEvaluatedLatest`), `out` is populated from the
   *    cached frame using the new quantum's base/sampleRate (the PLL is
   *    NOT re-observed — repeating a stale producer stamp at advancing
   *    consumer times would poison the residual). If the cache is empty
   *    (first quantum with no producer push), `out` is left untouched —
   *    callers using `scratchEvaluatedFrame()` see zero-initialized
   *    silence in that case.
   *
   * `sampleRate`: per-call audio sample rate. May be omitted (or passed
   * `undefined`) if a default was registered via `setSampleRate(rate)`;
   * throws otherwise. Per-call value wins if both are present.
   *
   * `opts.timestamp`: name of one of the schema's declared timestamp
   * roles (`.withTimestamps({ ... })`). Defaults to the role flagged
   * `default: true` (or the first declared role if none was flagged).
   * Compile-time-checked via `TimestampRoleOf<S>`.
   *
   * Requires the schema to have `.withTimestamps(...)` attached — throws
   * otherwise. (0.6.5)
   */
  pullEvaluatedLatest(
    out: FrameFor<S>,
    baseConsumerNs: number,
    sampleRate?: number,
    opts?: { timestamp?: TimestampRoleOf<S> },
  ): number {
    if (!Number.isFinite(baseConsumerNs)) {
      throw new Error(
        `pullEvaluatedLatest: baseConsumerNs must be finite, got ${baseConsumerNs}`,
      );
    }
    const sr = sampleRate ?? this.defaultSampleRate;
    if (!Number.isFinite(sr) || sr <= 0) {
      throw new Error(
        `pullEvaluatedLatest: sampleRate not provided and no default set via setSampleRate(rate)`,
      );
    }
    if (this.schema.timestamps === null) {
      throw new Error(
        `pullEvaluatedLatest: schema has no .withTimestamps(...) attached`,
      );
    }
    const roleName = opts?.timestamp ?? this.schema.timestamps.defaultRole;
    const role = this.schema.timestamps.roles[roleName];
    if (!role) {
      throw new Error(
        `pullEvaluatedLatest: unknown timestamp role '${String(roleName)}'`,
      );
    }
    if (this.cachedRawFrame === null) {
      this.cachedRawFrame = this.scratchFrame();
    }
    const skipped = this.pullLatest(this.cachedRawFrame);
    if (skipped >= 0) {
      // Fresh frame — update timestamp cache and drive the PLL. Observing
      // is gated on a fresh pull because feeding the PLL a repeated
      // producer stamp at increasing consumer times would poison the
      // residual (the producer's true clock is advancing, it just hasn't
      // pushed yet).
      const rawValue = (this.cachedRawFrame as unknown as Record<string, unknown>)[role.field];
      const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
      this.cachedTimestampNs = this._timestampToNs(numericRaw, role.unit, sr);
      this.observeConsumerTime(baseConsumerNs, this.cachedTimestampNs);
      this.cachedEvalValid = true;
    } else if (!this.cachedEvalValid) {
      // Ring is empty and we've never pulled a frame — nothing to evaluate.
      return -1;
    }
    // Either case (fresh-pull or cache-only): update the quantum context
    // so sample-offset arithmetic uses this quantum's base/rate, then
    // evaluate sample 0 into `out`.
    this.cachedBaseConsumerNs = baseConsumerNs;
    this.cachedSampleRate = sr;
    this.evaluateAtSampleOffset(out, 0);
    return skipped;
  }

  /**
   * Evaluate sample `sampleOffset` of the active quantum (set up by the
   * most recent successful `pullEvaluatedLatest`) into `out`. Computes
   * `consumerNs = base + sampleOffset / sampleRate · 1e9`, runs the PLL
   * to map into producer-clock space, computes `dt = (producerEstimate −
   * cachedTimestampNs) · 1e−9` (seconds), and calls `evaluateInto` against
   * the cached raw frame.
   *
   * Heap-only — never touches the SAB. Cost = one `phaseLockedTime`
   * (one add + one boolean check post-lock) + one `evaluateInto`
   * (which itself is ~5–10 ns per trajectory sample at order=2).
   *
   * Throws if no successful `pullEvaluatedLatest` has run yet (or after
   * `resetEvalCache()`). `sampleOffset` may be any finite integer ≥ 0;
   * the bridge does not enforce that it's < quantumSize, since callers
   * occasionally want to look ahead. (0.6.5)
   */
  evaluateAtSampleOffset(out: FrameFor<S>, sampleOffset: number): void {
    if (!this.cachedEvalValid) {
      throw new Error(
        `evaluateAtSampleOffset: no cached frame; call pullEvaluatedLatest first`,
      );
    }
    if (!Number.isFinite(sampleOffset)) {
      throw new Error(
        `evaluateAtSampleOffset: sampleOffset must be finite, got ${sampleOffset}`,
      );
    }
    const consumerNs =
      this.cachedBaseConsumerNs + (sampleOffset / this.cachedSampleRate) * 1e9;
    const producerNs = this.phaseLockedTime(consumerNs);
    const dt_s = (producerNs - this.cachedTimestampNs) * 1e-9;
    this.evaluateInto(this.cachedRawFrame as FrameFor<S>, dt_s, out);
  }

  /**
   * Invalidate the cache shared by `pullEvaluatedLatest` /
   * `evaluateAtSampleOffset`. After this call, `evaluateAtSampleOffset`
   * throws until the next successful `pullEvaluatedLatest`. The raw-frame
   * buffer is retained (no allocation on next pull).
   *
   * Independent of `resetSmoother()` (α-smoother prev) and `resetPll()`
   * (PLL offset estimate). Call on `AudioContext` suspend/resume, when
   * the producer reconnects with a different timestamp epoch, or
   * whenever you want to drop the cached quantum context. (0.6.5)
   */
  resetEvalCache(): void {
    this.cachedEvalValid = false;
  }

  /**
   * Convert a timestamp value (read from the schema's role field, in the
   * role's declared unit) into nanoseconds. Used internally by
   * `pullEvaluatedLatest` to populate `cachedTimestampNs`.
   *
   * Supported units: ns / us / ms / s / samples (samples uses the
   * provided sampleRate). Future extension: a `'custom'` unit with a
   * caller-supplied `toNs` multiplier on the role spec — a single
   * `case "custom": return value * role.toNs;` branch added here when a
   * concrete caller asks for it.
   */
  private _timestampToNs(
    value: number,
    unit: TimestampUnit,
    sampleRate: number,
  ): number {
    switch (unit) {
      case "ns":      return value;
      case "us":      return value * 1e3;
      case "ms":      return value * 1e6;
      case "s":       return value * 1e9;
      case "samples": return (value / sampleRate) * 1e9;
    }
  }

  /**
   * Apply the one-pole blend in-place on `out` and update `consumerPrev`.
   *
   * Called by `pullSmoothed` / `pullLatestSmoothed` after the SAB read +
   * release-store have completed. `out` arrives holding the raw fresh frame
   * (curr); on exit it holds the blended frame, and `this.consumerPrev` mirrors
   * it. Allocation-free in steady state; the first call allocates the prev
   * buffer via `scratchFrame()` (heap typed arrays + scalar zeros), seeds it
   * with curr, and flips `consumerPrevValid` true.
   */
  private _applySmoother(out: Record<string, unknown>, alpha: number): void {
    if (!this.consumerPrevValid) {
      // First smoothed call (or first after invalidation): no blend, just
      // seed prev with the current fresh frame. Allocate prev if needed.
      if (this.consumerPrev === null) {
        this.consumerPrev = this.scratchFrame();
      }
      this._copyFrameInto(out, this.consumerPrev as unknown as Record<string, unknown>);
      this.consumerPrevValid = true;
      return;
    }
    const prev = this.consumerPrev as unknown as Record<string, unknown>;
    const oneMinusAlpha = 1 - alpha;
    // Scalars.
    const sl = this.scalarLayout;
    const sbi = this.scalarIsBigInt;
    const sii = this.scalarIsInteger;
    for (let i = 0; i < sl.length; i++) {
      const name = sl[i]!.name;
      if (sbi[i]) {
        // BigInt — verbatim pass-through. `out` already holds curr; sync prev.
        prev[name] = out[name];
      } else {
        const curr = out[name] as number;
        const p = prev[name] as number;
        let blended = alpha * curr + oneMinusAlpha * p;
        if (sii[i]) blended = Math.round(blended);
        out[name] = blended;
        prev[name] = blended;
      }
    }
    // Arrays.
    const al = this.arrayLayout;
    const abi = this.arrayIsBigInt;
    const aii = this.arrayIsInteger;
    const ato = this.arrayTrajectoryOrder;
    for (let i = 0; i < al.length; i++) {
      const name = al[i]!.name;
      if (abi[i]) {
        const currArr = out[name] as { set(s: ArrayLike<bigint>): void } & ArrayLike<bigint>;
        const prevArr = prev[name] as { set(s: ArrayLike<bigint>): void };
        prevArr.set(currArr);
      } else {
        const cA = out[name] as { length: number; [j: number]: number };
        const pA = prev[name] as { length: number; [j: number]: number };
        const isInt = aii[i];
        const L = cA.length;
        const order = ato[i]!;
        if (order === 0) {
          // Plain array (or order=1 trajectory): blend every element.
          for (let j = 0; j < L; j++) {
            let b = alpha * cA[j]! + oneMinusAlpha * pA[j]!;
            if (isInt) b = Math.round(b);
            cA[j] = b;
            pA[j] = b;
          }
        } else {
          // Trajectory order=2 or order=3. Layout is interleaved:
          //   order=2 → [p, v, p, v, ...]; order=3 → [p, v, a, p, v, a, ...].
          // Blend positions (`j % order === 0`) and copy derivative slots
          // verbatim from curr. Velocity and acceleration are snapshots of
          // the producer's instantaneous state — time-averaging them across
          // frames corrupts the very signal the trajectory ships to preserve.
          for (let j = 0; j < L; j++) {
            if ((j % order) === 0) {
              let b = alpha * cA[j]! + oneMinusAlpha * pA[j]!;
              if (isInt) b = Math.round(b);
              cA[j] = b;
              pA[j] = b;
            } else {
              // Derivative slot: out already holds curr; sync prev to match.
              pA[j] = cA[j]!;
            }
          }
        }
      }
    }
  }

  /**
   * Run one PI controller cycle against the pre-pull occupancy and publish
   * the new flow_scale on lane 2. Called from the four pull paths after the
   * release-store on read_index, only on the successful (frame-was-consumed)
   * branch — empty-pull early-returns skip this so the controller never sees
   * a misleading "occupancy = 0 because nobody pulled" sample.
   *
   * Pre-pull occupancy = `(writeIdx - readIdx) / capacity`, where readIdx is
   * the value BEFORE the consumer's increment — i.e. "how full was the ring
   * when the consumer arrived to take a frame." For `pullLatest` the diff is
   * `skipped + 1`. The wrap-invariant signed subtraction `(a - b) | 0` is
   * the same trick used throughout for the SPSC counters.
   *
   * See file header "Adaptive backpressure" for the gain rationale and
   * anti-windup design.
   */
  private _updateFlowScale(writeIdx: number, readIdx: number): void {
    const buffered = (writeIdx - readIdx) | 0;
    const occupancy = buffered / this.capacity;
    const err = occupancy - 0.5;
    let integral = this.piIntegral + err;
    // Anti-windup: bound the integrator so a long stall can't trap the
    // controller in permanent over-correction.
    if (integral > FLOW_SCALE_INT_LIMIT) integral = FLOW_SCALE_INT_LIMIT;
    else if (integral < -FLOW_SCALE_INT_LIMIT) integral = -FLOW_SCALE_INT_LIMIT;
    this.piIntegral = integral;
    // Sign: err > 0 (consumer overfull) → scale < 1 (producer slow down);
    // err < 0 (consumer starved) → scale > 1 (producer speed up).
    let scale = 1 - FLOW_SCALE_KP * err - FLOW_SCALE_KI * integral;
    if (scale < FLOW_SCALE_MIN) scale = FLOW_SCALE_MIN;
    else if (scale > FLOW_SCALE_MAX) scale = FLOW_SCALE_MAX;
    // Q16.16 encode. floor not round — preserves the boundary semantics
    // documented in flowScaleHint().
    Atomics.store(
      this.indices,
      FLOW_SCALE_LANE,
      Math.floor(scale * FLOW_SCALE_Q),
    );
  }

  /**
   * Classify a stored vs computed invariant ratio into ok / soft / hard +
   * the soft-recovery α.
   *
   * The OK band is `max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)`
   * compared against `|computed − stored|` (0.6.6). For non-trivial `stored`
   * the relative term dominates and behavior is bit-identical to 0.6.5's
   * pure-ratio check; the absolute floor only matters when `stored` is
   * subnormal-tiny or exactly zero, where the old code misclassified rounding
   * residues as hard. `absoluteEpsilon` is set per-schema via
   * `.withInvariant(fn, { absoluteEpsilon })` (default `1e-12`).
   *
   *   ok:    |computed − stored| < max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)
   *   soft:  delta < INVARIANT_SOFT_THRESHOLD   (relative; only when stored ≠ 0)
   *   hard:  otherwise, or NaN/Infinity on either side
   *
   * For soft, α = clamp(INVARIANT_SOFT_ALPHA_BASE / delta, 0, 1) — small
   * deviations get α≈1 (trust curr); deviations near the hard boundary get
   * α near INVARIANT_SOFT_ALPHA_BASE (trust prev). See file header "Schema
   * invariants" for the curve rationale.
   */
  private _classifyInvariant(
    computed: number,
    stored: number,
  ): { kind: "ok" | "soft" | "hard"; alpha: number } {
    if (!Number.isFinite(computed) || !Number.isFinite(stored)) {
      return { kind: "hard", alpha: 0 };
    }
    const absErr = Math.abs(computed - stored);
    // Bit-identical pre-0.6.6 short-circuit: exact equality is always OK,
    // even under absoluteEpsilon = 0 (which would otherwise collapse the OK
    // band to a half-open zero-width interval and miss the 0/0 case).
    if (absErr === 0) return { kind: "ok", alpha: 1 };
    const eps = this.invariantAbsoluteEpsilon;
    const absStored = Math.abs(stored);
    const okBand = eps > INVARIANT_OK_THRESHOLD * absStored
      ? eps
      : INVARIANT_OK_THRESHOLD * absStored;
    if (absErr < okBand) return { kind: "ok", alpha: 1 };
    if (stored === 0) {
      // OK band failed and stored is zero — relative-ratio classifier
      // undefined, so anything outside the absolute floor is hard.
      return { kind: "hard", alpha: 0 };
    }
    const delta = absErr / absStored;
    if (delta < INVARIANT_SOFT_THRESHOLD) {
      const alpha = Math.min(
        1,
        Math.max(0, INVARIANT_SOFT_ALPHA_BASE / delta),
      );
      return { kind: "soft", alpha };
    }
    return { kind: "hard", alpha: 0 };
  }

  /**
   * Invariant handler for raw pulls (`pull` / `pullLatest`) under an
   * invariant-enabled schema. Called after release-store and notify. Only
   * touches heap state (`consumerPrev`, `consumerPrevValid`, the
   * tornFrameCounter lane).
   *
   * Branches:
   *   ok   — seed/update consumerPrev with `out` (last-known-good).
   *   soft — invoke smoother with computed α (blends out with consumerPrev,
   *          updates consumerPrev to blended value).
   *   hard — Atomics.add tornFrameCounter. If consumerPrev is valid, copy
   *          it into out (graceful fallback). Otherwise leave out as the
   *          raw payload (corruption visible on first-pull hard error) and
   *          do NOT seed consumerPrev so corruption can't propagate.
   */
  private _invariantHandleRaw(
    out: Record<string, unknown>,
    invariantStored: number,
  ): void {
    const inv = this.schema.invariant;
    if (inv === null) return; // defensive — caller already checked.
    const computed = inv.compute(out);
    const { kind, alpha } = this._classifyInvariant(computed, invariantStored);
    if (kind === "ok") {
      this._seedConsumerPrev(out);
    } else if (kind === "soft") {
      this._applySmoother(out, alpha);
    } else {
      // hard
      Atomics.add(this.indices, TORN_FRAME_LANE, 1);
      if (this.consumerPrevValid && this.consumerPrev !== null) {
        this._copyFrameInto(
          this.consumerPrev as unknown as Record<string, unknown>,
          out,
        );
      }
      // else: pass through. Don't update consumerPrev (would propagate
      // corruption). Next ok pull will (re-)seed.
    }
  }

  /**
   * Invariant handler for smoothed pulls (`pullSmoothed` /
   * `pullLatestSmoothed`). Always runs the smoother on ok / soft / no-
   * invariant; on hard error, falls back to consumerPrev (or passes through
   * with smoother seeding when no prev). Soft-error α is the USER's α — the
   * smoother is already smoothing; layering recovery-α on top is
   * unnecessary (the smoother's α gate handles minor deviations).
   */
  private _invariantHandleSmoothed(
    out: Record<string, unknown>,
    invariantStored: number,
    alpha: number,
  ): void {
    if (this.schema.invariant === null) {
      // No invariant: behavior identical to 0.5.0 smoothed pull.
      this._applySmoother(out, alpha);
      return;
    }
    const computed = this.schema.invariant.compute(out);
    const { kind } = this._classifyInvariant(computed, invariantStored);
    if (kind === "hard") {
      Atomics.add(this.indices, TORN_FRAME_LANE, 1);
      if (this.consumerPrevValid && this.consumerPrev !== null) {
        this._copyFrameInto(
          this.consumerPrev as unknown as Record<string, unknown>,
          out,
        );
      }
      // else: pass through; don't seed prev with corrupt data.
      return;
    }
    // ok or soft: smoother handles both. Identical to no-invariant path.
    this._applySmoother(out, alpha);
  }

  /** Allocate-on-demand seed of `consumerPrev` from `src`. */
  private _seedConsumerPrev(src: Record<string, unknown>): void {
    if (this.consumerPrev === null) this.consumerPrev = this.scratchFrame();
    this._copyFrameInto(
      src,
      this.consumerPrev as unknown as Record<string, unknown>,
    );
    this.consumerPrevValid = true;
  }

  /** Copy `src` into `dst` field-by-field. Used to seed `consumerPrev` on
   *  the first smoothed call or invariant ok-branch. Scalars are plain
   *  assigns; arrays use typed-array `.set()` so length / element-kind
   *  validation happens at the runtime layer (`dst` is always a freshly-
   *  allocated `scratchFrame()`). */
  private _copyFrameInto(
    src: Record<string, unknown>,
    dst: Record<string, unknown>,
  ): void {
    for (const f of this.scalarLayout) {
      dst[f.name] = src[f.name];
    }
    for (const f of this.arrayLayout) {
      (dst[f.name] as { set: (s: ArrayLike<number> | ArrayLike<bigint>) => void }).set(
        src[f.name] as ArrayLike<number> | ArrayLike<bigint>,
      );
    }
  }

  /** Number of frames currently buffered (≤ capacity). */
  available(): number {
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    return ((writeIdx - readIdx) | 0);
  }

  /**
   * Producer-side adaptive backpressure hint. Returns the consumer's most
   * recent flow_scale value in [0.5, 2.0]:
   *
   *   1.0  no scaling — producer/consumer rates are matched
   *   <1.0 consumer is overfull — producer should slow down (push less)
   *   >1.0 consumer is starved  — producer should speed up (push more)
   *
   * Best-effort: the bridge does NOT enforce this. The producer voluntarily
   * honors the hint by scaling its `dt`, dropping frames, sleeping a
   * fraction of its interval, etc. The hard contract is still capacity-
   * based push reject (`push()` returns false when full); flow_scale is the
   * soft layer that, when honored, keeps the producer/consumer matched so
   * the hard reject is reached only under genuine overload.
   *
   * See file header "Adaptive backpressure" for the controller math.
   *
   * Q16.16 encoding detail: `floor(scale * 65536)`, so the returned value is
   * quantized to multiples of 2⁻¹⁶ on the way out. The producer should treat
   * the result as a real number; the round-trip error is below any practical
   * tuning resolution.
   */
  flowScaleHint(): number {
    return (Atomics.load(this.indices, FLOW_SCALE_LANE) | 0) / FLOW_SCALE_Q;
  }

  /**
   * Observability snapshot. Returns a frozen object with the current state
   * of every bridge-managed counter / hint:
   *
   *   tornFrames  — monotonic count of hard-error invariant fallbacks since
   *                 SAB allocation (0 if the schema has no invariant or if
   *                 no hard error has ever occurred). Wraps mod 2^32 like
   *                 the other Int32 lanes.
   *   flowScale   — current consumer→producer adaptive backpressure hint,
   *                 in [0.5, 2.0]. Same value `flowScaleHint()` returns.
   *   available   — number of frames currently buffered.
   *   capacity    — total ring capacity (constant per Bridge instance).
   *   writeIndex  — current producer counter (Int32, wraps mod 2^32).
   *   readIndex   — current consumer counter (Int32, wraps mod 2^32).
   *
   * All reads are O(1) and use Atomics.load — safe to call from any
   * thread. The snapshot is a point-in-time sample; under live producer/
   * consumer activity the values are individually consistent but not
   * mutually atomic. For diagnostic / dashboard use only.
   */
  telemetry(): {
    readonly tornFrames: number;
    readonly flowScale: number;
    readonly available: number;
    readonly capacity: number;
    readonly writeIndex: number;
    readonly readIndex: number;
    readonly pllLocked: boolean;
    readonly pllOffsetNs: number;
  } {
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    return Object.freeze({
      // Read as unsigned so the counter is exposed in [0, 2^32) regardless
      // of i32 sign wrap. SPSC counters use signed-32 internally for the
      // wrap-invariant subtraction trick; telemetry consumers want the raw
      // monotonic count.
      tornFrames: Atomics.load(this.indices, TORN_FRAME_LANE) >>> 0,
      flowScale: (Atomics.load(this.indices, FLOW_SCALE_LANE) | 0) / FLOW_SCALE_Q,
      available: ((writeIdx - readIdx) | 0),
      capacity: this.capacity,
      writeIndex: writeIdx >>> 0,
      readIndex: readIdx >>> 0,
      // PLL fields are heap-only on this Bridge instance — a peer reading
      // their own Bridge's telemetry sees their own PLL state. Lanes 4-5
      // are still reserved; cross-process observability lands in a follow-up.
      pllLocked: this.pllLocked,
      pllOffsetNs: this.pllOffsetNs,
    });
  }

  /**
   * Producer-side park: block until the consumer advances read_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has space.
   *
   * Atomics.wait performs an atomic compare-and-park against the value at
   * indices[1] (read_index) — if the consumer advanced read_index between
   * our load and the wait, the wait returns "not-equal" immediately rather
   * than parking forever. This closes the load-then-park race window.
   *
   * NOTE: Atomics.wait blocks the calling thread. On the browser main thread
   * the spec forbids it (TypeError). On a Worker / Node main / Node worker
   * it is permitted. Do NOT call from an AudioWorklet process() method —
   * that is hard-real-time and must never block.
   */
  waitForSpace(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) < this.capacity) return "not-equal";
    return Atomics.wait(this.indices, READ_IDX_LANE, readIdx, timeoutMs);
  }

  /**
   * Consumer-side park: block until the producer advances write_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has data. Mirror of waitForSpace.
   *
   * NOT real-time safe — see waitForSpace for the threading rules. An
   * AudioWorklet's per-quantum read path MUST NOT call this; it should poll
   * via pullLatest() and tolerate misses.
   */
  waitForData(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    if (writeIdx !== readIdx) return "not-equal";
    return Atomics.wait(this.indices, WRITE_IDX_LANE, writeIdx, timeoutMs);
  }

  /**
   * Returns a JSON-able description of the schema's frame byte layout, for
   * worklets that want to inline the read protocol without importing the
   * Bridge class on the audio thread. The worklet can postMessage this
   * object across via `processorOptions` and reconstruct the per-field
   * typed-array views in its constructor.
   */
  describeLayout(): SchemaLayoutDescription {
    return describeSchemaLayout(this.schema);
  }

  // ─── Validation (used by pushChecked) ────────────────────────────────────

  private _validateFrame(view: FrameFor<S>, ctx: string): void {
    const frame = view as unknown as Record<string, unknown>;
    for (const field of this.schema.compiled.fields) {
      const val = frame[field.name];
      if (field.isArray) {
        const Ctor = ctorForKind(field.kind);
        if (!(val instanceof Ctor)) {
          const got = val === null || val === undefined
            ? String(val)
            : (val as { constructor?: { name?: string } }).constructor?.name ?? typeof val;
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected ${Ctor.name}(${field.length}), got ${got}`,
          );
        }
        const len = (val as { length: number }).length;
        if (len !== field.length) {
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected length ${field.length}, got ${len}`,
          );
        }
      } else {
        const expected = kindTsType(field.kind);
        if (typeof val !== expected) {
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected ${expected}, got ${typeof val}`,
          );
        }
      }
    }
  }
}
