import { describe, expect, it } from 'vitest';
import { landingItems } from '@/modules/wms/calc/intake';
import { parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';

/**
 * docs/AI-SORAYDI.md §3.1 T8 — the typed goods reader keeps a line it
 * half-understands (dg3-09, second).
 *
 * The goods test wanted every token after a line's first figure to be a
 * figure or a unit word it knew. A forwarder's dash («Stol - 10ctn - 150kg -
 * 1.2cbm»), a label («G.W.»), one unknown word («5 meshok») — and the whole
 * line was no goods line: «Tovarlar (0): ⚠️ tovar nomi — yozilmagan», and its
 * lone weight was then taken for the SHIPMENT's. Now the line is a NAMED row;
 * what it holds and nobody reads is kept on the row's note, never on a
 * column, never guessed.
 *
 * Every figure below is worked by hand in the comment beside it.
 */

/** The shipment's two totals as the typed reader states them. */
const totals = (text: string) => {
  const f = parseManualFacts(text, 'podklyuch');
  return { kg: f.weightKg ?? null, m3: f.volumeM3 ?? null };
};

/** The one typed goods row a line gives. */
const row = (text: string) => {
  const goods = readGoodsLines(text);
  expect(goods, text).toHaveLength(1);
  return goods[0]!;
};

describe('T8 — a separator between two figure groups separates them', () => {
  it('dg3-09: «Stol - 10ctn - 150kg - 1.2cbm» is the product Stol with its weight and its cube', () => {
    // Was «Tovarlar (0)», with 150 kg the shipment's and the cube asked.
    expect(row('Stol - 10ctn - 150kg - 1.2cbm')).toMatchObject({ name: 'Stol', weightKg: 150, volumeM3: 1.2 });
    // An en dash and a bar between the groups read the same.
    expect(row('Stol – 10 ctn – 150 kg')).toMatchObject({ name: 'Stol', weightKg: 150 });
    expect(row('Stol | 10 ctn | 150 kg')).toMatchObject({ name: 'Stol', weightKg: 150 });
  });

  it('dg3-09: «LED lamp 3000pcs/15ctns/507kgs/5.92cbm» — a slash before a figure is a separator, never a word of the name', () => {
    // Was the product «LED lamp / / /».
    expect(row('LED lamp 3000pcs/15ctns/507kgs/5.92cbm')).toMatchObject({
      name: 'LED lamp',
      quantity: 3000,
      weightKg: 507,
      volumeM3: 5.92,
    });
  });

  it('two such lines are two rows, and their figures are the lines’ own (PF-2) — no total is read off them', () => {
    const text = 'Stol - 10ctn - 150kg - 1.2cbm\nStul - 20ctn - 300kg - 2.4cbm';
    expect(readGoodsLines(text).map((g) => [g.name, g.weightKg, g.volumeM3])).toEqual([
      ['Stol', 150, 1.2],
      ['Stul', 300, 2.4],
    ]);
    // Before T8 neither line was goods: 150 and 300 were two different
    // weights for the shipment (asked), 1.2 and 2.4 two cubes.
    expect(totals(text)).toEqual({ kg: null, m3: null });
  });

  it('a fraction is no separator and no pair: «Truba 1/2 dyuym 100 dona» is still not read as a «2 dyuym» product', () => {
    expect(readGoodsLines('Truba 1/2 dyuym 100 dona')).toEqual([]);
    expect(readGoodsLines('Kurtka 300 dona 1/2 dyuym')).toEqual([]);
  });
});

describe('T8 — a field label labels the figure after it, and says which weight', () => {
  it('«Stul 20 ctns G.W. 300 kgs» — the row’s 300 kg is its BRUTTO, said by the label', () => {
    // Was no row (an unknown «G.W.» in the tail), and 300 the shipment's.
    const r = row('Stul 20 ctns G.W. 300 kgs');
    expect(r).toMatchObject({ name: 'Stul', weightKg: 300, weightKind: 'gross' });
    // Landed, the row says so: customs wants netto.
    expect(landingItems(parseManualFacts('Stul 20 ctns G.W. 300 kgs'))[0]!.note ?? '').toContain('og‘irlik brutto');
  });

  it('a netto beside a brutto: the row’s weight is the netto (customs), the brutto kept on its note — the shipment’s total is still the brutto', () => {
    const text = 'Stul 20 ctns N.W. 280 kgs G.W. 300 kgs 2.5 cbm';
    // Was dropped: two weights of one unit read as two lines welded into one.
    expect(row(text)).toMatchObject({ name: 'Stul', weightKg: 280, weightKind: 'net', volumeM3: 2.5, note: 'sotuvchi: G.W. 300 kgs' });
    // One goods line is the shipment: its brutto 300 answers the freight
    // question, the netto 280 never does (PF-1).
    expect(totals(text)).toEqual({ kg: 300, m3: 2.5 });
  });

  it('a label with NO unit after its figure gives it one only after «:» or «=» and an unambiguous label (JN-21)', () => {
    // «G.W.: 15» — the label can name nothing but a brutto: 15 kg.
    expect(row('Stul 300 dona G.W.: 15')).toMatchObject({ name: 'Stul', quantity: 300, weightKg: 15, weightKind: 'gross' });
    // «G.W. 15» — no «:»: the figure is set aside for the note, never a count of 15.
    expect(row('Stul 300 dona G.W. 15')).toMatchObject({ name: 'Stul', quantity: 300, weightKg: null, note: 'sotuvchi: G.W. 15' });
    // «CBM 2.5» — the same rule for a cube: aside, the cube asked; the brutto still read.
    expect(row('Stul 20 ctns G.W. 300 kgs CBM 2.5')).toMatchObject({ weightKg: 300, volumeM3: null, note: 'sotuvchi: CBM 2.5' });
  });

  it('before the line’s first figure a label is the NAME’s word unless written as a field — «Kurtka umumiy vazni 150 kg», «Qop soni 20 ta»', () => {
    expect(row('Kurtka umumiy vazni 150 kg')).toMatchObject({ name: 'Kurtka umumiy vazni', weightKg: 150 });
    expect(readGoodsLines('Qop soni 20 ta')).toEqual([]);
  });
});

describe('T8 — a number and a word no vocabulary knows', () => {
  it('AFTER the figures it is set aside for the note, and the row keeps what it read', () => {
    // Was no row, and 150 kg the shipment's alone.
    expect(row('Kurtka 300 dona 150 kg 5 meshok')).toMatchObject({
      name: 'Kurtka',
      quantity: 300,
      weightKg: 150,
      note: 'sotuvchi: 5 meshok',
    });
  });

  it('…and beside another goods line its weight is no longer taken for the shipment’s (dg3-09)', () => {
    const text = 'Kurtka 300 dona 150 kg 5 meshok\nShim 200 dona 80 kg';
    expect(readGoodsLines(text).map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    // 150 and 80 are the two lines' own: no total stated (the brutto is asked).
    expect(totals(text)).toEqual({ kg: null, m3: null });
  });

  it('BEFORE the figures the pair is the name’s, as the kernel reads it — a model, a capacity, a variety', () => {
    expect(row('iPhone 15 Pro 300 dona')).toMatchObject({ name: 'iPhone 15 Pro', quantity: 300 });
    expect(row('Samsung A54 128 GB 50 dona 10 kg')).toMatchObject({ name: 'Samsung A54 128 GB', quantity: 50, weightKg: 10 });
  });

  it('…judged by the name without it: the shipment’s and the chat’s words stay no product', () => {
    // «Yuk» is the cargo itself: the 36 m³ stays the shipment's.
    expect(readGoodsLines('Yuk 3 mashina 36 kub')).toEqual([]);
    expect(totals('Yuk 3 mashina 36 kub')).toEqual({ kg: null, m3: 36 });
    expect(readGoodsLines('Bugun 3 mashina 12 kub')).toEqual([]);
  });

  it('a price is no word of a name, and no pair: «Kurtka 300 dona 5 dollar» reads as it did (T11 is release 1b’s)', () => {
    expect(readGoodsLines('Kurtka 300 dona 5 dollar')).toEqual([]);
  });

  it('a second word after the number is no pair: «Kurtka 300 dona 150 kg qora rang» is still no goods line', () => {
    expect(readGoodsLines('Kurtka 300 dona 150 kg 5 qora rang')).toEqual([]);
  });
});
