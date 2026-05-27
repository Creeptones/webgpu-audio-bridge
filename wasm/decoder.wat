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

  ;; pullLatest peek: latest-frame drain with skip semantics.
  ;; Param:  $mask = capacity − 1 (power-of-two ring; computed JS-side once).
  ;; Returns: slot index (≥ 0) of the newest available frame, or -1 if empty.
  ;; Side effect: saves the observed writeIdx into $pendingNewReadIdx so
  ;;              commit_pull_latest knows what to release.
  (func $peek_pull_latest (export "peek_pull_latest") (param $mask i32) (result i32)
    (local $writeIdx i32)
    (local $readIdx i32)
    ;; readIdx: plain non-atomic read of lane 1 (single-consumer guarantee
    ;; means we own this lane until our commit).
    i32.const 4
    i32.load
    local.set $readIdx
    ;; writeIdx: acquire load of lane 0.
    i32.const 0
    i32.atomic.load
    local.set $writeIdx
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
    memory.copy))
