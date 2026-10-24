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
