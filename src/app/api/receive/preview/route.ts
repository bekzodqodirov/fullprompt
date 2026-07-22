import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { previewLetters } from '@/modules/wms/sequencer';

const querySchema = z.object({
  warehouseId: z.string().uuid(),
  count: z.coerce.number().int().min(1).max(50),
});

/** Non-binding letter preview for the wizard ("≈ D, E, F" — DECISIONS #8). */
export async function GET(request: Request) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw err;
  }

  const url = new URL(request.url);
  const query = querySchema.safeParse({
    warehouseId: url.searchParams.get('warehouseId'),
    count: url.searchParams.get('count'),
  });
  if (!query.success) return Response.json({ error: 'validation' }, { status: 400 });

  const letters = await db.transaction((tx) =>
    previewLetters(tx, query.data.warehouseId, query.data.count),
  );
  return Response.json({ letters });
}
