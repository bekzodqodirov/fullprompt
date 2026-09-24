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
});
