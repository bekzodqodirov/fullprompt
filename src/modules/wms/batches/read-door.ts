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
 * The five permissions are the batches screen's own door. Warehouse scoping
 * stays each screen's job, because the fence differs by what is drawn: a
 * batch is judged by its TWO ends, stock by where it stands.
 */
export const BATCH_READERS = [
  'scan.load',
  'scan.unload',
  'ved.docs',
  'plans.manage',
  'batches.depart_close',
] as const;

export function mayReadBatches(permissions: { has(code: string): boolean }): boolean {
  return BATCH_READERS.some((code) => permissions.has(code));
}
