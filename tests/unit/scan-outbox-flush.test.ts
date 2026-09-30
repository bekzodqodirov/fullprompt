import { describe, expect, it } from 'vitest';
import { codesToUnmark } from '@/offline/ack-verdict';
import { MAX_PER_SYNC, flushScansWith, type OutboxScan, type SyncAck } from '@/offline/scan-outbox';

/**
 * The phone's flush LOOP (the reroute round's blocker). The outbox is one
 * queue per phone, and it used to stop at the first 403 — so one queued scan
 * of a truck the phone had lost (rerouted away from this warehouse) stopped
 * every scan behind it, on every truck, loading included, for good. The loop
 * is pressed here with an in-memory queue and a stand-in server, so which
 * answer stops it and which does not is a fact about the code, not a hope.
 */

const A = '00000000-0000-4000-8000-00000000a0aa'; // rerouted away
const B = '00000000-0000-4000-8000-00000000b0bb'; // this warehouse's own
const C = '00000000-0000-4000-8000-00000000c0cc'; // never this warehouse's

let seq = 0;
function row(batchId: string, code = `YW26-${String(++seq).padStart(6, '0')}`): OutboxScan {
  return {
    clientEventUuid: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    batchId,
    code,
    method: 'qr',
    addedOnSpot: false,
    scannedAt: new Date(0).toISOString(),
    scanType: 'unload',
  };
}

/** An in-memory outbox and a server that answers each posted slice with `answer(slice)`. */
function world(rows: OutboxScan[], answer: (slice: OutboxScan[]) => Response) {
  const queue = new Map(rows.map((r) => [r.clientEventUuid, r]));
  const posted: OutboxScan[][] = [];
  return {
    queue,
    posted,
    deps: {
      pending: async () => [...queue.values()],
      remove: async (uuids: string[]) => {
        for (const uuid of uuids) queue.delete(uuid);
      },
      post: async (slice: OutboxScan[]) => {
        posted.push(slice);
        return answer(slice);
      },
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('flushScansWith', () => {
  it('a rerouted truck’s rows are answered, leave the queue, and their marks come back off', async () => {
    const mine = [row(B), row(B)];
    const lost = [row(A), row(A), row(A)];
    const w = world([...mine, ...lost], () =>
      json({
        acks: [
          ...mine.map((r): SyncAck => ({ clientEventUuid: r.clientEventUuid, result: 'ok' })),
          ...lost.map(
            (r): SyncAck => ({
              clientEventUuid: r.clientEventUuid,
              result: 'rejected',
              detail: 'batch_rerouted',
              scannedCode: r.code,
              rerouteTo: 'AND',
            }),
          ),
        ],
        withheld: [],
      }),
    );
    const result = await flushScansWith(w.deps);
    expect(w.queue.size).toBe(0);
    expect(result.refusedForbidden).toBe(false);
    expect(result.withheld).toBe(0);
    expect(codesToUnmark(result.acks).sort()).toEqual(lost.map((r) => r.code).sort());
  });

  it('a 403 slice does not stop the next one — it is sent', async () => {
    // Slice one is 200 rows of a truck that is nobody's here; slice two is ours.
    const foreign = Array.from({ length: MAX_PER_SYNC }, () => row(C));
    const ours = row(B);
    const w = world([...foreign, ours], (slice) =>
      slice.every((r) => r.batchId === C)
        ? json({ error: 'forbidden', withheld: [C] }, 403)
        : json({ acks: [{ clientEventUuid: ours.clientEventUuid, result: 'ok' }], withheld: [] }),
    );
    const result = await flushScansWith(w.deps);
    expect(w.posted).toHaveLength(2);
    expect(w.queue.has(ours.clientEventUuid)).toBe(false);
    // The foreign rows stay — never dropped — and are counted.
    expect(w.queue.size).toBe(MAX_PER_SYNC);
    expect(result.withheld).toBe(MAX_PER_SYNC);
    expect(result.refusedForbidden).toBe(true);
  });

  it('a 401 stops the loop: nothing after it can go either', async () => {
    const rows = Array.from({ length: MAX_PER_SYNC + 1 }, () => row(B));
    const w = world(rows, () => json({ error: 'unauthenticated' }, 401));
    const result = await flushScansWith(w.deps);
    expect(w.posted).toHaveLength(1);
    expect(w.queue.size).toBe(MAX_PER_SYNC + 1);
    expect(result.refusedForbidden).toBe(true);
  });

  it('withheld rows inside an answered body stay queued and are counted', async () => {
    const ours = row(B);
    const held = [row(C), row(C)];
    const w = world([ours, ...held], () =>
      json({ acks: [{ clientEventUuid: ours.clientEventUuid, result: 'ok' }], withheld: [C] }),
    );
    const result = await flushScansWith(w.deps);
    expect([...w.queue.keys()].sort()).toEqual(held.map((r) => r.clientEventUuid).sort());
    expect(result.withheld).toBe(2);
    expect(result.refusedForbidden).toBe(false);
  });
});
