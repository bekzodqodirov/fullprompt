import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Every mapped sheet of a workbook is judged (docs/FAYL-OQISH.md §4, his 2a
 * ⭐): «boshqa varaqdagi tovarlar BOSHQA ekani aniq ko‘rinsa, ular qo‘shiladi;
 * packing list varag‘i bo‘lsa, undan og‘irlik va kub olinadi; aniqlab
 * bo‘lmasa, hozirgidek qoladi va bot buni aytadi». Before, the sheet with the
 * most rows was the job and every other sheet was text the model was told not
 * to list: another factory's goods on «Zavod B» vanished with no word, and the
 * same goods' packing list gave its totals only if the model read them.
 *
 * Through the bot's own file door (`readIntakeFile`) onto a live collection,
 * the real reader and the real workbook files — what is under test is what the
 * bot does with the sheets, before any model.
 */

import { activeIntake, endIntake, pickGoods, fileLeftOutNote, sameAsInvoiceNote, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { PICTURES_LINE, promptFileLines, readIntakeFile, receiveSheetText, sheetTextLine } from '@/modules/platform/telegram/calc-files';
import { readGoodsFile, workbookRows } from '@/modules/wms/deals/goods-file';
import { otherName, positionalFills, provenOther, samePositions, sameWorkbookAgain } from '@/modules/platform/telegram/file-goods';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import type { AmendBase } from '@/modules/wms/calc/amend-types';
import * as B from '../fixtures/fayl-books';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

/** A ➕ collection's base: the request and the rows it already stores. */
function amendOf(items: Goods): AmendBase {
  return {
    requestId: '00000000-0000-4000-8000-00000000fb01',
    cardLabel: 'B-000777',
    entityType: 'deal',
    entityId: '00000000-0000-4000-8000-00000000fb02',
    leadOpen: null,
    section: 'rastamojka',
    door: 'ai',
    clientLabel: null,
    openedRev: 1,
    items: items.map((g, i) => ({
      itemId: `00000000-0000-4000-8000-0000000fc0${i}`,
      seq: i + 1,
      name: g.name,
      quantity: g.quantity ?? null,
      weightKg: g.weightKg ?? null,
      volumeM3: null,
      measureUnit: null,
      measureQty: null,
      tnvedCode: null,
      law: null,
      confirmed: false,
    })),
    weightKg: null,
    volumeM3: null,
    fromCity: null,
    toCity: null,
  };
}

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}, opts: { ai?: boolean } = {}) {
  seq += 1;
  const chatId = BigInt(-9_340_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-fayl', ai: opts.ai ?? true });
  updateIntake(chatId, { stage: 'material', ...patch });
  return chatId;
}
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

/** A file forwarded into the collection through the bot's own door, as every door applies it. */
async function forward(chatId: bigint, body: Buffer, name: string) {
  const live = activeIntake(chatId)!;
  const answer = await readIntakeFile({ isPhoto: false, body, attachmentId: `a-${name}-${live.fileCount}` }, name, B.XLSX, live);
  updateIntake(chatId, { ...answer.patch, fileCount: live.fileCount + 1 });
  return answer;
}
const rows = (chatId: bigint) => (activeIntake(chatId)!.invoiceGoods ?? []).map((g) => g.name);

const r1Book = (opts: { net?: boolean } = {}) =>
  B.bookOf((wb) => {
    B.englishInvoice(wb.addWorksheet('INVOICE'));
    B.chinesePacking(wb.addWorksheet('PACKING'), B.GOODS, opts);
  });
const K10_B = [B.B_KROSS, B.B_KEPKA];
const k10Book = (b: readonly B.Row[] = K10_B) => B.twoFactoryBook([B.A_KURTKA, B.A_SHIM, B.A_SUMKA], b);
const SAME_SENTENCE = '— o‘sha tovarlar deb olindi (faqat jami uchun o‘qildi); boshqa tovar bo‘lsa, alohida fayl qilib yuboring.';

describe('the reader hands every mapped sheet over (§4.1, sheets-07)', () => {
  it('the further mapped sheets are rows beside the goods; `text` is the sheets with NO header mapped', async () => {
    const body = await B.bookOf((wb) => {
      B.plainSheet(wb.addWorksheet('Zavod A'), B.INVOICE_HEAD, B.invoiceRows([B.A_KURTKA, B.A_SHIM, B.A_SUMKA]));
      B.plainSheet(wb.addWorksheet('Zavod B'), B.INVOICE_HEAD, B.invoiceRows(K10_B));
      wb.addWorksheet('Note').addRows([['Shipping mark: GS777'], ['TOTAL G.W.', '1592 KGS']]);
    });
    const read = await readGoodsFile(body, null);
    if (read?.kind !== 'goods') throw new Error(`not goods: ${read?.kind}`);
    expect(read.sheet).toBe('Zavod A');
    expect(read.moreSheets.map((m) => [m.sheet, m.shape, m.goods.map((g) => g.description)])).toEqual([
      ['Zavod B', 'invoice', ['Кроссовки мужские', 'Кепка бейсболка']],
    ]);
    expect(read.moreSheets[0]!.ownText.text).toContain('[Zavod B]');
    // The mapped «Zavod B» left the text: left there, it sat under the model's
    // «for totals» heading and its Σ came back as the shipment's.
    expect(read.text).toBe('[Note]\nShipping mark: GS777\nTOTAL G.W. | 1592 KGS');
    expect(read.text).not.toContain('Zavod B');
  });

  it('the deal card’s import still reads the first sheet only (sheets-09, §8)', async () => {
    const sheet = await workbookRows(await k10Book());
    expect(sheet?.name).toBe('Zavod A');
  });
});

describe('a further sheet, by its shape (§4.2)', () => {
  it('R1 as one workbook: 12 rows, the packing list’s Σ as deterministic totals, said', async () => {
    const chatId = collection();
    const answer = await forward(chatId, await r1Book(), 'CI-PL.xlsx');
    expect(rows(chatId)).toEqual(B.GOODS.map((g) => g.en));
    const s = activeIntake(chatId)!;
    // The cartons-only Chinese packing list, line for line in another script:
    // its brutto and cube are the shipment's — no model asked.
    expect([s.fileTotals?.weightKg, s.fileTotals?.volumeM3, s.fileTotals?.weightNetto]).toEqual([1592, 13.58, false]);
    expect(answer.say).toBe(
      '📄 «CI-PL.xlsx» — 12 ta tovar o‘qildi («INVOICE» varag‘idan).\n' +
        '📄 «CI-PL.xlsx», «PACKING» varag‘i — o‘sha tovarlar: qatorlar «INVOICE» varag‘idan, bundan faqat umumiy brutto va kub olindi.',
    );
    // Its text still rides to the model under the totals heading (the C2/C6 fence stands).
    // The FILE's label: a later file that squeezes it says ««CI-PL.xlsx» ning boshqa varaqlari».
    expect(s.invoiceTexts.map((t) => [t.label, t.text.split('\n')[0], t.unmapped])).toEqual([['«CI-PL.xlsx»', '[PACKING]', undefined]]);
  });

  it('a packing sheet’s text squeezed out of the model’s budget later is named by its FILE', async () => {
    const chatId = collection();
    await forward(chatId, await r1Book(), 'CI-PL.xlsx');
    const lines = promptFileLines(activeIntake(chatId)!, (texts) => ({ kept: texts.map(() => 1), total: texts.map(() => 12) }));
    expect(lines).toEqual(['⚠️ AI «CI-PL.xlsx» ning boshqa varaqlaridan faqat 1 / 12 qatorini o‘qiydi.']);
  });

  it('R1 with a net column: each row takes its netto from the packing line at its PLACE', async () => {
    const chatId = collection();
    const answer = await forward(chatId, await r1Book({ net: true }), 'CI-PL.xlsx');
    expect((activeIntake(chatId)!.invoiceGoods ?? []).map((g) => g.weightKg)).toEqual(B.GOODS.map((g) => B.r2(g.nw * g.ctns)));
    expect(answer.say).toContain('12 ta qatorga netto og‘irlik shu fayldan yozildi');
  });

  it('R1 after another goods file: the packing list’s place no longer says which row is whose — today’s reading', async () => {
    const chatId = collection();
    await forward(chatId, await B.sheetsBook([['Inv', ['Description', 'Qty'], [['Kurtka', 10]]]]), 'first.xlsx');
    const answer = await forward(chatId, await r1Book(), 'CI-PL.xlsx');
    expect(activeIntake(chatId)!.fileTotals ?? null).toBeNull();
    expect(answer.say).toContain(`📄 «CI-PL.xlsx», «PACKING» varag‘i ${SAME_SENTENCE}`);
  });

  it('R1 after the same goods held in ANOTHER order: no netto by place — each would take another row’s', async () => {
    const chatId = collection();
    const reversed = [...B.GOODS].reverse();
    await forward(chatId, await B.sheetsBook([['Inv', ['Description', 'Quantity'], reversed.map((g) => [g.en, B.pcs(g)])]]), 'first.xlsx');
    await forward(chatId, await r1Book({ net: true }), 'CI-PL.xlsx');
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(reversed.map((g) => g.en));
    expect((s.invoiceGoods ?? []).map((g) => g.weightKg ?? null)).toEqual(reversed.map(() => null));
    expect(s.fileTotals ?? null).toBeNull();
  });

  it('R1 after the same goods held in the SAME order: the held rows are the sheet’s, place for place — R1 stands', async () => {
    const chatId = collection();
    await forward(chatId, await B.sheetsBook([['Inv', ['Description', 'Quantity'], B.GOODS.map((g) => [g.en, B.pcs(g)])]]), 'first.xlsx');
    await forward(chatId, await r1Book({ net: true }), 'CI-PL.xlsx');
    const s = activeIntake(chatId)!;
    expect((s.invoiceGoods ?? []).map((g) => g.weightKg)).toEqual(B.GOODS.map((g) => B.r2(g.nw * g.ctns)));
    expect([s.fileTotals?.weightKg, s.fileTotals?.volumeM3]).toEqual([1592, 13.58]);
  });

  it('R1 with another factory folded in before the packing list: its Σ is not the list’s — today’s reading', async () => {
    const chatId = collection();
    const body = await B.bookOf((wb) => {
      B.englishInvoice(wb.addWorksheet('INVOICE'));
      B.plainSheet(wb.addWorksheet('Zavod B'), ['Description', 'Quantity'], [['Electric kettle', 50], ['Hair dryer', 80]]);
      B.chinesePacking(wb.addWorksheet('PACKING'), B.GOODS, { net: true });
    });
    const answer = await forward(chatId, body, 'CI-PL.xlsx');
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods).toHaveLength(14);
    expect(s.fileTotals ?? null).toBeNull();
    expect(answer.say).toContain(`📄 «CI-PL.xlsx», «PACKING» varag‘i ${SAME_SENTENCE}`);
  });

  it('a bilingual CI + PL of the same goods (`packingOfHeld`): the totals and every netto, as two files give them (xlsxN-11)', async () => {
    const chatId = collection();
    const body = await B.bookOf((wb) => {
      B.invoiceSheet(wb.addWorksheet('INVOICE'), B.GOODS);
      B.packingSheet(wb.addWorksheet('PACKING LIST'), B.GOODS);
    });
    await forward(chatId, body, 'XH20261028.xlsx');
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods).toHaveLength(12);
    expect((s.invoiceGoods ?? []).every((g) => typeof g.weightKg === 'number')).toBe(true);
    expect([s.fileTotals?.weightKg, s.fileTotals?.volumeM3]).toEqual([1592, 13.58]);
  });

  it('K10, two invoice sheets of two factories: «Zavod B» is folded in and named (known-1)', async () => {
    const chatId = collection();
    const answer = await forward(chatId, await k10Book(), 'GS777_invoice.xlsx');
    expect(rows(chatId)).toEqual(['Куртка женская', 'Брюки мужские', 'Сумка женская PU', 'Кроссовки мужские', 'Кепка бейсболка']);
    expect(answer.say).toBe(
      '📄 «GS777_invoice.xlsx» — 3 ta tovar o‘qildi («Zavod A» varag‘idan).\n📄 «GS777_invoice.xlsx», «Zavod B» varag‘idan 2 ta yangi tovar qo‘shildi.',
    );
    const s = activeIntake(chatId)!;
    // The folded sheet's text goes nowhere — and two goods blocks refuse the lone ✅ total.
    expect(s.invoiceTexts).toEqual([]);
    expect(s.goodsFiles?.map((f) => [f.label, f.rows])).toEqual([
      ['«GS777_invoice.xlsx»', 3],
      ['«GS777_invoice.xlsx», «Zavod B» varag‘i', 2],
    ]);
  });

  it('K10 with B at 300/200 — the round counts of an ordinary day: still proven (Σ 800 against 500), 5 rows', async () => {
    const chatId = collection();
    await forward(chatId, await k10Book([{ ...B.B_KROSS, pcs: 300 }, { ...B.B_KEPKA, pcs: 200 }]), 'GS777_invoice.xlsx');
    expect(rows(chatId)).toHaveLength(5);
  });

  it('J1, a packing sheet per factory (one script shared, counts on every row, Σ differ): folded', async () => {
    const chatId = collection();
    const body = await B.bookOf((wb) => {
      B.packingSheet(wb.addWorksheet('义乌工厂 Factory A'), B.GOODS.slice(0, 8));
      B.packingSheet(wb.addWorksheet('广州工厂 Factory B'), B.GOODS.slice(8));
    });
    const answer = await forward(chatId, body, 'GS777-packing.xlsx');
    expect(rows(chatId)).toHaveLength(12);
    expect(answer.say).toContain('«广州工厂 Factory B» varag‘idan 4 ta yangi tovar qo‘shildi');
    // Factory A's Σ is not the shipment's: nothing written as the totals.
    expect(activeIntake(chatId)!.fileTotals ?? null).toBeNull();
  });

  it('G, a sheet per category: the shoes are folded in (unmapped-other-sheets)', async () => {
    const chatId = collection();
    const body = await B.sheetsBook([
      ['Kiyimlar', ['Наименование', 'Кол-во', 'Вес'], [['Куртка женская', 300, 150], ['Брюки мужские', 200, 100], ['Кофта детская', 100, 40]]],
      ['Poyabzal', ['Наименование', 'Кол-во', 'Вес'], [['Кроссовки', 120, 60], ['Тапочки', 80, 20]]],
    ]);
    const answer = await forward(chatId, body, 'tovarlar.xlsx');
    expect(rows(chatId)).toEqual(['Куртка женская', 'Брюки мужские', 'Кофта детская', 'Кроссовки', 'Тапочки']);
    expect(answer.say).toContain('📄 «tovarlar.xlsx», «Poyabzal» varag‘idan 2 ta yangi tovar qo‘shildi.');
  });

  it('an RU CI + its short-named RU packing list: today’s 3 rows, and the sentence (sheets-01)', async () => {
    const chatId = collection();
    const body = await B.sheetsBook([
      ['Инвойс', ['Наименование', 'Кол-во', 'Сумма'], [['Куртка женская зимняя на синтепоне', 300, 1950], ['Куртка мужская демисезонная', 240, 1728], ['Брюки детские трикотажные', 400, 840]]],
      ['Упаковочный', ['Наименование', 'Мест', 'Вес брутто, кг', 'Объем, м3'], [['Куртка женская', 15, 157.5, 1.8], ['Куртка мужская', 12, 134.4, 1.56], ['Брюки детские', 8, 104, 0.72]]],
    ]);
    const answer = await forward(chatId, body, 'inv.xlsx');
    expect(rows(chatId)).toHaveLength(3);
    expect(answer.say).toContain(`📄 «inv.xlsx», «Упаковочный» varag‘i ${SAME_SENTENCE}`);
    // …its text read for the totals, as today.
    expect(activeIntake(chatId)!.invoiceTexts.map((t) => t.text.split('\n')[0])).toEqual(['[Упаковочный]']);
  });

  it('an EN «Ladies jacket, black» CI + a «Ladies jacket» PL: the CI’s rows only, and the sentence', async () => {
    const chatId = collection();
    const body = await B.sheetsBook([
      ['Invoice', ['Description', 'Qty', 'Amount'], [['Ladies jacket, black', 300, 1950], ['Mens jacket, grey', 240, 1728]]],
      ['Packing', ['Description', 'Ctns', 'G.W.', 'CBM'], [['Ladies jacket', 15, 157.5, 1.8], ['Mens jacket', 12, 134.4, 1.56]]],
    ]);
    const answer = await forward(chatId, body, 'inv.xlsx');
    expect(rows(chatId)).toEqual(['Ladies jacket, black', 'Mens jacket, grey']);
    expect(answer.say).toContain(SAME_SENTENCE);
  });

  it('an invoice and its own translation sheet (equal Σ): 2 rows, never doubled', async () => {
    const chatId = collection();
    const body = await B.sheetsBook([
      ['Invoice', ['Description', 'Qty', 'Amount USD'], [['Ladies jacket', 300, 1500], ['Men trousers', 200, 800]]],
      ['Инвойс', ['Наименование', 'Кол-во', 'Сумма USD'], [['Куртка женская', 300, 1500], ['Брюки мужские', 200, 800]]],
    ]);
    await forward(chatId, body, 'invoice.xlsx');
    expect(rows(chatId)).toEqual(['Ladies jacket', 'Men trousers']);
  });

  // The sheet is judged against the WORKBOOK's goods; the request's stored rows
  // only fence the names (review sheets-break-topup-sum-kept): counted into the
  // Σ, a stored row made a restatement «proven other» and folded it twice.
  const topUps = (stored: Goods): Partial<IntakeState>[] => [
    { seed: stored, seedDoor: 'ai', seededFrom: '00000000-0000-4000-8000-00000000fa04', facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods: stored } },
    { amend: amendOf(stored) },
  ];

  it('in a top-up, an invoice and its Specification of the same pieces (Σ equal): 2 rows, the stored row counts into no Σ', async () => {
    const body = await B.sheetsBook([
      ['Invoice', ['Description', 'Qty', 'Amount'], [['Sneakers men', 120, 1020], ['Baseball cap', 800, 640]]],
      ['Specification', ['Description', 'Qty', 'Amount'], [['Sport shoes', 120, 1020], ['Hat', 800, 640]]],
    ]);
    for (const patch of [{}, ...topUps([line('Ladies jacket', { quantity: 300 })])]) {
      const chatId = collection(patch);
      const answer = await forward(chatId, body, 'inv.xlsx');
      expect(rows(chatId)).toEqual(['Sneakers men', 'Baseball cap']);
      expect(answer.say).toContain(`📄 «inv.xlsx», «Specification» varag‘i ${SAME_SENTENCE}`);
    }
  });

  it('in a top-up, K10 is folded whatever the stored rows state: a kg-only stored row is no reason to keep «Zavod B» out', async () => {
    for (const patch of topUps([line('Куртка детская', { weightKg: 120 })])) {
      const chatId = collection(patch);
      const answer = await forward(chatId, await k10Book(), 'GS777_invoice.xlsx');
      expect(rows(chatId)).toHaveLength(5);
      expect(answer.say).toContain('«Zavod B» varag‘idan 2 ta yangi tovar qo‘shildi');
    }
  });

  it('in a top-up, a stored row in another script is a name nothing proves «Zavod B» is not — today’s reading, said', async () => {
    // «Ladies jacket» may be what a Cyrillic line translates (`otherName` calls
    // two names other only in a script both write — the same rule as the held
    // rows'); the landing could not tell either, and would price it twice.
    for (const patch of topUps([line('Ladies jacket', { quantity: 50 })])) {
      const chatId = collection(patch);
      const answer = await forward(chatId, await k10Book(), 'GS777_invoice.xlsx');
      expect(rows(chatId)).toHaveLength(3);
      expect(answer.say).toContain(`📄 «GS777_invoice.xlsx», «Zavod B» varag‘i ${SAME_SENTENCE}`);
    }
  });

  it('in a top-up, a CI + PL workbook of the same goods: its totals go on the note, never the request (§4.2)', async () => {
    const bilingual = await B.bookOf((wb) => {
      B.invoiceSheet(wb.addWorksheet('INVOICE'), B.GOODS);
      B.packingSheet(wb.addWorksheet('PACKING LIST'), B.GOODS);
    });
    for (const [book, sheet] of [
      [bilingual, 'PACKING LIST'],
      [await r1Book({ net: true }), 'PACKING'],
    ] as const) {
      for (const patch of topUps([line('Sumka', { quantity: 10 })])) {
        const chatId = collection(patch);
        const answer = await forward(chatId, book, 'CI-PL.xlsx');
        expect(rows(chatId)).toHaveLength(12);
        expect(answer.say).toContain(`📄 «CI-PL.xlsx», «${sheet}» varag‘i — packing list jami: brutto 1592 kg, 13.58 m³ — so‘rovga yozilmadi, VED fayldan ko‘radi.`);
        expect(activeIntake(chatId)!.fileTotals ?? null).toBeNull();
      }
    }
  });

  it('the summary-invoice workbook, in both sheet orders: today’s rows — the packing list’s three (sheets-03)', async () => {
    const summary: [string, string[], (string | number)[][]] = ['INVOICE', ['DESCRIPTION OF GOODS', 'QUANTITY', 'AMOUNT (USD)'], [['GARMENTS (AS PER PACKING LIST)', 940, 5000]]];
    const pl: [string, string[], (string | number)[][]] = [
      'PACKING',
      ['Description', 'Qty', 'Ctns', 'G.W.', 'CBM'],
      [['Ladies jacket', 300, 15, 157.5, 1.8], ['Mens jacket', 240, 12, 134.4, 1.56], ['Kids pants', 400, 8, 104, 0.72]],
    ];
    for (const order of [[summary, pl], [pl, summary]]) {
      const chatId = collection();
      await forward(chatId, await B.sheetsBook(order), 'S.xlsx');
      expect(rows(chatId)).toEqual(['Ladies jacket', 'Mens jacket', 'Kids pants']);
    }
  });
});

describe('the workbook as a WHOLE (§4.1, sheets-06)', () => {
  it('sent twice: «avval yuborilgan» once, nothing pushed or said again', async () => {
    for (const book of [await k10Book(), await r1Book({ net: true })]) {
      const chatId = collection();
      await forward(chatId, book, 'a.xlsx');
      const before = activeIntake(chatId)!;
      const again = await forward(chatId, book, 'a.xlsx');
      expect(again.say).toBe('📄 «a.xlsx» — bu fayl avval yuborilgan: qatorlari bir marta olindi.');
      const after = activeIntake(chatId)!;
      expect(after.invoiceGoods).toEqual(before.invoiceGoods);
      expect(after.invoiceTexts).toEqual(before.invoiceTexts);
      expect(after.goodsFiles).toEqual(before.goodsFiles);
    }
  });

  it('the same goods sheet with a NEW «Zavod C»: the new sheet is judged, never «avval yuborilgan»', async () => {
    const chatId = collection();
    await forward(chatId, await k10Book(), 'a.xlsx');
    const more = await B.bookOf((wb) => {
      B.plainSheet(wb.addWorksheet('Zavod A'), B.INVOICE_HEAD, B.invoiceRows([B.A_KURTKA, B.A_SHIM, B.A_SUMKA]));
      B.plainSheet(wb.addWorksheet('Zavod B'), B.INVOICE_HEAD, B.invoiceRows(K10_B));
      B.plainSheet(wb.addWorksheet('Zavod C'), B.INVOICE_HEAD, B.invoiceRows([{ name: 'Чайник электрический', pcs: 50, nw: 60, gw: 65, cbm: 0.6, price: 9 }]));
    });
    const answer = await forward(chatId, more, 'b.xlsx');
    expect(answer.say).not.toContain('avval yuborilgan');
    expect(rows(chatId)).toContain('Чайник электрический');
  });
});

describe('a top-up’s packing list is the goods list while the request has no rows (§4.5, known-2)', () => {
  it('a returned request with NO rows (seed []): the packing list’s rows are the goods', async () => {
    const chatId = collection({ seed: [], seedDoor: 'ai', seededFrom: '00000000-0000-4000-8000-00000000fa01' });
    const pl = await B.sheetsBook([['PACKING LIST', ['No.', 'Description', 'CTNS', 'PCS', 'N.W. (kg)', 'G.W. (kg)', 'CBM'], [[1, 'Куртка женская', 15, 300, 150, 165, 1.8], [2, 'Брюки мужские', 8, 200, 80, 88, 0.72]]]]);
    const answer = await forward(chatId, pl, 'PL.xlsx');
    expect(rows(chatId)).toEqual(['Куртка женская', 'Брюки мужские']);
    expect(answer.say).not.toContain('so‘rovga yozilmadi');
  });

  // A returned request (seed) and a ➕ on one (amend), both with nothing stored.
  const emptyTopUps = (): Partial<IntakeState>[] => [
    { seed: [], seedDoor: 'ai', seededFrom: '00000000-0000-4000-8000-00000000fa03' },
    { amend: amendOf([]) },
  ];

  it('…and an invoice after that packing list takes the goods role, as on a fresh collection: never doubled (review sheets-break-empty-topup-swap)', async () => {
    const pl = await B.sheetsBook([
      ['PL', ['Description', 'Ctns', 'Qty', 'G.W.', 'CBM'], [['女士夹克', 15, 300, 165, 1.8], ['男士夹克', 12, 240, 134.4, 1.56], ['儿童裤子', 8, 400, 104, 0.72]]],
    ]);
    const ci = await B.sheetsBook([['CI', ['Description', 'Qty', 'Amount'], [['Ladies jacket', 300, 1950], ['Mens jacket', 240, 1728], ['Kids pants', 400, 840]]]]);
    for (const patch of emptyTopUps()) {
      const chatId = collection(patch);
      await forward(chatId, pl, 'PL.xlsx');
      const answer = await forward(chatId, ci, 'CI.xlsx');
      expect(rows(chatId)).toEqual(['Ladies jacket', 'Mens jacket', 'Kids pants']);
      // A top-up writes no totals from its material (R3 interp 2): the packing list's go on the note.
      expect(answer.say).toContain('📄 «PL.xlsx» — packing list jami: brutto 403.4 kg, 4.08 m³ — so‘rovga yozilmadi, VED fayldan ko‘radi.');
      expect(activeIntake(chatId)!.fileTotals ?? null).toBeNull();
    }
  });

  it('a returned request WITH rows: still the noted file (FILES-2’s fence stands)', async () => {
    const stored = [line('Куртка женская', { quantity: 300 })];
    const chatId = collection({ seed: stored, seedDoor: 'ai', seededFrom: '00000000-0000-4000-8000-00000000fa02', facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods: stored } });
    const pl = await B.sheetsBook([['PACKING LIST', ['No.', 'Description', 'CTNS', 'PCS', 'N.W. (kg)', 'G.W. (kg)', 'CBM'], [[1, 'Брюки мужские', 8, 200, 80, 88, 0.72]]]]);
    const answer = await forward(chatId, pl, 'PL.xlsx');
    expect(rows(chatId)).toEqual([]);
    expect(answer.say).toContain('so‘rovga yozilmadi, VED fayldan ko‘radi');
  });
});

describe('the words (§4.4)', () => {
  it('the arrival line claims for the other sheets only what is done with them', async () => {
    const chatId = collection();
    const body = await B.bookOf((wb) => {
      B.plainSheet(wb.addWorksheet('Invoice'), ['Description', 'Qty'], [['Kurtka', 300]]);
      wb.addWorksheet('Note').addRows([['TOTAL G.W.', '150 KGS']]);
    });
    const answer = await forward(chatId, body, 'A.xlsx');
    expect(answer.say).toBe('📄 «A.xlsx» — 1 ta tovar o‘qildi («Invoice» varag‘idan; boshqa varaqlar faqat jami uchun o‘qiladi).');
    expect(answer.say).not.toContain('boshqa varaqlarni AI o‘qiydi');
    // …and the unmapped text is marked so, for the reading (§4.6).
    expect(activeIntake(chatId)!.invoiceTexts.map((t) => t.unmapped)).toEqual([true]);
  });

  it('…and beside a further mapped sheet, it names the sheets it is true of: never «the other sheets» above one folded in', async () => {
    const body = await B.bookOf((wb) => {
      B.plainSheet(wb.addWorksheet('Zavod A'), B.INVOICE_HEAD, B.invoiceRows([B.A_KURTKA, B.A_SHIM, B.A_SUMKA]));
      B.plainSheet(wb.addWorksheet('Zavod B'), B.INVOICE_HEAD, B.invoiceRows(K10_B));
      wb.addWorksheet('Note').addRows([['Shipping mark: GS777'], ['TOTAL G.W.', '1592 KGS']]);
    });
    const answer = await forward(collection(), body, 'X.xlsx');
    expect(answer.say).toBe(
      '📄 «X.xlsx» — 3 ta tovar o‘qildi («Zavod A» varag‘idan; tovar qatori olinmagan varaqlar faqat jami uchun o‘qiladi).\n' +
        '📄 «X.xlsx», «Zavod B» varag‘idan 2 ta yangi tovar qo‘shildi.',
    );
  });

  it('a header FOUND with no goods row under it is not «sarlavhasini topa olmadim» (xlsx1-04)', async () => {
    const chatId = collection();
    // The only row is the container's total: the header was found, no goods row came out. (The
    // fixture was a lone «TOTAL cordless drill» until P-reader made that drill a good — xlsx1-04 is
    // exactly that bug — so it now stands on a row the reader still refuses, a label-only total.)
    const body = await B.sheetsBook([['PL', ['Description', 'Qty', 'Ctns', 'N.W.', 'G.W.', 'CBM'], [["TOTAL 1X40'HQ", 50, 5, 110, 120, 0.6]]]]);
    const read = await readGoodsFile(body, null);
    expect(read).toMatchObject({ kind: 'text', why: 'header' });
    const answer = await forward(chatId, body, 'drill.xlsx');
    expect(answer.say).not.toContain('sarlavhasini topa olmadim');
    expect(answer.say).toContain('jadvaldan tovar qatorlarini o‘zim ajrata olmadim, AI o‘qiydi.');
  });

  it('a cover sheet with no goods row says so, never «AI o‘qiydi» (unmapped-misleading-receipts)', async () => {
    const body = await B.bookOf((wb) =>
      wb.addWorksheet('PI').addRows([['YIWU HUAXIN TRADING CO., LTD'], ['PROFORMA INVOICE', 'No: HX-2026-118'], ['To: GSR LOGISTICS'], ['TOTAL: 25 CTNS, 480 KG, 2.1 CBM']]),
    );
    const read = await readGoodsFile(body, null);
    expect(read).toMatchObject({ kind: 'text', why: 'no_rows', pictures: 0 });
    const chatId = collection();
    const answer = await forward(chatId, body, 'PI.xlsx');
    expect(answer.say).toBe('📄 «PI.xlsx» — jadvalda tovar qatori ko‘rinmadi.');
    // …and a factory office's letterhead over nothing: the company, the
    // address and phone, the title, the labels and their values.
    const letterhead = await B.bookOf((wb) =>
      wb.addWorksheet('CI').addRows([
        ['YIWU XINGHUA IMPORT & EXPORT CO., LTD 义乌兴华进出口有限公司'],
        ['ADD: NO. 188 CHOUZHOU NORTH ROAD, YIWU, ZHEJIANG, CHINA  TEL: +86-579-85551234'],
        ['商业发票 COMMERCIAL INVOICE'],
        ['TO: GSR LOGISTICS, TASHKENT, UZBEKISTAN', null, null, 'INVOICE NO.:', 'XH20261028'],
        ['Date:', '2026-10-28'],
        ['SAY US DOLLARS 26850.4 ONLY'],
      ]),
    );
    expect(await readGoodsFile(letterhead, null)).toMatchObject({ kind: 'text', why: 'no_rows' });
  });

  // «No goods row» is said only of a sheet every line of which is a cover's —
  // a title, the company, a contact label, a total (review
  // sheets-spec-no-rows-too-wide): «no row pairs a name with a figure» also
  // took a names-only list, one-cell lines and figures in a unit the reader
  // does not know, whose goods the model then read off that very text.
  it('a header-less list with no figure cell beside its names keeps today’s words: the model reads goods there', async () => {
    const lists: (string | number)[][][] = [
      [['Кастрюля'], ['Сковорода'], ['Чайник']],
      [['Ayollar kurtkasi 300 dona 150 kg'], ['Erkaklar shimi 200 dona 100 kg']],
      [['Ladies jacket', 'black'], ['Mens trousers', 'grey']],
      [['Ткань полиэстер 150см', '12 рулонов'], ['Подкладочная ткань', '30 рулонов'], ['Нитки швейные', '5 мешков']],
      [['Tovar: Ayollar kurtkasi'], ['Soni: 300 dona'], ['Og‘irligi: 150 kg']],
    ];
    for (const cells of lists) {
      const body = await B.bookOf((wb) => wb.addWorksheet('S').addRows(cells));
      const read = await readGoodsFile(body, null);
      expect(read?.kind, JSON.stringify(cells)).toBe('text');
      expect(read as { why?: string }, JSON.stringify(cells)).not.toHaveProperty('why');
      expect((await forward(collection(), body, 'S.xlsx')).say).toBe('📄 «S.xlsx» — jadval sarlavhasini topa olmadim, AI o‘qiydi.');
    }
  });

  it('a header-less goods table keeps today’s words', async () => {
    const body = await B.bookOf((wb) => wb.addWorksheet('S').addRows([[1, 'Ladies jacket', 300, 157.5], [2, 'Mens jacket', 240, 134.4]]));
    expect(await readGoodsFile(body, null)).toMatchObject({ kind: 'text', pictures: 0 });
    expect((await readGoodsFile(body, null)) as { why?: string }).not.toHaveProperty('why');
    const chatId = collection();
    expect((await forward(chatId, body, 'S.xlsx')).say).toBe('📄 «S.xlsx» — jadval sarlavhasini topa olmadim, AI o‘qiydi.');
  });

  it('a workbook whose goods are in a picture says to send the picture (unmapped-embedded-picture-dropped)', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const picture = async (cells: (string | number)[][]) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('PI');
      ws.addRows(cells);
      ws.addImage(wb.addImage({ buffer: png as unknown as ExcelJS.Buffer, extension: 'png' }), { tl: { col: 0, row: 3 }, ext: { width: 600, height: 400 } });
      return Buffer.from(await wb.xlsx.writeBuffer());
    };
    const only = await picture([]);
    expect(await readGoodsFile(only, null)).toEqual({ kind: 'refused', reason: 'pictures' });
    const chatId = collection();
    expect((await forward(chatId, only, 'skrin.xlsx')).say).toBe(`📄 «skrin.xlsx» — jadval bo‘sh. ${PICTURES_LINE}`);
    expect(PICTURES_LINE).toBe('Excel ichidagi rasm o‘qilmaydi — rasmni alohida (rasm yoki PDF qilib) yuboring.');
    // A caption beside the picture: the text goes to the model, the picture is said.
    const captioned = await picture([['PROFORMA INVOICE'], ['TOTAL: 25 CTNS, 480 KG']]);
    const said = (await forward(collection(), captioned, 'PI.xlsx')).say!;
    expect(said).toBe(`📄 «PI.xlsx» — jadvalda tovar qatori ko‘rinmadi. ${PICTURES_LINE}`);
  });

  it('the prompt redraws the same words from durable state', () => {
    const chatId = collection();
    const answer = receiveSheetText(activeIntake(chatId)!, '«PI.xlsx»', { text: '[PI]\nTOTAL', cut: false, cellsCut: false, why: 'no_rows', pictures: true }, (t) => ({
      kept: t.map(() => 1),
      total: t.map(() => 1),
    }));
    expect(answer.patch.sheetTexts?.[0]).toMatchObject({ why: 'no_rows', pictures: true });
    expect(sheetTextLine('«PI.xlsx»', { kept: 1, total: 1 }, false, answer.patch.sheetTexts![0]!)).toBe(answer.say);
  });
});

describe('cuts keep an emoji whole (§3.8, apireq-1)', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  it('a cell cut at its 300 units, and at its 1,200-unit window, leaves no lone half in the text', async () => {
    const at300 = `${'a'.repeat(299)}😀 tail`;
    const at1200 = `${'b'.repeat(1199)}😀${'c'.repeat(50)}`;
    const body = await B.bookOf((wb) => wb.addWorksheet('S').addRows([[at300, 1], [at1200, 2]]));
    const read = await readGoodsFile(body, null);
    if (read?.kind !== 'text') throw new Error(`text expected, got ${read?.kind}`);
    expect(read.text).not.toMatch(lone);
    expect(read.cellsCut).toBe(true);
    expect(JSON.stringify(read.text)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
  });

  it('…and the 1,200-unit window itself cuts whole: a padded cell whose window ends between the halves', async () => {
    // The spaces collapse, so the 300-unit cut never reaches the emoji: only
    // the window can split it (review sheets-spec-window-cut-unpinned).
    const padded = `a${' '.repeat(1197)}b😀 tail`;
    const body = await B.bookOf((wb) => wb.addWorksheet('S').addRows([[padded, 1]]));
    const read = await readGoodsFile(body, null);
    if (read?.kind !== 'text') throw new Error(`text expected, got ${read?.kind}`);
    expect(read.text).not.toMatch(lone);
    expect(read.text).not.toContain('\uFFFD');
    expect(read.text).toBe('[S]\na b | 1');
  });
});

describe('a model line is never dropped in silence (§4.6, xlsxN-02 J2, narrowed by sheets-08)', () => {
  const invoice = [line('Ladies jacket', { quantity: 300 }), line('Mens jacket', { quantity: 240 }), line('Kids pants', { quantity: 400 })];
  const pick = (model: Goods, otherMaterial: boolean) =>
    pickGoods({ invoice, aiGoods: null, model, typed: [], typedLabelled: [], otherMaterial });

  it('a lone Excel whose model restates every row translated, by count: nothing named', () => {
    const model = [line('Куртка женская', { quantity: 300 }), line('Куртка мужская', { quantity: 240 }), line('Брюки детские', { quantity: 400 })];
    for (const other of [false, true]) expect(pick(model, other)).toEqual({ goods: invoice, sameAsInvoice: [] });
  });

  it('beside a header-less sheet: a line the Excel does not carry is NAMED, never added', () => {
    const picked = pick([line('Power bank', { quantity: 500 })], true);
    expect(picked.goods).toEqual(invoice);
    expect(picked.sameAsInvoice).toEqual([{ ...line('Power bank', { quantity: 500 }), why: 'file' }]);
    expect(fileLeftOutNote(picked.sameAsInvoice)).toBe('AI fayldan yana «Power bank» ni topdi — ro‘yxatga qo‘shilmadi, VED ko‘radi');
    // …and never as «bir xil».
    expect(sameAsInvoiceNote(picked.sameAsInvoice)).toBeNull();
  });

  it('with no such material, the same line is the model restating — nothing named', () => {
    expect(pick([line('Power bank', { quantity: 500 })], false).sameAsInvoice).toEqual([]);
  });

  it('a line meeting a row by an equal count under names that do not contradict is a restatement', () => {
    expect(pick([line('Женская куртка', { quantity: 300 })], true).sameAsInvoice).toEqual([]);
  });

  // «By position in an equal-length list» is the line AT a place meeting the
  // row at that place — never a blanket pass for any list of that length
  // (review sheets-break-file-naming-length): K10's «Zavod B» on a sheet the
  // reader cannot map, two lines beside a two-row invoice, vanished unsaid.
  it('a list as long as the Excel’s is judged place by place: another factory’s goods are named', () => {
    const two = [line('Куртка женская', { quantity: 300 }), line('Брюки мужские', { quantity: 200 })];
    const model = [line('Кроссовки мужские', { quantity: 120 }), line('Кепка бейсболка', { quantity: 800 })];
    const picked = pickGoods({ invoice: two, aiGoods: null, model, typed: [], typedLabelled: [], otherMaterial: true });
    expect(picked.sameAsInvoice.map((g) => g.name)).toEqual(['Кроссовки мужские', 'Кепка бейсболка']);
    // …the same one cut to one line was named already: the length is no evidence.
    expect(pickGoods({ invoice: two, aiGoods: null, model: model.slice(0, 1), typed: [], typedLabelled: [], otherMaterial: true }).sameAsInvoice.map((g) => g.name)).toEqual([
      'Кроссовки мужские',
    ]);
  });

  it('one row answers ONE line: an invoice’s three 300s answer three translated lines, and no fourth', () => {
    const twelve = B.GOODS.map((g) => line(g.en, { quantity: B.pcs(g) }));
    // «Ladies jacket», «Ladies handbag PU» and «Sports shoes» are all 300.
    const restated = [line('Куртка женская', { quantity: 300 }), line('Сумка женская', { quantity: 300 })];
    expect(pickGoods({ invoice: twelve, aiGoods: null, model: restated, typed: [], typedLabelled: [], otherMaterial: true }).sameAsInvoice).toEqual([]);
    const four = [...restated, line('Кроссовки', { quantity: 300 }), line('Чайник', { quantity: 300 })];
    expect(pickGoods({ invoice: twelve, aiGoods: null, model: four, typed: [], typedLabelled: [], otherMaterial: true }).sameAsInvoice.map((g) => g.name)).toEqual(['Чайник']);
    // A row the model repeated by NAME answers that line: a 300 of another good is new.
    const one = [line('Ladies jacket', { quantity: 300 })];
    expect(pickGoods({ invoice: one, aiGoods: null, model: [line('Ladies jacket', { quantity: 300 }), line('Power bank', { quantity: 300 })], typed: [], typedLabelled: [], otherMaterial: true }).sameAsInvoice.map((g) => g.name)).toEqual(['Power bank']);
  });

  it('in an equal-length list, the line at a place answers the row at that place before any other', () => {
    // «Куртка женская» 300 restates «Ladies jacket» 300 at its own place; the
    // kettle ahead of it, with the same 300, took that row first and the
    // jacket's translation was named instead of the kettle.
    const inv = [line('Mens trousers', { quantity: 200 }), line('Ladies jacket', { quantity: 300 })];
    const model = [line('Чайник', { quantity: 300 }), line('Куртка женская', { quantity: 300 })];
    expect(pickGoods({ invoice: inv, aiGoods: null, model, typed: [], typedLabelled: [], otherMaterial: true }).sameAsInvoice.map((g) => g.name)).toEqual(['Чайник']);
  });

  it('photos keep their own branch and words', () => {
    const picked = pickGoods({ invoice, aiGoods: null, model: [line('Power bank', { quantity: 500 })], typed: [], typedLabelled: [], modelSawImages: true, otherMaterial: true });
    expect(picked.sameAsInvoice.map((g) => g.why)).toEqual(['typed']);
  });
});

describe('the pure rules under the judgement (file-goods.ts)', () => {
  const k10a = [line('Куртка женская', { quantity: 300 }), line('Брюки мужские', { quantity: 200 }), line('Сумка женская PU', { quantity: 300 })];
  const k10b = [line('Кроссовки мужские', { quantity: 120 }), line('Кепка бейсболка', { quantity: 800 })];

  it('«proven other» is positive evidence, never the absence of a meeting (sheets-01)', () => {
    expect(provenOther(k10a, k10b)).toBe(true);
    // A packing list states cartons, never pieces: nothing proven.
    expect(provenOther(k10a, [line('Кроссовки мужские'), line('Кепка бейсболка', { quantity: 800 })])).toBe(false);
    // The same pieces: the whole-list test of a packing list of the same goods passes — not proven other.
    expect(provenOther(k10a, [line('Кроссовки мужские', { quantity: 400 }), line('Кепка бейсболка', { quantity: 400 })])).toBe(false);
    // The customs name and its short name are not two names.
    expect(provenOther([line('Куртка женская зимняя на синтепоне', { quantity: 300 })], [line('Куртка женская', { quantity: 150 })])).toBe(false);
    // A Chinese row beside an English one may be its translation.
    expect(provenOther([line('Ladies jacket', { quantity: 300 })], [line('女士夹克', { quantity: 150 })])).toBe(false);
    // …even where their numbers differ: a pair that shares no letter script proves nothing.
    expect(provenOther([line('Кружка 350мл', { quantity: 480 })], [line('陶瓷杯 500ml', { quantity: 240 })])).toBe(false);
  });

  it('`otherName` is exported as the one rule for «two names» (each has a word the other lacks)', () => {
    expect(otherName('кроссовки мужские', 'куртка женская')).toBe(true);
    expect(otherName('куртка женская', 'куртка женская зимняя на синтепоне')).toBe(false);
  });

  it('`samePositions`: one length, no shared script — R1 and nothing wider', () => {
    const en = [line('Ladies jacket'), line('Mens jacket')];
    expect(samePositions(en, [line('女士夹克'), line('男士夹克')])).toBe(true);
    expect(samePositions(en, [line('女士夹克 Ladies jacket'), line('男士夹克')])).toBe(false);
    expect(samePositions(en, [line('女士夹克')])).toBe(false);
  });

  it('`positionalFills`: a NET weight into a row that states none, never across two counts that disagree', () => {
    const held = [line('A', { quantity: 10 }), line('B', { quantity: 20, weightKg: 5 }), line('C', { quantity: 30 })];
    const pl = [line('甲', { weightKg: 1 }), line('乙', { weightKg: 2 }), line('丙', { quantity: 31, weightKg: 3 })];
    expect(positionalFills(held, pl, 'net').goods.map((g) => g.weightKg)).toEqual([1, 5, undefined]);
    expect(positionalFills(held, pl, 'gross')).toEqual({ goods: held, filled: 0 });
  });

  it('`sameWorkbookAgain`: every sheet held one way or the other, one held row per read row', () => {
    const held = [line('Ladies jacket', { quantity: 300, weightKg: 142.5 }), line('Power bank', { quantity: 500 })];
    const goods = [line('Ladies jacket', { quantity: 300 })];
    const folded = { goods: [line('Power bank', { quantity: 500 })], text: '[B]\nPower bank | 500' };
    const forTotals = { goods: [line('女士夹克')], text: '[PL]\n女士夹克 | 15' };
    // The netto a packing sheet wrote into the held row is not a difference.
    expect(sameWorkbookAgain(held, goods, [folded], '', [])).toBe(true);
    expect(sameWorkbookAgain(held, goods, [forTotals], '', [{ text: forTotals.text }])).toBe(true);
    // A sheet held neither way is new: the workbook is judged sheet by sheet.
    expect(sameWorkbookAgain(held, goods, [forTotals], '', [])).toBe(false);
    // One held row answers one read row.
    expect(sameWorkbookAgain(held, goods, [{ goods, text: '' }], '', [])).toBe(false);
  });
});
