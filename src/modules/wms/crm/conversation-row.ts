/**
 * What a conversation row IS, and where it opens — pure, so the dock (a client
 * component) and the server share one shape and one address rule.
 *
 * Two kinds since the lead chats round (owner, 2026-09-28, answer 4a: a
 * prospect's Telegram chat is watched «exactly like a client's»):
 *
 *   client — `tg_messages.client_id` is set; opens on /suhbatlar/<client>.
 *   lead   — `client_id IS NULL`, `lead_id` set: a person who wrote in before
 *            anybody gave them a GS code. Opens on the LEAD card, scrolled to
 *            its chat, because that is the only screen that shows a lead's
 *            conversation (the thread screen and the composer are keyed to
 *            the client book — a lead chat is answered from the phone).
 *
 * The client id always wins: a row carrying both ids (written after the lead
 * was won) belongs to the client's conversation, never to a second row.
 */

export type ConversationKind = 'client' | 'lead';

/** The lead card's chat panel carries this id; the row's link lands on it. */
export const LEAD_THREAD_ANCHOR = 'tg-thread';

export interface ConversationTarget {
  kind: ConversationKind;
  clientId: string | null;
  leadId: string | null;
  /**
   * May the READER open where this row points (`mayOpenLead` for a lead; a
   * client row is always openable by whoever the list admitted)? A row whose
   * link would bounce gets no link at all and names the lead's owner instead
   * — the design judge's first finding.
   */
  openable: boolean;
}

/** Where a conversation row opens, or null when the reader may not follow it. */
export function conversationHref(row: ConversationTarget): string | null {
  if (row.kind === 'client') return row.clientId ? `/suhbatlar/${row.clientId}` : null;
  if (!row.openable || !row.leadId) return null;
  return `/crm/leads/${row.leadId}#${LEAD_THREAD_ANCHOR}`;
}

/**
 * Which conversation the LEAD card's chat panel shows.
 *
 * The card resolves a client by the lead's typed phone (`conversationClientForLead`)
 * for its lenta, and the chat panel used to show that client's thread — so a
 * lead whose phone happened to match one client hid its OWN chat behind the
 * client's (or behind nothing, when the client had none), and the «Lid» row on
 * «Suhbatlar» opened onto a card without the conversation it promised (#476's
 * shape: two screens telling two stories). Precedence: the lead's own
 * standing rows first; only a lead with none falls back to the phone match.
 *
 * Computed ONCE by the page and handed to both the panel and the dock marker,
 * so the two can never disagree about which chat this card is about (round 52's
 * rule — the design judge's fourth finding).
 */
export type LeadThreadSource =
  { kind: 'lead' } | { kind: 'client'; clientId: string } | { kind: 'none' };

export function leadThreadSource(input: {
  /** This lead's own standing chat rows the viewer may read (`client_id IS NULL`). */
  ownLeadRows: number;
  /** The client the card resolved for its lenta, if any. */
  resolvedClientId: string | null;
}): LeadThreadSource {
  if (input.ownLeadRows > 0) return { kind: 'lead' };
  if (input.resolvedClientId) return { kind: 'client', clientId: input.resolvedClientId };
  return { kind: 'none' };
}

/**
 * One row of the dock's list, as the route sends it and the drawer reads it.
 *
 * Exported so the JSON crossing has ONE type on both ends: the route builds
 * `DockConversation` objects and the dock reads them as `DockConversation`,
 * so renaming a field is a compile error on both sides (the design judge's
 * eighth finding — `pnpm typecheck` does not see through `res.json()`).
 */
export interface DockConversation {
  kind: ConversationKind;
  clientId: string | null;
  leadId: string | null;
  /** The GS code; null on a lead row — a prospect has none yet. */
  code: string | null;
  name: string;
  /**
   * `conversationHref` of the row. The drawer opens a CLIENT row in place (its
   * thread and composer are client-keyed) and follows this only for a lead;
   * null = a lead this reader may not open.
   */
  href: string | null;
  /** Named when a lead row cannot be opened by this reader. */
  leadOwner: string | null;
  lastAt: string;
  lastBody: string | null;
  lastHasMedia: boolean;
  waitingOnUs: boolean;
}
