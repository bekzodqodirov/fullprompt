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

  it('lets him move his own: the client is his, or the stamp, or the deal it stands on', () => {
    expect(mayRefileReceipt(seller, ME, facts({ clientManagerId: ME }))).toBe(true);
    expect(mayRefileReceipt(seller, ME, facts({ stampedSellerId: ME }), null)).toBe(true);
    expect(mayRefileReceipt(seller, ME, facts({ standingDealOwnerId: ME }), { ownerId: COLLEAGUE })).toBe(true);
  });

  it('lets him attach a prixod standing on NO deal to a deal he owns — and only that', () => {
    // The deal card's attach, for a won lead about a colleague's client (Uch band Q3 b).
    const loose = facts({ standingDealId: null, standingDealOwnerId: null });
    expect(mayRefileReceipt(seller, ME, loose, { ownerId: ME })).toBe(true);
    expect(mayRefileReceipt(seller, ME, loose, { ownerId: COLLEAGUE })).toBe(false);
    // A NEW deal is always the presser's — it must not make the cargo his.
    expect(mayRefileReceipt(seller, ME, loose)).toBe(false);
    expect(mayRefileReceipt(seller, ME, loose, null)).toBe(false);
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

  it('linkReceiptAction asks it with the target deal, before the link', () => {
    const fn = body(actions, 'linkReceiptAction');
    const ask = fn.indexOf('await refileRefusal(actor, receiptId, dealId)');
    const link = fn.indexOf('linkReceipt(receiptId, dealId');
    expect(ask).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(ask);
  });

  it('a deal born with a prixod asks it with NO target, before the deal exists', () => {
    const fn = body(actions, 'createDealAction');
    const ask = fn.indexOf('await refileRefusal(actor, receiptId)');
    const create = fn.indexOf('createDeal(');
    expect(ask).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(ask);
  });

  it('the card draws the «Bitim» cell only where the rule says the prixod is the reader’s', () => {
    expect(card).toMatch(/const canLinkDeal =\s*canWriteDeal\(actor\.permissions\) &&\s*Boolean\(receipt\.clientId\) &&\s*mayRefileReceipt\(/);
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
