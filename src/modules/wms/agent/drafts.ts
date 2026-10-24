import { and, eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentDrafts, agentOutbox, calcOffers } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { offerStandsSql, releasedOfferWhere } from '../calc/workspace';

/**
 * The drafts and their cards. (Filled in by the brain and the bot packages;
 * the two functions here are the listener's seam, `settle-hooks.ts`.)
 */

/** A price reply's offer still stands — released and not superseded; null when the draft carries none. */
export async function draftOfferStands(draftId: string): Promise<boolean | null> {
  const [draft] = await db.select({ offerId: agentDrafts.offerId }).from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!draft?.offerId) return null;
  const [row] = await db
    .select({ id: calcOffers.id })
    .from(calcOffers)
    .where(and(eq(calcOffers.id, draft.offerId), releasedOfferWhere(), offerStandsSql()));
  return row !== undefined;
}

/** The card of the draft this outbox row carries is re-rendered with the outcome. */
export async function refreshCardForOutbox(outboxId: string): Promise<void> {
  const [row] = await db
    .select({ draftId: agentOutbox.draftId })
    .from(agentOutbox)
    .where(eq(agentOutbox.id, outboxId));
  if (!row) return;
  try {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(row.draftId);
  } catch (err) {
    logger.warn({ err, outboxId }, '[agent] card not refreshed');
  }
}

