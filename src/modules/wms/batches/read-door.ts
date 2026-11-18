/**
 * Who may read about trucks at all — ONE list for every screen that shows
 * them.
 *
 * It existed three times before it existed once: `wms/search` kept it as
 * BATCH_READERS, round 105 restated it on /transit, and /trucks and /map kept
 * no door at all — any signed-in login read every truck in the company, its
 * plate, its route and its per-client contents, and /map added every
 * warehouse's stock broken down by client code. A menu decision is not an
 * access decision (round 47): neither page was in the sales menus, and both
 * answered to anybody who typed the address.
 *
 * The permissions are the batches screen's own door. Warehouse scoping
 * stays each screen's job, because the fence differs by what is drawn: a
 * batch is judged by its TWO ends, stock by where it stands.
 *
 * The first five are each a power to ACT. `batches.view` (2026-11-18) is the
 * one that only reads: the sellers' door to the board, the trucks list,
 * «Yo'lda» and the map (his «sotuvchilarga … furalarga … korishga ruxsat»).
 * Read is all it may ever mean — no action asks this list, the documents keep
 * their own (`documents/route-guard.ts`), and nobody is notified for holding
 * it. Two copies are spelled out in platform (nav.ts, workspaces.ts) because
 * platform must not import wms; `batch-read-door.test.ts` pins them here.
 */
export const BATCH_READERS = [
  'scan.load',
  'scan.unload',
  'ved.docs',
  'plans.manage',
  'batches.depart_close',
  'batches.view',
] as const;

export function mayReadBatches(permissions: { has(code: string): boolean }): boolean {
  return BATCH_READERS.some((code) => permissions.has(code));
}
