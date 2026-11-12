import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { fitSheetRows } from '@/modules/wms/calc/intake-ai';
import { SHEET_TEXT_BUDGET, readGoodsFile, sheetsAsText } from '@/modules/wms/deals/goods-file';
import { CoverMask, parseGoods, type Cell } from '@/modules/wms/deals/goods-import';
import { readGoodsFileCases } from './fixtures/intake-corpus';

/**
 * «AI so‘raydi», package P-excel — the column reader (docs/AI-SORAYDI.md
 * §3.2, X0-X4, X6, X7; rulings JN-11, JN-13, JN-14, JR-1 of
 * docs/AI-SORAYDI-REVIEW.md). The corpus (c3400+) pins the diagnosis' own
 * sheets; these pin where each rule stops, on both sides. Every figure below
 * is worked out by hand in the comment beside it.
 */

const sheet = (header: Cell[], ...rows: Cell[][]) => parseGoods([header, ...rows]);
const first = (header: Cell[], ...rows: Cell[][]) => sheet(header, ...rows).goods[0]!;

describe('X6 — a volume header’s own unit (review JN-13)', () => {
  const volume = (header: string, value: Cell) => first(['Description', 'Qty', header], ['Chair', 10, value]).volumeM3;

  it('cubic centimetres are divided by a million, in every spelling', () => {
    // 120 000 cm³ ÷ 1 000 000 = 0.12 m³.
    for (const header of ['Volume (cm3)', 'Volume, cm³', '体积(cm³)', 'Объем (см3)', 'Объем, куб.см', 'Hajmi (sm3)', 'Volume cm3', '体积（立方厘米）']) {
      expect(volume(header, 120000), header).toBe(0.12);
    }
  });

  it('cubic decimetres and litres are divided by a thousand', () => {
    // 250 dm³ = 250 l = 0.25 m³.
    for (const header of ['Объем, дм3', 'Volume (dm3)', 'Объем, л', 'Объём (литр)', 'Volume (L)', 'Hajmi (litr)', 'Объём в литрах', 'Volume / L', '体积(升)']) {
      expect(volume(header, 250), header).toBe(0.25);
    }
  });

  it('cubic metres stay cubic metres — the unit part names them, or names no unit', () => {
    for (const header of ['CBM', 'Volume (CBM)', 'MEAS.(CBM)', 'Объем, м3', 'Общий объём, м³', 'Hajmi (m3)', '体积(m³)', 'Объем (куб.м)', 'Объем, м.куб', 'Volume (total)', 'Объем (всего)', 'Hajmi (jami)', 'Volume/m3']) {
      expect(volume(header, 1.2), header).toBe(1.2);
    }
  });

  it('a unit nobody converts refuses the column: no volume, the figure on the note', () => {
    for (const header of ['Volume (ft3)', 'Volume (cu.ft)', 'CBM (cm)', 'Volume, ml', 'Объем (мл)', 'Volume (inch)', 'Hajmi (sm)']) {
      const row = first(['Description', 'Qty', header], ['Chair', 10, 42]);
      expect(row.volumeM3, header).toBeNull();
      expect(row.note, header).toBe(`«${header}»: 42`);
    }
  });

  it('on the abbreviation rung a litre and a millilitre stay a bottle’s own (the corpus’ c1936, c1937)', () => {
    for (const header of ['Vol (L)', 'Vol, ml', 'MEAS (L)']) expect(volume(header, 4), header).toBeNull();
  });

  it('a column in cubic metres outranks a converted one, wherever each stands', () => {
    // «Volume (cm3)» 120000 would be 0.12; the «CBM» beside it says 1.2.
    expect(first(['Description', 'Volume (cm3)', 'CBM'], ['Chair', 120000, 1.2]).volumeM3).toBe(1.2);
    expect(first(['Description', 'CBM', 'Volume (cm3)'], ['Chair', 1.2, 120000]).volumeM3).toBe(1.2);
    // …and a «MEAS.» with no unit outranks it too, though it is the weaker rung.
    expect(first(['Description', 'Volume (cm3)', 'MEAS.'], ['Chair', 120000, 1.2]).volumeM3).toBe(1.2);
  });

  it('a converted figure says what the file wrote, and a glued unit is not guessed at', () => {
    expect(first(['Description', 'Qty', 'Volume (cm3)'], ['Chair', 10, 120000]).note).toBe('«Volume (cm3)»: 120000');
    const glued = first(['Description', 'Qty', 'Объем, л'], ['Бак', 10, '250 л']);
    expect(glued.volumeM3).toBeNull();
    expect(glued.note).toContain('hajm «250 л» — aniq emas');
  });

  it('the sheet’s own TOTAL row is read in the column’s unit: it agrees with the converted Σ, or refuses it', () => {
    // 120000 + 60000 = 180000 cm³ = 0.18 m³: the TOTAL row says the same.
    const agrees = sheet(['Description', 'Qty', 'G.W.', 'Volume (cm3)'], ['Jacket', 200, 120, 120000], ['Toy', 480, 260, 60000], ['TOTAL', 680, 380, 180000]);
    expect(agrees.volumeM3).toBe(0.18);
    // …and 3 800 000 cm³ (3.8 m³) against a 0.18 m³ Σ is a contradiction: no Σ.
    const refuses = sheet(['Description', 'Qty', 'G.W.', 'Volume (cm3)'], ['Jacket', 200, 120, 120000], ['Toy', 480, 260, 60000], ['TOTAL', 680, 380, 3800000]);
    expect(refuses.volumeM3).toBeNull();
    expect(refuses.goods.map((g) => g.volumeM3)).toEqual([0.12, 0.06]);
  });

  it('volumetric kilos and a density are neither the cube nor the weight', () => {
    const headers = ['Объемный вес, кг', 'Объёмный вес', 'Volume weight (kg)', 'Volumetric weight', 'Chargeable weight (kg)', '体积重', 'Плотность, кг/м3'];
    // …the words the other way round, the abbreviation, and the two Chinese forwarders write.
    headers.push('Вес объемный', 'Масса объёмная, кг', 'Vol. weight', 'VOL WT (KG)', '体积重量', '抛重 (kg)', '计费重量(KG)');
    for (const header of headers) {
      const row = first(['Description', 'Qty', header, 'G.W. (kg)', 'CBM'], ['Jacket', 300, 200, 150, 1.2]);
      // 150 is the gross column's; 200 — the heavier «plain» candidate — is the carrier's.
      expect([row.weightKg, row.volumeM3], header).toEqual([150, 1.2]);
      expect(row.note, header).toBe(`«${header}»: 200`);
    }
  });

  it('a real weight beside a real volume is untouched', () => {
    const row = first(['Наименование', 'Кол-во', 'Вес, кг', 'Объем, м3'], ['Куртка', 300, 150, 1.2]);
    expect([row.weightKg, row.volumeM3, row.note]).toEqual([150, 1.2, null]);
  });
});

describe('X0 — a sheet handed to the model keeps its columns (CR-1, review JN-14)', () => {
  /** One sheet «S» as the model is handed it, with the header row the column reader found (or none). */
  const textOf = (rows: Cell[][], headerRow: number | null = null, covered?: CoverMask, budget?: number) =>
    sheetsAsText([{ sheet: { name: 'S', rows, ...(covered ? { covered } : {}) }, headerRow }], budget);
  /** The lines under the «[S]» heading. */
  const linesOf = (text: string) => text.split('\n').slice(1);
  /** A line's cells: split on its «|», each trimmed. */
  const cellsOf = (line: string) => line.split('|').map((cell) => cell.trim());
  /** The text as it was written before X0: every line's empty cells taken out. */
  const squeezed = (text: string) =>
    text
      .split('\n')
      .map((line, i) => (i === 0 ? line : cellsOf(line).filter(Boolean).join(' | ')))
      .join('\n');
  const coveredAt = (...at: [row: number, col: number][]) => {
    const mask = new CoverMask();
    for (const [r, c] of at) mask.add(r, c);
    return mask;
  };

  // The critic's «PL-2611.xlsx»: the N.W. blank on one line and on the TOTAL, the CBM on another.
  const CRITIC: Cell[][] = [
    ['Description', 'QTY (PCS)', 'CTNS', 'N.W. (KG)', 'G.W. (KG)', 'CBM'],
    ['Folding chair', 480, 20, 280, 300, 2.4],
    ['Office chair', 120, 10, null, 150, 1.2],
    ['Bar stool', 60, 5, 70, 80, null],
    ['TOTAL', 660, 35, null, 530, 3.6],
  ];
  const CRITIC_LINES = [
    'Description | QTY (PCS) | CTNS | N.W. (KG) | G.W. (KG) | CBM',
    'Folding chair | 480 | 20 | 280 | 300 | 2.4',
    'Office chair | 120 | 10 |  | 150 | 1.2',
    'Bar stool | 60 | 5 | 70 | 80 |',
    'TOTAL | 660 | 35 |  | 530 | 3.6',
  ];

  it('an empty cell is an empty slot: every line has the header’s cell count, and the cube stays under «CBM»', () => {
    const { text, rowsCut, cellsCut } = textOf(CRITIC, 0);
    expect(text).toBe(`[S]\n${CRITIC_LINES.join('\n')}`);
    expect([rowsCut, cellsCut]).toEqual([false, false]);
    const lines = linesOf(text);
    for (const line of lines) expect(cellsOf(line), line).toHaveLength(6);
    // Was «TOTAL | 660 | 35 | 530 | 3.6»: 530 under N.W., 3.6 under G.W., nothing under CBM.
    expect(cellsOf(lines[4]!)).toEqual(['TOTAL', '660', '35', '', '530', '3.6']);
    expect(cellsOf(lines[0]!)[5]).toBe('CBM');
  });

  it('…and that is the text a packing list’s own sheet reaches the model with (`ownText`)', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sheet1').addRows(CRITIC);
    const read = await readGoodsFile(Buffer.from(await workbook.xlsx.writeBuffer()), null);
    if (read?.kind !== 'goods') throw new Error(`not goods: ${read?.kind}`);
    expect(read.shape).toBe('packing');
    expect(read.ownText?.text).toBe(`[Sheet1]\n${CRITIC_LINES.join('\n')}`);
  });

  it('the judge’s fixture: a blank first cell, a first column merged down three rows, a TOTAL labelled in column B', () => {
    // Σ by hand: 480 + 120 + 60 + 30 = 690 pcs; 20 + 10 + 5 = 35 ctns; 300 + 150 + 80 + 40 = 570 kg; 2.4 + 1.2 + 0.9 = 4.5 m³.
    const rows: Cell[][] = [
      ['Factory', 'No.', 'Description', 'QTY', 'CTNS', 'G.W. (KG)', 'CBM'],
      ['Yiwu Plant 1', 1, 'Folding chair', 480, 20, 300, 2.4],
      ['Yiwu Plant 1', 2, 'Office chair', 120, 10, 150, 1.2],
      ['Yiwu Plant 1', 3, 'Bar stool', 60, 5, 80, 0.9],
      [null, null, 'Bar stool, spare seats', 30, null, 40, null],
      [null, 'TOTAL', null, 690, 35, 570, 4.5],
    ];
    // The readers repeat a merged cell's value down its column and say where (A2:A4).
    const lines = linesOf(textOf(rows, 0, coveredAt([2, 0], [3, 0])).text);
    expect(lines).toEqual([
      'Factory | No. | Description | QTY | CTNS | G.W. (KG) | CBM',
      'Yiwu Plant 1 | 1 | Folding chair | 480 | 20 | 300 | 2.4',
      // A merged NAME is still repeated on the lines it covers (the fourth review).
      'Yiwu Plant 1 | 2 | Office chair | 120 | 10 | 150 | 1.2',
      'Yiwu Plant 1 | 3 | Bar stool | 60 | 5 | 80 | 0.9',
      '|  | Bar stool, spare seats | 30 |  | 40 |',
      '| TOTAL |  | 690 | 35 | 570 | 4.5',
    ]);
    for (const line of lines) expect(cellsOf(line), line).toHaveLength(7);
  });

  it('a merge’s covered FIGURE is an empty slot where it stands — never left out', () => {
    const rows: Cell[][] = [
      ['Chair', '5 pcs', '160 kg', 'A'],
      ['Stool', '3 pcs', '160 kg', 'B'],
    ];
    // Was «Stool | 3 pcs | B»: the mark under the weight.
    expect(linesOf(textOf(rows, null, coveredAt([1, 2])).text)).toEqual(['Chair | 5 pcs | 160 kg | A', 'Stool | 3 pcs |  | B']);
  });

  describe('a column only its header names is dropped, header cell and all', () => {
    it('on a sheet nobody mapped: a PICTURE header over a row of figures', () => {
      const rows: Cell[][] = [
        ['图片', '型号', '数量', '毛重(KG)'],
        [null, 'XJ-200', 480, 300],
        [null, 'XJ-350', 120, 150],
      ];
      expect(linesOf(textOf(rows).text)).toEqual(['型号 | 数量 | 毛重(KG)', 'XJ-200 | 480 | 300', 'XJ-350 | 120 | 150']);
      for (const head of ['Picture', 'PHOTO', 'Product picture', '产品图片', 'Фото', 'Фото товара', 'Rasmi']) {
        expect(linesOf(textOf([[head, ...rows[0]!.slice(1)], ...rows.slice(1)]).text)[0], head).toBe('型号 | 数量 | 毛重(KG)');
      }
    });

    it('on a mapped sheet: whatever the reader’s OWN header row heads over nothing', () => {
      const rows: Cell[][] = [
        ['Remark', 'Description', 'CTNS'],
        [null, 'Chair', 5],
        [null, 'Table', 8],
      ];
      expect(linesOf(textOf(rows, 0).text)).toEqual(['Description | CTNS', 'Chair | 5', 'Table | 8']);
      // …with no header known it is not guessed at: the column keeps its heading and its empty slots.
      expect(linesOf(textOf(rows, null).text)).toEqual(['Remark | Description | CTNS', '| Chair | 5', '| Table | 8']);
      // Not even over a row of figures: only a PICTURE heading is taken for one there.
      const unmapped: Cell[][] = [
        ['备注', '型号', '数量', '毛重(KG)'],
        [null, 'XJ-200', 480, 300],
      ];
      expect(linesOf(textOf(unmapped).text)).toEqual(['备注 | 型号 | 数量 | 毛重(KG)', '| XJ-200 | 480 | 300']);
    });

    it('…and the door hands the writer that header row: a packing list’s own text loses its empty «Remark» column', async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('PL').addRows([
        ['Remark', 'Description', 'CTNS', 'G.W. (KG)'],
        [null, 'Chair', 5, 50],
        [null, 'Table', 8, 96],
      ]);
      const read = await readGoodsFile(Buffer.from(await workbook.xlsx.writeBuffer()), null);
      if (read?.kind !== 'goods') throw new Error(`not goods: ${read?.kind}`);
      expect(read.ownText?.text).toBe('[PL]\nDescription | CTNS | G.W. (KG)\nChair | 5 | 50\nTable | 8 | 96');
    });

    it('a header cell merged down a two-row header goes with its repeats', () => {
      const rows: Cell[][] = [
        ['Picture', 'Description', 'G.W. (KG)'],
        ['Picture', '(name)', '(total)'],
        [null, 'Chair', 300],
      ];
      expect(linesOf(textOf(rows, 0, coveredAt([1, 0])).text)).toEqual(['Description | G.W. (KG)', '(name) | (total)', 'Chair | 300']);
    });
  });

  describe('what stands alone in its column and is no header’s cell is content, and stays', () => {
    it('the one remark of a names-only list', () => {
      expect(textOf([['Chair', 'wooden', 'fragile'], ['Table', 'oak']]).text).toBe('[S]\nChair | wooden | fragile\nTable | oak |');
    });

    it('a picture word on a line that carries figures — «see the photo» — or over no figures at all', () => {
      const remark: Cell[][] = [
        ['型号', '数量', '毛重(KG)'],
        ['XJ-200', 480, 300, '图片'],
      ];
      expect(linesOf(textOf(remark).text)).toEqual(['型号 | 数量 | 毛重(KG) |', 'XJ-200 | 480 | 300 | 图片']);
      const names: Cell[][] = [
        ['Picture', 'Frame', 'wooden'],
        [null, 'Mirror', 'oval'],
      ];
      expect(linesOf(textOf(names).text)).toEqual(['Picture | Frame | wooden', '| Mirror | oval']);
    });

    it('a letterhead’s «label: | value» line, a paragraph, a cell beside another header’s', () => {
      const rows: Cell[][] = [
        ['Photo:', 'attached', 'Buyer:', 'GSR LOGISTICS'],
        ['型号', '数量', '毛重(KG)'],
        ['XJ-200', 480, 300],
      ];
      expect(linesOf(textOf(rows).text)[0]).toBe('Photo: | attached | Buyer: | GSR LOGISTICS');
    });
  });

  it('a row with nothing in any kept column is no line, and no line carries white space at either end', () => {
    const rows: Cell[][] = [['a', 'b', 'c'], [null, '  ', null], [], [null, null, 'z'], ['x']];
    const { text } = textOf(rows);
    expect(text).toBe('[S]\na | b | c\n|  | z\nx |  |');
    // A caller's trim of the whole text (the collector's, `sheetsPromptText`'s) changes nothing.
    expect(text.trim()).toBe(text);
    for (const line of text.split('\n')) expect(line.trim()).toBe(line);
  });

  it('a line opening with an empty slot is still one ROW to the fitter', () => {
    // The heading is no row; «| TOTAL |  | 5» is one.
    expect(fitSheetRows(['[S]\na | b | c\n| TOTAL |  | 5'], 1_000)).toEqual({ kept: [2], total: [2] });
  });

  describe('a line’s own cap (2,000 characters, whole cells)', () => {
    const long = (i: number) => `${'Ж'.repeat(288)} ${i}`; // 290 characters each

    it('a row too long for it loses its tail, and the text says cells were cut', () => {
      const { text, cellsCut } = textOf([Array.from({ length: 8 }, (_, i) => long(i))]);
      // Six cells and their five separators: 6 × 290 + 5 × 3 = 1,755; a seventh would make 2,048.
      expect(linesOf(text)[0]!.length).toBe(1_755);
      expect(cellsCut).toBe(true);
    });

    it('a row that only runs out of EMPTY slots has lost nothing, and nothing is said', () => {
      const header = Array.from({ length: 100 }, (_, i) => `c${i}`);
      const { text, cellsCut } = textOf([header, Array.from({ length: 6 }, (_, i) => long(i))]);
      const line = linesOf(text)[1]!;
      // 1,755 for the six cells; each empty slot costs 3: 81 of the 94 fit (1,755 + 243 = 1,998, the 82nd would make 2,001).
      expect(cellsOf(line)).toHaveLength(6 + 81);
      expect(cellsOf(line).slice(0, 6)).toEqual(Array.from({ length: 6 }, (_, i) => long(i)));
      expect(cellsCut).toBe(false);
    });
  });

  describe('what the slots cost the model’s budget (review JB-19)', () => {
    // The widest sheet the corpus holds: c0215's packing list — thirteen columns under a ten-line letterhead.
    const c0215 = readGoodsFileCases.find((c) => c.id === 'c0215')!.input;
    if (c0215.kind !== 'xlsx') throw new Error('c0215 is an xlsx');
    const sheet = c0215.sheets[0]!;
    const rows = typeof sheet.rows === 'function' ? sheet.rows() : sheet.rows!;
    const whole = sheetsAsText([{ sheet: { name: sheet.name, rows }, headerRow: 12 }], Number.MAX_SAFE_INTEGER).text;

    it('a dense table pays only for its letterhead and its TOTAL row: 276 characters on c0215’s 130 lines', () => {
      // An empty slot is 3 characters (« | »), less the 1 of white space trimmed when a line ends on one.
      // Thirteen kept columns. The four one-cell lines (company, address, TEL, «PACKING LIST»): 12 slots each, 36 − 1 = 35 → 140.
      // «To: | GSR …» and «Shipping marks: | GS777»: 11 slots, 33 − 1 = 32 → 64. «Invoice No: …» and «From: …»: 9 slots, 27 − 1 = 26 → 52.
      // The header and the 130 lines are full. TOTAL: 6 of 13 cells written, 7 slots, 21 − 1 = 20.
      // 140 + 64 + 52 + 20 = 276.
      expect(whole.length - squeezed(whole).length).toBe(276);
      expect(linesOf(whole).filter((line) => cellsOf(line).length !== 13)).toEqual([]);
    });

    it('…so at the model’s budget the list is cut at most two lines earlier than it was', () => {
      // Every goods line is over 138 characters (its 13 cells: a 44-character name among them), so 276 is under two of them.
      const shown = (text: string) => {
        let used = 0;
        let n = 0;
        for (const line of text.split('\n')) {
          if (used + line.length + (n > 0 ? 1 : 0) > SHEET_TEXT_BUDGET) break;
          used += line.length + (n > 0 ? 1 : 0);
          n += 1;
        }
        return n;
      };
      const cut = sheetsAsText([{ sheet: { name: sheet.name, rows }, headerRow: 12 }]);
      expect(cut.rowsCut).toBe(true);
      const now = cut.text.split('\n').length;
      const before = shown(squeezed(whole));
      expect(now).toBe(shown(whole));
      expect(before - now).toBeGreaterThanOrEqual(0);
      expect(before - now).toBeLessThanOrEqual(2);
    });
  });
});

describe('X1 — «PKGS» is not kilos: the unit is a word, never a substring (XLS-3)', () => {
  /** The line of a sheet whose third column is headed `header`, beside a gross-weight column. */
  const beside = (header: string) => first(['Description', 'Qty', header, 'G.W. (KG)'], ['Chair', 100, 10, 120]);

  it('a header with «kg» INSIDE a word is no weight: the gross column beside it is the line’s', () => {
    for (const header of ['PKGS', 'PKG', 'Pkgs.', 'NO. OF PKGS', 'Total PKGS', 'PKGS QTY', 'BKG NO', 'Background']) {
      // 120 is «G.W. (KG)»; 10 stood in the column the «kg» inside the word used to claim.
      expect(beside(header).weightKg, header).toBe(120);
    }
  });

  it('…and alone it gives the line no weight at all — the weight is asked, never 10 «kg»', () => {
    const row = first(['Description', 'Qty', 'PKGS'], ['Chair', 100, 10]);
    expect([row.quantity, row.weightKg]).toEqual([100, null]);
  });

  it('kilos as a WORD stay the weight, however a sheet spells them', () => {
    for (const header of ['KG', 'KGS', 'Kg', 'kgs.', 'кг', 'Кг.', 'KGM', 'Weight(KGS)', 'WEIGHT/KG', '重量KG', '总KG', 'Jami kg', '25 KG NET']) {
      const row = first(['Description', 'Qty', header], ['Chair', 100, 150]);
      expect(row.weightKg, header).toBe(150);
    }
  });

  it('a package count that names its package’s size is still a count, never a weight candidate', () => {
    for (const header of ['BAGS (25KG)', 'PKGS (KG)', 'CTNS 25KG', 'Мест (кг)', 'Мешков по 50 кг', 'Qoplar (50 kg)', 'Коробок, кг', '袋 (25KG)']) {
      expect(beside(header).weightKg, header).toBe(120);
      expect(first(['Description', 'Qty', header], ['Chair', 100, 10]).weightKg, header).toBeNull();
    }
  });

  it('…while a WEIGHT that mentions its packages stays one', () => {
    for (const header of ['Вес мест, кг', 'Gross weight of packages (kg)', 'Bag weight, kg', 'Weight of cartons', 'Karobkalar vazni']) {
      expect(first(['Description', 'Qty', header], ['Chair', 100, 150]).weightKg, header).toBe(150);
    }
  });

  it('«TOTAL PKGS» is not the line’s money either, and the sheet is still a packing list', () => {
    const read = sheet(['Description', 'TOTAL QTY', 'TOTAL PKGS', 'TOTAL G.W.'], ['Chair', 100, 10, 120]);
    expect([read.goods[0]!.amount, read.goods[0]!.weightKg, read.shape]).toEqual([null, 120, 'packing']);
  });

  it('a net column named by «NET» and the unit word is still the net weight (S6)', () => {
    const read = sheet(['Description', 'Qty', 'GROSS (KG)', 'NET (KG)'], ['Chair', 100, 120, 110]);
    // The line's weight is the netto 110; the sheet's brutto the 120 beside it.
    expect([read.goods[0]!.weightKg, read.weightKind, read.grossKg]).toEqual([110, 'net', 120]);
  });
});

describe('X7 — the cube and weight headers nobody mapped (XLS-7, XLS-8)', () => {
  /** A line under `Description | Qty | CTNS | <header>`: its figure there is 42. */
  const under = (header: string) => first(['Description', 'Qty', 'CTNS', header], ['Chair', 100, 10, 42]);

  it('a cube by any of its names is the line’s volume', () => {
    for (const header of ['方数', '总方数', 'CUBE', 'Cube (m3)', 'Cubes', 'Cubage', 'Cubic meter', 'CUBIC METERS', 'Cubic metre', 'CU.M', 'CU. M', 'CU M', 'CU.MTS', 'CMB', 'CUBM', 'Total CUBM', 'TOTAL CUBE']) {
      const row = under(header);
      expect([row.volumeM3, row.amount, row.weightKg], header).toEqual([42, null, null]);
    }
  });

  it('…and what only looks like one is not', () => {
    // Square metres counted («平方数»), cubic FEET, a cumulative count, and words «cub» / «cmb» are merely inside.
    for (const header of ['平方数', 'Cubic feet', 'CUBIC FT', 'CUM', 'Cum. total', 'Cuba', 'Incubator', 'CMBS']) {
      expect(under(header).volumeM3, header).toBeNull();
    }
    // «Cube (ft)» names a cube in a unit nobody converts: refused, and said (X6).
    const feet = under('Cube (ft)');
    expect([feet.volumeM3, feet.note]).toEqual([null, '«Cube (ft)»: 42']);
  });

  it('a weight by its abbreviation or as «mass» is the line’s weight', () => {
    for (const header of ['GW', 'G/W', 'G / W', 'GW(KG)', 'GW/KGS', '总GW', 'NW', 'N/W', 'NW (KG)', 'T.W', 'T/W', 'T.W.(KG)', 'Масса', 'Масса, кг', 'Общая масса', 'Massa', 'Massasi (kg)', '总重', '公斤', '重量(公斤)']) {
      expect(under(header).weightKg, header).toBe(42);
    }
  });

  it('…as the kind it says: «GW» gross, «NW» net, the rest plain', () => {
    const kind = (header: string) => sheet(['Description', 'Qty', header], ['Chair', 100, 42]).weightKind;
    for (const header of ['GW', 'G/W', 'GW(KG)', '总GW']) expect(kind(header), header).toBe('gross');
    for (const header of ['NW', 'N/W', 'NW (KG)']) expect(kind(header), header).toBe('net');
    for (const header of ['T.W', 'Масса', 'Massa', '总重', '公斤']) expect(kind(header), header).toBe('plain');
  });

  it('…and letters that only look like the abbreviation are not', () => {
    // A serial number and a warehouse, Taiwan, a part number's letters, a solid-wood column.
    for (const header of ['S/N W/H', 'TW', 'NWT-200', 'GWP', 'Массив', 'Massaj']) {
      expect(under(header).weightKg, header).toBeNull();
    }
  });

  it('«NW | GW» in either order: the line is the NET, the shipment’s brutto the Σ of the GW column (XLS-8)', () => {
    // Netto 110 and 240; brutto 120 + 260 = 380.
    for (const [a, b] of [['NW(KG)', 'GW(KG)'], ['NW', 'GW'], ['N/W', 'G/W']] as const) {
      const netFirst = sheet(['Description', 'Qty', a, b], ['Jacket', 200, 110, 120], ['Toy', 480, 240, 260]);
      expect([netFirst.goods.map((g) => g.weightKg), netFirst.weightKind, netFirst.grossKg], `${a} | ${b}`).toEqual([[110, 240], 'net', 380]);
      const grossFirst = sheet(['Description', 'Qty', b, a], ['Jacket', 200, 120, 110], ['Toy', 480, 260, 240]);
      expect([grossFirst.goods.map((g) => g.weightKg), grossFirst.weightKind, grossFirst.grossKg], `${b} | ${a}`).toEqual([[110, 240], 'net', 380]);
    }
  });

  it('a total that says it weighs or is a cube is never the line’s money, on an invoice either', () => {
    // «Unit price» alone makes the header an invoice's: a bare «Total …» there is money — unless it names a weight or a cube.
    const row = (header: string) => first(['Description', 'Qty', 'Unit price', header], ['Chair', 100, 6.5, 42]);
    // The unit price is all the money there is — 6.5, never 42 — and the 42 lands as what its header says.
    for (const header of ['Total GW', 'TOTAL N/W', 'Total T.W', 'Total масса']) {
      expect([row(header).amount, row(header).weightKg], header).toEqual([6.5, 42]);
    }
    for (const header of ['Total CUBM', 'TOTAL CUBE', 'Total 方数', 'Total cubic meters']) {
      expect([row(header).amount, row(header).volumeM3], header).toEqual([6.5, 42]);
    }
  });

  it('a SECOND cube column — the volume is already chosen — is still never the line’s money', () => {
    // «Total» is a money key; the first cube column took the volume, and the one left free must not become the sum.
    for (const [a, b] of [['CUBE', 'Total CUBE'], ['CBM', 'Total CUBM'], ['CU.M', 'Total cubic meters'], ['方数', 'Total 方数']] as const) {
      const row = first(['Description', 'Qty', a, b], ['Chair', 100, 0.5, 5]);
      expect([row.volumeM3, row.amount], `${a} | ${b}`).toEqual([0.5, null]);
    }
  });

  it('a per-package cube or weight under the new names is still nobody’s line figure', () => {
    for (const header of ['CUBE/CTN', '方数/箱', 'GW/CTN', 'NW/CTN', 'Масса 1 места']) {
      const row = under(header);
      expect([row.volumeM3, row.weightKg], header).toEqual([null, null]);
    }
  });
});
