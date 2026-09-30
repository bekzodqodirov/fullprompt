import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { batches, warehouses } from '../../platform/db/schema';
import type { Actor } from '../../platform/rbac/authorize';
import { mayAt } from '../../platform/rbac/scope';
import { formerDestinationsFor } from '../batches/reroute';
import { lostThroughReroute } from '../batches/reroute-rules';
import { NO_DOOR } from './count-rules';
import { ingestLoadScans, loadScanSchema, type ScanAck } from './service';
import { ingestUnloadScans, type UnloadAck } from './unload';

/*
 * The phone's offline outbox, landed (spec §15, edge cases 13/14) — the body
 * of `/api/scan/sync`, moved out of the route so it can be pressed by a test.
 *
 * PER TRUCK, never per body (the reroute round's blocker). The route used to
 * authorize every truck named in the body and answer 403 for the WHOLE body
 * on the first one the person could not act at — and the outbox is one
 * global queue per phone that stops on a 403. So one queued scan of a truck
 * that was rerouted away from this warehouse jammed every scan behind it, on
 * every truck, loading included, for good: its green marks stayed green, and
 * the next «Yuklash tugadi» on another truck declared cartons that were on it
 * left behind (#221/#626's failure). Now each truck is admitted, answered row
 * by row, or withheld:
 *
 *  - a truck that is not there → each row `rejected / batch_not_found` (it
 *    used to be a whole-body 404, the same jam);
 *  - load rows need `scan.load` at the ORIGIN, unload rows `scan.unload` at
 *    the LIVE destination — `mayAt`, `authorize`'s own rule as a predicate;
 *  - an unload row for a truck the person lost THROUGH A REROUTE → each row
 *    `rejected / batch_rerouted` with `rerouteTo`: the phone takes its marks
 *    back, says where the truck went, and the rows leave the queue;
 *  - anything else the person may not touch → `withheld`: the rows stay
 *    queued (a real scan is never dropped because a right is missing) and
 *    the phone says so, but they no longer block the others.
 *
 * Every admitted unload row carries the destination it was admitted AT
 * (`expectDest`), which the ingest compares again under the truck's lock — a
 * reroute committing between this read and the landing refuses the row
 * instead of landing it at a warehouse this person was never authorized at.
 */

export const syncItemSchema = loadScanSchema.extend({
  scanType: z.enum(['load', 'unload']).default('load'),
});
export const syncBodySchema = z.object({ scans: z.array(syncItemSchema).min(1).max(200) });
export type SyncItem = z.infer<typeof syncItemSchema>;

export type SyncAckOut = (ScanAck | UnloadAck) & { rerouteTo?: string };

export interface SyncResult {
  acks: SyncAckOut[];
  /** The trucks (ids) this person may not touch — their rows stay on the phone. */
  withheld: string[];
}

export async function syncScans(
  actor: Actor,
  scans: SyncItem[],
  meta: { ip: string | null; userAgent: string | null },
): Promise<SyncResult> {
  const ids = [...new Set(scans.map((s) => s.batchId))];
  const rows = ids.length
    ? await db
        .select({
          id: batches.id,
          originWarehouseId: batches.originWarehouseId,
          destWarehouseId: batches.destWarehouseId,
        })
        .from(batches)
        .where(inArray(batches.id, ids))
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  const acks: SyncAckOut[] = [];
  const withheld = new Set<string>();
  const loads: SyncItem[] = [];
  const unloads: SyncItem[] = [];
  const refusedUnloads: SyncItem[] = [];
  const expectDest = new Map<string, string>();

  for (const scan of scans) {
    const truck = byId.get(scan.batchId);
    if (!truck) {
      acks.push({
        clientEventUuid: scan.clientEventUuid,
        result: 'rejected',
        detail: 'batch_not_found',
        scannedCode: scan.code,
      });
      continue;
    }
    if (scan.scanType === 'load') {
      if (mayAt(actor, 'scan.load', truck.originWarehouseId)) loads.push(scan);
      else withheld.add(truck.id);
      continue;
    }
    if (mayAt(actor, 'scan.unload', truck.destWarehouseId)) {
      unloads.push(scan);
      expectDest.set(truck.id, truck.destWarehouseId);
    } else {
      refusedUnloads.push(scan);
    }
  }

  // ONE read of the reroute history for every truck the person was refused
  // at: a truck they lost through a reroute is answered, anything else held.
  if (refusedUnloads.length > 0) {
    const refusedIds = [...new Set(refusedUnloads.map((s) => s.batchId))];
    const former = await formerDestinationsFor(refusedIds);
    const lost = refusedIds.filter((id) =>
      lostThroughReroute(actor, 'scan.unload', former.get(id) ?? [], byId.get(id)!.destWarehouseId),
    );
    const codes = lost.length
      ? new Map(
          (
            await db
              .select({ id: warehouses.id, code: warehouses.code })
              .from(warehouses)
              .where(inArray(warehouses.id, [...new Set(lost.map((id) => byId.get(id)!.destWarehouseId))]))
          ).map((w) => [w.id, w.code]),
        )
      : new Map<string, string>();
    const lostSet = new Set(lost);
    for (const scan of refusedUnloads) {
      if (!lostSet.has(scan.batchId)) {
        withheld.add(scan.batchId);
        continue;
      }
      const to = codes.get(byId.get(scan.batchId)!.destWarehouseId);
      acks.push({
        clientEventUuid: scan.clientEventUuid,
        result: 'rejected',
        detail: 'batch_rerouted',
        scannedCode: scan.code,
        ...(to ? { rerouteTo: to } : {}),
      });
    }
  }

  const ctx = { actorId: actor.id, ...meta };
  if (loads.length) acks.push(...(await ingestLoadScans(loads, ctx)));
  if (unloads.length) acks.push(...(await ingestUnloadScans(unloads, ctx, NO_DOOR, { expectDest })));
  return { acks, withheld: [...withheld] };
}
