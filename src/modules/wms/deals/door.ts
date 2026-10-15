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
