/**
 * Tiny assertion helpers for standalone tsx-script tests.
 *
 * No test framework — tests run with `tsx <file>` and exit non-zero on the
 * first failure. Each test file calls its own main(). This mirrors the
 * convention used in the source project the ring buffer was extracted from.
 */

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

export function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    console.error(
      `FAIL: ${msg}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`,
    );
    process.exitCode = 1;
    throw new Error(msg);
  }
}

export function ok(label: string): void {
  console.log("OK ", label);
}
