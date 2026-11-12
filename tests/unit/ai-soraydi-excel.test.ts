import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { foldInvoice, packingCarries, packingFills, packingTotals, positionalFills } from '@/modules/platform/telegram/file-goods';
import { applyPacking, emptyPacking, type Packing } from '@/modules/wms/calc/carton-math';
import { invoiceFacts, landingItems } from '@/modules/wms/calc/intake';
import { fitSheetRows } from '@/modules/wms/calc/intake-ai';
import { pasteItems } from '@/modules/wms/calc/send-rows';
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

    it('…but a label|value card’s name line is no table header: the good’s name, alone in the value column, stays', () => {
      // The column reader reports the card's NAME line as its «header row».
      const card: Cell[][] = [
        ['Tovar nomi', 'Ayollar kurtkasi'],
        ['Izoh', null],
        ['Eslatma', null],
      ];
      expect(linesOf(textOf(card, 0).text)).toEqual(['Tovar nomi | Ayollar kurtkasi', 'Izoh |', 'Eslatma |']);
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

    it('…and a SPARSE size-run quotation pays for every slot: shown whole before, cut at 240 of 300 lines now (review excel-break-8)', () => {
      // The commonest Chinese shoe and clothing quotation, which no header the reader maps (it goes to the
      // model as text): «Article | Color | 35 … 46 | Total», three of the twelve sizes filled.
      const header: Cell[] = ['Article', 'Color', ...Array.from({ length: 12 }, (_, i) => String(35 + i)), 'Total'];
      const rows: Cell[][] = [header, ...Array.from({ length: 300 }, (_, i): Cell[] => [`XJ-${200 + i}`, 'Black', 10, 15, 20, ...Array<Cell>(9).fill(null), 45])];
      const now = textOf(rows);
      const whole = textOf(rows, null, undefined, Number.MAX_SAFE_INTEGER).text;
      // By hand. A goods line before X0: «XJ-200 | Black | 10 | 15 | 20 | 45» = 6 + 5 + 4 × 2 + 5 × 3 = 34.
      // Now: 15 cells, 14 separators — 6 + 5 + 4 × 2 + 14 × 3 = 61. The header: 7 + 5 + 12 × 2 + 5 + 14 × 3 = 83.
      // Whole: «[S]» (3) + 301 lines and their 301 newlines: 3 + 301 + 83 + 300 × 61 = 18,687 — before X0,
      // 3 + 301 + 83 + 300 × 34 = 10,587, under the 15,000 the model is shown.
      expect(whole.length).toBe(18_687);
      expect(squeezed(whole).length).toBe(10_587);
      expect(squeezed(whole).length).toBeLessThan(SHEET_TEXT_BUDGET);
      // At the budget: 3 + 1 + 83 = 87 for the heading and the header, then 62 a goods line —
      // 87 + 240 × 62 = 14,967 fits, a 241st makes 15,029. The text says rows were cut, and on the AI door a
      // goods sheet the model was not shown whole holds «✅» (`aiInputCut`). JN-14 binds the slots; the
      // budget — or a compact empty slot the header line explains — is the lead's call (stated under «open»).
      expect(now.rowsCut).toBe(true);
      expect(now.text.length).toBe(14_967);
      expect(linesOf(now.text)).toHaveLength(1 + 240);
      expect(linesOf(now.text).every((line) => cellsOf(line).length === 15)).toBe(true);
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
    // (Re-anchored in X5: the line's cube is the column with the LARGER Σ now, never the leftmost — so the first
    // column holds the larger figure, 5 against 0.5, and the «Total …» column is still the one left free.)
    for (const [a, b] of [['CUBE', 'Total CUBE'], ['CBM', 'Total CUBM'], ['CU.M', 'Total cubic meters'], ['方数', 'Total 方数']] as const) {
      const row = first(['Description', 'Qty', a, b], ['Chair', 100, 5, 0.5]);
      expect([row.volumeM3, row.amount], `${a} | ${b}`).toEqual([5, null]);
    }
  });

  it('a per-package cube or weight under the new names is still nobody’s line figure', () => {
    for (const header of ['CUBE/CTN', '方数/箱', 'GW/CTN', 'NW/CTN', 'Масса 1 места']) {
      const row = under(header);
      expect([row.volumeM3, row.weightKg], header).toEqual([null, null]);
    }
  });
});

/** A packing as the reader writes it: every figure empty but the ones the sheet states. */
const packed = (figures: Partial<Packing>): Packing => ({ ...emptyPacking('file'), ...figures });
/** The rows as the calc door lands them — the kernel's arithmetic done — each with the note the VED reads on the card. */
const landed = (header: Cell[], ...rows: Cell[][]) => {
  const facts = invoiceFacts(sheet(header, ...rows).goods);
  const items = landingItems({ goods: facts });
  return facts.map((g, i) => ({ ...g, landedNote: items[i]!.note }));
};

describe('X2 — the carton count is the row’s packing, never its pieces (XLS-9)', () => {
  it('a bare package header beside a piece column: the pieces stay the count, the cartons go to the packing', () => {
    // «QTY 100 | <header> 10 | G.W. 50»: 100 pieces in 10 cartons weighing 50 kg — nothing multiplied here.
    for (const header of ['CTNS', 'CTN', 'Cartons', 'PKGS', 'Packages', 'NO. OF CTNS', '箱数', '总箱数', 'Мест', 'Мест (кор)', 'Mesta', 'Korobka', 'Karobka', 'Quti', 'Коробок']) {
      const row = first(['Description', 'QTY', header, 'G.W.'], ['Chair', 100, 10, 50]);
      expect([row.quantity, row.unit, row.weightKg, row.packing], header).toEqual([100, null, 50, packed({ cartons: 10 })]);
    }
  });

  it('a COUNT header that counts packages is the packing’s too — and «件数» only beside a piece column', () => {
    for (const header of ['Кол-во мест', 'Количество коробок', 'Karobka soni', 'Joy soni', 'QTY (CTNS)', 'Qty of cartons', '件数']) {
      const row = first(['Description', 'QTY', header, 'G.W.'], ['Chair', 100, 10, 50]);
      expect([row.quantity, row.unit, row.packing], header).toEqual([100, null, packed({ cartons: 10 })]);
    }
    // «数量 | 件数»: the other column is the pieces, so 件 counts the packages here…
    const han = first(['品名', '数量', '件数', '毛重'], ['椅子', 100, 10, 50]);
    expect([han.quantity, han.packing]).toEqual([100, packed({ cartons: 10 })]);
    // …and alone it is the PIECES, as it always was (the corpus’ c1778, c2453): no packing at all.
    const alone = first(['Description', '件数', 'G.W.'], ['Chair', 10, 50]);
    expect([alone.quantity, alone.unit, alone.packing]).toEqual([10, null, undefined]);
  });

  it('the lone-column rule is the rank’s vocabulary: a package count standing alone lands as cartons, never as pieces', () => {
    // The reader keeps the count under the header’s own carton word (the deal import and the VED’s paste read
    // that); the calc door lands NO piece count and says the cartons once, as the packing.
    for (const [header, word] of [
      ['Karobka soni', 'karobka'],
      ['Joy soni', 'joy'],
      ['Кол-во мест', 'мест'],
      ['Количество коробок', 'коробок'],
      ['QTY (CTNS)', 'ctns'],
    ] as const) {
      const row = first(['Description', header, 'G.W.'], ['Chair', 10, 50]);
      expect([row.quantity, row.unit, row.packing], header).toEqual([10, word, packed({ cartons: 10 })]);
      const [fact] = landed(['Description', header, 'G.W.'], ['Chair', 10, 50]);
      expect([fact!.quantity, fact!.unit, fact!.weightKg, fact!.landedNote], header).toEqual([null, null, 50, '📦 10 karobka — fayldan']);
    }
    // …and beside the piece count, on EITHER side of it: «<header> 10 | Soni 200» is 200 pieces in 10 cartons. A
    // package word the rank did not know ranked as pieces, won by standing leftmost, and the 200 were on no row.
    for (const header of ['Karobka soni', 'Joy soni', 'Mesta soni', 'Korobka soni', 'Кол-во мест']) {
      for (const row of [
        first(['Tovar', header, 'Soni', 'Vazni'], ['Kurtka', 10, 200, 120]),
        first(['Tovar', 'Soni', header, 'Vazni'], ['Kurtka', 200, 10, 120]),
      ]) {
        expect([row.quantity, row.unit, row.packing], header).toEqual([200, null, packed({ cartons: 10 })]);
      }
    }
    // A bare header carries no quantity key: it never was a count, and its number stood on no row at all.
    for (const header of ['CTNS', 'Мест', '箱数']) {
      const row = first(['Description', header, 'G.W.'], ['Chair', 10, 50]);
      expect([row.quantity, row.unit, row.packing], header).toEqual([null, null, packed({ cartons: 10 })]);
      expect(landed(['Description', header, 'G.W.'], ['Chair', 10, 50])[0]!.landedNote, header).toBe('📦 10 karobka — fayldan');
    }
  });

  it('a carton’s NUMBER, a column of words and a word that merely holds «мест» count no cartons', () => {
    for (const [header, cell] of [
      ['CTN NO.', 7],
      ['Carton No.', 7],
      ['箱号', 7],
      ['№ места', 7],
      ['Packages', 'wooden case'],
      ['Вместимость', 7],
      ['Упаковка', 7],
      ['Packing', 'carton'],
    ] as [string, Cell][]) {
      const row = first(['Description', 'QTY', header, 'CBM'], ['Chair', 100, cell, 0.5]);
      expect([row.quantity, row.volumeM3, row.packing], header).toEqual([100, 0.5, undefined]);
    }
    // «Вес мест, кг» names the packages and is a WEIGHT: the 7 is kilos, and no carton count.
    const weight = first(['Description', 'QTY', 'Вес мест, кг', 'CBM'], ['Chair', 100, 7, 0.5]);
    expect([weight.weightKg, weight.packing]).toEqual([7, undefined]);
    // A bare package header is the carton column only when its cells ARE counts: a «Carton» column of SIZES is
    // none, and no row says «karobka soni «60x40x50» — aniq emas» about a size (the cells above hold no figure,
    // so they could not tell the guard from its absence; these can).
    const sizes = sheet(['Description', 'QTY', 'Carton', 'G.W.'], ['Chair', 100, '60x40x50', 50], ['Table', 50, '50x40x30', 30]).goods;
    expect(sizes.map((g) => [g.quantity, g.packing, g.note])).toEqual([
      [100, undefined, null],
      [50, undefined, null],
    ]);
  });

  it('the cell: a glued carton word and a thousands comma are read; a count that is no whole carton is SAID, never rounded', () => {
    const cell = (value: Cell) => first(['Description', 'QTY', 'CTNS', 'CBM'], ['Chair', 100, value, 0.5], ['Table', 50, 5, 0.25], ['Desk', 20, 2, 0.1]);
    for (const value of ['10 CTNS', '10ctns', '10 кор', '10箱']) expect(cell(value).packing, value).toEqual(packed({ cartons: 10 }));
    // A count is whole, so «1,500» under a carton header is fifteen hundred.
    expect(cell('1,500').packing).toEqual(packed({ cartons: 1500 }));
    for (const value of [2.5, 0, -3, '10 pcs', '10/12', '3 pallets'] as Cell[]) {
      const row = cell(value);
      expect([row.packing, row.note, row.quantity], String(value)).toEqual([undefined, `karobka soni «${value}» — aniq emas`, 100]);
    }
  });

  it('a cell of thousands of characters is no package header, however many package words it holds', () => {
    // A merged master repeated across a sheet (the corpus’ c1306, c1879) is text, not a header: asked of every such
    // cell the packing’s tests cost seconds (fayl-oqish-reader’s long-strings sheet: 2.9 s before them, 5 s with).
    const master = `CTNS CBM/CTN Carton size ${'x'.repeat(30_000)}`;
    const row = first(['Description', 'QTY', master, 'CBM'], ['Chair', 100, 10, 0.5]);
    expect([row.quantity, row.volumeM3, row.packing]).toEqual([100, 0.5, undefined]);
    // The longest header a real list writes is far inside the bound, and is read.
    const bilingual = first(['Description', 'QTY', 'Количество мест / Number of packages / 箱数', 'CBM'], ['Chair', 100, 10, 0.5]);
    expect([bilingual.quantity, bilingual.packing]).toEqual([100, packed({ cartons: 10 })]);
  });

  it('cartons stated once over two lines (a merged cell) stay on the line that states them', () => {
    // «Chair red 60 | 10 CTNS | 0.05» then «Chair blue 40» with both cells empty: ten cartons hold both colours.
    const rows = landed(['Description', 'QTY', 'CTNS', 'CBM/CTN'], ['Chair red', 60, 10, 0.05], ['Chair blue', 40, '', '']);
    // 10 × 0.05 = 0.5 m³, said once; the second line gains nothing — 0.5 m³ in all, never 1.
    expect(rows.map((g) => [g.quantity, g.volumeM3, g.packing?.cartons ?? null])).toEqual([
      [60, 0.5, 10],
      [40, null, null],
    ]);
    // …and as the FILE reader hands a real merge: the master’s value repeated into the covered cells, with the mask
    // that says which they are. The count is the first line’s alone; what one carton measures is every covered line’s.
    const mask = new CoverMask();
    mask.add(2, 2); // «CTNS» of the second line
    mask.add(2, 3); // «CBM/CTN» of the second line
    const merged = parseGoods([['Description', 'QTY', 'CTNS', 'CBM/CTN'], ['Chair red', 60, 10, 0.05], ['Chair blue', 40, 10, 0.05]], mask).goods;
    expect(merged.map((g) => g.packing)).toEqual([packed({ cartons: 10, m3PerCarton: 0.05 }), packed({ m3PerCarton: 0.05 })]);
    // Still 10 × 0.05 = 0.5 m³ in all — never two lines of ten cartons each.
    expect(invoiceFacts(merged).map((g) => g.volumeM3)).toEqual([0.5, null]);
  });
});

describe('X2 — what ONE carton measures, weighs and holds (XLS-4, DIM-7; review JR-1)', () => {
  const beside = (header: string, value: Cell = 0.05) => sheet(['Description', 'QTY', 'CTNS', header], ['Chair', 100, 10, value]);

  it('one carton’s cube is copied, the line’s own cube stays empty: the reader multiplies nothing', () => {
    for (const header of ['CBM/CTN', 'MEAS./CTN (CBM)', '单箱体积', '每箱体积', '体积/箱', 'Объем 1 места', 'Объём на 1 кор', 'CBM per carton']) {
      const row = beside(header).goods[0]!;
      expect([row.volumeM3, row.packing], header).toEqual([null, packed({ cartons: 10, m3PerCarton: 0.05 })]);
    }
    // The header’s own unit (X6): 50 000 cm³ ÷ 1 000 000 = 0.05 m³ a carton.
    expect(beside('Volume/ctn (cm3)', 50000).goods[0]!.packing).toEqual(packed({ cartons: 10, m3PerCarton: 0.05 }));
  });

  it('a PIECE’s cube, or a mark that may be either, is nobody’s: the cartons are kept and nothing is multiplied', () => {
    for (const header of ['CBM/PCS', 'CBM each', '单件体积', '体积/件']) {
      const row = beside(header).goods[0]!;
      expect([row.volumeM3, row.packing], header).toEqual([null, packed({ cartons: 10 })]);
      expect(landed(['Description', 'QTY', 'CTNS', header], ['Chair', 100, 10, 0.05])[0]!.volumeM3, header).toBeNull();
    }
  });

  it('one carton’s weight keeps the KIND its header names — and the sheet’s weight is of that kind', () => {
    const kinds: [string, 'gross' | 'net' | null, 'gross' | 'net' | 'plain'][] = [
      ['G.W./CTN', 'gross', 'gross'],
      ['毛重/箱', 'gross', 'gross'],
      ['单箱毛重', 'gross', 'gross'],
      ['Вес брутто 1 места', 'gross', 'gross'],
      ['G.W. per carton', 'gross', 'gross'],
      ['N.W./CTN', 'net', 'net'],
      ['净重/箱', 'net', 'net'],
      ['单箱净重', 'net', 'net'],
      ['Вес нетто 1 места', 'net', 'net'],
      ['KGS/CTN', null, 'plain'],
      ['Вес 1 места', null, 'plain'],
      ['Weight/ctn', null, 'plain'],
    ];
    for (const [header, kind, sheetKind] of kinds) {
      const parsed = beside(header, 12.5);
      expect([parsed.goods[0]!.weightKg, parsed.goods[0]!.packing, parsed.weightKind], header).toEqual([
        null,
        packed({ cartons: 10, kgPerCarton: 12.5, kgPerCartonKind: kind }),
        sheetKind,
      ]);
    }
    // One PIECE’s weight is no carton’s: no weight in the packing, and the sheet has no weight column at all.
    for (const header of ['G.W./PCS', '单重', '毛重/件']) {
      const parsed = beside(header, 12.5);
      expect([parsed.goods[0]!.packing, parsed.weightKind], header).toEqual([packed({ cartons: 10 }), null]);
    }
  });

  it('with both on the sheet the NET one is the packing’s; the gross is said on the note only where no line gross stands', () => {
    const both = first(['Description', 'QTY', 'CTNS', 'N.W./CTN', 'G.W./CTN'], ['Chair', 100, 10, 11, 12.5]);
    expect([both.packing, both.note]).toEqual([packed({ cartons: 10, kgPerCarton: 11, kgPerCartonKind: 'net' }), '«G.W./CTN»: 12.5']);
    // Beside the lines’ own «N.W.» and «G.W.» the per-carton gross is noise: the note stays empty.
    const totals = first(['Description', 'QTY', 'CTNS', 'N.W./CTN', 'G.W./CTN', 'N.W.', 'G.W.'], ['Chair', 100, 10, 11, 12.5, 110, 125]);
    expect([totals.weightKg, totals.note, totals.packing?.kgPerCartonKind]).toEqual([110, null, 'net']);
  });

  it('what one carton HOLDS is counted in the unit its header names (JR-1) — a pair is never a piece', () => {
    const holds: [string, Packing['perCartonUnit']][] = [
      ['PCS/CTN', undefined],
      ['QTY/CTN', undefined],
      ['шт в коробке', undefined],
      ['装箱数', undefined],
      ['入数', undefined],
      ['PRS/CTN', 'juft'],
      ['пар/кор', 'juft'],
      ['pairs per carton', 'juft'],
      ['Кол-во в коробке, пар', 'juft'],
      ['Soni (juft) har biri', 'juft'],
      ['双/箱', 'juft'],
      ['每箱双数', 'juft'],
      ['m²/ctn', 'm2'],
      ['m2/box', 'm2'],
      ['L/CTN', 'litr'],
    ];
    for (const [header, unit] of holds) {
      const row = first(['Description', 'CTNS', header, 'G.W.'], ['Shoes', 10, 12, 80]);
      expect([row.quantity, row.packing], header).toEqual([null, packed({ cartons: 10, pcsPerCarton: 12, ...(unit ? { perCartonUnit: unit } : {}) })]);
      // The door: 10 cartons × 12 = 120 — PIECES under a piece header, and the law’s measure under any other.
      const [fact] = landed(['Description', 'CTNS', header, 'G.W.'], ['Shoes', 10, 12, 80]);
      expect([fact!.quantity, fact!.measureUnit ?? null, fact!.measureQty ?? null], header).toEqual(unit ? [null, unit, 120] : [120, null, null]);
    }
  });

  it('a header naming no unit counts what the ROW counts in: «Unit: pairs» beside «QTY/CTN» is pairs a carton', () => {
    const header = ['Description', 'Unit', 'CTNS', 'QTY/CTN', 'G.W.'];
    expect(first(header, ['Shoes', 'pairs', 10, 12, 80]).packing).toEqual(packed({ cartons: 10, pcsPerCarton: 12, perCartonUnit: 'juft' }));
    // …and a row counting pieces keeps pieces.
    expect(first(header, ['Shoes', 'pcs', 10, 12, 80]).packing).toEqual(packed({ cartons: 10, pcsPerCarton: 12 }));
  });

  it('«QTY/CTNS» still counts the cartons themselves (FR-REGR-6) — and now multiplies the «PCS/CTN» beside it', () => {
    const header = ['Description', 'QTY/CTNS', 'PCS/CTN', 'G.W.'];
    const row = first(header, ['Shoes', 10, 12, 80]);
    expect([row.quantity, row.unit, row.packing]).toEqual([10, 'ctns', packed({ cartons: 10, pcsPerCarton: 12 })]);
    // 10 × 12 = 120 pieces: the carton count never lands as the pieces, the product does.
    const [fact] = landed(header, ['Shoes', 10, 12, 80]);
    expect([fact!.quantity, fact!.unit, fact!.landedNote]).toEqual([120, null, '📦 10 karobka · 12 dona/karobka — fayldan · soni hisoblangan: 10 × 12 = 120 dona']);
  });

  it('a per-carton cell the reader cannot use is said on the row, and nothing is multiplied from it', () => {
    const noted = (header: string, value: Cell, good: Cell) => sheet(['Description', 'QTY', 'CTNS', header], ['Chair', 100, 10, value], ['Table', 50, 5, good]).goods[0]!;
    // Litres under a cubic-metre header, a weight in pounds, a count in another unit, a zero: each kept as written.
    expect(noted('CBM/CTN', '50 l', 0.12).note).toBe('1 karobka hajmi «50 l» — aniq emas');
    expect(noted('CBM/CTN', 0, 0.12).note).toBe('1 karobka hajmi «0» — aniq emas');
    expect(noted('G.W./CTN', '12.5 lbs', 30).note).toBe('1 karobka og‘irligi «12.5 lbs» — aniq emas');
    expect(noted('PCS/CTN', '12 prs', 6).note).toBe('1 karobkadagi soni «12 prs» — aniq emas');
    for (const [header, value, good] of [['CBM/CTN', '50 l', 0.12], ['G.W./CTN', '12.5 lbs', 30], ['PCS/CTN', '12 prs', 6]] as const) {
      expect(noted(header, value, good).packing, header).toEqual(packed({ cartons: 10 }));
    }
    // A unit the cell glues on in the header’s own unit is read: «0.05 m3», «12.5 kg», a decimal comma.
    expect(noted('CBM/CTN', '0.05 m3', 0.12).packing).toEqual(packed({ cartons: 10, m3PerCarton: 0.05 }));
    expect(noted('CBM/CTN', '0,05', 0.12).packing).toEqual(packed({ cartons: 10, m3PerCarton: 0.05 }));
    expect(noted('G.W./CTN', '12.5 kg', 30).packing).toEqual(packed({ cartons: 10, kgPerCarton: 12.5, kgPerCartonKind: 'gross' }));
  });
});

describe('X3 — the size column, and whose size it is (XLS-5, DIM-6; review JN-11)', () => {
  const sized = (header: string, value: Cell = '60*40*50') => first(['Description', 'QTY', 'CTNS', header], ['Chair', 100, 10, value]);
  const size = (of: 'package' | 'product' | null, unit: 'cm' | 'mm' | 'm' | 'other' | null = null, sides: [number, number, number] = [60, 40, 50]) => ({
    l: sides[0],
    w: sides[1],
    h: sides[2],
    unit,
    of,
  });

  it('a header that names the PACKAGE gives the package’s size', () => {
    for (const header of ['Carton size', 'CTN SIZE', 'MEAS.', '外箱尺寸', '箱规', '包装尺寸', 'Размер коробки', 'Габариты коробки', 'Karobka o‘lchami', 'Box size', 'Packing size']) {
      const row = sized(header);
      expect([row.packing?.size, row.volumeM3], header).toEqual([size('package'), null]);
    }
  });

  it('a bare «size» says NOBODY’s — kept, never multiplied (a sofa’s «220×95×85» beside 30 cartons is no cube)', () => {
    for (const header of ['Size', 'Dimensions', 'Dimension', 'L*W*H', '尺寸', 'Размер', 'Габариты', 'O‘lchami']) {
      expect(sized(header).packing?.size, header).toEqual(size(null));
    }
    // The door computes nothing from it and the kernel’s doubt asks whose it is.
    const [sofa] = landed(['Description', 'QTY', 'CTNS', 'Size (cm)'], ['Sofa', 10, 30, '220*95*85']);
    expect([sofa!.volumeM3, sofa!.landedNote]).toEqual([null, '📦 30 karobka · o‘lcham (kimniki — aniq emas) 220×95×85 sm — fayldan']);
    const doubts = applyPacking({ quantity: 10, weightKg: null, volumeM3: null, packing: packed({ cartons: 30, size: size(null, 'cm', [220, 95, 85]) }) }).doubts;
    expect(doubts.map((d) => d.kind)).toEqual(['size_owner']);
  });

  it('a header that names the GOODS gives the product’s size: said on the card, multiplied by nothing', () => {
    for (const header of ['Product size', 'Размер товара', '产品尺寸']) expect(sized(header).packing?.size, header).toEqual(size('product'));
    expect(sized('Item size (cm)').packing?.size).toEqual(size('product', 'cm'));
    const [sofa] = landed(['Description', 'QTY', 'CTNS', 'Product size (cm)'], ['Sofa', 10, 30, '220*95*85']);
    expect([sofa!.volumeM3, sofa!.landedNote]).toEqual([null, '📦 30 karobka · tovar o‘lchami 220×95×85 sm — fayldan']);
  });

  it('the unit is the header’s, in any of its spellings — and one nobody converts stays «other»', () => {
    for (const [header, unit] of [
      ['CTN SIZE (CM)', 'cm'],
      ['MEAS (CM)', 'cm'],
      ['Размер коробки, см', 'cm'],
      ['CTN SIZE CM', 'cm'],
      ['Carton size (mm)', 'mm'],
      ['Carton size, м', 'm'],
      ['Carton size (inch)', 'other'],
    ] as const) {
      expect(sized(header).packing?.size, header).toEqual(size('package', unit));
    }
    expect(sized('L×W×H (cm)').packing?.size).toEqual(size(null, 'cm'));
  });

  it('…or the cell’s own, which outranks the header’s', () => {
    const cells: [string, ReturnType<typeof size>][] = [
      ['60*40*50', size('package')],
      ['60×40×50', size('package')],
      ['60X40X50', size('package')],
      ['60х40х50', size('package')], // a Cyrillic «х»
      ['L60 W40 H50', size('package')],
      ['60 x 40 x 50 cm', size('package', 'cm')],
      ['60*40*50 CM', size('package', 'cm')],
      ['600*400*500mm', size('package', 'mm', [600, 400, 500])],
      ['0.6*0.4*0.5m', size('package', 'm', [0.6, 0.4, 0.5])],
      ['60*40*50 inch', size('package', 'other')],
    ];
    for (const [value, expected] of cells) expect(sized('Carton size', value).packing?.size, value).toEqual(expected);
    // The header says millimetres, the cell says centimetres: the cell is what the row wrote.
    expect(sized('Carton size (mm)', '60*40*50cm').packing?.size).toEqual(size('package', 'cm'));
  });

  it('a cell that is no carton’s size — two sides, four, two sizes, inches in quotes, a word — is SAID and multiplies nothing', () => {
    for (const value of ['60*40', '60*40*50*2', '60*40*50cm / 62*42*52cm', '24"x16"x20"', '60-40-50', 'XL', 42] as Cell[]) {
      const [row] = landed(['Description', 'QTY', 'CTNS', 'Carton size'], ['Chair', 100, 10, value], ['Table', 50, 5, '60*40*50'], ['Desk', 20, 2, '80*60*40']);
      expect([row!.packing, row!.volumeM3, row!.landedNote], String(value)).toEqual([
        packed({ cartons: 10 }),
        null,
        `o‘lcham «${value}» — aniq emas · 📦 10 karobka — fayldan`,
      ]);
    }
  });

  it('a «Size» whose cells are no three sides is no size column: S / M / L and a tile’s «600x600» stay what they were', () => {
    const letters = sheet(['Description', 'Size', 'QTY', 'CTNS'], ['T-shirt', 'XL', 100, 10], ['T-shirt', 'M', 50, 5], ['Shoes', 42, 30, 3]);
    expect(letters.goods.map((g) => [g.packing?.size ?? null, g.note])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    const tiles = sheet(['Description', 'Size', 'QTY'], ['Tile', '600x600', 100], ['Tile', '300x600', 50]);
    expect(tiles.goods.map((g) => [g.packing, g.note])).toEqual([
      [undefined, null],
      [undefined, null],
    ]);
  });

  it('«MEAS.» whose cells are sizes is a size column, not a cube — and whose cells are cubes stays the cube', () => {
    const sizes = sheet(['Description', 'QTY', 'CTNS', 'MEAS.'], ['Chair', 100, 10, '60*40*50'], ['Table', 50, 5, '50x40x30']);
    expect(sizes.goods.map((g) => [g.volumeM3, g.packing?.size, g.note])).toEqual([
      [null, size('package'), null],
      [null, size('package', null, [50, 40, 30]), null],
    ]);
    const cubes = sheet(['Description', 'QTY', 'CTNS', 'MEAS.'], ['Chair', 100, 10, 0.5], ['Table', 50, 5, 0.25]);
    expect(cubes.goods.map((g) => [g.volumeM3, g.packing])).toEqual([
      [0.5, packed({ cartons: 10 })],
      [0.25, packed({ cartons: 5 })],
    ]);
    expect(cubes.volumeM3).toBe(0.75);
  });

  it('an L | W | H triplet is one size — in any order, in three languages, under the label that says whose', () => {
    const triplet = (header: Cell[], ...rows: Cell[][]) => sheet(header, ...rows).goods[0]!.packing?.size;
    // Bare sides say nobody’s; the unit is the headers’.
    expect(triplet(['Description', 'QTY', 'CTNS', 'L', 'W', 'H'], ['Chair', 100, 10, 60, 40, 50])).toEqual(size(null));
    expect(triplet(['Description', 'QTY', 'CTNS', 'L (cm)', 'W (cm)', 'H (cm)'], ['Chair', 100, 10, 60, 40, 50])).toEqual(size(null, 'cm'));
    expect(triplet(['Наименование', 'Кол-во', 'Мест', 'Длина, см', 'Ширина, см', 'Высота, см'], ['Стул', 100, 10, 60, 40, 50])).toEqual(size(null, 'cm'));
    // H | L | W: each side lands under its own letter, whatever the order.
    expect(triplet(['Description', 'QTY', 'CTNS', 'H (cm)', 'L (cm)', 'W (cm)'], ['Chair', 100, 10, 50, 60, 40])).toEqual(size(null, 'cm'));
    // «外箱长 / 宽 / 高»: the OUTER CARTON’s sides.
    expect(triplet(['品名', '数量', '箱数', '外箱长', '外箱宽', '外箱高'], ['椅子', 100, 10, 60, 40, 50])).toEqual(size('package'));
    // A two-row header: the label above says whose the three are.
    expect(triplet(['Description', 'QTY', 'CTNS', 'Carton size (cm)', '', ''], ['', '', '', 'L', 'W', 'H'], ['Chair', 100, 10, 60, 40, 50])).toEqual(size('package', 'cm'));
    expect(triplet(['Description', 'QTY', 'CTNS', 'Product size (cm)', '', ''], ['', '', '', 'L', 'W', 'H'], ['Chair', 100, 10, 60, 40, 50])).toEqual(size('product', 'cm'));
  });

  it('«N.W.» and «G.W.» end in a W and are no carton’s width; two sides of three are no size', () => {
    const weights = sheet(['Description', 'QTY', 'CTNS', 'N.W.', 'G.W.'], ['Chair', 100, 10, 45, 50]);
    expect([weights.goods[0]!.weightKg, weights.grossKg, weights.weightKind, weights.goods[0]!.packing]).toEqual([45, 50, 'net', packed({ cartons: 10 })]);
    expect(first(['Description', 'QTY', 'CTNS', 'L (cm)', 'W (cm)'], ['Chair', 100, 10, 60, 40]).packing).toEqual(packed({ cartons: 10 }));
    // «N.W.» standing BEFORE the real «W» does not take the width’s place (the corpus’ c1935: a 150 kg carton side).
    const mixed = first(['Description', 'QTY', 'CTNS', 'N.W.', 'L', 'W', 'H'], ['Chair', 100, 10, 45, 60, 40, 50]);
    expect([mixed.weightKg, mixed.packing]).toEqual([45, packed({ cartons: 10, size: size(null) })]);
  });

  it('a triplet with a side left empty is no size on that row: said as written, the other rows keep theirs', () => {
    const rows = sheet(['Description', 'QTY', 'CTNS', 'L (cm)', 'W (cm)', 'H (cm)'], ['Chair', 100, 10, 60, '', 50], ['Table', 50, 5, 60, 40, 50]).goods;
    expect(rows.map((g) => [g.packing?.size ?? null, g.note])).toEqual([
      [null, 'o‘lcham «60 x 50» — aniq emas'],
      [size(null, 'cm'), null],
    ]);
    // …even when the two cells left happen to hold three numbers: «60*40 | (empty) | 50» is not 60×40×50.
    const glued = sheet(['Description', 'QTY', 'CTNS', 'L (cm)', 'W (cm)', 'H (cm)'], ['Chair', 100, 10, '60*40', '', 50], ['Table', 50, 5, 60, 40, 50], ['Desk', 20, 2, 80, 60, 40]).goods[0]!;
    expect([glued.packing?.size ?? null, glued.note]).toEqual([null, 'o‘lcham «60*40 x 50» — aniq emas']);
  });
});

describe('X4 — the arithmetic is the kernel’s: a per-carton figure fills only what the line left empty', () => {
  it('cartons × one carton’s cube and weight: the line’s empty cells are filled, and the card says how', () => {
    const rows = landed(['Description', 'QTY', 'CTNS', 'CBM/CTN', 'G.W./CTN'], ['Chair', 100, 10, 0.05, 12.5], ['Table', 50, 5, 0.12, 30]);
    // 10 × 0.05 = 0.5 m³ and 10 × 12.5 = 125 kg; 5 × 0.12 = 0.6 m³ and 5 × 30 = 150 kg.
    expect(rows.map((g) => [g.quantity, g.volumeM3, g.weightKg])).toEqual([
      [100, 0.5, 125],
      [50, 0.6, 150],
    ]);
    expect(rows[0]!.landedNote).toBe(
      '📦 10 karobka · 0.05 m³/karobka · 12.5 kg/karobka (brutto) — fayldan · hajm hisoblangan: 10 × 0.05 m³ = 0.5 m³ · og‘irlik hisoblangan: 10 × 12.5 kg = 125 kg · og‘irlik brutto (karobka og‘irligidan)',
    );
    // A weight made of the cartons’ GROSS is marked: no later rule takes it for the line’s netto.
    expect(rows.map((g) => g.derived?.weightIsGross)).toEqual([true, true]);
  });

  it('cartons × the PACKAGE’s size: 10 × 60×40×50 cm = 1.2 m³', () => {
    // 0.6 × 0.4 × 0.5 = 0.12 m³ a carton; × 10 = 1.2 m³.
    const [row] = landed(['Description', 'QTY', 'CTNS', 'Carton size (cm)'], ['Chair', 100, 10, '60*40*50']);
    expect([row!.volumeM3, row!.landedNote]).toEqual([1.2, '📦 10 karobka · 60×40×50 sm — fayldan · hajm hisoblangan: 10 × 60×40×50 sm = 1.2 m³']);
    // No unit anywhere: centimetres are assumed, and the card says so.
    const [assumed] = landed(['品名', '数量', '箱数', '外箱长', '外箱宽', '外箱高'], ['椅子', 100, 10, 60, 40, 50]);
    expect([assumed!.volumeM3, assumed!.landedNote]).toEqual([1.2, '📦 10 karobka · 60×40×50 sm — fayldan · hajm hisoblangan: 10 × 60×40×50 sm = 1.2 m³, sm deb olindi']);
  });

  it('the line’s own figure STANDS: agreeing it is only annotated, disagreeing it is kept and doubted — never overwritten', () => {
    const header = ['Description', 'QTY', 'CTNS', 'CBM/CTN', 'CBM'];
    // 10 × 0.05 = 0.5 = the line’s own 0.5: nothing computed, nothing asked.
    const [agrees] = landed(header, ['Chair', 100, 10, 0.05, 0.5]);
    expect([agrees!.volumeM3, agrees!.derived, agrees!.landedNote]).toEqual([0.5, undefined, '📦 10 karobka · 0.05 m³/karobka — fayldan']);
    // The line says 0.7, the cartons 0.5: the LINE’s 0.7 lands, and the doubt carries both.
    const differs = sheet(header, ['Chair', 100, 10, 0.05, 0.7]);
    const [fact] = invoiceFacts(differs.goods);
    expect([fact!.volumeM3, differs.volumeM3]).toEqual([0.7, 0.7]);
    const row = differs.goods[0]!;
    const { doubts } = applyPacking({ quantity: row.quantity, weightKg: row.weightKg, volumeM3: row.volumeM3, packing: row.packing! });
    expect(doubts).toEqual([{ kind: 'differs', field: 'volumeM3', stated: 0.7, derived: { value: 0.5, how: '10 × 0.05 m³' } }]);
  });

  it('a line figure that is ONE carton’s (a sheet’s unmarked «CBM» beside its size) is replaced — and the sheet’s Σ of it is no total', () => {
    const header = ['Description', 'QTY', 'CTNS', 'Carton size (cm)', 'CBM'];
    const parsed = sheet(header, ['Chair', 100, 10, '60*40*50', 0.12], ['Table', 50, 5, '100*60*40', 0.24], ['TOTAL', 150, 15, '', 0.36]);
    // 60×40×50 cm = 0.12 m³ and 100×60×40 cm = 0.24 m³: each «CBM» cell is exactly its carton’s — the lines are
    // 10 × 0.12 = 1.2 and 5 × 0.24 = 1.2 m³. The reader keeps what the file wrote…
    expect(parsed.goods.map((g) => g.volumeM3)).toEqual([0.12, 0.24]);
    // …and refuses the column’s Σ (0.36, one carton of each) as the shipment’s cube: 2.4 m³ is the rows’.
    expect(parsed.volumeM3).toBeNull();
    const rows = landed(header, ['Chair', 100, 10, '60*40*50', 0.12], ['Table', 50, 5, '100*60*40', 0.24], ['TOTAL', 150, 15, '', 0.36]);
    expect(rows.map((g) => [g.volumeM3, g.derived?.replaced])).toEqual([
      [1.2, { volumeM3: 0.12 }],
      [1.2, { volumeM3: 0.24 }],
    ]);
    expect(rows[0]!.landedNote).toBe('📦 10 karobka · 60×40×50 sm — fayldan · hajm bitta karobkaniki edi (0.12): 10 × 60×40×50 sm = 1.2 m³');
  });

  it('…the weight alike: a «G.W.» cell equal to «G.W./CTN» is one carton’s, and the gross Σ beside it is refused', () => {
    const parsed = sheet(['Description', 'QTY', 'CTNS', 'G.W./CTN', 'G.W.'], ['Chair', 100, 10, 12.5, 12.5], ['Table', 50, 5, 30, 30]);
    // Σ of the column = 12.5 + 30 = 42.5 kg — one carton of each; the lines are 10 × 12.5 = 125 and 5 × 30 = 150.
    expect([parsed.grossKg, parsed.weightKind]).toEqual([null, 'gross']);
    expect(invoiceFacts(parsed.goods).map((g) => g.weightKg)).toEqual([125, 150]);
    // A gross column of its OWN beside a replaced netto is untouched: 125 is what the sheet says the order weighs.
    const separate = sheet(['Description', 'QTY', 'CTNS', 'N.W./CTN', 'N.W.', 'G.W.'], ['Chair', 100, 10, 11, 11, 125]);
    expect([separate.grossKg, invoiceFacts(separate.goods)[0]!.weightKg]).toEqual([125, 110]);
  });

  it('the line’s GROSS weight is never compared with its cartons’ NET: the row carries which weight its own is (JN-4)', () => {
    // «N.W./CTN 11 | G.W. 125»: 10 × 11 = 110 kg netto and 125 kg brutto are two facts, not a disagreement.
    const gross = sheet(['Description', 'QTY', 'CTNS', 'N.W./CTN', 'G.W.'], ['Chair', 100, 10, 11, 125]).goods[0]!;
    expect(gross.weightKind).toBe('gross');
    // The door hands the kernel the same word: the line’s 125 kg lands, and the card says which weight it is.
    const [fact] = landed(['Description', 'QTY', 'CTNS', 'N.W./CTN', 'G.W.'], ['Chair', 100, 10, 11, 125]);
    expect([fact!.weightKg, fact!.weightKind, fact!.landedNote]).toEqual([125, 'gross', 'og‘irlik brutto (netto yozilmagan) · 📦 10 karobka · 11 kg/karobka (netto) — fayldan']);
    expect(applyPacking({ quantity: gross.quantity, weightKg: gross.weightKg, volumeM3: gross.volumeM3, packing: gross.packing!, weightKind: gross.weightKind! }).doubts).toEqual([]);
    // The control: under a plain «Weight» nobody can say which it is, and 125 against 110 IS asked.
    const plain = sheet(['Description', 'QTY', 'CTNS', 'N.W./CTN', 'Weight'], ['Chair', 100, 10, 11, 125]).goods[0]!;
    expect(plain.weightKind).toBeUndefined();
    expect(applyPacking({ quantity: plain.quantity, weightKg: plain.weightKg, volumeM3: plain.volumeM3, packing: plain.packing! }).doubts).toEqual([
      { kind: 'differs', field: 'weightKg', stated: 125, derived: { value: 110, how: '10 × 11 kg' } },
    ]);
  });

  it('no carton count, no arithmetic: one carton’s figures alone are kept on the card and multiply nothing', () => {
    const [perCarton] = landed(['Description', 'QTY', 'CBM/CTN', 'G.W./CTN'], ['Chair', 100, 0.05, 12.5]);
    expect([perCarton!.volumeM3, perCarton!.weightKg, perCarton!.landedNote]).toEqual([null, null, '📦 0.05 m³/karobka · 12.5 kg/karobka (brutto) — fayldan']);
    const [sizeOnly] = landed(['Description', 'QTY', 'Carton size (cm)'], ['Chair', 100, '60*40*50']);
    expect([sizeOnly!.volumeM3, sizeOnly!.landedNote]).toEqual([null, '📦 60×40×50 sm — fayldan']);
  });

  it('a piece count equal to ONE carton’s is replaced; a differing one stands and is doubted', () => {
    const header = ['Description', 'QTY', 'CTNS', 'PCS/CTN'];
    // «QTY 12 | CTNS 10 | PCS/CTN 12»: the 12 is one carton’s — 10 × 12 = 120 pieces.
    const [one] = landed(header, ['Chair', 12, 10, 12]);
    expect([one!.quantity, one!.landedNote]).toEqual([120, '📦 10 karobka · 12 dona/karobka — fayldan · soni bitta karobkaniki edi (12): 10 × 12 = 120 dona']);
    const [agrees] = landed(header, ['Chair', 120, 10, 12]);
    expect([agrees!.quantity, agrees!.derived]).toEqual([120, undefined]);
    // 100 stated against 10 × 12 = 120: the sheet’s 100 lands.
    expect(landed(header, ['Chair', 100, 10, 12])[0]!.quantity).toBe(100);
  });

  it('a row with no packing is not touched: the door’s row is the reader’s', () => {
    const [row] = landed(['Description', 'QTY', 'G.W.', 'CBM'], ['Chair', 100, 50, 0.5]);
    expect([row!.quantity, row!.weightKg, row!.volumeM3, row!.packing, row!.derived, row!.landedNote]).toEqual([100, 50, 0.5, undefined, undefined, null]);
  });
});

describe('X4 — a weight made of the cartons’ gross beside another file (file-goods.ts)', () => {
  // A packing list whose lines state a NETTO, and one line only its cartons’ gross: «Table» is 5 × 30 = 150 kg
  // BRUTTO while the sheet’s weight column — and so the file’s kind — is net.
  const list = sheet(['Description', 'QTY', 'CTNS', 'N.W.', 'G.W./CTN'], ['Chair', 100, 10, 110, 12.5], ['Table', 50, 5, '', 30]);
  const listRows = invoiceFacts(list.goods);
  const invoice = () => invoiceFacts(sheet(['Description', 'QTY', 'Unit price', 'Amount'], ['Chair', 100, 5, 500], ['Table', 50, 9, 450]).goods);

  it('the fixture is what the comment says', () => {
    expect([list.shape, list.weightKind, list.grossKg]).toEqual(['packing', 'net', null]);
    expect(listRows.map((g) => [g.name, g.weightKg, g.derived?.weightIsGross ?? false])).toEqual([
      ['Chair', 110, false],
      ['Table', 150, true],
    ]);
  });

  it('a goods row with no weight takes the list’s NETTO — never a brutto the cartons made', () => {
    const filled = packingFills(invoice(), [null, null], listRows, 'net');
    expect([filled.filled, filled.goods.map((g) => g.weightKg)]).toEqual([1, [110, null]]);
  });

  it('…by position too (a Chinese list beside an English invoice)', () => {
    const han = invoiceFacts(sheet(['品名', '数量', '箱数', '净重', '毛重/箱'], ['椅子', 100, 10, 110, 12.5], ['桌子', 50, 5, '', 30]).goods);
    const filled = positionalFills(invoice(), han, 'net');
    expect([filled.filled, filled.goods.map((g) => g.weightKg)]).toEqual([1, [110, null]]);
  });

  it('the list’s netto Σ is offered only when every line’s weight IS a netto', () => {
    // 110 + 150 = 260 would add a brutto to a netto: no weight total at all.
    expect(packingTotals({ weightKind: list.weightKind, grossKg: list.grossKg, volumeM3: list.volumeM3, capped: false }, listRows)).toEqual({
      weightKg: null,
      weightNetto: false,
      volumeM3: null,
    });
    // A list of «N.W./CTN» alone: 10 × 11 = 110 and 5 × 28 = 140 are netto lines, Σ 250 kg, offered as a netto.
    const net = sheet(['Description', 'QTY', 'CTNS', 'N.W./CTN'], ['Chair', 100, 10, 11], ['Table', 50, 5, 28]);
    const netRows = invoiceFacts(net.goods);
    expect(packingTotals({ weightKind: net.weightKind, grossKg: net.grossKg, volumeM3: net.volumeM3, capped: false }, netRows)).toEqual({
      weightKg: 250,
      weightNetto: true,
      volumeM3: null,
    });
    // …and those netto lines reach an invoice’s empty weights — as the list’s PACKAGES, computed on the invoice’s
    // row by the kernel and marked as the bot’s (`packingCarries`, phase 4’s seam; re-anchored: the fill copied
    // the list row’s computed 110 / 140 as if the line stated them). The fill copies only a netto a line STATES.
    expect(packingFills(invoice(), [null, null], netRows, net.weightKind).goods.map((g) => g.weightKg ?? null)).toEqual([null, null]);
    const carried = packingCarries(invoice(), [null, null], netRows, net.weightKind, (row) => applyPacking(row).line);
    expect(carried.goods.map((g) => [g.weightKg, g.derived?.weightKg])).toEqual([
      [110, '10 × 11 kg'],
      [140, '5 × 28 kg'],
    ]);
  });

  it('the same row again in a second file, stating its GROSS: one order, landed once', () => {
    // File B writes «Table | G.W. 150» with no count: the only figure the two rows share is the weight, and it is
    // the same brutto — 5 × 30 = 150 here, 150 there.
    const second = invoiceFacts(sheet(['Description', 'G.W.', 'Unit price', 'Amount'], ['Table', 150, 9, 450]).goods);
    const folded = foldInvoice([listRows[1]!], ['net'], second, 'gross', 'b.xlsx');
    expect([folded.added, folded.goods.length, folded.notes]).toEqual([0, 1, ['📄 b.xlsx — 1 tasi ro‘yxatda bor edi, yangi tovar qo‘shilmadi.']]);
    // A different brutto is another line, kept and named for the VED.
    const other = invoiceFacts(sheet(['Description', 'G.W.', 'Unit price', 'Amount'], ['Table', 170, 9, 450]).goods);
    expect(foldInvoice([listRows[1]!], ['net'], other, 'gross', 'b.xlsx').added).toBe(1);
  });
});

describe('the doors that keep no packing: the reader’s own row stays whole for them', () => {
  it('the VED’s paste: a carton-only table still says the cartons in words — and «Karobka soni» is no piece count there either', () => {
    const [ctns] = pasteItems('Description\tQTY IN CTNS\tG.W.(KG)\tCBM\nKurtka\t10\t100\t1');
    expect([ctns!.quantity, ctns!.weightKg, ctns!.volumeM3, ctns!.note]).toEqual([null, 100, 1, 'sotuvchi: 10 ctns']);
    // Before X2 this lone column was the PIECES: ten cartons pasted as ten jackets.
    const [karobka] = pasteItems('Tovar nomi\tKarobka soni\tOg‘irligi (kg)\nKurtka\t10\t100');
    expect([karobka!.quantity, karobka!.weightKg, karobka!.note]).toEqual([null, 100, 'sotuvchi: 10 karobka']);
  });

  it('the VED’s paste computes nothing from a packing: the pieces stay, the per-carton cube is not multiplied there', () => {
    const [row] = pasteItems('Description\tQTY\tCTNS\tCBM/CTN\nKurtka\t100\t10\t0.05');
    expect([row!.quantity, row!.volumeM3, row!.note]).toEqual([100, null, null]);
  });
});
