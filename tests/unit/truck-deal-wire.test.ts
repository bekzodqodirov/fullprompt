import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRUCK_DEAL_ERROR_KEYS } from '@/components/truck-deal-errors';

/**
 * His Q8 «c» (2026-10-27, «logist o'zi tanlaydi») from the screen to the door.
 * The rule itself is proven where it runs (`truckDealDecision`, unit; the
 * price door, integration); these are the halves no service test can see —
 * a forgotten line in the action or a `disabled` on the select passes every
 * one of them and breaks the screen (#531). Comments are stripped first, so
 * a fence cannot match the sentence that explains it (#725).
 */
const strip = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/\s\/\/\s.*$/, '')))
    .join('\n');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

const between = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  expect(start, `missing: ${from}`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  return source.slice(start, end > start ? end : undefined);
};

describe('the question the screens draw is the door’s', () => {
  it('the «Narx» tab reads the door’s own query once and posts the key it drew', () => {
    const page = read('src/app/(protected)/batches/[id]/pricing/page.tsx');
    expect(page).toContain('await dealCandidateRows([id], null)');
    expect(page).toMatch(/dealCandidatesOf\(\s*candidateRows\.filter\(\(row\) => row\.clientId === group\.clientId\),\s*group\.clientId,\s*\)/);
    expect(page).toContain('dealsSeen={candidates.key}');
  });

  it('the ledger reads the same query over its trucks — never the 40-row deal list — for a truck charge', () => {
    const page = read('src/app/(protected)/finance/[clientId]/page.tsx');
    expect(page).toContain('await dealCandidateRows(chargeTrucks.map((truck) => truck.batchId), clientId)');
    const form = read('src/app/(protected)/finance/[clientId]/tx-form.tsx');
    expect(form).toContain('{truckDeal && <input type="hidden" name="dealsSeen" value={truckDeal.key} />}');
    // The ledger's own deal select is for payments and truck-less prices.
    expect(form).toContain('{!truckDeal && deals.length > 0 && (');
  });

  it('the pricing form posts the key ALWAYS — the sole-deal form too, or a truck that turns two-deal is never caught', () => {
    const form = read('src/app/(protected)/batches/[id]/pricing/pricing-form.tsx');
    const hidden = form.indexOf('<input type="hidden" name="dealsSeen" value={dealsSeen} />');
    const branch = form.indexOf('{question && (');
    expect(hidden).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(hidden);
    // At the form's top level, beside the other hidden fields — not wrapped in
    // any condition of its own (review: `{question !== null && <input …/>}`
    // passed the order check above).
    expect(form).toMatch(/name="type" value="charge" \/>\s*<input type="hidden" name="dealsSeen" value=\{dealsSeen\} \/>/);
  });

  it('the action passes the key and the deal to the door', () => {
    const actions = read('src/app/(protected)/finance/actions.ts');
    const add = between(actions, 'export async function addTransactionAction', 'const voidSchema');
    expect(add).toContain("dealsSeen: formData.get('dealsSeen') || undefined,");
    expect(add).toContain("dealId: formData.get('dealId') || undefined,");
    expect(add).toContain('addTransaction(parsed.data,');
  });
});

describe('the select can never post a deal nobody chose', () => {
  const select = read('src/components/truck-deal-select.tsx');

  it('is required, never disabled, and its placeholder is not disabled either', () => {
    // The whole opening tag (its onChange holds an arrow, so not «up to >»).
    const tag = between(select, '<select', 'data-testid="truck-deal-select"');
    expect(tag).toContain('name="dealId"');
    expect(tag).toContain('required');
    // A disabled select posts nothing (#171) …
    expect(tag).not.toContain('disabled');
    // … and a disabled placeholder makes an unmatched value fall onto the
    // first DEAL (review).
    expect(select).toContain('<option value="">');
    expect(select).not.toMatch(/<option[^>]*disabled/);
  });

  it('both forms show the choice only under the question it was made for', () => {
    for (const path of [
      'src/app/(protected)/batches/[id]/pricing/pricing-form.tsx',
      'src/app/(protected)/finance/[clientId]/tx-form.tsx',
    ]) {
      expect(read(path), path).toMatch(/shownDealChoice\(choice, /);
    }
  });
});

describe('the confirmation is the question that is posted', () => {
  const form = read('src/app/(protected)/batches/[id]/pricing/pricing-form.tsx');

  it('is drawn only while the amount, the currency and the deal are still the ones asked about', () => {
    expect(form).toContain(
      'asked.amount === amount && asked.currency === currency && asked.deal === shown && asked.seen === dealsSeen',
    );
    // It prints the figure it was asked with, never the live one.
    expect(form).toContain('usd: `$${asked.usd.toFixed(2)}`');
  });

  it('the deal, the currency and the date take it back, as the amount always did', () => {
    const deal = between(form, '<TruckDealSelect', '/>');
    expect(deal).toContain('reask()');
    expect(between(form, 'name="currency"', '</select>')).toContain('reask()');
    for (const field of ['name="txDate"', 'name="amount"']) {
      expect(between(form, field, '/>'), field).toContain('reask()');
    }
    // …and taking it back disarms a «baribir saqlash» that never reached the action.
    expect(between(form, 'const reask = () => {', '};')).toContain('confirmed.current = false;');
  });

  it('«baribir saqlash» is armed only for a press the browser will send', () => {
    const confirm = between(form, 'data-testid="pricing-deviation-confirm"', '</button>');
    const valid = confirm.indexOf('form.reportValidity()');
    const armed = confirm.indexOf('confirmed.current = true;');
    expect(valid).toBeGreaterThan(-1);
    expect(armed).toBeGreaterThan(valid);
  });
});

describe('the door decides twice, on the same statement', () => {
  it('re-reads the cargo inside its transaction, after the truck lock, with the transaction’s handle', () => {
    const service = read('src/modules/wms/finance/service.ts');
    const fn = between(service, 'export async function addTransaction', 'export const moveChargeSchema');
    const cancelled = fn.indexOf("throw new FinanceError('batch_cancelled')");
    const again = fn.indexOf('await cargoAboard(values.batchId, input.clientId, tx)');
    expect(cancelled).toBeGreaterThan(-1);
    expect(again).toBeGreaterThan(cancelled);
    expect(fn).toContain("if (again.dealId !== values.dealId) throw new FinanceError('deals_changed')");
  });

  it('reads «bitimsiz» before anything treats the deal as a uuid', () => {
    const service = read('src/modules/wms/finance/service.ts');
    const fn = between(service, 'export async function addTransaction', 'export const moveChargeSchema');
    const sentinel = fn.indexOf("input.dealId === 'none'");
    const lookup = fn.indexOf('db.query.deals.findFirst');
    expect(sentinel).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(sentinel);
    expect(fn).toContain('where: eq(deals.id, postedDeal)');
  });
});

describe('every refusal has words, in every bundle', () => {
  it('the map’s keys exist in all four locales', () => {
    for (const locale of ['ru', 'uz', 'en', 'zh-CN']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { finance: Record<string, string> };
      for (const key of Object.values(TRUCK_DEAL_ERROR_KEYS)) {
        expect(bundle.finance[key], `${locale} finance.${key}`).toBeTruthy();
      }
    }
  });
});
