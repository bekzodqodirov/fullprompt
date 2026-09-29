import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { json } from '@/modules/platform/http/json';
import { plannableStock } from '@/modules/wms/planning/stock';

const querySchema = z.object({ warehouseId: z.string().uuid() });

/**
 * Plannable stock at a warehouse — the plan editor's list. The question
 * itself lives in `plannableStock`; this handler is the door.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = querySchema.safeParse({ warehouseId: url.searchParams.get('warehouseId') });
  if (!query.success) return Response.json({ error: 'validation' }, { status: 400 });
  try {
    await authorize('plans.manage', { warehouseId: query.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  // Compressed + tagged (round 110): the plan editor re-reads a whole
  // warehouse's loadable stock every time it opens or the origin changes,
  // and it is the screen the owner named — «planlarni yuklayotgan paytda».
  return json(request, await plannableStock(query.data.warehouseId));
}
