;; webgpu-audio-bridge — WASM consumer decoder, Track 2 scaffolding cut (0.7.5).
;;
;; This is the SMOKE-TEST shape of the WASM consumer for the AudioWorklet
;; fast path described in the King roadmap (Track 2). It exists to prove
;; three things in one tiny module:
;;
;;   (1) The build pipeline compiles WAT → WASM via wabt with both the
;;       SIMD and threads (atomics) feature flags enabled. Subsequent
;;       patches will introduce f64x2 / f32x4 SIMD intrinsics and the
;;       acquire/release barriers around the SPSC counters; getting the
;;       toolchain right ONCE here makes all later patches additive.
;;
;;   (2) A shared `WebAssembly.Memory` created on the host can be
;;       imported into the module and read by WASM-side atomic ops. The
;;       module's view of byte 0..7 (the SAB header's write_index and
;;       read_index lanes) must agree bit-for-bit with what JS-side
;;       `Atomics.load(int32View, lane)` returns for the same SAB. That
;;       cross-language atomic agreement is the bedrock for everything
;;       Track 2 builds on top.
;;
;;   (3) The host can hand the WASM module enough Memory to host the
;;       full Bridge SAB (header + payload slots) without any internal
;;       allocation. The module declares the memory as an IMPORT with
;;       `shared`, so the host owns the lifetime; the only constraint
;;       on the module side is the page count must equal what the
;;       caller created.
;;
;; ─── Why the page bounds are 1..16384 ───────────────────────────────────
;;
;; WebAssembly pages are 64 KiB each. The widest realistic Bridge today
;; carries ~1 MiB of payload (capacity=16 × frameSize ≤ 64 KiB per slot),
;; comfortably under 16 pages (1 MiB). The upper bound 16384 (1 GiB)
;; matches the WebAssembly spec maximum for shared memory and gives
;; future schemas (large block-mode frames in Track 3, multi-channel
;; WebNN tensors in Track 5) headroom without a module rebuild.
;;
;; The host instantiates with `new WebAssembly.Memory({ initial: N,
;; maximum: N, shared: true })` where N = ceil(byteLength / 65536).
;; The module's `1..16384` bounds let the host pick any value in range.
;;
;; ─── Atomic ops used ────────────────────────────────────────────────────
;;
;; `i32.atomic.load` is the WASM-spec acquire-ordered 32-bit load. It is
;; the direct counterpart of JS `Atomics.load(int32Array, k)` — both emit
;; the same underlying hardware barrier (LOAD-ACQUIRE on ARM, plain
;; aligned load on x86 with the spec's release-on-store discipline doing
;; the heavy lifting on the producer side). The two languages reading
;; the same SAB through the same memory model are guaranteed to see the
;; same value on any spec-compliant implementation.

(module
  ;; Shared-memory import. Host side: `new WebAssembly.Memory({ initial: N,
  ;; maximum: N, shared: true })`. Page count window matches the WebAssembly
  ;; spec max for shared memory (1 GiB). The `shared` flag is what gates
  ;; the atomic ops below — without it, `i32.atomic.load` traps.
  (import "env" "memory" (memory 1 16384 shared))

  ;; ─── SAB header readback ──────────────────────────────────────────────
  ;;
  ;; The Bridge's 32-byte SAB header lays out 8 Int32 lanes (see
  ;; src/SpscRing.ts for the canonical map): lane 0 = write_index,
  ;; lane 1 = read_index, lane 2 = flow_scale, lane 3 = torn_frame_counter,
  ;; lanes 4-7 = PLL state (offset_lo, offset_hi, drift, status).
  ;;
  ;; These two functions cover lanes 0 and 1 — the SPSC counters. They
  ;; are the only lanes the smoke test uses; subsequent patches will add
  ;; lane-aware accessors for the rest as the full pullLatest protocol
  ;; gets ported.

  ;; Read the producer's write_index (lane 0, byte offset 0). Acquire load.
  (func $read_write_index (export "read_write_index") (result i32)
    i32.const 0
    i32.atomic.load)

  ;; Read the consumer's read_index (lane 1, byte offset 4). Acquire load.
  (func $read_read_index (export "read_read_index") (result i32)
    i32.const 4
    i32.atomic.load)

  ;; ─── SPSC pull dance (0.7.6) ──────────────────────────────────────────
  ;;
  ;; The full pullLatest contract over the Bridge's SAB header is a
  ;; three-step dance:
  ;;
  ;;   (a) acquire-load writeIdx and plain-read readIdx, decide which
  ;;       slot to read (and whether the ring has anything to read at all)
  ;;   (b) read the payload bytes for that slot
  ;;   (c) release-store the advanced read_index and notify the producer
  ;;
  ;; Step (b) is the schema-driven decode — the JS Bridge owns the typed-
  ;; array umbrella views (`new Float64Array(sab, 32, …)` etc.) that
  ;; project the payload bytes into typed reads. Subsequent patches in
  ;; the Track 2 cohort will port (b) into WASM one decode kind at a
  ;; time (scalar → array → SIMD trajectory); this patch ports just (a)
  ;; and (c). The JS caller does (b) using its existing JS-side views.
  ;;
  ;; The PEEK/COMMIT split preserves the load-bearing SPSC invariant
  ;; that the producer cannot overwrite a slot until the consumer
  ;; releases its read on it. Specifically:
  ;;
  ;;     peek_pull_latest(mask) → slot OR -1
  ;;       Reads writeIdx (acquire) + readIdx, stores writeIdx into a
  ;;       module-scoped global so the matching commit_pull_latest knows
  ;;       what to release to. Returns the slot index of the newest
  ;;       frame, or -1 if the ring is empty. NO mutation of read_index.
  ;;
  ;;     commit_pull_latest()
  ;;       Release-stores read_index ← saved writeIdx, then notifies the
  ;;       producer. Caller MUST have read the slot bytes between the
  ;;       matching peek and this commit, OR be okay with discarding
  ;;       the frame (e.g., the inner loop's drain-only sweep).
  ;;
  ;; The FIFO `pull` flavor (peek_pull / commit_pull) is the same shape
  ;; but advances read_index by 1 rather than to writeIdx.
  ;;
  ;; WASM globals are per-instance — each instantiateConsumer() call
  ;; creates a fresh WebAssembly.Instance with its own globals, so two
  ;; consumers over two different Bridges never share state.
  ;;
  ;; Memory ordering (matches the JS Bridge contract bit-for-bit):
  ;;   - peek's writeIdx load is acquire-ordered (i32.atomic.load), so
  ;;     the producer's prior release-store on writeIdx happens-before
  ;;     the slot read that follows on the JS side.
  ;;   - commit's read_index store is release-ordered (i32.atomic.store),
  ;;     so any consumer-side reads happen-before any subsequent
  ;;     producer overwrite of the freed slot.
  ;;   - The notify (memory.atomic.notify) wakes a producer parked on
  ;;     the read_index lane via Atomics.wait; matches the JS Bridge's
  ;;     unconditional always-notify protocol (cheap when no waiter,
  ;;     correct when there is one).

  ;; Module-scoped state holding the writeIdx (or readIdx+1) observed by
  ;; the most recent peek call. The matching commit reads this back and
  ;; release-stores it into the read_index lane. Init to 0; safe because
  ;; commit's release-store on lane 1 just overwrites whatever was there
  ;; (the producer never reads our pending value).
  (global $pendingNewReadIdx (mut i32) (i32.const 0))

  ;; Module-scoped state holding the readIdx observed at the matching
  ;; peek call (the value the CAS commit uses as its "expected" arg).
  ;; Used only by commit_pull_cas / commit_pull_latest_cas (0.7.12); the
  ;; non-CAS release-store commits ignore it. Set on every peek
  ;; (cheap — one i32 store) so the CAS variant works without needing
  ;; a separate peek_cas family. Init to 0 — same safe-default rationale
  ;; as $pendingNewReadIdx (a no-prior-peek commit is a no-op CAS that
  ;; either matches the lane's 0 once at SAB allocation or fails
  ;; gracefully on every later attempt).
  (global $pendingCapturedReadIdx (mut i32) (i32.const 0))

  ;; pullLatest peek: latest-frame drain with skip semantics.
  ;; Param:  $mask = capacity − 1 (power-of-two ring; computed JS-side once).
  ;; Returns: slot index (≥ 0) of the newest available frame, or -1 if empty.
  ;; Side effect: saves the observed writeIdx into $pendingNewReadIdx so
  ;;              commit_pull_latest knows what to release.
  (func $peek_pull_latest (export "peek_pull_latest") (param $mask i32) (result i32)
    (local $writeIdx i32)
    (local $readIdx i32)
    ;; readIdx: lane 1. Under non-CAS commits this is a plain read (single-
    ;; consumer guarantee — only the consumer writes this lane); under
    ;; CAS commits (drop-oldest, 0.7.12) the producer may have advanced it
    ;; between this peek and our commit, which is the race CAS detects.
    ;; Either way the value here is the captured "expected" for the CAS.
    i32.const 4
    i32.load
    local.set $readIdx
    ;; writeIdx: acquire load of lane 0.
    i32.const 0
    i32.atomic.load
    local.set $writeIdx
    ;; Save the observed readIdx for both possible matching commits:
    ;;   - non-CAS commit_pull_latest uses the release-store path; the
    ;;     captured value is ignored there.
    ;;   - CAS commit_pull_latest_cas uses it as the expected arg.
    local.get $readIdx
    global.set $pendingCapturedReadIdx
    ;; Safe-default the commit target to the CURRENT readIdx so that
    ;; commit-after-empty-peek (and commit-without-any-prior-peek)
    ;; is a true no-op rather than rewinding the lane. The non-empty
    ;; branch below overwrites with writeIdx — the value we actually
    ;; want to release to.
    local.get $readIdx
    global.set $pendingNewReadIdx
    ;; Empty if writeIdx === readIdx. i32 equality is wrap-correct
    ;; regardless of signed-ness because the producer never wraps a full
    ;; 2^32 between consumer observations under the capacity ≤ 2^30 bound.
    local.get $writeIdx
    local.get $readIdx
    i32.eq
    if (result i32)
      i32.const -1
    else
      ;; Save the writeIdx so commit knows where to advance read_index.
      local.get $writeIdx
      global.set $pendingNewReadIdx
      ;; Return slot = (writeIdx − 1) & mask. Power-of-two mask makes the
      ;; modular arithmetic wrap-invisible.
      local.get $writeIdx
      i32.const 1
      i32.sub
      local.get $mask
      i32.and
    end)

  ;; pullLatest commit: release-store read_index ← saved writeIdx; notify.
  ;; Must be called AFTER the matching peek_pull_latest returned a
  ;; non-negative slot AND the caller has finished reading the slot
  ;; bytes. Safe to call after a peek that returned -1 (no-op semantics:
  ;; the saved value still equals the previous read_index so the store
  ;; is idempotent).
  (func $commit_pull_latest (export "commit_pull_latest")
    ;; Release-store lane 1 = saved writeIdx
    i32.const 4
    global.get $pendingNewReadIdx
    i32.atomic.store
    ;; Notify ≤ 1 waiting producer parked on lane 1 via Atomics.wait.
    ;; Drop the notification count return — caller never needs it.
    i32.const 4
    i32.const 1
    memory.atomic.notify
    drop)

  ;; FIFO pull peek: oldest-frame drain (no skip).
  ;; Param:  $mask = capacity − 1.
  ;; Returns: slot index (≥ 0) of the oldest unread frame, or -1 if empty.
  ;; Side effect: saves (readIdx + 1) into $pendingNewReadIdx so the
  ;;              matching commit advances read_index by exactly one.
  (func $peek_pull (export "peek_pull") (param $mask i32) (result i32)
    (local $writeIdx i32)
    (local $readIdx i32)
    i32.const 4
    i32.load
    local.set $readIdx
    i32.const 0
    i32.atomic.load
    local.set $writeIdx
    ;; Save observed readIdx as CAS-expected for commit_pull_cas (0.7.12).
    ;; Non-CAS commit_pull ignores it.
    local.get $readIdx
    global.set $pendingCapturedReadIdx
    ;; Safe-default: same discipline as peek_pull_latest — point the
    ;; pending commit at the current readIdx so an empty-peek commit
    ;; is a no-op store.
    local.get $readIdx
    global.set $pendingNewReadIdx
    local.get $writeIdx
    local.get $readIdx
    i32.eq
    if (result i32)
      i32.const -1
    else
      ;; Save readIdx + 1 for commit.
      local.get $readIdx
      i32.const 1
      i32.add
      global.set $pendingNewReadIdx
      ;; Return slot = readIdx & mask
      local.get $readIdx
      local.get $mask
      i32.and
    end)

  ;; FIFO pull commit: release-store read_index ← (saved readIdx + 1); notify.
  ;; Same protocol shape as commit_pull_latest; the difference is which
  ;; value was saved.
  (func $commit_pull (export "commit_pull")
    i32.const 4
    global.get $pendingNewReadIdx
    i32.atomic.store
    i32.const 4
    i32.const 1
    memory.atomic.notify
    drop)

  ;; ─── CAS-aware drop-oldest commits (0.7.12) ───────────────────────────
  ;;
  ;; When the JS Bridge runs `policy: 'drop-oldest'` (0.6.12; race-free
  ;; since 0.7.2), the producer is allowed to OVERWRITE older slots
  ;; without waiting for the consumer to release them — and to advance
  ;; read_index past the freed slot itself. That breaks the SPSC
  ;; invariant the plain release-store commits rely on: when the
  ;; consumer commits, the producer may have already moved read_index,
  ;; and the slot bytes the consumer just read may have been torn by a
  ;; mid-read overwrite.
  ;;
  ;; The fix (mirrors `_pullOverrunAware` / `_pullLatestOverrunAware`
  ;; in src/SpscRing.ts): the commit becomes a compare-and-exchange
  ;; against the readIdx the matching peek observed. If the CAS
  ;; succeeds, the consumer's read happened atomically before any
  ;; producer overrun and the slot bytes are intact. If the CAS fails,
  ;; the slot bytes are suspect and the caller must retry the whole
  ;; peek → read → commit cycle with a fresh snapshot.
  ;;
  ;; Returns i32 boolean (1 = success, 0 = race detected → retry).
  ;; Success branch ALSO performs the producer notify (matches the
  ;; JS path's notify-only-on-success discipline). Failure branch
  ;; skips notify — there's no progress to announce, and the next
  ;; successful commit will notify in its place.
  ;;
  ;; Memory ordering: i32.atomic.rmw.cmpxchg has acquire-release
  ;; semantics on both branches (whether the swap occurs or not).
  ;; That matches Atomics.compareExchange on every spec-compliant
  ;; engine, so the cross-language equivalence is bit-for-bit on the
  ;; observable side as well.
  ;;
  ;; Captured-readIdx state is shared with the non-CAS commits via
  ;; the $pendingCapturedReadIdx global set in both peeks. No new
  ;; peek_cas family — the caller's choice between CAS / non-CAS
  ;; happens entirely at commit time, matching the JS dispatcher's
  ;; `if (this._needsOverrunAware)` branch.

  ;; pullLatest CAS commit.
  ;; CAS lane 1: expected = $pendingCapturedReadIdx (from peek),
  ;;             desired  = $pendingNewReadIdx (writeIdx from peek).
  ;; Returns 1 on success (+ notify), 0 on race (caller retries).
  (func $commit_pull_latest_cas (export "commit_pull_latest_cas") (result i32)
    (local $prev i32)
    i32.const 4
    global.get $pendingCapturedReadIdx
    global.get $pendingNewReadIdx
    i32.atomic.rmw.cmpxchg
    local.set $prev
    local.get $prev
    global.get $pendingCapturedReadIdx
    i32.eq
    if (result i32)
      ;; Success — notify a waiting producer, return 1.
      i32.const 4
      i32.const 1
      memory.atomic.notify
      drop
      i32.const 1
    else
      ;; Race detected — caller must re-peek + retry. No notify (no
      ;; progress to announce). Return 0.
      i32.const 0
    end)

  ;; FIFO pull CAS commit. Same shape as commit_pull_latest_cas; the
  ;; difference is what $pendingNewReadIdx holds (readIdx+1 from
  ;; peek_pull vs writeIdx from peek_pull_latest).
  (func $commit_pull_cas (export "commit_pull_cas") (result i32)
    (local $prev i32)
    i32.const 4
    global.get $pendingCapturedReadIdx
    global.get $pendingNewReadIdx
    i32.atomic.rmw.cmpxchg
    local.set $prev
    local.get $prev
    global.get $pendingCapturedReadIdx
    i32.eq
    if (result i32)
      i32.const 4
      i32.const 1
      memory.atomic.notify
      drop
      i32.const 1
    else
      i32.const 0
    end)

  ;; ─── Scalar field decoders (0.7.7) ────────────────────────────────────
  ;;
  ;; One reader per FieldKind in the schema DSL. Each takes the absolute
  ;; byte offset within WASM memory (= within the SAB) and returns the
  ;; typed value via the corresponding WebAssembly load instruction.
  ;; Caller-side math: `byteOffset = RING_HEADER_BYTES + slot * frameByteSize
  ;; + field.byteOffset` (the JS shim wraps this so callers pass the
  ;; pre-resolved offset list).
  ;;
  ;; All loads use `align=1` to accept arbitrary field alignment without
  ;; trapping — the Bridge's schema-compile packs fields tightly and
  ;; does not pad to natural type alignment, so a u64 field can land on
  ;; any 4-byte boundary (or worse). align=1 costs ~one cycle on x86
  ;; for misaligned cases and is wire-correct on every spec-compliant
  ;; runtime.
  ;;
  ;; Endianness: WebAssembly loads are little-endian by spec, matching
  ;; the JS Bridge's umbrella TypedArray views (also LE on every
  ;; current platform). The two surfaces produce bit-identical reads.
  ;;
  ;; Signedness: WAT i32/i64 are bit patterns. The shim splits signed
  ;; vs unsigned at the JS boundary:
  ;;   - read_i32 returns Number (signed interpretation as-is)
  ;;   - read_u32: shim applies `value >>> 0` to recover unsigned
  ;;   - read_i64 returns BigInt (signed)
  ;;   - read_u64: shim applies BigInt.asUintN(64, value) for unsigned
  ;; The narrower integer kinds use the WAT instructions' built-in
  ;; sign-extension flavor (load8_s / load8_u / load16_s / load16_u)
  ;; so the result is already the right sign at the JS boundary.

  (func $read_f64 (export "read_f64") (param $off i32) (result f64)
    local.get $off
    f64.load align=1)

  (func $read_f32 (export "read_f32") (param $off i32) (result f32)
    local.get $off
    f32.load align=1)

  ;; 64-bit integer load — signed/unsigned interpretation happens in JS.
  ;; Same WAT instruction backs read_i64 and read_u64.
  (func $read_i64 (export "read_i64") (param $off i32) (result i64)
    local.get $off
    i64.load align=1)

  (func $read_u64 (export "read_u64") (param $off i32) (result i64)
    local.get $off
    i64.load align=1)

  ;; 32-bit integer load — same instruction for signed/unsigned.
  (func $read_i32 (export "read_i32") (param $off i32) (result i32)
    local.get $off
    i32.load align=1)

  (func $read_u32 (export "read_u32") (param $off i32) (result i32)
    local.get $off
    i32.load align=1)

  ;; 16-bit integer load — separate instructions per signedness so the
  ;; sign-extension happens in WAT (cheaper than a JS-side mask + shift).
  (func $read_i16 (export "read_i16") (param $off i32) (result i32)
    local.get $off
    i32.load16_s align=1)

  (func $read_u16 (export "read_u16") (param $off i32) (result i32)
    local.get $off
    i32.load16_u align=1)

  ;; 8-bit integer load.
  (func $read_i8 (export "read_i8") (param $off i32) (result i32)
    local.get $off
    i32.load8_s)

  (func $read_u8 (export "read_u8") (param $off i32) (result i32)
    local.get $off
    i32.load8_u)

  ;; ─── Array bulk copy (0.7.8) ──────────────────────────────────────────
  ;;
  ;; The schema DSL's array fields (f64Array, f32Array, integer arrays)
  ;; are stored contiguously inside a slot's payload region. The JS
  ;; Bridge's `pull` decodes them via TypedArray umbrella views and a
  ;; `frame.fieldName.set(arrayView[slot])` bulk copy — fast on x86 and
  ;; ARM, but still a JS hot-path operation that pays the umbrella-
  ;; lookup tax + the per-call function-call overhead.
  ;;
  ;; This single `copy_array` export does the equivalent bulk copy
  ;; inside WASM via `memory.copy` (bulk-memory proposal — already
  ;; enabled in the build). The caller passes:
  ;;
  ;;   srcOff:    absolute byte offset of the array's start within the
  ;;              slot (= header_bytes + slot * frame_bytes + field.byteOffset)
  ;;   dstOff:    absolute byte offset of the destination region within
  ;;              the same WebAssembly.Memory. The shim's `allocate-
  ;;              WorkletMemory({ sabBytes, scratchBytes })` reserves a
  ;;              region above the SAB ring for exactly this use; the
  ;;              JS caller can also wire its own destination anywhere
  ;;              in the Memory it owns.
  ;;   byteCount: array.length * elementByteSize. The shim caller
  ;;              precomputes this once per field at setup time.
  ;;
  ;; The Memory.copy operand order is (dst, src, len) per the WASM
  ;; spec; we accept (src, dst, byteCount) at the export level for
  ;; readability and swap inside.
  ;;
  ;; Endianness: byte-level copy — no endianness involved. The
  ;; destination region's typed-array view (created JS-side) interprets
  ;; the bytes in the platform's native endianness, matching the SAB
  ;; ring's discipline.
  ;;
  ;; Overlap: `memory.copy` is well-defined for overlapping ranges per
  ;; spec — same semantics as memmove (handles forward/backward overlap
  ;; correctly). The shim's allocated scratch region never overlaps the
  ;; SAB ring (it lives in pages above), so the overlap case is moot in
  ;; the canonical wiring; documented here for callers who DIY the
  ;; destination layout.
  (func $copy_array (export "copy_array")
        (param $srcOff i32) (param $dstOff i32) (param $byteCount i32)
    local.get $dstOff
    local.get $srcOff
    local.get $byteCount
    memory.copy)

  ;; ─── f64 trajectory evaluators (0.7.9) ────────────────────────────────
  ;;
  ;; Schema layout for `f64TrajectoryArray(n, { order })`:
  ;;
  ;;     order=1:  flat = [p_0, p_1, …, p_{n-1}]
  ;;     order=2:  flat = [p_0, v_0, p_1, v_1, …]
  ;;     order=3:  flat = [p_0, v_0, a_0, p_1, v_1, a_1, …]
  ;;
  ;; The evaluator reconstructs n scalar position samples at elapsed
  ;; time `dt`. For order=1 this is bit-exact copy (positions only —
  ;; no extrapolation possible); for order=2 it is the linear Taylor
  ;; `p + v·dt`; for order=3 it is the quadratic Taylor
  ;; `p + v·dt + ½·a·dt²`. Bit-identical to
  ;; `evaluateTrajectoryInto` in src/trajectory.ts (no clamps — the
  ;; clamped path lives JS-side until a future patch ports the clamp
  ;; resolution logic into WASM too).
  ;;
  ;; All loads use `align=1` to tolerate the interleaved layout's
  ;; non-natural alignment (vEff fields can land on any 4-byte
  ;; boundary depending on what precedes them in the schema).

  ;; Order=1: position-only. Output bytes are bit-identical to the
  ;; input bytes, so this is a memory.copy of n × 8 bytes. The dt
  ;; argument is accepted for signature consistency with the other
  ;; orders but ignored — matches the JS evaluator's `case 1` arm.
  (func $eval_taylor_f64_o1 (export "eval_taylor_f64_o1")
        (param $srcOff i32) (param $dstOff i32) (param $n i32)
    local.get $dstOff
    local.get $srcOff
    local.get $n
    i32.const 3
    i32.shl                    ;; n << 3 = n * 8 (f64 bytes)
    memory.copy)

  ;; Order=2: linear Taylor. Per sample i, out[i] = flat[2i] + flat[2i+1] * dt.
  ;; Scalar f64 loop; SIMD vectorization is deferred to 0.7.10 (where
  ;; the f32 mirrors land too and the f64x2 deinterleave shuffles
  ;; can be authored in a single self-contained section).
  (func $eval_taylor_f64_o2 (export "eval_taylor_f64_o2")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
    (local $i i32)
    (local $srcEnd i32)
    (local $dstP i32)
    (local $srcP i32)
    local.get $srcOff
    local.set $srcP
    local.get $dstOff
    local.set $dstP
    ;; srcEnd = srcOff + n * 16  (two f64s per sample)
    local.get $srcOff
    local.get $n
    i32.const 4
    i32.shl                    ;; n << 4 = n * 16
    i32.add
    local.set $srcEnd
    block $exit
      loop $loop
        ;; if srcP >= srcEnd → exit
        local.get $srcP
        local.get $srcEnd
        i32.ge_u
        br_if $exit
        ;; out[i] = flat[2i] + flat[2i+1] * dt
        local.get $dstP
        local.get $srcP
        f64.load align=1            ;; p_i
        local.get $srcP
        i32.const 8
        i32.add
        f64.load align=1            ;; v_i
        local.get $dt
        f64.mul
        f64.add
        f64.store align=1
        ;; advance pointers
        local.get $srcP
        i32.const 16
        i32.add
        local.set $srcP
        local.get $dstP
        i32.const 8
        i32.add
        local.set $dstP
        br $loop
      end
    end)

  ;; Order=3: quadratic Taylor. Per sample i,
  ;;   out[i] = flat[3i] + flat[3i+1] * dt + flat[3i+2] * (0.5 * dt²).
  ;; Caller-cached halfDt2 = 0.5 * dt * dt would save one multiply per
  ;; call but force a wider WASM signature; the per-call savings of
  ;; computing it inside the loop preamble (once, not per sample) is
  ;; identical to what the JS evaluator does and keeps the export
  ;; signature compact.
  (func $eval_taylor_f64_o3 (export "eval_taylor_f64_o3")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
    (local $srcEnd i32)
    (local $dstP i32)
    (local $srcP i32)
    (local $halfDt2 f64)
    ;; halfDt2 = 0.5 * dt * dt — computed once per call.
    local.get $dt
    local.get $dt
    f64.mul
    f64.const 0.5
    f64.mul
    local.set $halfDt2
    local.get $srcOff
    local.set $srcP
    local.get $dstOff
    local.set $dstP
    ;; srcEnd = srcOff + n * 24  (three f64s per sample)
    local.get $srcOff
    local.get $n
    i32.const 8
    i32.mul                    ;; n * 8 ...
    i32.const 3
    i32.mul                    ;; ... * 3 = n * 24
    i32.add
    local.set $srcEnd
    block $exit
      loop $loop
        local.get $srcP
        local.get $srcEnd
        i32.ge_u
        br_if $exit
        ;; out[i] = p + v*dt + a*halfDt2
        local.get $dstP
        local.get $srcP
        f64.load align=1            ;; p
        local.get $srcP
        i32.const 8
        i32.add
        f64.load align=1            ;; v
        local.get $dt
        f64.mul
        f64.add
        local.get $srcP
        i32.const 16
        i32.add
        f64.load align=1            ;; a
        local.get $halfDt2
        f64.mul
        f64.add
        f64.store align=1
        local.get $srcP
        i32.const 24
        i32.add
        local.set $srcP
        local.get $dstP
        i32.const 8
        i32.add
        local.set $dstP
        br $loop
      end
    end)

  ;; ─── f64 Hermite evaluator (0.7.9) ────────────────────────────────────
  ;;
  ;; Two-frame C¹ cubic Hermite reconstruction matching the JS
  ;; `evaluateHermiteTrajectoryInto` (src/trajectory.ts, 0.7.4). Per
  ;; sample i with stride = order (= 2 or 3):
  ;;
  ;;     P_0 = prev[stride·i]
  ;;     M_0 = prev[stride·i + 1]
  ;;     P_1 = curr[stride·i]
  ;;     M_1 = curr[stride·i + 1]
  ;;     out[i] = h00·P_0 + h10s·M_0 + h01·P_1 + h11s·M_1
  ;;
  ;; Where (h00, h10s, h01, h11s) are the cubic-Hermite basis
  ;; coefficients (h10s and h11s already include the segmentSeconds
  ;; tangent scaling — caller-side math, computed ONCE per call rather
  ;; than once per sample). The stride parameter accommodates order=2
  ;; vs order=3; the WAT doesn't need order, just the stride.
  ;;
  ;; Acceleration lane is ignored on the cubic path (matches the JS
  ;; cubic Hermite — a future quintic variant could consume it).

  (func $eval_hermite_f64 (export "eval_hermite_f64")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32)
        (param $n i32) (param $strideElems i32)
        (param $h00 f64) (param $h10s f64) (param $h01 f64) (param $h11s f64)
    (local $i i32)
    (local $prevP i32)
    (local $currP i32)
    (local $dstP i32)
    (local $strideBytes i32)
    ;; strideBytes = strideElems * 8
    local.get $strideElems
    i32.const 3
    i32.shl
    local.set $strideBytes
    local.get $prevOff
    local.set $prevP
    local.get $currOff
    local.set $currP
    local.get $dstOff
    local.set $dstP
    i32.const 0
    local.set $i
    block $exit
      loop $loop
        local.get $i
        local.get $n
        i32.ge_u
        br_if $exit
        ;; out[i] = h00*P0 + h10s*M0 + h01*P1 + h11s*M1
        local.get $dstP
        ;; h00 * P0
        local.get $prevP
        f64.load align=1
        local.get $h00
        f64.mul
        ;; + h10s * M0
        local.get $prevP
        i32.const 8
        i32.add
        f64.load align=1
        local.get $h10s
        f64.mul
        f64.add
        ;; + h01 * P1
        local.get $currP
        f64.load align=1
        local.get $h01
        f64.mul
        f64.add
        ;; + h11s * M1
        local.get $currP
        i32.const 8
        i32.add
        f64.load align=1
        local.get $h11s
        f64.mul
        f64.add
        f64.store align=1
        ;; advance pointers
        local.get $prevP
        local.get $strideBytes
        i32.add
        local.set $prevP
        local.get $currP
        local.get $strideBytes
        i32.add
        local.set $currP
        local.get $dstP
        i32.const 8
        i32.add
        local.set $dstP
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $loop
      end
    end)

  ;; ─── f32 trajectory evaluators (0.7.10) ───────────────────────────────
  ;;
  ;; Mirror of the f64 family above, with two changes per evaluator:
  ;;   - f32 loads/stores in place of f64 (4-byte stride per element)
  ;;   - dt and Hermite basis coefficients are f64 in the WAT signature
  ;;     even though the per-sample math is f32; we demote them via
  ;;     `f32.demote_f64` at the call site so the JS caller can pass a
  ;;     plain Number and the WAT does the truncation. Matches the JS
  ;;     evaluator's behavior of accepting a Number `dt` and writing
  ;;     into a Float32Array (which truncates per-store).
  ;;
  ;; The interleaved layouts are identical to the f64 versions just
  ;; with 4-byte instead of 8-byte strides.

  (func $eval_taylor_f32_o1 (export "eval_taylor_f32_o1")
        (param $srcOff i32) (param $dstOff i32) (param $n i32)
    local.get $dstOff
    local.get $srcOff
    local.get $n
    i32.const 2
    i32.shl                    ;; n << 2 = n * 4 (f32 bytes)
    memory.copy)

  (func $eval_taylor_f32_o2 (export "eval_taylor_f32_o2")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
    (local $srcEnd i32)
    (local $dstP i32)
    (local $srcP i32)
    ;; The per-sample math runs in f64 (matching the JS evaluator: a
    ;; Float32Array read promotes the element to a Number = f64; the
    ;; expression `flat[j] + flat[j+1] * dt` is all f64 arithmetic; the
    ;; demote to f32 only happens on the Float32Array store). Doing the
    ;; math in f32 instead would introduce 0.5-ULP differences against
    ;; JS — visible on order=3 terms where the quadratic accumulates.
    ;; The SIMD f32x4 path is constrained to f32 math (no per-lane
    ;; widen), so SIMD-vs-scalar bit-exact equality does NOT hold; the
    ;; SIMD pin uses an epsilon tolerance.
    local.get $srcOff
    local.set $srcP
    local.get $dstOff
    local.set $dstP
    local.get $srcOff
    local.get $n
    i32.const 3
    i32.shl                    ;; n * 8 (two f32 per sample)
    i32.add
    local.set $srcEnd
    block $exit
      loop $loop
        local.get $srcP
        local.get $srcEnd
        i32.ge_u
        br_if $exit
        local.get $dstP
        local.get $srcP
        f32.load align=1            ;; p (f32)
        f64.promote_f32             ;; → f64
        local.get $srcP
        i32.const 4
        i32.add
        f32.load align=1            ;; v (f32)
        f64.promote_f32             ;; → f64
        local.get $dt               ;; dt (already f64)
        f64.mul
        f64.add                     ;; p + v*dt (f64)
        f32.demote_f64              ;; truncate to f32 for store
        f32.store align=1
        local.get $srcP
        i32.const 8
        i32.add
        local.set $srcP
        local.get $dstP
        i32.const 4
        i32.add
        local.set $dstP
        br $loop
      end
    end)

  (func $eval_taylor_f32_o3 (export "eval_taylor_f32_o3")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
    (local $srcEnd i32)
    (local $dstP i32)
    (local $srcP i32)
    (local $halfDt2 f64)
    ;; halfDt2 = 0.5 * dt * dt in f64 — matches the JS evaluator which
    ;; computes it before the loop with all-Number arithmetic.
    local.get $dt
    local.get $dt
    f64.mul
    f64.const 0.5
    f64.mul
    local.set $halfDt2
    local.get $srcOff
    local.set $srcP
    local.get $dstOff
    local.set $dstP
    ;; srcEnd = srcOff + n * 12  (three f32 per sample)
    local.get $srcOff
    local.get $n
    i32.const 4
    i32.mul
    i32.const 3
    i32.mul
    i32.add
    local.set $srcEnd
    block $exit
      loop $loop
        local.get $srcP
        local.get $srcEnd
        i32.ge_u
        br_if $exit
        local.get $dstP
        ;; out = (((p + v*dt) + a*halfDt2)) demoted to f32
        local.get $srcP
        f32.load align=1            ;; p (f32)
        f64.promote_f32             ;; → f64
        local.get $srcP
        i32.const 4
        i32.add
        f32.load align=1            ;; v
        f64.promote_f32
        local.get $dt
        f64.mul
        f64.add                     ;; p + v*dt (f64)
        local.get $srcP
        i32.const 8
        i32.add
        f32.load align=1            ;; a
        f64.promote_f32
        local.get $halfDt2
        f64.mul
        f64.add                     ;; + a*halfDt2 (f64)
        f32.demote_f64              ;; → f32 for store
        f32.store align=1
        local.get $srcP
        i32.const 12
        i32.add
        local.set $srcP
        local.get $dstP
        i32.const 4
        i32.add
        local.set $dstP
        br $loop
      end
    end)

  (func $eval_hermite_f32 (export "eval_hermite_f32")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32)
        (param $n i32) (param $strideElems i32)
        (param $h00 f64) (param $h10s f64) (param $h01 f64) (param $h11s f64)
    (local $i i32)
    (local $prevP i32)
    (local $currP i32)
    (local $dstP i32)
    (local $strideBytes i32)
    ;; Math runs in f64 (matching the JS evaluator's Float32Array-read
    ;; → Number promotion → f64 arithmetic → Float32Array-store demote
    ;; semantics). Basis coefficients stay in f64 throughout.
    ;; strideBytes = strideElems * 4
    local.get $strideElems
    i32.const 2
    i32.shl
    local.set $strideBytes
    local.get $prevOff
    local.set $prevP
    local.get $currOff
    local.set $currP
    local.get $dstOff
    local.set $dstP
    i32.const 0
    local.set $i
    block $exit
      loop $loop
        local.get $i
        local.get $n
        i32.ge_u
        br_if $exit
        local.get $dstP
        ;; h00 * P0
        local.get $prevP
        f32.load align=1
        f64.promote_f32
        local.get $h00
        f64.mul
        ;; + h10s * M0
        local.get $prevP
        i32.const 4
        i32.add
        f32.load align=1
        f64.promote_f32
        local.get $h10s
        f64.mul
        f64.add
        ;; + h01 * P1
        local.get $currP
        f32.load align=1
        f64.promote_f32
        local.get $h01
        f64.mul
        f64.add
        ;; + h11s * M1
        local.get $currP
        i32.const 4
        i32.add
        f32.load align=1
        f64.promote_f32
        local.get $h11s
        f64.mul
        f64.add
        f32.demote_f64
        f32.store align=1
        local.get $prevP
        local.get $strideBytes
        i32.add
        local.set $prevP
        local.get $currP
        local.get $strideBytes
        i32.add
        local.set $currP
        local.get $dstP
        i32.const 4
        i32.add
        local.set $dstP
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $loop
      end
    end)

  ;; ─── f64 / f32 Quintic Hermite evaluators (0.9.82, C²) ────────────────
  ;;
  ;; Degree-5 reconstruction matching the JS evaluateQuinticHermiteTrajectoryInto
  ;; (src/trajectory.ts, 0.9.80). Per sample, stride = order (3 or 4 elems):
  ;;   out[i] = h0·P0 + h1s·V0 + h2s·A0 + h3·P1 + h4s·V1 + h5s·A1
  ;; (h1s,h2s,h4s,h5s already fold the segmentSeconds / segmentSeconds² tangent
  ;; + curvature scaling — computed caller-side ONCE per call, like the cubic
  ;; path). Acceleration is at lane offset 16 (f64) / 8 (f32). The jerk lane
  ;; (order=4) is ignored on the C² path. f64 accumulates left-to-right with no
  ;; implicit FMA → bit-exact to the scalar JS; f32 promotes each load to f64,
  ;; accumulates in f64, demotes on store (matches the JS Float32Array contract).

  (func $eval_quintic_hermite_f64 (export "eval_quintic_hermite_f64")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32)
        (param $n i32) (param $strideElems i32)
        (param $h0 f64) (param $h1s f64) (param $h2s f64)
        (param $h3 f64) (param $h4s f64) (param $h5s f64)
    (local $i i32) (local $prevP i32) (local $currP i32) (local $dstP i32) (local $strideBytes i32)
    local.get $strideElems
    i32.const 3
    i32.shl
    local.set $strideBytes
    local.get $prevOff local.set $prevP
    local.get $currOff local.set $currP
    local.get $dstOff local.set $dstP
    i32.const 0 local.set $i
    block $exit
      loop $loop
        local.get $i local.get $n i32.ge_u br_if $exit
        local.get $dstP
        local.get $prevP f64.load align=1 local.get $h0 f64.mul
        local.get $prevP i32.const 8 i32.add f64.load align=1 local.get $h1s f64.mul f64.add
        local.get $prevP i32.const 16 i32.add f64.load align=1 local.get $h2s f64.mul f64.add
        local.get $currP f64.load align=1 local.get $h3 f64.mul f64.add
        local.get $currP i32.const 8 i32.add f64.load align=1 local.get $h4s f64.mul f64.add
        local.get $currP i32.const 16 i32.add f64.load align=1 local.get $h5s f64.mul f64.add
        f64.store align=1
        local.get $prevP local.get $strideBytes i32.add local.set $prevP
        local.get $currP local.get $strideBytes i32.add local.set $currP
        local.get $dstP i32.const 8 i32.add local.set $dstP
        local.get $i i32.const 1 i32.add local.set $i
        br $loop
      end
    end)

  (func $eval_quintic_hermite_f32 (export "eval_quintic_hermite_f32")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32)
        (param $n i32) (param $strideElems i32)
        (param $h0 f64) (param $h1s f64) (param $h2s f64)
        (param $h3 f64) (param $h4s f64) (param $h5s f64)
    (local $i i32) (local $prevP i32) (local $currP i32) (local $dstP i32) (local $strideBytes i32)
    local.get $strideElems
    i32.const 2
    i32.shl
    local.set $strideBytes
    local.get $prevOff local.set $prevP
    local.get $currOff local.set $currP
    local.get $dstOff local.set $dstP
    i32.const 0 local.set $i
    block $exit
      loop $loop
        local.get $i local.get $n i32.ge_u br_if $exit
        local.get $dstP
        local.get $prevP f32.load align=1 f64.promote_f32 local.get $h0 f64.mul
        local.get $prevP i32.const 4 i32.add f32.load align=1 f64.promote_f32 local.get $h1s f64.mul f64.add
        local.get $prevP i32.const 8 i32.add f32.load align=1 f64.promote_f32 local.get $h2s f64.mul f64.add
        local.get $currP f32.load align=1 f64.promote_f32 local.get $h3 f64.mul f64.add
        local.get $currP i32.const 4 i32.add f32.load align=1 f64.promote_f32 local.get $h4s f64.mul f64.add
        local.get $currP i32.const 8 i32.add f32.load align=1 f64.promote_f32 local.get $h5s f64.mul f64.add
        f32.demote_f64
        f32.store align=1
        local.get $prevP local.get $strideBytes i32.add local.set $prevP
        local.get $currP local.get $strideBytes i32.add local.set $currP
        local.get $dstP i32.const 4 i32.add local.set $dstP
        local.get $i i32.const 1 i32.add local.set $i
        br $loop
      end
    end)

  ;; ─── f64 / f32 Septic Hermite evaluators (0.9.82, C³) ─────────────────
  ;;
  ;; Degree-7 reconstruction matching the JS evaluateSepticHermiteTrajectoryInto
  ;; (src/trajectory.ts, 0.9.81). stride = 4 elems (p, v, a, j). Per sample:
  ;;   out[i] = h0·P0 + h1s·V0 + h2s·A0 + h3s·J0 + h4·P1 + h5s·V1 + h6s·A1 + h7s·J1
  ;; (h1s/h2s/h3s/h5s/h6s/h7s fold the segmentSeconds / ² / ³ scaling caller-side).
  ;; Jerk is at lane offset 24 (f64) / 12 (f32). Same f64-accumulate / f32-promote
  ;; -demote discipline as the quintic path → bit-exact (f64) / within-ULP (f32).

  (func $eval_septic_hermite_f64 (export "eval_septic_hermite_f64")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32)
        (param $n i32) (param $strideElems i32)
        (param $h0 f64) (param $h1s f64) (param $h2s f64) (param $h3s f64)
        (param $h4 f64) (param $h5s f64) (param $h6s f64) (param $h7s f64)
    (local $i i32) (local $prevP i32) (local $currP i32) (local $dstP i32) (local $strideBytes i32)
    local.get $strideElems
    i32.const 3
    i32.shl
    local.set $strideBytes
    local.get $prevOff local.set $prevP
    local.get $currOff local.set $currP
    local.get $dstOff local.set $dstP
    i32.const 0 local.set $i
    block $exit
      loop $loop
        local.get $i local.get $n i32.ge_u br_if $exit
        local.get $dstP
        local.get $prevP f64.load align=1 local.get $h0 f64.mul
        local.get $prevP i32.const 8 i32.add f64.load align=1 local.get $h1s f64.mul f64.add
        local.get $prevP i32.const 16 i32.add f64.load align=1 local.get $h2s f64.mul f64.add
        local.get $prevP i32.const 24 i32.add f64.load align=1 local.get $h3s f64.mul f64.add
        local.get $currP f64.load align=1 local.get $h4 f64.mul f64.add
        local.get $currP i32.const 8 i32.add f64.load align=1 local.get $h5s f64.mul f64.add
        local.get $currP i32.const 16 i32.add f64.load align=1 local.get $h6s f64.mul f64.add
        local.get $currP i32.const 24 i32.add f64.load align=1 local.get $h7s f64.mul f64.add
        f64.store align=1
        local.get $prevP local.get $strideBytes i32.add local.set $prevP
        local.get $currP local.get $strideBytes i32.add local.set $currP
        local.get $dstP i32.const 8 i32.add local.set $dstP
        local.get $i i32.const 1 i32.add local.set $i
        br $loop
      end
    end)

  (func $eval_septic_hermite_f32 (export "eval_septic_hermite_f32")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32)
        (param $n i32) (param $strideElems i32)
        (param $h0 f64) (param $h1s f64) (param $h2s f64) (param $h3s f64)
        (param $h4 f64) (param $h5s f64) (param $h6s f64) (param $h7s f64)
    (local $i i32) (local $prevP i32) (local $currP i32) (local $dstP i32) (local $strideBytes i32)
    local.get $strideElems
    i32.const 2
    i32.shl
    local.set $strideBytes
    local.get $prevOff local.set $prevP
    local.get $currOff local.set $currP
    local.get $dstOff local.set $dstP
    i32.const 0 local.set $i
    block $exit
      loop $loop
        local.get $i local.get $n i32.ge_u br_if $exit
        local.get $dstP
        local.get $prevP f32.load align=1 f64.promote_f32 local.get $h0 f64.mul
        local.get $prevP i32.const 4 i32.add f32.load align=1 f64.promote_f32 local.get $h1s f64.mul f64.add
        local.get $prevP i32.const 8 i32.add f32.load align=1 f64.promote_f32 local.get $h2s f64.mul f64.add
        local.get $prevP i32.const 12 i32.add f32.load align=1 f64.promote_f32 local.get $h3s f64.mul f64.add
        local.get $currP f32.load align=1 f64.promote_f32 local.get $h4 f64.mul f64.add
        local.get $currP i32.const 4 i32.add f32.load align=1 f64.promote_f32 local.get $h5s f64.mul f64.add
        local.get $currP i32.const 8 i32.add f32.load align=1 f64.promote_f32 local.get $h6s f64.mul f64.add
        local.get $currP i32.const 12 i32.add f32.load align=1 f64.promote_f32 local.get $h7s f64.mul f64.add
        f32.demote_f64
        f32.store align=1
        local.get $prevP local.get $strideBytes i32.add local.set $prevP
        local.get $currP local.get $strideBytes i32.add local.set $currP
        local.get $dstP i32.const 4 i32.add local.set $dstP
        local.get $i i32.const 1 i32.add local.set $i
        br $loop
      end
    end)

  ;; ─── SIMD-vectorized order=2 Taylor evaluators (0.7.10) ───────────────
  ;;
  ;; The order=2 interleaved layout `[p_0, v_0, p_1, v_1, …]` is the
  ;; ONLY trajectory shape that vectorizes cleanly with the WebAssembly
  ;; SIMD ops — two consecutive v128 loads cover four output samples
  ;; (for f32) or two (for f64), an i8x16.shuffle pair deinterleaves
  ;; positions from velocities, and one fused multiply-add (mul +
  ;; add — WASM has no fma op, so two instructions) produces the
  ;; results which a single store writes out.
  ;;
  ;; Order=3 (24 bytes per sample for f64, 12 for f32) does not pack
  ;; into v128 multiples cleanly and the deinterleave cost dwarfs the
  ;; per-sample win; that path stays scalar in this patch and forever
  ;; unless a future SIMD generation introduces wider vectors.
  ;;
  ;; Both SIMD evaluators MUST produce bit-identical output to their
  ;; scalar counterparts. WebAssembly's spec disallows implicit FMA
  ;; in `f32x4.mul` + `f32x4.add` (matching scalar `f32.mul` + `f32.add`
  ;; semantics), so this holds by construction on any spec-compliant
  ;; runtime.
  ;;
  ;; Both evaluators handle the SIMD body + a scalar tail for the
  ;; trailing 0-3 (f32) or 0-1 (f64) samples that don't fill a final
  ;; vector iteration.

  ;; f32 order=2 SIMD: processes 4 samples per iteration.
  ;; Per SIMD step:
  ;;   v0 = v128.load(srcP + 0)   = [p_0, v_0, p_1, v_1]
  ;;   v1 = v128.load(srcP + 16)  = [p_2, v_2, p_3, v_3]
  ;;   positions  = shuffle(v0, v1, [0..3, 8..11, 16..19, 24..27])
  ;;              = [p_0, p_1, p_2, p_3]
  ;;   velocities = shuffle(v0, v1, [4..7, 12..15, 20..23, 28..31])
  ;;              = [v_0, v_1, v_2, v_3]
  ;;   result = f32x4.add(positions, f32x4.mul(velocities, dt_v))
  ;;   v128.store(dstP, result)
  (func $eval_taylor_f32_o2_simd (export "eval_taylor_f32_o2_simd")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
    (local $srcP i32)
    (local $dstP i32)
    (local $simdEnd i32)
    (local $tailEnd i32)
    (local $dt32 f32)
    (local $dtV v128)
    (local $v0 v128)
    (local $v1 v128)
    (local $positions v128)
    (local $velocities v128)
    local.get $dt
    f32.demote_f64
    local.set $dt32
    local.get $dt32
    f32x4.splat
    local.set $dtV
    local.get $srcOff
    local.set $srcP
    local.get $dstOff
    local.set $dstP
    ;; tailEnd = srcOff + n * 8 (total bytes of the trajectory's flat array)
    local.get $srcOff
    local.get $n
    i32.const 3
    i32.shl
    i32.add
    local.set $tailEnd
    ;; simdEnd = srcOff + (n & ~3) * 8   = srcOff + ((n >> 2) << 5)
    ;; — last byte of the last SIMD-processable chunk (4 samples = 32 bytes).
    local.get $srcOff
    local.get $n
    i32.const 2
    i32.shr_u
    i32.const 5
    i32.shl
    i32.add
    local.set $simdEnd
    ;; SIMD body
    block $simdExit
      loop $simdLoop
        local.get $srcP
        local.get $simdEnd
        i32.ge_u
        br_if $simdExit
        local.get $srcP
        v128.load align=1
        local.set $v0
        local.get $srcP
        i32.const 16
        i32.add
        v128.load align=1
        local.set $v1
        local.get $v0
        local.get $v1
        i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27
        local.set $positions
        local.get $v0
        local.get $v1
        i8x16.shuffle 4 5 6 7 12 13 14 15 20 21 22 23 28 29 30 31
        local.set $velocities
        local.get $dstP
        local.get $positions
        local.get $velocities
        local.get $dtV
        f32x4.mul
        f32x4.add
        v128.store align=1
        local.get $srcP
        i32.const 32
        i32.add
        local.set $srcP
        local.get $dstP
        i32.const 16
        i32.add
        local.set $dstP
        br $simdLoop
      end
    end
    ;; Scalar tail for the trailing 0..3 samples.
    block $tailExit
      loop $tailLoop
        local.get $srcP
        local.get $tailEnd
        i32.ge_u
        br_if $tailExit
        local.get $dstP
        local.get $srcP
        f32.load align=1
        local.get $srcP
        i32.const 4
        i32.add
        f32.load align=1
        local.get $dt32
        f32.mul
        f32.add
        f32.store align=1
        local.get $srcP
        i32.const 8
        i32.add
        local.set $srcP
        local.get $dstP
        i32.const 4
        i32.add
        local.set $dstP
        br $tailLoop
      end
    end)

  ;; f64 order=2 SIMD: processes 2 samples per iteration.
  ;; Per SIMD step:
  ;;   v0 = v128.load(srcP + 0)   = [p_0, v_0]
  ;;   v1 = v128.load(srcP + 16)  = [p_1, v_1]
  ;;   positions  = shuffle(v0, v1, [0..7, 16..23])  = [p_0, p_1]
  ;;   velocities = shuffle(v0, v1, [8..15, 24..31]) = [v_0, v_1]
  ;;   result = f64x2.add(positions, f64x2.mul(velocities, dt_v))
  ;;   v128.store(dstP, result)
  (func $eval_taylor_f64_o2_simd (export "eval_taylor_f64_o2_simd")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
    (local $srcP i32)
    (local $dstP i32)
    (local $simdEnd i32)
    (local $tailEnd i32)
    (local $dtV v128)
    (local $v0 v128)
    (local $v1 v128)
    (local $positions v128)
    (local $velocities v128)
    local.get $dt
    f64x2.splat
    local.set $dtV
    local.get $srcOff
    local.set $srcP
    local.get $dstOff
    local.set $dstP
    ;; tailEnd = srcOff + n * 16
    local.get $srcOff
    local.get $n
    i32.const 4
    i32.shl
    i32.add
    local.set $tailEnd
    ;; simdEnd = srcOff + (n & ~1) * 16  = srcOff + ((n >> 1) << 5)
    ;; — 2 samples per SIMD chunk = 32 bytes.
    local.get $srcOff
    local.get $n
    i32.const 1
    i32.shr_u
    i32.const 5
    i32.shl
    i32.add
    local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $srcP
        local.get $simdEnd
        i32.ge_u
        br_if $simdExit
        local.get $srcP
        v128.load align=1
        local.set $v0
        local.get $srcP
        i32.const 16
        i32.add
        v128.load align=1
        local.set $v1
        local.get $v0
        local.get $v1
        i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
        local.set $positions
        local.get $v0
        local.get $v1
        i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
        local.set $velocities
        local.get $dstP
        local.get $positions
        local.get $velocities
        local.get $dtV
        f64x2.mul
        f64x2.add
        v128.store align=1
        local.get $srcP
        i32.const 32
        i32.add
        local.set $srcP
        local.get $dstP
        i32.const 16
        i32.add
        local.set $dstP
        br $simdLoop
      end
    end
    ;; Scalar tail for the trailing 0..1 samples.
    block $tailExit
      loop $tailLoop
        local.get $srcP
        local.get $tailEnd
        i32.ge_u
        br_if $tailExit
        local.get $dstP
        local.get $srcP
        f64.load align=1
        local.get $srcP
        i32.const 8
        i32.add
        f64.load align=1
        local.get $dt
        f64.mul
        f64.add
        f64.store align=1
        local.get $srcP
        i32.const 16
        i32.add
        local.set $srcP
        local.get $dstP
        i32.const 8
        i32.add
        local.set $dstP
        br $tailLoop
      end
    end)

  ;; ─── f64 Hermite order=2 SIMD (0.9.79) ────────────────────────────────
  ;;
  ;; Vectorized cubic Hermite for stride-2 (order=2) trajectories: 2 samples
  ;; per iteration. The interleaved [p, v] deinterleave is identical to
  ;; `eval_taylor_f64_o2_simd` (same i8x16.shuffle masks), applied to BOTH
  ;; the prev and curr frames. The four basis coefficients (h00/h10s/h01/h11s,
  ;; segmentSeconds already folded into h10s/h11s by the caller) are splatted
  ;; to f64x2 once and reused across the loop.
  ;;
  ;; Accumulation is LEFT-TO-RIGHT — h00·P0 + h10s·M0 + h01·P1 + h11s·M1 —
  ;; matching the JS `evaluateHermiteTrajectoryInto` op order exactly. WASM
  ;; f64x2 mul/add are IEEE-754 with no implicit FMA, so each lane reproduces
  ;; the JS rounding step-for-step: this path is BIT-EXACT to the scalar
  ;; `eval_hermite_f64` and to JS. A scalar tail handles the trailing 0..1
  ;; sample (same op order). Order-3 hermite needs the stride-3 deinterleave
  ;; (a separate function) — this is stride-2 only.
  (func $eval_hermite_f64_o2_simd (export "eval_hermite_f64_o2_simd")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32)
        (param $n i32)
        (param $h00 f64) (param $h10s f64) (param $h01 f64) (param $h11s f64)
    (local $prevP i32)
    (local $currP i32)
    (local $dstP i32)
    (local $simdEnd i32)
    (local $tailEnd i32)
    (local $h00V v128)
    (local $h10sV v128)
    (local $h01V v128)
    (local $h11sV v128)
    (local $a0 v128)
    (local $a1 v128)
    (local $P0 v128)
    (local $M0 v128)
    (local $P1 v128)
    (local $M1 v128)
    local.get $h00 f64x2.splat local.set $h00V
    local.get $h10s f64x2.splat local.set $h10sV
    local.get $h01 f64x2.splat local.set $h01V
    local.get $h11s f64x2.splat local.set $h11sV
    local.get $prevOff local.set $prevP
    local.get $currOff local.set $currP
    local.get $dstOff local.set $dstP
    ;; tailEnd = prevOff + n*16  (stride-2 f64 = 16 bytes/sample)
    local.get $prevOff
    local.get $n
    i32.const 4
    i32.shl
    i32.add
    local.set $tailEnd
    ;; simdEnd = prevOff + (n>>1)*32  (2 samples = 32 bytes)
    local.get $prevOff
    local.get $n
    i32.const 1
    i32.shr_u
    i32.const 5
    i32.shl
    i32.add
    local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $prevP
        local.get $simdEnd
        i32.ge_u
        br_if $simdExit
        ;; prev: deinterleave [p,v,p,v] -> P0=[p_i,p_{i+1}], M0=[v_i,v_{i+1}]
        local.get $prevP
        v128.load align=1
        local.set $a0
        local.get $prevP
        i32.const 16
        i32.add
        v128.load align=1
        local.set $a1
        local.get $a0
        local.get $a1
        i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
        local.set $P0
        local.get $a0
        local.get $a1
        i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
        local.set $M0
        ;; curr: same deinterleave -> P1, M1
        local.get $currP
        v128.load align=1
        local.set $a0
        local.get $currP
        i32.const 16
        i32.add
        v128.load align=1
        local.set $a1
        local.get $a0
        local.get $a1
        i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
        local.set $P1
        local.get $a0
        local.get $a1
        i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
        local.set $M1
        ;; acc = ((h00*P0 + h10s*M0) + h01*P1) + h11s*M1   (left-to-right)
        local.get $dstP
        local.get $h00V
        local.get $P0
        f64x2.mul
        local.get $h10sV
        local.get $M0
        f64x2.mul
        f64x2.add
        local.get $h01V
        local.get $P1
        f64x2.mul
        f64x2.add
        local.get $h11sV
        local.get $M1
        f64x2.mul
        f64x2.add
        v128.store align=1
        local.get $prevP i32.const 32 i32.add local.set $prevP
        local.get $currP i32.const 32 i32.add local.set $currP
        local.get $dstP i32.const 16 i32.add local.set $dstP
        br $simdLoop
      end
    end
    ;; Scalar tail (0..1 sample) — same left-to-right f64 op order.
    block $tailExit
      loop $tailLoop
        local.get $prevP
        local.get $tailEnd
        i32.ge_u
        br_if $tailExit
        local.get $dstP
        local.get $prevP
        f64.load align=1
        local.get $h00
        f64.mul
        local.get $prevP
        i32.const 8
        i32.add
        f64.load align=1
        local.get $h10s
        f64.mul
        f64.add
        local.get $currP
        f64.load align=1
        local.get $h01
        f64.mul
        f64.add
        local.get $currP
        i32.const 8
        i32.add
        f64.load align=1
        local.get $h11s
        f64.mul
        f64.add
        f64.store align=1
        local.get $prevP i32.const 16 i32.add local.set $prevP
        local.get $currP i32.const 16 i32.add local.set $currP
        local.get $dstP i32.const 8 i32.add local.set $dstP
        br $tailLoop
      end
    end)

  ;; ─── f32 Hermite order=2 SIMD (0.9.79) ────────────────────────────────
  ;;
  ;; f32x4 mirror of the f64x2 Hermite above: 4 samples per iteration, same
  ;; deinterleave masks as `eval_taylor_f32_o2_simd`. The basis coefficients
  ;; are demoted f64->f32 once and splatted. Like every f32 SIMD path here the
  ;; per-lane math runs in f32 (no per-lane widen), so — unlike the f64 path —
  ;; it is NOT bit-exact to the f64-accumulating JS evaluator; it agrees within
  ;; a few ULP (the equivalence pin uses an epsilon tolerance, as for the
  ;; f32 order-2 Taylor SIMD).
  (func $eval_hermite_f32_o2_simd (export "eval_hermite_f32_o2_simd")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32)
        (param $n i32)
        (param $h00 f64) (param $h10s f64) (param $h01 f64) (param $h11s f64)
    (local $prevP i32)
    (local $currP i32)
    (local $dstP i32)
    (local $simdEnd i32)
    (local $tailEnd i32)
    (local $h00f f32)
    (local $h10sf f32)
    (local $h01f f32)
    (local $h11sf f32)
    (local $h00V v128)
    (local $h10sV v128)
    (local $h01V v128)
    (local $h11sV v128)
    (local $a0 v128)
    (local $a1 v128)
    (local $P0 v128)
    (local $M0 v128)
    (local $P1 v128)
    (local $M1 v128)
    local.get $h00 f32.demote_f64 local.tee $h00f f32x4.splat local.set $h00V
    local.get $h10s f32.demote_f64 local.tee $h10sf f32x4.splat local.set $h10sV
    local.get $h01 f32.demote_f64 local.tee $h01f f32x4.splat local.set $h01V
    local.get $h11s f32.demote_f64 local.tee $h11sf f32x4.splat local.set $h11sV
    local.get $prevOff local.set $prevP
    local.get $currOff local.set $currP
    local.get $dstOff local.set $dstP
    ;; tailEnd = prevOff + n*8  (stride-2 f32 = 8 bytes/sample)
    local.get $prevOff
    local.get $n
    i32.const 3
    i32.shl
    i32.add
    local.set $tailEnd
    ;; simdEnd = prevOff + (n>>2)*32  (4 samples = 32 bytes)
    local.get $prevOff
    local.get $n
    i32.const 2
    i32.shr_u
    i32.const 5
    i32.shl
    i32.add
    local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $prevP
        local.get $simdEnd
        i32.ge_u
        br_if $simdExit
        ;; prev deinterleave
        local.get $prevP
        v128.load align=1
        local.set $a0
        local.get $prevP
        i32.const 16
        i32.add
        v128.load align=1
        local.set $a1
        local.get $a0
        local.get $a1
        i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27
        local.set $P0
        local.get $a0
        local.get $a1
        i8x16.shuffle 4 5 6 7 12 13 14 15 20 21 22 23 28 29 30 31
        local.set $M0
        ;; curr deinterleave
        local.get $currP
        v128.load align=1
        local.set $a0
        local.get $currP
        i32.const 16
        i32.add
        v128.load align=1
        local.set $a1
        local.get $a0
        local.get $a1
        i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27
        local.set $P1
        local.get $a0
        local.get $a1
        i8x16.shuffle 4 5 6 7 12 13 14 15 20 21 22 23 28 29 30 31
        local.set $M1
        ;; acc = ((h00*P0 + h10s*M0) + h01*P1) + h11s*M1  (f32x4)
        local.get $dstP
        local.get $h00V
        local.get $P0
        f32x4.mul
        local.get $h10sV
        local.get $M0
        f32x4.mul
        f32x4.add
        local.get $h01V
        local.get $P1
        f32x4.mul
        f32x4.add
        local.get $h11sV
        local.get $M1
        f32x4.mul
        f32x4.add
        v128.store align=1
        local.get $prevP i32.const 32 i32.add local.set $prevP
        local.get $currP i32.const 32 i32.add local.set $currP
        local.get $dstP i32.const 16 i32.add local.set $dstP
        br $simdLoop
      end
    end
    ;; Scalar tail (0..3 samples), f32 math (matches the SIMD body's precision).
    block $tailExit
      loop $tailLoop
        local.get $prevP
        local.get $tailEnd
        i32.ge_u
        br_if $tailExit
        local.get $dstP
        local.get $prevP
        f32.load align=1
        local.get $h00f
        f32.mul
        local.get $prevP
        i32.const 4
        i32.add
        f32.load align=1
        local.get $h10sf
        f32.mul
        f32.add
        local.get $currP
        f32.load align=1
        local.get $h01f
        f32.mul
        f32.add
        local.get $currP
        i32.const 4
        i32.add
        f32.load align=1
        local.get $h11sf
        f32.mul
        f32.add
        f32.store align=1
        local.get $prevP i32.const 8 i32.add local.set $prevP
        local.get $currP i32.const 8 i32.add local.set $currP
        local.get $dstP i32.const 4 i32.add local.set $dstP
        br $tailLoop
      end
    end)

  ;; ─── f64 order=3 Taylor SIMD (0.9.79 — the stride-3 break-through) ─────
  ;;
  ;; Deferred since the 0.7.10 SIMD cut: order-3's 24-byte (f64) sample stride
  ;; doesn't pack into v128 multiples, so the deinterleave was assumed to dwarf
  ;; the per-sample win. The f64x2 case is actually CLEAN: 2 samples = 48 bytes
  ;; = three v128 loads, and each of the p/v/a output lanes draws from exactly
  ;; TWO of those three registers, so three two-input i8x16.shuffles suffice —
  ;; no 3-input gather. Per 2-sample step:
  ;;   V0 = [p_i,   v_i  ]   (bytes  0..15)
  ;;   V1 = [a_i,   p_i+1]   (bytes 16..31)
  ;;   V2 = [v_i+1, a_i+1]   (bytes 32..47)
  ;;   P = shuffle(V0,V1, 0..7 , 24..31) = [p_i,   p_i+1]
  ;;   V = shuffle(V0,V2, 8..15, 16..23) = [v_i,   v_i+1]
  ;;   A = shuffle(V1,V2, 0..7 , 24..31) = [a_i,   a_i+1]
  ;;   out = (P + V·dt) + A·halfDt2
  ;; Accumulation is left-to-right in f64 with no FMA, and halfDt2 = (dt·dt)·0.5
  ;; exactly as the scalar `eval_taylor_f64_o3` computes it, so this is
  ;; BIT-EXACT to the scalar path and to `evaluateTrajectoryInto`. A scalar
  ;; tail handles the trailing 0..1 sample.
  (func $eval_taylor_f64_o3_simd (export "eval_taylor_f64_o3_simd")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
    (local $srcP i32)
    (local $dstP i32)
    (local $simdEnd i32)
    (local $tailEnd i32)
    (local $halfDt2 f64)
    (local $dtV v128)
    (local $halfV v128)
    (local $V0 v128)
    (local $V1 v128)
    (local $V2 v128)
    (local $P v128)
    (local $V v128)
    (local $A v128)
    local.get $dt
    local.get $dt
    f64.mul
    f64.const 0.5
    f64.mul
    local.set $halfDt2
    local.get $dt f64x2.splat local.set $dtV
    local.get $halfDt2 f64x2.splat local.set $halfV
    local.get $srcOff local.set $srcP
    local.get $dstOff local.set $dstP
    ;; tailEnd = srcOff + n*24
    local.get $srcOff
    local.get $n
    i32.const 8
    i32.mul
    i32.const 3
    i32.mul
    i32.add
    local.set $tailEnd
    ;; simdEnd = srcOff + (n>>1)*48  (2 samples = 48 bytes)
    local.get $srcOff
    local.get $n
    i32.const 1
    i32.shr_u
    i32.const 48
    i32.mul
    i32.add
    local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $srcP
        local.get $simdEnd
        i32.ge_u
        br_if $simdExit
        local.get $srcP
        v128.load align=1
        local.set $V0
        local.get $srcP
        i32.const 16
        i32.add
        v128.load align=1
        local.set $V1
        local.get $srcP
        i32.const 32
        i32.add
        v128.load align=1
        local.set $V2
        local.get $V0
        local.get $V1
        i8x16.shuffle 0 1 2 3 4 5 6 7 24 25 26 27 28 29 30 31
        local.set $P
        local.get $V0
        local.get $V2
        i8x16.shuffle 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23
        local.set $V
        local.get $V1
        local.get $V2
        i8x16.shuffle 0 1 2 3 4 5 6 7 24 25 26 27 28 29 30 31
        local.set $A
        ;; out = (P + V*dtV) + A*halfV
        local.get $dstP
        local.get $P
        local.get $V
        local.get $dtV
        f64x2.mul
        f64x2.add
        local.get $A
        local.get $halfV
        f64x2.mul
        f64x2.add
        v128.store align=1
        local.get $srcP i32.const 48 i32.add local.set $srcP
        local.get $dstP i32.const 16 i32.add local.set $dstP
        br $simdLoop
      end
    end
    ;; Scalar tail (0..1 sample) — same op order as eval_taylor_f64_o3.
    block $tailExit
      loop $tailLoop
        local.get $srcP
        local.get $tailEnd
        i32.ge_u
        br_if $tailExit
        local.get $dstP
        local.get $srcP
        f64.load align=1
        local.get $srcP
        i32.const 8
        i32.add
        f64.load align=1
        local.get $dt
        f64.mul
        f64.add
        local.get $srcP
        i32.const 16
        i32.add
        f64.load align=1
        local.get $halfDt2
        f64.mul
        f64.add
        f64.store align=1
        local.get $srcP i32.const 24 i32.add local.set $srcP
        local.get $dstP i32.const 8 i32.add local.set $dstP
        br $tailLoop
      end
    end)

  ;; ─── f32 order=3 Taylor SIMD (0.9.79 — the stride-3 break-through) ─────
  ;;
  ;; f32x4 case: 4 samples = 48 bytes = three v128 loads, but each p/v/a output
  ;; lane now draws from up to THREE registers, so the deinterleave needs TWO
  ;; chained shuffles per lane-group (6 total) — the cost the 0.7.10 note
  ;; flagged. Built + benched anyway (the f64x2 sibling is clean; this one the
  ;; data decides). Per 4-sample step:
  ;;   V0 = [p0,v0,a0,p1]  V1 = [v1,a1,p2,v2]  V2 = [a2,p3,v3,a3]
  ;;   P:  shuffle(V0,V1, p0 p1 p2 _) then shuffle(.,V2, _ _ _ p3)
  ;;   V:  shuffle(V0,V1, v0 v1 v2 _) then shuffle(.,V2, _ _ _ v3)
  ;;   A:  shuffle(V0,V1, a0 a1 _ _ ) then shuffle(.,V2, _ _ a2 a3)
  ;; f32-lane math (no per-lane widen), so — like every f32 SIMD path here —
  ;; it agrees with the f64-accumulating scalar within a few ULP, not bit-exact.
  (func $eval_taylor_f32_o3_simd (export "eval_taylor_f32_o3_simd")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
    (local $srcP i32)
    (local $dstP i32)
    (local $simdEnd i32)
    (local $tailEnd i32)
    (local $dt32 f32)
    (local $halfDt2 f32)
    (local $dtV v128)
    (local $halfV v128)
    (local $V0 v128)
    (local $V1 v128)
    (local $V2 v128)
    (local $P v128)
    (local $V v128)
    (local $A v128)
    local.get $dt f32.demote_f64 local.set $dt32
    ;; halfDt2 = (dt32 * dt32) * 0.5 in f32
    local.get $dt32
    local.get $dt32
    f32.mul
    f32.const 0.5
    f32.mul
    local.set $halfDt2
    local.get $dt32 f32x4.splat local.set $dtV
    local.get $halfDt2 f32x4.splat local.set $halfV
    local.get $srcOff local.set $srcP
    local.get $dstOff local.set $dstP
    ;; tailEnd = srcOff + n*12
    local.get $srcOff
    local.get $n
    i32.const 4
    i32.mul
    i32.const 3
    i32.mul
    i32.add
    local.set $tailEnd
    ;; simdEnd = srcOff + (n>>2)*48  (4 samples = 48 bytes)
    local.get $srcOff
    local.get $n
    i32.const 2
    i32.shr_u
    i32.const 48
    i32.mul
    i32.add
    local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $srcP
        local.get $simdEnd
        i32.ge_u
        br_if $simdExit
        local.get $srcP
        v128.load align=1
        local.set $V0
        local.get $srcP
        i32.const 16
        i32.add
        v128.load align=1
        local.set $V1
        local.get $srcP
        i32.const 32
        i32.add
        v128.load align=1
        local.set $V2
        ;; P = [p0,p1,p2,p3]: p0=V0.0 p1=V0.3 p2=V1.2(=24..27) ; then p3=V2.1(=20..23)
        local.get $V0
        local.get $V1
        i8x16.shuffle 0 1 2 3 12 13 14 15 24 25 26 27 0 1 2 3
        local.get $V2
        i8x16.shuffle 0 1 2 3 4 5 6 7 8 9 10 11 20 21 22 23
        local.set $P
        ;; V = [v0,v1,v2,v3]: v0=V0.1 v1=V1.0(=16..19) v2=V1.3(=28..31) ; v3=V2.2(=24..27)
        local.get $V0
        local.get $V1
        i8x16.shuffle 4 5 6 7 16 17 18 19 28 29 30 31 4 5 6 7
        local.get $V2
        i8x16.shuffle 0 1 2 3 4 5 6 7 8 9 10 11 24 25 26 27
        local.set $V
        ;; A = [a0,a1,a2,a3]: a0=V0.2 a1=V1.1(=20..23) ; a2=V2.0(=16..19) a3=V2.3(=28..31)
        local.get $V0
        local.get $V1
        i8x16.shuffle 8 9 10 11 20 21 22 23 8 9 10 11 8 9 10 11
        local.get $V2
        i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 28 29 30 31
        local.set $A
        ;; out = (P + V*dtV) + A*halfV
        local.get $dstP
        local.get $P
        local.get $V
        local.get $dtV
        f32x4.mul
        f32x4.add
        local.get $A
        local.get $halfV
        f32x4.mul
        f32x4.add
        v128.store align=1
        local.get $srcP i32.const 48 i32.add local.set $srcP
        local.get $dstP i32.const 16 i32.add local.set $dstP
        br $simdLoop
      end
    end
    ;; Scalar tail (0..3 samples), f32 math (matches the SIMD body precision).
    block $tailExit
      loop $tailLoop
        local.get $srcP
        local.get $tailEnd
        i32.ge_u
        br_if $tailExit
        local.get $dstP
        local.get $srcP
        f32.load align=1
        local.get $srcP
        i32.const 4
        i32.add
        f32.load align=1
        local.get $dt32
        f32.mul
        f32.add
        local.get $srcP
        i32.const 8
        i32.add
        f32.load align=1
        local.get $halfDt2
        f32.mul
        f32.add
        f32.store align=1
        local.get $srcP i32.const 12 i32.add local.set $srcP
        local.get $dstP i32.const 4 i32.add local.set $dstP
        br $tailLoop
      end
    end)

  ;; ─── f64x2 Quintic Hermite SIMD, stride-3 (0.9.83, C²) ────────────────
  ;;
  ;; 2 samples/iter. Reuses the CLEAN stride-3 f64x2 deinterleave proven by
  ;; eval_taylor_f64_o3_simd (3 two-input shuffles → P, V, A), applied to BOTH
  ;; the prev and curr frames, then the lane-wise quintic basis sum. f64
  ;; left-to-right accumulate, no implicit FMA → BIT-EXACT to the scalar
  ;; eval_quintic_hermite_f64 / JS. Order-3 (stride-3) only — the quintic over
  ;; an order-4 array (jerk ignored) keeps the scalar path; the f32x4 stride-3
  ;; gather (6 shuffles × 2 frames) is assessed-and-deferred pending bench signal.
  (func $eval_quintic_hermite_f64_o3_simd (export "eval_quintic_hermite_f64_o3_simd")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32) (param $n i32)
        (param $h0 f64) (param $h1s f64) (param $h2s f64)
        (param $h3 f64) (param $h4s f64) (param $h5s f64)
    (local $prevP i32) (local $currP i32) (local $dstP i32) (local $simdEnd i32) (local $tailEnd i32)
    (local $h0V v128) (local $h1sV v128) (local $h2sV v128)
    (local $h3V v128) (local $h4sV v128) (local $h5sV v128)
    (local $L0 v128) (local $L1 v128) (local $L2 v128)
    (local $P0 v128) (local $M0 v128) (local $A0 v128)
    (local $P1 v128) (local $M1 v128) (local $A1 v128)
    local.get $h0 f64x2.splat local.set $h0V
    local.get $h1s f64x2.splat local.set $h1sV
    local.get $h2s f64x2.splat local.set $h2sV
    local.get $h3 f64x2.splat local.set $h3V
    local.get $h4s f64x2.splat local.set $h4sV
    local.get $h5s f64x2.splat local.set $h5sV
    local.get $prevOff local.set $prevP
    local.get $currOff local.set $currP
    local.get $dstOff local.set $dstP
    ;; tailEnd = prevOff + n*24 ; simdEnd = prevOff + (n>>1)*48
    local.get $prevOff local.get $n i32.const 8 i32.mul i32.const 3 i32.mul i32.add local.set $tailEnd
    local.get $prevOff local.get $n i32.const 1 i32.shr_u i32.const 48 i32.mul i32.add local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $prevP local.get $simdEnd i32.ge_u br_if $simdExit
        ;; prev → P0, M0, A0
        local.get $prevP v128.load align=1 local.set $L0
        local.get $prevP i32.const 16 i32.add v128.load align=1 local.set $L1
        local.get $prevP i32.const 32 i32.add v128.load align=1 local.set $L2
        local.get $L0 local.get $L1 i8x16.shuffle 0 1 2 3 4 5 6 7 24 25 26 27 28 29 30 31 local.set $P0
        local.get $L0 local.get $L2 i8x16.shuffle 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 local.set $M0
        local.get $L1 local.get $L2 i8x16.shuffle 0 1 2 3 4 5 6 7 24 25 26 27 28 29 30 31 local.set $A0
        ;; curr → P1, M1, A1
        local.get $currP v128.load align=1 local.set $L0
        local.get $currP i32.const 16 i32.add v128.load align=1 local.set $L1
        local.get $currP i32.const 32 i32.add v128.load align=1 local.set $L2
        local.get $L0 local.get $L1 i8x16.shuffle 0 1 2 3 4 5 6 7 24 25 26 27 28 29 30 31 local.set $P1
        local.get $L0 local.get $L2 i8x16.shuffle 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 local.set $M1
        local.get $L1 local.get $L2 i8x16.shuffle 0 1 2 3 4 5 6 7 24 25 26 27 28 29 30 31 local.set $A1
        ;; out = ((((h0·P0 + h1s·M0) + h2s·A0) + h3·P1) + h4s·M1) + h5s·A1
        local.get $dstP
        local.get $h0V local.get $P0 f64x2.mul
        local.get $h1sV local.get $M0 f64x2.mul f64x2.add
        local.get $h2sV local.get $A0 f64x2.mul f64x2.add
        local.get $h3V local.get $P1 f64x2.mul f64x2.add
        local.get $h4sV local.get $M1 f64x2.mul f64x2.add
        local.get $h5sV local.get $A1 f64x2.mul f64x2.add
        v128.store align=1
        local.get $prevP i32.const 48 i32.add local.set $prevP
        local.get $currP i32.const 48 i32.add local.set $currP
        local.get $dstP i32.const 16 i32.add local.set $dstP
        br $simdLoop
      end
    end
    ;; Scalar tail (0..1 sample) — same left-to-right f64 op order as scalar quintic.
    block $tailExit
      loop $tailLoop
        local.get $prevP local.get $tailEnd i32.ge_u br_if $tailExit
        local.get $dstP
        local.get $prevP f64.load align=1 local.get $h0 f64.mul
        local.get $prevP i32.const 8 i32.add f64.load align=1 local.get $h1s f64.mul f64.add
        local.get $prevP i32.const 16 i32.add f64.load align=1 local.get $h2s f64.mul f64.add
        local.get $currP f64.load align=1 local.get $h3 f64.mul f64.add
        local.get $currP i32.const 8 i32.add f64.load align=1 local.get $h4s f64.mul f64.add
        local.get $currP i32.const 16 i32.add f64.load align=1 local.get $h5s f64.mul f64.add
        f64.store align=1
        local.get $prevP i32.const 24 i32.add local.set $prevP
        local.get $currP i32.const 24 i32.add local.set $currP
        local.get $dstP i32.const 8 i32.add local.set $dstP
        br $tailLoop
      end
    end)

  ;; ─── f64x2 Septic Hermite SIMD, stride-4 (0.9.83, C³) ─────────────────
  ;;
  ;; 2 samples/iter. Stride-4 (p,v,a,j) is the CLEAN f64x2 pack: 4 loads cover
  ;; 2 samples, and each lane-group (P,V,A,J) is one two-input shuffle. Applied
  ;; to prev + curr, then the 8-term lane-wise septic sum. f64 left-to-right,
  ;; no implicit FMA → BIT-EXACT to scalar eval_septic_hermite_f64 / JS.
  (func $eval_septic_hermite_f64_simd (export "eval_septic_hermite_f64_simd")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32) (param $n i32)
        (param $h0 f64) (param $h1s f64) (param $h2s f64) (param $h3s f64)
        (param $h4 f64) (param $h5s f64) (param $h6s f64) (param $h7s f64)
    (local $prevP i32) (local $currP i32) (local $dstP i32) (local $simdEnd i32) (local $tailEnd i32)
    (local $h0V v128) (local $h1sV v128) (local $h2sV v128) (local $h3sV v128)
    (local $h4V v128) (local $h5sV v128) (local $h6sV v128) (local $h7sV v128)
    (local $L0 v128) (local $L1 v128) (local $L2 v128) (local $L3 v128)
    (local $P0 v128) (local $V0 v128) (local $A0 v128) (local $J0 v128)
    (local $P1 v128) (local $V1 v128) (local $A1 v128) (local $J1 v128)
    local.get $h0 f64x2.splat local.set $h0V
    local.get $h1s f64x2.splat local.set $h1sV
    local.get $h2s f64x2.splat local.set $h2sV
    local.get $h3s f64x2.splat local.set $h3sV
    local.get $h4 f64x2.splat local.set $h4V
    local.get $h5s f64x2.splat local.set $h5sV
    local.get $h6s f64x2.splat local.set $h6sV
    local.get $h7s f64x2.splat local.set $h7sV
    local.get $prevOff local.set $prevP
    local.get $currOff local.set $currP
    local.get $dstOff local.set $dstP
    ;; tailEnd = prevOff + n*32 ; simdEnd = prevOff + (n>>1)*64
    local.get $prevOff local.get $n i32.const 32 i32.mul i32.add local.set $tailEnd
    local.get $prevOff local.get $n i32.const 1 i32.shr_u i32.const 64 i32.mul i32.add local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $prevP local.get $simdEnd i32.ge_u br_if $simdExit
        ;; prev: L0=[p0,v0] L1=[a0,j0] L2=[p1,v1] L3=[a1,j1]
        local.get $prevP v128.load align=1 local.set $L0
        local.get $prevP i32.const 16 i32.add v128.load align=1 local.set $L1
        local.get $prevP i32.const 32 i32.add v128.load align=1 local.set $L2
        local.get $prevP i32.const 48 i32.add v128.load align=1 local.set $L3
        local.get $L0 local.get $L2 i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 local.set $P0
        local.get $L0 local.get $L2 i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 local.set $V0
        local.get $L1 local.get $L3 i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 local.set $A0
        local.get $L1 local.get $L3 i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 local.set $J0
        ;; curr
        local.get $currP v128.load align=1 local.set $L0
        local.get $currP i32.const 16 i32.add v128.load align=1 local.set $L1
        local.get $currP i32.const 32 i32.add v128.load align=1 local.set $L2
        local.get $currP i32.const 48 i32.add v128.load align=1 local.set $L3
        local.get $L0 local.get $L2 i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 local.set $P1
        local.get $L0 local.get $L2 i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 local.set $V1
        local.get $L1 local.get $L3 i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 local.set $A1
        local.get $L1 local.get $L3 i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 local.set $J1
        ;; out = h0·P0 + h1s·V0 + h2s·A0 + h3s·J0 + h4·P1 + h5s·V1 + h6s·A1 + h7s·J1
        local.get $dstP
        local.get $h0V local.get $P0 f64x2.mul
        local.get $h1sV local.get $V0 f64x2.mul f64x2.add
        local.get $h2sV local.get $A0 f64x2.mul f64x2.add
        local.get $h3sV local.get $J0 f64x2.mul f64x2.add
        local.get $h4V local.get $P1 f64x2.mul f64x2.add
        local.get $h5sV local.get $V1 f64x2.mul f64x2.add
        local.get $h6sV local.get $A1 f64x2.mul f64x2.add
        local.get $h7sV local.get $J1 f64x2.mul f64x2.add
        v128.store align=1
        local.get $prevP i32.const 64 i32.add local.set $prevP
        local.get $currP i32.const 64 i32.add local.set $currP
        local.get $dstP i32.const 16 i32.add local.set $dstP
        br $simdLoop
      end
    end
    block $tailExit
      loop $tailLoop
        local.get $prevP local.get $tailEnd i32.ge_u br_if $tailExit
        local.get $dstP
        local.get $prevP f64.load align=1 local.get $h0 f64.mul
        local.get $prevP i32.const 8 i32.add f64.load align=1 local.get $h1s f64.mul f64.add
        local.get $prevP i32.const 16 i32.add f64.load align=1 local.get $h2s f64.mul f64.add
        local.get $prevP i32.const 24 i32.add f64.load align=1 local.get $h3s f64.mul f64.add
        local.get $currP f64.load align=1 local.get $h4 f64.mul f64.add
        local.get $currP i32.const 8 i32.add f64.load align=1 local.get $h5s f64.mul f64.add
        local.get $currP i32.const 16 i32.add f64.load align=1 local.get $h6s f64.mul f64.add
        local.get $currP i32.const 24 i32.add f64.load align=1 local.get $h7s f64.mul f64.add
        f64.store align=1
        local.get $prevP i32.const 32 i32.add local.set $prevP
        local.get $currP i32.const 32 i32.add local.set $currP
        local.get $dstP i32.const 8 i32.add local.set $dstP
        br $tailLoop
      end
    end)

  ;; ─── f32x4 Septic Hermite SIMD, stride-4 (0.9.83, C³) ─────────────────
  ;;
  ;; 4 samples/iter. Each sample [p,v,a,j] is one v128; 4 loads + a 4×4 AoS→SoA
  ;; transpose (2 unpack-lo/hi + 2 combine shuffles per group) yield P,V,A,J as
  ;; f32x4. Applied to prev + curr, then the f32-lane septic sum. Coefficients
  ;; demoted f64→f32 and splatted once. f32-lane math → within a few ULP of the
  ;; f64-accumulating scalar (NOT bit-exact), same as every f32 SIMD path here.
  (func $eval_septic_hermite_f32_simd (export "eval_septic_hermite_f32_simd")
        (param $prevOff i32) (param $currOff i32) (param $dstOff i32) (param $n i32)
        (param $h0 f64) (param $h1s f64) (param $h2s f64) (param $h3s f64)
        (param $h4 f64) (param $h5s f64) (param $h6s f64) (param $h7s f64)
    (local $prevP i32) (local $currP i32) (local $dstP i32) (local $simdEnd i32) (local $tailEnd i32)
    (local $h0V v128) (local $h1sV v128) (local $h2sV v128) (local $h3sV v128)
    (local $h4V v128) (local $h5sV v128) (local $h6sV v128) (local $h7sV v128)
    (local $L0 v128) (local $L1 v128) (local $L2 v128) (local $L3 v128)
    (local $t0 v128) (local $t1 v128) (local $t2 v128) (local $t3 v128)
    (local $P0 v128) (local $V0 v128) (local $A0 v128) (local $J0 v128)
    (local $P1 v128) (local $V1 v128) (local $A1 v128) (local $J1 v128)
    local.get $h0 f32.demote_f64 f32x4.splat local.set $h0V
    local.get $h1s f32.demote_f64 f32x4.splat local.set $h1sV
    local.get $h2s f32.demote_f64 f32x4.splat local.set $h2sV
    local.get $h3s f32.demote_f64 f32x4.splat local.set $h3sV
    local.get $h4 f32.demote_f64 f32x4.splat local.set $h4V
    local.get $h5s f32.demote_f64 f32x4.splat local.set $h5sV
    local.get $h6s f32.demote_f64 f32x4.splat local.set $h6sV
    local.get $h7s f32.demote_f64 f32x4.splat local.set $h7sV
    local.get $prevOff local.set $prevP
    local.get $currOff local.set $currP
    local.get $dstOff local.set $dstP
    ;; tailEnd = prevOff + n*16 ; simdEnd = prevOff + (n>>2)*64
    local.get $prevOff local.get $n i32.const 4 i32.shl i32.add local.set $tailEnd
    local.get $prevOff local.get $n i32.const 2 i32.shr_u i32.const 64 i32.mul i32.add local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $prevP local.get $simdEnd i32.ge_u br_if $simdExit
        ;; prev transpose
        local.get $prevP v128.load align=1 local.set $L0
        local.get $prevP i32.const 16 i32.add v128.load align=1 local.set $L1
        local.get $prevP i32.const 32 i32.add v128.load align=1 local.set $L2
        local.get $prevP i32.const 48 i32.add v128.load align=1 local.set $L3
        local.get $L0 local.get $L1 i8x16.shuffle 0 1 2 3 16 17 18 19 4 5 6 7 20 21 22 23 local.set $t0
        local.get $L0 local.get $L1 i8x16.shuffle 8 9 10 11 24 25 26 27 12 13 14 15 28 29 30 31 local.set $t1
        local.get $L2 local.get $L3 i8x16.shuffle 0 1 2 3 16 17 18 19 4 5 6 7 20 21 22 23 local.set $t2
        local.get $L2 local.get $L3 i8x16.shuffle 8 9 10 11 24 25 26 27 12 13 14 15 28 29 30 31 local.set $t3
        local.get $t0 local.get $t2 i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 local.set $P0
        local.get $t0 local.get $t2 i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 local.set $V0
        local.get $t1 local.get $t3 i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 local.set $A0
        local.get $t1 local.get $t3 i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 local.set $J0
        ;; curr transpose
        local.get $currP v128.load align=1 local.set $L0
        local.get $currP i32.const 16 i32.add v128.load align=1 local.set $L1
        local.get $currP i32.const 32 i32.add v128.load align=1 local.set $L2
        local.get $currP i32.const 48 i32.add v128.load align=1 local.set $L3
        local.get $L0 local.get $L1 i8x16.shuffle 0 1 2 3 16 17 18 19 4 5 6 7 20 21 22 23 local.set $t0
        local.get $L0 local.get $L1 i8x16.shuffle 8 9 10 11 24 25 26 27 12 13 14 15 28 29 30 31 local.set $t1
        local.get $L2 local.get $L3 i8x16.shuffle 0 1 2 3 16 17 18 19 4 5 6 7 20 21 22 23 local.set $t2
        local.get $L2 local.get $L3 i8x16.shuffle 8 9 10 11 24 25 26 27 12 13 14 15 28 29 30 31 local.set $t3
        local.get $t0 local.get $t2 i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 local.set $P1
        local.get $t0 local.get $t2 i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 local.set $V1
        local.get $t1 local.get $t3 i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 local.set $A1
        local.get $t1 local.get $t3 i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 local.set $J1
        ;; out = h0·P0 + h1s·V0 + h2s·A0 + h3s·J0 + h4·P1 + h5s·V1 + h6s·A1 + h7s·J1 (f32 lanes)
        local.get $dstP
        local.get $h0V local.get $P0 f32x4.mul
        local.get $h1sV local.get $V0 f32x4.mul f32x4.add
        local.get $h2sV local.get $A0 f32x4.mul f32x4.add
        local.get $h3sV local.get $J0 f32x4.mul f32x4.add
        local.get $h4V local.get $P1 f32x4.mul f32x4.add
        local.get $h5sV local.get $V1 f32x4.mul f32x4.add
        local.get $h6sV local.get $A1 f32x4.mul f32x4.add
        local.get $h7sV local.get $J1 f32x4.mul f32x4.add
        v128.store align=1
        local.get $prevP i32.const 64 i32.add local.set $prevP
        local.get $currP i32.const 64 i32.add local.set $currP
        local.get $dstP i32.const 16 i32.add local.set $dstP
        br $simdLoop
      end
    end
    ;; Scalar tail (0..3 samples) — f32 promote→f64 accumulate→demote, matching
    ;; eval_septic_hermite_f32 (NOTE: tail is f64-accumulated; the SIMD body is
    ;; f32-lane, so tail samples can differ from body samples by a ULP — both
    ;; are within the f32 tolerance the equivalence pin asserts).
    block $tailExit
      loop $tailLoop
        local.get $prevP local.get $tailEnd i32.ge_u br_if $tailExit
        local.get $dstP
        local.get $prevP f32.load align=1 f64.promote_f32 local.get $h0 f64.mul
        local.get $prevP i32.const 4 i32.add f32.load align=1 f64.promote_f32 local.get $h1s f64.mul f64.add
        local.get $prevP i32.const 8 i32.add f32.load align=1 f64.promote_f32 local.get $h2s f64.mul f64.add
        local.get $prevP i32.const 12 i32.add f32.load align=1 f64.promote_f32 local.get $h3s f64.mul f64.add
        local.get $currP f32.load align=1 f64.promote_f32 local.get $h4 f64.mul f64.add
        local.get $currP i32.const 4 i32.add f32.load align=1 f64.promote_f32 local.get $h5s f64.mul f64.add
        local.get $currP i32.const 8 i32.add f32.load align=1 f64.promote_f32 local.get $h6s f64.mul f64.add
        local.get $currP i32.const 12 i32.add f32.load align=1 f64.promote_f32 local.get $h7s f64.mul f64.add
        f32.demote_f64
        f32.store align=1
        local.get $prevP i32.const 16 i32.add local.set $prevP
        local.get $currP i32.const 16 i32.add local.set $currP
        local.get $dstP i32.const 4 i32.add local.set $dstP
        br $tailLoop
      end
    end)

  ;; ─── Descriptor-driven whole-frame decode (0.9.74) ────────────────────
  ;;
  ;; ONE JS↔WASM crossing decodes an ENTIRE frame. The per-field readers
  ;; above (`read_f64` / `read_u32` / …) each cost a crossing — fine for a
  ;; one-off scalar peek, pathological as a hot-path frame decoder (a
  ;; 6-field frame = 6 crossings/quantum). This export is the antidote and
  ;; the direct analogue of the website modal kernel's "do a frame's worth
  ;; of work per call" discipline: it loops over a descriptor table and
  ;; does one `memory.copy` per field, all inside a single call.
  ;;
  ;; The copy gathers each field's bytes from its slot offset into a
  ;; caller-chosen destination region (the consumer-side scratch the shim
  ;; allocates above the SAB ring). The JS side then reads the decoded
  ;; values from that stable scratch snapshot via its own typed-array
  ;; views — and, crucially, the SAB slot can be released the instant this
  ;; returns, so the producer is never blocked on the consumer's decode.
  ;;
  ;; Descriptor table layout (tightly-packed little-endian i32 words; the
  ;; shim's `buildFrameDescriptors` emits exactly this and guarantees
  ;; `descPtr` is 4-aligned):
  ;;
  ;;     desc[k].srcRel  = i32 @ descPtr + k*12 + 0   (offset WITHIN the frame)
  ;;     desc[k].dstAbs  = i32 @ descPtr + k*12 + 4   (absolute WASM-mem offset)
  ;;     desc[k].byteCnt = i32 @ descPtr + k*12 + 8   (elemSize * length)
  ;;
  ;; Per field: memory.copy(dstAbs, slotBase + srcRel, byteCnt). The slot's
  ;; bytes are little-endian; the copy is byte-exact and endianness-blind,
  ;; so the JS typed-array views over the scratch interpret them identically
  ;; to the umbrella views `Bridge.pull` lays over the SAB. Bit-exact to the
  ;; JS decode by construction (no arithmetic — pure relocation).
  ;;
  ;; `slotBase` is the absolute byte offset of the slot start within WASM
  ;; memory: `RING_HEADER_BYTES(32) + slot * frameByteSize`. The shim
  ;; computes it from the peeked slot index.
  (func $decode_frame (export "decode_frame")
        (param $slotBase i32) (param $descPtr i32) (param $descCount i32)
    (local $p i32)        ;; running descriptor-word pointer
    (local $end i32)      ;; one-past-end of the descriptor table
    local.get $descPtr
    local.set $p
    ;; end = descPtr + descCount * 12
    local.get $descPtr
    local.get $descCount
    i32.const 12
    i32.mul
    i32.add
    local.set $end
    block $exit
      loop $loop
        local.get $p
        local.get $end
        i32.ge_u
        br_if $exit
        ;; memory.copy expects (dst, src, len) on the stack in that order.
        ;; dst = desc.dstAbs = i32 @ p+4
        local.get $p
        i32.const 4
        i32.add
        i32.load
        ;; src = slotBase + desc.srcRel = slotBase + (i32 @ p+0)
        local.get $slotBase
        local.get $p
        i32.load
        i32.add
        ;; len = desc.byteCnt = i32 @ p+8
        local.get $p
        i32.const 8
        i32.add
        i32.load
        memory.copy
        ;; advance to next descriptor (3 i32 = 12 bytes)
        local.get $p
        i32.const 12
        i32.add
        local.set $p
        br $loop
      end
    end)

  ;; ─── Clamped trajectory evaluators (0.9.77) ───────────────────────────
  ;;
  ;; Port of `evaluateTrajectoryInto`'s clamped path (src/trajectory.ts, 0.6.7)
  ;; for the DERIVATIVE-CLAMP-ONLY case: `velocityClamp` (+ `accelerationClamp`
  ;; at order 3), with `maxDeltaPerSample` UNSET. Each loaded derivative is
  ;; clamped to `[-clamp, +clamp]` via min/max — the website modal kernel's
  ;; lane-wise clamp idiom — before the Taylor multiply. The `maxDeltaPerSample`
  ;; post-eval delta band is sequential (depends on the prior output) and
  ;; branchy (`overflowFallback`), so it does not vectorize and stays JS-side;
  ;; a caller with that clamp set keeps using `evaluateTrajectoryInto`.
  ;;
  ;; Bit-exactness: the JS clamp is `if (v>vc) vc else if (v<-vc) -vc else v`,
  ;; which for FINITE derivatives equals `max(-vc, min(vc, v))`. WebAssembly's
  ;; `f64.min`/`f64.max` produce the identical finite result, so the f64 paths
  ;; (scalar AND SIMD) are bit-exact to the JS clamped path. The f32 SIMD path
  ;; does its math in f32 (no per-lane widen), so — like the unclamped f32 SIMD
  ;; evaluator — it agrees only within a few ULP; the f32 SCALAR path promotes
  ;; to f64 (matching the JS Float32Array-read→Number semantics) and is
  ;; bit-exact.

  ;; f64 order-2 scalar clamped: out[i] = p_i + clamp(v_i)·dt.
  (func $eval_taylor_f64_o2_clamped (export "eval_taylor_f64_o2_clamped")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64) (param $vClamp f64)
    (local $srcP i32) (local $dstP i32) (local $srcEnd i32) (local $negV f64) (local $v f64)
    local.get $vClamp f64.neg local.set $negV
    local.get $srcOff local.set $srcP
    local.get $dstOff local.set $dstP
    local.get $srcOff local.get $n i32.const 4 i32.shl i32.add local.set $srcEnd
    block $exit
      loop $loop
        local.get $srcP local.get $srcEnd i32.ge_u br_if $exit
        ;; v = max(-vc, min(vc, load v))
        local.get $srcP i32.const 8 i32.add f64.load align=1
        local.get $vClamp f64.min
        local.get $negV f64.max
        local.set $v
        local.get $dstP
        local.get $srcP f64.load align=1
        local.get $v local.get $dt f64.mul
        f64.add
        f64.store align=1
        local.get $srcP i32.const 16 i32.add local.set $srcP
        local.get $dstP i32.const 8 i32.add local.set $dstP
        br $loop
      end
    end)

  ;; f64 order-3 scalar clamped: out[i] = p + clamp(v)·dt + clamp(a)·½dt².
  (func $eval_taylor_f64_o3_clamped (export "eval_taylor_f64_o3_clamped")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
        (param $vClamp f64) (param $aClamp f64)
    (local $srcP i32) (local $dstP i32) (local $srcEnd i32)
    (local $negV f64) (local $negA f64) (local $halfDt2 f64) (local $v f64) (local $a f64)
    local.get $vClamp f64.neg local.set $negV
    local.get $aClamp f64.neg local.set $negA
    local.get $dt local.get $dt f64.mul f64.const 0.5 f64.mul local.set $halfDt2
    local.get $srcOff local.set $srcP
    local.get $dstOff local.set $dstP
    local.get $srcOff local.get $n i32.const 8 i32.mul i32.const 3 i32.mul i32.add local.set $srcEnd
    block $exit
      loop $loop
        local.get $srcP local.get $srcEnd i32.ge_u br_if $exit
        local.get $srcP i32.const 8 i32.add f64.load align=1
        local.get $vClamp f64.min local.get $negV f64.max local.set $v
        local.get $srcP i32.const 16 i32.add f64.load align=1
        local.get $aClamp f64.min local.get $negA f64.max local.set $a
        local.get $dstP
        local.get $srcP f64.load align=1
        local.get $v local.get $dt f64.mul f64.add
        local.get $a local.get $halfDt2 f64.mul f64.add
        f64.store align=1
        local.get $srcP i32.const 24 i32.add local.set $srcP
        local.get $dstP i32.const 8 i32.add local.set $dstP
        br $loop
      end
    end)

  ;; f32 order-2 scalar clamped — math promoted to f64 (matches JS), demote on
  ;; store. Bit-exact to the JS f32 clamped path.
  (func $eval_taylor_f32_o2_clamped (export "eval_taylor_f32_o2_clamped")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64) (param $vClamp f64)
    (local $srcP i32) (local $dstP i32) (local $srcEnd i32) (local $negV f64) (local $v f64)
    local.get $vClamp f64.neg local.set $negV
    local.get $srcOff local.set $srcP
    local.get $dstOff local.set $dstP
    local.get $srcOff local.get $n i32.const 3 i32.shl i32.add local.set $srcEnd
    block $exit
      loop $loop
        local.get $srcP local.get $srcEnd i32.ge_u br_if $exit
        local.get $srcP i32.const 4 i32.add f32.load align=1 f64.promote_f32
        local.get $vClamp f64.min local.get $negV f64.max local.set $v
        local.get $dstP
        local.get $srcP f32.load align=1 f64.promote_f32
        local.get $v local.get $dt f64.mul f64.add
        f32.demote_f64
        f32.store align=1
        local.get $srcP i32.const 8 i32.add local.set $srcP
        local.get $dstP i32.const 4 i32.add local.set $dstP
        br $loop
      end
    end)

  ;; f32 order-3 scalar clamped — f64 math, demote on store.
  (func $eval_taylor_f32_o3_clamped (export "eval_taylor_f32_o3_clamped")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64)
        (param $vClamp f64) (param $aClamp f64)
    (local $srcP i32) (local $dstP i32) (local $srcEnd i32)
    (local $negV f64) (local $negA f64) (local $halfDt2 f64) (local $v f64) (local $a f64)
    local.get $vClamp f64.neg local.set $negV
    local.get $aClamp f64.neg local.set $negA
    local.get $dt local.get $dt f64.mul f64.const 0.5 f64.mul local.set $halfDt2
    local.get $srcOff local.set $srcP
    local.get $dstOff local.set $dstP
    local.get $srcOff local.get $n i32.const 4 i32.mul i32.const 3 i32.mul i32.add local.set $srcEnd
    block $exit
      loop $loop
        local.get $srcP local.get $srcEnd i32.ge_u br_if $exit
        local.get $srcP i32.const 4 i32.add f32.load align=1 f64.promote_f32
        local.get $vClamp f64.min local.get $negV f64.max local.set $v
        local.get $srcP i32.const 8 i32.add f32.load align=1 f64.promote_f32
        local.get $aClamp f64.min local.get $negA f64.max local.set $a
        local.get $dstP
        local.get $srcP f32.load align=1 f64.promote_f32
        local.get $v local.get $dt f64.mul f64.add
        local.get $a local.get $halfDt2 f64.mul f64.add
        f32.demote_f64
        f32.store align=1
        local.get $srcP i32.const 12 i32.add local.set $srcP
        local.get $dstP i32.const 4 i32.add local.set $dstP
        br $loop
      end
    end)

  ;; f64 order-2 SIMD clamped: 2 samples/iter. Deinterleave [p,v] like the
  ;; unclamped o2 SIMD, clamp the velocity lane via f64x2.min/max against the
  ;; broadcast clamp, then positions + velocities·dt. Bit-exact (f64 math).
  (func $eval_taylor_f64_o2_clamped_simd (export "eval_taylor_f64_o2_clamped_simd")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64) (param $vClamp f64)
    (local $srcP i32) (local $dstP i32) (local $simdEnd i32) (local $tailEnd i32)
    (local $negV f64) (local $dtV v128) (local $vcV v128) (local $negVcV v128)
    (local $v0 v128) (local $v1 v128) (local $positions v128) (local $velocities v128) (local $v f64)
    local.get $vClamp f64.neg local.set $negV
    local.get $dt f64x2.splat local.set $dtV
    local.get $vClamp f64x2.splat local.set $vcV
    local.get $negV f64x2.splat local.set $negVcV
    local.get $srcOff local.set $srcP
    local.get $dstOff local.set $dstP
    local.get $srcOff local.get $n i32.const 4 i32.shl i32.add local.set $tailEnd
    local.get $srcOff local.get $n i32.const 1 i32.shr_u i32.const 5 i32.shl i32.add local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $srcP local.get $simdEnd i32.ge_u br_if $simdExit
        local.get $srcP v128.load align=1 local.set $v0
        local.get $srcP i32.const 16 i32.add v128.load align=1 local.set $v1
        local.get $v0 local.get $v1 i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 local.set $positions
        local.get $v0 local.get $v1 i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 local.set $velocities
        ;; clamp velocities lane-wise: max(-vc, min(vc, v))
        local.get $velocities local.get $vcV f64x2.min local.get $negVcV f64x2.max local.set $velocities
        local.get $dstP
        local.get $positions
        local.get $velocities local.get $dtV f64x2.mul
        f64x2.add
        v128.store align=1
        local.get $srcP i32.const 32 i32.add local.set $srcP
        local.get $dstP i32.const 16 i32.add local.set $dstP
        br $simdLoop
      end
    end
    block $tailExit
      loop $tailLoop
        local.get $srcP local.get $tailEnd i32.ge_u br_if $tailExit
        local.get $srcP i32.const 8 i32.add f64.load align=1
        local.get $vClamp f64.min local.get $negV f64.max local.set $v
        local.get $dstP
        local.get $srcP f64.load align=1
        local.get $v local.get $dt f64.mul f64.add
        f64.store align=1
        local.get $srcP i32.const 16 i32.add local.set $srcP
        local.get $dstP i32.const 8 i32.add local.set $dstP
        br $tailLoop
      end
    end)

  ;; f32 order-2 SIMD clamped: 4 samples/iter. f32 math (NOT bit-exact to the
  ;; f64-promoted scalar — agrees within a few ULP, like the unclamped f32 SIMD).
  (func $eval_taylor_f32_o2_clamped_simd (export "eval_taylor_f32_o2_clamped_simd")
        (param $srcOff i32) (param $dstOff i32) (param $n i32) (param $dt f64) (param $vClamp f64)
    (local $srcP i32) (local $dstP i32) (local $simdEnd i32) (local $tailEnd i32)
    (local $dt32 f32) (local $vc32 f32) (local $negVc32 f32)
    (local $dtV v128) (local $vcV v128) (local $negVcV v128)
    (local $v0 v128) (local $v1 v128) (local $positions v128) (local $velocities v128) (local $v f32)
    local.get $dt f32.demote_f64 local.set $dt32
    local.get $vClamp f32.demote_f64 local.set $vc32
    local.get $vc32 f32.neg local.set $negVc32
    local.get $dt32 f32x4.splat local.set $dtV
    local.get $vc32 f32x4.splat local.set $vcV
    local.get $negVc32 f32x4.splat local.set $negVcV
    local.get $srcOff local.set $srcP
    local.get $dstOff local.set $dstP
    local.get $srcOff local.get $n i32.const 3 i32.shl i32.add local.set $tailEnd
    local.get $srcOff local.get $n i32.const 2 i32.shr_u i32.const 5 i32.shl i32.add local.set $simdEnd
    block $simdExit
      loop $simdLoop
        local.get $srcP local.get $simdEnd i32.ge_u br_if $simdExit
        local.get $srcP v128.load align=1 local.set $v0
        local.get $srcP i32.const 16 i32.add v128.load align=1 local.set $v1
        local.get $v0 local.get $v1 i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27 local.set $positions
        local.get $v0 local.get $v1 i8x16.shuffle 4 5 6 7 12 13 14 15 20 21 22 23 28 29 30 31 local.set $velocities
        local.get $velocities local.get $vcV f32x4.min local.get $negVcV f32x4.max local.set $velocities
        local.get $dstP
        local.get $positions
        local.get $velocities local.get $dtV f32x4.mul
        f32x4.add
        v128.store align=1
        local.get $srcP i32.const 32 i32.add local.set $srcP
        local.get $dstP i32.const 16 i32.add local.set $dstP
        br $simdLoop
      end
    end
    block $tailExit
      loop $tailLoop
        local.get $srcP local.get $tailEnd i32.ge_u br_if $tailExit
        local.get $srcP i32.const 4 i32.add f32.load align=1
        local.get $vc32 f32.min local.get $negVc32 f32.max local.set $v
        local.get $dstP
        local.get $srcP f32.load align=1
        local.get $v local.get $dt32 f32.mul f32.add
        f32.store align=1
        local.get $srcP i32.const 8 i32.add local.set $srcP
        local.get $dstP i32.const 4 i32.add local.set $dstP
        br $tailLoop
      end
    end)

  ;; ─── StatePredictor (classical Kalman) scalar kernels (0.9.903) ─────────
  ;;
  ;; WASM scalar port of src/StatePredictor.ts (Apollo Frontier 2). Operates on
  ;; caller-laid-out f64 state in linear memory, bit-exact (left-to-right f64,
  ;; no implicit FMA) to the JS reference so the SIMD port (0.9.904) can be
  ;; validated against either. Memory layout per lane:
  ;;   x[] : laneCount × m f64  (m = 2 cv, 3 ca), lane i at xOff + i*m*8
  ;;   P[] : laneCount × m*m f64 (row-major), lane i at pOff + i*m*m*8
  ;;   pos/vel/acc/val/var : laneCount f64, lane i at *Off + i*8
  ;;   scratch : 2*m f64 (K[0..m) then row[0..m)) — caller-owned, reused per lane
  ;;
  ;; Sequential scalar measurement update for ONE lane at state index idx
  ;; (diagonal R): y = z − x[idx]; S = P[idx][idx] + r; K = P[:,idx]/S;
  ;; x += K·y; P −= K·P[idx,:]. Generic over m via the scratch K/row buffers —
  ;; identical op order to StatePredictor._updateScalar.
  (func $kalman_update
        (param $xLane i32) (param $pLane i32) (param $m i32) (param $idx i32)
        (param $z f64) (param $r f64) (param $scratch i32)
    (local $i i32) (local $j i32)
    (local $S f64) (local $y f64) (local $ki f64) (local $rowj f64)
    (local $mBytes i32) (local $off i32) (local $kOff i32) (local $rowOff i32)
    (local.set $mBytes (i32.shl (local.get $m) (i32.const 3)))
    (local.set $kOff (local.get $scratch))
    (local.set $rowOff (i32.add (local.get $scratch) (local.get $mBytes)))
    ;; S = P[idx*m+idx] + r
    (local.set $off
      (i32.add (local.get $pLane)
        (i32.shl (i32.add (i32.mul (local.get $idx) (local.get $m)) (local.get $idx)) (i32.const 3))))
    (local.set $S (f64.add (f64.load align=1 (local.get $off)) (local.get $r)))
    ;; y = z - x[idx]
    (local.set $y
      (f64.sub (local.get $z)
        (f64.load align=1 (i32.add (local.get $xLane) (i32.shl (local.get $idx) (i32.const 3))))))
    ;; K[i] = P[i*m+idx]/S  -> scratch
    (local.set $i (i32.const 0))
    (block $ke (loop $kl
      (br_if $ke (i32.ge_u (local.get $i) (local.get $m)))
      (f64.store align=1
        (i32.add (local.get $kOff) (i32.shl (local.get $i) (i32.const 3)))
        (f64.div
          (f64.load align=1
            (i32.add (local.get $pLane)
              (i32.shl (i32.add (i32.mul (local.get $i) (local.get $m)) (local.get $idx)) (i32.const 3))))
          (local.get $S)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $kl)))
    ;; x[i] += K[i]*y
    (local.set $i (i32.const 0))
    (block $xe (loop $xl
      (br_if $xe (i32.ge_u (local.get $i) (local.get $m)))
      (local.set $off (i32.add (local.get $xLane) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $ki (f64.load align=1 (i32.add (local.get $kOff) (i32.shl (local.get $i) (i32.const 3)))))
      (f64.store align=1 (local.get $off)
        (f64.add (f64.load align=1 (local.get $off)) (f64.mul (local.get $ki) (local.get $y))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $xl)))
    ;; row[j] = P[idx*m+j]  -> scratch
    (local.set $j (i32.const 0))
    (block $re (loop $rl
      (br_if $re (i32.ge_u (local.get $j) (local.get $m)))
      (f64.store align=1
        (i32.add (local.get $rowOff) (i32.shl (local.get $j) (i32.const 3)))
        (f64.load align=1
          (i32.add (local.get $pLane)
            (i32.shl (i32.add (i32.mul (local.get $idx) (local.get $m)) (local.get $j)) (i32.const 3)))))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $rl)))
    ;; P[i*m+j] -= K[i]*row[j]
    (local.set $i (i32.const 0))
    (block $pie (loop $pil
      (br_if $pie (i32.ge_u (local.get $i) (local.get $m)))
      (local.set $ki (f64.load align=1 (i32.add (local.get $kOff) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $j (i32.const 0))
      (block $pje (loop $pjl
        (br_if $pje (i32.ge_u (local.get $j) (local.get $m)))
        (local.set $rowj (f64.load align=1 (i32.add (local.get $rowOff) (i32.shl (local.get $j) (i32.const 3)))))
        (local.set $off
          (i32.add (local.get $pLane)
            (i32.shl (i32.add (i32.mul (local.get $i) (local.get $m)) (local.get $j)) (i32.const 3))))
        (f64.store align=1 (local.get $off)
          (f64.sub (f64.load align=1 (local.get $off)) (f64.mul (local.get $ki) (local.get $rowj))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $pjl)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pil)))
  )

  ;; CV (m=2) covariance propagate for ONE lane: x ← Fx; P ← F P Fᵀ + Q,
  ;; Q = q·[[dt³/3,dt²/2],[dt²/2,dt]]. Op order matches _propagateCV.
  (func $kalman_propagate_cv (param $xLane i32) (param $pLane i32) (param $dt f64) (param $q f64)
    (local $x0 f64) (local $x1 f64)
    (local $p00 f64) (local $p01 f64) (local $p10 f64) (local $p11 f64)
    (local $fp00 f64) (local $fp01 f64) (local $dt2 f64) (local $dt3 f64)
    (local.set $x0 (f64.load align=1 (local.get $xLane)))
    (local.set $x1 (f64.load align=1 (i32.add (local.get $xLane) (i32.const 8))))
    (f64.store align=1 (local.get $xLane)
      (f64.add (local.get $x0) (f64.mul (local.get $dt) (local.get $x1))))
    (local.set $p00 (f64.load align=1 (local.get $pLane)))
    (local.set $p01 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 8))))
    (local.set $p10 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 16))))
    (local.set $p11 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 24))))
    (local.set $fp00 (f64.add (local.get $p00) (f64.mul (local.get $dt) (local.get $p10))))
    (local.set $fp01 (f64.add (local.get $p01) (f64.mul (local.get $dt) (local.get $p11))))
    (local.set $dt2 (f64.mul (local.get $dt) (local.get $dt)))
    (local.set $dt3 (f64.mul (local.get $dt2) (local.get $dt)))
    ;; P[0] = fp00 + dt*fp01 + q*dt3/3
    (f64.store align=1 (local.get $pLane)
      (f64.add
        (f64.add (local.get $fp00) (f64.mul (local.get $dt) (local.get $fp01)))
        (f64.div (f64.mul (local.get $q) (local.get $dt3)) (f64.const 3))))
    ;; P[1] = fp01 + q*dt2/2
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 8))
      (f64.add (local.get $fp01) (f64.div (f64.mul (local.get $q) (local.get $dt2)) (f64.const 2))))
    ;; P[2] = p10 + dt*p11 + q*dt2/2   (fp10=p10, fp11=p11)
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 16))
      (f64.add
        (f64.add (local.get $p10) (f64.mul (local.get $dt) (local.get $p11)))
        (f64.div (f64.mul (local.get $q) (local.get $dt2)) (f64.const 2))))
    ;; P[3] = p11 + q*dt
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 24))
      (f64.add (local.get $p11) (f64.mul (local.get $q) (local.get $dt))))
  )

  ;; CV ingest: per lane, propagate (if dt>0) then a position update and an
  ;; optional velocity update. Mirrors StatePredictor.ingest for model "cv".
  (func $kalman_ingest_cv_f64 (export "kalman_ingest_cv_f64")
        (param $xOff i32) (param $pOff i32) (param $posOff i32) (param $velOff i32)
        (param $n i32) (param $dt f64) (param $q f64) (param $rp f64) (param $rv f64)
        (param $useVel i32) (param $scratch i32)
    (local $i i32) (local $xLane i32) (local $pLane i32) (local $lo i32)
    (local.set $i (i32.const 0))
    (block $exit (loop $loop
      (br_if $exit (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $xLane (i32.add (local.get $xOff) (i32.mul (local.get $i) (i32.const 16))))
      (local.set $pLane (i32.add (local.get $pOff) (i32.mul (local.get $i) (i32.const 32))))
      (local.set $lo (i32.shl (local.get $i) (i32.const 3)))
      (if (f64.gt (local.get $dt) (f64.const 0))
        (then (call $kalman_propagate_cv (local.get $xLane) (local.get $pLane) (local.get $dt) (local.get $q))))
      (call $kalman_update (local.get $xLane) (local.get $pLane) (i32.const 2) (i32.const 0)
        (f64.load align=1 (i32.add (local.get $posOff) (local.get $lo))) (local.get $rp) (local.get $scratch))
      (if (local.get $useVel)
        (then (call $kalman_update (local.get $xLane) (local.get $pLane) (i32.const 2) (i32.const 1)
          (f64.load align=1 (i32.add (local.get $velOff) (local.get $lo))) (local.get $rv) (local.get $scratch))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
  )

  ;; CV predict: per lane, value = p + dt·v ; variance = (F P Fᵀ)₀₀ + q·dt³/3.
  ;; Read-only on x/P. Mirrors StatePredictor.predictInto for model "cv".
  (func $kalman_predict_cv_f64 (export "kalman_predict_cv_f64")
        (param $xOff i32) (param $pOff i32) (param $valOff i32) (param $varOff i32)
        (param $n i32) (param $dt f64) (param $q f64)
    (local $i i32) (local $xp i32) (local $pp i32)
    (local $p00 f64) (local $p01 f64) (local $p10 f64) (local $p11 f64)
    (local $fp0 f64) (local $fp1 f64)
    (local.set $i (i32.const 0))
    (block $exit (loop $loop
      (br_if $exit (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $xp (i32.add (local.get $xOff) (i32.mul (local.get $i) (i32.const 16))))
      (local.set $pp (i32.add (local.get $pOff) (i32.mul (local.get $i) (i32.const 32))))
      ;; value = x0 + dt*x1
      (f64.store align=1 (i32.add (local.get $valOff) (i32.shl (local.get $i) (i32.const 3)))
        (f64.add (f64.load align=1 (local.get $xp))
          (f64.mul (local.get $dt) (f64.load align=1 (i32.add (local.get $xp) (i32.const 8))))))
      (local.set $p00 (f64.load align=1 (local.get $pp)))
      (local.set $p01 (f64.load align=1 (i32.add (local.get $pp) (i32.const 8))))
      (local.set $p10 (f64.load align=1 (i32.add (local.get $pp) (i32.const 16))))
      (local.set $p11 (f64.load align=1 (i32.add (local.get $pp) (i32.const 24))))
      (local.set $fp0 (f64.add (local.get $p00) (f64.mul (local.get $dt) (local.get $p10))))
      (local.set $fp1 (f64.add (local.get $p01) (f64.mul (local.get $dt) (local.get $p11))))
      ;; var = (fp0 + dt*fp1) + q*dt*dt*dt/3
      (f64.store align=1 (i32.add (local.get $varOff) (i32.shl (local.get $i) (i32.const 3)))
        (f64.add
          (f64.add (local.get $fp0) (f64.mul (local.get $dt) (local.get $fp1)))
          (f64.div
            (f64.mul (f64.mul (f64.mul (local.get $q) (local.get $dt)) (local.get $dt)) (local.get $dt))
            (f64.const 3))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
  )

  ;; CA (m=3) covariance propagate for ONE lane: x ← Fx; P ← F P Fᵀ + Q (jerk
  ;; model). Op order matches _propagateCA. h = ½dt².
  (func $kalman_propagate_ca (param $xLane i32) (param $pLane i32) (param $dt f64) (param $q f64)
    (local $h f64)
    (local $x0 f64) (local $x1 f64) (local $x2 f64)
    (local $p0 f64) (local $p1 f64) (local $p2 f64) (local $p3 f64) (local $p4 f64)
    (local $p5 f64) (local $p6 f64) (local $p7 f64) (local $p8 f64)
    (local $f0 f64) (local $f1 f64) (local $f2 f64) (local $f3 f64) (local $f4 f64)
    (local $f5 f64) (local $f6 f64) (local $f7 f64) (local $f8 f64)
    (local $dt2 f64) (local $dt3 f64) (local $dt4 f64) (local $dt5 f64)
    (local.set $h (f64.mul (f64.mul (f64.const 0.5) (local.get $dt)) (local.get $dt)))
    (local.set $x0 (f64.load align=1 (local.get $xLane)))
    (local.set $x1 (f64.load align=1 (i32.add (local.get $xLane) (i32.const 8))))
    (local.set $x2 (f64.load align=1 (i32.add (local.get $xLane) (i32.const 16))))
    ;; x0' = x0 + dt*x1 + h*x2 ; x1' = x1 + dt*x2 ; x2 unchanged
    (f64.store align=1 (local.get $xLane)
      (f64.add (f64.add (local.get $x0) (f64.mul (local.get $dt) (local.get $x1)))
        (f64.mul (local.get $h) (local.get $x2))))
    (f64.store align=1 (i32.add (local.get $xLane) (i32.const 8))
      (f64.add (local.get $x1) (f64.mul (local.get $dt) (local.get $x2))))
    (local.set $p0 (f64.load align=1 (local.get $pLane)))
    (local.set $p1 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 8))))
    (local.set $p2 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 16))))
    (local.set $p3 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 24))))
    (local.set $p4 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 32))))
    (local.set $p5 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 40))))
    (local.set $p6 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 48))))
    (local.set $p7 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 56))))
    (local.set $p8 (f64.load align=1 (i32.add (local.get $pLane) (i32.const 64))))
    ;; FP = F·P  (f0..f8 row-major)
    (local.set $f0 (f64.add (f64.add (local.get $p0) (f64.mul (local.get $dt) (local.get $p3))) (f64.mul (local.get $h) (local.get $p6))))
    (local.set $f1 (f64.add (f64.add (local.get $p1) (f64.mul (local.get $dt) (local.get $p4))) (f64.mul (local.get $h) (local.get $p7))))
    (local.set $f2 (f64.add (f64.add (local.get $p2) (f64.mul (local.get $dt) (local.get $p5))) (f64.mul (local.get $h) (local.get $p8))))
    (local.set $f3 (f64.add (local.get $p3) (f64.mul (local.get $dt) (local.get $p6))))
    (local.set $f4 (f64.add (local.get $p4) (f64.mul (local.get $dt) (local.get $p7))))
    (local.set $f5 (f64.add (local.get $p5) (f64.mul (local.get $dt) (local.get $p8))))
    (local.set $f6 (local.get $p6))
    (local.set $f7 (local.get $p7))
    (local.set $f8 (local.get $p8))
    (local.set $dt2 (f64.mul (local.get $dt) (local.get $dt)))
    (local.set $dt3 (f64.mul (local.get $dt2) (local.get $dt)))
    (local.set $dt4 (f64.mul (local.get $dt3) (local.get $dt)))
    (local.set $dt5 (f64.mul (local.get $dt4) (local.get $dt)))
    ;; P[0] = (f0 + dt*f1 + h*f2) + q*dt5/20
    (f64.store align=1 (local.get $pLane)
      (f64.add (f64.add (f64.add (local.get $f0) (f64.mul (local.get $dt) (local.get $f1))) (f64.mul (local.get $h) (local.get $f2)))
        (f64.div (f64.mul (local.get $q) (local.get $dt5)) (f64.const 20))))
    ;; P[1] = (f1 + dt*f2) + q*dt4/8
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 8))
      (f64.add (f64.add (local.get $f1) (f64.mul (local.get $dt) (local.get $f2)))
        (f64.div (f64.mul (local.get $q) (local.get $dt4)) (f64.const 8))))
    ;; P[2] = f2 + q*dt3/6
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 16))
      (f64.add (local.get $f2) (f64.div (f64.mul (local.get $q) (local.get $dt3)) (f64.const 6))))
    ;; P[3] = (f3 + dt*f4 + h*f5) + q*dt4/8
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 24))
      (f64.add (f64.add (f64.add (local.get $f3) (f64.mul (local.get $dt) (local.get $f4))) (f64.mul (local.get $h) (local.get $f5)))
        (f64.div (f64.mul (local.get $q) (local.get $dt4)) (f64.const 8))))
    ;; P[4] = (f4 + dt*f5) + q*dt3/3
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 32))
      (f64.add (f64.add (local.get $f4) (f64.mul (local.get $dt) (local.get $f5)))
        (f64.div (f64.mul (local.get $q) (local.get $dt3)) (f64.const 3))))
    ;; P[5] = f5 + q*dt2/2
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 40))
      (f64.add (local.get $f5) (f64.div (f64.mul (local.get $q) (local.get $dt2)) (f64.const 2))))
    ;; P[6] = (f6 + dt*f7 + h*f8) + q*dt3/6
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 48))
      (f64.add (f64.add (f64.add (local.get $f6) (f64.mul (local.get $dt) (local.get $f7))) (f64.mul (local.get $h) (local.get $f8)))
        (f64.div (f64.mul (local.get $q) (local.get $dt3)) (f64.const 6))))
    ;; P[7] = (f7 + dt*f8) + q*dt2/2
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 56))
      (f64.add (f64.add (local.get $f7) (f64.mul (local.get $dt) (local.get $f8)))
        (f64.div (f64.mul (local.get $q) (local.get $dt2)) (f64.const 2))))
    ;; P[8] = f8 + q*dt
    (f64.store align=1 (i32.add (local.get $pLane) (i32.const 64))
      (f64.add (local.get $f8) (f64.mul (local.get $q) (local.get $dt))))
  )

  ;; CA ingest: per lane, propagate (if dt>0) then position + optional velocity
  ;; + optional acceleration scalar updates. Mirrors StatePredictor.ingest "ca".
  (func $kalman_ingest_ca_f64 (export "kalman_ingest_ca_f64")
        (param $xOff i32) (param $pOff i32) (param $posOff i32) (param $velOff i32) (param $accOff i32)
        (param $n i32) (param $dt f64) (param $q f64) (param $rp f64) (param $rv f64) (param $ra f64)
        (param $useVel i32) (param $useAcc i32) (param $scratch i32)
    (local $i i32) (local $xLane i32) (local $pLane i32) (local $lo i32)
    (local.set $i (i32.const 0))
    (block $exit (loop $loop
      (br_if $exit (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $xLane (i32.add (local.get $xOff) (i32.mul (local.get $i) (i32.const 24))))
      (local.set $pLane (i32.add (local.get $pOff) (i32.mul (local.get $i) (i32.const 72))))
      (local.set $lo (i32.shl (local.get $i) (i32.const 3)))
      (if (f64.gt (local.get $dt) (f64.const 0))
        (then (call $kalman_propagate_ca (local.get $xLane) (local.get $pLane) (local.get $dt) (local.get $q))))
      (call $kalman_update (local.get $xLane) (local.get $pLane) (i32.const 3) (i32.const 0)
        (f64.load align=1 (i32.add (local.get $posOff) (local.get $lo))) (local.get $rp) (local.get $scratch))
      (if (local.get $useVel)
        (then (call $kalman_update (local.get $xLane) (local.get $pLane) (i32.const 3) (i32.const 1)
          (f64.load align=1 (i32.add (local.get $velOff) (local.get $lo))) (local.get $rv) (local.get $scratch))))
      (if (local.get $useAcc)
        (then (call $kalman_update (local.get $xLane) (local.get $pLane) (i32.const 3) (i32.const 2)
          (f64.load align=1 (i32.add (local.get $accOff) (local.get $lo))) (local.get $ra) (local.get $scratch))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
  )

  ;; CA predict: value = p + dt·v + ½dt²·a ; variance = (F P Fᵀ)₀₀ + q·dt⁵/20.
  (func $kalman_predict_ca_f64 (export "kalman_predict_ca_f64")
        (param $xOff i32) (param $pOff i32) (param $valOff i32) (param $varOff i32)
        (param $n i32) (param $dt f64) (param $q f64)
    (local $i i32) (local $xp i32) (local $pp i32) (local $h f64)
    (local $fp0 f64) (local $fp1 f64) (local $fp2 f64) (local $dt2 f64) (local $dt5 f64)
    (local.set $h (f64.mul (f64.mul (f64.const 0.5) (local.get $dt)) (local.get $dt)))
    (local.set $i (i32.const 0))
    (block $exit (loop $loop
      (br_if $exit (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $xp (i32.add (local.get $xOff) (i32.mul (local.get $i) (i32.const 24))))
      (local.set $pp (i32.add (local.get $pOff) (i32.mul (local.get $i) (i32.const 72))))
      ;; value = x0 + dt*x1 + h*x2
      (f64.store align=1 (i32.add (local.get $valOff) (i32.shl (local.get $i) (i32.const 3)))
        (f64.add
          (f64.add (f64.load align=1 (local.get $xp))
            (f64.mul (local.get $dt) (f64.load align=1 (i32.add (local.get $xp) (i32.const 8)))))
          (f64.mul (local.get $h) (f64.load align=1 (i32.add (local.get $xp) (i32.const 16))))))
      ;; fp0 = P0 + dt*P3 + h*P6
      (local.set $fp0 (f64.add (f64.add (f64.load align=1 (local.get $pp))
        (f64.mul (local.get $dt) (f64.load align=1 (i32.add (local.get $pp) (i32.const 24)))))
        (f64.mul (local.get $h) (f64.load align=1 (i32.add (local.get $pp) (i32.const 48))))))
      ;; fp1 = P1 + dt*P4 + h*P7
      (local.set $fp1 (f64.add (f64.add (f64.load align=1 (i32.add (local.get $pp) (i32.const 8)))
        (f64.mul (local.get $dt) (f64.load align=1 (i32.add (local.get $pp) (i32.const 32)))))
        (f64.mul (local.get $h) (f64.load align=1 (i32.add (local.get $pp) (i32.const 56))))))
      ;; fp2 = P2 + dt*P5 + h*P8
      (local.set $fp2 (f64.add (f64.add (f64.load align=1 (i32.add (local.get $pp) (i32.const 16)))
        (f64.mul (local.get $dt) (f64.load align=1 (i32.add (local.get $pp) (i32.const 40)))))
        (f64.mul (local.get $h) (f64.load align=1 (i32.add (local.get $pp) (i32.const 64))))))
      (local.set $dt2 (f64.mul (local.get $dt) (local.get $dt)))
      (local.set $dt5 (f64.mul (f64.mul (local.get $dt2) (local.get $dt2)) (local.get $dt)))
      ;; var = (fp0 + dt*fp1 + h*fp2) + q*dt5/20
      (f64.store align=1 (i32.add (local.get $varOff) (i32.shl (local.get $i) (i32.const 3)))
        (f64.add
          (f64.add (f64.add (local.get $fp0) (f64.mul (local.get $dt) (local.get $fp1)))
            (f64.mul (local.get $h) (local.get $fp2)))
          (f64.div (f64.mul (local.get $q) (local.get $dt5)) (f64.const 20))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
  )
)
