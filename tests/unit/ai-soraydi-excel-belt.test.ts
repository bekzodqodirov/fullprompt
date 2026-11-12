import { describe, expect, it } from 'vitest';
import { invoiceFacts } from '@/modules/wms/calc/intake';
import { MAX_GOODS_ROWS, parseGoods, type Cell } from '@/modules/wms/deals/goods-import';

/**
 * «AI so‘raydi», package P-excel, phase 3 — the per-carton column and the
 * sheet's TOTAL row (docs/AI-SORAYDI.md §3.2 X5, X8; rulings JN-12, JN-13,
 * JR-3, JR-11, JS-33 of docs/AI-SORAYDI-REVIEW.md). The corpus (c3500+) pins
 * the diagnosis' own sheets; these pin where each rule stops, on both sides.
 * Every figure below is worked out by hand in the comment beside it.
 */

const sheet = (header: Cell[], ...rows: Cell[][]) => parseGoods([header, ...rows]);
const notes = (header: Cell[], ...rows: Cell[][]) => sheet(header, ...rows).notes.map((n) => `${n.warn ? '⚠️ ' : ''}${n.text}`);
/** The rows as the calc door takes them — the kernel multiplies what the reader copied. */
const door = (header: Cell[], ...rows: Cell[][]) => invoiceFacts(sheet(header, ...rows).goods);

describe('X5 — the line’s cube is the column with the LARGEST Σ (XLS-2, review JN-13)', () => {
  const volumes = (header: Cell[], ...rows: Cell[][]) => sheet(header, ...rows).goods.map((g) => g.volumeM3);

  it('one carton’s unmarked cube loses to the line’s, on either side of it', () => {
    // 0.05 + 0.06 = 0.11 against 0.5 + 1.2 = 1.7: the larger is the line's.
    expect(volumes(['Description', 'CTNS', 'CBM', 'TOTAL CBM'], ['Jacket', 10, 0.05, 0.5], ['Toy', 20, 0.06, 1.2])).toEqual([0.5, 1.2]);
    expect(volumes(['Description', 'CTNS', 'TOTAL CBM', 'CBM'], ['Jacket', 10, 0.5, 0.05], ['Toy', 20, 1.2, 0.06])).toEqual([0.5, 1.2]);
  });

  it('a column in cm³ is CONVERTED before it is compared: the line’s «Volume (cm3)» beats one carton’s «CBM»', () => {
    // 500 000 + 1 200 000 cm³ = 0.5 + 1.2 = 1.7 m³ against 0.05 + 0.06 = 0.11 m³.
    expect(volumes(['Description', 'CTNS', 'CBM', 'Volume (cm3)'], ['Jacket', 10, 0.05, 500000], ['Toy', 20, 0.06, 1200000])).toEqual([0.5, 1.2]);
  });

  it('two columns saying ONE figure keep X6’s order: cubic metres, then the keyed rung, then the leftmost', () => {
    // 120 000 cm³ = 0.12 m³ beside 0.12 m³: equal sums, the cubic metres stand (the row reads 0.12 either way,
    // and the cm³ figure is on no note — that column was not the one taken).
    const row = sheet(['Description', 'Volume (cm3)', 'CBM'], ['Chair', 120000, 0.12]).goods[0]!;
    expect(row.volumeM3).toBe(0.12);
    expect(row.note).toBeNull();
    // «CBM» (keyed) and «MEAS.» (the abbreviation rung) with one figure: «CBM».
    expect(sheet(['Description', 'MEAS.', 'CBM'], ['Chair', 0.12, 0.12]).goods[0]!.volumeM3).toBe(0.12);
    // Within half a per cent is one figure: 1.2 against 1.204 (0.33 %) keeps the left keyed column.
    expect(sheet(['Description', 'CBM', 'Volume'], ['Chair', 1.2, 1.204]).goods[0]!.volumeM3).toBe(1.2);
    // …past it the larger wins: 1.2 against 1.21 (0.83 %).
    expect(sheet(['Description', 'CBM', 'Volume'], ['Chair', 1.2, 1.21]).goods[0]!.volumeM3).toBe(1.21);
  });

  it('a lone volume column is taken whatever its Σ — the ranking only chooses among several', () => {
    expect(volumes(['Description', 'CBM'], ['Chair', 0.05], ['Desk', 0.06])).toEqual([0.05, 0.06]);
  });
});

describe('X5 — ONE carton’s cube by the volume’s own words (XLS-2)', () => {
  const packed = (header: string) => {
    const row = sheet(['Description', 'Qty', 'CTNS', header], ['Jacket', 200, 10, 0.05]).goods[0]!;
    return { line: row.volumeM3, perCarton: row.packing?.m3PerCarton ?? null };
  };

  it('a carton word before the cube, 外箱 / 箱 before 体积, a box or a place after объём, quti / karobka before hajm / kub', () => {
    for (const header of ['CTN CBM', 'CARTON CBM', 'Ctn. CBM', 'Carton volume', 'CTN MEAS', 'Box CBM', '外箱体积', '箱体积', 'Объем коробки', 'Объём коробки, м3', 'Объем кор., м3', 'Объем места, м3', 'Объём места', '1 quti hajmi', 'Karobka hajmi', 'Bir karobka kubi', 'Korobka hajmi (m3)']) {
      // 10 × 0.05 = 0.5 m³ at the door; the reader's own line stays empty.
      expect(packed(header), header).toEqual({ line: null, perCarton: 0.05 });
    }
  });

  it('…the cartons TOGETHER stay the line’s: the plural, a total word, «общий», 总', () => {
    for (const header of ['CTNS CBM', 'Cartons CBM', 'Total carton CBM', 'TTL CTN CBM', 'Объем коробок', 'Объем мест', 'Общий объем коробки', 'Karobkalar hajmi', 'Jami karobka hajmi', '总箱体积']) {
      expect(packed(header), header).toEqual({ line: 0.05, perCarton: null });
    }
  });

  it('…and a carton word AFTER the cube in Latin is no package mark («CBM carton» is no header anybody writes per carton)', () => {
    expect(packed('CBM carton')).toEqual({ line: 0.05, perCarton: null });
  });

  it('the door multiplies it like any «CBM/CTN»: 10 × 0.05 = 0.5, 4 × 0.06 = 0.24', () => {
    const facts = door(['Наименование', 'Кол-во', 'Мест', 'Объем коробки'], ['Куртка', 200, 10, 0.05], ['Брюки', 100, 4, 0.06]);
    expect(facts.map((g) => g.volumeM3)).toEqual([0.5, 0.24]);
  });
});

describe('X5 — the belt concludes ONE carton’s figure only when the arithmetic meets the TOTAL (review JN-12, JR-11)', () => {
  const H: Cell[] = ['Description', 'QTY', 'CTNS', 'G.W.(KGS)', 'CBM'];

  it('Σ(value × cartons) meets the TOTAL, Σ(value) does not: the figures go to the packing, the door multiplies', () => {
    const read = sheet(H, ['Jacket', 200, 10, 12, 0.05], ['Toy', 480, 20, 13, 0.06], ['TOTAL', 680, 30, 380, 1.7]);
    // 10 × 12 + 20 × 13 = 120 + 260 = 380 kg; 10 × 0.05 + 20 × 0.06 = 0.5 + 1.2 = 1.7 m³ — the TOTAL row's.
    // The lines' own sums, 25 kg and 0.11 m³, are what it contradicts.
    expect(read.goods.map((g) => [g.weightKg, g.volumeM3, g.packing?.kgPerCarton, g.packing?.kgPerCartonKind, g.packing?.m3PerCarton])).toEqual([
      [null, null, 12, 'gross', 0.05],
      [null, null, 13, 'gross', 0.06],
    ]);
    expect([read.grossKg, read.volumeM3]).toEqual([380, 1.7]);
    expect(invoiceFacts(read.goods).map((g) => [g.weightKg, g.volumeM3])).toEqual([
      [120, 0.5],
      [260, 1.2],
    ]);
  });

  it('…by the belt’s OWN rounding and nothing looser: a TOTAL 1.4 % off the product is no proof', () => {
    // 10 × 12 + 20 × 13 = 380 against a TOTAL of 385: 5 kg apart, over 1 kg and over 0.5 % of 385 (1.9 kg).
    const read = sheet(['Description', 'QTY', 'CTNS', 'G.W.(KGS)'], ['Jacket', 200, 10, 12], ['Toy', 480, 20, 13], ['TOTAL', 680, 30, 385]);
    expect(read.goods.every((g) => g.packing?.kgPerCarton == null)).toBe(true);
    // …and it is no longer a line figure either: 12 + 13 = 25 is under half of 385 (192.5) while 380 is within
    // 385 × 1.02 = 392.7 — one carton's as like as not (JS-33's test, over every row that has the figure).
    expect(read.goods.map((g) => g.weightKg)).toEqual([null, null]);
  });

  it('…a TOTAL printed to its own decimal agrees with the product, as it does with a Σ', () => {
    // 10 × 0.033 + 20 × 0.068 = 0.33 + 1.36 = 1.69 m³; the TOTAL row prints «1.7» (1.65-1.75 by its place).
    const read = sheet(['Description', 'QTY', 'CTNS', 'CBM'], ['Jacket', 200, 10, 0.033], ['Toy', 480, 20, 0.068], ['TOTAL', 680, 30, 1.7]);
    expect(read.goods.map((g) => g.packing?.m3PerCarton)).toEqual([0.033, 0.068]);
    expect(read.volumeM3).toBe(1.69);
  });

  it('a TOTAL that IS the column’s Σ proves nothing: the lines stand (the column is asked in release 1b)', () => {
    // 12 + 13 = 25 and 0.05 + 0.06 = 0.11: a supplier's SUM dragged across the column.
    const read = sheet(H, ['Jacket', 200, 10, 12, 0.05], ['Toy', 480, 20, 13, 0.06], ['TOTAL', 680, 30, 25, 0.11]);
    expect(read.goods.map((g) => [g.weightKg, g.volumeM3])).toEqual([
      [12, 0.05],
      [13, 0.06],
    ]);
    expect(read.notes).toEqual([]);
  });

  it('no TOTAL row, nothing checked: the lines stand and nothing is said', () => {
    const read = sheet(H, ['Jacket', 200, 10, 12, 0.05], ['Toy', 480, 20, 13, 0.06]);
    expect(read.goods.map((g) => g.weightKg)).toEqual([12, 13]);
    expect(read.notes).toEqual([]);
  });

  it('nothing explains the gap — a pallet in the TOTAL: the LINES stand, the Σ is refused, both sums are said', () => {
    // 100 + 166 = 266 kg against 300; 10 × 100 + 5 × 166 = 1830 explains nothing.
    const read = sheet(['Description', 'CTN', 'G.W.(kg)', 'CBM'], ['Kurtka', 10, 100, 1.0], ['Shim', 5, 166, 1.1], ['TOTAL', 15, 300, 2.1]);
    expect(read.goods.map((g) => g.weightKg)).toEqual([100, 166]);
    expect([read.grossKg, read.volumeM3]).toEqual([null, 2.1]);
    expect(read.notes).toEqual([{ warn: true, text: '«G.W.(kg)» ustuni: jami qatorida 300 kg, qatorlar yig‘indisi 266 kg — umumiy brutto fayldan olinmadi.' }]);
  });

  it('no carton column: nothing can make the figure one carton’s — the lines stand', () => {
    // 15 + 10 = 25 against 190.
    const read = sheet(['Description', 'Qty', 'G.W.(kg)'], ['Ladies jacket', 300, 15], ['Trousers', 100, 10], ['TOTAL', 400, 190]);
    expect(read.goods.map((g) => g.weightKg)).toEqual([15, 10]);
    expect(read.grossKg).toBeNull();
  });

  it('a row that already states one carton’s weight elsewhere keeps it: the column stays the lines’, and the clash is said', () => {
    // «G.W./CTN» 15 / 16 is the packing's. The unmarked «N.W.» 12 / 13 (Σ 25) is contradicted by 380, and
    // 10 × 12 + 20 × 13 = 380 meets it — but the packing has a carton's weight already, and it is not written over.
    const H5: Cell[] = ['Description', 'QTY', 'CTNS', 'G.W./CTN', 'N.W.'];
    const rows: Cell[][] = [['Jacket', 200, 10, 15, 12], ['Toy', 480, 20, 16, 13], ['TOTAL', 680, 30, null, 380]];
    const read = sheet(H5, ...rows);
    expect(read.goods.map((g) => [g.weightKg, g.packing?.kgPerCarton, g.packing?.kgPerCartonKind])).toEqual([
      [12, 15, 'gross'],
      [13, 16, 'gross'],
    ]);
    expect(notes(H5, ...rows)).toEqual(['⚠️ «N.W.» ustuni: jami qatorida 380 kg, qatorlar yig‘indisi 25 kg — bir-biriga mos kelmaydi.']);
  });

  it('a merged figure is its master’s, stated once: a column with one is never multiplied row by row', () => {
    // «G.W.» 12 merged over the jacket's two lines (10 + 10 cartons) and 13 on the toy's 20: 12 + 13 = 25
    // against 380 contradicts; but the merge's 12 belongs to which 10 cartons nobody can say.
    const rows: Cell[][] = [
      ['Description', 'QTY', 'CTNS', 'G.W.'],
      ['Jacket black', 100, 10, 12],
      ['Jacket white', 100, 10, 12],
      ['Toy', 480, 20, 13],
      ['TOTAL', 680, 40, 380],
    ];
    const cover = { has: (d: number, c: number) => d === 2 && c === 3, size: 1 };
    const read = parseGoods(rows, cover as never);
    expect(read.goods.every((g) => g.packing?.kgPerCarton == null)).toBe(true);
  });

  it('the NET column is belted too, and the gross beside it stays the brutto', () => {
    // N.W. 11 / 12 (Σ 23) against 350; 10 × 11 + 20 × 12 = 110 + 240 = 350 ✓. G.W. 120 + 260 = 380 = its TOTAL.
    const read = sheet(['Description', 'QTY', 'CTNS', 'N.W.', 'G.W.'], ['Jacket', 200, 10, 11, 120], ['Toy', 480, 20, 12, 260], ['TOTAL', 680, 30, 350, 380]);
    expect(read.goods.map((g) => [g.weightKg, g.packing?.kgPerCarton, g.packing?.kgPerCartonKind])).toEqual([
      [null, 11, 'net'],
      [null, 12, 'net'],
    ]);
    expect(read.grossKg).toBe(380);
    expect(invoiceFacts(read.goods).map((g) => g.weightKg)).toEqual([110, 240]);
  });

  it('a GROSS column of one carton’s figure beside the lines’ net: the brutto is the product, the lines untouched', () => {
    // N.W. 110 + 240 = 350 ✓ its TOTAL; G.W. 12 + 13 = 25 against 380, 10 × 12 + 20 × 13 = 380 ✓.
    const read = sheet(['Description', 'QTY', 'CTNS', 'N.W.', 'G.W.'], ['Jacket', 200, 10, 110, 12], ['Toy', 480, 20, 240, 13], ['TOTAL', 680, 30, 350, 380]);
    expect(read.goods.map((g) => g.weightKg)).toEqual([110, 240]);
    expect(read.grossKg).toBe(380);
    expect(read.notes).toEqual([
      { warn: false, text: '«G.W.» ustunidagi son bitta karobkaniki: karobkalar soni × shu son = 380 kg, fayldagi jami bilan bir xil — brutto shundan olindi.' },
    ]);
  });

  it('a cube column beside a SIZE column is the kernel’s to compare (X4), never the belt’s', () => {
    // 60×40×50 cm = 0.12 m³ a carton; «CBM» 0.12 IS one carton's — the kernel replaces it at the door.
    const one = sheet(['Description', 'CTNS', 'Carton size (cm)', 'CBM'], ['Jacket', 10, '60*40*50', 0.12], ['TOTAL', 10, null, 1.2]);
    expect(one.goods[0]!.packing?.m3PerCarton).toBeNull();
    expect(invoiceFacts(one.goods)[0]!.volumeM3).toBe(1.2);
    // …and where the kernel replaces nothing — 0.1 is not 60×40×50's 0.12, 0.05 not 50×40×30's 0.06 — the
    // column still meets the TOTAL as one carton's (10 × 0.1 + 20 × 0.05 = 2.0), yet beside a size it is
    // never given a second cube: the lines stand (the kernel asks each, `differs`).
    const two = sheet(['Description', 'CTNS', 'Carton size (cm)', 'CBM'], ['Jacket', 10, '60*40*50', 0.1], ['Toy', 20, '50*40*30', 0.05], ['TOTAL', 30, null, 2.0]);
    expect(two.goods.map((g) => [g.volumeM3, g.packing?.m3PerCarton])).toEqual([
      [0.1, null],
      [0.05, null],
    ]);
    expect(two.volumeM3).toBeNull();
  });

  it('a list stopped at the reader’s ceiling is belted by nobody: its first 500 lines are no shipment', () => {
    const lines: Cell[][] = Array.from({ length: MAX_GOODS_ROWS + 1 }, (_, k): Cell[] => [`Item ${k + 1}`, 1, 2, 3]);
    const read = parseGoods([['Description', 'QTY', 'CTNS', 'G.W.'], ...lines, ['TOTAL', 501, 1002, 3006]]);
    expect(read.stoppedShort).toBe(true);
    // 500 × 3 = 1500 kg read, 2 cartons each: 500 × 2 × 3 = 3000 — near the TOTAL, and nothing is concluded.
    expect(read.goods.every((g) => g.weightKg === 3 && g.packing?.kgPerCarton == null)).toBe(true);
    expect(read.notes).toEqual([]);
  });
});

describe('X5 — the rows that HAVE the figure (review JS-33)', () => {
  const H: Cell[] = ['Description', 'QTY', 'CTNS', 'G.W.'];

  it('under half the TOTAL, the product within 2 % of it, on two rows of several cartons: off the rows, onto their notes', () => {
    // 15 + 18 = 33 < 530 / 2 = 265; 20 × 15 + 10 × 18 = 300 + 180 = 480 ≤ 530 × 1.02 = 540.6.
    const read = sheet(H, ['Kurtka', 200, 20, 15], ['Shim', 100, 10, 18], ['Sumka', 50, 5, null], ['TOTAL', 350, 35, 530]);
    expect(read.goods.map((g) => [g.weightKg, g.note])).toEqual([
      [null, 'vazn «15» — bitta karobkanikimi yoki qatornikimi, aniq emas'],
      [null, 'vazn «18» — bitta karobkanikimi yoki qatornikimi, aniq emas'],
      [null, null],
    ]);
    expect(notes(H, ['Kurtka', 200, 20, 15], ['Shim', 100, 10, 18], ['Sumka', 50, 5, null], ['TOTAL', 350, 35, 530])).toEqual([
      '⚠️ «G.W.» ustuni: qatorlardagi yig‘indi 33 kg, jami qatorida 530 kg — ustundagi son bitta karobkanikimi yoki qatornikimi, aniq emas; qatorlarga yozilmadi.',
    ]);
  });

  it('…not at half the TOTAL or more: the present rows are the lines’ (a big row left blank)', () => {
    // 150 + 180 = 330 ≥ 265: the lines stand.
    const read = sheet(H, ['Kurtka', 200, 20, 150], ['Shim', 100, 10, 180], ['Sumka', 50, 5, null], ['TOTAL', 350, 35, 530]);
    expect(read.goods.map((g) => g.weightKg)).toEqual([150, 180, null]);
    // …at exactly half too, where the product alone would call the column one carton's: 130 + 135 = 265 =
    // 530 / 2, and 2 × 130 + 2 × 135 = 530 ≤ 540.6.
    const half = sheet(H, ['Kurtka', 200, 2, 130], ['Shim', 100, 2, 135], ['Sumka', 50, 5, null], ['TOTAL', 350, 9, 530]);
    expect(half.goods.map((g) => g.weightKg)).toEqual([130, 135, null]);
  });

  it('…not when the product passes the TOTAL by more than 2 %', () => {
    // 20 × 15 + 10 × 30 = 300 + 300 = 600 > 540.6, though 15 + 30 = 45 < 265.
    const read = sheet(H, ['Kurtka', 200, 20, 15], ['Shim', 100, 10, 30], ['Sumka', 50, 5, null], ['TOTAL', 350, 35, 530]);
    expect(read.goods.map((g) => g.weightKg)).toEqual([15, 30, null]);
  });

  it('…not on ONE row of several cartons: a single figure says nothing of the column', () => {
    // Only Kurtka has several cartons with a figure (Shim's 1 carton × 18 = 18 is the figure itself).
    const read = sheet(H, ['Kurtka', 200, 20, 15], ['Shim', 100, 1, 18], ['Sumka', 50, 5, null], ['TOTAL', 350, 26, 530]);
    expect(read.goods.map((g) => g.weightKg)).toEqual([15, 18, null]);
  });

  it('…not when a row with the figure has no carton count: there is no product to weigh', () => {
    const read = sheet(H, ['Kurtka', 200, 20, 15], ['Shim', 100, null, 18], ['Sumka', 50, 5, null], ['TOTAL', 350, 25, 530]);
    expect(read.goods.map((g) => g.weightKg)).toEqual([15, 18, null]);
  });

  it('the cube alike: the figure as the file wrote it goes on the note', () => {
    // 0.05 + 0.06 = 0.11 < 3.8 / 2 = 1.9; 10 × 0.05 + 20 × 0.06 = 1.7 ≤ 3.8 × 1.02 = 3.876.
    const read = sheet(['Description', 'QTY', 'CTNS', 'CBM'], ['Jacket', 200, 10, 0.05], ['Toy', 480, 20, '0.06'], ['Lamp', 300, 30, null], ['TOTAL', 980, 60, 3.8]);
    expect(read.goods.map((g) => [g.volumeM3, g.note])).toEqual([
      [null, 'hajm «0.05» — bitta karobkanikimi yoki qatornikimi, aniq emas'],
      [null, 'hajm «0.06» — bitta karobkanikimi yoki qatornikimi, aniq emas'],
      [null, null],
    ]);
  });
});

describe('X8 — the TOTAL row as the sheet’s total, where a kept line LACKS the figure (XLS-6, review JR-3)', () => {
  const H: Cell[] = ['Description', 'CTN', 'G.W.(kg)', 'CBM'];
  const totals = (...rows: Cell[][]) => {
    const read = parseGoods(rows);
    return [read.grossKg, read.volumeM3];
  };

  it('one total row and a line without the figure: the row’s cell — and with every line stating it, the lines’ Σ as before', () => {
    // The cube: no line states one, the TOTAL row says 3.8; the weight: 100 + 166 = 266 = its TOTAL.
    expect(totals(H, ['Kurtka', 10, 100, null], ['Shim', 5, 166, null], ['TOTAL', 15, 266, 3.8])).toEqual([266, 3.8]);
    // 1.0 + 1.1 = 2.1 from the lines, the TOTAL row agreeing to its printed place («2.1»).
    expect(totals(H, ['Kurtka', 10, 100, 1.0], ['Shim', 5, 166, 1.1], ['TOTAL', 15, 266, 2.1])).toEqual([266, 2.1]);
  });

  it('sections: their totals ADDED when nothing closes them — never the last section’s alone', () => {
    // 100 + 166 = 266, the Shim line's weight blank.
    expect(totals(H, ['Kurtka', 10, 100, 1.0], ['TOTAL', 10, 100, 1.0], ['Shim', 5, null, 1.1], ['TOTAL', 5, 166, 1.1])[0]).toBe(266);
    // …a closing grand total that is their sum: 266 (100 + 166).
    expect(totals(H, ['Kurtka', 10, 100, 1.0], ['TOTAL', 10, 100, 1.0], ['Shim', 5, null, 1.1], ['TOTAL', 5, 166, 1.1], ['TOTAL', 15, 266, 2.1])[0]).toBe(266);
    // …a section TOTAL that states no weight: nothing adds up to the shipment.
    expect(totals(H, ['Kurtka', 10, 100, 1.0], ['TOTAL', 10, null, 1.0], ['Shim', 5, null, 1.1], ['TOTAL', 5, 166, 1.1])[0]).toBeNull();
  });

  it('only total rows that CLOSE the list: a section below the last of them is covered by none', () => {
    // «MEN» has no TOTAL of its own: 150 kg / 1.2 m³ are the women's alone — the shipment is 150 + 120 = 270 kg
    // and 1.2 + 1 = 2.2 m³ — and the headings' blank cells are what leaves the Σ null (the corpus' c3083).
    const read = parseGoods([
      ['Description', 'Qty', 'G.W. (kg)', 'CBM'],
      ['WOMEN', null, null, null],
      ['Ladies jacket', 300, 150, 1.2],
      ['TOTAL', 300, 150, 1.2],
      ['MEN', null, null, null],
      ['Men jacket', 200, 120, 1],
    ]);
    expect([read.grossKg, read.volumeM3]).toEqual([null, null]);
  });

  it('a «SAY TOTAL» words line under the TOTAL row is no section of it', () => {
    // One line lacks its weight; the TOTAL row says 266; the words line states no figure of any column.
    expect(totals(H, ['Kurtka', 10, 100, 1.0], ['Shim', 5, null, 1.1], ['TOTAL', 15, 266, 2.1], ['SAY TOTAL: US DOLLARS ONE THOUSAND ONLY'])[0]).toBe(266);
  });

  it('never where the belt REFUSED a Σ — the pallet sheet keeps no brutto', () => {
    // 100 + 166 = 266 against 300: refused, and the TOTAL does not then stand for it.
    expect(totals(H, ['Kurtka', 10, 100, 1.0], ['Shim', 5, 166, 1.1], ['TOTAL', 15, 300, 2.1])).toEqual([null, 2.1]);
  });

  it('never where the KERNEL corrected the lines — their Σ is a sum of single cartons, and the TOTAL is not offered in its place', () => {
    // «G.W.» 12 equals «G.W./CTN» 12 beside 10 cartons: the door replaces it by 120, and the sheet's gross Σ is no total.
    const read = parseGoods([['Description', 'CTNS', 'G.W./CTN', 'G.W.'], ['Jacket', 10, 12, 12], ['TOTAL', 10, null, 120]]);
    expect(read.grossKg).toBeNull();
  });

  it('never on a list stopped at the reader’s ceiling', () => {
    const lines: Cell[][] = Array.from({ length: MAX_GOODS_ROWS + 1 }, (_, k): Cell[] => [`Item ${k + 1}`, 1, null, 0.1]);
    const read = parseGoods([H, ...lines, ['TOTAL', 501, 5010, 50.1]]);
    expect(read.stoppedShort).toBe(true);
    expect([read.grossKg, read.volumeM3]).toEqual([null, null]);
  });

  it('the TOTAL row’s brutto lighter than the lines’ own netto is no brutto either', () => {
    // N.W. 150 + 250 = 400 kg; the TOTAL row's G.W. 300 < 400.
    expect(parseGoods([['Description', 'QTY', 'N.W.', 'G.W.'], ['Jacket', 200, 150, 160], ['Toy', 480, 250, null], ['TOTAL', 680, 400, 300]]).grossKg).toBeNull();
  });

  it('a TOTAL cell that reads two ways states nothing', () => {
    expect(totals(['Description', 'CTN', 'G.W.(kg)'], ['Kurtka', '10', '1200'], ['Shim', '5', null], ['TOTAL', '15', '1,650'])[0]).toBeNull();
  });
});

describe('X8 — a summary line read in the trade’s words (units.ts’ vocabulary)', () => {
  const HEAD: Cell[] = ['No.', 'Description', 'QTY(PCS)', 'Unit price (USD)', 'Amount (USD)'];
  const ROWS: Cell[][] = [[1, 'Ladies jacket', 200, 6.5, 1300], [2, 'Kids toy plastic', 480, 1.2, 576], ['TOTAL', null, 680, null, 1876]];
  const under = (...lines: Cell[][]) => {
    const read = parseGoods([HEAD, ...ROWS, ...lines]);
    return [read.grossKg, read.volumeM3];
  };

  it('«TOTAL: 60 CTNS / G.W. 710 KGS / 3.8 CBM»: the brutto after its label, the cube by its unit', () => {
    expect(under(['TOTAL: 60 CTNS / G.W. 710 KGS / 3.8 CBM'])).toEqual([710, 3.8]);
    expect(under(['TOTAL: 15 CTNS, G.W.: 507 KGS, MEAS: 5.92 CBM'])).toEqual([507, 5.92]);
    expect(under(['合计: 毛重 507kg 体积 5.92立方'])).toEqual([507, 5.92]);
  });

  it('label | value cells: a bare figure after a cube label and a colon is the cube', () => {
    expect(under(['TOTAL G.W.:', '710 KGS'], ['TOTAL CBM:', 3.8])).toEqual([710, 3.8]);
  });

  it('…and a bare figure with no colon, kilos with no gross label, a netto — none is the brutto', () => {
    expect(under(['TOTAL CBM 3.8'])[1]).toBeNull();
    expect(under(['TOTAL: 60 CTNS / 710 KGS'])[0]).toBeNull();
    expect(under(['TOTAL N.W.: 480 KGS'])[0]).toBeNull();
  });

  it('one carton’s figure, a figure that reads two ways, half of a spaced group, two different figures: nothing', () => {
    expect(under(['TOTAL: G.W. 15 KGS/CTN'])[0]).toBeNull();
    expect(under(['TOTAL: G.W. 1,650 KGS'])[0]).toBeNull();
    expect(under(['TOTAL G.W. 1 136.5 KGS'])[0]).toBeNull();
    // …after a colon too, where the figure may stand with no unit: never the «1» alone.
    expect(under(['TOTAL G.W.: 1 136.5 KGS'])[0]).toBeNull();
    // …and a cube after a bare number: «60 3.8 CBM» is no 3.8 m³ (nor 603.8).
    expect(under(['TOTAL: 60 3.8 CBM'])[1]).toBeNull();
    expect(under(['TOTAL: G.W. 710 KGS / G.W. 720 KGS'])[0]).toBeNull();
    // …while a comma group AND a decimal point is ONE number: 1136.5.
    expect(under(['TOTAL G.W.: 1,136.5 KGS'])[0]).toBe(1136.5);
  });

  it('two summary lines: the same figure is said twice, two sections are added', () => {
    expect(under(['TOTAL: G.W. 710 KGS'], ['TOTAL: G.W. 710 KGS'])[0]).toBe(710);
    // 100 + 166 = 266.
    expect(under(['TOTAL: G.W. 100 KGS'], ['TOTAL: G.W. 166 KGS'])[0]).toBe(266);
  });

  it('a line with no total word is not read (it may be one carton’s spec)', () => {
    expect(under(['毛重 507kg 体积 5.92立方'])).toEqual([null, null]);
  });

  it('the column’s own TOTAL cell outranks a summary line beside it', () => {
    const read = parseGoods([
      ['Description', 'CTN', 'G.W.(kg)', 'CBM'],
      ['Kurtka', 10, 100, null],
      ['Shim', 5, null, null],
      ['TOTAL', 15, 266, 2.1],
      ['TOTAL: G.W. 270 KGS / 2.2 CBM'],
    ]);
    // The column reading: the TOTAL row's 266 and 2.1 (the summary row states no figure of a column, so it is
    // not a section of them); the summary line is read only where the columns say nothing.
    expect([read.grossKg, read.volumeM3]).toEqual([266, 2.1]);
  });
});
