# Changelog

All notable changes to this project will be documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-05-25

### Changed
- `pull()` and `pullLatest()` no longer perform a second `Atomics.load(write_index)` re-check after copying the payload. Under the library's strict push contract (`push()` refuses when `write_index − read_index ≥ capacity`), the producer cannot advance `write_index` past `read_index + capacity`, so the slot offsets `(write_index & mask)` and `(read_index & mask)` cannot collide while there is an unread frame. The re-check was guarding an impossibility and is removed. `pull()` returns `false` only on empty; `pullLatest()` returns `-1` only on empty. Callers that previously treated the second-`false`/`-1` case as "torn" continue to work — that path was unreachable under the conforming contract.
- README "Memory ordering" section updated to reflect the simpler protocol.
- `testTornFrameDetection` removed from the test suite — it tested the now-deleted code path. Test count 12 → 11.

### Fixed
- README CPU-overhead figure was misstated as `~0.000006%` at 60 Hz (raw ratio written with a `%` sign, plus an extra zero); corrected to `~0.006%` of one core in 0.1.0 README via README-only patch on the 0.1.0 tag's main branch. Restated here for the version-bound CHANGELOG record.

### Documentation
- Added secondary cite to public [gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432) alongside the Chromium tracker for the 5–15 ms `mapAsync` claim.
- Clarified that ECMA-262 only defines sequentially-consistent atomics; the release/acquire description names the protocol shape, not the underlying primitive.

## [0.1.0] — 2026-05-25

Initial release.

### Added
- `Float64RingBuffer` — lock-free SPSC ring over `SharedArrayBuffer`.
  - BigInt64 monotonic-forever indices via `Atomics`.
  - Frame-oriented layout: `[seq, tMacroNs, vMax, jMax, V_eff[N], J_eff[N]]` per slot.
  - `push()`, `pull()`, `pullLatest()`, `available()` API.
  - Torn-frame re-check on both read paths.
  - Static `allocate()` and `byteLength()` helpers.
- 12-pin property-test suite including a 10,000-iteration mulberry32-seeded fuzz against an oracle queue.
- Microbenchmark reporting push / pull / pullLatest median, p99, and mean.
- Documentation of the macro / micro control-rate-GPU / audio-rate-CPU architectural pattern.
