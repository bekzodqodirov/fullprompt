import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { handovers } from '@/modules/platform/db/schema';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { buildHandoverAct } from '@/modules/wms/documents/handover-act';

/**
 * Handover act PDF (optional per issue, spec 6.7).
 *
 * The gate is the HANDOVER's warehouse, not merely a login. This route used
 * to ask `requireActor()` and nothing else while the act itself carries the
 * customer's name, the receiver's name and PHONE, and the signed box list —
 * and handover ids are published into card feeds (`'hv-'||id` in
 * `clientFeed`), which sales roles read. So any of the ~20 staff could
 * download any customer's act from another country by pasting an id off a
 * card. The permission mirrors the attachment branch for the SAME document
 * verbatim (`scan.issue || receipts.unclaimed.resolve`, in scope) — the act
 * and the files hanging off it must not disagree about who may read them.
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

  const row = await db.query.handovers.findFirst({
    where: eq(handovers.id, id),
    columns: { warehouseId: true },
  });
  if (!row) return new Response('Not found', { status: 404 });
  const mayRead =
    (actor.permissions.has('scan.issue') ||
      actor.permissions.has('receipts.unclaimed.resolve')) &&
    inScope(actor, row.warehouseId);
  if (!mayRead) return new Response('Forbidden', { status: 403 });

  const pdf = await buildHandoverAct(id);
  if (!pdf) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'inline; filename="handover-act.pdf"',
    },
  });
}
