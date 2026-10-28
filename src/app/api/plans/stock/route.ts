import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { json } from '@/modules/platform/http/json';
import { logger } from '@/modules/platform/logger';
import { plannableStock, roadStock, withRoad } from '@/modules/wms/planning/stock';
import { planRoadReady } from '@/modules/wms/planning/road';

const querySchema = z.object({ warehouseId: z.string().uuid() });

/**
 * Plannable stock at a warehouse — the plan editor's list. The question
 * itself lives in `plannableStock`; this handler is the door.
 *
 * `road=1` («🚚 Yo'ldagi yuklar ham», docs/YOLDAGI-YUK.md §4) adds the cargo
 * still on a truck bound here, merged into the one list, and the factory trips
 * heading here. The road half runs in its own catch: when it fails the shelf
 * list still arrives and says so (`roadFailed`), because the shelf list is the
 * screen the owner named. `roadOn` is whether this server has the road at all
 * — the editor draws the checkbox only then.
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
  const stock = await plannableStock(query.data.warehouseId);
  const road = await planRoadReady();
  if (!road.on || url.searchParams.get('road') !== '1') {
    return json(request, { ...stock, roadOn: road.on });
  }
  try {
    const onRoad = await roadStock(query.data.warehouseId);
    return json(request, {
      ...stock,
      lots: withRoad(stock.lots, onRoad.lots),
      roadOn: true,
      road: true,
      factoryTrips: onRoad.factoryTrips,
    });
  } catch (err) {
    logger.error({ err, warehouseId: query.data.warehouseId }, '[plan-road] road half failed');
    return json(request, { ...stock, roadOn: true, roadFailed: true });
  }
}
