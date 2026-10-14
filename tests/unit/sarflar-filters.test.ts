import { describe, expect, it } from 'vitest';
import { readSpendFilters } from '@/modules/wms/accounting/sarflar';

/**
 * The register's filters out of the URL (docs/SARFLAR.md §8.4): a value is
 * a forged post until read, and a reader without expense rows is never
 * filtered onto rows his register cannot show — an expense-only payer
 * bucket would answer «nothing here» under a bucket the map says holds money.
 */
describe('the payer filter, per reader', () => {
  const blind = { seesStaff: false, expenseRows: false };
  const full = { seesStaff: true, expenseRows: true };

  it('a reader without expense rows reads the cost book’s payers only', () => {
    expect(readSpendFilters({ payer: 'book' }, blind).payer).toBeNull();
    expect(readSpendFilters({ payer: 'noKassa' }, blind).payer).toBeNull();
    expect(readSpendFilters({ payer: 'own' }, blind).payer).toBeNull();
    expect(readSpendFilters({ payer: 'kassa' }, blind).payer).toBe('kassa');
    expect(readSpendFilters({ payer: 'queue' }, blind).payer).toBe('queue');
  });

  it('the expense book’s reader keeps every bucket, and nonsense is no filter', () => {
    expect(readSpendFilters({ payer: 'book' }, full).payer).toBe('book');
    expect(readSpendFilters({ payer: 'noKassa' }, full).payer).toBe('noKassa');
    expect(readSpendFilters({ payer: 'own' }, full).payer).toBe('own');
    expect(readSpendFilters({ payer: 'drop table' }, full).payer).toBeNull();
  });
});
