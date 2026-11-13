/**
 * Is the system's own question (his «1 b», `client_notices` kind
 * `lot_reask`) still a line on the prixod card's «Mijozdan so'rash» block?
 * PURE — the page asks it, a unit test pins it.
 *
 * Held (waiting): always — it is about to go. Sent or failed: only while it
 * is the NEWEST thing the client was asked — a person's «Mijozdan so'rash»
 * delivered after it is the question the client holds now, and a failure the
 * person has already acted on (pressed again, the client answered) must not
 * go on telling them to act (the as-built review, DLV-1). A failure is dated
 * by the time it was due (`send_after`): it cannot have failed earlier.
 */
export interface ReaskLineFacts {
  state: 'waiting' | 'sent' | 'failed';
  at: Date | null;
}

export function reaskLineDrawn(auto: ReaskLineFacts | null, personDeliveredAt: Date | null): boolean {
  if (auto === null) return false;
  if (auto.state === 'waiting') return true;
  if (personDeliveredAt === null) return true;
  return auto.at !== null && auto.at.getTime() > personDeliveredAt.getTime();
}
