import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The as-built review of docs/FAYL-OQISH.md, the second fix pass (B): the
 * collector, the door and the words. The model and the day's ledger are
 * stand-ins — the reading's outcome is scripted and what the model was SHOWN
 * is captured — while the collection, the file door and the readers are the
 * real ones, on real workbook files.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));
// The proven-other judgement, counted and otherwise the real one.
const judged = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/modules/platform/telegram/file-goods', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/platform/telegram/file-goods')>();
  return {
    ...real,
    provenOther: (...args: Parameters<typeof real.provenOther>) => {
      judged.calls += 1;
      return real.provenOther(...args);
    },
  };
});

import {
  activeIntake,
  analyzeCollected,
  endIntake,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import type { CalcSection } from '@/modules/wms/calc/intake';
import { permanentRefusal, promptFileLines, readIntakeFile, saveBotFile } from '@/modules/platform/telegram/calc-files';
import { RESTART_HOLD } from '@/modules/platform/telegram/calc-dialog';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { isStorableType, resolveContentType } from '@/modules/platform/files/service';
import { readGoodsFile } from '@/modules/wms/deals/goods-file';
import { readFileSync } from 'node:fs';
import * as B from '../fixtures/fayl-books';

const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
let seq = 0;
const chats: bigint[] = [];
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  model.analyze.mockReset();
});

function collection(section: CalcSection = 'podklyuch', patch: Partial<IntakeState> = {}, ai = true): bigint {
  seq += 1;
  const chatId = BigInt(-9_342_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-fayl-asb-b', ai });
  updateIntake(chatId, { stage: 'material', ...patch });
  return chatId;
}

/** A file forwarded into the collection through the bot's own door, as every door applies it. */
async function forward(chatId: bigint, body: Buffer, name: string, mime: string | null = B.XLSX) {
  const live = activeIntake(chatId)!;
  const answer = await readIntakeFile({ isPhoto: false, body, attachmentId: `a-${name}-${live.fileCount}` }, name, mime, live);
  updateIntake(chatId, { ...answer.patch, fileCount: live.fileCount + 1 });
  return answer;
}

/** What `analyzeIntake` was handed, as one string the model would read. */
function shown(call: unknown): string {
  return JSON.stringify(call);
}

describe('one factory’s TOTAL never sits under the totals heading beside a fold (OWNER-1, MODEL-1, SHEETS-2, REGRESSION-3)', () => {
  const A = B.GOODS.slice(0, 8);
  const Bf = B.GOODS.slice(8);
  // A model that answers what it is shown; here, no totals — so the brutto is
  // asked and the cube stays the rows' own Σ, as on the plain door.
  const noTotals = { ok: true, facts: { goods: [] }, steps: [], usage: BILL, answered: [BILL], knownCodes: [] };

  const j1 = () =>
    B.bookOf((wb) => {
      B.packingSheet(wb.addWorksheet('义乌工厂 Factory A'), A);
      B.packingSheet(wb.addWorksheet('广州工厂 Factory B'), Bf);
    });

  it('one workbook, two factories’ packing lists: no goods sheet text reaches the model', async () => {
    const chatId = collection('podklyuch');
    await forward(chatId, await j1(), 'J1.xlsx');
    const live = activeIntake(chatId)!;
    // The fold stands (P-sheets): twelve rows, two goods files, no total written.
    expect(live.invoiceGoods).toHaveLength(12);
    expect(live.goodsFiles).toHaveLength(2);
    expect(live.fileTotals).toBeNull();
    model.analyze.mockResolvedValueOnce(noTotals);
    const out = await analyzeCollected(live);
    expect(model.analyze).toHaveBeenCalledTimes(1);
    const input = model.analyze.mock.calls[0]![0] as { goodsSheetText?: unknown };
    expect(input.goodsSheetText).toBeUndefined();
    // Factory A's own TOTAL row (8 rows: 1179.9 kg / 10.56 m³) is shown nowhere.
    expect(shown(input)).not.toContain('TOTAL 合计');
    expect(out.facts.weightKg ?? null).toBeNull();
  });

  it('two FILES, each a factory’s packing list: the same', async () => {
    const chatId = collection('podklyuch');
    await forward(chatId, await B.bookOf((wb) => B.packingSheet(wb.addWorksheet('PACKING LIST'), A)), 'A.xlsx');
    await forward(chatId, await B.bookOf((wb) => B.packingSheet(wb.addWorksheet('PACKING LIST'), Bf)), 'B.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.invoiceGoods).toHaveLength(12);
    expect((live.goodsFiles ?? []).length).toBeGreaterThan(1);
    model.analyze.mockResolvedValueOnce(noTotals);
    await analyzeCollected(live);
    const input = model.analyze.mock.calls[0]![0] as { goodsSheetText?: unknown };
    expect(input.goodsSheetText).toBeUndefined();
    expect(shown(input)).not.toContain('TOTAL 合计');
  });

  it('the control: a lone packing list holding every row still hands its own rows over for the coding', async () => {
    const chatId = collection('podklyuch');
    await forward(chatId, await B.bookOf((wb) => B.packingSheet(wb.addWorksheet('PACKING LIST'), B.GOODS)), 'PL.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.goodsFiles).toHaveLength(1);
    model.analyze.mockResolvedValueOnce(noTotals);
    await analyzeCollected(live);
    const input = model.analyze.mock.calls[0]![0] as { goodsSheetText?: { text: string } };
    expect(input.goodsSheetText?.text).toContain('TOTAL 合计');
  });
});

describe('a packing list of SOME of the held goods gives no shipment totals (SHEETS-3)', () => {
  const CI_HEAD = ['No.', 'Description', 'Quantity (pcs)', 'Unit price (USD)', 'Amount (USD)'];
  const PL_HEAD = ['No.', 'Description', 'Quantity (pcs)', 'N.W. (kg)', 'G.W. (kg)', 'CBM'];
  const ci = (rows: readonly B.Row[]) => rows.map((r, i) => [i + 1, r.name, r.pcs, r.price, B.r2(r.pcs * r.price)]);
  const pl = (rows: readonly B.Row[]) => rows.map((r, i) => [i + 1, r.name, r.pcs, r.nw, r.gw, r.cbm]);
  const A = [B.A_KURTKA, B.A_SHIM, B.A_SUMKA];
  const Bf = [B.B_KROSS, B.B_KEPKA];
  const sheets = {
    ciA: ['CI A', CI_HEAD, ci(A)] as [string, (string | null)[], (string | number | null)[][]],
    ciB: ['CI B', CI_HEAD, ci(Bf)] as [string, (string | null)[], (string | number | null)[][]],
    plA: ['PL A', PL_HEAD, pl(A)] as [string, (string | null)[], (string | number | null)[][]],
  };
  const noTotals = { ok: true, facts: { goods: [] }, steps: [], usage: BILL, answered: [BILL], knownCodes: [] };

  it('the control: an invoice and ITS packing list — the list’s Σ is the shipment’s', async () => {
    const chatId = collection('podklyuch');
    await forward(chatId, await B.sheetsBook([sheets.ciA, sheets.plA]), 'ab.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.invoiceGoods).toHaveLength(3);
    expect(live.fileTotals).toMatchObject({ weightKg: 343, volumeM3: 4.02 });
  });

  it('«CI A, CI B, PL A»: factory A’s list is said as a part, its Σ is not taken', async () => {
    const chatId = collection('podklyuch');
    const answer = await forward(chatId, await B.sheetsBook([sheets.ciA, sheets.ciB, sheets.plA]), 'abc.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.invoiceGoods).toHaveLength(5);
    expect(live.fileTotals ?? null).toBeNull();
    expect(answer.say).toContain(
      '📄 «abc.xlsx», «PL A» varag‘i — ro‘yxatdagi tovarlarning bir qismi: boshqa tovarlar unda yo‘q, shuning uchun umumiy brutto va kub butun yuk uchun olinmadi.',
    );
    expect(answer.say).not.toContain('bundan faqat');
    // …and its Σ does not reach the model under the totals heading either.
    model.analyze.mockResolvedValueOnce(noTotals);
    const out = await analyzeCollected(live);
    expect(shown(model.analyze.mock.calls[0]![0])).not.toContain('343');
    expect(out.facts.weightKg ?? null).toBeNull();
  });

  it('«CI A, PL A, CI B»: the totals PL A gave are dropped when B is folded in, and said', async () => {
    const chatId = collection('podklyuch');
    const answer = await forward(chatId, await B.sheetsBook([sheets.ciA, sheets.plA, sheets.ciB]), 'acb.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.invoiceGoods).toHaveLength(5);
    expect(live.fileTotals ?? null).toBeNull();
    expect(answer.say).toContain(
      '📄 «acb.xlsx», «PL A» varag‘i — undan olingan umumiy brutto va kub endi butun yukniki emas: ro‘yxatga boshqa tovarlar qo‘shildi, shuning uchun olinmadi.',
    );
    model.analyze.mockResolvedValueOnce(noTotals);
    const out = await analyzeCollected(live);
    expect(out.facts.weightKg ?? null).toBeNull();
    expect(out.facts.volumeM3 ?? null).toBeNull();
  });
});

describe('past the queue’s limit a further sheet is not judged either (REGRESSION-2)', () => {
  const WORDS = ['Alfa', 'Bravo', 'Charli', 'Delta', 'Exo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'];
  const factory = (z: number): (string | number | null)[][] =>
    Array.from({ length: 500 }, (_, k) => [
      k + 1,
      `${WORDS[z]}${String.fromCharCode(97 + (k % 26))}${String.fromCharCode(97 + (Math.floor(k / 26) % 26))} tovar`,
      (z + 1) * 1000 + k,
      1,
      10,
      2,
      2.2,
      0.1,
    ]);

  it('ten factories of 500: the second is judged and folded (1000), the other eight are never asked', async () => {
    const book = await B.sheetsBook(WORDS.map((w, z) => [`Zavod ${z + 1}`, B.INVOICE_HEAD, factory(z)]));
    const chatId = collection('rastamojka');
    judged.calls = 0;
    const started = Date.now();
    const answer = await forward(chatId, book, 'oʻn.xlsx');
    const took = Date.now() - started;
    const live = activeIntake(chatId)!;
    expect(live.invoiceGoods).toHaveLength(1000);
    expect(judged.calls).toBe(1);
    expect(answer.say).toContain('«Zavod 10» varag‘i qo‘shilmadi');
    // Generous: the judgement of eight sheets against a thousand rows cost
    // seconds (4.3 s measured at 7224051); the parse alone is a fraction of one.
    expect(took).toBeLessThan(3000);
  });
});

describe('a cut answer keeps the goods the seller typed (OWNER-2)', () => {
  const good = (n: number) => ({ name: `Tovar ${n}`, quantity: n * 10, weightKg: null, volumeM3: null, tnvedCode: null, note: null });
  const seven = Array.from({ length: 7 }, (_, k) => good(k + 1));

  it('an unmapped sheet’s seven goods closed before the clock, and the caption’s good after them', async () => {
    const chatId = collection('rastamojka', { material: ['Erkaklar shimi 50 dona'], fileCount: 1 });
    model.analyze.mockResolvedValueOnce({ ok: true, facts: { goods: seven }, steps: [], usage: BILL, answered: [BILL], cut: { goods: 7, why: 'clock' } });
    const out = await analyzeCollected(activeIntake(chatId)!);
    expect(out.aiCut).toEqual({ goods: 7, why: 'clock' });
    const names = (out.facts.goods ?? []).map((g) => g.name);
    expect(names).toHaveLength(8);
    expect(names.slice(0, 7)).toEqual(seven.map((g) => g.name));
    expect(out.facts.goods?.[7]).toMatchObject({ quantity: 50 });
    expect(names[7]).toMatch(/Erkaklar shimi/);
  });

  it('a typed good the model DID read is not listed twice; a whole answer keeps today’s rule', async () => {
    const chatId = collection('rastamojka', { material: ['Erkaklar shimi 50 dona'], fileCount: 1 });
    const read = [...seven, { ...good(8), name: 'Erkaklar shimi', quantity: 50 }];
    model.analyze.mockResolvedValueOnce({ ok: true, facts: { goods: read }, steps: [], usage: BILL, answered: [BILL], cut: { goods: 8, why: 'clock' } });
    const cut = await analyzeCollected(activeIntake(chatId)!);
    expect(cut.facts.goods).toHaveLength(8);
    model.analyze.mockResolvedValueOnce({ ok: true, facts: { goods: seven }, steps: [], usage: BILL, answered: [BILL] });
    const whole = await analyzeCollected(activeIntake(chatId)!);
    expect(whole.facts.goods).toHaveLength(7);
  });
});

describe('a picture document past storage’s photo ceiling is refused for good, in its own words (MODEL-3)', () => {
  const JPEG_16MB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16 * 1024 * 1024)]);
  afterEach(() => {
    __setTelegramTransport(null);
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('a 16 MB JPEG sent as a file: storage refuses it, and the door hears a refusal no re-send heals', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
    __setTelegramTransport(async () => new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/scan.jpg' } }), { status: 200 }));
    vi.stubGlobal('fetch', async () => new Response(JPEG_16MB, { status: 200 }));
    const saved = await saveBotFile(
      {},
      { entityType: 'crm_activity', entityId: '00000000-0000-4000-8000-000000000099', uploadedBy: 'staff', namePrefix: 'hisob' },
      { fileId: 'f-1', isPhoto: false, fileName: 'scan.jpg', mime: 'image/jpeg', size: JPEG_16MB.length },
    );
    expect(saved).toEqual({ refused: 'too_large' });
  });

  it('said, named on the table, its caption read — never TOO_BIG_SAY’s «Telegram uni botga bermaydi»', () => {
    const chatId = collection('rastamojka');
    const answer = permanentRefusal(activeIntake(chatId)!, 'too_large', { name: 'scan.jpg', isPhoto: false });
    expect(answer).toEqual({
      patch: { refusedFiles: [{ name: 'scan.jpg', why: '15 MB dan katta rasm' }] },
      say: '🖼 «scan.jpg» — rasm 15 MB dan katta, saqlanmadi. Kichikroq qilib (yoki PDF) yuboring.',
    });
  });
});

describe('a macro workbook is stored and read; an HTML or XML table is refused in words that work (OWNER-10, MODEL-4, REGRESSION-5)', () => {
  const XLSM = 'application/vnd.ms-excel.sheet.macroEnabled.12';
  // Saved by LibreOffice as «Excel 2007-365 (macro-enabled)».
  const xlsm = () => readFileSync('tests/fixtures/invoice-macro.xlsm');

  it('storage keeps a .xlsm — by its mime and by its name', () => {
    expect(isStorableType(XLSM)).toBe(true);
    expect(resolveContentType('invoice.xlsm', 'application/octet-stream')).toBe(XLSM);
  });

  it('the reader reads a real .xlsm, and the file door takes its rows', async () => {
    const read = await readGoodsFile(xlsm(), XLSM);
    expect(read?.kind).toBe('goods');
    const chatId = collection('rastamojka');
    await forward(chatId, xlsm(), 'invoice.xlsm', XLSM);
    const live = activeIntake(chatId)!;
    expect((live.invoiceGoods ?? []).map((g) => g.name)).toEqual(['Куртка женская', 'Брюки мужские']);
    expect(live.refusedFiles ?? []).toEqual([]);
  });

  it('an HTML or XML table is told to be saved as .xlsx, and named as what it is', () => {
    const chatId = collection('rastamojka');
    const s = activeIntake(chatId)!;
    expect(permanentRefusal(s, 'unsupported', { name: 'export.html', isPhoto: false, mime: 'text/html' })).toEqual({
      patch: { refusedFiles: [{ name: 'export.html', why: 'HTML jadval' }] },
      say: '📎 «export.html» kartada saqlanmadi: HTML jadval o‘qilmaydi — Excel’da .xlsx qilib saqlab yuboring.',
    });
    expect(permanentRefusal(s, 'unsupported', { name: '', isPhoto: false, mime: 'application/xml' })!.patch.refusedFiles).toEqual([
      { name: 'fayl', why: 'XML jadval' },
    ]);
    // …and an unknown drawing keeps today's words.
    expect(permanentRefusal(s, 'unsupported', { name: 'chizma.dwg', isPhoto: false })!.say).toContain('rasm, PDF va Excel/CSV yuboring');
  });
});

describe('a refused file sent again and taken leaves the named tier (MODEL-5)', () => {
  const pdfBody = (bytes: number) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(bytes)]);

  it('refused at 11 MB, accepted at 3 MB under the same name: named nowhere', async () => {
    const chatId = collection('rastamojka');
    await forward(chatId, pdfBody(11 * 1024 * 1024), 'CI-2611.pdf', 'application/pdf');
    expect(activeIntake(chatId)!.refusedFiles).toEqual([{ name: 'CI-2611.pdf', why: 'PDF 10 MB dan katta' }]);
    await forward(chatId, pdfBody(3 * 1024 * 1024), 'CI-2611.pdf', 'application/pdf');
    const live = activeIntake(chatId)!;
    expect(live.pdfs.map((p) => p.name)).toEqual(['CI-2611.pdf']);
    expect(live.refusedFiles).toEqual([]);
  });

  it('another file’s refusal stands, and a second refusal of the same name is kept', async () => {
    const chatId = collection('rastamojka');
    await forward(chatId, pdfBody(11 * 1024 * 1024), 'big.pdf', 'application/pdf');
    await forward(chatId, pdfBody(1024), 'other.pdf', 'application/pdf');
    await forward(chatId, pdfBody(11 * 1024 * 1024), 'big.pdf', 'application/pdf');
    expect(activeIntake(chatId)!.refusedFiles).toEqual([
      { name: 'big.pdf', why: 'PDF 10 MB dan katta' },
      { name: 'big.pdf', why: 'PDF 10 MB dan katta' },
    ]);
  });
});

describe('the prompt never promises a reading for a PDF the API refused (WORDS-5)', () => {
  it('«AI bu faylni qabul qilmadi», the table’s words, until the next reading moves it', () => {
    const lines = promptFileLines(
      {
        pdfs: [
          { attachmentId: 'p1', name: 'scan.pdf', bytes: 10 },
          { attachmentId: 'p2', name: 'invoice.pdf', bytes: 10 },
        ],
        unreadPdfs: ['p1'],
        sheetTexts: [],
        invoiceTexts: [],
      },
      () => ({ kept: [], total: [] }),
    );
    expect(lines).toEqual(['📄 «scan.pdf» — AI bu faylni qabul qilmadi.', '📄 «invoice.pdf» — AI o‘qiydi.']);
  });
});

describe('the restart hold is true at every door (WORDS-10)', () => {
  it('it asks for what was SENT again, never for a file a typed line never was', () => {
    expect(RESTART_HOLD).toBe(
      '⏸ Avval yuqoridagi savolga javob bering — «🔄 Ha, boshqatdan» yoki «▶️ Yo‘q, davom etaman». Yuborganingizni javobdan keyin qayta yuboring.',
    );
  });
});

describe('a picture-only workbook is named once as not read (OWNER-11, MODEL-7)', () => {
  it('«pics.xlsx o‘qilmadi (ichida faqat rasm, jadval yo‘q)» — «not read» said once', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const book = await B.bookOf((wb) => {
      const ws = wb.addWorksheet('Rasm');
      const id = wb.addImage({ buffer: png as unknown as ArrayBuffer, extension: 'png' });
      ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 40, height: 40 } });
    });
    const chatId = collection('rastamojka');
    await forward(chatId, book, 'pics.xlsx');
    expect(activeIntake(chatId)!.refusedFiles).toEqual([{ name: 'pics.xlsx', why: 'ichida faqat rasm, jadval yo‘q' }]);
  });
});
