import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { calcGroups, calcRequestItems } from '@/modules/platform/db/schema';
import { authorize, AuthError } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { defaultBasisFor } from '@/modules/wms/calc/basis';
import { suggestImportBaza, UNIT_FOR_BASIS } from '@/modules/wms/customs/import-baza';

/**
 * «Bu kod uchun importda nima bor?» — the picker behind the 📥 chip.
 *
 * It takes an ITEM id and nothing else. The name, the code, the count and
 * the weight are read HERE, off the row itself: a browser that could pass
 * its own search terms would be a free text search over the whole customs
 * dump behind a calc-screen door, and the suggestion the VED sees must be
 * the one `saveTable` would have made.
 *
 * The door is the workspace's own grant (`ved.docs`); this app has no
 * middleware, so every /api route states it (#721-726).
 */
export async function GET(request: Request) {
  try {
    await authorize('ved.docs');
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const itemId = new URL(request.url).searchParams.get('item') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return Response.json({ error: 'bad_item' }, { status: 400 });

  try {
    const [item] = await db
      .select({
        name: calcRequestItems.name,
        tnvedCode: calcRequestItems.tnvedCode,
        quantity: calcRequestItems.quantity,
        weightKg: calcRequestItems.weightKg,
        dutyUnit: calcGroups.dutyUnit,
      })
      .from(calcRequestItems)
      .leftJoin(calcGroups, eq(calcGroups.id, calcRequestItems.groupId))
      .where(eq(calcRequestItems.id, itemId))
      .limit(1);
    if (!item) return Response.json({ error: 'not_found' }, { status: 404 });
    const code = (item.tnvedCode ?? '').trim();
    // No code, no question: the file is keyed on the code and a name search
    // across every declaration is not what he asked for.
    if (!code) return Response.json({ candidates: [], batchId: null });

    const basis = defaultBasisFor({ dutyUnit: item.dutyUnit });
    const qty = item.quantity === null ? null : Number(item.quantity);
    const kg = item.weightKg === null ? null : Number(item.weightKg);
    const perPiece =
      basis === 'unit' && qty !== null && qty > 0 && kg !== null && kg > 0 ? kg / qty : null;

    const sug = await suggestImportBaza({
      tnvedCode: code,
      name: item.name,
      unit: UNIT_FOR_BASIS[basis],
      weightPerUnitKg: perPiece,
    });
    return Response.json(
      { candidates: sug.candidates, batchId: sug.batchId },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (err) {
    // Deploy morning: 0094's tables may not exist yet (#472). The picker
    // says «nothing», the screen keeps working, the number stays the VED's.
    if (isServerBehind(err)) {
      logger.error({ err }, '[calc] import-baza: server behind');
      return Response.json({ candidates: [], batchId: null });
    }
    throw err;
  }
}
