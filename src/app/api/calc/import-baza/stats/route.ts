import { inArray } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { customsImportBatches } from '@/modules/platform/db/schema';
import { authorize, AuthError } from '@/modules/platform/rbac/authorize';
import { isQueryCanceled, isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { isBazaBasis, type BazaBasis } from '@/modules/wms/calc/pricing';
import { underCeiling } from '@/modules/wms/finance/price-history';
import { newestReadyBatchId, previousReadyBatchId } from '@/modules/wms/customs/import-service';
import { periodText, readImportStats, type ImportStatsAnswer } from '@/modules/wms/customs/import-stats';
import { readPickerItem } from '@/modules/wms/customs/picker-item';

/**
 * «Narxlar statistikasi» behind the 📥 dialog (his C1-C6).
 *
 * The same door as the list (`ved.docs`), the same item read
 * (`readPickerItem`) and the same one extra word (a drafted basis, validated
 * as an enum). NO other parameter is read: what the statistics describe is
 * decided by the saved row and the quarter that answers now, never by the
 * browser (import-stats-wire.test.ts pins it).
 *
 * The three statements run in ONE `underCeiling` transaction: each statement
 * is bounded at 1500 ms (so the worst case of the read is about three times
 * that), and a cancel becomes `state: 'timeout'` — a sentence beside a list
 * that keeps working, never a hung dialog. The batch ids and the item are
 * read BEFORE the transaction, on the pool (#714).
 */
export async function GET(request: Request) {
  try {
    await authorize('ved.docs');
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const params = new URL(request.url).searchParams;
  const itemId = params.get('item') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return Response.json({ error: 'bad_item' }, { status: 400 });
  const drafted = params.get('basis');
  const draftedBasis: BazaBasis | null = isBazaBasis(drafted) ? drafted : null;

  const empty = (state: ImportStatsAnswer['state']): ImportStatsAnswer => ({
    state,
    batchId: null,
    period: null,
    prevPeriod: null,
    filtered: false,
    units: [],
    wants: [],
    perPieceKg: null,
    lawUnit: null,
  });
  const headers = { 'cache-control': 'private, no-store' };

  let batchId: string | null = null;
  try {
    const item = await readPickerItem(itemId, draftedBasis);
    if (!item) return Response.json({ error: 'not_found' }, { status: 404 });
    if (!item.code) return Response.json(empty('no_code'), { headers });

    batchId = await newestReadyBatchId();
    if (!batchId) return Response.json(empty('no_batch'), { headers });
    const prevBatchId = await previousReadyBatchId(batchId);
    const periods = await db
      .select({
        id: customsImportBatches.id,
        fileName: customsImportBatches.fileName,
        periodFrom: customsImportBatches.periodFrom,
        periodTo: customsImportBatches.periodTo,
      })
      .from(customsImportBatches)
      .where(inArray(customsImportBatches.id, prevBatchId ? [batchId, prevBatchId] : [batchId]));

    const current = batchId;
    const stats = await underCeiling((tx) =>
      readImportStats(tx, {
        batchId: current,
        prevBatchId,
        tnvedCode: item.code,
        units: item.units,
        dutyUnit: item.dutyUnit,
        perPieceKg: item.perPieceKg,
      }),
    );
    const answer: ImportStatsAnswer = {
      state: 'ok',
      ...stats,
      period: periodText(periods.find((p) => p.id === current)),
      prevPeriod: prevBatchId ? periodText(periods.find((p) => p.id === prevBatchId)) : null,
    };
    return Response.json(answer, { headers });
  } catch (err) {
    // Deploy morning: 0094's tables may not exist yet (#472).
    if (isServerBehind(err)) {
      logger.error({ err }, '[calc] import-stats: server behind');
      return Response.json(empty('behind'), { headers });
    }
    // A statement over its ceiling: the list still answers, the statistics
    // say so in words. Never the name — it is the VED's customer's goods.
    if (isQueryCanceled(err)) {
      logger.warn({ code: (err as { code?: string }).code ?? '57014', batchId }, '[calc] import-stats: timeout');
      return Response.json(empty('timeout'), { headers });
    }
    throw err;
  }
}
