import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { batches } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { placeCargo } from '@/modules/wms/tracking/place-cargo';

/**
 * One place's cargo, lot by lot, for the staff map's popup. The map page's
 * own door (`mayReadBatches`) and its own fences: a warehouse is judged by
 * where the cargo stands, a truck by its TWO ends.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  if (!mayReadBatches(actor.permissions)) return Response.json({ error: 'forbidden' }, { status: 403 });
  const url = new URL(request.url);
  const wh = url.searchParams.get('wh');
  const batchId = url.searchParams.get('batch');
  const mijoz = url.searchParams.get('mijoz')?.trim() || null;
  if (mijoz && !/^[A-Za-z0-9-]{1,20}$/.test(mijoz)) {
    return Response.json({ error: 'bad_client' }, { status: 400 });
  }

  let result;
  if (wh && UUID.test(wh)) {
    if (!inScope(actor, wh)) return Response.json({ error: 'forbidden' }, { status: 403 });
    result = await placeCargo({ warehouseId: wh }, mijoz);
  } else if (batchId && UUID.test(batchId)) {
    const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) return Response.json({ error: 'not_found' }, { status: 404 });
    if (!inScope(actor, batch.originWarehouseId) && !inScope(actor, batch.destWarehouseId)) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    result = await placeCargo({ batchId }, mijoz);
  } else {
    return Response.json({ error: 'bad_place' }, { status: 400 });
  }
  return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
}
