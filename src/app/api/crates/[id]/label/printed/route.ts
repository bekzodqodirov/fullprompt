import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { crates } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';

/**
 * The crate half of "the operator asked to print this sticker" — see the
 * receipt version for why the record is separate from rendering the sheet.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const crate = await db.query.crates.findFirst({ where: eq(crates.id, id) });
  if (!crate) return new Response('Not found', { status: 404 });

  let actor;
  try {
    actor = await authorize('crates.manage', { warehouseId: crate.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return new Response('Forbidden', { status: 403 });
    throw err;
  }

  const meta = await requestMeta();
  await writeAudit(db, { actorId: actor.id, ...meta, warehouseId: crate.warehouseId }, {
    entityType: 'crate',
    entityId: id,
    action: 'label_print',
    after: { code: crate.code },
  });

  return new Response(null, { status: 204 });
}
