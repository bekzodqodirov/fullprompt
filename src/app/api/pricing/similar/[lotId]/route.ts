import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { lotSimilarPicks, receiptLots } from '@/modules/platform/db/schema';
import { getActor, type Actor } from '@/modules/platform/rbac/authorize';
import { aiConfigured } from '@/modules/platform/ai/model';
import { logger } from '@/modules/platform/logger';
import { batchLots } from '@/modules/wms/batches/lots';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { loadBatchHead } from '@/modules/wms/batches/card-head';
import { pricingSight } from '@/modules/wms/finance/pricing-view';
import {
  priceHistoryForLots,
  SIMILAR_CLAIM_STALE_MS,
  SIMILAR_PICK_PENDING,
} from '@/modules/wms/finance/price-history';
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
 * Never pay for a known answer, and never twice for one lot:
 * - the free search is re-run first — a row found is `found_free`, and a read
 *   that FAILED is `failed`: a timed-out free list is an unknown answer, not
 *   «nothing found», and the busy moment is exactly when it is likeliest to
 *   exist;
 * - the lot is CLAIMED before the model is called (a `pending` pick row, one
 *   INSERT … ON CONFLICT), so two tabs, a double POST or a hand-typed request
 *   pay once — a stored pick or a live claim is `already`. A failure deletes
 *   the claim; a claim a dead process left behind is taken over after the
 *   workspace lock's ten minutes.
 * The 🤖 has its own daily budget (`aiCalcBudgetLeft('similar')`), so presses
 * here cannot spend the VED's Telegram estimates.
 *
 * What the model picks is stored as past LOT ids, each reason beside the lots
 * it stands for; the price is read from the ledger at render, per reader.
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

  try {
    return await ask(actor, batchId, lotId);
  } catch (err) {
    // A database blip is not a refusal of access: the button says «failed».
    logger.error({ err, lotId, batchId }, '[similar-ai] route failed');
    return refuse('failed');
  }
}

async function ask(actor: Actor, batchId: string, lotId: string) {
  const head = await loadBatchHead(batchId);
  if (!head || !mayOpenBatchCard(actor, head.batch)) return refuse('not_found', 404);
  if (pricingSight(actor.permissions, head.internal) === 'none') return refuse('not_found', 404);
  const lots = await batchLots(batchId);
  const lot = lots.find((row) => row.lotId === lotId);
  if (!lot) return refuse('not_found', 404);

  if (!aiConfigured()) return refuse('not_configured');
  if ((await aiCalcBudgetLeft('similar')) <= 0) return refuse('budget');

  const free = (await priceHistoryForLots([lot], batchId, actor)).get(lot.lotId);
  if (!free || free.failed) return refuse('failed');
  if (free.rows.length > 0) return refuse('found_free');

  const row = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lot.lotId) });
  if (!row) return refuse('not_found', 404);

  // The claim: written only where no pick stands and no live claim is out.
  const staleBefore = new Date(Date.now() - SIMILAR_CLAIM_STALE_MS).toISOString();
  const claimed = await db
    .insert(lotSimilarPicks)
    .values({ lotId: lot.lotId, pickedLotIds: [], reasons: [], model: SIMILAR_PICK_PENDING, createdBy: actor.id })
    .onConflictDoUpdate({
      target: lotSimilarPicks.lotId,
      set: { createdBy: actor.id, createdAt: new Date() },
      setWhere: sql`${lotSimilarPicks.model} = ${SIMILAR_PICK_PENDING}
        AND ${lotSimilarPicks.createdAt} < ${staleBefore}::timestamptz`,
    })
    .returning({ lotId: lotSimilarPicks.lotId });
  if (claimed.length === 0) return refuse('already');
  const release = () =>
    db
      .delete(lotSimilarPicks)
      .where(and(eq(lotSimilarPicks.lotId, lot.lotId), eq(lotSimilarPicks.model, SIMILAR_PICK_PENDING)))
      .catch((err) => logger.error({ err, lotId }, '[similar-ai] claim not released'));

  let candidates;
  try {
    candidates = await similarCandidates({ id: row.id, zh: row.productNameZh, ru: row.productNameRu }, batchId, actor);
  } catch (err) {
    logger.warn({ err, lotId }, '[similar-ai] candidates failed');
    await release();
    return refuse('failed');
  }
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
  if (picks === null) {
    await release();
    return refuse('failed');
  }

  const picked = picks.flatMap((pick) => candidates[pick.index]?.lotIds ?? []);
  // Each reason carries the lots it stands for: a later reader is shown it
  // only when one of them reached a row priced for THEM (`visibleReasons`).
  const reasons = picks.map((pick) => ({
    name: candidates[pick.index]?.name ?? '',
    reason: pick.reason,
    lotIds: candidates[pick.index]?.lotIds ?? [],
  }));
  try {
    await db
      .update(lotSimilarPicks)
      .set({ pickedLotIds: picked, reasons, model: model || 'unknown', createdBy: actor.id, createdAt: new Date() })
      .where(and(eq(lotSimilarPicks.lotId, lot.lotId), eq(lotSimilarPicks.model, SIMILAR_PICK_PENDING)));
  } catch (err) {
    logger.error({ err, lotId }, '[similar-ai] pick not stored');
    await release();
    return refuse('failed');
  }
  return NextResponse.json({ ok: true, picked: picked.length }, { headers: NO_STORE });
}
