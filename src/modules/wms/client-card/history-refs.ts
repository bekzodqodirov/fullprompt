import { inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, handovers } from '../../platform/db/schema';

/**
 * What the client card's «Topshirilgan» list needs beside the Mini App's
 * history and the Mini App must never be sent: each handover's WAREHOUSE
 * (the act's door is the warehouse's, `documents/handover-act-door.ts`) and
 * each leg's TRUCK with its two ends (a truck code is linked only when the
 * truck card's door admits). `issuedHandovers` is the customer's wire shape
 * and stays as it is; the office resolves these two beside it, one statement
 * each. A leg names its truck by CODE, which is unique, so the lookup is
 * exact.
 */
export interface HistoryRefs {
  handoverWarehouse: Map<string, string>;
  truckByCode: Map<string, { id: string; originWarehouseId: string; destWarehouseId: string }>;
}

export async function historyRefs(handoverIds: string[], legCodes: string[]): Promise<HistoryRefs> {
  const hIds = [...new Set(handoverIds)];
  const codes = [...new Set(legCodes)];
  const [hRows, bRows] = await Promise.all([
    hIds.length
      ? db
          .select({ id: handovers.id, warehouseId: handovers.warehouseId })
          .from(handovers)
          .where(inArray(handovers.id, hIds))
      : Promise.resolve([] as { id: string; warehouseId: string }[]),
    codes.length
      ? db
          .select({
            id: batches.id,
            code: batches.code,
            originWarehouseId: batches.originWarehouseId,
            destWarehouseId: batches.destWarehouseId,
          })
          .from(batches)
          .where(inArray(batches.code, codes))
      : Promise.resolve([] as { id: string; code: string; originWarehouseId: string; destWarehouseId: string }[]),
  ]);
  return {
    handoverWarehouse: new Map(hRows.map((r) => [r.id, r.warehouseId])),
    truckByCode: new Map(bRows.map((r) => [r.code, r])),
  };
}
