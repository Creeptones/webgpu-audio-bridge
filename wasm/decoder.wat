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
    i32.atomic.load))
