import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { driveReading, readingsEnqueued, resetReadingDrive } from '../fixtures/calc-read-drive';
import { bodyOf, read } from '../fixtures/source-shape';

/**
 * docs/FAYL-OQISH.md §1-§2 (P-door), his 2026-11-10 «fillarni oldin korib
 * chiqib togridan togri tasdiq deyabti»: on the AI door «✅ Tasdiqlash» is
 * drawn only over a reading that read everything it accepted, and every word
 * and button that names the confirm asks the same wholeness. The states are
 * BUILT here — the reading's own fields (aiCut, unreadPdfs, filesMissing, …)
 * are another package's to write (§10); this file pins what the table, the
 * keyboard, the words and the landing do with them.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
const budget = vi.hoisted(() => ({ available: true }));
vi.mock('@/modules/wms/calc/ai-cost', () => ({
  aiCalcBudgetLeft: async () => 100,
  aiCalcAvailable: async () => budget.available,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
// The save branch's failed landing (door-spec-drawers-call-sites-unpinned):
// a staff member to land for, and a landing that throws — only while a test
// asks for it; otherwise the real ones.
const landing = vi.hoisted(() => ({ fail: false }));
vi.mock('@/modules/platform/telegram/staff-bot', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/platform/telegram/staff-bot')>();
  return {
    ...real,
    staffForChat: async (chatId: bigint) => (landing.fail ? { id: 'staff-test', fullName: 'Sotuvchi' } : real.staffForChat(chatId)),
    landCollectedIntake: async (...args: Parameters<typeof real.landCollectedIntake>) => {
      if (landing.fail) throw new Error('database blip');
      return real.landCollectedIntake(...args);
    },
  };
});

import { activeIntake, endIntake, filesMissingNote, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import {
  AI_QUEUED,
  deliverNextStep,
  landingPress,
  landingReplyText,
  landingRetryWords,
  pressCertificate,
  routeCollectorText,
  tableEditsSettled,
  vedQueuedText,
} from '@/modules/platform/telegram/calc-dialog';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { deliverStoredReply, noticeKindOf, READING_NOTICE, runIntakeRead, settleAnalysis } from '@/modules/platform/telegram/calc-read';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { markIntakesHydrated } from '@/modules/platform/telegram/calc-store';
import { CALC_STEP_REPEAT, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { addReadingUnread, amendSubmissionOf, unreadRepassLine } from '@/modules/platform/telegram/calc-amend';
import {
  AI_FILES_REFUSED,
  AI_GOODS_ROW_UNREAD,
  AI_NO_GOODS,
  AI_TABLE_COMPLETE,
  cutNoteText,
  intakeNoteText,
  readInsteadWords,
  refusedFileLines,
  vedLandingNote,
  vedLandingReason,
} from '@/modules/wms/calc/intake';
import { fitTelegram, TELEGRAM_LIMIT } from '@/modules/wms/calc/fit-telegram';
import { landingOwesPass } from '@/modules/wms/calc/intake-land';
import { aiReadingWhole } from '@/modules/platform/telegram/reading-whole';
import { aiVedReplyText, NO_GOODS_CUSTOMS } from '@/modules/wms/calc/ai-reply';
import { aiNoteText } from '@/modules/wms/calc/ai-note';
import { amendDiff } from '@/modules/wms/calc/amend';
import type { AmendBase } from '@/modules/wms/calc/amend-types';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}, amend: AmendBase | null = null) {
  seq += 1;
  const chatId = BigInt(-9_900_500_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test', amend });
  return { chatId, state: updateIntake(chatId, { stage: 'review', ai: true, ...patch })! };
}

type Sent = { id: number; text: string; extra?: Record<string, unknown> };
function fakeCtx() {
  let next = 100;
  const replies: Sent[] = [];
  return {
    replies,
    async reply(text: string, extra?: Record<string, unknown>) {
      next += 1;
      replies.push({ id: next, text, extra });
      return { message_id: next };
    },
    api: {
      async editMessageText() {
        return true;
      },
      async setMessageReaction() {
        return true;
      },
    },
  };
}
const buttons = (sent: Sent | undefined) =>
  ((sent?.extra?.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
const data = (sent: Sent | undefined) => buttons(sent).map((b) => b.callback_data);

/** The table, as a reading sends it. */
async function drawn(chatId: bigint) {
  const ctx = fakeCtx();
  await deliverNextStep(ctx, chatId, activeIntake(chatId)!);
  return ctx.replies.at(-1)!;
}

const FULL = { weightKg: 3500, volumeM3: 12 };
const PDF = { attachmentId: 'pdf-1', name: 'invoice.pdf', bytes: 10 };
const PHOTO = { attachmentId: 'img-1', mediaType: 'image/jpeg' as const };
const TWO = [line('Kurtka', { quantity: 300, tnvedCode: '6201400000' }), line('Sumka', { quantity: 20, tnvedCode: '4202920000' })];
const NOT_WHOLE_PRESS = '«👤 VED hisoblasin»';

beforeEach(() => {
  model.analyze.mockReset();
  resetReadingDrive();
  budget.available = true;
});
afterEach(async () => {
  await tableEditsSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

/** No «✅ Tasdiqlash» anywhere on it — neither the button nor the words (§1.5). */
function noConfirm(table: Sent) {
  expect(data(table)).not.toContain('c:save');
  expect(table.text).not.toContain('«✅ Tasdiqlash»');
  expect(data(table)).toContain('c:to_ved');
}

describe('the AI table over a reading that is not whole (§1.2)', () => {
  it('zero rows after a file the model could not read: «fayldan o‘qilmadi», the reason once, 🔄 where it helps — no ✅', async () => {
    const { chatId } = collection({ fileCount: 1, pdfs: [PDF], aiUsed: false, aiFailure: 'timeout', facts: FULL });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('Tovarlar (0):\n⚠️ tovar — fayldan o‘qilmadi');
    expect(table.text).not.toContain('tovar nomi — yozilmagan');
    expect(table.text).toContain('\n⚠️ Fayldan tovar o‘qilmadi.\n');
    // The reason is the tail's failure block, said ONCE (critic-said-twice).
    expect(table.text.split('AI belgilangan vaqtda javob bermadi').length).toBe(2);
    expect(data(table)[0]).toBe('c:reread');
    expect(table.text).toContain('«🔄 AI qayta o‘qisin» ni bosing, yoki faylni Excel qilib');
    expect(data(table)).toEqual(['c:reread', 'c:cert_n', 'c:more', 'c:to_ved', 'c:cancel']);
  });

  it('zero rows after a file the model READ and found nothing in: its own words, no 🔄', async () => {
    const { chatId } = collection({ fileCount: 1, pdfs: [PDF], aiUsed: true, aiFailure: null, facts: FULL });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('⚠️ AI yuborilgan fayllardan tovar topa olmadi.');
    expect(data(table)).not.toContain('c:reread');
    expect(table.text).toContain('Faylni Excel qilib / tovarlarni yozib «➕ Yana ma’lumot» bilan yuboring. Yoki «👤 VED hisoblasin» — VED xodimi fayllarni o‘zi ko‘rib hisoblaydi (AI hisoblamaydi).');
  });

  it('zero rows and no file: «Tovar nomi yozilmagan.» — the old goods row stays, the shared legacy constant does not move', async () => {
    const { chatId } = collection({ material: ['salom'], aiUsed: true, facts: FULL });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('⚠️ tovar nomi — yozilmagan');
    expect(table.text).toContain(`\n${AI_NO_GOODS}\n`);
    expect(table.text).not.toContain('tovarlarni «➕ Yana ma’lumot» bilan yuboring.\nBilmagan');
  });

  it('rows from the Excel beside a PDF the model never read: named, and no ✅ (the commonest not-whole table)', async () => {
    const { chatId } = collection({
      fileCount: 2,
      pdfs: [PDF],
      invoiceGoods: TWO,
      aiUsed: false,
      aiFailure: 'not_configured',
      facts: { ...FULL, goods: TWO },
    });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('⚠️ 2 ta tovar Excel’dan olindi; 1 ta PDF o‘qilmadi.');
    // No key is no retry: «🔄» is never named where it is not drawn.
    expect(data(table)).not.toContain('c:reread');
    expect(table.text).not.toContain('🔄 AI qayta o‘qisin');
    expect(table.text).not.toContain(AI_TABLE_COMPLETE);
  });

  it('a photo and a typed list: «yozilganidan», «1 ta rasm»', async () => {
    const { chatId } = collection({
      images: [PHOTO],
      material: ['Kurtka 300 dona\nSumka 20 dona'],
      aiUsed: false,
      aiFailure: 'overloaded',
      facts: { ...FULL, goods: TWO },
    });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('⚠️ 2 ta tovar yozilganidan olindi; 1 ta rasm o‘qilmadi.');
    expect(data(table)[0]).toBe('c:reread');
  });

  it('a CLOCK cut: what was read, «🔄» once per material mark', async () => {
    const { chatId } = collection({
      fileCount: 1,
      pdfs: [PDF],
      aiUsed: true,
      aiCut: { goods: 2, why: 'clock' },
      facts: { ...FULL, goods: TWO },
    });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('⚠️ AI faylni oxirigacha o‘qib ulgurmadi — 2 ta tovar o‘qildi, qolgani o‘qilmadi.');
    expect(data(table)[0]).toBe('c:reread');
    updateIntake(chatId, { aiCutRetried: true });
    const again = await drawn(chatId);
    expect(data(again)).not.toContain('c:reread');
    expect(again.text).not.toContain('🔄 AI qayta o‘qisin');
  });

  it('a SIZE cut never draws «🔄» (review #21)', async () => {
    const { chatId } = collection({ fileCount: 1, pdfs: [PDF], aiUsed: true, aiCut: { goods: 2, why: 'size' }, facts: { ...FULL, goods: TWO } });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('⚠️ Material juda katta — 2 ta tovar o‘qildi, qolgani o‘qilmadi. Kamroq sahifa yoki Excel yuboring.');
    expect(data(table)).not.toContain('c:reread');
  });

  it('a capped Excel: «birinchi 500 qatori» — the reader counted no rest', async () => {
    const capped = { label: 'katta.xlsx', shape: 'invoice' as const, weightKind: null, grossKg: null, grossColumn: false, volumeM3: null, rows: 500, text: null, capped: true as const };
    const { chatId } = collection({ fileCount: 1, invoiceGoods: TWO, goodsFiles: [capped], aiUsed: true, facts: { ...FULL, goods: TWO } });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('⚠️ «katta.xlsx» jadvalining birinchi 500 qatori o‘qildi.');
  });

  it('a sheet the model was shown only part of: «kept/total», measured by the reader’s own fit', async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `Tovar ${i} | ${i} | dona`).join('\n');
    const { chatId } = collection({
      fileCount: 1,
      sheetTexts: [{ text: rows, cut: false, cellsCut: false, label: 'uzun.csv' }],
      aiUsed: true,
      aiInputCut: true,
      facts: { ...FULL, goods: TWO },
    });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toMatch(/⚠️ «uzun\.csv» jadvalining \d+\/4000 qatori o‘qildi\./u);
  });

  it('a file storage did not hand back: its count and «🔄», the generic words never beside them', async () => {
    const { chatId } = collection({ fileCount: 1, pdfs: [PDF], aiUsed: false, aiFailure: 'files_missing', filesMissing: 1, facts: FULL });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('⚠️ 1 ta fayl saqlangan joydan olinmadi — «🔄 AI qayta o‘qisin» ni bosing.');
    expect(table.text).not.toContain('Yuborilgan fayl saqlangan joydan olinmadi.');
    expect(data(table)[0]).toBe('c:reread');
    // The press named ONCE (door-break-6): the remedy under it starts at «Faylni …».
    expect(table.text.split('«🔄 AI qayta o‘qisin»').length - 1).toBe(1);
    expect(table.text).toContain(`Faylni Excel qilib / tovarlarni yozib «➕ Yana ma’lumot» bilan yuboring. Yoki ${NOT_WHOLE_PRESS}`);
  });

  it('a retryable failure the tail does not name «🔄» for keeps the remedy’s «🔄» lead', async () => {
    const { chatId } = collection({ fileCount: 1, pdfs: [PDF], aiUsed: false, aiFailure: 'timeout', facts: FULL });
    const table = await drawn(chatId);
    expect(table.text).toContain('«🔄 AI qayta o‘qisin» ni bosing, yoki faylni Excel qilib');
  });

  it('a PDF the API refused is named on the table, every time it is drawn', async () => {
    const { chatId } = collection({ fileCount: 2, pdfs: [PDF], unreadPdfs: ['pdf-1'], invoiceGoods: TWO, aiUsed: true, facts: { ...FULL, goods: TWO } });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('📄 «invoice.pdf» — AI bu faylni qabul qilmadi');
  });
});

describe('a whole AI table keeps today’s words (§1.2, critic-pins)', () => {
  it('complete: AI_TABLE_COMPLETE and «✅ Tasdiqlash»', async () => {
    const { chatId } = collection({ fileCount: 1, invoiceGoods: TWO, aiUsed: true, facts: { ...FULL, goods: TWO } });
    const table = await drawn(chatId);
    expect(data(table)).toContain('c:save');
    expect(data(table)).not.toContain('c:to_ved');
    expect(table.text.split('\n').at(-1)).toBe(AI_TABLE_COMPLETE);
  });

  it('a file refused at arrival is NAMED with its reason, and «✅ Tasdiqlash» stays (§1.1, critic-refused-unread)', async () => {
    const { chatId } = collection({
      fileCount: 1,
      invoiceGoods: TWO,
      aiUsed: true,
      refusedFiles: [{ name: 'shartnoma.docx', why: 'Word fayl o‘qilmaydi.' }],
      facts: { ...FULL, goods: TWO },
    });
    const table = await drawn(chatId);
    expect(data(table)).toContain('c:save');
    expect(table.text).toContain('«shartnoma.docx» o‘qilmadi (Word fayl o‘qilmaydi) — undagi tovarlar hisobga kirmaydi.');
    expect(table.text.split('\n').at(-1)).toBe(AI_TABLE_COMPLETE);
  });

  it('a NULL-door seeded zero-row table keeps today’s keyboard and closing (§1.0, critic-door-predicate)', async () => {
    const { chatId } = collection({ seed: [], seedDoor: null, seededFrom: 'r-1', fileCount: 1, facts: FULL });
    const table = await drawn(chatId);
    expect(data(table)).toContain('c:save');
    expect(data(table)).not.toContain('c:to_ved');
    expect(table.text).toContain('⚠️ Tovar nomi yozilmagan — tovarlarni «➕ Yana ma’lumot» bilan yuboring.');
  });

  it('an AI-door SEEDED collection that came back with no rows is not whole: «👤», never «✅»', async () => {
    const { chatId } = collection({ seed: [], seedDoor: 'ai', seededFrom: 'r-2', facts: FULL });
    const table = await drawn(chatId);
    noConfirm(table);
  });
});

describe('every word that names the confirm asks the same wholeness (door-closing-drawers)', () => {
  const notWhole = () =>
    collection({ fileCount: 1, pdfs: [PDF], invoiceGoods: TWO, aiUsed: false, aiFailure: 'not_configured', facts: { ...FULL, goods: TWO } });

  it('landingPress: «👤 VED hisoblasin» on a not-whole AI table, «✅ Tasdiqlash» on a whole one, the add door’s own on an addition', () => {
    expect(landingPress(notWhole().state)).toEqual({ step: 'to_ved', label: '👤 VED hisoblasin', name: NOT_WHOLE_PRESS });
    expect(landingPress(collection({ invoiceGoods: TWO, facts: { ...FULL, goods: TWO } }).state).step).toBe('save');
    // A plain door and a NULL door never draw «👤».
    expect(landingPress(collection({ ai: false, fileCount: 1, pdfs: [PDF], facts: FULL }).state).step).toBe('save');
  });

  it('the courtesy-word nudge names the press that is drawn', async () => {
    const { chatId } = notWhole();
    const ctx = fakeCtx();
    await routeCollectorText(ctx, chatId, activeIntake(chatId)!, 'rahmat', { date: 0, messageId: 77, forwarded: false, replyTo: null });
    expect(ctx.replies.at(-1)!.text).toBe(`VED ga yuborish uchun ${NOT_WHOLE_PRESS} ni bosing. Yana ma’lumot bo‘lsa — yuboring.`);
  });

  it('the certificate’s fallback reply carries the table’s own buttons — no ✅', async () => {
    const { chatId } = notWhole();
    const ctx = fakeCtx();
    await pressCertificate(ctx, chatId, false);
    const reply = ctx.replies.at(-1)!;
    expect(data(reply)).toEqual(['c:cert_y', 'c:more', 'c:to_ved', 'c:cancel']);
  });

  it('an answer on a not-whole AI table: no echo with a confirm — the table it edits carries «c:to_ved», never «c:save»', async () => {
    // The AI door commits every answer quietly (docs/IKKI-ESHIK.md §3.4): a
    // 👍 and the table's own block, so what names the confirm after an answer
    // is the TABLE's keyboard and closing, redrawn — never an echo's.
    const goods = [
      line('Kurtka', { quantity: 300, tnvedCode: '6201400000' }),
      line('Sumka', { tnvedCode: '4202920000' }),
      line('Shim', { tnvedCode: '6203420000' }),
    ];
    const { chatId } = collection({ fileCount: 1, pdfs: [PDF], aiUsed: false, aiFailure: 'not_configured', facts: { ...FULL, goods } });
    const ctx = fakeCtx();
    const edits: Sent[] = [];
    ctx.api.editMessageText = (async (_chat: string, id: number, text: string, extra?: Record<string, unknown>) => {
      edits.push({ id, text, extra });
      return true;
    }) as typeof ctx.api.editMessageText;
    await deliverNextStep(ctx, chatId, activeIntake(chatId)!);
    const table = ctx.replies.at(-1)!;
    for (const [n, answer] of [[701, '2: 20 dona'], [702, '3: 10 dona']] as const) {
      await routeCollectorText(ctx, chatId, activeIntake(chatId)!, answer, { date: 0, messageId: n, forwarded: false, replyTo: null });
      await tableEditsSettled();
    }
    // Nothing but the table was ever sent: no echo, so no echo's «✅».
    expect(ctx.replies).toEqual([table]);
    const now = edits.filter((e) => e.id === table.id).at(-1)!;
    expect(now.text).toContain('2. Sumka — 20 dona');
    expect(data(now)).toContain('c:to_ved');
    expect(data(now)).not.toContain('c:save');
    expect(now.text).toContain(NOT_WHOLE_PRESS);
    expect(now.text).not.toContain('«✅ Tasdiqlash»');
  });

  it('the echo’s confirm and its «what is still open» name the press through `landingPress` alone (a fence: no literal of its own)', () => {
    const dialog = read('src/modules/platform/telegram/calc-dialog.ts');
    const rows = bodyOf(dialog, 'function confirmRows(');
    expect(rows).toContain('const press = landingPress(state);');
    expect(rows).toContain('callback_data: `c:${press.step}`');
    expect(rows).not.toMatch(/Tasdiqlash|c:save/u);
    const missing = bodyOf(dialog, 'function missingLines(');
    expect(missing).not.toMatch(/Tasdiqlash|c:save/u);
    expect(missing.match(/confirmName\(state\)/gu)?.length).toBe(2);
    expect(dialog).toContain('const confirmName = (state: IntakeState) => landingPress(state).name;');
  });

  it('the save branch’s failed landing names «👤» — pressed «👤», or «✅» over a reading that is not whole', async () => {
    landing.fail = true;
    try {
      for (const step of ['to_ved', 'save'] as const) {
        const { chatId } = notWhole();
        updateIntake(chatId, { clientHintRaw: 'GS777' });
        const ctx = fakeCtx();
        await handleCalcCallback(ctx, chatId, step);
        expect(ctx.replies.at(-1)!.text, step).toBe(`Saqlab bo‘lmadi — ${NOT_WHOLE_PRESS} ni qayta bosing.`);
      }
    } finally {
      landing.fail = false;
    }
  });

  it('the failed landing’s retry names the press that was made', () => {
    const { state } = notWhole();
    expect(landingRetryWords(state)).toBe(`Saqlab bo‘lmadi — ${NOT_WHOLE_PRESS} ni qayta bosing.`);
    // «👤» pressed on a table that has since become whole: still the VED's.
    const whole = collection({ invoiceGoods: TWO, facts: { ...FULL, goods: TWO }, landAs: 'ved' }).state;
    expect(landingRetryWords(whole)).toBe(`Saqlab bo‘lmadi — ${NOT_WHOLE_PRESS} ni qayta bosing.`);
    expect(landingRetryWords({ ...whole, landAs: 'ai' })).toBe('Saqlab bo‘lmadi — «✅ Tasdiqlash» ni qayta bosing.');
  });

  it('the derived fence: «c:to_ved» parses, and repeats as «c:save» does', () => {
    expect(parseCallback('c:to_ved')).toEqual({ kind: 'calc', step: 'to_ved' });
    expect(CALC_STEP_REPEAT.to_ved).toBe(CALC_STEP_REPEAT.save);
  });
});

describe('the tail says what WAS read (§2.2, critic-tail-both)', () => {
  it('four cases: Excel and typed (today’s words), Excel only, typed only, neither', () => {
    expect(readInsteadWords({ material: ['Kurtka'], invoiceGoods: TWO })).toBe('Faqat Excel va yozilganidan o‘qildi.');
    expect(readInsteadWords({ material: ['  '], invoiceGoods: TWO })).toBe('Faqat Excel’dan o‘qildi.');
    expect(readInsteadWords({ material: ['Kurtka'], invoiceGoods: [] })).toBe('Faqat yozilganidan o‘qildi.');
    expect(readInsteadWords({ material: [], invoiceGoods: [] })).toBe('Hech narsa o‘qilmadi.');
  });

  it('neither read, yet rows on the table — the returned request’s own: the line is left out (door-break-7)', async () => {
    expect(readInsteadWords({ material: [], invoiceGoods: [] }, 2)).toBeNull();
    const { chatId } = collection({ seed: TWO, seedDoor: 'ai', seededFrom: 'r-7', fileCount: 1, images: [PHOTO], aiUsed: false, aiFailure: 'timeout', facts: { ...FULL, goods: TWO } });
    const table = await drawn(chatId);
    expect(table.text).toContain('⚠️ AI belgilangan vaqtda javob bermadi.');
    expect(table.text).not.toContain('Hech narsa o‘qilmadi.');
    expect(table.text).toContain('⚠️ 2 ta tovar so‘rovdan olindi; 1 ta rasm o‘qilmadi.');
  });

  it('on the table: a PDF that did not read and nothing typed is «Hech narsa o‘qilmadi», never «yozilganidan»', async () => {
    const { chatId } = collection({ fileCount: 1, pdfs: [PDF], aiUsed: false, aiFailure: 'rejected', facts: FULL });
    const table = await drawn(chatId);
    expect(table.text).toContain('Hech narsa o‘qilmadi.');
    expect(table.text).not.toContain('Faqat yozilganidan o‘qildi.');
  });

  it('«nothing for the model to read» beside an Excel that WAS read is no failure, on either door (§2.1)', async () => {
    for (const ai of [true, false]) {
      const { chatId } = collection({ ai, fileCount: 1, invoiceGoods: TWO, aiUsed: false, aiFailure: 'nothing_to_read', facts: { ...FULL, goods: TWO } });
      const table = await drawn(chatId);
      expect(table.text, String(ai)).not.toContain('AI ga o‘qish uchun matn, rasm yoki PDF yo‘q edi');
    }
  });
});

describe('the reading notice (§2.3, critic-notice-kind)', () => {
  const base = {
    aiUsed: false,
    aiFailure: null,
    aiCut: null,
    aiInputCut: false,
    filesMissing: 0,
    images: [],
    pdfs: [],
    sheetTexts: [],
    unreadPdfs: [],
    goodsFiles: [],
    invoiceGoods: [],
    material: [],
  };
  it('five kinds, decided at the settle', () => {
    expect(noticeKindOf({ ...base, aiUsed: true })).toBe('read');
    expect(noticeKindOf({ ...base, aiUsed: true, aiCut: { goods: 3, why: 'clock' } })).toBe('cut');
    expect(noticeKindOf({ ...base, aiFailure: 'timeout' })).toBe('failed');
    // Material only the model reads, unread for want of a key: failed, «sababi pastda».
    expect(noticeKindOf({ ...base, aiFailure: 'not_configured', pdfs: [PDF] })).toBe('failed');
    expect(noticeKindOf({ ...base, aiFailure: 'files_missing', filesMissing: 1 })).toBe('failed');
    // An Excel whose goods were read without the model.
    expect(noticeKindOf({ ...base, aiFailure: 'nothing_to_read', invoiceGoods: TWO })).toBe('no_model');
    // Typed text alone, no key: read by the bot, no file to call read.
    expect(noticeKindOf({ ...base, material: ['Kurtka 300 dona'], aiFailure: 'not_configured' })).toBe('read');
    expect(READING_NOTICE).toEqual({
      read: '✅ O‘qildi — natija pastda ⬇️',
      cut: '⚠️ AI oxirigacha o‘qimadi — natija pastda ⬇️',
      failed: '⚠️ AI o‘qiy olmadi — sababi pastda ⬇️',
      no_model: '📊 Fayl o‘qildi — natija pastda ⬇️',
      arrived: '⬇️ Yangi xabarlar keldi — pastda',
    });
  });

  it('never says the opposite of the table below it (door-break-3)', () => {
    // The one file was refused at arrival — the state the file door leaves
    // (it counts that file): nothing read, so never «📊 Fayl o‘qildi».
    expect(noticeKindOf({ ...base, aiFailure: 'nothing_to_read' })).toBe('failed');
    // A file that did not load, a PDF the API refused: the table is not
    // whole even where the model answered for the rest — never «✅ O‘qildi».
    expect(noticeKindOf({ ...base, aiUsed: true, filesMissing: 1 })).toBe('failed');
    expect(noticeKindOf({ ...base, aiUsed: true, pdfs: [PDF], unreadPdfs: [PDF.attachmentId] })).toBe('failed');
    // Shown only part of what it was sent: said as a cut.
    expect(noticeKindOf({ ...base, aiUsed: true, aiInputCut: true })).toBe('cut');
    expect(noticeKindOf({ ...base, invoiceGoods: TWO, goodsFiles: [{ capped: true } as never], aiFailure: 'nothing_to_read' })).toBe('cut');
  });
});

describe('the notice is edited by the kind STORED with the reply (§2.3)', () => {
  /** Run the press's reading job with Telegram stood in for; the notice's edits, as Telegram got them. */
  async function readWith(chatId: bigint): Promise<{ edits: { messageId: number; text: string }[]; notice: number | null }> {
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    const job = readingsEnqueued(chatId).at(-1)!.data;
    const edits: { messageId: number; text: string }[] = [];
    let id = 70_000;
    markIntakesHydrated();
    process.env.TELEGRAM_BOT_TOKEN ??= 'fayl-oqish-door';
    __setTelegramTransport(async (url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      if (url.endsWith('/editMessageText')) edits.push({ messageId: Number(body.message_id), text: String(body.text ?? '') });
      return new Response(JSON.stringify({ ok: true, result: { message_id: (id += 1) } }), { status: 200 });
    });
    try {
      await runIntakeRead(job, 0);
      await vi.waitFor(() => expect(edits.length).toBeGreaterThan(0));
    } finally {
      __setTelegramTransport(null);
    }
    return { edits, notice: job.noticeMessageId };
  }

  it('a model that did not answer: «⚠️ AI o‘qiy olmadi — sababi pastda ⬇️», never «✅ O‘qildi»', async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka 300 dona'] });
    model.analyze.mockResolvedValue({ ok: false, failure: 'timeout' });
    const { edits, notice } = await readWith(chatId);
    expect(edits).toEqual([{ messageId: notice, text: READING_NOTICE.failed }]);
    expect(activeIntake(chatId)!.pendingReply).toBeNull();
  });

  it('an Excel the model was never needed for: «📊 Fayl o‘qildi»', async () => {
    const { chatId } = collection({ stage: 'material', fileCount: 1, invoiceGoods: TWO });
    model.analyze.mockResolvedValue({ ok: false, failure: 'nothing_to_read' });
    const { edits, notice } = await readWith(chatId);
    expect(edits).toEqual([{ messageId: notice, text: READING_NOTICE.no_model }]);
  });

  it('a reply stored before the round (no kind) keeps «✅ O‘qildi» when the sweep sends it late', async () => {
    const { chatId } = collection({
      analysing: 'old-token',
      pendingReply: { token: 'old-token', text: 'jadval', keyboard: null, at: Date.now() - 600_000, jobId: null, noticeMessageId: 41 },
    });
    const edits: string[] = [];
    process.env.TELEGRAM_BOT_TOKEN ??= 'fayl-oqish-door';
    __setTelegramTransport(async (url, init) => {
      if (url.endsWith('/editMessageText')) edits.push(String((JSON.parse(String(init.body ?? '{}')) as { text?: string }).text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 71_000 } }), { status: 200 });
    });
    try {
      await deliverStoredReply(chatId, activeIntake(chatId)!);
      await vi.waitFor(() => expect(edits).toEqual([READING_NOTICE.read]));
    } finally {
      __setTelegramTransport(null);
    }
  });
});

describe('settleAnalysis carries the reading’s own fields (§10, door-whole-inputs)', () => {
  it('each field from the reading; a cut, then a whole re-read, leaves no cut behind', () => {
    const { state } = collection({ stage: 'material', analysing: 'tok' });
    const cut = settleAnalysis(state, state, { ...state, aiCut: { goods: 4, why: 'clock' }, aiInputCut: true, filesMissing: 2, unreadPdfs: ['p'] }, 'tok');
    expect(cut.kind).toBe('done');
    const after = (cut as { state: IntakeState }).state;
    expect([after.aiCut, after.aiInputCut, after.filesMissing, after.unreadPdfs]).toEqual([{ goods: 4, why: 'clock' }, true, 2, ['p']]);
    const live = { ...after, analysing: 'tok2' };
    const whole = settleAnalysis(live, live, { ...live, aiCut: null, aiInputCut: false, filesMissing: 0, unreadPdfs: [] }, 'tok2');
    const clean = (whole as { state: IntakeState }).state;
    expect([clean.aiCut, clean.aiInputCut, clean.filesMissing, clean.unreadPdfs]).toEqual([null, false, 0, []]);
  });
});

describe('«🔄» after a clock cut is spent once per material mark (§1.2)', () => {
  it('a re-read of the same material spends it; new material earns it again', async () => {
    const { chatId } = collection({ fileCount: 1, pdfs: [PDF], aiUsed: true, aiCut: { goods: 2, why: 'clock' }, facts: { ...FULL, goods: TWO }, readMark: { material: 0, files: 1 } });
    const ctx = fakeCtx();
    model.analyze.mockResolvedValue({ ok: true, facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods: [] }, steps: [], usage: { model: 'm', inputTokens: 1, outputTokens: 1 }, answered: [] });
    await handleCalcCallback(ctx, chatId, 'reread');
    expect(activeIntake(chatId)!.aiCutRetried).toBe(true);
    await driveReading(chatId, ctx);
    // New material: the mark moves, the «🔄» is earned again.
    updateIntake(chatId, { stage: 'material', material: ['Shim 10 dona'], aiCut: { goods: 2, why: 'clock' } });
    await handleCalcCallback(ctx, chatId, 'done');
    expect(activeIntake(chatId)!.aiCutRetried).toBe(false);
    await driveReading(chatId, ctx);
  });
});

describe('«Bo‘ldi» with every file refused at arrival (§2.3)', () => {
  it('names each with its reason and starts no reading', async () => {
    const { chatId } = collection({
      stage: 'material',
      refusedFiles: [
        { name: 'a.docx', why: 'Word fayl o‘qilmaydi.' },
        { name: 'b.zip', why: 'Arxiv o‘qilmaydi' },
      ],
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(ctx.replies.at(-1)!.text).toBe('Yuborilgan fayllarning birortasi ham o‘qiladigan emas: a.docx — Word fayl o‘qilmaydi; b.zip — Arxiv o‘qilmaydi.');
    expect(activeIntake(chatId)!.analysing).toBeNull();
    expect(model.analyze).not.toHaveBeenCalled();
  });

  it('judged by what was ACCEPTED, never by the count — the file door counts the refused files too (door-break-2)', async () => {
    const { chatId } = collection({ stage: 'material', fileCount: 2, refusedFiles: [{ name: 'a.docx', why: 'Word fayl o‘qilmaydi.' }] });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(ctx.replies.map((r) => r.text)).toEqual(['Yuborilgan fayllarning birortasi ham o‘qiladigan emas: a.docx — Word fayl o‘qilmaydi.']);
    expect(activeIntake(chatId)!.analysing).toBeNull();
    expect(readingsEnqueued(chatId)).toEqual([]);
  });

  it('a refused file beside something accepted is a reading as before', async () => {
    const { chatId } = collection({ stage: 'material', fileCount: 2, material: ['Kurtka 300 dona'], refusedFiles: [{ name: 'a.docx', why: 'Word fayl o‘qilmaydi.' }] });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(activeIntake(chatId)!.analysing).not.toBeNull();
    expect(ctx.replies.map((r) => r.text)).not.toContain('Yuborilgan fayllarning birortasi ham o‘qiladigan emas: a.docx — Word fayl o‘qilmaydi.');
  });
});

describe('the landing’s words (§1.3 b)', () => {
  const target = { kind: 'lead' as const, label: 'Ali', outcome: 'lead', queued: true, replyQueued: true };
  it('a VED landing says why, never AI_QUEUED — on the row the landing wrote «🧮»', () => {
    const said = landingReplyText({ ...target, ved: { reason: '1 ta PDF o‘qilmadi' } }, { link: null, tariffFollows: false, door: 'plain', aiAvailable: true });
    expect(said).toContain(vedQueuedText('1 ta PDF o‘qilmadi'));
    expect(said).toContain('🧮 VED navbatiga tushdi — AI hisoblamadi: 1 ta PDF o‘qilmadi. VED xodimi fayllarni ko‘rib, javobni shu yerga yuboradi.');
    expect(said).not.toContain(AI_QUEUED);
  });

  it('an «🤖» row with no goods is never promised the AI’s figure', () => {
    const said = landingReplyText({ ...target, items: 0 }, { link: null, tariffFollows: false, door: 'ai', aiAvailable: true });
    expect(said).not.toContain(AI_QUEUED);
    expect(said).toContain('AI hisoblamadi: so‘rovda tovar yo‘q');
    expect(landingReplyText({ ...target, items: 2 }, { link: null, tariffFollows: false, door: 'ai', aiAvailable: true })).toContain(AI_QUEUED);
  });

  it('the lenta says the AI door collected it, why the AI did not compute, and what was read', () => {
    const { state } = collection({ fileCount: 2, pdfs: [PDF], invoiceGoods: TWO, aiUsed: false, aiFailure: 'not_configured', facts: { ...FULL, goods: TWO } });
    const note = vedLandingNote(state, aiReadingWhole(state, 2), null, 2);
    expect(note).toBe('🤖 AI eshigidan keldi — AI hisoblamadi: 1 ta PDF o‘qilmadi. O‘qilgan: 2 ta tovar (Excel).');
    const text = intakeNoteText({ section: 'rastamojka', facts: { ...FULL, goods: TWO }, laws: new Map(), steps: [], collectedBy: 'Ali', fileCount: 2, doorNote: note });
    expect(text.split('\n').slice(0, 3)).toEqual(['🧮 Hisoblatish — 🛃 Rastamojka', 'Yig‘di: Ali (Telegram bot)', note]);
  });
});

describe('a landing with no goods owes no customs pass (§1.3 c, door-zero-pass)', () => {
  it('rastamojka of nothing: no pass; yolkira and podklyuch keep theirs', () => {
    expect(landingOwesPass('rastamojka', 0)).toBe(false);
    expect(landingOwesPass('rastamojka', 1)).toBe(true);
    expect(landingOwesPass('yolkira', 0)).toBe(true);
    expect(landingOwesPass('podklyuch', 0)).toBe(true);
  });

  it('podklyuch’s customs half says «so‘rovda tovar yo‘q» — chat, lenta and the VED’s note', () => {
    const reply = aiVedReplyText({
      clientLabel: null,
      cardLabel: null,
      lines: [],
      ungrouped: [],
      fee: null,
      totalUsd: 0,
      feeRefusal: null,
      hasCertificate: true,
      freight: null,
      link: null,
      aiConfigured: true,
      budgetSpent: false,
      audience: 'chat',
    } as unknown as Parameters<typeof aiVedReplyText>[0]);
    expect(reply).toContain(NO_GOODS_CUSTOMS);
    expect(reply).not.toContain('hozircha hisoblab bo‘lmadi');
    expect(reply).not.toContain('Rastamojka jami: ≈');
    const note = aiNoteText({
      clientLabel: null,
      cardLabel: null,
      pass: 'landing',
      rows: [],
      groups: [],
      ungrouped: [],
      asks: [],
      freight: null,
      feeRefusal: null,
      pickLeft: null,
      hasCertificate: true,
      aiConfigured: true,
      budgetSpent: false,
    });
    expect(note).toContain(NO_GOODS_CUSTOMS);
  });
});

describe('the ➕ add collection’s own reading (§1.6)', () => {
  const base: AmendBase = {
    requestId: '00000000-0000-4000-8000-000000000071',
    section: 'rastamojka',
    cardLabel: 'L-71',
    door: 'ai',
    items: [{ itemId: 'i-1', seq: 1, name: 'Kurtka', quantity: 300, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: '6201400000', note: null }],
    weightKg: 3500,
    volumeM3: 12,
    fromCity: null,
    toCity: null,
  } as unknown as AmendBase;

  it('keeps its keyboard, says what it did not read, and promises no re-run', async () => {
    const { chatId } = collection(
      {
        fileCount: 1,
        pdfs: [PDF],
        aiUsed: false,
        aiFailure: 'not_configured',
        facts: { ...FULL, goods: [line('Kurtka', { itemId: 'i-1', seq: 1, quantity: 300, tnvedCode: '6201400000' })] },
      },
      base,
    );
    const table = await drawn(chatId);
    expect(data(table)).toContain('c:save');
    expect(data(table)).not.toContain('c:to_ved');
    expect(table.text).toContain('⚠️ 1 ta PDF o‘qilmadi — «✅ Qo‘shish» faqat o‘qilganini qo‘shadi, AI qayta hisoblamaydi.');
    expect(table.text).not.toContain('AI qayta hisoblaydi.');
  });

  it('is judged by what ITS reading read — a stored request with no goods is no unread of the addition (door-break-5)', async () => {
    const empty = { ...base, items: [] } as unknown as AmendBase;
    // The missing brutto alone, read in full, added to a pre-deploy «🤖» request of zero goods.
    const { chatId, state } = collection({ material: ['jami 3500 kg'], aiUsed: true, facts: { weightKg: 3500, goods: [] } }, empty);
    expect(await addReadingUnread(state)).toBeNull();
    const table = await drawn(chatId);
    expect(table.text).not.toContain('o‘qilmadi — «✅ Qo‘shish» faqat o‘qilganini qo‘shadi');
    expect(data(table)).toContain('c:save');
    // Its OWN unread still is one: the PDF it was sent and did not read.
    const pdf = collection({ fileCount: 1, pdfs: [PDF], aiUsed: false, aiFailure: 'timeout', facts: { goods: [] } }, empty);
    expect(await addReadingUnread(pdf.state)).toBe('1 ta PDF');
  });

  it('its save ends the restart question standing over it, its buttons stripped (§2.4, door-spec-amend-save-keeps-restart-question)', async () => {
    const { chatId } = collection(
      {
        stage: 'review',
        aiUsed: true,
        facts: { ...FULL, goods: [line('Kurtka', { itemId: 'i-1', seq: 1, quantity: 300, tnvedCode: '6201400000' })] },
        restartAsked: { messageId: 4_401, at: Date.now() },
      },
      base,
    );
    const strips: number[] = [];
    process.env.TELEGRAM_BOT_TOKEN ??= 'fayl-oqish-door';
    __setTelegramTransport(async (url, init) => {
      if (url.endsWith('/editMessageReplyMarkup')) strips.push(Number((JSON.parse(String(init.body ?? '{}')) as { message_id?: number }).message_id));
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    try {
      await handleCalcCallback(fakeCtx(), chatId, 'save');
      const live = activeIntake(chatId)!;
      expect(live.saving).not.toBeNull();
      expect(live.restartAsked ?? null).toBeNull();
      await vi.waitFor(() => expect(strips).toContain(4_401));
    } finally {
      __setTelegramTransport(null);
    }
  });

  it('its save carries the phrase, the diff keeps it, and the words never say «AI qayta hisoblayapti»', () => {
    const { state } = collection({ facts: { goods: [line('Shim', { quantity: 5 })] } }, base);
    const sub = amendSubmissionOf(state, '1 ta PDF');
    expect(sub.unread).toBe('1 ta PDF');
    expect(amendDiff(base, sub, '00000000-0000-4000-8000-0000000000aa').unread).toBe('1 ta PDF');
    expect(amendSubmissionOf(state).unread).toBeUndefined();
    expect(unreadRepassLine('1 ta PDF')).toBe('\n⚠️ 1 ta PDF o‘qilmadi — AI qayta hisoblamaydi, narxni VED beradi.');
  });
});

describe('the as-built review’s words on the AI table (as-built review A)', () => {
  const VED_FILES = '«👤 VED hisoblasin» — VED xodimi fayllarni o‘zi ko‘rib hisoblaydi (AI hisoblamaydi).';
  const capped = (label: string) => ({
    label,
    shape: 'invoice' as const,
    weightKind: null,
    grossKg: null,
    grossColumn: false,
    volumeM3: null,
    rows: 500,
    text: null,
    capped: true as const,
  });

  it('OWNER-6: a label the reader stored quoted is quoted once — a file, a further sheet, an unread sheet', async () => {
    const file = collection({ fileCount: 1, invoiceGoods: TWO, goodsFiles: [capped('«long.xlsx»')], aiUsed: true, facts: { ...FULL, goods: TWO } });
    const table = await drawn(file.chatId);
    expect(table.text).toContain('⚠️ «long.xlsx» jadvalining birinchi 500 qatori o‘qildi.');
    expect(table.text).not.toContain('««');
    const whole = aiReadingWhole(file.state, 2);
    expect(vedLandingReason(file.state, whole, { label: '«long.xlsx»', kept: 500, total: null })).toBe('«long.xlsx» jadvali to‘liq o‘qilmadi');
    const sheet = collection({ fileCount: 1, invoiceGoods: TWO, goodsFiles: [capped('«two.xlsx», «Zavod B» varag‘i')], aiUsed: true, facts: { ...FULL, goods: TWO } });
    expect((await drawn(sheet.chatId)).text).toContain('⚠️ «two.xlsx», «Zavod B» varag‘ining birinchi 500 qatori o‘qildi.');
    const free = collection({
      fileCount: 2,
      invoiceGoods: TWO,
      sheetTexts: [{ text: 'Kurtka | 3\nShim | 2', cut: false, cellsCut: false, label: '«free.xlsx»' }],
      aiUsed: false,
      aiFailure: 'timeout',
      facts: { ...FULL, goods: TWO },
    });
    const freeText = (await drawn(free.chatId)).text;
    expect(freeText).toContain('⚠️ 2 ta tovar Excel’dan olindi; «free.xlsx» varag‘i o‘qilmadi.');
    expect(freeText).not.toContain('««');
  });

  it('OWNER-8: under a capped table the remedy never sends the seller round ➕ — «👤», or «✖️» and the file again in parts', async () => {
    const { chatId } = collection({ fileCount: 1, invoiceGoods: TWO, goodsFiles: [capped('«long.xlsx»')], aiUsed: true, facts: { ...FULL, goods: TWO } });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).not.toContain('«➕ Yana ma’lumot» bilan yuboring');
    expect(table.text).toContain(
      `«👤 VED hisoblasin» ni bosing — VED xodimi fayllarni o‘zi ko‘rib hisoblaydi (AI hisoblamaydi). Yoki «✖️ Bekor qilish» ni bosib, jadvalni kichikroq bo‘laklarga bo‘lib qaytadan yuboring.`,
    );
  });

  it('OWNER-8: a size cut does not repeat its own advice as a ➕ road; no file at all promises no files to the VED', async () => {
    const size = collection({ fileCount: 1, pdfs: [PDF], aiUsed: true, aiCut: { goods: 2, why: 'size' }, facts: { ...FULL, goods: TWO } });
    const sizeText = (await drawn(size.chatId)).text;
    expect(sizeText).not.toContain('«➕ Yana ma’lumot» bilan yuboring');
    expect(sizeText).toContain('Yoki «✖️ Bekor qilish» ni bosib, kamroq sahifa yoki Excel qilib qaytadan yuboring.');
    const none = collection({ material: ['salom'], aiUsed: true, facts: FULL });
    const noneText = (await drawn(none.chatId)).text;
    expect(noneText).toContain('Tovarlarni yozib «➕ Yana ma’lumot» bilan yuboring. Yoki «👤 VED hisoblasin» — VED xodimi o‘zi hisoblaydi (AI hisoblamaydi).');
    expect(noneText).not.toContain('fayllarni o‘zi ko‘rib');
  });

  it('WORDS-3: on a budget day the remedy is the same after ➕ brought the goods as an Excel — and it no longer says ➕ heals it now', async () => {
    const day = collection({ fileCount: 1, pdfs: [PDF], aiUsed: false, aiFailure: 'budget', facts: FULL });
    const first = (await drawn(day.chatId)).text;
    const later = `«👤 VED hisoblasin» ni bosing — VED xodimi fayllarni o‘zi ko‘rib hisoblaydi (AI hisoblamaydi). Yoki ertaga «➕ Yana ma’lumot» bilan biror narsa yuboring — AI hammasini qayta o‘qiydi.`;
    expect(first).toContain(later);
    expect(first).not.toContain('Faylni Excel qilib');
    updateIntake(day.chatId, { fileCount: 2, invoiceGoods: TWO, facts: { ...FULL, goods: TWO } });
    const after = await drawn(day.chatId);
    noConfirm(after);
    expect(after.text).toContain('⚠️ 2 ta tovar Excel’dan olindi; 1 ta PDF o‘qilmadi.');
    expect(after.text).toContain(later);
    // A refusal of the material itself: only «👤», or «✖️» and the goods without that file.
    const refused = collection({ fileCount: 1, images: [PHOTO], aiUsed: false, aiFailure: 'refused', facts: FULL });
    expect((await drawn(refused.chatId)).text).toContain('Yoki «✖️ Bekor qilish» ni bosib, o‘qilmagan faylsiz (Excel qilib yoki yozib) qaytadan yuboring.');
    // A retryable failure keeps today's words (control).
    const timeout = collection({ fileCount: 1, pdfs: [PDF], aiUsed: false, aiFailure: 'timeout', facts: FULL });
    expect((await drawn(timeout.chatId)).text).toContain(`«🔄 AI qayta o‘qisin» ni bosing, yoki faylni Excel qilib / tovarlarni yozib «➕ Yana ma’lumot» bilan yuboring. Yoki ${VED_FILES}`);
  });

  it('OWNER-5: files refused at arrival are the same fact, counted or not — «Yuborilgan fayl o‘qilmadi», never «AI … topa olmadi» or «yozilmagan»', async () => {
    // A DOCX the file door counted, and a 25 MB PDF it did not.
    for (const fileCount of [1, 0]) {
      const name = fileCount ? 'inv.docx' : 'CI-big.pdf';
      const { chatId, state } = collection({ fileCount, refusedFiles: [{ name, why: fileCount ? 'Word fayl' : '20 MB dan katta' }], material: ['salom'], aiUsed: true, facts: FULL });
      const table = await drawn(chatId);
      noConfirm(table);
      expect(table.text, name).toContain(`Tovarlar (0):\n${AI_GOODS_ROW_UNREAD}`);
      expect(table.text, name).toContain(`\n${AI_FILES_REFUSED}\n«${name}» o‘qilmadi`);
      expect(table.text, name).not.toContain('AI yuborilgan fayllardan tovar topa olmadi');
      expect(table.text, name).not.toContain(AI_NO_GOODS);
      // The DOCX is on the card for the VED to open; the 25 MB file never reached it.
      expect(table.text.includes('fayllarni o‘zi ko‘rib'), name).toBe(fileCount > 0);
      expect(vedLandingReason(state, aiReadingWhole(state, 0), null), name).toBe('yuborilgan fayl o‘qilmadi');
    }
  });

  it('OWNER-7: «🔄» is named once when the reading’s own note names it', async () => {
    const { chatId } = collection({
      fileCount: 2,
      invoiceGoods: TWO,
      pdfs: [PDF],
      aiUsed: true,
      filesMissing: 1,
      notes: [filesMissingNote(1, true)!],
      facts: { ...FULL, goods: TWO },
    });
    const table = await drawn(chatId);
    expect(data(table)[0]).toBe('c:reread');
    expect(table.text.split('«🔄 AI qayta o‘qisin»').length - 1).toBe(1);
    expect(table.text).toContain(`Faylni Excel qilib / tovarlarni yozib «➕ Yana ma’lumot» bilan yuboring. Yoki ${VED_FILES}`);
  });

  it('OWNER-12: a lone PDF the API refused is said once — by its name, never also by the tail’s generic refusal', async () => {
    const { chatId } = collection({ fileCount: 1, pdfs: [PDF], unreadPdfs: ['pdf-1'], aiUsed: false, aiFailure: 'rejected', facts: FULL });
    const table = await drawn(chatId);
    noConfirm(table);
    expect(table.text).toContain('📄 «invoice.pdf» — AI bu faylni qabul qilmadi');
    expect(table.text).not.toContain('AI so‘rovni qabul qilmadi');
    expect(table.text).toContain('Hech narsa o‘qilmadi.');
    // A rejection with no PDF to name keeps the tail's words (control).
    const bare = collection({ fileCount: 1, pdfs: [PDF], aiUsed: false, aiFailure: 'rejected', facts: FULL });
    expect((await drawn(bare.chatId)).text).toContain('AI so‘rovni qabul qilmadi');
  });

  it('REGRESSION-4: sixty files refused at arrival leave the goods rows and the remedy on the table — the first five by name, the rest counted', async () => {
    const goods = Array.from({ length: 40 }, (_, i) => line(`Tovar ${i + 1}`, { quantity: 10 + i, tnvedCode: '6201400000' }));
    const refusedFiles = Array.from({ length: 60 }, (_, i) => ({ name: `IMG_20261110_${1000 + i}.HEIC`, why: 'HEIC rasm' }));
    const { chatId } = collection({ fileCount: 61, invoiceGoods: goods, pdfs: [PDF], aiUsed: false, aiFailure: 'timeout', refusedFiles, facts: { ...FULL, goods } });
    const table = await drawn(chatId);
    expect(table.text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(table.text).toContain('1. Tovar 1');
    expect(table.text).toContain('Yana 55 ta fayl o‘qilmadi (HEIC rasm) — ulardagi tovarlar hisobga kirmaydi.');
    expect(table.text.split('\n').at(-1)).toContain(VED_FILES);
    expect(table.text).not.toContain('(qisqartirildi)');
  });

  it('WORDS-11: a counted entry is plural, a file is quoted', () => {
    expect(refusedFileLines([{ name: '3 ta rasm', why: '12 tadan ortiq rasm' }, { name: 'spec.docx', why: 'Word fayl' }])).toEqual([
      '3 ta rasm o‘qilmadi (12 tadan ortiq rasm) — ulardagi tovarlar hisobga kirmaydi.',
      '«spec.docx» o‘qilmadi (Word fayl) — undagi tovarlar hisobga kirmaydi.',
    ]);
  });

  it('REGRESSION-4: the last resort of the fit ends on a line, and never inside an emoji', () => {
    const many = Array.from({ length: 300 }, (_, i) => `Qator ${i} — undagi tovarlar hisobga kirmaydi.`);
    const text = fitTelegram(['Bosh'], [], many, []);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(text.split('\n').at(-2)).toMatch(/kirmaydi\.$/u);
    const emoji = fitTelegram([`${'a'.repeat(TELEGRAM_LIMIT - 21)}🔄${'b'.repeat(50)}`], [], [], []);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it('OWNER-3: the plain door’s summary says a cut reading — the keyboard stays his 2a’s', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => line(`Tovar ${i + 1}`, { quantity: 10 }));
    const { chatId } = collection({ ai: false, fileCount: 1, aiUsed: true, aiCut: { goods: 7, why: 'clock' }, facts: { ...FULL, goods: seven } });
    const table = await drawn(chatId);
    expect(data(table)).toContain('c:save');
    expect(table.text).toContain('⚠️ AI faylni oxirigacha o‘qib ulgurmadi — 7 ta tovar o‘qildi, qolgani o‘qilmadi.');
    // No cut, no line (control).
    const whole = collection({ ai: false, fileCount: 1, aiUsed: true, facts: { ...FULL, goods: seven } });
    expect((await drawn(whole.chatId)).text).not.toContain('oxirigacha');
  });

  it('WORDS-2: the card names the files refused at arrival, and its doorNote can carry a cut', () => {
    const note = intakeNoteText({
      section: 'rastamojka',
      facts: { ...FULL, goods: TWO },
      laws: new Map(),
      steps: [],
      collectedBy: 'Sotuvchi',
      fileCount: 1,
      doorNote: cutNoteText({ goods: 7, why: 'clock' }),
      refusedFiles: [{ name: 'CI-big.pdf', why: '20 MB dan katta' }, { name: '3 ta rasm', why: '12 tadan ortiq rasm' }],
    });
    expect(note).toContain('⚠️ AI faylni oxirigacha o‘qimadi — 7 ta tovar o‘qildi, qolgani o‘qilmadi: ro‘yxat to‘liq emas, faylni ko‘ring.');
    expect(note).toContain('⚠️ O‘qilmagan fayllar (tovarlari hisobga kirmagan): «CI-big.pdf» — 20 MB dan katta; 3 ta rasm — 12 tadan ortiq rasm');
  });
});
