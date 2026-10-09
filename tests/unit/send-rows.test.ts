import { describe, expect, it } from 'vitest';
import {
  answerAmbiguous,
  blankRow,
  codeLooksRight,
  dropBareNumbers,
  isBlankRow,
  itemOfRow,
  keepPair,
  labelNumbers,
  nameKeepsNumber,
  pasteItems,
  rowFromDealLine,
  rowIssues,
  rowOfLine,
  textRows,
  type SendRow,
} from '@/modules/wms/calc/send-rows';
import { parseGoodsLine } from '@/modules/wms/calc/units';

/**
 * The seller's goods table and the VED's paste, as pure functions (P1.1,
 * P1.6, judge UX1-UX3). The owner's sentence: «tnved code va dona m2 juftda
 * otadgan tovarlarni kirgizadgan joyi yoqku». The old form read one textarea
 * as «nomi, soni[, birlik]», so «Kafel, 120 m2» lost its 120 and nothing
 * could carry a code, a net weight or a pair.
 */
const one = (text: string): SendRow => textRows(text, 0)[0]!;
const row = (patch: Partial<SendRow>): SendRow => ({ ...blankRow(1), touched: true, ...patch });

describe('the quick box reads every line into a row, live (UX2)', () => {
  it('«nomi, soni» — the shape every seller and every e2e already types — is unchanged', () => {
    expect(itemOfRow(one('monitor, 10'))).toMatchObject({ name: 'monitor', quantity: 10, weightKg: null });
  });

  it('each figure lands in the column its unit names', () => {
    expect(itemOfRow(one('Kurtka 300 dona 150 kg'))).toMatchObject({
      name: 'Kurtka',
      quantity: 300,
      weightKg: 150,
      measureUnit: null,
    });
    expect(itemOfRow(one('Kafel plitka, 120 m², kod 6907'))).toMatchObject({
      name: 'Kafel plitka',
      quantity: null,
      measureUnit: 'm2',
      measureQty: 120,
      tnvedCode: '6907',
    });
    expect(itemOfRow(one('Lak 50 litr'))).toMatchObject({ measureUnit: 'litr', measureQty: 50 });
    // A volume beside a pair rides along — the one amount cell holds the pair.
    expect(itemOfRow(one('Tufli 40 juft 2 m3'))).toMatchObject({ measureUnit: 'juft', measureQty: 40, volumeM3: 2 });
  });

  it('a carton count is SENT with a note, never written as pieces (UX3, MR-25)', () => {
    const r = one('Futbolka, 20 karobka');
    expect(rowIssues(r).blocking).toEqual([]);
    expect(itemOfRow(r)).toMatchObject({ quantity: null, note: 'sotuvchi: 20 karobka' });
  });

  it('a unit nobody prices is sent with a note too', () => {
    const r = one('Mato 300 рулон');
    expect(rowIssues(r).blocking).toEqual([]);
    expect(itemOfRow(r)!.note).toBe('sotuvchi: 300 рулон');
    expect(itemOfRow(r)!.quantity).toBeNull();
  });
});

describe('only three things stop a send, each with one-tap answers (UX3)', () => {
  it('«1,200» reads two ways: blocked, and either answer re-reads the line', () => {
    const r = one('Kabel, 1,200, kg');
    expect(rowIssues(r).blocking).toHaveLength(1);
    // Nothing is written while it stands — the figure is not guessed.
    expect(itemOfRow(r)!.weightKg).toBeNull();
    const fixed = answerAmbiguous(r.raw!, '1,200', 1200);
    expect(itemOfRow(one(fixed))).toMatchObject({ weightKg: 1200 });
    expect(itemOfRow(one(answerAmbiguous(r.raw!, '1,200', 1.2)))).toMatchObject({ weightKg: 1.2 });
  });

  it('two pairs on one line: keep one and the other leaves the text', () => {
    const raw = 'Plitka 120 m2 40 juft';
    const r = one(raw);
    expect(rowIssues(r).blocking).toHaveLength(1);
    // The «2» of the KEPT «m2» must not be read as the start of «2 40 juft» —
    // the first version re-read the line as «120 m», a unit nobody prices.
    const kept = keepPair(raw, parseGoodsLine(raw), 'm2');
    expect(itemOfRow(one(kept))).toMatchObject({ measureUnit: 'm2', measureQty: 120 });
    expect(rowIssues(one(kept)).blocking).toEqual([]);
    const juft = keepPair(raw, parseGoodsLine(raw), 'juft');
    expect(itemOfRow(one(juft))).toMatchObject({ measureUnit: 'juft', measureQty: 40 });
  });

  it('two bare numbers in separate cells: the seller says which is the count', () => {
    const raw = 'Kurtka; 300; 150';
    const r = one(raw);
    expect(rowIssues(r).blocking).toHaveLength(1);
    const line = parseGoodsLine(raw);
    expect(itemOfRow(one(labelNumbers(line, [300, 150], true)))).toMatchObject({ quantity: 300, weightKg: 150 });
    expect(itemOfRow(one(labelNumbers(line, [300, 150], false)))).toMatchObject({ quantity: 150, weightKg: 300 });
    expect(itemOfRow(one(dropBareNumbers(line)))).toMatchObject({ name: 'Kurtka', quantity: null, weightKg: null });
  });

  it('«Samsung TV 55, 10»: the name keeps its number and the count is the count', () => {
    // None of the text answers fits the commonest «nomi, soni» line with a
    // model number: both labellings invent a weight and «drop» loses the 10.
    const raw = 'Samsung TV 55, 10';
    const r = one(raw);
    expect(rowIssues(r).blocking).toHaveLength(1);
    const fixed = nameKeepsNumber(r, parseGoodsLine(raw), [55, 10]);
    expect(rowIssues(fixed).blocking).toEqual([]);
    expect(itemOfRow(fixed)).toMatchObject({ name: 'Samsung TV 55', quantity: 10, weightKg: null });
  });

  it('a hand-typed cell that reads two ways blocks too, and a word is refused in words', () => {
    expect(rowIssues(row({ name: 'Kabel', kg: '1,200' })).blocking).toMatchObject([
      { kind: 'cell', field: 'kg', cell: { state: 'ambiguous' } },
    ]);
    expect(rowIssues(row({ name: 'Kabel', qty: 'ko‘p' })).blocking).toMatchObject([
      { kind: 'cell', field: 'qty', cell: { state: 'bad' } },
    ]);
    // A row with figures and no name is not a product anybody can price.
    expect(rowIssues(row({ qty: '5' })).blocking).toEqual([{ kind: 'no_name' }]);
  });

  it('a pristine row is not a product and blocks nothing', () => {
    expect(isBlankRow(blankRow(3))).toBe(true);
    expect(rowIssues(blankRow(3)).blocking).toEqual([]);
    expect(itemOfRow(blankRow(3))).toBeNull();
  });
});

describe('the row as the door takes it — structured, nothing derived', () => {
  it('the netto cell is the line’s weight; the shipment total never fills it (MR-7)', () => {
    const item = itemOfRow(row({ name: 'Kurtka', qty: '300', kg: '150', code: '6201' }));
    expect(item).toMatchObject({ quantity: 300, weightKg: 150, tnvedCode: '6201', volumeM3: null });
  });

  it('the amount cell is a pair, or the volume when its unit is m³', () => {
    expect(itemOfRow(row({ name: 'Kafel', amount: '120', unit: 'm2' }))).toMatchObject({
      measureUnit: 'm2',
      measureQty: 120,
      volumeM3: null,
    });
    expect(itemOfRow(row({ name: 'Paket', amount: '2,5', unit: 'm3' }))).toMatchObject({
      measureUnit: null,
      measureQty: null,
      volumeM3: 2.5,
    });
  });

  it('a code that will not be kept is hinted at, never blocked (the door notes it)', () => {
    expect(codeLooksRight('6907')).toBe(true);
    expect(codeLooksRight('6907.21.00.00')).toBe(true);
    expect(codeLooksRight('')).toBe(true);
    expect(codeLooksRight('901210000')).toBe(false);
    expect(codeLooksRight('abc')).toBe(false);
    expect(rowIssues(row({ name: 'X', qty: '1', code: 'abc' })).blocking).toEqual([]);
  });
});

describe('the deal prefill routes each line once (UX17)', () => {
  it('a «120 m2» deal line lands as a pair, never as 120 pieces', () => {
    const r = rowFromDealLine(
      { name: 'Kafel', tnvedCode: '6907210000', quantity: 120, unit: 'm2', weightKg: 900, volumeM3: null },
      5,
    );
    expect(r).toMatchObject({ qty: '', kg: '900', amount: '120', unit: 'm2', code: '6907210000' });
  });

  it('a carton count leaves the piece cell empty and says so', () => {
    const r = rowFromDealLine(
      { name: 'Futbolka', tnvedCode: null, quantity: 20, unit: 'karobka', weightKg: null, volumeM3: null },
      6,
    );
    expect(r.qty).toBe('');
    expect(r.notes).toEqual(['sotuvchi: 20 karobka']);
  });
});

describe('the VED paste never asks, and lands every column (P1.6, TT-16)', () => {
  it('a header TSV keeps its TNVED, its unit and its net weight', () => {
    const text = [
      'Наименование\tКод ТН ВЭД товара\tКол-во\tЕд. изм.\tВес нетто, кг',
      'Плитка\t6907210000\t120\tм2\t900',
      'Куртка\t6201930000\t300\tшт\t150',
    ].join('\n');
    expect(pasteItems(text)).toMatchObject([
      { name: 'Плитка', quantity: null, measureUnit: 'm2', measureQty: 120, weightKg: 900, tnvedCode: '6907210000' },
      { name: 'Куртка', quantity: 300, unit: 'шт', weightKg: 150, tnvedCode: '6201930000' },
    ]);
  });

  it('an unclear free line lands EMPTY with its own words in the note', () => {
    const [kabel, kafel, kurtka] = pasteItems('Kabel, 1,200, kg\nKafel 120 m2 6907210000\nKurtka; 300; 150');
    expect(kabel).toMatchObject({ name: 'Kabel', weightKg: null, note: 'qatorda: «Kabel, 1,200, kg» — aniq emas' });
    expect(kafel).toMatchObject({ measureUnit: 'm2', measureQty: 120, tnvedCode: '6907210000', note: null });
    expect(kurtka).toMatchObject({ quantity: null, weightKg: null, note: 'qatorda: «Kurtka; 300; 150» — aniq emas' });
  });

  it('nothing pasted is nothing posted', () => {
    expect(pasteItems('')).toEqual([]);
    expect(pasteItems('\n  \n')).toEqual([]);
  });
});

describe('a read line keeps its text only while a question stands on it', () => {
  it('a clean line lets go of its text; a blocked one holds it for the answer', () => {
    expect(rowOfLine(parseGoodsLine('monitor, 10'), 1, 'monitor, 10').raw).toBeNull();
    expect(rowOfLine(parseGoodsLine('Kabel, 1,200, kg'), 1, 'Kabel, 1,200, kg').raw).toBe('Kabel, 1,200, kg');
  });
});
