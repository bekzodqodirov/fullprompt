import type { CountOnlyLot } from './count-only';

/**
 * Which codes the loading screen shows as ON the truck, after a snapshot
 * arrives (0112). Browser-safe: no server imports.
 *
 * For a lot a phone scans, «loaded» only ever GROWS between snapshots — a
 * code the loader just scanned is marked before the server has heard of it,
 * and a snapshot fetched a second earlier must not take that mark away.
 *
 * A lot the OFFICE counts is the opposite: nobody on this phone marks its
 * cartons, and the office may dial its number DOWN. So for those cartons the
 * server's word is the whole truth — aboard when the snapshot says so, off
 * when it does not — or a count lowered from 48 to 40 would go on reading 48
 * here until the page was reloaded. Crated cartons stay the phone's (a crate
 * is scanned as the crate), and a count-only lot's siblings at the origin are
 * never on this truck's screen.
 */
export interface MergeBox {
  shortCode: string;
  status: string;
  lotId: string;
  crateCode?: string | null;
}

const ABOARD = new Set(['loading', 'in_transit']);

export function mergeLoaded(
  prev: ReadonlySet<string>,
  boxes: readonly MergeBox[],
  countOnly?: readonly CountOnlyLot[],
): Set<string> {
  const next = new Set(prev);
  const office = new Set((countOnly ?? []).map((lot) => lot.lotId));
  for (const box of boxes) {
    const aboard = ABOARD.has(box.status);
    if (office.has(box.lotId) && !box.crateCode) {
      if (aboard) next.add(box.shortCode);
      else next.delete(box.shortCode);
    } else if (aboard) {
      next.add(box.shortCode);
    }
  }
  for (const lot of countOnly ?? []) {
    for (const code of lot.siblings) {
      next.delete(code);
      next.delete(code.toUpperCase());
    }
  }
  return next;
}
