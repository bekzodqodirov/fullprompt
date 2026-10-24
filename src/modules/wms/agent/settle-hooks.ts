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

/** A price reply's offer still stands (released, not superseded) — null when the draft carries none. */
export async function offerStandsFor(draftId: string): Promise<boolean | null> {
  const { draftOfferStands } = await import('./drafts');
  return draftOfferStands(draftId);
}

/** Live drafts a forced off expired: each card loses its buttons and says why. */
export async function onAgentDraftsRetired(draftIds: readonly string[]): Promise<void> {
  if (draftIds.length === 0) return;
  const { refreshAgentCard } = await import('./card-io');
  for (const id of draftIds) await refreshAgentCard(id).catch(() => undefined);
}
