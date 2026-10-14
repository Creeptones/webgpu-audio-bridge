/**
 * apiSurface — pins for the member-level API snapshot generator (0.9.948).
 *
 * Run: tsx tests/apiSurface.test.ts
 *
 * The 1.0 freeze gate (`npm run check:api-snapshot`) is only as good as the
 * extractor behind it (scripts/_apiSurface.mjs). These pins run it on two
 * fixtures that differ by ONE renamed method on a class reachable only through
 * a type alias (the `Bridge` → `BridgeImpl` shape) and assert:
 *
 *   1. the rename changes the snapshot (the old export-line snapshot missed it);
 *   2. members of a NON-exported class behind an exported alias are captured;
 *   3. private / protected members are excluded, public readonly props kept;
 *   4. @deprecated members/exports are marked;
 *   5. the real root snapshot covers `Bridge`'s instance methods.
 */

import { assert, ok } from "./_assert.js";
// @ts-expect-error — plain .mjs script, no type declarations.
import { apiSurface } from "../scripts/_apiSurface.mjs";

type Surface = { names: string[]; text: string };
const ENTRIES = [
  "tests/fixtures/apiSurface/v1.ts",
  "tests/fixtures/apiSurface/v2.ts",
  "src/index.ts",
];
const v1 = apiSurface(ENTRIES[0], ENTRIES) as Surface;
const v2 = apiSurface(ENTRIES[1], ENTRIES) as Surface;

assert(v1.text !== v2.text, "renaming a method on an alias-reachable class changes the snapshot");
assert(/^\s+read\(out: T\[\]\) => number$/m.test(v1.text), `v1 lists read(): \n${v1.text}`);
assert(/^\s+readInto\(out: T\[\]\) => number$/m.test(v2.text), "v2 lists readInto()");
assert(!/^\s+read\(/m.test(v2.text), "v2 no longer lists read()");
ok("1 a renamed public method changes the snapshot");

assert(/^class Impl<T> \(internal, /m.test(v1.text), "non-exported Impl behind the Handle alias is captured");
ok("2 internal class reachable through an exported alias is snapshotted");

assert(!/secret|guarded/.test(v1.text), "private/protected members excluded");
assert(/^\s+readonly name: string$/m.test(v1.text), "public readonly parameter property kept");
ok("3 private/protected excluded; public readonly kept");

assert(/^\s+legacy\(\) => void @deprecated$/m.test(v1.text), "@deprecated member marked");
ok("4 @deprecated members are marked");

const root = apiSurface("src/index.ts", ENTRIES) as Surface;
for (const m of ["pullLatest", "pullHermiteLatest", "readPublishedPllState", "telemetry"]) {
  assert(new RegExp(`^class BridgeImpl<[^\\n]*\\n(?:  [^\\n]*\\n)*  ${m}\\(`, "m").test(root.text), `root snapshot lists BridgeImpl.${m}`);
}
ok("5 root snapshot covers Bridge's instance methods (via BridgeImpl)");

console.log("\nAll apiSurface pins passed.");
