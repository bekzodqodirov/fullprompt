import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { QRLESS_SHEET_CAP } from '@/modules/wms/labels/qrless-sql';
import { confirmQrLabelled, QrlessError } from '@/modules/wms/labels/qrless';

const bodySchema = z.object({
  warehouseId: z.string().uuid(),
  boxIds: z.array(z.string().uuid()).min(1).max(QRLESS_SHEET_CAP),
});

/**
 * «✅ Stikerlar yopishtirildi» (0112, decision 31): the ids the sheet
 * rendered, stamped where they stand.
 *
 * Gated like the sheet — `receipts.create` at the warehouse in the BODY, the
 * one the cartons stand in — and the service asks the rest again inside its
 * UPDATE (still here, still QR-siz, a planned carton only for the count
 * door). A route handler and not an action: 500 ids is a body, and the answer
 * is a count the page prints, never a redirect.
 */
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: 'validation' }, { status: 400 });
  }
  const body = bodySchema.safeParse(raw);
  if (!body.success) return Response.json({ error: 'validation' }, { status: 400 });

  let actor;
  try {
    actor = await authorize('receipts.create', { warehouseId: body.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }
  const meta = await requestMeta();
  try {
    const result = await confirmQrLabelled(body.data.warehouseId, body.data.boxIds, actor, {
      actorId: actor.id,
      ...meta,
    });
    return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof QrlessError) {
      return Response.json({ error: err.code }, { status: err.code === 'forbidden' ? 403 : 400 });
    }
    throw err;
  }
}
