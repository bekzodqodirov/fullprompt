import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches } from '../../platform/db/schema';
import { AuthError, requireActor } from '../../platform/rbac/authorize';
import { inScope } from '../../platform/rbac/scope';

/**
 * Who may download a document about a truck.
 *
 * ONE function for all four batch document routes, because they kept drifting
 * apart one at a time: the manifest asked for a login alone until round 101,
 * and packing, packing-photos and invoice still asked for a permission and
 * never for the warehouse — so a scoped operator in Yiwu could pull another
 * country's whole cargo list, every short code, client code, marking and
 * weight, with nothing but a batch id.
 *
 * The rule is the batch card's own: one of the named permissions AND either
 * END of the trip, since a truck between two countries stands on nobody's
 * floor and both ends care about it.
 *
 * 404 for a batch that is not there, 403 for one the person may not read —
 * the existing routes' shapes, kept.
 */
export async function guardBatchDocument(
  batchId: string,
  allowed: readonly string[],
): Promise<Response | null> {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Unauthorized', { status: 401 });
    throw err;
  }
  const row = await db.query.batches.findFirst({
    where: eq(batches.id, batchId),
    columns: { originWarehouseId: true, destWarehouseId: true },
  });
  if (!row) return new Response('Not found', { status: 404 });

  const mayRead =
    allowed.some((code) => actor.permissions.has(code)) &&
    (inScope(actor, row.originWarehouseId) || inScope(actor, row.destWarehouseId));
  return mayRead ? null : new Response('Forbidden', { status: 403 });
}
