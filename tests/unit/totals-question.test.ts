import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shipment's totals, asked (his 2.7 b, docs/SAKKIZ-R2.md §8.2.5): BRUTTO
 * kilos on every freight section and every door, the cube only when the lines
 * cannot give it, a bare number read as the unit the question asked, the
 * answer kept across a re-read (judge concurrency-4), and an orphaned answer
 * kept away from the paid assistant (judge concurrency-5).
 *
 * The model, the budget and Telegram are stand-ins: what is under test is
 * what the collector does with them.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));
const bot = vi.hoisted(() => ({ assistant: vi.fn(async () => null), lookup: vi.fn(async () => null) }));
vi.mock('@/modules/platform/telegram/staff-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/staff-bot')>()),
  assistantFromBot: bot.assistant,
  lookupFromBot: bot.lookup,
}));
vi.mock('@/modules/platform/notes/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/notes/service')>()),
  notesByTitle: async () => [],
}));
vi.mock('@/modules/platform/ai/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/ai/model')>()),
  aiConfigured: () => true,
}));
vi.mock('@/modules/platform/telegram/send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/send')>()),
  sendTyping: async () => ({ ok: true }),
  sendTextBriefRetry: async () => ({ ok: true }),
  editText: async () => ({ ok: true }),
}));

import { factsVolumeM3 } from '@/modules/wms/calc/intake';
import {
  activeIntake,
  analyzeCollected,
  endIntake,
  looksLikeTotalsAnswer,
  startIntake,
  totalsQuestion,
  totalsQuestionText,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import {
  LOST_TOTALS_ANSWER,
  answerStaffText,
  applyLineAnswer,
  handleCalcCallback,
} from '@/modules/platform/telegram/staff-handlers';

let seq = 0;
const chats: bigint[] = [];
function collection(
  patch: Partial<IntakeState> = {},
  section: IntakeState['section'] = 'yolkira',
): { chatId: bigint; state: IntakeState } {
  seq += 1;
  const chatId = BigInt(-9_600_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section);
  return { chatId, state: updateIntake(chatId, patch)! };
}

function fakeCtx() {
  const replies: string[] = [];
  return {
    replies,
    async reply(text: string) {
      replies.push(text);
      return { message_id: replies.length };
    },
    api: {} as import('grammy').Api,
  };
}

/** A reading of the material, as the model would hand it back. */
const reads = (facts: Partial<IntakeState['facts']>) => ({
  ok: true,
  facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: null, volumeM3: null, goods: [], ...facts },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
  answered: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
});

const ask = (state: Pick<IntakeState, 'section' | 'totalsAsked' | 'facts'>) =>
  totalsQuestion(state, factsVolumeM3(state.facts));

beforeEach(() => {
  model.analyze.mockReset();
  bot.assistant.mockClear();
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('whether and which totals are asked', () => {
  const lines = { goods: [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }, { name: 'Shim', quantity: 200, volumeM3: 1.6 }] };

  it('every freight section asks, on every door; rastamojka never does', () => {
    expect(ask({ section: 'yolkira', totalsAsked: false, facts: {} })).toBe('both');
    expect(ask({ section: 'podklyuch', totalsAsked: false, facts: {} })).toBe('both');
    expect(ask({ section: 'rastamojka', totalsAsked: false, facts: {} })).toBeNull();
  });

  it('kg when the cube is stated or summable; m3 when only the kilos are; both when neither', () => {
    expect(ask({ section: 'yolkira', totalsAsked: false, facts: { volumeM3: 12 } })).toBe('kg');
    expect(ask({ section: 'yolkira', totalsAsked: false, facts: lines })).toBe('kg');
    expect(ask({ section: 'yolkira', totalsAsked: false, facts: { weightKg: 3500 } })).toBe('m3');
    expect(ask({ section: 'yolkira', totalsAsked: false, facts: { weightKg: 3500, ...lines } })).toBeNull();
  });

  it('asked once', () => {
    expect(ask({ section: 'yolkira', totalsAsked: true, facts: {} })).toBeNull();
  });

  it('the cube question never asks the kilos the seller already typed (product-fit-7)', () => {
    const text = totalsQuestionText('m3', { weightKg: 3500 }, { m3: null, fromLines: false });
    expect(text).toBe('Yo‘lkira uchun umumiy hajm (kub) kerak. Masalan: «12» yoki «12 kub»\n(brutto og‘irlik bor: 3500 kg)');
    expect(text).not.toContain('BRUTTO og‘irlik kerak');
  });

  it('the brutto question says what is known, and where a summed cube came from', () => {
    expect(totalsQuestionText('kg', {}, { m3: 2.8, fromLines: true })).toBe(
      'Yo‘lkira uchun umumiy BRUTTO og‘irlik kerak (qadoq bilan), kg. Masalan: «3500» yoki «3500 kg»\n(hajm: 2.8 m³ — qatorlardan qo‘shildi)',
    );
    expect(totalsQuestionText('kg', {}, { m3: 12, fromLines: false })).toContain('\n(hajm bor: 12 m³)');
    expect(totalsQuestionText('both', {}, { m3: null, fromLines: false })).toBe(
      'Yo‘lkira uchun umumiy hajm va brutto og‘irlik kerak. Masalan: «12 kub 3500 kg»',
    );
  });

  it('a plain-door yolkira collection is ASKED after its reading (the AI-podklyuch gate is gone)', async () => {
    const { chatId } = collection({ stage: 'question', ai: false, askingIndex: null, facts: { fromCity: 'Yiwu', toCity: 'Toshkent' } });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.replies.at(-1)).toBe('Yo‘lkira uchun umumiy hajm va brutto og‘irlik kerak. Masalan: «12 kub 3500 kg»');
    expect(activeIntake(chatId)).toMatchObject({ askingTotalsFor: 'both', totalsAsked: true });
  });
});

describe('the answer', () => {
  it('a bare «3500» after the brutto question is 3500 kg', async () => {
    const { chatId, state } = collection({ stage: 'question', askingTotalsFor: 'kg', totalsAsked: true, facts: { volumeM3: 12 } });
    const ctx = fakeCtx();
    await applyLineAnswer(ctx, chatId, state, '3500');
    const live = activeIntake(chatId)!;
    expect(live.facts.weightKg).toBe(3500);
    expect(live.facts.volumeM3).toBe(12);
    expect(live.totalsAnswer).toEqual({ weightKg: 3500, volumeM3: null });
    // The text goes to the card with the per-line answers, not into the
    // material a re-read parses.
    expect(live.answers).toEqual(['Umumiy: 3500']);
    expect(live.material).toEqual([]);
    expect(live.stage).toBe('review');
  });

  it('a bare «12» after the cube question is 12 m³; after the question for BOTH it is refused in words', async () => {
    const m3 = collection({ stage: 'question', askingTotalsFor: 'm3', totalsAsked: true, facts: { weightKg: 3500 } });
    await applyLineAnswer(fakeCtx(), m3.chatId, m3.state, '12');
    expect(activeIntake(m3.chatId)!.facts.volumeM3).toBe(12);

    const both = collection({ stage: 'question', askingTotalsFor: 'both', totalsAsked: true });
    const ctx = fakeCtx();
    await applyLineAnswer(ctx, both.chatId, both.state, '3500');
    expect(ctx.replies).toEqual(['Kub va kg ni birlik bilan yozing: «12 kub 3500 kg»']);
    expect(activeIntake(both.chatId)!.facts.weightKg ?? null).toBeNull();
  });

  it('the answer survives «➕ Yana ma’lumot» → «Bo‘ldi»: a re-read that finds no kilos keeps 3500', async () => {
    const { chatId, state } = collection({
      stage: 'question',
      askingTotalsFor: 'kg',
      totalsAsked: true,
      material: ['Kurtka 300 dona 12 kub'],
      facts: { volumeM3: 12 },
    });
    await applyLineAnswer(fakeCtx(), chatId, state, '3500');
    // More material, read again — the model finds the cube and no weight.
    updateIntake(chatId, { stage: 'material', material: [...activeIntake(chatId)!.material, 'Shim 50 dona'] });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    const out = await analyzeCollected(activeIntake(chatId)!);
    expect(out.facts.weightKg).toBe(3500);
    // …and the question stays answered: nothing it asked is missing.
    expect(out.totalsAsked).toBe(true);
  });

  it('a re-read that still misses the asked figure clears «asked», so the question comes again', async () => {
    const { state } = collection({ stage: 'material', totalsAsked: true, material: ['Kurtka 300 dona'] });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    const out = await analyzeCollected(state);
    expect(out.facts.weightKg ?? null).toBeNull();
    expect(out.totalsAsked).toBe(false);
  });
});

describe('an answer with no collection to answer (judge concurrency-5)', () => {
  it('reads only digits and the kg / kub words as a totals answer', () => {
    for (const text of ['3500', '3500 kg', '12 kub', '12 kub 3500 kg', '3 500', '3500kg', '12 m³']) {
      expect(looksLikeTotalsAnswer(text), text).toBe(true);
    }
    for (const text of ['Kurtka 300 kg', 'GS777', 'kg', '', 'YW26-000123', '12 kub qayerda']) {
      expect(looksLikeTotalsAnswer(text), text).toBe(false);
    }
  });

  it('is told the collection is gone, and the paid assistant is never asked', async () => {
    const chatId = BigInt(-9_700_000_001);
    const ctx = fakeCtx();
    await answerStaffText(ctx, chatId, 'staff-1', '3500', { backlog: false, messageId: null, once: null });
    // The assistant is dispatched off the poller; give it the tick it takes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bot.assistant).not.toHaveBeenCalled();
    expect(ctx.replies).toEqual([LOST_TOTALS_ANSWER]);
  });

  it('any other words still reach the assistant', async () => {
    const chatId = BigInt(-9_700_000_002);
    const ctx = fakeCtx();
    await answerStaffText(ctx, chatId, 'staff-1', 'bu oy qancha kub keldi', { backlog: false, messageId: null, once: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bot.assistant).toHaveBeenCalledTimes(1);
  });
});
