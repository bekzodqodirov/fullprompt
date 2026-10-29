/**
 * The client-finding agent's source key (docs/AGENT-FEED.md) — one home for
 * «is this the agent», asked by the landing's belt, the contact clock and
 * the doors screen.
 *
 * Its own module with NO imports, because one of the askers sits under
 * `inbound.ts` in the import graph (inbound.ts → inbound-notify.ts →
 * first-contact.ts): a constant read at module load across that circle is a
 * temporal-dead-zone ReferenceError the day the evaluation order flips.
 * `inbound.ts` re-exports both names, so callers keep one import.
 */
export const AGENT_SOURCE_KEY = 'agent';

export const isAgentSource = (key: string | null | undefined): boolean => key === AGENT_SOURCE_KEY;

/**
 * The lead sources a PERSON may pick on a lead form: every one but the
 * agent's, which only the agent's door writes — a seller tagging a hand-made
 * lead «Agent (qidiruv)» would count it in the agent's figures on
 * /crm/tahlil (review, regression lens). The record's OWN source stays even
 * when it is the agent's: a select that cannot render the stored value posts
 * «—» on the next save and erases it (#171).
 */
export function personPickableSources<T extends { id: string; key: string | null }>(
  rows: T[],
  currentId: string | null | undefined,
): T[] {
  return rows.filter((row) => !isAgentSource(row.key) || row.id === currentId);
}
