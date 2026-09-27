import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { batches } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { json } from '@/modules/platform/http/json';
import { countDoorFor } from '@/modules/wms/scanning/count-door';
import { countableLotsAt } from '@/modules/wms/scanning/count-load';

/**
 * The count panel's lot picker (0112): the origin's lots that can still go
 * onto this truck by count. Fetched only when the picker opens, so the batch
 * card's render does not carry it. Lot-level and capped at 300 with the
 * total beside it — a cut list says so (#758).
 *
 * The same door as the press: `plans.manage` at the truck's origin.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!batch) return Response.json({ error: 'not_found' }, { status: 404 });
  let actor;
  try {
    actor = await authorize('plans.manage', { warehouseId: batch.originWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }
  if (!countDoorFor(actor, batch.originWarehouseId)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!['forming', 'loading'].includes(batch.status)) {
    return Response.json({ error: 'batch_not_loading' }, { status: 409 });
  }
  const q = new URL(request.url).searchParams.get('q') ?? undefined;
  const { lots, total } = await countableLotsAt(batch, q);
  return json(request, { lots, total, shown: lots.length }, { headers: { 'Cache-Control': 'private, no-store' } });
}
