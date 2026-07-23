import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { batches } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { ingestLoadScans, loadScanSchema } from '@/modules/wms/scanning/service';
import { ingestUnloadScans } from '@/modules/wms/scanning/unload';

const itemSchema = loadScanSchema.extend({
  scanType: z.enum(['load', 'unload']).default('load'),
});
const bodySchema = z.object({ scans: z.array(itemSchema).min(1).max(200) });

/**
 * Offline outbox sync endpoint (spec §15, edge cases 13/14): accepts a batch
 * of load/unload scan events, returns per-item acks. Replays are idempotent.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'validation' }, { status: 400 });

  const loads = parsed.data.scans.filter((s) => s.scanType === 'load');
  const unloads = parsed.data.scans.filter((s) => s.scanType === 'unload');

  let actor;
  try {
    for (const batchId of new Set(loads.map((s) => s.batchId))) {
      const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
      if (!batch) return Response.json({ error: 'batch_not_found' }, { status: 404 });
      actor = await authorize('scan.load', { warehouseId: batch.originWarehouseId });
    }
    for (const batchId of new Set(unloads.map((s) => s.batchId))) {
      const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
      if (!batch) return Response.json({ error: 'batch_not_found' }, { status: 404 });
      actor = await authorize('scan.unload', { warehouseId: batch.destWarehouseId });
    }
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const meta = await requestMeta();
  const ctx = { actorId: actor!.id, ...meta };
  const acks = [
    ...(loads.length ? await ingestLoadScans(loads, ctx) : []),
    ...(unloads.length ? await ingestUnloadScans(unloads, ctx) : []),
  ];
  return Response.json({ acks });
}
