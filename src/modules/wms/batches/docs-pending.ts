import { aliasedTable, and, eq, inArray, isNull, not, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, warehouses } from '../../platform/db/schema';
import { sameCountryLegSql } from './internal';

/**
 * «The papers have not reached the agent» — ONE sentence for the VED home's
 * company-wide count and the truck card's own «Agentga yuborilmagan» item
 * (#513), so the number on his home is the number of trucks whose card says
 * so.
 *
 * A truck that has left without its papers reaching the agent is the thing
 * the VED gets phoned about; unloaded means customs is behind it. An internal
 * leg (Yiwu → Kashgar, Andijan → Tashkent) carries no export papers to send,
 * so it is not his phone call either. Three-valued on purpose, as the home's
 * count always was: a warehouse with no country makes `sameCountryLegSql`
 * NULL, `NOT NULL` is NULL, and such a truck is not pending.
 *
 * `origin` / `dest` are the two warehouse table references the query joined.
 */
export function docsPendingWhere(origin: SQL, dest: SQL): SQL {
  return and(
    inArray(batches.status, ['in_transit', 'arrived']),
    isNull(batches.sentToAgentAt),
    not(sameCountryLegSql(origin, dest)),
  )!;
}

/** The same sentence asked of one truck. */
export async function batchDocsPending(batchId: string): Promise<boolean> {
  const originWh = aliasedTable(warehouses, 'origin_wh');
  const destWh = aliasedTable(warehouses, 'dest_wh');
  const rows = await db
    .select({ id: batches.id })
    .from(batches)
    .innerJoin(originWh, eq(batches.originWarehouseId, originWh.id))
    .innerJoin(destWh, eq(batches.destWarehouseId, destWh.id))
    .where(and(eq(batches.id, batchId), docsPendingWhere(sql`${originWh}`, sql`${destWh}`)));
  return rows.length > 0;
}
