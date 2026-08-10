import { describe, expect, it } from 'vitest';
import { moneyOwnerFilter, seesAllMoney } from '@/modules/wms/finance/scope';
import { defaultThreadManager } from '@/modules/wms/crm/conversations';

const actor = (id: string, ...permissions: string[]) => ({
  id,
  permissions: new Set(permissions),
});

/**
 * The owner, logged in as a seller: «menga boshqa clientlarning financi
 * ko'rinyabti — unga faqat o'zini ko'rinishi yetarli». `sales_manager` holds
 * `finance.view`, and every money screen treated that as the whole ledger.
 */
describe('whose money a person reads', () => {
  it('a seller reads their own book — finance.view is a door, not a licence', () => {
    const seller = actor('u-seller', 'finance.view', 'clients.view_own', 'crm.leads');
    expect(seesAllMoney(seller)).toBe(false);
    expect(moneyOwnerFilter(seller)).toBe('u-seller');
  });

  it('the accountant reads everything', () => {
    const acc = actor('u-acc', 'finance.view', 'finance.manage');
    expect(seesAllMoney(acc)).toBe(true);
    expect(moneyOwnerFilter(acc)).toBeUndefined();
  });

  it('whoever administers the client book reads everything', () => {
    expect(seesAllMoney(actor('u-adm', 'finance.view', 'clients.manage'))).toBe(true);
  });

  it('there is no third answer: a scoped person always carries a filter', () => {
    // The failure `warehouseScope` was written to end (#199): a filter that
    // can quietly become "no filter" fails in the permissive direction.
    const seller = actor('u-x', 'finance.view');
    expect(moneyOwnerFilter(seller)).not.toBeUndefined();
    expect(moneyOwnerFilter(seller)).toBe('u-x');
  });
});

/**
 * Two managers on two personal Telegram accounts are two conversations.
 * Merging them by timestamp shows a thread that never happened.
 */
describe('which conversation a client card opens on', () => {
  const m = (id: string, messages: number, lastAt: string | null) => ({
    id,
    name: id,
    messages,
    lastAt,
  });

  it('opens on whoever spoke last, not whoever spoke most', () => {
    const managers = [
      m('busy', 500, '2026-01-01T00:00:00Z'),
      m('recent', 3, '2026-08-10T00:00:00Z'),
    ];
    expect(defaultThreadManager(managers)).toBe('recent');
  });

  it('does not choose when there is nothing to choose between', () => {
    expect(defaultThreadManager([])).toBeNull();
    expect(defaultThreadManager([m('only', 9, '2026-08-10T00:00:00Z')])).toBeNull();
  });

  it('survives a manager with no timestamp rather than picking them', () => {
    const managers = [m('nulled', 2, null), m('real', 1, '2026-08-10T00:00:00Z')];
    expect(defaultThreadManager(managers)).toBe('real');
  });
});
