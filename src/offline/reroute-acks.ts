import type { SyncAck } from './scan-outbox';

/*
 * Whose «rerouted» is this? (the reroute review.)
 *
 * The phone's outbox is ONE queue for every truck: a flush on truck B's
 * screen sends truck A's leftover rows too, and their answers come back to
 * whichever screen is open. The unload screen took ANY `batch_rerouted` as
 * its own — B's screen then read «this truck goes to HOR, the cargo does not
 * land here» and refused every scan of B until a reload, while B was coming
 * exactly where the operator stood. Pure, so the rule can be pressed by a
 * test with no screen (#166); both scan screens ask it.
 */

export interface ReroutedElsewhere {
  /** The other truck's code — `null` only from a server that did not say. */
  code: string | null;
  /** Where that truck goes now. */
  to: string;
  /** How many of its queued scans came back refused. */
  n: number;
}

export interface RerouteVerdict {
  /** This screen's truck was rerouted: where it goes now. `null` = not this truck. */
  own: string | null;
  /** Other trucks' rows that came back rerouted — named, never latched. */
  elsewhere: ReroutedElsewhere[];
}

/**
 * An ack is THIS truck's only when the flush tagged it with this truck's id
 * from the queued row. An untagged ack is never taken as this screen's: a
 * wrong «not coming here» blocks a real unload, a missed one only leaves the
 * next /planned tick to say it.
 */
export function rerouteVerdict(acks: readonly SyncAck[], batchId: string): RerouteVerdict {
  let own: string | null = null;
  const elsewhere = new Map<string, ReroutedElsewhere>();
  for (const ack of acks) {
    if (ack.result !== 'rejected' || ack.detail !== 'batch_rerouted') continue;
    const to = ack.rerouteTo ?? '—';
    if (ack.batchId === batchId) {
      own = to;
      continue;
    }
    const key = ack.batchId ?? ack.batchCode ?? '?';
    const entry = elsewhere.get(key) ?? { code: ack.batchCode ?? null, to, n: 0 };
    entry.n += 1;
    entry.to = to;
    elsewhere.set(key, entry);
  }
  return { own, elsewhere: [...elsewhere.values()] };
}

/**
 * The snapshot's destination moved away from the one this screen was opened
 * for — said for EVERY viewer (the reroute review): an unscoped logist or an
 * admin gets a 200 from `/planned` at the new warehouse, never the 409 a
 * scoped operator gets, and used to go on scanning with nothing on screen.
 * `null` = no change, or nothing to compare (an older cached snapshot that
 * does not carry the destination).
 */
export function snapshotRerouted(
  base: string | null | undefined,
  fresh: { destWarehouseId?: string | null; destCode?: string | null },
): string | null {
  if (!base || !fresh.destWarehouseId || fresh.destWarehouseId === base) return null;
  return fresh.destCode ?? '—';
}
