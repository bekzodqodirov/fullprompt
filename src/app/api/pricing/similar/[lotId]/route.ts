import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { lotSimilarPicks, receiptLots } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { aiConfigured } from '@/modules/platform/ai/model';
import { logger } from '@/modules/platform/logger';
import { batchLots } from '@/modules/wms/batches/lots';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { loadBatchHead } from '@/modules/wms/batches/card-head';
import { pricingSight } from '@/modules/wms/finance/pricing-view';
import { priceHistoryForLots } from '@/modules/wms/finance/price-history';
import { pickSimilarLots, similarCandidates } from '@/modules/wms/finance/similar-ai';
import { aiCalcBudgetLeft, recordAiPass } from '@/modules/wms/calc/ai-cost';

/**
 * «AI bilan qidirish» under an empty «📈 Oldingi narx» (0119, 18a) — a route
 * handler, pressed, never a render: a page must not wait on a model.
 *
 * The door is the pricing page's own, re-derived here because this app has no
 * middleware (#721-726): `finance.manage`, the truck's card door, the page's
 * sight, and the lot must really ride this truck (the riders). Anything else
 * is a 404 that says nothing about what exists.
 *
 * The free search is re-run first and a non-empty answer is `found_free` —
 * never pay for a known answer. What the model picks is stored as past LOT
 * ids; the price is read from the ledger at render.
 */
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const refuse = (error: string, status = 200) => NextResponse.json({ error }, { status, headers: NO_STORE });

export async function POST(request: Request, { params }: { params: Promise<{ lotId: string }> }) {
  const actor = await getActor();
  if (!actor || !actor.permissions.has('finance.manage')) return refuse('not_found', 404);
  const { lotId } = await params;
  let batchId = '';
  try {
    const body = (await request.json()) as { batchId?: unknown };
    batchId = typeof body.batchId === 'string' ? body.batchId : '';
  } catch {
    return refuse('not_found', 404);
  }
  if (!/^[0-9a-f-]{36}$/.test(batchId) || !/^[0-9a-f-]{36}$/.test(lotId)) return refuse('not_found', 404);

  const head = await loadBatchHead(batchId);
  if (!head || !mayOpenBatchCard(actor, head.batch)) return refuse('not_found', 404);
  if (pricingSight(actor.permissions, head.internal) === 'none') return refuse('not_found', 404);
  const lots = await batchLots(batchId);
  const lot = lots.find((row) => row.lotId === lotId);
  if (!lot) return refuse('not_found', 404);

  if (!aiConfigured()) return refuse('not_configured');
  if ((await aiCalcBudgetLeft()) <= 0) return refuse('budget');

  const free = (await priceHistoryForLots([lot], batchId, actor)).get(lot.lotId);
  if (free && free.rows.length > 0) return refuse('found_free');

  const row = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lot.lotId) });
  if (!row) return refuse('not_found', 404);
  const candidates = await similarCandidates(
    { id: row.id, zh: row.productNameZh, ru: row.productNameRu },
    batchId,
    actor,
  );
  // Which model answered, as the call reports it — the ledger row and the
  // pick record say the same thing.
  let model = '';
  const picks = await pickSimilarLots({ zh: row.productNameZh, ru: row.productNameRu }, candidates, {
    onUsage: (usage) => {
      model = usage.model;
      void recordAiPass({
        kind: 'similar',
        requestId: null,
        staffId: actor.id,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    },
  });
  if (picks === null) return refuse('failed');

  const picked = picks.flatMap((pick) => candidates[pick.index]?.lotIds ?? []);
  const reasons = picks.map((pick) => ({ name: candidates[pick.index]?.name ?? '', reason: pick.reason }));
  try {
    await db
      .insert(lotSimilarPicks)
      .values({ lotId: lot.lotId, pickedLotIds: picked, reasons, model: model || 'unknown', createdBy: actor.id })
      .onConflictDoUpdate({
        target: lotSimilarPicks.lotId,
        set: { pickedLotIds: picked, reasons, model: model || 'unknown', createdBy: actor.id, createdAt: new Date() },
      });
  } catch (err) {
    logger.error({ err, lotId }, '[similar-ai] pick not stored');
    return refuse('failed');
  }
  return NextResponse.json({ ok: true, picked: picked.length }, { headers: NO_STORE });
}
