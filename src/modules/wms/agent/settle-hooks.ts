/**
 * What the listener's agent pump tells the rest of the agent, and asks of it —
 * the seam between the pump (it holds the session) and the drafts/cards
 * (they live in the app). Imported by the listener, so it stays small and
 * reaches the heavier modules by dynamic import.
 */

/** An agent_outbox row reached a final state (sent, failed, cancelled, unknown): the card says so. */
export async function onAgentOutboxSettled(outboxId: string): Promise<void> {
  const { refreshCardForOutbox } = await import('./drafts');
  await refreshCardForOutbox(outboxId);
}

/**
 * A reply's figure still stands — a 💵's request not superseded by a recalculation (his 6 b: a 💵 has no offer
 * row), or its offer released and not superseded; a machine estimate priced again on today's tariff and avia rate
 * (spec SPEC-P1-v2 §1.3). null when the draft carries none. `offer_gone` or `estimate_moved` cancels the row at its
 * next step, each in its own words. Never throws on a re-price (`draftOfferStands`).
 */
export async function offerStandsFor(draftId: string, now: Date = new Date()): Promise<'stands' | 'offer_gone' | 'estimate_moved' | null> {
  const { draftOfferStands } = await import('./drafts');
  return draftOfferStands(draftId, now);
}

/** Live drafts a forced off expired: each card loses its buttons and says why. */
export async function onAgentDraftsRetired(draftIds: readonly string[]): Promise<void> {
  if (draftIds.length === 0) return;
  const { refreshAgentCard } = await import('./card-io');
  for (const id of draftIds) await refreshAgentCard(id).catch(() => undefined);
}
