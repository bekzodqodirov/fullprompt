import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

/**
 * «↩️ Shu javobni bekor qilish» (docs/SAKKIZ-R3.md §2.3, §8.2.7): one answer
 * message taken back while the collection is open. The row is found where
 * the answer is NOW, a row a later answer changed again is named and kept,
 * and a totals answer is restored WHOLE — its mark and the doubts it retired.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
// The reading job bills each answered reading itself (docs/SAKKIZ-R3.md §7.2.10).
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100, recordAiPass: async () => {} }));
// «Bo‘ldi» only enqueues since the reading is a pg-boss job (§7.1): the one
// drive helper runs the captured job.
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import { activeIntake, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import {
  deliverNextStep,
  pressPick,
  pressUndo,
  routeCollectorText,
  tableEditsSettled,
} from '@/modules/platform/telegram/calc-dialog';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}, section: IntakeState['section'] = 'rastamojka') {
  seq += 1;
  const chatId = BigInt(-9_900_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-test' });
  return { chatId, state: updateIntake(chatId, patch)! };
}

type Sent = { id: number; text: string; extra?: Record<string, unknown> };
function fakeCtx() {
  let next = 100;
  const replies: Sent[] = [];
  const edits: Sent[] = [];
  const toasts: (string | undefined)[] = [];
  return {
    replies,
    edits,
    toasts,
    texts: () => replies.map((r) => r.text),
    async reply(text: string, extra?: Record<string, unknown>) {
      next += 1;
      replies.push({ id: next, text, extra });
      return { message_id: next };
    },
    async answerCallbackQuery(other?: { text?: string }) {
      toasts.push(other?.text);
      return true;
    },
    api: {
      async editMessageText(_chat: string, id: number, text: string, extra?: Record<string, unknown>) {
        edits.push({ id, text, extra });
        return true;
      },
    },
  };
}
type Ctx = ReturnType<typeof fakeCtx>;
const from = (ctx: Ctx, id: number) => Object.assign(Object.create(ctx) as Ctx, { callbackQuery: { message: { message_id: id } } });

let messageId = 5000;
async function say(ctx: Ctx, chatId: bigint, text: string, forwarded = false) {
  await routeCollectorText(ctx, chatId, activeIntake(chatId)!, text, { date: 0, messageId: (messageId += 1), forwarded, replyTo: null });
  await tableEditsSettled();
  return ctx.replies.at(-1)!;
}
/** The echo's tag, by its position among the collection's echoes. */
const tagOf = (chatId: bigint, n: number) => activeIntake(chatId)!.echoes.at(n)!.tag;
async function undo(ctx: Ctx, chatId: bigint, echo: Sent, tag: string) {
  await pressUndo(from(ctx, echo.id), chatId, tag);
  await tableEditsSettled();
}

const reads = (facts: Partial<CalcFacts>) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods: [], ...facts },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
  answered: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
});
async function pressDone(ctx: Ctx, chatId: bigint) {
  await handleCalcCallback(ctx, chatId, 'done');
  await driveReading(chatId, ctx);
  expect(activeIntake(chatId)?.analysing ?? null).toBeNull();
  await tableEditsSettled();
}

beforeEach(() => {
  model.analyze.mockReset();
  resetReadingDrive();
});
afterEach(async () => {
  await tableEditsSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('↩️', () => {
  it('restores what the answer replaced, and edits both messages — the echo and the table', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka')] } });
    const ctx = fakeCtx();
    await deliverNextStep(ctx, chatId, activeIntake(chatId)!);
    const table = ctx.replies[0]!;
    const echo = await say(ctx, chatId, '2: 50 dona');
    expect(activeIntake(chatId)!.facts.goods?.[1]).toEqual(line('Sumka', { quantity: 50 }));
    const editsBefore = ctx.edits.length;
    await undo(ctx, chatId, echo, tagOf(chatId, 0));
    const live = activeIntake(chatId)!;
    expect(live.facts.goods?.[1]).toEqual(line('Sumka', { quantity: null }));
    expect(live.lineAnswers).toEqual([]);
    expect(live.echoes[0]!.undone).toBe(true);
    const after = ctx.edits.slice(editsBefore);
    expect(after.find((e) => e.id === echo.id)).toMatchObject({ text: '↩️ Bekor qilindi: 2-qator «Sumka» — 50 dona', extra: { reply_markup: { inline_keyboard: [] } } });
    expect(after.find((e) => e.id === table.id)!.text).toContain('⚠️ 2. Sumka');
    expect(ctx.toasts).toEqual([undefined]);
  });

  it('twice: «Allaqachon bekor qilingan», nothing moves', async () => {
    const { chatId } = collection({ stage: 'review', facts: { goods: [line('Kurtka'), line('Sumka')] } });
    const ctx = fakeCtx();
    const echo = await say(ctx, chatId, '2: 50 dona');
    const tag = tagOf(chatId, 0);
    await undo(ctx, chatId, echo, tag);
    const before = JSON.stringify(activeIntake(chatId));
    await undo(ctx, chatId, echo, tag);
    expect(ctx.toasts.at(-1)).toBe('Allaqachon bekor qilingan');
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  });

  it('an unknown tag, or no live collection: «Bu tugma eskirgan»', async () => {
    const { chatId } = collection({ stage: 'review', facts: { goods: [line('Kurtka'), line('Sumka')] } });
    const ctx = fakeCtx();
    const echo = await say(ctx, chatId, '2: 50 dona');
    await pressUndo(from(ctx, echo.id), chatId, 'deadbeef');
    expect(ctx.toasts.at(-1)).toBe('Bu tugma eskirgan.');
    expect(ctx.texts().at(-1)).toBe('Bu tugma eskirgan.');
    const tag = tagOf(chatId, 0);
    endIntake(chatId);
    await pressUndo(from(ctx, echo.id), chatId, tag);
    expect(ctx.texts().at(-1)).toBe('Bu tugma eskirgan.');
  });

  it('a row a LATER answer changed again is kept, and named', async () => {
    const { chatId } = collection({ stage: 'review', facts: { goods: [line('Kurtka'), line('Sumka')] } });
    const ctx = fakeCtx();
    const first = await say(ctx, chatId, '2: 50 dona');
    await say(ctx, chatId, '2: 70 dona');
    await undo(ctx, chatId, first, tagOf(chatId, 0));
    expect(activeIntake(chatId)!.facts.goods?.[1]).toEqual(line('Sumka', { quantity: 70 }));
    expect(activeIntake(chatId)!.lineAnswers).toMatchObject([{ index: 1, patch: { quantity: 70 } }]);
    expect(ctx.edits.find((e) => e.id === first.id)!.text).toBe('⚠️ 2-qator keyin o‘zgartirilgan — u bekor qilinmadi.');
  });

  it('a picked offer is restored like a typed answer', async () => {
    const { chatId } = collection({ stage: 'review', facts: { goods: [line('Kurtka', { quantity: 3 }), line('Sumka')] } });
    const ctx = fakeCtx();
    const asked = await say(ctx, chatId, '2: 50');
    await pressPick(from(ctx, asked.id), chatId, activeIntake(chatId)!, 1);
    await tableEditsSettled();
    const echo = ctx.replies.at(-1)!;
    expect(activeIntake(chatId)!.facts.goods?.[1]).toEqual(line('Sumka', { weightKg: 50 }));
    await undo(ctx, chatId, echo, tagOf(chatId, 0));
    expect(activeIntake(chatId)!.facts.goods?.[1]).toEqual(line('Sumka', { weightKg: null }));
    expect(ctx.edits.find((e) => e.id === echo.id)!.text).toBe('↩️ Bekor qilindi: 2-qator «Sumka» — 50 kg');
  });

  it('after «➕ Yana ma’lumot» + «Bo‘ldi» moved Sumka from row 3 to row 5, the OLD echo reverts row 5 — row 3’s new goods are untouched (product-fit-11)', async () => {
    const before = [line('Kurtka', { quantity: 1 }), line('Shim', { quantity: 1 }), line('Sumka'), line('Shapka', { quantity: 1 }), line('Sharf', { quantity: 1 })];
    const { chatId } = collection({ stage: 'review', material: ['ro‘yxat'], facts: { weightKg: 3500, volumeM3: 12, goods: before } });
    const ctx = fakeCtx();
    const echo = await say(ctx, chatId, '3: 50 dona');
    const tag = tagOf(chatId, 0);
    await handleCalcCallback(ctx, chatId, 'more');
    updateIntake(chatId, { material: ['ro‘yxat', 'yana'] });
    model.analyze.mockResolvedValueOnce(
      reads({
        weightKg: 3500,
        volumeM3: 12,
        goods: [line('Kurtka', { quantity: 1 }), line('Shim', { quantity: 1 }), line('Paypoq', { quantity: 50 }), line('Shapka', { quantity: 1 }), line('Sumka')],
      }),
    );
    await pressDone(ctx, chatId);
    expect(activeIntake(chatId)!.facts.goods?.[4]).toEqual(line('Sumka', { quantity: 50 }));
    await undo(ctx, chatId, echo, tag);
    const live = activeIntake(chatId)!;
    expect(live.facts.goods?.[4]).toEqual(line('Sumka', { quantity: null }));
    expect(live.facts.goods?.[2]).toEqual(line('Paypoq', { quantity: 50 }));
    expect(ctx.edits.find((e) => e.id === echo.id)!.text).toBe('↩️ Bekor qilindi: 5-qator «Sumka» — 50 dona');
  });

  it('a totals answer is undone WHOLE: the doubt it settled is back, and the weight is empty again (re-check p3-3)', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka 300 dona'], facts: { volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] } }, 'yolkira');
    const ctx = fakeCtx();
    await say(ctx, chatId, 'jami 3500 kg');
    await handleCalcCallback(ctx, chatId, 'more');
    await say(ctx, chatId, 'brutto 4200 kg', true);
    model.analyze.mockResolvedValueOnce(reads({ fromCity: 'Yiwu', toCity: 'Toshkent', volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] }));
    await pressDone(ctx, chatId);
    const doubt = { field: 'weightKg', answered: 3500, stated: 4200 };
    expect(activeIntake(chatId)!.ambiguousTotals).toEqual([doubt]);
    const echo = await say(ctx, chatId, 'jami 4200 kg');
    expect(activeIntake(chatId)!.facts.weightKg).toBe(4200);
    expect(activeIntake(chatId)!.ambiguousTotals).toEqual([]);
    await undo(ctx, chatId, echo, tagOf(chatId, -1));
    const live = activeIntake(chatId)!;
    expect(live.facts.weightKg ?? null).toBeNull();
    expect(live.ambiguousTotals).toEqual([doubt]);
    expect(live.totalsAnswer).toMatchObject({ weightKg: 3500, at: { material: 1, files: 0 } });
    expect(ctx.edits.find((e) => e.id === echo.id)!.text).toBe('↩️ Bekor qilindi: umumiy brutto — 4200 kg');
    // The table asks it again, with both figures.
    expect(ctx.edits.at(-1)!.text).toContain('⚠️ Siz 3500 kg deb javob bergansiz, keyin yuborilgan ma’lumotda 4200 kg — qaysi biri?');
  });
});
