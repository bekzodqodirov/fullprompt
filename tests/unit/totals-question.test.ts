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
// Door B's «🔍» claims its one search before the assistant; the claim's
// table is not what is under test.
vi.mock('@/modules/platform/telegram/once', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/once')>()),
  claimOnce: async () => true,
}));
vi.mock('@/modules/platform/telegram/send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/send')>()),
  sendTyping: async () => ({ ok: true }),
  sendTextBriefRetry: async () => ({ ok: true }),
  editText: async () => ({ ok: true }),
}));

import { factsVolumeM3, intakeSummaryText } from '@/modules/wms/calc/intake';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';
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
  settleAnalysis,
} from '@/modules/platform/telegram/staff-handlers';
import type { OnceKey } from '@/modules/platform/telegram/once';

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

/** «Bo‘ldi» pressed: the analysis runs off the poller, so wait for it to land. */
async function pressDone(ctx: ReturnType<typeof fakeCtx>, chatId: bigint) {
  await handleCalcCallback(ctx, chatId, 'done');
  for (let i = 0; i < 200 && activeIntake(chatId)?.analysing; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(activeIntake(chatId)?.analysing ?? null).toBeNull();
}

/** «1,200 kg» — the material's weight, written two ways. */
const KG_1200 = { field: 'weightKg' as const, text: '1,200', decimal: 1.2, thousands: 1200 };

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

  it('through the door: «Bo‘ldi» after the answer keeps 3500 and the question stays answered (P3-1)', async () => {
    const { chatId } = collection({
      stage: 'review',
      totalsAsked: true,
      totalsAnswer: { weightKg: 3500, volumeM3: null },
      material: ['Kurtka 300 dona 12 kub'],
      facts: { volumeM3: 12, weightKg: 3500 },
    });
    // The re-read finds the cube and no kilos.
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    const ctx = fakeCtx();
    await pressDone(ctx, chatId);
    const live = activeIntake(chatId)!;
    expect(live.facts.weightKg).toBe(3500);
    expect(live.totalsAsked).toBe(true);
    expect(ctx.replies.at(-1)).toContain('Og‘irlik: 3500 kg');
  });

  it('through the door: a re-read that still misses the kilos asks the brutto AGAIN (P3-1)', async () => {
    const { chatId } = collection({
      stage: 'review',
      totalsAsked: true,
      material: ['Kurtka 300 dona 12 kub'],
      facts: { volumeM3: 12 },
    });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    const ctx = fakeCtx();
    await pressDone(ctx, chatId);
    expect(ctx.replies.at(-1)).toBe(
      'Yo‘lkira uchun umumiy BRUTTO og‘irlik kerak (qadoq bilan), kg. Masalan: «3500» yoki «3500 kg»\n(hajm bor: 12 m³)',
    );
    expect(activeIntake(chatId)).toMatchObject({ askingTotalsFor: 'kg', totalsAsked: true });
  });

  it('an answer typed WHILE the reading ran is put back by settleAnalysis, its ambiguity with it (P3-1, P3-3)', () => {
    const { chatId, state: snapshot } = collection({ analysing: 'tok', totalsAsked: true, ambiguousTotals: [KG_1200] });
    // The seller answered «1200» to the brutto question while the model read.
    const live = updateIntake(chatId, { totalsAnswer: { weightKg: 1200, volumeM3: null } })!;
    const analysed: IntakeState = {
      ...snapshot,
      facts: { volumeM3: 12, weightKg: null, goods: [] },
      totalsAsked: false,
      ambiguousTotals: [KG_1200],
    };
    const out = settleAnalysis(live, snapshot, analysed, 'tok');
    expect(out.kind).toBe('done');
    if (out.kind === 'gone') return;
    expect(out.state.facts.weightKg).toBe(1200);
    expect(out.state.ambiguousTotals).toEqual([]);
  });

  it('a re-read that still misses the asked figure clears «asked», so the question comes again', async () => {
    const { state } = collection({ stage: 'material', totalsAsked: true, material: ['Kurtka 300 dona'] });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    const out = await analyzeCollected(state);
    expect(out.facts.weightKg ?? null).toBeNull();
    expect(out.totalsAsked).toBe(false);
  });
});

describe('a total typed two ways (review P3-3, P3-R2)', () => {
  const twoLines = [
    { name: 'Kurtka', quantity: 300, volumeM3: 1.2 },
    { name: 'Shim', quantity: 200, volumeM3: 1.6 },
  ];

  it('the answer to the brutto question retires its own «mi yoki» — the summary no longer asks about it', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka 300 dona 1.2 kub, 1,200 kg'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 1200, goods: [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }] }));
    const ctx = fakeCtx();
    await pressDone(ctx, chatId);
    // Asked — and told WHY, since the seller typed a weight.
    expect(activeIntake(chatId)!.askingTotalsFor).toBe('kg');
    expect(ctx.replies.at(-1)).toContain('«1,200 kg» — 1.2 mi yoki 1200 mi?');
    await applyLineAnswer(ctx, chatId, activeIntake(chatId)!, '1200');
    const summary = ctx.replies.at(-1)!;
    expect(summary).toContain('Og‘irlik: 1200 kg');
    expect(summary).not.toContain('mi yoki');
    expect(activeIntake(chatId)!.ambiguousTotals).toEqual([]);
  });

  it('…and a re-read of the same material does not bring it back', async () => {
    const { state } = collection({
      stage: 'material',
      totalsAsked: true,
      totalsAnswer: { weightKg: 1200, volumeM3: null },
      material: ['Kurtka 300 dona 1.2 kub, 1,200 kg', 'Shim 200 dona'],
    });
    model.analyze.mockResolvedValueOnce(reads({ goods: [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }] }));
    const out = await analyzeCollected(state);
    expect(out.facts.weightKg).toBe(1200);
    expect(out.ambiguousTotals).toEqual([]);
  });

  it('a cube typed two ways is ASKED, never answered by the lines’ Σ, and the summary does not say «to‘liq»', async () => {
    const { state } = collection({ stage: 'material', material: ['Yiwu - Toshkent, 3500 kg, 2,500 kub'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 3500, volumeM3: 2500, goods: twoLines }));
    const out = await analyzeCollected(state);
    expect(out.facts.volumeM3 ?? null).toBeNull();
    expect(out.facts.volumeAmbiguous).toBe(true);
    expect(factsVolumeM3(out.facts)).toBeNull();
    expect(ask(out)).toBe('m3');
    const summary = intakeSummaryText({
      section: 'yolkira',
      facts: out.facts,
      laws: new Map(),
      clientLabel: null,
      fileCount: 0,
      ambiguous: out.ambiguousTotals,
    });
    expect(summary).not.toContain('to‘liq');
    expect(summary).toContain('Hajm: —');
  });

  it('the answer «2.5» settles the cube: the flag and its «mi yoki» go, the typed figure stands', async () => {
    const { chatId } = collection({
      stage: 'question',
      askingTotalsFor: 'm3',
      totalsAsked: true,
      ambiguousTotals: parseManualFacts('3500 kg, 2,500 kub').ambiguous,
      facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 3500, volumeAmbiguous: true, goods: twoLines },
    });
    const ctx = fakeCtx();
    await applyLineAnswer(ctx, chatId, activeIntake(chatId)!, '2.5');
    const live = activeIntake(chatId)!;
    expect(live.facts.volumeM3).toBe(2.5);
    expect(live.facts.volumeAmbiguous).toBeUndefined();
    expect(factsVolumeM3(live.facts)).toBe(2.5);
    expect(ctx.replies.at(-1)).not.toContain('mi yoki');
    expect(ctx.replies.at(-1)).toContain('✅ Ma’lumot to‘liq');
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

  it('a phone number is not a totals answer — the assistant finds people by it (review P3-R1)', () => {
    for (const text of ['+998 90 123 45 67', '+998901234567', '998901234567', '901234567', '90 123 45 67', '123 45 67']) {
      expect(looksLikeTotalsAnswer(text), text).toBe(false);
    }
    // …while a figure grouped by thousands, beside a cube, still is one.
    for (const text of ['12 kub 3 500 kg', '12.5 kub 3500 kg', '1,200 kg', '3500 kg.']) {
      expect(looksLikeTotalsAnswer(text), text).toBe(true);
    }
  });

  it('a typed phone number reaches the assistant, not the lost-collection sentence', async () => {
    const ctx = fakeCtx();
    await answerStaffText(ctx, BigInt(-9_700_000_003), 'staff-1', '+998 90 123 45 67', {
      backlog: false,
      messageId: 3,
      once: null,
      waitDeclined: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.replies).not.toContain(LOST_TOTALS_ANSWER);
    expect(bot.assistant).toHaveBeenCalledTimes(1);
  });

  it('Door B’s «🔍» replays a FORWARDED customer message: «12 kub 3500 kg» is searched, never called a lost answer', async () => {
    const ctx = fakeCtx();
    await answerStaffText(ctx, BigInt(-9_700_000_004), 'staff-1', '12 kub 3500 kg', {
      backlog: false,
      messageId: null,
      once: 'q:-9700000004:1:search' as unknown as OnceKey,
      waitDeclined: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.replies).not.toContain(LOST_TOTALS_ANSWER);
    expect(bot.assistant).toHaveBeenCalledTimes(1);
  });

  it('a figure the ⏰ wait declined («Bu sana emas» said already) is not told a collection was lost', async () => {
    const ctx = fakeCtx();
    await answerStaffText(ctx, BigInt(-9_700_000_005), 'staff-1', '3500', {
      backlog: false,
      messageId: 5,
      once: null,
      waitDeclined: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.replies).not.toContain(LOST_TOTALS_ANSWER);
    expect(bot.assistant).toHaveBeenCalledTimes(1);
  });

  it('is told the collection is gone, and the paid assistant is never asked', async () => {
    const chatId = BigInt(-9_700_000_001);
    const ctx = fakeCtx();
    await answerStaffText(ctx, chatId, 'staff-1', '3500', { backlog: false, messageId: 1, once: null, waitDeclined: false });
    // The assistant is dispatched off the poller; give it the tick it takes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bot.assistant).not.toHaveBeenCalled();
    expect(ctx.replies).toEqual([LOST_TOTALS_ANSWER]);
  });

  it('any other words still reach the assistant', async () => {
    const chatId = BigInt(-9_700_000_002);
    const ctx = fakeCtx();
    await answerStaffText(ctx, chatId, 'staff-1', 'bu oy qancha kub keldi', {
      backlog: false,
      messageId: 2,
      once: null,
      waitDeclined: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bot.assistant).toHaveBeenCalledTimes(1);
  });
});
