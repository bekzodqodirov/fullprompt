import { afterEach, describe, expect, it } from 'vitest';

/**
 * The as-built review of docs/FAYL-OQISH.md, the files lens (SHEETS-1,
 * REGRESSION-6): what a workbook's FURTHER sheets did not hand over, and the
 * one truth behind a capped list — through the bot's own file door
 * (`readIntakeFile`) with the real reader and real workbook files.
 */
import { activeIntake, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { readIntakeFile } from '@/modules/platform/telegram/calc-files';
import { aiReadingWhole } from '@/modules/platform/telegram/reading-whole';
import { readGoodsFile } from '@/modules/wms/deals/goods-file';
import { MAX_GOODS_ROWS, parseGoods, type Cell } from '@/modules/wms/deals/goods-import';
import * as B from '../fixtures/fayl-books';

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}, opts: { ai?: boolean } = {}) {
  seq += 1;
  const chatId = BigInt(-9_341_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-fayl-asb', ai: opts.ai ?? true });
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

describe('a further sheet’s dropped rows reach a reader (as-built review SHEETS-1)', () => {
  // «Zavod B»: two goods with figures, then two figure-less lines the reader
  // trims as a footer — real goods, perhaps, and only the seller knows.
  const book = () =>
    B.sheetsBook([
      ['Zavod A', B.INVOICE_HEAD, B.invoiceRows([B.A_KURTKA, B.A_SHIM, B.A_SUMKA])],
      ['Zavod B', B.INVOICE_HEAD, [...B.invoiceRows([B.B_KROSS, B.B_KEPKA]), [3, 'Шарф шерстяной'], [4, 'Перчатки кожаные']]],
    ]);
  const LINE = '📄 «two.xlsx», «Zavod B» varag‘i — ostidagi 2 ta qator tovar deb olinmadi: «3 | Шарф шерстяной», «4 | Перчатки кожаные».';

  it('the reader hands the further sheet’s dropped rows over', async () => {
    const read = await readGoodsFile(await book(), null);
    expect(read?.kind).toBe('goods');
    if (read?.kind !== 'goods') return;
    expect(read.moreSheets.map((m) => m.dropped.map((d) => d.name))).toEqual([['Шарф шерстяной', 'Перчатки кожаные']]);
  });

  for (const ai of [true, false]) {
    it(`said on receipt and kept for the card on the ${ai ? 'AI' : 'plain'} door; shown to the model on the AI door only`, async () => {
      const chatId = collection({}, { ai });
      const answer = await forward(chatId, await book(), 'two.xlsx');
      const live = activeIntake(chatId)!;
      // The fold stands: B's two goods are another factory's.
      expect((live.invoiceGoods ?? []).map((g) => g.name)).toHaveLength(5);
      expect(answer.say).toContain(LINE);
      expect(live.fileNotes).toContain(LINE);
      const context = live.invoiceTexts.filter((t) => t.text.includes('Шарф шерстяной'));
      expect(context.length).toBe(ai ? 1 : 0);
      if (ai) {
        expect(context[0]!.text).toContain('лист «Zavod B»');
        expect(context[0]!.dropped).toBe(true);
      }
    });
  }
});

describe('a list read WHOLE at the ceiling is no cut (as-built review REGRESSION-6)', () => {
  const rowsOf = (n: number): (string | number | null)[][] => Array.from({ length: n }, (_, k) => [k + 1, `Tovar ${k + 1}`, 10, 1, 10, 2, 2.2, 0.1]);
  const list = (n: number): Cell[][] => [['Description', 'Qty', 'G.W. (kg)'], ...Array.from({ length: n }, (_, k): Cell[] => [`Item ${k + 1}`, 10, 2])];

  it('parseGoods says whether it stopped with rows left — never the row count', () => {
    expect(parseGoods(list(MAX_GOODS_ROWS)).stoppedShort).toBe(false);
    expect(parseGoods(list(MAX_GOODS_ROWS + 1)).stoppedShort).toBe(true);
    // A footer past the ceiling is no row left unread.
    expect(parseGoods([...list(MAX_GOODS_ROWS), ['Made in China', null, null]]).stoppedShort).toBe(false);
    // The headerless pass says the same.
    const names = (n: number): Cell[][] => Array.from({ length: n }, (_, k): Cell[] => [`Tovar raqam ${k + 1} ko‘k`]);
    expect(parseGoods(names(MAX_GOODS_ROWS)).stoppedShort).toBe(false);
    expect(parseGoods(names(MAX_GOODS_ROWS + 3)).stoppedShort).toBe(true);
  });

  it('exactly 500 goods on the AI door: the file is not capped, and the reading is whole', async () => {
    const chatId = collection();
    await forward(chatId, await B.sheetsBook([['Invoice', B.INVOICE_HEAD, rowsOf(MAX_GOODS_ROWS)]]), 'tochno500.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.invoiceGoods).toHaveLength(MAX_GOODS_ROWS);
    expect((live.goodsFiles ?? []).some((f) => f.capped)).toBe(false);
    expect(aiReadingWhole({ ...live, aiUsed: true }, MAX_GOODS_ROWS).blocking).not.toContain('capped');
  });

  it('501 goods: capped, and the reader’s ceiling said (control)', async () => {
    const chatId = collection();
    const answer = await forward(chatId, await B.sheetsBook([['Invoice', B.INVOICE_HEAD, rowsOf(MAX_GOODS_ROWS + 1)]]), 'katta.xlsx');
    expect((activeIntake(chatId)!.goodsFiles ?? []).some((f) => f.capped)).toBe(true);
    expect(answer.say).toContain('⚠️ Bitta fayldan ko‘pi bilan 500 ta tovar qatori o‘qiladi');
  });
});

describe('a workbook’s fold stops at the queue’s own limit (as-built review REGRESSION-1)', () => {
  // Three factories of 400 different goods each, every row stating a count.
  const factory = (z: number): (string | number | null)[][] =>
    Array.from({ length: 400 }, (_, k) => [
      k + 1,
      // A word of its own per row and per factory: every row another good.
      `${['Alfa', 'Beta', 'Gamma'][z - 1]}${String.fromCharCode(97 + (k % 26))}${String.fromCharCode(97 + (Math.floor(k / 26) % 26))} tovar`,
      // …and a count no other factory's row states.
      z * 1000 + k,
      1,
      10,
      2,
      2.2,
      0.1,
    ]);
  const book = () =>
    B.sheetsBook([
      ['Zavod 1', B.INVOICE_HEAD, factory(1)],
      ['Zavod 2', B.INVOICE_HEAD, factory(2)],
      ['Zavod 3', B.INVOICE_HEAD, factory(3)],
    ]);

  for (const ai of [true, false]) {
    it(`${ai ? 'AI' : 'plain'} door: two factories fold (800), the third is not taken past 1000 — and the seller is told`, async () => {
      const chatId = collection({}, { ai });
      const answer = await forward(chatId, await book(), 'zavodlar.xlsx');
      const live = activeIntake(chatId)!;
      expect(live.invoiceGoods).toHaveLength(800);
      expect(answer.say).toContain('📄 «zavodlar.xlsx», «Zavod 3» varag‘i qo‘shilmadi — bitta so‘rovda 1000 tadan ortiq tovar bo‘lmaydi; bu varaqni alohida so‘rov qilib yuboring.');
      expect(live.fileNotes?.some((n) => n.includes('«Zavod 3» varag‘i qo‘shilmadi'))).toBe(true);
    });
  }
});
