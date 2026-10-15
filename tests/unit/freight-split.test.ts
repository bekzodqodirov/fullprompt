import { describe, expect, it } from 'vitest';
import { allocateEntry, type AllocBox } from '@/modules/wms/costing/engine';
import {
  FREIGHT_LIGHT_BELOW,
  bandText,
  byShareThenLabel,
  clientBandLine,
  clientCentsOf,
  columnProblem,
  columnWatch,
  copyDraft,
  freightLots,
  freightUsable,
  lotCents,
  offeredBases,
  rollupClients,
  splitCents,
  splitFreight,
  stableMeasure,
  wholeDensity,
} from '@/modules/wms/costing/freight-split';
import type { BandView, BoxMeasure, FreightBandCopy, FreightCopy, FreightOffer, LotView, SplitView } from '@/modules/wms/costing/freight-types';
import { OWNER_TARIFF_BANDS } from '@/modules/wms/calc/tariff-seed';

/**
 * docs/YOLKIRA-TAQSIMOT.md §1, §11 and §15 — every anchor is a LITERAL worked
 * out by hand from his own table (#1116), never a number the code under test
 * produced. His example, his 2b (each LOT on its own row), his rule 6 per lot,
 * and the two carton shapes whose float density flips band with the carton
 * count.
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
  letter?: string;
  goods?: string;
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
      lotLetter: opts.letter ?? 'A',
      lotSeq: 1,
      productNameRu: opts.goods ?? null,
      productNameZh: '货',
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
  const split = splitFreight(freightLots(measures), copy);
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

  it('a bill frozen on the Qashqar column BEFORE his 1a still splits by its own copy (3a): A $195 × 2 = 390, B $100 → 278.57 / 71.43', () => {
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

describe('his 2b (2026-10-15): each LOT is priced by its OWN density', () => {
  // His own example: D has 1 m³ of pillows at 100 kg/m³ and 1 m³ of tiles at
  // 1100 kg/m³ — on the Xitoy column $110 and 1100 × $0.55 = $605.
  const yostiq = () => totals('D', 100, 1, { lotId: 'D-yostiq', letter: 'A', goods: 'Yostiq' });
  const kafel = () => totals('D', 1100, 1, { lotId: 'D-kafel', letter: 'B', goods: 'Kafel' });

  it('his D: yostiq $110 + kafel $605 = $715 — 15.38 % / 84.62 % of D’s part', () => {
    const split = splitFreight(freightLots([...yostiq(), ...kafel()]), copyOf(column('cn')));
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.lots.map((l) => [l.lotId, l.density])).toEqual([
      ['D-yostiq', 100],
      ['D-kafel', 1100],
    ]);
    expect(split.lots[0]!.value).toBeCloseTo(110, 9);
    expect(split.lots[1]!.value).toBeCloseTo(605, 9);
    expect(split.lots.map((l) => Math.round(l.share * 10000) / 100)).toEqual([15.38, 84.62]);
    expect(split.lots.map((l) => l.goods)).toEqual(['Yostiq', 'Kafel']);
    // Inside a lot the share goes by m³, so the two cartons are NOT equal now.
    expect(split.weights.get('D-yostiq-0')).toBeCloseTo(110, 9);
    expect(split.weights.get('D-kafel-0')).toBeCloseTo(605, 9);
  });

  it('D + E (600 kg/m³, 1 m³ → $300) on $1,015 is D 715.00 / E 300.00 — the client grain gave 676.67 / 338.33', () => {
    const measures = [...yostiq(), ...kafel(), ...totals('E', 600, 1)];
    expect(share(measures, copyOf(column('cn')), 1015)).toEqual({ D: 715, E: 300 });
  });

  it('the per-kg band: a 1 m³ lot at 1100 kg/m³ is $0.55 × 1100 = 605', () => {
    const split = splitFreight(freightLots(totals('A', 1100, 1)), copyOf(column('cn')));
    expect(split.ok && split.lots[0]!.band.perKg).toBe(true);
    expect(split.ok && split.lots[0]!.value).toBeCloseTo(605, 9);
  });

  it('one prixod with two lots is two lots; one client’s lots on two prixods are two lots', () => {
    const one = [
      ...totals('A', 300, 1, { receipt: 'R1', lotId: 'R1-A' }),
      ...totals('A', 300, 1, { receipt: 'R1', lotId: 'R1-B', letter: 'B' }),
    ];
    expect(freightLots(one).map((l) => [l.key, l.clientKey, l.label])).toEqual([
      ['l:R1-A', 'c:A', 'GSA-A'],
      ['l:R1-B', 'c:A', 'GSA-B'],
    ]);
    const two = [...totals('A', 300, 1, { receipt: 'R1', lotId: 'X' }), ...totals('A', 300, 1, { receipt: 'R2', lotId: 'Y' })];
    expect(freightLots(two).map((l) => l.key)).toEqual(['l:X', 'l:Y']);
  });

  it('an unclaimed prixod’s lots roll up under the prixod (r:<receipt>), each priced alone', () => {
    const measures = [
      ...totals(null, 100, 1, { receipt: 'U1', lotId: 'U1-A' }),
      ...totals(null, 1100, 1, { receipt: 'U1', lotId: 'U1-B' }),
    ];
    const lots = freightLots(measures);
    expect(lots.map((l) => [l.clientKey, l.clientLabel])).toEqual([
      ['r:U1', 'MARK-U1'],
      ['r:U1', 'MARK-U1'],
    ]);
    const split = splitFreight(lots, copyOf(column('cn')));
    expect(split.ok && split.lots.map((l) => l.density)).toEqual([100, 1100]);
  });

  it('a lot’s density does not depend on how many of its cartons ride: 1, 7 and 500 aboard read one band', () => {
    for (const n of [1, 7, 500]) {
      const uniform = lot({ n, dims: [50, 50, 40], boxKg: '25.000' }); // 0.1 m³ / 25 kg = 250 kg/m³
      const split = splitFreight(freightLots(uniform), copyOf(column('cn')));
      expect(split.ok && [split.lots[0]!.density, split.lots[0]!.band.min], `n=${n}`).toEqual([250, 201]);
    }
  });

  it('the client roll-up: a client’s share is the sum of its lots’, clients and lots by share', () => {
    const split = splitFreight(
      freightLots([...totals('E', 600, 1, { lotId: 'E1' }), ...yostiq(), ...kafel()]),
      copyOf(column('cn')),
    );
    if (!split.ok) throw new Error('expected a split');
    const { lots, clients } = rollupClients(split.lots);
    // 715 / 1015 = 70.44 %, 300 / 1015 = 29.56 %.
    expect(clients.map((c) => [c.key, c.label, Math.round(c.share * 10000) / 100, c.lotKeys])).toEqual([
      ['c:D', 'GSD', 70.44, ['l:D-kafel', 'l:D-yostiq']],
      ['c:E', 'GSE', 29.56, ['l:E1']],
    ]);
    expect(lots.map((l) => l.key)).toEqual(['l:D-kafel', 'l:D-yostiq', 'l:E1']);
  });
});

describe('stable measures — the carton, not the re-rounded totals', () => {
  it('40³ cm / 63.968 kg is exactly 999.5 → 1000 kg/m³ (per-kg row) at EVERY carton count', () => {
    for (const n of [1, 2, 3, 10, 32, 33, 50, 100]) {
      const measures = lot({ n, dims: [40, 40, 40], boxKg: '63.968' });
      const split = splitFreight(freightLots(measures), copyOf(column('cn')));
      expect(split.ok && split.lots[0]!.density, `n=${n}`).toBe(1000);
      expect(split.ok && split.lots[0]!.band.min, `n=${n}`).toBe(1000);
    }
  });

  it('21 cm / 9.256 kg is 999.46 → 999 (701-999 row) at every count, though its totals round to 1001', () => {
    for (const n of [1, 2, 3, 4, 33]) {
      const totalKg = ((n * 9256) / 1000).toFixed(3);
      const totalM3 = (Math.round((n * 9261) / 100) / 10000).toFixed(4);
      const measures = lot({ n, dims: [21, 21, 21], boxKg: '9.256', totalKg, totalM3 });
      const split = splitFreight(freightLots(measures), copyOf(column('cn')));
      expect(split.ok && split.lots[0]!.band.min, `n=${n}`).toBe(701);
    }
  });

  it('a 4×4×3 cm carton is priceable although its total rounds to 0.0000 m³', () => {
    const measures = lot({ dims: [4, 4, 3], boxKg: '0.100', totalKg: '0.100', totalM3: '0.0000' });
    const split = splitFreight(freightLots(measures), copyOf(column('cn')));
    expect(split.ok).toBe(true);
    expect(split.ok && split.lots[0]!.density).toBe(2083);
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
    const [lot] = freightLots(measures);
    expect(lot!.cm3.d <= 500n).toBe(true);
    expect(lot!.grams.d <= 500n).toBe(true);
    expect(wholeDensity(lot!.grams, lot!.cm3)).toBe(171);
    const split = splitFreight([lot!], copyOf(column('cn')));
    expect(split.ok && split.lots[0]!.m3).toBeCloseTo(3.5, 9);
    expect(split.ok && split.lots[0]!.kg).toBeCloseTo(600, 9);
  });

  it('a held light lot of that size prints its m³ and kg, not NaN', () => {
    const measures = totals('L', 1, 3.5, { n: 500 });
    const split = splitFreight(freightLots(measures), {
      warehouseId: 'W',
      zone: 'cn',
      tariffFrom: '2026-01-01',
      lightBelow: FREIGHT_LIGHT_BELOW,
      bands: [{ min: 1, max: null, price: 100, perKg: false }],
    });
    expect(split.ok).toBe(false);
    if (split.ok || split.held.reason !== 'cargo') throw new Error('expected a cargo hold');
    const lot = split.held.tooLight[0]!;
    expect(lot.m3).toBeCloseTo(3.5, 9);
    expect(lot.kg).toBeCloseTo(1, 9);
  });
});

describe('his rule 6 — «1 kub 10 kg dan kam bo‘lsa ogohlantirsin»', () => {
  it('the whole density decides, the number the screen prints: 9.49 → held, 9.5 → priced', () => {
    const at = (kg: string) =>
      splitFreight(freightLots([...lot({ dims: [100, 100, 100], boxKg: kg })]), copyOf(column('cn')));
    const light = at('9.490');
    expect(light.ok).toBe(false);
    expect(!light.ok && light.held.reason === 'cargo' && light.held.tooLight[0]!.density).toBe(9);
    const heavy = at('9.500');
    expect(heavy.ok && heavy.lots[0]!.density).toBe(10);
  });

  it('3 m³ and 0 kg is 0 kg/m³ → held, never a free ride', () => {
    const split = splitFreight(freightLots(totals('C', 0, 3)), copyOf(column('cn')));
    expect(!split.ok && split.held.reason === 'cargo' && split.held.tooLight[0]!.density).toBe(0);
  });

  it('no volume at all is a MISSING measure naming the lot, not a light lot', () => {
    const split = splitFreight(freightLots(totals('C', 50, 0, { lotId: 'L-empty' })), copyOf(column('cn')));
    expect(!split.ok && split.held.reason === 'cargo' && split.held.measureMissing.map((l) => l.lotId)).toEqual([
      'L-empty',
    ]);
  });

  it('every light lot on the truck is named, LIGHTEST first; a lot of exactly 10 kg/m³ is priced, not named', () => {
    const measures = [
      ...totals('C', 20, 2, { lotId: 'exactly-10' }),
      ...totals('C', 5, 1, { lotId: 'five' }),
      ...totals('Z', 1, 3, { lotId: 'zero' }),
    ];
    const split = splitFreight(freightLots(measures), copyOf(column('cn')));
    expect(!split.ok && split.held.reason === 'cargo' && split.held.tooLight.map((l) => [l.lotId, l.density])).toEqual([
      ['zero', 0],
      ['five', 5],
    ]);
  });

  it('both reasons at once are BOTH named (measure first), so fixing one does not uncover the other later', () => {
    const measures = [...totals('X', 40, 0, { lotId: 'X-none' }), ...totals('Y', 5, 1, { lotId: 'Y-light' })];
    const held = splitFreight(freightLots(measures), copyOf(column('cn')));
    expect(held.ok).toBe(false);
    if (held.ok || held.held.reason !== 'cargo') throw new Error('expected a cargo hold');
    expect(held.held.measureMissing.map((l) => l.lotId)).toEqual(['X-none']);
    expect(held.held.tooLight.map((l) => l.lotId)).toEqual(['Y-light']);
  });

  it('per lot (his 2b): a light lot HOLDS the bill even inside a heavy client — the client average no longer hides it', () => {
    // A: 20 m³ at 200 kg/m³ plus a 100 kg lot typed as 50 m³ (2 kg/m³). The
    // client grain read 4100 / 70 = 59 and split; one light lot is a typo.
    const measures = [...totals('A', 4000, 20, { lotId: 'A-good' }), ...totals('A', 100, 50, { lotId: 'A-typo' })];
    const split = splitFreight(freightLots(measures), copyOf(column('cn')));
    expect(split.ok).toBe(false);
    expect(!split.ok && split.held.reason === 'cargo' && split.held.tooLight.map((l) => [l.lotId, l.density])).toEqual([
      ['A-typo', 2],
    ]);
  });

  it('from 10 up to a column’s lowest floor the lot takes the LOWEST row («100 kgdan kam tarif»)', () => {
    const high: FreightBandCopy[] = [
      { min: 50, max: 100, price: 120, perKg: false },
      { min: 101, max: null, price: 200, perKg: false },
    ];
    const split = splitFreight(freightLots(totals('A', 20, 1)), copyOf(high));
    expect(split.ok && split.lots[0]!.band.min).toBe(50);
    expect(split.ok && split.lots[0]!.clamped).toBe(true);
  });

  it('his seeded columns never clamp at 10 kg/m³ and above (their floor is 1)', () => {
    for (const which of ['cn', 'kashgar'] as const) {
      const split = splitFreight(freightLots(totals('A', 10, 1)), copyOf(column(which), which));
      expect(split.ok && split.lots[0]!.clamped).toBe(false);
      expect(split.ok && split.lots[0]!.band.min).toBe(1);
    }
  });

  it('the limit is the COPY’s, frozen per bill — a later constant does not move a saved bill', () => {
    const split = splitFreight(freightLots(totals('A', 7, 1)), copyOf(column('cn'), 'cn', 5));
    expect(split.ok && split.lots[0]!.density).toBe(7);
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
      zone: 'cn',
      money: true,
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

describe('one cents rule — a client is the SUM of its lots (judge J2/J14/J22)', () => {
  // His D (yostiq $110 + kafel $605), B $300, C $160 on a $103 bill. By hand:
  // 10300 cents × 110/1175 = 964.26, × 605/1175 = 5303.40, × 300/1175 =
  // 2629.79, × 160/1175 = 1402.55 → floors 964/5303/2629/1402 = 10298, the two
  // spare cents to the largest remainders (.79 → B, .55 → C).
  const lots = [
    { key: 'l:yostiq', clientKey: 'c:D', weight: 110 },
    { key: 'l:kafel', clientKey: 'c:D', weight: 605 },
    { key: 'l:b', clientKey: 'c:B', weight: 300 },
    { key: 'l:c', clientKey: 'c:C', weight: 160 },
  ];

  it('the lots split the bill: 9.64 / 53.03 / 26.30 / 14.03', () => {
    expect(lotCents(103, lots)).toEqual({ 'l:yostiq': 9.64, 'l:kafel': 53.03, 'l:b': 26.3, 'l:c': 14.03 });
  });

  it('D is 9.64 + 53.03 = 62.67 — a second split over the clients would say 62.68 (and C 14.02)', () => {
    expect(clientCentsOf(lots, lotCents(103, lots))).toEqual({ 'c:D': 62.67, 'c:B': 26.3, 'c:C': 14.03 });
  });

  it('the input order does not move a cent (a GROUP BY has no order)', () => {
    const shuffled = [lots[2]!, lots[0]!, lots[3]!, lots[1]!];
    expect(lotCents(103, shuffled)).toEqual(lotCents(103, lots));
    // An exact tie: the spare cent goes to the first KEY, whichever row came first.
    const tie = [
      { key: 'l:2', weight: 1 },
      { key: 'l:1', weight: 1 },
    ];
    expect(lotCents(0.01, tie)).toEqual({ 'l:1': 0.01, 'l:2': 0 });
    expect(lotCents(0.01, [...tie].reverse())).toEqual({ 'l:1': 0.01, 'l:2': 0 });
  });

  it('a client with a lot the cents do not name has no figure; whole cents never print 0.30000000000000004', () => {
    expect(clientCentsOf(lots, { 'l:yostiq': 9.64, 'l:b': 26.3, 'l:c': 14.03 })).toEqual({ 'c:B': 26.3, 'c:C': 14.03 });
    expect(clientCentsOf([{ key: 'a', clientKey: 'x' }, { key: 'b', clientKey: 'x' }], { a: 0.1, b: 0.2 })).toEqual({ x: 0.3 });
  });

  it('the drawing order is share descending, then the label by code unit', () => {
    const rows = [
      { share: 0.2, label: 'GS2' },
      { share: 0.5, label: 'GS9' },
      { share: 0.2, label: 'GS10' },
    ].sort(byShareThenLabel);
    expect(rows.map((r) => r.label)).toEqual(['GS9', 'GS10', 'GS2']);
  });
});

describe('the Narx band line — one pure rule (judge J1/J15/J21/J36)', () => {
  const band = (min: number, max: number | null, price: number, perKg = false): BandView => ({ min, max, price, perKg });
  const lot = (id: string, client: string, b: BandView, share: number): LotView => ({
    key: `l:${id}`,
    lotId: id,
    receiptId: 'r',
    receiptNumber: null,
    clientKey: client,
    clientLabel: client,
    label: id,
    goods: '',
    m3: 1,
    density: 100,
    band: b,
    share,
  });
  const view = (lots: LotView[]): SplitView => ({ kind: 'split', lots, clients: [] });
  const money = { money: true };

  it('one lot → its band; a held or absent view → null', () => {
    const v = view([lot('a', 'c:D', band(1, 100, 110), 1)]);
    expect(clientBandLine(v, 'c:D', null, money)).toEqual({
      bands: [{ key: 'freightBandMoney', range: '1–100', price: '$110' }],
      more: 0,
    });
    expect(clientBandLine({ kind: 'nothing' }, 'c:D', null, money)).toBeNull();
    expect(clientBandLine(undefined, 'c:D', null, money)).toBeNull();
    expect(clientBandLine(v, 'c:X', null, money)).toBeNull();
  });

  it('two lots on the SAME row print it once — under BOTH sights (a plain band is a fresh object)', () => {
    const plain = (b: BandView): BandView => ({ min: b.min, max: b.max, perKg: b.perKg });
    const same = band(101, 500, 200);
    const v = view([lot('a', 'c:D', same, 0.6), lot('b', 'c:D', band(101, 500, 200), 0.4)]);
    expect(clientBandLine(v, 'c:D', null, money)?.bands).toHaveLength(1);
    const p = view([lot('a', 'c:D', plain(same), 0.6), lot('b', 'c:D', plain(same), 0.4)]);
    expect(clientBandLine(p, 'c:D', null, { money: false })).toEqual({
      bands: [{ key: 'freightBand', range: '101–500', price: '' }],
      more: 0,
    });
  });

  it('his D: kafel (the larger lot) first, then yostiq; four rows → two and «+2»', () => {
    const d = view([lot('kafel', 'c:D', band(1000, null, 0.55, true), 0.85), lot('yostiq', 'c:D', band(1, 100, 110), 0.15)]);
    expect(clientBandLine(d, 'c:D', null, money)?.bands.map((b) => b.range)).toEqual(['1000+', '1–100']);
    const four = view([
      lot('a', 'c:D', band(1, 100, 110), 0.4),
      lot('b', 'c:D', band(101, 500, 200), 0.3),
      lot('c', 'c:D', band(501, 999, 300), 0.2),
      lot('e', 'c:D', band(1000, null, 0.55, true), 0.1),
    ]);
    expect(clientBandLine(four, 'c:D', null, money)).toMatchObject({ more: 2 });
    expect(clientBandLine(four, 'c:D', null, money)?.bands.map((b) => b.range)).toEqual(['1–100', '101–500']);
  });

  it('only the lots whose money is IN the part: a carried part holding the kafel alone names the kafel row alone', () => {
    const d = view([lot('kafel', 'c:D', band(1000, null, 0.55, true), 0.85), lot('yostiq', 'c:D', band(1, 100, 110), 0.15)]);
    expect(clientBandLine(d, 'c:D', ['kafel'], money)).toEqual({
      bands: [{ key: 'freightBandMoneyPerKg', range: '1000+', price: '$0.55' }],
      more: 0,
    });
    expect(clientBandLine(d, 'c:D', [], money)).toBeNull();
  });
});

describe('columnWatch — /admin/tarif says when the one column would not split (judge J31)', () => {
  const row = (min: number, max: number | null, price: number, date: string, zone = 'cn') => ({
    zone,
    minDensity: min,
    maxDensity: max,
    priceUsd: price,
    perKg: max === null,
    effectiveDate: date,
  });
  const whole = OWNER_TARIFF_BANDS.map(([min, max, cn]) => row(min, max, cn, '2026-01-01'));

  it('his seeded column is whole today → nothing to say', () => {
    expect(columnWatch('cn', whole, '2026-10-15', FREIGHT_LIGHT_BELOW)).toEqual([]);
  });

  it('a later version that moves a floor is named by ITS date (an overlap stays for good — there is no delete)', () => {
    // A row typed from 90 kg/m³ on 1 November: 90-100 is now in two rows.
    const moved = [...whole, row(90, 150, 130, '2026-11-01')];
    expect(columnWatch('cn', moved, '2026-10-15', FREIGHT_LIGHT_BELOW)).toEqual([
      { from: '2026-11-01', problem: { kind: 'overlap', at: 90 } },
    ]);
    // Once that date comes, it is today's problem — still one line.
    expect(columnWatch('cn', moved, '2026-11-02', FREIGHT_LIGHT_BELOW)).toHaveLength(1);
  });

  it('no row at all is «unpriced» today; another zone’s rows do not count', () => {
    expect(columnWatch('cn', [row(1, null, 50, '2026-01-01', 'kashgar')], '2026-10-15', FREIGHT_LIGHT_BELOW)).toEqual([
      { from: '2026-10-15', problem: { kind: 'unpriced' } },
    ]);
  });
});
