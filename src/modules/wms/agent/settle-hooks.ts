import { enqueue } from '../../platform/jobs/boss';
import { AFTER_SENT_RETRY_LIMIT, JOB_AGENT_AFTER_SENT, type AgentAfterSentJob } from './queues';

/**
 * What the listener's agent pump tells the rest of the agent, and asks of it —
 * the seam between the pump (it holds the session) and the drafts/cards
 * (they live in the app). Imported by the listener, so it stays small and
 * reaches the heavier modules by dynamic import. Its only STATIC imports are
 * the queue names and pg-boss's sender (a source fence pins it): the after-sent
 * job's steps — the offer, the stage mover — run in the app's worker, never here.
 */

/**
 * A reply REACHED the customer (SPEC-P2-v2 §2.4, §3.2): queue what it settles on the card — the VED price the
 * machine quoted becomes the card's offer, the lead moves a stage on. Called from the `sent` branch of
 * `applyAgentOutcome` ONLY: `onAgentOutboxSettled` also fires for a wait's hold, a cancel, an unknown, a flood and
 * a failure, none of which reached anybody. The job's id IS the outbox row's id — pg-boss inserts ON CONFLICT DO
 * NOTHING, so an outcome replayed after a database blip is still one job. Never throws into the pump: a job that
 * could not be queued is the minute sweep's to queue (`queueMissedAfterSent`).
 */
export async function onAgentReplySent(outboxId: string): Promise<void> {
  try {
    await enqueue(JOB_AGENT_AFTER_SENT, { outboxId } satisfies AgentAfterSentJob, { id: outboxId, retryLimit: AFTER_SENT_RETRY_LIMIT });
  } catch {
    // The sweep's net finds a sent row with no recorded outcome; the pump must never fail over a card's bookkeeping.
  }
}

/** An agent_outbox row reached a final state (sent, failed, cancelled, unknown): the card says so. */
export async function onAgentOutboxSettled(outboxId: string): Promise<void> {
  const { refreshCardForOutbox } = await import('./drafts');
  await refreshCardForOutbox(outboxId);
}

/**
 * A reply's figure still stands — a 💵's request not superseded by a recalculation (his 6 b: a 💵 has no offer
 * row), or its offer released and not superseded; a machine estimate priced again on today's tariff and avia rate
 * (spec SPEC-P1-v2 §1.3); a VED answer's price priced again (SPEC-P2-v2 §2.5). null when the draft carries none.
 * `offer_gone`, `estimate_moved` or `calc_price_moved` cancels the row at its next step, each in its own words. Never
 * throws on a re-price (`draftOfferStands`).
 */
export async function offerStandsFor(
  draftId: string,
  now: Date = new Date(),
): Promise<'stands' | 'offer_gone' | 'estimate_moved' | 'calc_price_moved' | null> {
  const { draftOfferStands } = await import('./drafts');
  return draftOfferStands(draftId, now);
}

/** Live drafts a forced off expired: each card loses its buttons and says why. */
export async function onAgentDraftsRetired(draftIds: readonly string[]): Promise<void> {
  if (draftIds.length === 0) return;
  const { refreshAgentCard } = await import('./card-io');
  for (const id of draftIds) await refreshAgentCard(id).catch(() => undefined);
}
