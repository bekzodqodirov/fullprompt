import { describe, expect, it } from 'vitest';
import {
  lawAsksInputOf,
  lawAsksInputOfStored,
  lawAsksOf,
  type LawAsksInput,
} from '@/modules/wms/calc/law-asks';
import type { CalcGoodsFact } from '@/modules/wms/calc/intake';
import type { NeedLaw } from '@/modules/wms/calc/needs';
import type { Workspace } from '@/modules/wms/calc/workspace';

/**
 * His 2.8 b (docs/SAKKIZ-R3.md §10.2.6, §10.3) and his 1.14 a: after the AI
 * answer the bot asks exactly the figure the LAW pins and the row does not
 * state — dona, juft, and also kg, m², litr when the floor or excise is in
 * that unit. The rows are the scout's probe, typed by hand; the expected
 * column is the spec's table, never a reading of the code (#166).
 */

const law = (over: Partial<NeedLaw>): NeedLaw => ({
  dutyMode: 'advalor',
  dutyUnit: null,
  dutySpecific: null,
  dutyFree: false,
  excisePct: null,
  exciseSpecific: null,
  exciseUnit: null,
  ...over,
});

/** «20 %, kamida $3/dona» — PP-3818's commonest floor. */
const FLOOR_DONA = law({ dutyMode: 'max', dutyUnit: 'dona', dutySpecific: 3 });
const FLOOR_M2 = law({ dutyMode: 'max', dutyUnit: 'm2', dutySpecific: 0.5 });
const FLOOR_JUFT = law({ dutyMode: 'max', dutyUnit: 'juft', dutySpecific: 3 });
const ADVALOR = law({});
/** A lgota: the same floor, switched off — the engine skips the specific half. */
const LGOTA = law({ dutyMode: 'max', dutyUnit: 'dona', dutySpecific: 2, dutyFree: true });

const row = (seq: number, name: string, rowLaw: NeedLaw | null, over: Partial<CalcGoodsFact> = {}): CalcGoodsFact => ({
  seq,
  itemId: `item-${seq}`,
  name,
  quantity: null,
  weightKg: null,
  volumeM3: null,
  measureUnit: null,
  measureQty: null,
  tnvedCode: `61000000${String(seq).padStart(2, '0')}`,
  bazaBasis: null,
  law: rowLaw,
  ...over,
});

const stored = (goods: CalcGoodsFact[], over: Partial<LawAsksInput> = {}): LawAsksInput => ({
  section: 'rastamojka',
  facts: { goods, lineWeightsStated: true, totalsStored: true },
  bookLaws: new Map(),
  confirmedSeqs: new Set(),
  ...over,
});

/** The asks as «seq: unit,unit», the shape the table below is written in. */
const shape = (input: LawAsksInput) => lawAsksOf(input).map((a) => `${a.seq}: ${a.needs.map((n) => n.unit).join(',')}`);

describe('the rows the law asks a figure for (the spec’s table, his 1.14 a)', () => {
  const probe = [
    // A per-kg import baza on a jacket whose floor counts pieces.
    row(1, 'Kurtka', FLOOR_DONA, { weightKg: 300, bazaBasis: 'kg' }),
    // An m² law on a row that states only its kilos — asked m² (1.14 a).
    row(2, 'Kafel', FLOOR_M2, { weightKg: 900 }),
    // A juft law with no baza: the floor and the baza's default unit are one
    // figure, asked once.
    row(3, 'Krossovka', FLOOR_JUFT, { quantity: 200 }),
    // Ad valorem: no unit is the law's — the one-measure rule is the VED's.
    row(4, 'Sumka', ADVALOR, { quantity: 50 }),
    // A lgota: the floor that would have asked the count is off.
    row(5, 'Ko‘ylak', LGOTA, { weightKg: 100, bazaBasis: 'kg' }),
    // The count is given.
    row(6, 'Shim', FLOOR_DONA, { quantity: 300, weightKg: 120, bazaBasis: 'kg' }),
  ];

  it('Kurtka → dona, Kafel → m², Krossovka → juft once; Sumka, Ko‘ylak and Shim → none', () => {
    expect(shape(stored(probe))).toEqual(['1: dona', '2: m2', '3: juft']);
  });

  it('each ask says WHY in the law’s own terms — the floor and its rate', () => {
    const [kurtka] = lawAsksOf(stored(probe));
    expect(kurtka).toEqual({
      itemId: 'item-1',
      seq: 1,
      name: 'Kurtka',
      needs: [{ unit: 'dona', why: 'duty', present: false, rate: 3 }],
    });
  });

  it('a yolkira job asks nothing — a truck is priced on its totals', () => {
    expect(lawAsksOf(stored(probe, { section: 'yolkira' }))).toEqual([]);
  });

  it('kg and litr are asked too when the law pins them — the floor or a specific excise (1.14 a)', () => {
    const goods = [
      row(1, 'Stol', law({ dutyMode: 'max', dutyUnit: 'kg', dutySpecific: 0.4 }), { quantity: 40 }),
      row(2, 'Pivo', law({ exciseSpecific: 0.5, exciseUnit: 'litr' }), { quantity: 100, bazaBasis: 'unit' }),
    ];
    expect(shape(stored(goods))).toEqual(['1: kg', '2: litr']);
  });

  it('a row whose only gap is «any measure» is the VED’s, never the law’s ask (#910)', () => {
    // No code, no law: the baza's unit is the VED's to choose.
    expect(shape(stored([row(1, 'Nomsiz', null, { tnvedCode: null })]))).toEqual([]);
  });
});

describe('the row answers to its GROUP’s law, and a ✅ ends the asking', () => {
  it('a grouped row whose group law differs from the book → the group’s (judge S9)', () => {
    // The book says ad valorem for the code; the VED retyped the group's law
    // to «kamida $3/dona». The row carries its group's law (`law`), which
    // wins over the book (`bookLaws`) — the same rule the VED's chips follow.
    const code = '6201400000';
    const grouped = row(1, 'Kurtka', FLOOR_DONA, { tnvedCode: code, weightKg: 300, bazaBasis: 'kg' });
    const book = new Map<string, NeedLaw>([[code, ADVALOR]]);
    expect(shape(stored([grouped], { bookLaws: book }))).toEqual(['1: dona']);
    // …and the other way: the book's floor does not ask a row whose group a
    // person set to ad valorem.
    const relaxed = row(1, 'Kurtka', ADVALOR, { tnvedCode: code, weightKg: 300, bazaBasis: 'kg' });
    expect(shape(stored([relaxed], { bookLaws: new Map([[code, FLOOR_DONA]]) }))).toEqual([]);
  });

  it('…and an ungrouped row (no `law` of its own) answers to the book', () => {
    const code = '6201400000';
    const loose: CalcGoodsFact = { ...row(1, 'Kurtka', null, { tnvedCode: code, weightKg: 300, bazaBasis: 'kg' }) };
    delete loose.law;
    expect(shape(stored([loose], { bookLaws: new Map([[code, FLOOR_DONA]]) }))).toEqual(['1: dona']);
  });

  it('a row in a ✅’d group → none: the VED vouched for it', () => {
    const goods = [row(1, 'Kurtka', FLOOR_DONA, { weightKg: 300, bazaBasis: 'kg' }), row(2, 'Kafel', FLOOR_M2, { weightKg: 900 })];
    expect(shape(stored(goods, { confirmedSeqs: new Set([1]) }))).toEqual(['2: m2']);
  });

  it('numbered by `seq` after a deletion (1, 3, 4) — the number the add table and the VED print', () => {
    const goods = [
      row(1, 'Kurtka', FLOOR_DONA, { weightKg: 300, bazaBasis: 'kg' }),
      row(3, 'Kafel', FLOOR_M2, { weightKg: 900 }),
      row(4, 'Krossovka', FLOOR_JUFT, { quantity: 200 }),
    ];
    expect(lawAsksOf(stored(goods)).map((a) => [a.seq, a.itemId])).toEqual([
      [1, 'item-1'],
      [3, 'item-3'],
      [4, 'item-4'],
    ]);
  });

  it('a line with no stored identity is not asked here — it is not on the job yet', () => {
    const fresh: CalcGoodsFact = { name: 'Yangi', weightKg: 10, tnvedCode: '6201400000', law: FLOOR_DONA };
    expect(lawAsksOf(stored([fresh]))).toEqual([]);
  });
});

describe('the two adapters (performance-9, p5-p6-12)', () => {
  /** A workspace as `loadWorkspace` hands it — only the fields the adapter reads. */
  const ws = (over: Partial<Workspace> = {}): Workspace =>
    ({
      rev: 5,
      handsoffRev: 5,
      section: 'rastamojka',
      fromCity: null,
      weightKg: 1200,
      volumeM3: null,
      groups: [
        {
          ...FLOOR_DONA,
          excisePct: null,
          exciseSpecific: null,
          exciseUnit: null,
          confirmedAt: null,
          items: [
            { id: 'item-3', seq: 3, label: 'Kurtka', quantity: null, weightKg: 300, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: '6201400000', bazaBasis: 'kg' },
          ],
        },
        {
          ...FLOOR_M2,
          excisePct: null,
          exciseSpecific: null,
          exciseUnit: null,
          confirmedAt: new Date(),
          items: [
            { id: 'item-1', seq: 1, label: 'Kafel', quantity: null, weightKg: 900, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: '6907210000', bazaBasis: null },
          ],
        },
      ],
      ungrouped: [
        { id: 'item-2', seq: 2, label: 'Nomsiz', quantity: null, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: null, bazaBasis: null },
      ],
      ...over,
    }) as unknown as Workspace;

  it('the workspace adapter and the stored-request adapter give `lawAsksOf` the same rows', () => {
    // The same request, as `storedRequestFacts` reads it (K14): the rows in
    // seq order, each with its law, the ✅ on the group's rows.
    const fromStored = lawAsksInputOfStored({
      base: {
        section: 'rastamojka',
        items: [
          { seq: 1, confirmed: true },
          { seq: 2, confirmed: false },
          { seq: 3, confirmed: false },
        ],
      } as never,
      facts: {
        weightKg: 1200,
        volumeM3: null,
        goods: [
          row(1, 'Kafel', FLOOR_M2, { weightKg: 900, tnvedCode: '6907210000' }),
          row(2, 'Nomsiz', null, { tnvedCode: null }),
          row(3, 'Kurtka', FLOOR_DONA, { weightKg: 300, bazaBasis: 'kg', tnvedCode: '6201400000' }),
        ],
        lineWeightsStated: true,
        totalsStored: true,
      },
    });
    const fromWorkspace = lawAsksInputOf(ws())!;
    expect(fromWorkspace).not.toBeNull();
    expect(lawAsksOf(fromWorkspace)).toEqual(lawAsksOf(fromStored));
    expect(lawAsksOf(fromWorkspace).map((a) => a.seq)).toEqual([3]);
  });

  it('a person has written since the machine (`handsoffRev !== rev`) → null, nothing is asked', () => {
    expect(lawAsksInputOf(ws({ handsoffRev: 4 }))).toBeNull();
    // A request from before 0139 (or a correction) carries no stamp at all.
    expect(lawAsksInputOf(ws({ handsoffRev: null }))).toBeNull();
  });
});
