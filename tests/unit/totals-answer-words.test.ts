import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * docs/AI-SORAYDI.md §3.1 T2, T3, T14 — what the BOT says and writes when a
 * typed answer holds a figure the table could not take, a word that is no
 * unit, or a weight in tonnes. `parseTableAnswer` decides (its own tests pin
 * that); here the answer goes through the dialogue's one door
 * (`applyTableAnswer`) with Telegram as a stand-in, so what is pinned is the
 * seller's side: the table after the answer, and the one reply.
 *
 * Every sentence is written out by hand.
 */
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  recordAiPass: async () => {},
  aiCalcAvailable: async () => true,
}));
vi.mock('@/modules/platform/ai/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/ai/model')>()),
  aiConfigured: () => true,
}));
vi.mock('@/modules/platform/telegram/send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/send')>()),
  sendTyping: async () => ({ ok: true }),
  editText: async () => ({ ok: true }),
}));

import type { Context } from 'grammy';
import { activeIntake, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { applyTableAnswer, routeCollectorText, tableEditsSettled } from '@/modules/platform/telegram/calc-dialog';
import { collectorScope } from '@/modules/platform/telegram/calc-store';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';

let seq = 0;
const chats: bigint[] = [];

/** A collection at its table: `goods` read, the two totals as given. `ai` picks the door. */
function atTable(
  goods: NonNullable<IntakeState['facts']['goods']>,
  opts: { ai?: boolean; weightKg?: number | null; volumeM3?: number | null } = {},
): bigint {
  seq += 1;
  const chatId = BigInt(-9_700_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'podklyuch', { staffId: 'staff-test' });
  updateIntake(chatId, {
    stage: 'review',
    ai: opts.ai ?? true,
    material: ['x'],
    facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: opts.weightKg ?? null, volumeM3: opts.volumeM3 ?? null, goods },
  });
  return chatId;
}

function fakeCtx() {
  const replies: string[] = [];
  return {
    replies,
    async reply(text: string) {
      replies.push(text);
      return { message_id: 100 + replies.length };
    },
    api: {
      async editMessageText() {
        return true;
      },
      async deleteMessage() {
        return true;
      },
      async setMessageReaction() {
        return true;
      },
    },
  };
}

const after = (chatId: bigint, ctx: ReturnType<typeof fakeCtx>) => {
  const live = activeIntake(chatId)!;
  return { replies: ctx.replies, kg: live.facts.weightKg ?? null, m3: live.facts.volumeM3 ?? null, goods: live.facts.goods ?? [], answers: live.answers };
};

/** A typed answer at the AI door's table — the dialogue's one door for it. */
async function answer(chatId: bigint, text: string) {
  const ctx = fakeCtx();
  await applyTableAnswer(ctx, chatId, activeIntake(chatId)!, text, { date: 0, messageId: 77, forwarded: false, replyTo: null });
  await tableEditsSettled();
  return after(chatId, ctx);
}

let messageId = 7_000;
/**
 * A typed message routed as the collector routes it, inside the bot's own
 * message scope — the PLAIN door's way in (`routeCollectorText` sends it to
 * the door's own reader; calling the table's door directly would pin a path
 * production never takes).
 */
async function say(chatId: bigint, text: string) {
  const ctx = fakeCtx();
  const id = (messageId += 1);
  const scoped = { chat: { id: Number(chatId) }, message: { message_id: id }, api: { config: { use() {} } } } as unknown as Context;
  await collectorScope()(scoped, () =>
    routeCollectorText(ctx, chatId, activeIntake(chatId)!, text, { date: 0, messageId: id, forwarded: false, replyTo: null }),
  );
  await tableEditsSettled();
  await keptLastSettled();
  return after(chatId, ctx);
}

const KURTKA = { name: 'Kurtka', quantity: 300, weightKg: 150 };

afterEach(async () => {
  await tableEditsSettled();
  await keptLastSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('T2 — a totals answer with a figure no total takes (AI door)', () => {
  it('both totals are written with no word at all', async () => {
    const out = await answer(atTable([KURTKA]), '507 kg 5.92 cbm');
    expect([out.kg, out.m3]).toEqual([507, 5.92]);
    // The AI door's answer sends no message of its own: nothing refused, nothing asked.
    expect(out.replies).toEqual([]);
  });

  it('a count beside the kilos: the kilos are written AND the count is named, with the row’s own number', async () => {
    const out = await answer(atTable([KURTKA]), 'jami 507 kg 300 dona');
    expect(out.kg).toBe(507);
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]).toContain(
      '⚠️ «300 dona» — umumiyga yozilmaydi (umumiyda faqat og‘irlik va hajm). Qatorniki bo‘lsa raqami bilan yozing: «1: 300 dona».',
    );
    // The row was not touched by a figure the seller did not address to it.
    expect(out.goods[0]).toMatchObject({ quantity: 300 });
  });

  it('a netto beside the brutto: the brutto is written, the netto said', async () => {
    const out = await answer(atTable([KURTKA]), 'brutto 507 kg netto 480 kg');
    expect(out.kg).toBe(507);
    expect(out.replies[0]).toContain(
      '⚠️ «netto 480 kg» — umumiy og‘irlik brutto (qadoq bilan) yoziladi, netto umumiyga yozilmadi. Qatorniki bo‘lsa raqami bilan yozing: «1: 480 kg».',
    );
    // 480 is no brutto and was written nowhere: the row keeps its 150.
    expect(out.goods[0]).toMatchObject({ weightKg: 150 });
  });

  it('two different weights: neither is written, both are named, the cube is', async () => {
    const out = await answer(atTable([KURTKA]), 'jami 507 kg 480 kg 5.9 kub');
    expect([out.kg, out.m3]).toEqual([null, 5.9]);
    expect(out.replies[0]).toContain('⚠️ «507 kg», «480 kg» — ikki xil og‘irlik: bittasini yozing, masalan «jami 507 kg».');
  });

  it('a number with no unit beside a worded total', async () => {
    const out = await answer(atTable([KURTKA]), 'jami 507 kg 5.9');
    expect([out.kg, out.m3]).toEqual([507, null]);
    expect(out.replies[0]).toContain('⚠️ «5.9» — birligi yozilmagan: «jami 5.9 kg» yoki «jami 5.9 kub» deb yozing.');
  });

  it('the row hint names the first row still open, and is left out of a table with no row', async () => {
    // Row 2 is the one that still owes a figure: the example points there.
    const twoRows = atTable([KURTKA, { name: 'Shim' }]);
    expect((await answer(twoRows, 'jami 507 kg 300 dona')).replies[0]).toContain('«2: 300 dona»');
    const none = await answer(atTable([]), 'jami 507 kg 300 dona');
    expect(none.kg).toBe(507);
    expect(none.replies[0]).toContain('⚠️ «300 dona» — umumiyga yozilmaydi (umumiyda faqat og‘irlik va hajm).');
    expect(none.replies[0]).not.toContain('Qatorniki');
  });

  it('a bare «jami 3500» with both totals open keeps the sentence it always had', async () => {
    const out = await answer(atTable([KURTKA]), 'jami 3500');
    expect(out.kg).toBeNull();
    expect(out.replies[0]).toContain('⚠️ Umumiy uchun birlik bilan yozing: «jami 3500 kg» yoki «jami 12 kub».');
  });
});

describe('T2 — the plain door: the totals are written quietly, an addressed refusal keeps its one line (docs/IKKI-ESHIK.md §2.2 a)', () => {
  it('the kilos are written; the count gets its one line', async () => {
    const out = await say(atTable([KURTKA], { ai: false }), 'jami 507 kg 300 dona');
    expect(out.kg).toBe(507);
    expect(out.replies).toEqual([
      '⚠️ «300 dona» — umumiyga yozilmaydi (umumiyda faqat og‘irlik va hajm). Qatorniki bo‘lsa raqami bilan yozing: «1: 300 dona».',
    ]);
    // The seller's own words are kept for the VED, as every plain answer is.
    expect(out.answers.at(-1)).toBe('jami 507 kg 300 dona');
  });

  it('both totals: written, and not a word', async () => {
    const out = await say(atTable([KURTKA], { ai: false }), 'jami 507 kg 5.92 cbm');
    expect([out.kg, out.m3]).toEqual([507, 5.92]);
    expect(out.replies).toEqual([]);
    expect(out.answers.at(-1)).toBe('Umumiy: jami 507 kg 5.92 cbm');
  });
});
