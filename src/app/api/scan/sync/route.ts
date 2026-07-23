import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { batches } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { ingestLoadScans, loadScanSchema } from '@/modules/wms/scanning/service';

const bodySchema = z.object({ scans: z.array(loadScanSchema).min(1).max(200) });

/**
 * Offline outbox sync endpoint (spec §15, edge cases 13/14): accepts a batch
 * of scan events, returns per-item acks. Replays are idempotent.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'validation' }, { status: 400 });

  // All scans in one flush target the same batch in practice; authorize per
  // distinct batch to be safe.
  const batchIds = [...new Set(parsed.data.scans.map((s) => s.batchId))];
  let actor;
  try {
    for (const batchId of batchIds) {
      const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
      if (!batch) return Response.json({ error: 'batch_not_found' }, { status: 404 });
      actor = await authorize('scan.load', { warehouseId: batch.originWarehouseId });
    }
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const meta = await requestMeta();
  const acks = await ingestLoadScans(parsed.data.scans, { actorId: actor!.id, ...meta });
  return Response.json({ acks });
}
