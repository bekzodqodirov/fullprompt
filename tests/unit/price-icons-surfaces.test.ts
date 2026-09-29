import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The 0119 surfaces nothing else draws a line to (review, 2026-09-29): the
 * VED home row, the nazorat «shown / total», the workspace's sheet fold, and
 * the pricing lot's link state and «↑ yuqorida». Integration proves the
 * COUNTS behind them; deleting the JSX that prints them left every gate
 * green. Source-shape on purpose — the home row needs a seal to appear in a
 * browser, and a seal is configuration every later spec inherits (#935) —
 * and comments are stripped first, or a fence matches the sentence that
 * explains it (#725).
 */

function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

/** The JSX element carrying `testid`, from its opening `<` to the matching close of the props. */
function elementWith(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `${marker} must be drawn`).toBeGreaterThan(-1);
  const open = source.lastIndexOf('<', at);
  const close = source.indexOf('/>', at);
  const end = source.indexOf('>', at);
  return source.slice(open, Math.max(close, end) + 2);
}

describe('0119 surfaces', () => {
  it('home draws «Tasdiqlash kerak» from the flow’s own count, to the control screen', () => {
    const home = read('src/app/(protected)/page.tsx');
    const row = elementWith(home, 'testid="ved-flow-links"');
    expect(row).toContain('count={flow.calcLinksPending}');
    expect(row).toContain('href="/hisoblash/nazorat"');
    expect(home).toContain('flow.calcLinksPending > 0 &&');
    // …and the count is the control screen's own function, not a restatement.
    const flows = read('src/modules/wms/home/role-flows.ts');
    expect(flows).toMatch(/linkSuggestionCount\(\{ scope: calcControlScopeFor\(actor\), actorId: actor\.id \}\)/);
  });

  it('nazorat says «shown / total» from the uncapped count', () => {
    const page = read('src/app/(protected)/hisoblash/nazorat/page.tsx');
    expect(page).toContain('linkSuggestionCount(who)');
    const line = page.slice(page.indexOf('data-testid="link-shown-of"'));
    expect(page.indexOf('data-testid="link-shown-of"')).toBeGreaterThan(-1);
    expect(line.slice(0, 200)).toContain("t('linksShownOf', { shown: queue.length, total: queueTotal })");
  });

  it('the workspace hands the sealed sheet to the sealed panel', () => {
    const page = read('src/app/(protected)/hisoblash/[id]/page.tsx');
    expect(page).toMatch(/calcSheetsForRequest\(id, sheetSight\)/);
    expect(page).toMatch(/sealedSheet=\{[^}]*<CalcSheet data=\{sheet\} sight=\{sheetSight\} \/>/);
    const workspace = read('src/app/(protected)/hisoblash/[id]/calc-workspace.tsx');
    expect(workspace).toContain('sheet={sealedSheet}');
    expect(workspace).toContain('data-testid="calc-sealed-sheet"');
  });

  it('the pricing lot prints its link state, naming the calculation, and points later lots up', () => {
    const page = read('src/app/(protected)/batches/[id]/pricing/page.tsx');
    const at = page.indexOf('data-testid="lot-calc-link"');
    expect(at).toBeGreaterThan(-1);
    const link = page.slice(at, at + 900);
    expect(link).toContain('linkedCalcLabel(dealCalc, lot.calcRequestId)');
    expect(link).toContain("t('calcLinkConfirmed')");
    expect(link).toContain("t('calcLinkSuggested')");
    expect(page).toMatch(/href=\{`#\$\{anchor\}`\}[^>]*data-testid="lot-calc-above"/);
    expect(page).toContain('id={firstOfDeal ? anchor : undefined}');
  });

  it('an internal leg pays for neither icon', () => {
    const page = read('src/app/(protected)/batches/[id]/pricing/page.tsx');
    expect(page).toMatch(/internal \? Promise\.resolve\(new Map<string, PriceHistory>\(\)\) : priceHistoryForLots\(/);
    expect(page).toMatch(/\{internal \? null : \(\s*<div className="mt-1 flex flex-wrap gap-2" data-testid="lot-icons">/);
  });

  it('every hint read on the pricing page fails soft', () => {
    const page = read('src/app/(protected)/batches/[id]/pricing/page.tsx');
    expect(page).toMatch(/soft\('similar picks', similarPicksFor\(/);
    expect(page).toMatch(/soft\('deal calc sheets', dealCalcSheets\(/);
  });
});
