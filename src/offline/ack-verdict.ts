import type { SyncAck } from './scan-outbox';

/**
 * Which codes the screen must stop showing as scanned.
 *
 * The phone marks a code done the instant it is scanned, because the whole
 * point of the offline queue is that there is nothing to ask at that moment.
 * The rule that was missing is the other direction: **every path that puts a
 * code into `done` needs a path that takes it back out.** A queue flushed
 * after the logist has pressed «Tushirish tugadi» comes back
 * `rejected / batch_not_unloading` for every row — the screen went on reading
 * 150/150 with every lot line green, one dark toast (a single slot,
 * overwritten by the next) as the whole of the telling, while those 150
 * cartons stood in the warehouse recorded as missing in transit.
 *
 * `not_on_plan` is deliberately NOT here: that one opens a confirm and the
 * operator decides, so the mark is still live. `duplicate` is not either — it
 * means the box is already recorded, which is the state the green mark
 * claims.
 */
export function codesToUnmark(acks: SyncAck[]): string[] {
  const out: string[] = [];
  for (const ack of acks) {
    if (ack.result !== 'rejected' && ack.result !== 'unknown_code') continue;
    if (ack.scannedCode) out.push(ack.scannedCode);
  }
  return out;
}
