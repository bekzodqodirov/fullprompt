import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChainVersion } from '@/modules/wms/calc/chain';
import { calcSheetOf, type SheetVersionRow } from '@/modules/wms/calc/sheet';

/**
 * «🧮 Bitim hisobi» (0119) — the sealed record read back, pure. The sheet
 * never recomputes a figure, so what is pinned here is that it READS every
 * age of snapshot without inventing one, and that its type has no room for a
 * client price (law 4: the VED reads this sheet).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const version = (patch: Partial<SheetVersionRow>): SheetVersionRow => ({
  id: 'v-1',
  requestId: 'r-1',
  section: 'rastamojka',
  sealedAt: new Date('2026-06-01T09:00:00Z'),
  validUntil: new Date('2026-06-15T09:00:00Z'),
  totalUsd: 1500,
  perM3Usd: null,
  perKgUsd: null,
  discountUsd: 0,
  extrasUsd: 0,
  freightZone: null,
  freightBandMin: null,
  freightRate: null,
  freightPerKg: null,
  freightListUsd: null,
  breakdown: {},
  ...patch,
});

const chainLink = (patch: Partial<ChainVersion>): ChainVersion => ({
  versionId: 'v-1',
  requestId: 'r-1',
  quoteNo: 1,
  sealedAt: new Date('2026-06-01T09:00:00Z'),
  sealedByName: 'Ved Bir',
  section: 'rastamojka',
  totalUsd: 1500,
  superseded: false,
  supersededByNo: null,
  recalcOpen: false,
  expired: false,
  ...patch,
});

/** Every number anywhere in the value — a NaN in any corner fails the test. */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) for (const v of value) numbersIn(v, out);
  else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const v of Object.values(value)) numbersIn(v, out);
  }
  return out;
}

describe('calcSheetOf reads every age of snapshot', () => {
  it('a breakdown sealed before 0091/0092 prints «—», never NaN and never $0', () => {
    const sheet = calcSheetOf(
      version({
        breakdown: {
          groups: [
            {
              tnvedCode: '6402999800',
              label: 'Oyoq kiyim',
              // no dutyPct, no dutyMode, no measure pair, no customs block
              items: [{ label: 'Krossovka', bazaUsd: '4', weightKg: 'abc' }],
            },
          ],
        },
      }),
      [],
      [chainLink({})],
    );
    const group = sheet.groups[0]!;
    expect(group.dutyText).toBe('—');
    expect(group.vatPct).toBeNull();
    expect(group.customsUsd).toBeNull();
    expect(group.items[0]).toEqual({
      name: 'Krossovka',
      bazaUsd: 4,
      basis: null,
      kg: null,
      m3: null,
      measureUnit: null,
      measureQty: null,
    });
    expect(sheet.feeUsd).toBeNull();
    for (const n of numbersIn(sheet)) expect(Number.isFinite(n), String(n)).toBe(true);
  });

  it('a snapshot with the law prints it the one way (duty-text.ts)', () => {
    const sheet = calcSheetOf(
      version({
        breakdown: {
          groups: [
            {
              tnvedCode: '6403120000',
              label: 'Poyabzal',
              dutyPct: 20,
              dutyMode: 'max',
              dutySpecific: 3,
              dutyUnit: 'juft',
              vatPct: 12,
              customs: { customsUsd: 812.4 },
              items: [],
            },
          ],
          fee: { feeUsd: 105 },
        },
      }),
      [],
      [chainLink({})],
    );
    expect(sheet.groups[0]!.dutyText).toBe('20% / min 3 $/juft');
    expect(sheet.groups[0]!.customsUsd).toBe(812.4);
    expect(sheet.feeUsd).toBe(105);
  });

  it('a yo\'lkira seal carries no groups — the goods come from the request\'s items (#874)', () => {
    const sheet = calcSheetOf(
      version({
        section: 'yolkira',
        breakdown: { groups: [] },
        freightZone: 'cn',
        freightBandMin: 151,
        freightRate: 160,
        freightPerKg: false,
        freightListUsd: 4800,
      }),
      [
        { name: 'Stul', weightKg: '1200.000', volumeM3: '6.500' },
        { name: 'Stol', weightKg: null, volumeM3: '' },
      ],
      [chainLink({ section: 'yolkira' })],
    );
    expect(sheet.groups).toEqual([]);
    expect(sheet.goods).toEqual([
      { name: 'Stul', kg: 1200, m3: 6.5 },
      { name: 'Stol', kg: null, m3: null },
    ]);
    expect(sheet.freight).toEqual({ zone: 'cn', bandMin: 151, rate: 160, perKg: false, listUsd: 4800 });
  });

  it('the rank and the older prices come from the chain, newest first', () => {
    const chain = [
      chainLink({ versionId: 'v-0', requestId: 'r-0', quoteNo: 1, totalUsd: 1400, superseded: true }),
      chainLink({ versionId: 'v-mid', requestId: 'r-mid', quoteNo: 2, totalUsd: 1450, superseded: true }),
      chainLink({ versionId: 'v-1', requestId: 'r-1', quoteNo: 3, totalUsd: 1500 }),
    ];
    const sheet = calcSheetOf(version({}), [], chain);
    expect(sheet.quoteNo).toBe(3);
    expect(sheet.status).toBe('stands');
    expect(sheet.previous.map((p) => [p.quoteNo, p.totalUsd])).toEqual([
      [2, 1450],
      [1, 1400],
    ]);
  });

  it('a correction being written keeps the old price standing and says so', () => {
    const sheet = calcSheetOf(version({}), [], [chainLink({ recalcOpen: true, superseded: true })]);
    expect(sheet.status).toBe('recalc_open');
  });

  it('an expired quote is marked, against the clock it was given', () => {
    const v = version({ validUntil: new Date('2026-06-15T09:00:00Z') });
    expect(calcSheetOf(v, [], [chainLink({})], new Date('2026-06-16T00:00:00Z')).expired).toBe(true);
    expect(calcSheetOf(v, [], [chainLink({})], new Date('2026-06-14T00:00:00Z')).expired).toBe(false);
  });
});

/*
 * Law 4 in the TYPE (26a): the VED reads this sheet, so it has no field a
 * client price could travel in. Pinned twice — the keys a real sheet carries
 * at runtime, and the fields the interfaces DECLARE (an optional field never
 * set would pass the runtime half alone).
 */
const FORBIDDEN = /price|offer|upsale|quoted|client|floor/i;

function declaredFields(source: string, name: string): string[] {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  expect(m, `interface ${name} not found — re-anchor this fence`).not.toBeNull();
  return [...m![1]!.matchAll(/^ {2}(\w+)\??:/gm)].map((f) => f[1]!);
}

describe('the sheet cannot carry a client price (law 4)', () => {
  const source = read('src/modules/wms/calc/sheet.ts');

  it('CalcSheet declares exactly these fields', () => {
    expect(declaredFields(source, 'CalcSheet').sort()).toEqual(
      [
        'discountUsd',
        'expired',
        'extrasUsd',
        'feeUsd',
        'freight',
        'goods',
        'groups',
        'perKgUsd',
        'perM3Usd',
        'previous',
        'quoteNo',
        'requestId',
        'section',
        'sealedAt',
        'sealedByName',
        'status',
        'totalUsd',
        'validUntil',
      ].sort(),
    );
  });

  it('CalcAnswer declares exactly these fields', () => {
    expect(declaredFields(source, 'CalcAnswer').sort()).toEqual(
      ['amount', 'byName', 'completedAt', 'currency', 'note', 'requestId', 'section'].sort(),
    );
  });

  it('no declared field of any sheet type names a price, offer, upsale, quote, client or floor', () => {
    for (const name of ['CalcSheet', 'CalcSheetGroup', 'CalcSheetItem', 'CalcAnswer']) {
      for (const field of declaredFields(source, name)) expect(field, `${name}.${field}`).not.toMatch(FORBIDDEN);
    }
  });

  it('nor does any key a real sheet carries at runtime', () => {
    const sheet = calcSheetOf(
      version({
        freightZone: 'cn',
        freightListUsd: 100,
        breakdown: { groups: [{ label: 'x', dutyPct: 5, items: [{ label: 'y' }] }], fee: { feeUsd: 1 } },
      }),
      [{ name: 'g', weightKg: 1, volumeM3: 1 }],
      [chainLink({})],
    );
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && !(v instanceof Date)) {
        for (const [k, inner] of Object.entries(v)) {
          keys.push(k);
          walk(inner);
        }
      }
    };
    walk(sheet);
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect(k).not.toMatch(FORBIDDEN);
  });

  it('the module never reads the card\'s quote — after a released offer it IS the client price (#793)', () => {
    expect(source).not.toMatch(/quoted_amount|quotedAmount|calc_offers|client_price/);
  });
});
