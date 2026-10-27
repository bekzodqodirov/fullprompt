/**
 * «Is this code a carton of a lot the plan still owes from the road?» —
 * decided on the phone from the loading snapshot (docs/YOLDAGI-YUK.md §9), so
 * the loader hears it at once and offline. Browser-safe: no imports.
 *
 *  - free on this shelf: accepted while this phone has taken fewer of its lot
 *    than the lot owes, and the server claims it; past that it is an extra
 *    like any other (`null` — the red confirm);
 *  - still on an inbound truck: refused at once with that truck's code.
 *    Accepted green and taken back at the flush, a carton physically loaded
 *    went unrecorded (#221, review numbers#5).
 */
export interface RoadSnapshotView {
  roadOwed?: readonly { lotId: string; owed: number }[];
  roadShelf?: readonly { code: string; lotId: string }[];
  roadInbound?: readonly { code: string; truck: string }[];
}

export type RoadScan = { kind: 'accept' } | { kind: 'inbound'; truck: string } | null;

export function roadScanVerdict(code: string, snap: RoadSnapshotView, loaded: ReadonlySet<string>): RoadScan {
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
  return inbound ? { kind: 'inbound', truck: inbound.truck } : null;
}
