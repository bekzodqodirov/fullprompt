import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { batches } from '@/modules/platform/db/schema';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { buildManifestXlsx } from '@/modules/wms/documents/manifest-xlsx';

/**
 * Actual manifest XLSX — what really departed (fact, not plan).
 *
 * Gated like the screen it backs and like its sibling documents: the invoice
 * and packing routes ask `ved.docs || plans.manage`, and the batch card
 * itself `notFound()`s a truck belonging to neither of the viewer's
 * warehouses. This route asked for a login alone, so a warehouse-scoped
 * operator could pull another country's whole cargo list — every short code,
 * client code, marking and weight — with a batch id.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Unauthorized', { status: 401 });
    throw err;
  }
  const { id } = await params;

  const row = await db.query.batches.findFirst({
    where: eq(batches.id, id),
    columns: { originWarehouseId: true, destWarehouseId: true },
  });
  if (!row) return new Response('Not found', { status: 404 });
  const mayRead =
    (actor.permissions.has('ved.docs') || actor.permissions.has('plans.manage')) &&
    // Both ends, as the batch card and the bot lookup judge it: a truck
    // between two countries belongs to nobody's floor and both ends care.
    (inScope(actor, row.originWarehouseId) || inScope(actor, row.destWarehouseId));
  if (!mayRead) return new Response('Forbidden', { status: 403 });

  const buffer = await buildManifestXlsx(id);
  if (!buffer) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="manifest.xlsx"',
    },
  });
}
