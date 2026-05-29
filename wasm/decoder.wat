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
    end))
