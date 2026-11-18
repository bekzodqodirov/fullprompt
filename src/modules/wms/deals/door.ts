/**
 * The deal doors — who may open a deal card, who may work its terms, which
 * board a person gets and whose work it draws. ONE pure module with no imports
 * at all, so a client component, a pure module (`calc/upsale-scope.ts`) and a
 * test with no database can all ask the same question.
 *
 * The owner's 17a (2026-10-07) split the deal card in two. The VED reads the
 * card and writes a text note on the lenta, and its POSITIONS (the TNVED codes)
 * and its PRIXOD links stay his — that is his daily work. The TERMS — opening a
 * deal, its stage, its owner, its quote, its discount — are the seller's: «what
 * the lead karta gives him» on the deal card too.
 *
 * Defined by permission CODES and never by role name (#170): the owner edits
 * roles with checkboxes on /admin/roles, so a both-hats person (seller +
 * `ved.docs`, the logist, an admin) keeps everything by construction, and the
 * day he ticks `crm.leads` for the VED the VED becomes a seller here too.
 */

/** May open a deal card and work its positions and prixods (17a). */
export const DEAL_WRITE_PERMISSIONS = ['crm.leads', 'ved.docs', 'clients.manage'] as const;

export function canWriteDeal(permissions: { has(code: string): boolean }): boolean {
  return DEAL_WRITE_PERMISSIONS.some((code) => permissions.has(code));
}

/**
 * The commercial half of a deal — its terms, its stage, its owner, its
 * discount, its birth. The deal-write list minus `ved.docs` (17a), and also
 * the people who may quote a customer at all (`upsale-scope.ts` asks this).
 */
export const DEAL_TERMS_PERMISSIONS = ['crm.leads', 'clients.manage'] as const;

export function mayEditDealTerms(permissions: { has(code: string): boolean }): boolean {
  return DEAL_TERMS_PERMISSIONS.some((code) => permissions.has(code));
}

/**
 * Which board this person gets: the full funnel, the VED's read-only slice
 * (G3 a — deals that carry a calc request and open deals with a position that
 * has no TNVED code), or none.
 */
export type DealBoardShape = 'full' | 'ved' | 'none';

export function dealBoardShape(permissions: { has(code: string): boolean }): DealBoardShape {
  if (!canWriteDeal(permissions)) return 'none';
  return mayEditDealTerms(permissions) ? 'full' : 'ved';
}

/**
 * Whose work the board draws, out of the URL's `scope` and `hodim` — the ONE
 * answer the query, the filter panel's whose-work block and the chips all
 * read, so a chip can never name a filter the query dropped.
 *
 * `crm.leads.view_all` widens the FUNNEL only. The VED's board is his work set
 * (G3 a) and has no «whose» at all: a person holding the VED hat and
 * `view_all` without a seller's grant (two roles, or one checkbox on
 * /admin/roles) was drawn the Meniki/Hammasi radios, a colleague picker and a
 * «👤 X» chip over a slice that ignores all three. And `scope=all` from
 * somebody who may not see everybody — a published view, a pasted link — is
 * ignored like `hodim` always was (#514), so no «👥 Hammasi» chip sits over
 * his own deals.
 *
 * `hodim` is format-checked, not just permission-checked: it lands in
 * `eq(deals.ownerId, …)`, and a hand-typed non-uuid was a 22P02 500 for a
 * view_all holder rather than a dropped filter. The STRICT shape (`UUID`
 * below, `calc/card-door.ts`'s): the loose «8 hex, a dash, 27 of hex-or-dash»
 * the page used admits `aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaa`, which postgres
 * refuses with exactly that 22P02.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DealBoardWhose {
  /** May pick whose work — the radios and the colleague picker are drawn. */
  seesAll: boolean;
  /** «Hammasi» is on, and honoured. */
  all: boolean;
  /** The picked colleague's id, or '' when none is honoured. */
  hodim: string;
}

export function dealBoardWhose(
  permissions: { has(code: string): boolean },
  asked: { scope?: string; hodim?: string },
): DealBoardWhose {
  const seesAll = dealBoardShape(permissions) === 'full' && permissions.has('crm.leads.view_all');
  return {
    seesAll,
    all: seesAll && asked.scope === 'all',
    hodim: seesAll && UUID.test(asked.hodim ?? '') ? asked.hodim! : '',
  };
}

/**
 * Who may move a prixod between deals — tie it to one, re-file it, take it
 * off, or open a new deal born with it (2026-11-18).
 *
 * The deal-write list alone answered this until the sellers were given every
 * client's cargo on Ostatka and the board (his «sotuvchilarga … skladdagi
 * yuklarni korishga ruxsat», 1a): from there every row opens its prixod card,
 * and the card's «Bitim» cell let any seller take a COLLEAGUE's prixod off the
 * colleague's deal (which zeroes that deal's unpaid upsale), file it on another
 * deal, or open a deal of his own born with it. Seeing a colleague's cargo is
 * what he asked for; moving it is not.
 *
 *  - The office decides for everybody: the VED (the prixod links are his work,
 *    17a / G1 a), whoever manages clients, whoever reads every funnel.
 *  - A prixod standing on a job somebody OWNS is that owner's to move. Not
 *    the client's sales manager's: since Uch band Q3 b a colleague's request
 *    about his client is the COLLEAGUE's sale, and taking its cargo off zeroes
 *    the colleague's unpaid upsale — the very harm this door exists for (the
 *    as-built review, SEL-3).
 *  - Otherwise a seller (`crm.leads`) moves a prixod that is HIS: he is the
 *    client's sales manager, or the seller the prixod was stamped with.
 *  - And one more: a prixod standing on NO deal, onto a deal HE owns — the deal
 *    card's own attach, for a won lead about a colleague's client (Uch band
 *    Q3 b), whose prixods are stamped with the colleague.
 *
 * «The deal it stands on» is the prixod client's OWN deal (`ownDealOf`,
 * finance/truck-deal.ts). A client correction leaves `deal_id` on the old
 * client's job; that job's owner is nobody's owner here — counted, he could
 * file a colleague's client's cargo on the colleague's deals and open a deal
 * of his own born with it (the as-built review, SEL-1/EE-2). Both readers
 * hand the door the OWN deal or none; the door cannot see a client id.
 *
 * `target`: `undefined` = the question with no particular deal (the card
 * drawing its cell, a new deal born with the prixod — a NEW deal is always the
 * presser's, so it must never count as «his deal»); `null` = taking it off;
 * `{ ownerId }` = an existing deal.
 */
export interface RefileFacts {
  /** The client's sales manager. */
  clientManagerId: string | null;
  /** The seller stamped on the prixod (0117). */
  stampedSellerId: string | null;
  /** The prixod client's OWN deal the prixod stands on (`ownDealOf`), and its owner. */
  standingDealId: string | null;
  standingDealOwnerId: string | null;
}

export function mayRefileReceipt(
  permissions: { has(code: string): boolean },
  actorId: string,
  facts: RefileFacts,
  target?: { ownerId: string | null } | null,
): boolean {
  if (permissions.has('ved.docs') || permissions.has('clients.manage') || permissions.has('crm.leads.view_all')) {
    return true;
  }
  if (!permissions.has('crm.leads')) return false;
  if (facts.standingDealId !== null && facts.standingDealOwnerId !== null) {
    return facts.standingDealOwnerId === actorId;
  }
  if (facts.clientManagerId === actorId || facts.stampedSellerId === actorId) return true;
  return facts.standingDealId === null && target != null && target.ownerId === actorId;
}
