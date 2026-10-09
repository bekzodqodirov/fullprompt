import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  customsFeeFor,
  customsFor,
  type CustomsResult,
  type PricedGroup,
  type PricedItem,
} from '@/modules/wms/calc/pricing';
import { EXCISE_MAY_APPLY, exciseAnswered, exciseMayApply, exciseUnitsFor } from '@/modules/wms/calc/excise';
import { calcSheetOf, sheetPartsAddUp, type SheetVersionRow } from '@/modules/wms/calc/sheet';
import { dayText, feeInputsValues, groupDigits, rateText, relawedQuery } from '@/modules/wms/calc/law-words';
import { sameGroupRates } from '@/modules/wms/calc/workspace';
import type { calcGroups } from '@/modules/platform/db/schema';

/**
 * P2 «Hisob» (2026-10-09) — the pure halves of the round: the excise list
 * and its unit rule, the fee's refusal words, the sealed sheet adding up,
 * the one-law comparison and the words the law is printed with. Every
 * expected figure is a LITERAL computed by hand from the law, or the
 * engine's own output read back through a second reader — never the rule
 * restated (#1116's lesson).
 */

const group = (over: Partial<PricedGroup> = {}): PricedGroup => ({
  seq: 1,
  label: 'Poyabzal',
  tnvedCode: '6403990000',
  dutyPct: 10,
  vatPct: 12,
  feeUsd: null,
  dutyMode: 'advalor',
  dutySpecific: null,
  dutyUnit: null,
  excisePct: null,
  exciseSpecific: null,
  exciseUnit: null,
  hasCertificate: true,
  dutyFree: false,
  vatFree: false,
  ...over,
});

const item = (over: Partial<PricedItem> = {}): PricedItem => ({
  seq: 1,
  label: 'Etik',
  quantity: 100,
  weightKg: 50,
  volumeM3: 1,
  bazaUsd: 10,
  bazaBasis: 'unit',
  measureUnit: null,
  measureQty: null,
  ...over,
});

describe('the excise list is a warning list, matched by heading (P2.4)', () => {
  it('names the agreed headings and nothing else', () => {
    expect([...EXCISE_MAY_APPLY]).toEqual([
      '2202', '2203', '2204', '2205', '2206', '2207', '2208', '2402', '2403', '2404', '2710', '8703', '8711',
    ]);
  });

  it('matches a code by its heading, ignoring formatting, never a short scrap', () => {
    expect(exciseMayApply('2203000100')).toBe(true);
    expect(exciseMayApply('8703.23.190')).toBe(true);
    expect(exciseMayApply('6403990000')).toBe(false);
    expect(exciseMayApply('220')).toBe(false);
    expect(exciseMayApply(null)).toBe(false);
  });

  it('«answered» is either shape; all null is the open question (MR-12)', () => {
    expect(exciseAnswered({ excisePct: 0, exciseSpecific: null })).toBe(true);
    expect(exciseAnswered({ excisePct: null, exciseSpecific: 0.5 })).toBe(true);
    expect(exciseAnswered({ excisePct: null, exciseSpecific: null })).toBe(false);
  });

  it('a pair unit is offered only when it IS the law’s own pair (judge S4)', () => {
    expect(exciseUnitsFor(null)).toEqual(['kg', 'dona', '1000_dona']);
    expect(exciseUnitsFor('kg')).toEqual(['kg', 'dona', '1000_dona']);
    expect(exciseUnitsFor('litr')).toEqual(['kg', 'dona', '1000_dona', 'litr']);
    expect(exciseUnitsFor('juft')).toEqual(['kg', 'dona', '1000_dona', 'juft']);
  });
});

describe('the excise prices, and sits in the VAT base (the kernel engine, read back)', () => {
  it('a specific excise per litre: $0.50 × 200 l', () => {
    // value 100 × $10 = 1000; duty 10 % = 100; excise 200 l × 0.5 = 100;
    // VAT 12 % of (1000 + 100 + 100) = 144; customs = 344.
    const r = customsFor(
      group({ tnvedCode: '2203000100', exciseSpecific: 0.5, exciseUnit: 'litr' }),
      [item({ measureUnit: 'litr', measureQty: 200 })],
    );
    expect(r).toMatchObject({ ok: true, valueUsd: 1000, dutyUsd: 100, exciseUsd: 100, vatUsd: 144, customsUsd: 344 });
  });

  it('per thousand pieces divides the count by a thousand', () => {
    // 20 000 sticks at $2 per 1000 = $40 of excise on a $1000 value.
    const r = customsFor(
      group({ tnvedCode: '2402200000', exciseSpecific: 2, exciseUnit: '1000_dona' }),
      [item({ quantity: 20_000, bazaUsd: 0.05 })],
    );
    expect(r).toMatchObject({ ok: true, valueUsd: 1000, exciseUsd: 40 });
  });
});

describe('the fee says WHOSE job its refusal is (P2.6)', () => {
  const base = { valueUsd: 5000, bhmUzs: 412_000, fxUzsPerUsd: 12_650, overrideUsd: null };

  it('a BHM setting that is not a positive number is the admin’s, not a typo', () => {
    for (const bhmUzs of [0, -1, Number.NaN]) {
      expect(customsFeeFor({ ...base, bhmUzs })).toEqual({ ok: false, reason: 'fee_bhm_bad' });
    }
  });

  it('an override needs no so‘m rate — the box that rescues a job with none', () => {
    expect(customsFeeFor({ ...base, fxUzsPerUsd: null, overrideUsd: 50 })).toEqual({
      ok: true,
      feeUsd: 50,
      bhmCoefficient: 0,
      overridden: true,
    });
  });

  it('no so‘m rate is the accountant’s, and an unreadable override stays a number problem', () => {
    expect(customsFeeFor({ ...base, fxUzsPerUsd: null })).toEqual({ ok: false, reason: 'fee_fx_missing' });
    expect(customsFeeFor({ ...base, overrideUsd: Number.NaN })).toEqual({ ok: false, reason: 'not_a_number' });
  });

  it('the inputs print as the office writes them — the sum checks by hand', () => {
    // 2.5 BHM × 412 000 ÷ 12 650 = 81.42 (to the cent).
    expect(feeInputsValues({ usd: 81.42, bhm: 2.5, bhmUzs: 412_000, fxUzsPerUsd: 12_650, fxDate: '2026-10-09' })).toEqual({
      bhm: '2.5',
      bhmUzs: '412 000',
      rate: '12 650',
      date: '09.10.2026',
      usd: '81.42',
    });
    // A hole in any input is no sentence at all (an override, an old seal).
    expect(feeInputsValues({ usd: 50, bhm: 0, bhmUzs: null, fxUzsPerUsd: 12_650, fxDate: '2026-10-09' })).toBeNull();
  });

  it('the small formatters', () => {
    expect(groupDigits(1_234_567.5)).toBe('1 234 567.5');
    expect(rateText(15)).toBe('15');
    expect(rateText(0.12345)).toBe('0.1235');
    expect(rateText(null)).toBe('—');
    expect(dayText('2026-01-31')).toBe('31.01.2026');
  });
});

describe('the sealed sheet adds up (P2.7)', () => {
  const version = (groups: unknown[]): SheetVersionRow => ({
    id: 'v-1',
    requestId: 'r-1',
    section: 'rastamojka',
    sealedAt: new Date('2026-10-01T09:00:00Z'),
    validUntil: new Date('2026-10-15T09:00:00Z'),
    totalUsd: 0,
    perM3Usd: null,
    perKgUsd: null,
    discountUsd: 0,
    extrasUsd: 0,
    freightZone: null,
    freightBandMin: null,
    freightRate: null,
    freightPerKg: null,
    freightListUsd: null,
    breakdown: { groups },
  });
  /** A group as the seal writes it into the breakdown — the engine's own
   * customs result, stored whole. */
  const sealed = (g: PricedGroup, customs: CustomsResult) => ({ ...g, customs, items: [] });

  it('a lgota group: duty $0, VAT on the value alone', () => {
    const g = group({ dutyFree: true });
    const customs = customsFor(g, [item()]);
    expect(customs).toMatchObject({ ok: true, dutyUsd: 0, vatUsd: 120, customsUsd: 120 });
    const sheet = calcSheetOf(version([sealed(g, customs)]), [], []);
    expect(sheet.groups[0]!.dutyFree).toBe(true);
    expect(sheet.groups[0]!.parts).toMatchObject({ dutyUsd: 0, addDutyUsd: 0, vatUsd: 120 });
    expect(sheetPartsAddUp(sheet.groups[0]!)).toBe(true);
  });

  it('a no-certificate group: the additional duty is its own printed part', () => {
    const g = group({ hasCertificate: false });
    const customs = customsFor(g, [item()]);
    expect(customs.ok).toBe(true);
    if (!customs.ok) return;
    expect(customs.addDutyUsd).toBeGreaterThan(0);
    const sheet = calcSheetOf(version([sealed(g, customs)]), [], []);
    const row = sheet.groups[0]!;
    expect(row.hasCertificate).toBe(false);
    expect(row.parts!.addDutyUsd).toBe(customs.addDutyUsd);
    expect(row.parts!.addDutyPct).toBe(customs.addDutyPct);
    expect(sheetPartsAddUp(row)).toBe(true);
    // …and a sheet that dropped the part would not add up — the check is
    // about the PRINTED lines, not the stored total.
    expect(sheetPartsAddUp({ ...row, parts: { ...row.parts!, addDutyUsd: 0 } })).toBe(false);
  });

  it('a specific-excise group prints its excise as a part', () => {
    const g = group({ tnvedCode: '2203000100', exciseSpecific: 0.5, exciseUnit: 'litr' });
    const customs = customsFor(g, [item({ measureUnit: 'litr', measureQty: 200 })]);
    const sheet = calcSheetOf(version([sealed(g, customs)]), [], []);
    const row = sheet.groups[0]!;
    expect(row.exciseSpecific).toBe(0.5);
    expect(row.exciseUnit).toBe('litr');
    expect(row.parts!.exciseUsd).toBe(100);
    expect(sheetPartsAddUp(row)).toBe(true);
  });

  it('an old seal with no parts prints its total and claims nothing', () => {
    const sheet = calcSheetOf(version([{ ...group(), customs: { ok: true, customsUsd: 100 }, items: [] }]), [], []);
    expect(sheet.groups[0]!.parts).toBeNull();
    expect(sheetPartsAddUp(sheet.groups[0]!)).toBe(false);
  });
});

describe('two blocks carry one law only when the excise agrees too (0131)', () => {
  const row = (over: Partial<typeof calcGroups.$inferSelect> = {}) =>
    ({
      dutyPct: '10.000',
      vatPct: '12.000',
      feeUsd: null,
      dutyMode: null,
      dutySpecific: null,
      dutyUnit: null,
      excisePct: null,
      exciseSpecific: '0.5000',
      exciseUnit: 'litr',
      dutyFree: false,
      vatFree: false,
      hasCertificate: null,
      ...over,
    }) as typeof calcGroups.$inferSelect;

  it('differs on the specific excise alone', () => {
    expect(sameGroupRates(row(), row())).toBe(true);
    expect(sameGroupRates(row(), row({ exciseSpecific: '0.6000' }))).toBe(false);
    expect(sameGroupRates(row(), row({ exciseUnit: 'kg' }))).toBe(false);
  });
});

describe('what the re-read book moved travels as codes and rows only (P2.2)', () => {
  it('builds the query the new request reads once', () => {
    expect(relawedQuery({ relawed: ['6403', '8516'], remeasure: [2, 5] })).toBe('?relawed=6403%2C8516&olchov=2%2C5');
    expect(relawedQuery({ relawed: [], remeasure: [] })).toBe('');
    expect(relawedQuery({})).toBe('');
  });
});

/*
 * The two screen halves no behavioural test reaches (the seal panel and the
 * totals are client components): pinned as source shape, comments stripped
 * so a sentence about the rule cannot satisfy it (#725).
 */
const WS = readFileSync('src/app/(protected)/hisoblash/[id]/calc-workspace.tsx', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('the seal panel and the totals (P2.6, P2.8)', () => {
  it('a typed band override lifts ONLY the band refusals off the seal button', () => {
    const panel = WS.slice(WS.indexOf('function SealPanel('), WS.indexOf('function SealedPanel('));
    expect(panel).toContain("b.kind === 'freight' && (b.reason === 'band_missing' || b.reason === 'band_ambiguous')");
    expect(panel).toContain('const overrideTyped = workspace.parts.freight && override.trim() !== \'\';');
    expect(panel).toContain('disabled={pending || dirty > 0 || standing.length > 0}');
    // The band box exists only where there is a road.
    expect(panel.indexOf('{workspace.parts.freight ? (')).toBeLessThan(panel.indexOf('calc-band-override'));
    // The seal posts the fee the screen showed.
    expect(panel).toContain('sawFeeUsd: workspace.parts.customs ? (workspace.fee?.ok ? workspace.fee.feeUsd : null) : undefined');
  });

  it('the fee door renders where the fee is BLOCKED, not only where it priced', () => {
    const totals = WS.slice(WS.indexOf('function TotalsPanel('), WS.indexOf('function SealPanel('));
    const blocked = totals.slice(totals.indexOf('calc-total-blocked'));
    expect(blocked).toContain('calc-fee-blocked');
    expect(blocked).toContain('<FeeOverride');
  });
});
