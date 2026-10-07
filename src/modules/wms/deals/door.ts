/**
 * The deal doors — who may open a deal card, who may work its terms, and which
 * board a person gets. ONE pure module with no imports at all, so a client
 * component, a pure module (`calc/upsale-scope.ts`) and a test with no database
 * can all ask the same question.
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
