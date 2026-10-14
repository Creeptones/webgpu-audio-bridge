/**
 * Shared 2^31 ticket-wrap regression driver for MpmcWorkQueue (JS) and
 * WasmMpmcWorkQueue (0.9.947). White-box: re-seeds the header + per-slot
 * stamps so the queue starts `ticketsBeforeWrap` tickets below the Int32 wrap
 * (a state a long-lived queue reaches after ~2^31 frames), then drives real
 * push/pull traffic across it. Before 0.9.947 `pull` treated any negative
 * claim as "empty": the first claim past the wrap advanced `dequeueTicket`,
 * was dropped, and the queue wedged into drop-newest.
 */
import { assert, assertEq } from "./_assert.js";

interface WrapQueue {
  readonly capacity: number;
  push(frame: Record<string, unknown>): boolean;
  pull(out: Record<string, unknown>): boolean;
  droppedFrames(): number;
}

export function driveAcrossTicketWrap(
  queue: WrapQueue,
  sab: SharedArrayBuffer,
  genByteOffset: number,
  frame: Record<string, unknown>,
  out: Record<string, unknown>,
  seqField: string,
  label: string,
  ticketsBeforeWrap = 5,
): void {
  const cap = queue.capacity;
  const header = new Int32Array(sab, 0, 8);
  const gen = new Int32Array(sab, genByteOffset, cap);
  const base = (0x7fffffff - ticketsBeforeWrap + 1) | 0; // wrap lands mid-run
  Atomics.store(header, 0, base); // enqueueTicket
  Atomics.store(header, 1, base); // dequeueTicket
  Atomics.store(header, 2, base); // committedFrontier
  for (let k = 0; k < cap; k++) {
    const t = (base + k) | 0;
    Atomics.store(gen, (t >>> 0) & (cap - 1), t); // Free(t)
  }
  const total = cap * 4;
  let next = 0;
  let got = 0;
  for (let i = 0; i < total; i++) {
    frame[seqField] = i;
    assert(queue.push(frame), `${label}: push ${i} accepted (ticket ${(base + i) | 0})`);
    assert(queue.pull(out), `${label}: pull ${i} delivers (ticket ${(base + i) | 0})`);
    assertEq(out[seqField], next, `${label}: FIFO across the wrap`);
    next++;
    got++;
  }
  assertEq(got, total, `${label}: every frame delivered across the 2^31 wrap`);
  assertEq(queue.droppedFrames(), 0, `${label}: nothing dropped across the wrap`);
  assert((Atomics.load(header, 1) | 0) < 0, `${label}: dequeueTicket actually crossed into negative tickets`);
}
