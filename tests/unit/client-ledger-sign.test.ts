import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signedUsd } from '@/modules/wms/finance/service';

/**
 * The client ledger's sign rule has ONE home (`signedUsdSql` / `signedUsd` in
 * finance/service.ts) since the refund kind arrived (0101, owner R6a).
 *
 * Before it, eleven places restated the sign as «a charge is +, ANYTHING ELSE
 * is −» — true of a two-kind ledger and wrong the moment a third kind exists:
 * a refund (money we handed BACK) would have read as money received, lowering
 * the client's debt, the handover gate, the ageing and the Balans at once.
 * The shape is structural, so the fence is too: no source file may decide the
 * sign by testing for 'charge' and negating the rest.
 */
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'migrations' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('the client ledger sign rule', () => {
  it('a refund raises the balance like a charge; only a payment lowers it', () => {
    expect(signedUsd({ type: 'charge', amountUsd: 10 })).toBe(10);
    expect(signedUsd({ type: 'refund', amountUsd: 10 })).toBe(10);
    expect(signedUsd({ type: 'payment', amountUsd: 10 })).toBe(-10);
  });

  it("no file in src/ decides the sign by «'charge' then +, else −»", () => {
    const offenders = files('src').filter((path) =>
      /'charge'\s*then[^;]{0,160}?else\s*-/i.test(strip(readFileSync(path, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * U-K1 (iii), 0105: the mirror image — «a payment is the ONLY credit». True
   * of a three-kind ledger and wrong the moment the compensation exists: it
   * lowers the balance like a payment, so every CASE that named 'payment'
   * alone read it as a debt. The credit list is `CREDIT_KINDS`, rendered by
   * `signedUsdSql` (ledger-sql.ts). Allowed where the sentence means
   * something else:
   * - finance/service.ts, ledger-kinds.ts, ledger-sql.ts — the rule's homes;
   * - accounting/service.ts — `accountBalancesBetween`'s `signOf` is the
   *   KASSA's sign (index 0 the client till, where a compensation correctly
   *   moves nothing; index 4 the partner ledger), not the client balance.
   */
  it("no file in src/ decides the balance by «'payment' then −»", () => {
    const allowed = [
      'src/modules/wms/finance/service.ts',
      'src/modules/wms/finance/ledger-kinds.ts',
      'src/modules/wms/finance/ledger-sql.ts',
      'src/modules/wms/accounting/service.ts',
    ];
    const offenders = files('src')
      .filter((path) => !allowed.includes(path))
      .filter((path) => {
        const text = strip(readFileSync(path, 'utf8'));
        return /'payment'\s*then\s*-/i.test(text) || /type\s*===\s*'payment'\s*\?\s*-/.test(text);
      });
    expect(offenders).toEqual([]);
  });

  /**
   * U-K1 (iv), 0105: every named REVENUE reader knows a price can be taken
   * back — it asks `revenueUsdSql` / `REVENUE_TYPES` / the compensation by
   * name. A reader left on `type = 'charge'` alone reports the lost cargo's
   * price as earned. Sliced by function name, comments stripped (#725);
   * anchored on the names (#720), so a rename turns this red rather than
   * silently checking nothing.
   */
  it('every revenue reader counts the price taken back', () => {
    const readers: [string, string][] = [
      ['src/modules/wms/accounting/reports.ts', 'profitAndLoss'],
      ['src/modules/wms/accounting/reports.ts', 'profitByBatch'],
      ['src/modules/wms/accounting/reports.ts', 'unbatchedMoney'],
      ['src/modules/wms/accounting/reports.ts', 'profitByClient'],
      ['src/modules/wms/deals/service.ts', 'dealProfit'],
      ['src/modules/wms/crm/seller-report.ts', 'sellerPerformanceOwn'],
      ['src/modules/wms/finance/service.ts', 'clientMoneyInPeriod'],
      ['src/modules/wms/finance/service.ts', 'clientBalances'],
      ['src/modules/wms/finance/client-cargo.ts', 'clientCargo'],
      ['src/modules/wms/reports/overview.ts', 'moneySnapshot'],
      ['src/modules/wms/calc/upsale-service.ts', 'upsaleStateOf'],
    ];
    const blind: string[] = [];
    for (const [path, name] of readers) {
      const text = strip(readFileSync(path, 'utf8'));
      const start = text.search(new RegExp(`export (async )?function ${name}\\b`));
      expect(start, `${name} not found in ${path}`).toBeGreaterThanOrEqual(0);
      const next = text.indexOf('\nexport ', start + 1);
      const body = text.slice(start, next < 0 ? text.length : next);
      if (!/revenueUsdSql\(|REVENUE_TYPES|compensat/.test(body)) blind.push(`${path}: ${name}`);
    }
    expect(blind).toEqual([]);
  });
});
