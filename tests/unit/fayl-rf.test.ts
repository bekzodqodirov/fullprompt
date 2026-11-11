import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The review of the as-built FIXES of docs/FAYL-OQISH.md (RF-*): each fix of
 * the as-built review reopened something one step over — a factory's totals
 * standing beside another factory's goods, a re-read keeping what new material
 * should have replaced, a refusal deleted on a name. The model, pg-boss and
 * Telegram are stand-ins; the collection, the file door, the readers, the
 * press and the reading are the real ones, on real workbook files.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  aiCalcAvailable: async () => true,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import {
  activeIntake,
  analyzeCollected,
  endIntake,
  pickGoods,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import { readIntakeFile } from '@/modules/platform/telegram/calc-files';
import { settleAnalysis } from '@/modules/platform/telegram/calc-read';
import { aiReadingWhole } from '@/modules/platform/telegram/reading-whole';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { notWholeRetry, refusedFileLines, refusedFilesNote, type CalcSection } from '@/modules/wms/calc/intake';
import { sheetsPromptText } from '@/modules/wms/calc/intake-ai';
import { readingsEnqueued, resetReadingDrive } from '../fixtures/calc-read-drive';
import * as B from '../fixtures/fayl-books';

const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
let seq = 0;
const chats: bigint[] = [];

beforeAll(async () => {
  await import('@/modules/wms/calc/intake-manual');
  await import('@/modules/wms/calc/intake');
  const { markIntakesHydrated } = await import('@/modules/platform/telegram/calc-store');
  markIntakesHydrated();
});
beforeEach(() => {
  resetReadingDrive();
  model.analyze.mockReset();
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

function collection(section: CalcSection = 'podklyuch', patch: Partial<IntakeState> = {}, ai = true): bigint {
  seq += 1;
  const chatId = BigInt(-9_472_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-fayl-rf', ai });
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

/** A model that read a FACTORY's TOTAL off the sheet it was shown and gave it as the shipment's. */
const readsTotals = (weightKg: number, volumeM3: number) => ({
  ok: true,
  facts: { goods: [], weightKg, volumeM3 },
  steps: [],
  usage: BILL,
  answered: [BILL],
  knownCodes: [],
});

const CI_HEAD = ['No.', 'Description', 'Quantity (pcs)', 'Unit price (USD)', 'Amount (USD)'];
const PL_HEAD = ['No.', 'Description', 'Quantity (pcs)', 'N.W. (kg)', 'G.W. (kg)', 'CBM'];
const ci = (rows: readonly B.Row[]) => rows.map((r, i) => [i + 1, r.name, r.pcs, r.price, B.r2(r.pcs * r.price)]);
const pl = (rows: readonly B.Row[]) => rows.map((r, i) => [i + 1, r.name, r.pcs, r.nw, r.gw, r.cbm]);
const A = [B.A_KURTKA, B.A_SHIM, B.A_SUMKA];
const Bf = [B.B_KROSS, B.B_KEPKA];
type Sheet = [string, (string | null)[], (string | number | null)[][]];
const ciA: Sheet = ['CI A', CI_HEAD, ci(A)];
const ciB: Sheet = ['CI B', CI_HEAD, ci(Bf)];
const plA: Sheet = ['PL A', PL_HEAD, pl(A)];
const plB: Sheet = ['PL B', PL_HEAD, pl(Bf)];
const plAll: Sheet = ['PL', PL_HEAD, pl([...A, ...Bf])];
const STALE = 'undan olingan umumiy brutto va kub endi butun yukniki emas';

describe('beside a fold no factory’s totals are the shipment’s (RF-TOTALS-1)', () => {
  const cases: [string, [Sheet[], string][], CalcSection, boolean][] = [
    ['two workbooks [CI A, PL A] then [CI B, PL B], AI door', [[[ciA, plA], 'A.xlsx'], [[ciB, plB], 'B.xlsx']], 'podklyuch', true],
    ['the same on the plain door', [[[ciA, plA], 'A.xlsx'], [[ciB, plB], 'B.xlsx']], 'podklyuch', false],
    ['factory B first, rastamojka', [[[ciB, plB], 'B.xlsx'], [[ciA, plA], 'A.xlsx']], 'rastamojka', true],
    ['file CI A, file PL A, workbook [CI B, PL B]', [[[ciA], 'CIA.xlsx'], [[plA], 'PLA.xlsx'], [[ciB, plB], 'B.xlsx']], 'podklyuch', true],
  ];
  for (const [name, files, section, ai] of cases) {
    it(`${name}: the standing totals are dropped and said, and the model’s figure does not land`, async () => {
      const chatId = collection(section, {}, ai);
      const says: string[] = [];
      for (const [sheets, file] of files) says.push((await forward(chatId, await B.sheetsBook(sheets), file)).say ?? '');
      const live = activeIntake(chatId)!;
      expect(live.invoiceGoods).toHaveLength(5);
      expect(live.fileTotals).toBeNull();
      expect(says.at(-1)).toContain(STALE);
      // The model read one factory's TOTAL (343 kg / 4.02 m³) under the totals
      // heading and gave it as the shipment's: beside the fold it is not taken.
      model.analyze.mockResolvedValueOnce(readsTotals(343, 4.02));
      const out = await analyzeCollected(live);
      expect(out.facts.weightKg ?? null).toBeNull();
      expect(out.facts.volumeM3 ?? null).toBeNull();
      // …and the model was told the sheets it reads are a part.
      expect((model.analyze.mock.calls[0]![0] as { foldedSheets?: boolean }).foldedSheets).toBe(true);
    });
  }

  it('control: [CI A, CI B] then the WHOLE packing list keeps its 507 kg / 5.92 m³ above the model', async () => {
    const chatId = collection('podklyuch');
    await forward(chatId, await B.sheetsBook([ciA, ciB]), 'AB.xlsx');
    await forward(chatId, await B.sheetsBook([plAll]), 'PL.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.fileTotals).toMatchObject({ weightKg: 507, volumeM3: 5.92 });
    model.analyze.mockResolvedValueOnce(readsTotals(343, 4.02));
    const out = await analyzeCollected(live);
    expect(out.facts.weightKg).toBe(507);
    expect(out.facts.volumeM3).toBe(5.92);
    expect((model.analyze.mock.calls[0]![0] as { foldedSheets?: boolean }).foldedSheets).toBeUndefined();
  });

  it('control: one workbook [CI A, PL A] — one factory, its own totals stand', async () => {
    const chatId = collection('podklyuch');
    await forward(chatId, await B.sheetsBook([ciA, plA]), 'A.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.fileTotals).toMatchObject({ weightKg: 343, volumeM3: 4.02 });
    model.analyze.mockResolvedValueOnce(readsTotals(1, 1));
    const out = await analyzeCollected(live);
    expect(out.facts.weightKg).toBe(343);
  });
});

describe('a sheet past the queue’s limit gives the model nothing, and its receipt says one thing (RF-TOTALS-3, RF-WORDS-5, RF-REGRESSION-2)', () => {
  const WORDS = ['Alfa', 'Bravo', 'Charli', 'Delta', 'Exo'];
  const factory = (z: number, n: number): (string | number | null)[][] =>
    Array.from({ length: n }, (_, k) => [
      k + 1,
      `${WORDS[z]}${String.fromCharCode(97 + (k % 26))}${String.fromCharCode(97 + (Math.floor(k / 26) % 26))} tovar`,
      (z + 1) * 1000 + k,
      1,
      10,
      2,
      2.2,
      0.1,
    ]);

  it('500 rows, then [Zavod 2 400, Zavod 3 150 + TOTAL]: Zavod 3’s TOTAL reaches no model, and no figure lands', async () => {
    const chatId = collection('podklyuch');
    await forward(chatId, await B.sheetsBook([['Zavod 1', B.INVOICE_HEAD, factory(0, 500)]]), 'one.xlsx');
    const z3 = factory(2, 150);
    z3.push(['TOTAL', null, null, null, null, 800, 2640, 120]);
    const answer = await forward(chatId, await B.sheetsBook([['Zavod 2', B.INVOICE_HEAD, factory(1, 400)], ['Zavod 3', B.INVOICE_HEAD, z3]]), 'two.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.invoiceGoods).toHaveLength(900);
    expect(answer.say).toContain('«Zavod 3» varag‘i qo‘shilmadi');
    expect(answer.say).not.toContain('to‘liq olindi');
    expect(live.invoiceTexts.some((t) => t.text.includes('2640'))).toBe(false);
    model.analyze.mockResolvedValueOnce(readsTotals(2640, 120));
    const out = await analyzeCollected(live);
    expect(JSON.stringify(model.analyze.mock.calls[0]![0])).not.toContain('2640');
    expect(out.facts.weightKg ?? null).toBeNull();
  });

  it('three factories of 400 in one book: the not-added sheet is never «tovarlar ro‘yxati to‘liq olindi»', async () => {
    const chatId = collection('podklyuch');
    const answer = await forward(
      chatId,
      await B.sheetsBook([0, 1, 2].map((z): Sheet => [`Zavod ${z + 1}`, B.INVOICE_HEAD, factory(z, 400)])),
      'zavodlar.xlsx',
    );
    expect(answer.say).toContain('«Zavod 3» varag‘i qo‘shilmadi');
    expect(answer.say).not.toContain('to‘liq olindi');
    expect((activeIntake(chatId)!.fileNotes ?? []).join('\n')).not.toContain('to‘liq olindi');
  });
});

describe('one factory’s subtotal beside a fold is not the shipment’s total (RF-TOTALS-6)', () => {
  const head = ['No.', 'Description', 'Quantity (pcs)', 'Unit price (USD)', 'Amount (USD)', 'N.W. (kg)', 'G.W. (kg)', 'CBM'];

  it('two files, a.xlsx under «Итого по разделу …», then b.xlsx: the model is told, its 343 does not land', async () => {
    const chatId = collection('podklyuch');
    const a: (string | number | null)[][] = [...B.invoiceRows(A), ['Итого по разделу Одежда', null, 800, null, 3930, 310, 343, 4.02]];
    await forward(chatId, await B.sheetsBook([['Inv', head, a]]), 'a.xlsx');
    await forward(chatId, await B.sheetsBook([['Inv', head, B.invoiceRows(Bf)]]), 'b.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.goodsFiles).toHaveLength(2);
    model.analyze.mockResolvedValueOnce(readsTotals(343, 4.02));
    const out = await analyzeCollected(live);
    const input = model.analyze.mock.calls[0]![0] as { foldedSheets?: boolean; contextSheets: { text: string }[] };
    expect(input.foldedSheets).toBe(true);
    expect(out.facts.weightKg ?? null).toBeNull();
    // The heading the model reads says the sheets are a part, never «только для итогов».
    const prompt = sheetsPromptText([], input.contextSheets as never, 100_000, true);
    expect(prompt).not.toContain('только для итогов');
    expect(prompt).toContain('НЕ общие');
  });

  it('one workbook [Zavod A, Zavod B + subtotal]: the same', async () => {
    const chatId = collection('podklyuch');
    const b: (string | number | null)[][] = [...B.invoiceRows(Bf), ['Итого по разделу Обувь', null, 920, null, 1660, 152, 164, 1.9]];
    await forward(chatId, await B.sheetsBook([['Zavod A', head, B.invoiceRows(A)], ['Zavod B', head, b]]), 'ab.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.invoiceGoods).toHaveLength(5);
    model.analyze.mockResolvedValueOnce(readsTotals(164, 1.9));
    const out = await analyzeCollected(live);
    expect((model.analyze.mock.calls[0]![0] as { foldedSheets?: boolean }).foldedSheets).toBe(true);
    expect(out.facts.weightKg ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The re-read that keeps the earlier reading (CRITIC-1), as fixed.
// ---------------------------------------------------------------------------

const good = (n: number) => ({ name: `Tovar ${n}`, quantity: n * 10, weightKg: null, volumeM3: null, tnvedCode: null, note: null });
const goods = (n: number) => Array.from({ length: n }, (_, k) => good(k + 1));
const cutAt = (n: number) => ({ ok: true, facts: { goods: goods(n) }, steps: [], usage: BILL, answered: [BILL], cut: { goods: n, why: 'clock' } });
const KEPT_7 = '⚠️ Qayta o‘qishda AI avvalgidan kam o‘qidi — avvalgi o‘qishdagi 7 ta tovar qoldi.';
const MISSING_1 = '⚠️ 1 ta fayl saqlangan joydan olinmadi — «🔄 AI qayta o‘qisin» ni bosing.';
type Files = { images: never[]; pdfs: { data: Buffer; name: string }[]; missing: number };
const pdf = (name: string) => ({ data: Buffer.from('%PDF-1.4'), name });

function fakeCtx() {
  const replies: { text: string }[] = [];
  return {
    replies,
    texts: () => replies.map((r) => r.text),
    async reply(text: string) {
      replies.push({ text });
      return { message_id: 100 + replies.length };
    },
  };
}

/** One reading of the live collection, settled onto it as the job does. */
async function readAndSettle(chatId: bigint, answer: unknown, files?: Files): Promise<IntakeState> {
  model.analyze.mockResolvedValueOnce(answer);
  const token = `t-${Math.random()}`;
  const snapshot = updateIntake(chatId, { analysing: token })!;
  const analysed = await analyzeCollected(snapshot, files as never);
  const settled = settleAnalysis(activeIntake(chatId), snapshot, analysed, token);
  if (settled.kind !== 'done') throw new Error(`settle: ${settled.kind}`);
  return updateIntake(chatId, settled.state)!;
}

function reReadCollection(patch: Partial<IntakeState> = {}, ai = true): bigint {
  return collection('rastamojka', { clientHintRaw: 'GS777', material: ['erkin matn'], ...patch }, ai);
}

describe('new material after the press is a new reading (RF-TOTALS-4 b)', () => {
  it('«🔄», then «Shapka qora 50 dona» before the job: the line is read, and the new cut earns its own «🔄»', async () => {
    const chatId = reReadCollection();
    await readAndSettle(chatId, cutAt(7));
    updateIntake(chatId, { stage: 'review' });
    await handleCalcCallback(fakeCtx(), chatId, 'reread');
    expect(activeIntake(chatId)!.aiCutRetried).toBe(true);
    const live = activeIntake(chatId)!;
    updateIntake(chatId, { material: [...live.material, 'Shapka qora 50 dona'] });
    const after = await readAndSettle(chatId, cutAt(2));
    const names = (after.facts.goods ?? []).map((g) => g.name);
    expect(names.slice(0, 2)).toEqual(['Tovar 1', 'Tovar 2']);
    expect(names.some((n) => /Shapka/u.test(n))).toBe(true);
    expect(after.notes).not.toContain(KEPT_7);
    expect(after.aiCutRetried).toBe(false);
    expect(notWholeRetry(after as never)).toBe(true);
  });
});

describe('a kept re-read says what THIS reading found of the files (RF-TOTALS-4 a, RF-WORDS-2, RF-REGRESSION-4)', () => {
  const twoPdfs: Partial<IntakeState> = {
    material: [],
    pdfs: [
      { attachmentId: 'p1', name: 'inv1.pdf', bytes: 10 },
      { attachmentId: 'p2', name: 'inv2.pdf', bytes: 10 },
    ],
    fileCount: 2,
  };

  it('a file missing at the first reading and handed back at the re-read: «saqlangan joydan olinmadi» is gone', async () => {
    const chatId = reReadCollection(twoPdfs);
    const first = await readAndSettle(chatId, cutAt(7), { images: [], pdfs: [pdf('inv1.pdf')], missing: 1 });
    expect(first.notes).toContain(MISSING_1);
    updateIntake(chatId, { aiCutRetried: true });
    const after = await readAndSettle(chatId, cutAt(2), { images: [], pdfs: [pdf('inv1.pdf'), pdf('inv2.pdf')], missing: 0 });
    expect(after.facts.goods).toHaveLength(7);
    expect(after.filesMissing).toBe(0);
    expect(after.notes.join('\n')).not.toContain('saqlangan joydan olinmadi');
    expect(after.notes).toContain(KEPT_7);
  });

  it('a file lost at the re-read: the table names it and the «🔄», and the AI is not blamed', async () => {
    const chatId = reReadCollection(twoPdfs);
    await readAndSettle(chatId, cutAt(7), { images: [], pdfs: [pdf('inv1.pdf'), pdf('inv2.pdf')], missing: 0 });
    updateIntake(chatId, { aiCutRetried: true });
    const after = await readAndSettle(chatId, cutAt(2), { images: [], pdfs: [pdf('inv1.pdf')], missing: 1 });
    expect(after.facts.goods).toHaveLength(7);
    expect(after.notes).toContain(MISSING_1);
    expect(after.notes).toContain('⚠️ Qayta o‘qishda avvalgi o‘qishdagi 7 ta tovar qoldi.');
    expect(after.notes).not.toContain(KEPT_7);
    expect(notWholeRetry(after as never)).toBe(true);
  });

  it('a lone PDF that does not load at the re-read (files_missing): the same', async () => {
    const chatId = reReadCollection({ material: [], pdfs: [{ attachmentId: 'p1', name: 'inv.pdf', bytes: 10 }], fileCount: 1 });
    await readAndSettle(chatId, cutAt(7), { images: [], pdfs: [pdf('inv.pdf')], missing: 0 });
    updateIntake(chatId, { aiCutRetried: true });
    const after = await readAndSettle(chatId, { ok: false, failure: 'nothing_to_read' }, { images: [], pdfs: [], missing: 1 });
    expect(after.facts.goods).toHaveLength(7);
    expect(after.notes).toContain(MISSING_1);
    expect(after.notes).not.toContain(KEPT_7);
  });
});

describe('the keep sentence is said once (RF-WORDS-7, RF-REGRESSION-5)', () => {
  it('plain door: cut after 7, then two stale «Bo‘ldi» readings cut after 2 and 3 — one line', async () => {
    const chatId = reReadCollection({}, false);
    await readAndSettle(chatId, cutAt(7));
    updateIntake(chatId, { aiCutRetried: true });
    await readAndSettle(chatId, cutAt(2));
    updateIntake(chatId, { aiCutRetried: true });
    const after = await readAndSettle(chatId, cutAt(3));
    expect(after.facts.goods).toHaveLength(7);
    expect(after.notes.filter((n) => n === KEPT_7)).toHaveLength(1);
  });
});

describe('a seeded AI collection keeps its better reading too (RF-TOTALS-5, RF-REGRESSION-6)', () => {
  it('seed [Eski tovar A, B], cut after 7, «🔄», cut after 2: the 2 + 7 stay, and it is said', async () => {
    const seed = [
      { name: 'Eski tovar A', quantity: 5, weightKg: null, volumeM3: null, tnvedCode: null, note: null },
      { name: 'Eski tovar B', quantity: 6, weightKg: null, volumeM3: null, tnvedCode: null, note: null },
    ];
    const chatId = reReadCollection({ seed: seed as never, seedDoor: 'ai' as never });
    const first = await readAndSettle(chatId, cutAt(7));
    const firstNames = (first.facts.goods ?? []).map((g) => g.name);
    expect(firstNames).toHaveLength(9);
    updateIntake(chatId, { stage: 'review' });
    await handleCalcCallback(fakeCtx(), chatId, 'reread');
    expect(readingsEnqueued(chatId)).toHaveLength(1);
    const after = await readAndSettle(chatId, cutAt(2));
    expect((after.facts.goods ?? []).map((g) => g.name)).toEqual(firstNames);
    expect(after.aiCut).toEqual({ goods: 7, why: 'clock' });
    expect(after.notes).toContain(KEPT_7);
  });
});

// ---------------------------------------------------------------------------
// A cut answer and the typed lines it renamed (RF-REGRESSION-1).
// ---------------------------------------------------------------------------

describe('a typed line the cut answer wrote in Russian is listed once (RF-REGRESSION-1)', () => {
  const line = (name: string, quantity: number, volumeM3: number | null = null) => ({ name, quantity, weightKg: null, volumeM3, tnvedCode: null, note: null });
  const pick = (model: ReturnType<typeof line>[], typed: ReturnType<typeof line>[]) =>
    pickGoods({ invoice: [], aiGoods: null, model, typed, typedLabelled: typed, cut: true }).goods.map((g) => g.name);

  it('«Erkaklar shimi 50 dona 2 kub» read as «Брюки мужские» 50 / 2 m³: once; the line not reached stays', () => {
    expect(
      pick([line('Брюки мужские', 50, 2)], [line('Erkaklar shimi', 50, 2), line('Ayollar kurtkasi', 30, 1)]),
    ).toEqual(['Брюки мужские', 'Ayollar kurtkasi']);
  });

  it('through the reading: two goods typed, the cut answer reached one — two goods, 3 m³ of lines, not 5', async () => {
    const chatId = collection('rastamojka', { material: ['Erkaklar shimi 50 dona 2 kub', 'Ayollar kurtkasi 30 dona 1 kub'] });
    model.analyze.mockResolvedValueOnce({
      ok: true,
      facts: { goods: [line('Брюки мужские', 50, 2)] },
      steps: [],
      usage: BILL,
      answered: [BILL],
      cut: { goods: 1, why: 'clock' },
    });
    const out = await analyzeCollected(activeIntake(chatId)!);
    const rows = out.facts.goods ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.reduce((n, g) => n + (g.volumeM3 ?? 0), 0)).toBe(3);
  });

  it('a count alone across scripts says nothing: «Tovar 5» 50 beside «Erkaklar shimi 50 dona» are two goods', () => {
    expect(pick([line('Tovar 4', 40), line('Tovar 5', 50)], [line('Erkaklar shimi', 50)])).toEqual(['Tovar 4', 'Tovar 5', 'Erkaklar shimi']);
    expect(pick([line('Брюки мужские', 50)], [line('Erkaklar shimi', 50)])).toEqual(['Брюки мужские', 'Erkaklar shimi']);
  });

  it('two typed lines the figures cannot tell apart are kept both — never one dropped at a guess', () => {
    expect(pick([line('Брюки мужские', 50, 2)], [line('Erkaklar shimi', 50, 2), line('Ayollar shimi', 50, 2)])).toEqual([
      'Брюки мужские',
      'Erkaklar shimi',
      'Ayollar shimi',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The files refused, as the table and the card name them.
// ---------------------------------------------------------------------------

describe('a name the bot made up is a word, never a quoted file (RF-WORDS-9, RF-REGRESSION-9)', () => {
  it('«rasm», «fayl»: bare, singular', () => {
    expect(refusedFileLines([{ name: 'rasm', why: '12 tadan ortiq rasm' }, { name: 'fayl', why: 'Word fayl' }])).toEqual([
      'rasm o‘qilmadi (12 tadan ortiq rasm) — undagi tovarlar hisobga kirmaydi.',
      'fayl o‘qilmadi (Word fayl) — undagi tovarlar hisobga kirmaydi.',
    ]);
    expect(refusedFilesNote([{ name: 'rasm', why: '12 tadan ortiq rasm' }])).toBe(
      '⚠️ O‘qilmagan fayllar (tovarlari hisobga kirmagan): rasm — 12 tadan ortiq rasm',
    );
  });
});

describe('the card counts the rest as the table does (RF-WORDS-10)', () => {
  it('five Word files, a HEIC and «9 ta rasm»: yana 1 ta (HEIC rasm), yana 9 ta (12 tadan ortiq rasm) — on both', () => {
    const list = [
      ...Array.from({ length: 5 }, (_, i) => ({ name: `d${i}.docx`, why: 'Word fayl' })),
      { name: 'f.heic', why: 'HEIC rasm' },
      { name: '9 ta rasm', why: '12 tadan ortiq rasm' },
    ];
    const table = refusedFileLines(list);
    expect(table).toContain('Yana 1 ta fayl o‘qilmadi (HEIC rasm) — ulardagi tovarlar hisobga kirmaydi.');
    expect(table).toContain('Yana 9 ta fayl o‘qilmadi (12 tadan ortiq rasm) — ulardagi tovarlar hisobga kirmaydi.');
    expect(refusedFilesNote(list)).toMatch(/; yana 1 ta \(HEIC rasm\), yana 9 ta \(12 tadan ortiq rasm\)$/u);
  });
});

describe('a refusal is never deleted on a name (RF-FILES-1)', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const pictureOnly = () =>
    B.bookOf((wb) => {
      const ws = wb.addWorksheet('Rasm');
      const id = wb.addImage({ buffer: png as unknown as ArrayBuffer, extension: 'png' });
      ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 40, height: 40 } });
    });

  it('factory A’s picture-only «装箱单.xlsx», then factory B’s real one: A stays named, as an earlier copy', async () => {
    const chatId = collection('rastamojka');
    await forward(chatId, await pictureOnly(), '装箱单.xlsx');
    await forward(chatId, await B.sheetsBook([ciB]), '装箱单.xlsx');
    const live = activeIntake(chatId)!;
    expect(live.invoiceGoods).toHaveLength(2);
    expect(live.refusedFiles).toEqual([{ name: '装箱单.xlsx', why: 'ichida faqat rasm, jadval yo‘q', resent: true }]);
    const named = aiReadingWhole(live as never, 2).named;
    expect(refusedFileLines(named)).toEqual([
      '«装箱单.xlsx» (avvalgi nusxa) o‘qilmadi (ichida faqat rasm, jadval yo‘q) — keyin shu nomli fayl olindi.',
    ]);
    expect(refusedFilesNote(named)).toBe(
      '⚠️ O‘qilmagan fayllar (tovarlari hisobga kirmagan): «装箱单.xlsx» (avvalgi nusxa; keyin shu nomli fayl olindi) — ichida faqat rasm, jadval yo‘q',
    );
  });
});

describe('an API-refused PDF and its password-free copy (RF-WORDS-4, RF-FILES-3)', () => {
  const pdfs = [
    { attachmentId: 'pdf-1', name: 'invoice.pdf', bytes: 10 },
    { attachmentId: 'pdf-2', name: 'invoice.pdf', bytes: 10 },
  ];
  const read = { ok: true, facts: { goods: [good(1), good(2)] }, steps: [], usage: BILL, answered: [BILL] };

  it('refused at reading 1, the copy taken after it: the demotion names an earlier copy', async () => {
    const chatId = collection('rastamojka', { material: [], pdfs, unreadPdfs: ['pdf-1'], fileCount: 2 });
    model.analyze.mockResolvedValueOnce(read);
    const out = await analyzeCollected(activeIntake(chatId)!, { images: [], pdfs: [pdf('invoice.pdf')], missing: 0 });
    expect(out.refusedFiles).toEqual([{ name: 'invoice.pdf', why: 'AI qabul qilmadi', resent: true }]);
    expect(refusedFileLines(out.refusedFiles ?? []).join('\n')).not.toContain('undagi tovarlar hisobga kirmaydi');
  });

  it('control: no copy after it, or a copy refused too — plainly «o‘qilmadi»', async () => {
    const alone = collection('rastamojka', { material: [], pdfs: pdfs.slice(0, 1), unreadPdfs: ['pdf-1'], fileCount: 1 });
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'nothing_to_read' });
    expect((await analyzeCollected(activeIntake(alone)!)).refusedFiles).toEqual([{ name: 'invoice.pdf', why: 'AI qabul qilmadi' }]);
    const both = collection('rastamojka', { material: [], pdfs, unreadPdfs: ['pdf-1'], fileCount: 2 });
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'rejected', unreadPdfs: ['pdf-2'] });
    expect((await analyzeCollected(activeIntake(both)!, { images: [], pdfs: [pdf('invoice.pdf')], missing: 0 })).refusedFiles).toEqual([
      { name: 'invoice.pdf', why: 'AI qabul qilmadi' },
    ]);
  });
});
