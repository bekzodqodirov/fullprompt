import { describe, expect, it } from 'vitest';
import { payerView } from '@/modules/wms/partners/staff';

/**
 * A cost row's payer on every cost card (M3a, SARFLAR §8.2): a colleague's
 * own pocket is named only to the staff-money readers — anybody else is told
 * that a member of staff paid, so the row does not read as unpaid.
 */
describe('payerView', () => {
  const staffRow = { partnerName: 'Dilnoza (hodim)', partnerIsStaff: true };
  const firmRow = { partnerName: 'Trans firma', partnerIsStaff: false };

  it('names a colleague only to the expense book’s readers', () => {
    expect(payerView(new Set(['finance.expenses']), staffRow)).toEqual({ partnerName: 'Dilnoza (hodim)', payerHidden: false });
    expect(payerView(new Set(['costs.enter_batch', 'finance.manage']), staffRow)).toEqual({ partnerName: null, payerHidden: true });
  });

  it('a firm stays named for everybody', () => {
    expect(payerView(new Set(['costs.enter_batch']), firmRow)).toEqual({ partnerName: 'Trans firma', payerHidden: false });
  });
});
