import { describe, expect, it } from 'vitest';
import { allocateEntry, type AllocBox } from '@/modules/wms/costing/engine';
import {
  FREIGHT_LIGHT_BELOW,
  bandText,
  columnProblem,
  copyDraft,
  freightGroups,
  freightUsable,
  offeredBases,
  splitCents,
  splitFreight,
  stableMeasure,
  wholeDensity,
} from '@/modules/wms/costing/freight-split';
import type { BoxMeasure, FreightBandCopy, FreightCopy, FreightOffer } from '@/modules/wms/costing/freight-types';
import { OWNER_TARIFF_BANDS } from '@/modules/wms/calc/tariff-seed';

/**
 * docs/YOLKIRA-TAQSIMOT.md §1 and §11 — every anchor is a LITERAL worked out
 * by hand from his own table (#1116), never a number the code under test
 * produced. His example, his rule 6, and the two carton shapes whose float
 * density flips band with the carton count.
 */

/** His seeded columns, written out from tariff-seed (the fence owns the seed). */
const column = (which: 'cn' | 'kashgar'): FreightBandCopy[] =>
  OWNER_TARIFF_BANDS.map(([min, max, cn, west]) => ({
    min,
    max,
    price: which === 'cn' ? cn : west,
    perKg: max === null,
  }));
const copyOf = (bands: FreightBandCopy[], zone = 'cn', lightBelow = FREIGHT_LIGHT_BELOW): FreightCopy => ({
  warehouseId: 'W',
  zone,
  tariffFrom: '2026-01-01',
  lightBelow,
  bands,
});

let seq = 0;
/** n cartons of one lot. `uniform` = box dims + box weight; else totals. */
function lot(opts: {
  client?: string | null;
  receipt?: string;
  lotId?: string;
  n?: number;
  dims?: [number, number, number];
  boxKg?: string;
  totalKg?: string;
  totalM3?: string;
  mixed?: boolean;
}): BoxMeasure[] {
  const n = opts.n ?? 1;
  const lotId = opts.lotId ?? `L${(seq += 1)}`;
  const client = opts.client === undefined ? 'A' : opts.client;
  const out: BoxMeasure[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      boxId: `${lotId}-${i}`,
      clientId: client,
      clientCode: client ? `GS${client}` : null,
      receiptId: opts.receipt ?? `R-${client ?? lotId}`,
      receiptNumber: `N-${opts.receipt ?? lotId}`,
      unclaimedMarking: client ? null : `MARK-${opts.receipt ?? lotId}`,
      lotId,
      lotLetter: 'A',
      lotSeq: 1,
      dimsMode: opts.mixed ? 'mixed' : 'uniform',
      boxLengthCm: opts.dims?.[0] ?? null,
      boxWidthCm: opts.dims?.[1] ?? null,
      boxHeightCm: opts.dims?.[2] ?? null,
      boxWeightKg: opts.boxKg ?? null,
      boxCount: n,
      totalWeightKg: opts.totalKg ?? '0.000',
      totalVolumeM3: opts.totalM3 ?? '0.0000',
      weightKg: 0,
      volumeM3: 0,
    });
  }
  return out;
}

/** A lot stated by its totals (mixed / legacy), kg and m³ as the db prints them. */
const totals = (client: string | null, kg: number, m3: number, extra: Partial<Parameters<typeof lot>[0]> = {}) =>
  lot({ client, totalKg: kg.toFixed(3), totalM3: m3.toFixed(4), ...extra });

/** Split, then allocate the bill like the recompute does, summed per client to the cent. */
function share(measures: BoxMeasure[], copy: FreightCopy, amount: number): Record<string, number> {
  const split = splitFreight(freightGroups(measures), copy);
  if (!split.ok) throw new Error(`held: ${JSON.stringify(split.held)}`);
  const pool: AllocBox[] = measures.map((m) => ({
    boxId: m.boxId,
    clientId: m.clientId,
    weightKg: 0,
    volumeM3: 0,
    chargeableKg: 0,
    freightWeight: split.weights.get(m.boxId)!,
  }));
  const shares = allocateEntry({ amountUsd: amount, basis: 'freight' }, pool);
  const out: Record<string, number> = {};
  for (const s of shares) out[s.clientId ?? 'unclaimed'] = (out[s.clientId ?? 'unclaimed'] ?? 0) + s.amountUsd;
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]! * 100) / 100;
  return out;
}

describe('his example (2026-10-13), on his own columns', () => {
  // A: 2 m³ at 600 kg/m³ (band 501-700); B: 1 m³ at 160 kg/m³ (band 151-200).
  const cargo = () => [...totals('A', 1200, 2), ...totals('B', 160, 1)];

  it('Xitoy column: A $300 × 2 = 600, B $160 → a $350 bill is 276.32 / 73.68', () => {
    expect(share(cargo(), copyOf(column('cn')), 350)).toEqual({ A: 276.32, B: 73.68 });
  });

  it('Qashqar column: A $195 × 2 = 390, B $100 → 278.57 / 71.43', () => {
    expect(share(cargo(), copyOf(column('kashgar'), 'kashgar'), 350)).toEqual({ A: 278.57, B: 71.43 });
  });

  it('a column where his own 300/100 are the prices gives exactly his 300.00 / 50.00', () => {
    const his: FreightBandCopy[] = [
      { min: 1, max: 200, price: 100, perKg: false },
      { min: 201, max: 999, price: 300, perKg: false },
      { min: 1000, max: null, price: 0.55, perKg: true },
    ];
    expect(share(cargo(), copyOf(his), 350)).toEqual({ A: 300, B: 50 });
  });
});

describe('his 1a: the client’s whole cargo is ONE density', () => {
  it('two lots (100 and 1100 kg/m³) price at their combined 600 kg/m³ → $600, not $715 per lot', () => {
    const measures = [...totals('A', 100, 1), ...totals('A', 1100, 1)];
    const split = splitFreight(freightGroups(measures), copyOf(column('cn')));
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.groups).toHaveLength(1);
    expect(split.groups[0]!.density).toBe(600);
    expect(split.groups[0]!.value).toBeCloseTo(600, 9);
    // Inside the client the share goes by m³: the two lots' boxes weigh the same.
    const w = [...split.weights.values()];
    expect(w[0]).toBeCloseTo(w[1]!, 9);
  });

  it('the per-kg band: a 1 m³ group at 1100 kg/m³ is $0.55 × 1100 = 605', () => {
    const split = splitFreight(freightGroups(totals('A', 1100, 1)), copyOf(column('cn')));
    expect(split.ok && split.groups[0]!.band.perKg).toBe(true);
    expect(split.ok && split.groups[0]!.value).toBeCloseTo(605, 9);
  });

  it('unclaimed cargo is its own group PER PRIXOD (two prixods, two groups)', () => {
    const measures = [...totals(null, 300, 1, { receipt: 'U1' }), ...totals(null, 300, 1, { receipt: 'U2' })];
    const keys = freightGroups(measures).map((g) => g.key);
    expect(keys).toEqual(['r:U1', 'r:U2']);
  });
});

describe('stable measures — the carton, not the re-rounded totals', () => {
  it('40³ cm / 63.968 kg is exactly 999.5 → 1000 kg/m³ (per-kg row) at EVERY carton count', () => {
    for (const n of [1, 2, 3, 10, 32, 33, 50, 100]) {
      const measures = lot({ n, dims: [40, 40, 40], boxKg: '63.968' });
      const split = splitFreight(freightGroups(measures), copyOf(column('cn')));
      expect(split.ok && split.groups[0]!.density, `n=${n}`).toBe(1000);
      expect(split.ok && split.groups[0]!.band.min, `n=${n}`).toBe(1000);
    }
  });

  it('21 cm / 9.256 kg is 999.46 → 999 (701-999 row) at every count, though its totals round to 1001', () => {
    for (const n of [1, 2, 3, 4, 33]) {
      const totalKg = ((n * 9256) / 1000).toFixed(3);
      const totalM3 = (Math.round((n * 9261) / 100) / 10000).toFixed(4);
      const measures = lot({ n, dims: [21, 21, 21], boxKg: '9.256', totalKg, totalM3 });
      const split = splitFreight(freightGroups(measures), copyOf(column('cn')));
      expect(split.ok && split.groups[0]!.band.min, `n=${n}`).toBe(701);
    }
  });

  it('a 4×4×3 cm carton is priceable although its total rounds to 0.0000 m³', () => {
    const measures = lot({ dims: [4, 4, 3], boxKg: '0.100', totalKg: '0.100', totalM3: '0.0000' });
    const split = splitFreight(freightGroups(measures), copyOf(column('cn')));
    expect(split.ok).toBe(true);
    expect(split.ok && split.groups[0]!.density).toBe(2083);
  });

  it('a MIXED lot is its totals ÷ count even when it carries dims', () => {
    const m = lot({ mixed: true, n: 2, dims: [10, 10, 10], boxKg: '1.000', totalKg: '50.000', totalM3: '0.2000' })[0]!;
    const sm = stableMeasure(m)!;
    expect(wholeDensity(sm.grams, sm.cm3)).toBe(250);
  });
});

describe('the exact sums stay small (fix review)', () => {
  it('a 500-carton totals lot sums to a reduced fraction, and its float twin is a number', () => {
    // Each carton is totals ÷ 500; unreduced, the sum's denominator was 500^500.
    const measures = totals('A', 600, 3.5, { n: 500 });
    const [group] = freightGroups(measures);
    const [lot] = group!.lots;
    expect(lot!.cm3.d <= 500n).toBe(true);
    expect(lot!.grams.d <= 500n).toBe(true);
    expect(wholeDensity(lot!.grams, lot!.cm3)).toBe(171);
    expect(group!.m3F).toBeCloseTo(3.5, 9);
    expect(group!.kgF).toBeCloseTo(600, 9);
  });

  it('a held light lot of that size prints its m³ and kg, not NaN', () => {
    const measures = totals('L', 1, 3.5, { n: 500 });
    const split = splitFreight(freightGroups(measures), {
      warehouseId: 'W',
      zone: 'cn',
      tariffFrom: '2026-01-01',
      lightBelow: FREIGHT_LIGHT_BELOW,
      bands: [{ min: 1, max: null, price: 100, perKg: false }],
    });
    expect(split.ok).toBe(false);
    if (split.ok || split.held.reason !== 'cargo') throw new Error('expected a cargo hold');
    const lot = split.held.tooLight[0]!.lots[0]!;
    expect(lot.m3).toBeCloseTo(3.5, 9);
    expect(lot.kg).toBeCloseTo(1, 9);
  });
});

describe('his rule 6 — «1 kub 10 kg dan kam bo‘lsa ogohlantirsin»', () => {
  it('the whole density decides, the number the screen prints: 9.49 → held, 9.5 → priced', () => {
    const at = (kg: string) =>
      splitFreight(freightGroups([...lot({ dims: [100, 100, 100], boxKg: kg })]), copyOf(column('cn')));
    const light = at('9.490');
    expect(light.ok).toBe(false);
    expect(!light.ok && light.held.reason === 'cargo' && light.held.tooLight[0]!.density).toBe(9);
    const heavy = at('9.500');
    expect(heavy.ok && heavy.groups[0]!.density).toBe(10);
  });

  it('3 m³ and 0 kg is 0 kg/m³ → held, never a free ride', () => {
    const split = splitFreight(freightGroups(totals('C', 0, 3)), copyOf(column('cn')));
    expect(!split.ok && split.held.reason === 'cargo' && split.held.tooLight[0]!.density).toBe(0);
  });

  it('no volume at all is a MISSING measure naming the lot, not a light group', () => {
    const split = splitFreight(freightGroups(totals('C', 50, 0, { lotId: 'L-empty' })), copyOf(column('cn')));
    expect(!split.ok && split.held.reason === 'cargo' && split.held.measureMissing.map((l) => l.lotId)).toEqual([
      'L-empty',
    ]);
  });

  it('a light group lists its lots LIGHTEST first', () => {
    const measures = [...totals('C', 20, 2, { lotId: 'heavier' }), ...totals('C', 1, 3, { lotId: 'lightest' })];
    const split = splitFreight(freightGroups(measures), copyOf(column('cn')));
    expect(!split.ok && split.held.reason === 'cargo' && split.held.tooLight[0]!.lots.map((l) => l.lotId)).toEqual([
      'lightest',
      'heavier',
    ]);
  });

  it('both reasons at once are BOTH named (measure first), so fixing one does not uncover the other later', () => {
    const measures = [...totals('X', 40, 0, { lotId: 'X-none' }), ...totals('Y', 5, 1, { lotId: 'Y-light' })];
    const held = splitFreight(freightGroups(measures), copyOf(column('cn')));
    expect(held.ok).toBe(false);
    if (held.ok || held.held.reason !== 'cargo') throw new Error('expected a cargo hold');
    expect(held.held.measureMissing.map((l) => l.lotId)).toEqual(['X-none']);
    expect(held.held.tooLight.map((g) => g.key)).toEqual(['c:Y']);
  });

  it('a light LOT inside a heavy group does not hold the bill — it is named (ⓘ)', () => {
    // A: 20 m³ at 200 kg/m³ plus a 100 kg lot typed as 50 m³ → 4100 / 70 = 59.
    const measures = [...totals('A', 4000, 20, { lotId: 'A-good' }), ...totals('A', 100, 50, { lotId: 'A-typo' })];
    const split = splitFreight(freightGroups(measures), copyOf(column('cn')));
    expect(split.ok && split.groups[0]!.density).toBe(59);
    expect(split.ok && split.groups[0]!.lightLots.map((l) => l.lotId)).toEqual(['A-typo']);
  });

  it('from 10 up to a column’s lowest floor the group takes the LOWEST row («100 kgdan kam tarif»)', () => {
    const high: FreightBandCopy[] = [
      { min: 50, max: 100, price: 120, perKg: false },
      { min: 101, max: null, price: 200, perKg: false },
    ];
    const split = splitFreight(freightGroups(totals('A', 20, 1)), copyOf(high));
    expect(split.ok && split.groups[0]!.band.min).toBe(50);
    expect(split.ok && split.groups[0]!.clamped).toBe(true);
  });

  it('his seeded columns never clamp at 10 kg/m³ and above (their floor is 1)', () => {
    for (const which of ['cn', 'kashgar'] as const) {
      const split = splitFreight(freightGroups(totals('A', 10, 1)), copyOf(column(which), which));
      expect(split.ok && split.groups[0]!.clamped).toBe(false);
      expect(split.ok && split.groups[0]!.band.min).toBe(1);
    }
  });

  it('the limit is the COPY’s, frozen per bill — a later constant does not move a saved bill', () => {
    const split = splitFreight(freightGroups(totals('A', 7, 1)), copyOf(column('cn'), 'cn', 5));
    expect(split.ok && split.groups[0]!.density).toBe(7);
  });
});

describe('columnProblem — what a column lacks', () => {
  it('his seeded columns are whole', () => {
    expect(columnProblem(column('cn'))).toBeNull();
    expect(columnProblem(column('kashgar'))).toBeNull();
  });
  it('a closed top is a hole from its top + 1 upwards', () => {
    expect(columnProblem(column('cn').slice(0, -1))).toEqual({ kind: 'gap', from: 1000, to: null });
  });
  it('his first table’s 900-999 hole', () => {
    const bands = column('cn').map((b) => (b.min === 701 ? { ...b, max: 899 } : b));
    expect(columnProblem(bands)).toEqual({ kind: 'gap', from: 900, to: 999 });
  });
  it('his first table’s 700 in two rows', () => {
    const bands = column('cn').map((b) => (b.min === 701 ? { ...b, min: 700 } : b));
    expect(columnProblem(bands)).toEqual({ kind: 'overlap', at: 700 });
  });
  it('a fractional floor covers from its ceiling', () => {
    expect(
      columnProblem([
        { min: 1, max: 100, price: 1, perKg: false },
        { min: 100.5, max: null, price: 2, perKg: false },
      ]),
    ).toBeNull();
  });
  it('a lowest floor of 50 is no hole (rule 6 covers below it)', () => {
    expect(columnProblem([{ min: 50, max: null, price: 1, perKg: false }])).toBeNull();
  });
  it('no rows is «unpriced»; a contiguous 60-row column is fine (no band-count cap)', () => {
    expect(columnProblem([])).toEqual({ kind: 'unpriced' });
    const sixty = Array.from({ length: 60 }, (_, i) => ({
      min: i * 10 + 1,
      max: i === 59 ? null : i * 10 + 10,
      price: 100 + i,
      perKg: false,
    }));
    expect(columnProblem(sixty)).toBeNull();
  });
});

describe('copyDraft — the one constructor of a frozen copy', () => {
  const history = [
    { zone: 'cn', minDensity: 1, maxDensity: 100, priceUsd: 110, perKg: false, effectiveDate: '2026-01-01' },
    { zone: 'cn', minDensity: 101, maxDensity: null, priceUsd: 130, perKg: false, effectiveDate: '2026-01-01' },
    { zone: 'cn', minDensity: 1, maxDensity: 100, priceUsd: 120, perKg: false, effectiveDate: '2026-03-01' },
    { zone: 'kashgar', minDensity: 1, maxDensity: null, priceUsd: 70, perKg: false, effectiveDate: '2026-01-01' },
  ];
  it('reads the newest row per floor on or before the date, and names the newest date it used', () => {
    const d = copyDraft('cn', history, '2026-03-15', 10, 'W');
    expect(d.ok && d.draft.bands.map((b) => b.price)).toEqual([120, 130]);
    expect(d.ok && d.draft.tariffFrom).toBe('2026-03-01');
    const before = copyDraft('cn', history, '2026-02-01', 10, 'W');
    expect(before.ok && before.draft.bands.map((b) => b.price)).toEqual([110, 130]);
    expect(before.ok && before.draft.tariffFrom).toBe('2026-01-01');
  });
  it('a date before the first row has NO earliest-row fallback', () => {
    expect(copyDraft('cn', history, '2025-12-31', 10, 'W')).toEqual({ ok: false, problem: { kind: 'unpriced' } });
  });
  it('a NaN price is refused before it can be frozen', () => {
    const bad = [{ ...history[0]!, priceUsd: Number.NaN }, history[1]!];
    expect(copyDraft('cn', bad, '2026-02-01', 10, 'W')).toEqual({ ok: false, problem: { kind: 'not_finite' } });
  });
});

describe('the words and the cents', () => {
  it('splitCents adds up to the bill to the cent', () => {
    const cents = splitCents(350, [0.7894736842, 0.2105263158]);
    expect(cents).toEqual([276.32, 73.68]);
    expect(splitCents(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33]);
    expect(splitCents(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
  });
  it('bandText words a band one way — a per-kg band by the kilo, never «$605/kub»', () => {
    const b = { min: 501, max: 700, price: 300, perKg: false };
    // Without money sight no price is worded (review: the band carried it to
    // every browser), and a band that arrives without one can only be worded so.
    expect(bandText(b, { money: false })).toEqual({ key: 'freightBand', range: '501–700', price: '' });
    expect(bandText(b, { money: true })).toEqual({ key: 'freightBandMoney', range: '501–700', price: '$300' });
    const kg = { min: 1000, max: null, price: 0.55, perKg: true };
    expect(bandText(kg, { money: false })).toEqual({ key: 'freightBandPerKg', range: '1000+', price: '' });
    expect(bandText(kg, { money: true })).toEqual({ key: 'freightBandMoneyPerKg', range: '1000+', price: '$0.55' });
    const stripped = { min: 501, max: 700, perKg: false };
    expect(bandText(stripped, { money: true })).toEqual({ key: 'freightBand', range: '501–700', price: '' });
  });
});

describe('where freight is offered (his 4a)', () => {
  const flags = { freightTypeIds: ['T-freight'], customsTypeIds: ['T-customs'] };
  it('only on a truck’s bill, and never on a customs type', () => {
    expect(offeredBases('batch', flags, 'T-freight')).toContain('freight');
    expect(offeredBases('batch', flags, 'T-other')).toContain('freight');
    expect(offeredBases('batch', flags, 'T-customs')).not.toContain('freight');
    for (const scope of ['receipt', 'crate', 'pickup'] as const) {
      expect(offeredBases(scope, flags, 'T-freight')).not.toContain('freight');
    }
  });
  it('a date before the column’s first price is unpriced; an older-than-held date is the server’s call', () => {
    const offer: FreightOffer = {
      status: 'ready',
      warehouse: { id: 'W', code: 'YW', name: 'Yiwu' },
      zone: 'cn',
      money: true,
      mayFixColumn: false,
      mayFixTariff: false,
      typeFlags: flags,
      firstFrom: '2026-01-01',
      versions: [{ from: '2026-06-01', digest: 'd', problem: null, split: null }],
    };
    expect(freightUsable(offer, '2025-12-31')).toEqual({ ok: false, why: 'unpriced' });
    expect(freightUsable(offer, '2026-03-01')).toEqual({ ok: true, version: null });
    expect(freightUsable(offer, '2026-07-01')).toEqual({ ok: true, version: offer.versions[0] });
    expect(freightUsable({ status: 'server_behind', typeFlags: flags }, '2026-07-01')).toEqual({
      ok: false,
      why: 'server_behind',
    });
  });
});
