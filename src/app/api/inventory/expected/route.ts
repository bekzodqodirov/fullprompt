import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { json } from '@/modules/platform/http/json';
import { inventorySnapshot } from '@/modules/wms/inventory/service';

const querySchema = z.object({ warehouseId: z.string().uuid() });

/** Expected-stock snapshot for the inventory screen (W: stocktake). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = querySchema.safeParse({ warehouseId: url.searchParams.get('warehouseId') });
  if (!query.success) return Response.json({ error: 'validation' }, { status: 400 });
  try {
    await authorize('scan.load', { warehouseId: query.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }
  // Compressed + tagged: this is a whole warehouse's stock in one body, read
  // on a phone in Yiwu or Kashgar (round 110).
  return json(request, await inventorySnapshot(query.data.warehouseId));
}
