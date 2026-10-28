/**
 * «Is this code a carton of a lot the plan still owes from the road?» —
 * decided on the phone from the loading snapshot (docs/YOLDAGI-YUK.md §9, §11),
 * so the loader hears it at once and offline. Browser-safe: no imports.
 *
 *  - free on this shelf: accepted while this phone has taken fewer of its lot
 *    than the lot owes, and the server claims it; past that it is an extra
 *    like any other (`null` — the red confirm). Best-effort: a second phone on
 *    the same truck, or a claim made since the snapshot, is not seen here, and
 *    the server's `not_on_plan` takes such a mark back at the flush;
 *  - on an inbound truck IN THE SNAPSHOT — which is up to fifteen seconds old,
 *    and at Horgos a carton goes from one truck to the next in fewer: the
 *    landing that reserved it onto this truck is invisible here (review of the
 *    fixes, locks#0). So the server decides whenever it can answer at once
 *    (online), and so does a landing THIS phone has queued (the sync lands
 *    before it loads). Only an offline phone with no landing of its own refuses
 *    it, naming the truck — accepted green there and taken back at the flush,
 *    a carton physically loaded would go unrecorded (#221, review numbers#5).
 */
export interface RoadSnapshotView {
  roadOwed?: readonly { lotId: string; owed: number }[];
  roadShelf?: readonly { code: string; lotId: string }[];
  roadInbound?: readonly { code: string; truck: string }[];
}

export interface RoadScanContext {
  /** The screen's last flush reached the server. */
  online: boolean;
  /** Codes (upper-cased) this phone's outbox holds UNLOAD rows for. */
  queuedUnloads: ReadonlySet<string>;
}

export type RoadScan = { kind: 'accept' } | { kind: 'inbound'; truck: string } | null;

export function roadScanVerdict(
  code: string,
  snap: RoadSnapshotView,
  loaded: ReadonlySet<string>,
  ctx: RoadScanContext,
): RoadScan {
  const upper = code.trim().toUpperCase();
  if (!upper) return null;
  const shelf = snap.roadShelf ?? [];
  const onShelf = shelf.find((c) => c.code.toUpperCase() === upper);
  if (onShelf) {
    const owed = (snap.roadOwed ?? []).find((l) => l.lotId === onShelf.lotId)?.owed ?? 0;
    const taken = new Set([...loaded].map((c) => c.toUpperCase()));
    const takenOfLot = shelf.filter((c) => c.lotId === onShelf.lotId && taken.has(c.code.toUpperCase())).length;
    return takenOfLot < owed ? { kind: 'accept' } : null;
  }
  const inbound = (snap.roadInbound ?? []).find((c) => c.code.toUpperCase() === upper);
  if (!inbound) return null;
  if (ctx.online || ctx.queuedUnloads.has(upper)) return { kind: 'accept' };
  return { kind: 'inbound', truck: inbound.truck };
}
