import { describe, expect, it } from 'vitest';
import {
  MISS_WORDS,
  UNIT_BASIS,
  bandKeyOf,
  estimateCustoms,
  estimateInputOf,
  medianForRow,
  missWords,
  type CodeMedianUnit,
  type EstimateGroup,
  type EstimateItem,
  type RowMedian,
} from '@/modules/wms/calc/estimate';
import { customsFor, type PricedGroup } from '@/modules/wms/calc/pricing';
import { blockerText } from '@/modules/wms/calc/prefill-reply';
import { BASIS_FOR_UNIT } from '@/modules/wms/customs/import-baza';
import type { Workspace } from '@/modules/wms/calc/workspace';

/**
 * The 📊 shadow estimate (docs/SAKKIZ-R2.md §6.5) — his 2.1 b and 2.2 b.
 *
 * Every expected figure is worked out by hand in the comment beside it, from
 * the law and the medians: the engine priced the input groups, and the
 * question here is only what the ESTIMATE makes of them.
 */
const FEE = { bhmUzs: 412_000, fxUzsPerUsd: 12_500, feeOverrideUsd: null }; // 1 BHM = $32.96

const law = (over: Partial<PricedGroup> = {}): PricedGroup => ({
  seq: 1,
  label: 'Guruh',
  tnvedCode: '6201400000',
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

const item = (id: string, seq: number, over: Partial<EstimateItem> = {}): EstimateItem => ({
  id,
  seq,
  label: `Tovar ${seq}`,
  quantity: null,
  weightKg: 100,
  volumeM3: null,
  bazaUsd: null,
  bazaBasis: null,
  measureUnit: null,
  measureQty: null,
  ...over,
});

/** A group as the workspace hands it in: the law, and the ENGINE's exact answer. */
const group = (id: string, priced: PricedGroup, items: EstimateItem[]): EstimateGroup => ({
  id,
  seq: priced.seq,
  label: priced.label,
  priced,
  customs: customsFor(priced, items),
  items,
});

const median = (bazaUsd: number, n = 6, over: Partial<Extract<RowMedian, { ok: true }>> = {}): RowMedian => ({
  ok: true,
  bazaUsd,
  basis: 'kg',
  n,
  batchEnd: '2026-09-30',
  stale: false,
  ...over,
});
const missed = (miss: Extract<RowMedian, { ok: false }>['miss'], n: number | null = null): RowMedian => ({
  ok: false,
  miss,
  n,
});

describe('two totals: «Aniq» over what priced, «Taxminiy» once the medians fill the rest', () => {
  it('(a) 7 exact rows in 2 groups + 3 estimated rows — Aniq without the fee, Taxminiy with it', () => {
    // A: 4 × 100 kg × $4 = $1600; duty 10 % = 160; VAT 12 % of 1760 = 211.20 → 371.20
    const a = group('A', law({ seq: 1 }), [1, 2, 3, 4].map((s) => item(`a${s}`, s, { bazaUsd: 4, bazaBasis: 'kg' })));
    // B: 3 × 50 kg × $2 = $300; duty 5 % = 15; VAT 12 % of 315 = 37.80 → 52.80
    const b = group(
      'B',
      law({ seq: 2, dutyPct: 5 }),
      [5, 6, 7].map((s) => item(`b${s}`, s, { weightKg: 50, bazaUsd: 2, bazaBasis: 'kg' })),
    );
    // C: 3 × 100 kg, no baza; the median $3.50/kg → $1050; duty 105; VAT 12 % of 1155 = 138.60 → 243.60
    const c = group('C', law({ seq: 3 }), [8, 9, 10].map((s) => item(`c${s}`, s)));
    const medians = new Map([8, 9, 10].map((s) => [`c${s}`, median(3.5, 23)]));

    const out = estimateCustoms({ groups: [a, b, c], ungroupedCount: 0, ...FEE, medians });
    expect(out.rows).toBe(10);
    expect(out.exactRows).toBe(7);
    // 371.20 + 52.80, and NO fee: the fee's tier is the whole declaration's.
    expect(out.exactUsd).toBe(424);
    // Value 1600 + 300 + 1050 = 2950 → 1 BHM = 412 000 ÷ 12 500 = 32.96.
    // 371.20 + 52.80 + 243.60 + 32.96 = 700.56
    expect(out.taxminiy).toEqual({
      customsUsd: 700.56,
      fee: { ok: true, feeUsd: 32.96, bhmCoefficient: 1, overridden: false },
    });
    expect(out.taxminiyBlock).toBeNull();
    const ce = out.groups.get('C');
    expect(ce?.kind).toBe('estimated');
    expect(ce?.kind === 'estimated' && ce.customs.customsUsd).toBe(243.6);
    expect(ce?.kind === 'estimated' && ce.medians.map((m) => m.n)).toEqual([23, 23, 23]);
    expect(out.groups.get('A')).toEqual({ kind: 'exact' });
  });

  it('(b) the fee tier is taken on the FULL value — 1.5 BHM in Taxminiy, none in Aniq', () => {
    // Exact: 100 kg × $90 = $9000; duty 900; VAT 12 % of 9900 = 1188 → 2088.
    const e = group('E', law({ seq: 1 }), [item('e1', 1, { bazaUsd: 90, bazaBasis: 'kg' })]);
    // Estimated: 100 kg × $30 = $3000; duty 300; VAT 12 % of 3300 = 396 → 696.
    const f = group('F', law({ seq: 2 }), [item('f1', 2)]);
    const out = estimateCustoms({ groups: [e, f], ungroupedCount: 0, ...FEE, medians: new Map([['f1', median(30)]]) });
    expect(out.exactUsd).toBe(2088);
    // 9000 + 3000 = 12 000 → the 10 001-20 000 tier, 1.5 BHM = 49.44.
    // 2088 + 696 + 49.44 = 2833.44 — on $9000 alone it would have been 1 BHM.
    expect(out.taxminiy?.fee.bhmCoefficient).toBe(1.5);
    expect(out.taxminiy?.fee.feeUsd).toBe(49.44);
    expect(out.taxminiy?.customsUsd).toBe(2833.44);
  });

  it('(c) one row with no median → no Taxminiy at all, and the miss is named', () => {
    const a = group('A', law({ seq: 1 }), [item('a1', 1, { bazaUsd: 4, bazaBasis: 'kg' })]);
    const c = group('C', law({ seq: 2 }), [item('c1', 2)]);
    const d = group('D', law({ seq: 3 }), [item('d1', 3, { label: 'Kurtka qishki' })]);
    const out = estimateCustoms({
      groups: [a, c, d],
      ungroupedCount: 0,
      ...FEE,
      medians: new Map([
        ['c1', median(3.5)],
        ['d1', missed('few', 3)],
      ]),
    });
    expect(out.groups.get('C')?.kind).toBe('estimated');
    // WHOLE or absent (⭐ of his Question 1): A + C would be a number, and a
    // smaller one than the declaration's.
    expect(out.taxminiy).toBeNull();
    expect(out.taxminiyBlock).toBe('refused');
    expect(out.groups.get('D')).toMatchObject({
      kind: 'refused',
      customs: { ok: false, reason: 'baza_missing', itemSeq: 3 },
      misses: [{ seq: 3, label: 'Kurtka qishki', miss: 'few', n: 3 }],
    });
  });

  it('(d) an uncoded row → no Taxminiy, and it is counted among the rows', () => {
    const a = group('A', law({ seq: 1 }), [item('a1', 1, { bazaUsd: 4, bazaBasis: 'kg' })]);
    const c = group('C', law({ seq: 2 }), [item('c1', 2)]);
    const out = estimateCustoms({ groups: [a, c], ungroupedCount: 1, ...FEE, medians: new Map([['c1', median(3.5)]]) });
    expect(out.rows).toBe(3);
    expect(out.exactRows).toBe(1);
    expect(out.taxminiy).toBeNull();
    expect(out.taxminiyBlock).toBe('ungrouped');
  });

  it('(e) the certificate is the EFFECTIVE one — an inherited «bor» adds no duty', () => {
    // The group says nothing (raw override null) and the request says «bor».
    const ws = {
      groups: [
        {
          id: 'g1',
          seq: 1,
          label: 'Kurtka',
          tnvedCode: '6201400000',
          dutyPct: 10,
          vatPct: 12,
          feeUsd: null,
          dutyMode: 'advalor',
          dutySpecific: null,
          dutyUnit: null,
          excisePct: null,
          exciseSpecific: null,
          exciseUnit: null,
          hasCertificate: null,
          effectiveCertificate: true,
          requestCertificate: true,
          dutyFree: false,
          vatFree: false,
          customs: { ok: false, reason: 'baza_missing', itemSeq: 1, itemLabel: 'Kurtka' },
          items: [item('i1', 1, { label: 'Kurtka' })],
        },
      ],
      ungrouped: [],
      ...FEE,
    } as unknown as Workspace;
    const out = estimateCustoms({ ...estimateInputOf(ws), medians: new Map([['i1', median(3.5)]]) });
    const g = out.groups.get('g1');
    // 100 kg × $3.50 = $350; duty 35; no additional duty; VAT 12 % of 385 = 46.20 → 81.20.
    // Spread as a WorkspaceGroup, `hasCertificate: null` would add 10 % = 35 → 120.40.
    expect(g?.kind === 'estimated' && g.customs.addDutyUsd).toBe(0);
    expect(g?.kind === 'estimated' && g.customs.customsUsd).toBe(81.2);
    // 81.20 + 32.96 = 114.16
    expect(out.taxminiy?.customsUsd).toBe(114.16);
  });

  it('(f) a typed price with no basis is never shadowed — it is somebody’s number', () => {
    const t = group('T', law({ seq: 1 }), [item('t1', 1, { bazaUsd: 5, bazaBasis: null })]);
    const out = estimateCustoms({ groups: [t], ungroupedCount: 0, ...FEE, medians: new Map([['t1', median(3.5)]]) });
    expect(out.groups.get('T')).toMatchObject({ kind: 'refused', customs: { reason: 'baza_missing', itemSeq: 1 }, misses: [] });
    expect(out.taxminiy).toBeNull();
  });

  it('(g) a shadow the law still refuses carries the ENGINE’s words', () => {
    // «10 %, lekin $3/dona dan kam emas» on a row stating kilos and no count:
    // the median prices the value, and the floor still has no count to read.
    const g = group(
      'G',
      law({ seq: 1, label: 'Kurtka', dutyMode: 'max', dutySpecific: 3, dutyUnit: 'dona' }),
      [item('g1', 1, { label: 'Kurtka' })],
    );
    const out = estimateCustoms({ groups: [g], ungroupedCount: 0, ...FEE, medians: new Map([['g1', median(4)]]) });
    const ge = out.groups.get('G');
    expect(ge).toMatchObject({
      kind: 'refused',
      customs: { reason: 'measure_missing', itemSeq: 1, unit: 'dona', half: 'duty', rate: 3 },
    });
    if (ge?.kind !== 'refused') throw new Error('expected refused');
    expect(
      blockerText({
        kind: 'customs',
        groupSeq: 1,
        groupLabel: 'Kurtka',
        reason: ge.customs.reason,
        itemLabel: ge.customs.itemLabel,
        itemSeq: ge.customs.itemSeq,
        unit: ge.customs.unit,
        half: ge.customs.half,
        rate: ge.customs.rate,
      }),
    ).toBe('Kurtka: 1-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona');
    expect(out.taxminiyBlock).toBe('refused_measure');
  });

  it('(i) why Taxminiy is absent — in §2.2’s order, first that applies', () => {
    const measure = () =>
      group('M', law({ seq: 1, dutyMode: 'max', dutySpecific: 3, dutyUnit: 'dona' }), [item('m1', 1)]);
    const noMedian = () => group('N', law({ seq: 2 }), [item('n1', 2)]);
    const mm = new Map<string, RowMedian>([
      ['m1', median(4)],
      ['n1', missed('few', 2)],
    ]);
    expect(estimateCustoms({ groups: [measure()], ungroupedCount: 1, ...FEE, medians: mm }).taxminiyBlock).toBe('ungrouped');
    expect(estimateCustoms({ groups: [measure(), noMedian()], ungroupedCount: 0, ...FEE, medians: mm }).taxminiyBlock).toBe(
      'refused_measure',
    );
    expect(
      estimateCustoms({ groups: [noMedian()], ungroupedCount: 0, ...FEE, medians: new Map([['n1', missed('budget')]]) })
        .taxminiyBlock,
    ).toBe('budget');
    expect(
      estimateCustoms({ groups: [noMedian()], ungroupedCount: 0, ...FEE, medians: new Map([['n1', missed('timeout')]]) })
        .taxminiyBlock,
    ).toBe('budget');
    // Every group exact and only the fee refusing: the fee says why.
    const a = group('A', law(), [item('a1', 1, { bazaUsd: 4, bazaBasis: 'kg' })]);
    expect(
      estimateCustoms({ groups: [a], ungroupedCount: 0, bhmUzs: 412_000, fxUzsPerUsd: null, feeOverrideUsd: null, medians: new Map() })
        .taxminiyBlock,
    ).toBe('fee_fx_missing');
  });
});

describe('(h) which median a row takes', () => {
  const series = (unit: CodeMedianUnit['unit'], n: number, p50: number | null, bands: [string, number, number | null][] = []) => ({
    unit,
    n,
    p50,
    bands: new Map(bands.map(([k, bn, bp]) => [k, { n: bn, p50: bp }])),
  });
  const base = { batch: { endDate: '2026-09-30' }, staleCutoff: '2026-07-01' };

  it('kilograms first for an advalor row stating kilos and a count', () => {
    const out = medianForRow({
      ...base,
      allowed: ['kg', 'dona'],
      bandKey: 'k1',
      rows: [series('kg', 6, 4.1), series('dona', 30, 2, [['k1', 9, 1.5]])],
    });
    expect(out).toEqual({ ok: true, bazaUsd: 4.1, basis: 'kg', n: 6, batchEnd: '2026-09-30', stale: false });
  });

  it('a dona row reads ITS OWN per-piece band — two rows, two bands, one statement’s answer', () => {
    const rows = [series('dona', 40, 2, [
      ['k1', 7, 1.5],
      ['k2', 9, 3],
    ])];
    expect(medianForRow({ ...base, allowed: ['dona', 'kg'], bandKey: 'k1', rows })).toMatchObject({
      ok: true,
      bazaUsd: 1.5,
      basis: 'unit',
      n: 7,
    });
    expect(medianForRow({ ...base, allowed: ['dona', 'kg'], bandKey: 'k2', rows })).toMatchObject({ ok: true, bazaUsd: 3, n: 9 });
  });

  it('four declarations are too few (FEW = 5) — said with the count', () => {
    const out = medianForRow({ ...base, allowed: ['kg'], bandKey: null, rows: [series('kg', 4, 3)] });
    expect(out).toEqual({ ok: false, miss: 'few', n: 4 });
    expect(missWords('few', 4)).toBe('faqat 4 ta deklaratsiya (kamida 5 kerak)');
  });

  it('a dona row with no per-piece weight is not compared against the whole series', () => {
    expect(medianForRow({ ...base, allowed: ['dona'], bandKey: null, rows: [series('dona', 30, 2)] })).toEqual({
      ok: false,
      miss: 'no_piece_weight',
      n: null,
    });
  });

  it('declarations in another unit only → unit_mismatch; none at all → no_declarations; no figure → no_measure', () => {
    expect(medianForRow({ ...base, allowed: ['kg'], bandKey: null, rows: [series('m2', 9, 5)] })).toEqual({
      ok: false,
      miss: 'unit_mismatch',
      n: null,
    });
    expect(medianForRow({ ...base, allowed: ['kg'], bandKey: null, rows: [] })).toEqual({
      ok: false,
      miss: 'no_declarations',
      n: 0,
    });
    expect(medianForRow({ ...base, allowed: [], bandKey: null, rows: [series('kg', 9, 5)] })).toEqual({
      ok: false,
      miss: 'no_measure',
      n: null,
    });
  });

  it('an old file is said — inclusive at the cutoff day, like the workspace’s own chip', () => {
    const rows = [series('kg', 6, 4)];
    expect(medianForRow({ ...base, staleCutoff: '2026-09-30', allowed: ['kg'], bandKey: null, rows })).toMatchObject({
      stale: true,
    });
    expect(medianForRow({ ...base, staleCutoff: '2026-09-29', allowed: ['kg'], bandKey: null, rows })).toMatchObject({
      stale: false,
    });
  });
});

describe('the small rules', () => {
  it('a file unit prices a row in the basis the import fill would use', () => {
    // Restated in the pure module; held equal to the one beside the database.
    expect(UNIT_BASIS).toEqual(BASIS_FOR_UNIT);
  });

  it('the band key is stable, and absent without a per-piece weight', () => {
    expect(bandKeyOf(0.4)).toEqual({ key: '0.3-0.5', lo: 0.3, hi: 0.5 });
    expect(bandKeyOf(null)).toBeNull();
    expect(bandKeyOf(0)).toBeNull();
  });

  it('every miss has words, and only «few» carries a count', () => {
    for (const [miss, words] of Object.entries(MISS_WORDS)) {
      expect(words.length, miss).toBeGreaterThan(5);
      expect(words.includes('{n}'), miss).toBe(miss === 'few');
    }
  });
});
