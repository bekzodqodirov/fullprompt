import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mayRefileReceipt, type RefileFacts } from '@/modules/wms/deals/door';
import { mayReadCostAmounts } from '@/modules/wms/costing/cost-sight';
import { ROLE_CODES, ROLE_MATRIX } from '@/modules/platform/rbac/catalog';

/**
 * A seller SEES every client's prixod and MOVES only his own (2026-11-18).
 *
 * The sellers were given every client's cargo on Ostatka and the board (his
 * «sotuvchilarga … skladdagi yuklarni korishga ruxsat», 1a), and each row
 * opens its prixod card. The card's «Bitim» cell asked only the deal-write
 * list, so any seller could take a colleague's prixod off the colleague's
 * deal (zeroing its unpaid upsale), file it elsewhere, or open a deal of his
 * own born with it — and read the colleague's quote and discount in the
 * page's payload. The design judge's LEAK-1. Seeing is the request; moving is
 * not.
 */

const ME = 'u-me';
const COLLEAGUE = 'u-colleague';
const seller = new Set(ROLE_MATRIX.sales_manager);
const facts = (over: Partial<RefileFacts> = {}): RefileFacts => ({
  clientManagerId: COLLEAGUE,
  stampedSellerId: COLLEAGUE,
  standingDealId: 'd-1',
  standingDealOwnerId: COLLEAGUE,
  ...over,
});

describe('mayRefileReceipt — whose prixod it is to move', () => {
  it("refuses a seller a colleague's prixod, whichever way he would move it", () => {
    expect(mayRefileReceipt(seller, ME, facts())).toBe(false);
    expect(mayRefileReceipt(seller, ME, facts(), null)).toBe(false);
    expect(mayRefileReceipt(seller, ME, facts(), { ownerId: ME })).toBe(false);
    expect(mayRefileReceipt(seller, ME, facts(), { ownerId: COLLEAGUE })).toBe(false);
  });

  it('lets him move his own: the client is his, or the stamp, or the deal it stands on — each one alone', () => {
    const loose = facts({ standingDealId: null, standingDealOwnerId: null });
    expect(mayRefileReceipt(seller, ME, { ...loose, clientManagerId: ME })).toBe(true);
    expect(mayRefileReceipt(seller, ME, { ...loose, stampedSellerId: ME }, null)).toBe(true);
    expect(mayRefileReceipt(seller, ME, facts({ standingDealOwnerId: ME }), { ownerId: COLLEAGUE })).toBe(true);
    expect(mayRefileReceipt(seller, ME, facts({ standingDealOwnerId: ME }))).toBe(true);
  });

  it('the client’s seller is never locked out of his client’s cargo by whoever owns the deal (#1805: tried and taken back)', () => {
    // A client handed over to him, a deal an admin or a colleague opened: the
    // deal's owner OUTRANKING him made a colleague's attach a one-way door
    // (the fixes' review, RR-1/T1/T4). Both of them may move it — the stated trade.
    expect(mayRefileReceipt(seller, ME, facts({ clientManagerId: ME }), null)).toBe(true);
    expect(mayRefileReceipt(seller, ME, facts({ clientManagerId: ME }), { ownerId: ME })).toBe(true);
    expect(mayRefileReceipt(seller, ME, facts({ stampedSellerId: ME }), { ownerId: COLLEAGUE })).toBe(true);
    expect(mayRefileReceipt(seller, COLLEAGUE, facts({ clientManagerId: ME }), null)).toBe(true);
  });

  it('lets him attach a prixod standing on NO deal to a deal he owns — and only that', () => {
    // The deal card's attach, for a won lead about a colleague's client (Uch band Q3 b).
    const loose = facts({ standingDealId: null, standingDealOwnerId: null });
    expect(mayRefileReceipt(seller, ME, loose, { ownerId: ME })).toBe(true);
    expect(mayRefileReceipt(seller, ME, loose, { ownerId: COLLEAGUE })).toBe(false);
    // A NEW deal is always the presser's — it must not make the cargo his.
    expect(mayRefileReceipt(seller, ME, loose)).toBe(false);
    expect(mayRefileReceipt(seller, ME, loose, null)).toBe(false);
    // An ownerless deal it stands on is still a deal: the clause is for loose cargo only.
    expect(mayRefileReceipt(seller, ME, facts({ standingDealOwnerId: null }), { ownerId: ME })).toBe(false);
  });

  it('a deal he owns does not reach cargo standing on a colleague’s deal', () => {
    expect(mayRefileReceipt(seller, ME, facts(), { ownerId: ME })).toBe(false);
  });

  it('the office decides for everybody', () => {
    for (const code of ['ved.docs', 'clients.manage', 'crm.leads.view_all']) {
      expect(mayRefileReceipt(new Set([code]), ME, facts()), code).toBe(true);
    }
    expect(mayRefileReceipt(new Set(ROLE_MATRIX.ved_manager), ME, facts())).toBe(true);
    expect(mayRefileReceipt(new Set(ROLE_MATRIX.logist), ME, facts())).toBe(true);
  });

  it('nobody without the seller grant moves anything by this rule', () => {
    expect(mayRefileReceipt(new Set(ROLE_MATRIX.warehouse_operator), ME, facts({ clientManagerId: ME }))).toBe(false);
  });
});

describe('mayReadCostAmounts — who reads a prixod’s bills', () => {
  it('the seller does not (his 4a); everybody who enters or reads truck costs does', () => {
    const reads = (role: (typeof ROLE_CODES)[number]) => mayReadCostAmounts(new Set(ROLE_MATRIX[role]));
    expect(reads('sales_manager')).toBe(false);
    for (const role of ['super_admin', 'admin', 'logist', 'ved_manager', 'warehouse_manager', 'warehouse_operator', 'accountant', 'viewer'] as const) {
      expect(reads(role), role).toBe(true);
    }
  });
});

describe('the two doors that move a prixod ask the rule — and the card draws by it', () => {
  const actions = readFileSync('src/app/(protected)/bitimlar/actions.ts', 'utf8');
  const card = readFileSync('src/app/(protected)/receipts/[id]/page.tsx', 'utf8');

  const body = (source: string, name: string): string => {
    const start = source.indexOf(`export async function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const next = source.indexOf('\nexport ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };

  // The answer is OBEYED, not only asked for (the as-built review, FENCE-1 —
  // receipt-files-wire's idiom): a bare call, or an inverted `if`, is lint-clean
  // and passes an indexOf. The behaviour is pinned too, as a seller, in
  // tests/integration/refile-door-actions.integration.test.ts.
  it('linkReceiptAction asks it with the target deal, obeys it, before the link', () => {
    const fn = body(actions, 'linkReceiptAction');
    const ask = fn.search(/const notHis = await refileRefusal\(actor, receiptId, dealId\);\s*if \(notHis\) throw new DealError\(notHis\);/);
    const link = fn.indexOf('linkReceipt(receiptId, dealId');
    expect(ask).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(ask);
  });

  it('a deal born with a prixod asks it with NO target, obeys it, before the deal exists', () => {
    const fn = body(actions, 'createDealAction');
    const ask = fn.search(/const notHis = await refileRefusal\(actor, receiptId\);\s*if \(notHis\) throw new DealError\(notHis\);/);
    const create = fn.indexOf('createDeal(');
    expect(ask).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(ask);
  });

  it('the card asks the rule over the OWN deal the prixod stands on — the facts refileRefusal reads (SEL-1, FENCE-2)', () => {
    expect(card).toMatch(
      /const refileFacts = \{\s*clientManagerId: client\?\.salesManagerId \?\? null,\s*stampedSellerId: receipt\.salesManagerId,\s*standingDealId: ownDeal\?\.id \?\? null,\s*standingDealOwnerId: ownDeal\?\.ownerId \?\? null,\s*\};/,
    );
    expect(card).toMatch(/const mayRefile = mayWriteHere && mayRefileReceipt\(actor\.permissions, actor\.id, refileFacts\);/);
    // Drawn where the prixod is his, or where a deal HE owns would take it.
    expect(card).toMatch(/const canLinkDeal = mayWriteHere && \(mayRefile \|\| dealOptions\.length > 0\);/);
    expect(card).toMatch(/mayRefileReceipt\(actor\.permissions, actor\.id, refileFacts, \{ ownerId: dealOwners\.get\(d\.id\) \?\? null \}\)/);
    // A restricted cell takes nothing off and opens no deal born with it.
    expect(card).toContain('detachable={mayRefile}');
    expect(card).toContain("!ownDeal && receipt.status === 'confirmed' && mayEditDealTerms(actor.permissions) && mayRefile");
    // The foreign job is named to whoever is drawn the cell — a restricted one
    // in its own sentence with no «Uzish» (RR-4); and the empty option there is a
    // disabled «choose a deal of yours», never «Uzish» (RR-3/T2).
    expect(card).toContain('foreign={foreignDeal ? { code: foreignDeal.code } : null}');
    const cell = readFileSync('src/app/(protected)/receipts/[id]/deal-link.tsx', 'utf8');
    expect(cell).toMatch(/\{detachable \? \(\s*<option value="">— \{td\('unlink'\)\}<\/option>\s*\) : \(\s*<option value="" disabled data-testid="receipt-deal-pick-own">/);
    expect(cell).toContain("t(!detachable ? 'dealForeignOwnOnly' : newDealHref ? 'dealForeign' : 'dealForeignPick'");
    expect(cell).toContain("(detachable || dealId !== '')");
  });

  it('the new-deal form draws «born with» only for a prixod the rule lets the presser move (RR-5)', () => {
    const page = readFileSync('src/app/(protected)/bitimlar/new/page.tsx', 'utf8');
    expect(page).toMatch(/\) === null &&[\s\S]{0,400}\(await refileRefusal\(actor, forReceipt\.id\)\) === null\s*\? \{ id: forReceipt\.id/);
  });

  it('the deal card offers only the loose prixods the rule lets THIS reader attach to THIS deal (SEL-2)', () => {
    const page = readFileSync('src/app/(protected)/bitimlar/[id]/page.tsx', 'utf8');
    expect(page).toMatch(/const attachable = unlinked\s*\.filter\(\(r\) =>\s*mayRefileReceipt\(/);
    expect(page).toMatch(
      /clientManagerId: row\.clientSalesManagerId,\s*stampedSellerId: r\.stampedSellerId,\s*standingDealId: null,\s*standingDealOwnerId: null,\s*\},\s*\{ ownerId: row\.deal\.ownerId \},/,
    );
    expect(page).toContain('<LinkReceipt dealId={row.deal.id} receipts={attachable} />');
    expect(page).not.toContain('receipts={unlinked}');
    // …and says the refusal in words, never a bare «Xatolik».
    const panel = readFileSync('src/app/(protected)/bitimlar/link-receipt.tsx', 'utf8');
    expect(panel).toContain("setError(result.ok ? null : (result.error ?? 'error'));");
    expect(panel).toContain("t(`errors.${error}` as 'errors.validation')");
  });

  it('the cell is handed what it draws and never a deal row (no quote, discount or note in the payload)', () => {
    expect(card).toContain(
      'const dealChoices = dealRows.map((d) => ({ id: d.id, code: d.code, title: d.title, cargo: d.cargo }));',
    );
    expect(card).toContain('options={dealChoices}');
    expect(card).not.toMatch(/options=\{dealRows\}/);
  });

  it('the card lists a prixod’s bills only to whoever reads cost amounts', () => {
    expect(card).toMatch(/const showCosts =\s*\(costMeta !== null \|\| mayReadCostAmounts\(actor\.permissions\)\) &&/);
  });
});
