import { describe, expect, it } from 'vitest';
import {
  MERGE_PICKS_MAX,
  NO_MERGE,
  fnv1a,
  groupSig,
  invoiceModel,
  labelRuns,
  mergeQuery,
  parseMergeParam,
  type InvoiceLot,
  type InvoiceSourceRow,
} from '@/modules/wms/documents/invoice-rows';

/**
 * The customs invoice's rows as data (the owner's item 6, 2026-11-10;
 * docs/TARKIB-TUZATISH.md §6): same code + same name is ONE position; same
 * code under different names is asked; every position names its lots; a lot
 * of several goods that do not stand in one position is red.
 */

const lot = (label: string, lines = 0, lotId = `id:${label}`): InvoiceLot => ({ lotId, label, lines });
const kg = (l: InvoiceLot, name: string, code: string, kilos: number, places: number | 'part' = 1): InvoiceSourceRow => ({
  lot: l,
  name,
  code,
  unit: 'кг',
  pieces: null,
  places,
  kgTenths: Math.round(kilos * 10),
  estimate: null,
});
const pcs = (l: InvoiceLot, name: string, code: string, pieces: number, kilos: number, places: number | 'part' = 1): InvoiceSourceRow => ({
  ...kg(l, name, code, kilos, places),
  unit: 'шт',
  pieces,
});
const face = (m: ReturnType<typeof invoiceModel>) =>
  m.positions.map((p) => [p.name, p.code, p.unit, p.quantity, p.places, p.kgTenths / 10, p.lots.map((x) => x.label).join(', ')]);
const answer = (m: ReturnType<typeof invoiceModel>, codes: string[]) =>
  parseMergeParam((mergeQuery(m, new Set(codes)) ?? '').replace('?merge=', ''));

const A = lot('GS777-A', 2);
const B = lot('GS812-B');
const C = lot('GS900-AC', 3);

describe('the automatic merge — same code AND same name', () => {
  it('two clients’ lots of one good are ONE position; column B lists both lots', () => {
    const m = invoiceModel([kg(A, 'Клавиатура', '8471607000', 60, 5), kg(B, ' клавиатура ', '8471607000', 40.5, 3)]);
    expect(face(m)).toEqual([['Клавиатура', '8471607000', 'кг', 100.5, 8, 100.5, 'GS777-A, GS812-B']]);
    expect(m.groups).toEqual([]);
    expect(m.fp).toBe('');
  });

  it('the same name under ANOTHER code is another position, and a row with NO code is never merged', () => {
    const m = invoiceModel([
      kg(A, 'Мышь', '8471606000', 10),
      kg(B, 'Мышь', '8471607000', 20),
      kg(lot('GS1-A'), 'Мышь', '', 30),
      kg(lot('GS2-A'), 'Мышь', '', 40),
    ]);
    expect(m.positions.map((p) => p.kgTenths / 10)).toEqual([10, 20, 30, 40]);
    expect(m.groups).toEqual([]);
  });

  it('the first member keeps the slot and the spelling; later members fold into it wherever they stand', () => {
    const m = invoiceModel([
      kg(A, 'Клавиатура', '8471607000', 1),
      kg(B, 'Чай', '0902', 2),
      kg(lot('GS3-C'), 'КЛАВИАТУРА', '8471607000', 3),
    ]);
    expect(m.positions.map((p) => [p.name, p.kgTenths])).toEqual([
      ['Клавиатура', 40],
      ['Чай', 20],
    ]);
    expect(m.positions[0]!.members).toEqual([0, 2]);
  });
});

describe('a merged position’s figures', () => {
  it('kilos are summed as integer tenths — 0.1 + 0.2 is 0.3, not 0.30000000000000004', () => {
    const m = invoiceModel([kg(A, 'X', '1234', 0.1), kg(B, 'X', '1234', 0.2)]);
    expect(m.positions[0]!.kgTenths).toBe(3);
    expect(m.positions[0]!.quantity).toBe(0.3);
  });

  it('«шт» only when EVERY member counts pieces; otherwise «кг» with the kilos — and the pieces that were stated are named, never lost', () => {
    const both = invoiceModel([pcs(A, 'Мышь', '8471606000', 500, 40), pcs(B, 'Мышь', '8471606000', 170, 12.5)]);
    expect(face(both)).toEqual([['Мышь', '8471606000', 'шт', 670, 2, 52.5, 'GS777-A, GS812-B']]);
    expect(both.positions[0]!.piecesDropped).toEqual([]);
    const mixed = invoiceModel([pcs(A, 'Мышь', '8471606000', 500, 40), kg(B, 'Мышь', '8471606000', 12.5)]);
    expect(face(mixed)).toEqual([['Мышь', '8471606000', 'кг', 52.5, 2, 52.5, 'GS777-A, GS812-B']]);
    expect(mixed.positions[0]!.piecesDropped).toEqual([{ label: 'GS777-A', pieces: 500 }]);
  });

  it('places: the numbers add up; «part» is kept only when no member has a number', () => {
    const numbers = invoiceModel([kg(A, 'X', '1234', 1, 7), kg(B, 'X', '1234', 1, 'part'), kg(C, 'X', '1234', 1, 2)]);
    expect(numbers.positions[0]!.places).toBe(9);
    const parts = invoiceModel([kg(A, 'X', '1234', 1, 'part'), kg(B, 'X', '1234', 1, 'part')]);
    expect(parts.positions[0]!.places).toBe('part');
  });

  it('an estimate note travels with its lot, once', () => {
    const rows = [
      { ...kg(A, 'X', '1234', 1), estimate: 'Расчётно: доля' },
      { ...kg(A, 'X', '1234', 1), estimate: 'Расчётно: доля' },
      kg(B, 'X', '1234', 1),
    ];
    expect(invoiceModel(rows).positions[0]!.estimates).toEqual([{ label: 'GS777-A', note: 'Расчётно: доля' }]);
  });
});

describe('same code, different names — asked, never merged by itself', () => {
  const rows = [
    kg(A, 'Клавиатура проводная', '8471607000', 60),
    pcs(A, 'Мышь', '8471606000', 500, 40),
    kg(B, 'Клавиатура беспроводная', '8471607000', 25),
    kg(lot('GS5-D'), 'клавиатура ПРОВОДНАЯ', '8471607000', 15),
  ];

  it('the group lists each name with its lots and figures, and what ONE merged position would print', () => {
    const m = invoiceModel(rows);
    expect(m.positions).toHaveLength(3);
    expect(m.groups).toHaveLength(1);
    const [g] = m.groups;
    expect(g!.code).toBe('8471607000');
    expect(g!.names).toEqual([
      { name: 'Клавиатура проводная', unit: 'кг', quantity: 75, kgTenths: 750, labels: ['GS777-A', 'GS5-D'] },
      { name: 'Клавиатура беспроводная', unit: 'кг', quantity: 25, kgTenths: 250, labels: ['GS812-B'] },
    ]);
    expect(g!.merged).toEqual({
      name: 'Клавиатура проводная, Клавиатура беспроводная',
      unit: 'кг',
      quantity: 100,
      kgTenths: 1000,
      mixedUnits: false,
    });
    expect(m.fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it('merged only when the answer names the code with the signature it has NOW', () => {
    const m = invoiceModel(rows);
    const yes = invoiceModel(rows, answer(m, ['8471607000']));
    expect(face(yes)).toEqual([
      // The lots in slot order: the first name's members, then the second's.
      ['Клавиатура проводная, Клавиатура беспроводная', '8471607000', 'кг', 100, 3, 100, 'GS777-A, GS5-D, GS812-B'],
      ['Мышь', '8471606000', 'шт', 500, 1, 40, 'GS777-A'],
    ]);
    // A name changed after the list was shown: the old answer is not this
    // group's answer, so nothing asked is merged — by the «all» token (the
    // only group IS all of them, so `answer()` sends that)…
    const renamed = rows.map((r, i) => (i === 2 ? { ...r, name: 'Клавиатура игровая' } : r));
    expect(invoiceModel(renamed, answer(m, ['8471607000'])).positions).toHaveLength(3);
    // …and by the per-code pair, which is what an address carries when only
    // SOME groups are merged: the code alone is not consent, the signature is.
    const oldPair = { all: null, picks: new Map([['8471607000', m.groups[0]!.sig]]) };
    expect(invoiceModel(rows, oldPair).positions).toHaveLength(2);
    expect(invoiceModel(renamed, oldPair).positions).toHaveLength(3);
    const newPair = { all: null, picks: new Map([['8471607000', invoiceModel(renamed).groups[0]!.sig]]) };
    expect(invoiceModel(renamed, newPair).positions).toHaveLength(2);
    // …and a bare address (an old link) prints every asked group apart.
    expect(invoiceModel(rows, NO_MERGE).positions).toHaveLength(3);
    expect(invoiceModel(rows, parseMergeParam(null)).positions).toHaveLength(3);
  });

  it('the signature ignores the order rows arrive in and the spelling’s case — and moves with the names', () => {
    expect(groupSig('8471607000', ['Б', 'а'])).toBe(groupSig('8471607000', [' А ', 'б']));
    expect(groupSig('8471607000', ['а', 'б'])).not.toBe(groupSig('8471607000', ['а', 'в']));
    expect(groupSig('8471607000', ['а', 'б'])).not.toBe(groupSig('8471606000', ['а', 'б']));
    expect(invoiceModel([...rows].reverse()).groups[0]!.sig).toBe(invoiceModel(rows).groups[0]!.sig);
  });

  it('a group that mixes «шт» and «кг» says so before it is merged', () => {
    const m = invoiceModel([pcs(A, 'Мышь', '8471606000', 500, 40), kg(B, 'Мышь оптическая', '8471606000', 10)]);
    expect(m.groups[0]!.merged).toMatchObject({ unit: 'кг', quantity: 50, mixedUnits: true });
  });

  it('«all» merges every group — while the whole list is the one that was shown', () => {
    const two = [...rows, kg(C, 'Чай зелёный', '0902', 5), kg(B, 'Чай чёрный', '0902', 6)];
    const m = invoiceModel(two);
    expect(m.groups.map((g) => g.code)).toEqual(['8471607000', '0902']);
    expect(mergeQuery(m, new Set(['8471607000', '0902']))).toBe(`?merge=all.${m.fp}`);
    expect(invoiceModel(two, { all: m.fp, picks: new Map() }).positions.map((p) => p.code)).toEqual(['8471607000', '8471606000', '0902']);
    expect(invoiceModel(two, { all: '00000000', picks: new Map() }).positions).toHaveLength(5);
    // One of two: a pair, not «all».
    expect(mergeQuery(m, new Set(['0902']))).toBe(`?merge=0902.${m.groups[1]!.sig}`);
    expect(mergeQuery(m, new Set())).toBe('');
  });
});

describe('the address parameter is read as a forged post', () => {
  it('keeps `code.sig` pairs and `all.fp`, drops everything else, never throws', () => {
    const a = parseMergeParam('8471607000.0a1b2c3d, 0902.ffffffff,DROP TABLE,12.zzzzzzzz,84716070001.00000000,all.89abcdef');
    expect([...a.picks]).toEqual([
      ['8471607000', '0a1b2c3d'],
      ['0902', 'ffffffff'],
    ]);
    expect(a.all).toBe('89abcdef');
    expect(parseMergeParam('')).toEqual({ all: null, picks: new Map() });
    expect(parseMergeParam(undefined)).toEqual({ all: null, picks: new Map() });
    expect(parseMergeParam('all.XYZ')).toEqual({ all: null, picks: new Map() });
  });

  it('is capped: the address carries at most MERGE_PICKS_MAX pairs, and that many stay under the signed link’s 2048 characters', () => {
    const many = Array.from({ length: 500 }, (_, i) => `${String(1000000000 + i)}.00000000`).join(',');
    expect(parseMergeParam(many).picks.size).toBe(MERGE_PICKS_MAX);
    const rows = Array.from({ length: MERGE_PICKS_MAX + 5 }, (_, i) => [
      kg(lot(`GS${i}-A`), 'имя один', String(1000000000 + i), 1),
      kg(lot(`GS${i}-B`), 'имя два', String(1000000000 + i), 1),
    ]).flat();
    const m = invoiceModel(rows);
    expect(m.groups).toHaveLength(MERGE_PICKS_MAX + 5);
    const codes = m.groups.map((g) => g.code);
    const full = mergeQuery(m, new Set(codes.slice(0, MERGE_PICKS_MAX)))!;
    expect(`/api/batches/00000000-0000-4000-8000-000000000000/invoice${full}`.length).toBeLessThan(2048);
    // More than the address can carry, but not all: said, never silently fewer.
    expect(mergeQuery(m, new Set(codes.slice(0, MERGE_PICKS_MAX + 1)))).toBeNull();
    expect(mergeQuery(m, new Set(codes))).toBe(`?merge=all.${m.fp}`);
  });

  it('fnv1a is the published FNV-1a/32 (the same value in a browser and on the server)', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });
});

describe('red — «opening this carton you may find another good»', () => {
  it('a lot of two goods standing in two positions is red in BOTH rows; its neighbour in the same cell is black', () => {
    const m = invoiceModel([
      kg(A, 'Клавиатура', '8471607000', 60),
      kg(A, 'Мышь', '8471606000', 40),
      kg(B, 'Мышь', '8471606000', 5),
    ]);
    expect([...m.redLabels]).toEqual(['GS777-A']);
    expect(m.positions.map((p) => labelRuns(p, m.redLabels))).toEqual([
      [{ text: 'GS777-A', red: true }],
      [
        { text: 'GS777-A', red: true },
        { text: 'GS812-B', red: false },
      ],
    ]);
  });

  it('…and black once its goods all stand in ONE position — one good to customs', () => {
    const rows = [kg(A, 'Клавиатура проводная', '8471607000', 60), kg(A, 'Клавиатура беспроводная', '8471607000', 40)];
    const apart = invoiceModel(rows);
    expect([...apart.redLabels]).toEqual(['GS777-A']);
    const merged = invoiceModel(rows, answer(apart, ['8471607000']));
    expect(merged.positions).toHaveLength(1);
    expect([...merged.redLabels]).toEqual([]);
  });

  it('a lot of three goods of which ONE row is on this truck is red: nobody knows which carton is which', () => {
    const m = invoiceModel([kg(C, 'Чай', '0902', 5), kg(B, 'Чай', '0902', 6)]);
    expect(m.positions).toHaveLength(1);
    expect([...m.redLabels]).toEqual(['GS900-AC']);
  });

  it('a lot with no tarkib, or with ONE line, is never red — however many clients share its position', () => {
    const m = invoiceModel([kg(B, 'Чай', '0902', 6), kg(lot('GS4-A', 1), 'Чай', '0902', 6), kg(lot('GS6-A'), 'Кофе', '0901', 1)]);
    expect([...m.redLabels]).toEqual([]);
  });

  it('decided per LABEL STRING: two lots that share a sticker are red together, in every row', () => {
    const twin = lot('GS777-AA', 0, 'id:other-warehouse');
    const split = lot('GS777-AA', 2, 'id:split');
    const m = invoiceModel([kg(split, 'Клавиатура', '8471607000', 1), kg(split, 'Мышь', '8471606000', 1), kg(twin, 'Кофе', '0901', 1)]);
    expect(m.positions.map((p) => labelRuns(p, m.redLabels))).toEqual([
      [{ text: 'GS777-AA', red: true }],
      [{ text: 'GS777-AA', red: true }],
      [{ text: 'GS777-AA', red: true }],
    ]);
    // …and one label carried by two lots of ONE position is printed once.
    const same = invoiceModel([kg(split, 'X', '1234', 1), kg(twin, 'X', '1234', 1)]);
    expect(labelRuns(same.positions[0]!, same.redLabels)).toHaveLength(1);
  });
});

describe('the totals do not move — a property over random trucks', () => {
  it('Σ kilos, Σ numeric places and the set of lots are the source’s, merged or not, in 400 random trucks', () => {
    let seed = 20261110;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const names = ['Клавиатура', 'Мышь', 'Чай', 'Кофе', 'Наушники', 'клавиатура', 'Мышь оптическая'];
    const codes = ['', '8471607000', '8471606000', '0902'];
    for (let t = 0; t < 400; t += 1) {
      const lots = Array.from({ length: 1 + rnd(6) }, (_, i) => lot(`GS${rnd(4)}-${'ABC'[rnd(3)]}`, rnd(4), `id:${t}:${i}`));
      const rows: InvoiceSourceRow[] = Array.from({ length: 1 + rnd(14) }, () => {
        const l = lots[rnd(lots.length)]!;
        const kilos = (1 + rnd(5000)) / 10;
        const place: number | 'part' = rnd(5) === 0 ? 'part' : 1 + rnd(40);
        return rnd(3) === 0
          ? pcs(l, names[rnd(names.length)]!, codes[rnd(codes.length)]!, 1 + rnd(900), kilos, place)
          : kg(l, names[rnd(names.length)]!, codes[rnd(codes.length)]!, kilos, place);
      });
      const plain = invoiceModel(rows);
      const all = invoiceModel(rows, { all: plain.fp, picks: new Map() });
      const some = invoiceModel(rows, answer(plain, plain.groups.filter((_, i) => i % 2 === 0).map((g) => g.code)));
      const kgOf = (m: typeof plain) => m.positions.reduce((s, p) => s + p.kgTenths, 0);
      const placesOf = (m: typeof plain) => m.positions.reduce((s, p) => s + (typeof p.places === 'number' ? p.places : 0), 0);
      const lotsOf = (m: typeof plain) => [...new Set(m.positions.flatMap((p) => p.lots.map((x) => x.lotId)))].sort();
      const source = {
        kg: rows.reduce((s, r) => s + r.kgTenths, 0),
        places: rows.reduce((s, r) => s + (typeof r.places === 'number' ? r.places : 0), 0),
        lots: [...new Set(rows.map((r) => r.lot.lotId))].sort(),
      };
      for (const m of [plain, all, some]) {
        expect(kgOf(m)).toBe(source.kg);
        expect(placesOf(m)).toBe(source.places);
        expect(lotsOf(m)).toEqual(source.lots);
        // Every source row stands in exactly one position.
        expect(m.positions.flatMap((p) => p.members).sort((a, b) => a - b)).toEqual(rows.map((_, i) => i));
      }
      // «All» leaves no code in two positions; a codeless row is never merged.
      const coded = all.positions.filter((p) => p.code !== '').map((p) => p.code);
      expect(new Set(coded).size).toBe(coded.length);
      expect(all.positions.filter((p) => p.code === '').length).toBe(rows.filter((r) => r.code === '').length);
    }
  });
});
