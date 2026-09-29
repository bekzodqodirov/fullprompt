import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «This expense is a seller's commission» is said ONCE
 * (`accounting/payout-sql.ts` `commissionPayoutSql`, 0117): the upsale's
 * `calc_offers.payout_expense_id` OR the KPI's `kpi_payouts.expense_id`. It
 * used to be the upsale literal written out in two readers, and the KPI
 * payout would have slipped past both. So the lookup SHAPE may appear in
 * that one file, and both readers must call it.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const HOME = 'src/modules/wms/accounting/payout-sql.ts';
const UPSALE_SHAPE = /FROM\s+calc_offers\s+\w+\s+WHERE\s+\w+\.payout_expense_id\s*=/i;
const KPI_SHAPE = /FROM\s+kpi_payouts\s+\w+\s+WHERE\s+\w+\.expense_id\s*=/i;

describe('one home for «a commission payout»', () => {
  const files = globSync('src/**/*.{ts,tsx}');

  it('the home says both halves', () => {
    const home = stripComments(readFileSync(HOME, 'utf8'));
    expect(home).toMatch(UPSALE_SHAPE);
    expect(home).toMatch(KPI_SHAPE);
  });

  it('no other file restates either lookup', () => {
    const offenders = files.filter((path) => {
      if (path === HOME) return false;
      const source = stripComments(readFileSync(path, 'utf8'));
      return UPSALE_SHAPE.test(source) || KPI_SHAPE.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('«To’landi» and the cost merge both refuse a commission through it', () => {
    const recurring = stripComments(readFileSync('src/modules/wms/accounting/recurring-sql.ts', 'utf8'));
    expect(recurring).toMatch(/AND NOT \$\{commissionPayoutSql\(sql`e\.id`\)\}/);
    const merge = stripComments(readFileSync('src/modules/wms/accounting/cost-merge.ts', 'utf8'));
    expect(merge).toMatch(/NOT \$\{commissionPayoutSql\(/);
  });
});
