import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shipment's totals, asked (his 2.7 b, docs/SAKKIZ-R2.md §8.2.5) — since
 * R3 as the table's `Umumiy` rows (his 1.10 c, docs/SAKKIZ-R3.md §2.1): which
 * totals are ⚠️ is `missingFields` minus the line fields on EVERY section
 * (regression-22), a bare number goes to the single open total by its own
 * unit, the answer is kept across a re-read (judge concurrency-4) and doubted
 * by later material (CONC-2), and an orphaned answer is kept away from the
 * paid assistant (judge concurrency-5).
 *
 * The model, the budget and Telegram are stand-ins: what is under test is
 * what the collector does with them.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
// The reading job bills each answered reading itself (docs/SAKKIZ-R3.md §7.2.10).
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100, recordAiPass: async () => {} }));
// «Bo‘ldi» only enqueues since the reading is a pg-boss job (§7.1).
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
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
// `sendTextBriefRetry` is the real one (P2): the reading job delivers its
// table through it, and the drive stands in for Telegram underneath it, so
// the table reaches the fake ctx. The assistant stand-in answers nothing, so
// nothing else here reaches it.
vi.mock('@/modules/platform/telegram/send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/send')>()),
  sendTyping: async () => ({ ok: true }),
  editText: async () => ({ ok: true }),
}));

import { factsVolumeM3, intakeTableText, tableOpenOf, type CalcFacts, type CalcSection } from '@/modules/wms/calc/intake';
import { nameWordFor } from '@/modules/wms/calc/line-address';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';
import {
  activeIntake,
  analyzeCollected,
  endIntake,
  looksLikeTotalsAnswer,
  startIntake,
  totalsAnswerShape,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import {
  BARE_FIGURE_NOT_FOUND,
  answerStaffText,
  handleCalcCallback,
  settleAnalysis,
} from '@/modules/platform/telegram/staff-handlers';
import {
  NO_OPEN_COLLECTION,
  applyTableAnswer,
  deliverNextStep,
  tableEditsSettled,
} from '@/modules/platform/telegram/calc-dialog';
import type { OnceKey } from '@/modules/platform/telegram/once';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

let seq = 0;
const chats: bigint[] = [];
function collection(
  patch: Partial<IntakeState> = {},
  section: IntakeState['section'] = 'yolkira',
): { chatId: bigint; state: IntakeState } {
  seq += 1;
  const chatId = BigInt(-9_600_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-test' });
  return { chatId, state: updateIntake(chatId, patch)! };
}

/** Replies, and the table's in-place edits (the last one is the table the seller now reads). */
function fakeCtx() {
  const replies: string[] = [];
  const edits: string[] = [];
  return {
    replies,
    edits,
    async reply(text: string) {
      replies.push(text);
      return { message_id: replies.length };
    },
    api: {
      async editMessageText(_chat: string, _id: number, text: string) {
        edits.push(text);
        return true;
      },
    },
  };
}

/** The staff text door's ctx — `answerStaffText` takes grammy's whole api, and these cases never reach it. */
function staffCtx() {
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

/** A typed message in the table stage, the table's edit settled. */
async function answer(ctx: ReturnType<typeof fakeCtx>, chatId: bigint, text: string) {
  await applyTableAnswer(ctx, chatId, activeIntake(chatId)!, text, { date: 0, messageId: 77, forwarded: false, replyTo: null });
  await tableEditsSettled();
}

/** A reading of the material, as the model would hand it back. */
const reads = (facts: Partial<IntakeState['facts']>) => ({
  ok: true,
  facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: null, volumeM3: null, goods: [], ...facts },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
  answered: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
});

/** The open totals rows of a table — `tableOpenOf`, the table's own rule. */
const openTotals = (section: CalcSection, facts: CalcFacts) =>
  tableOpenOf({ section, facts, laws: new Map(), amend: null }).flatMap((t) => ('totals' in t ? [t.totals] : []));

const table = (section: CalcSection, facts: CalcFacts, ambiguous: IntakeState['ambiguousTotals'] = []) =>
  intakeTableText({ section, facts, laws: new Map(), clientLabel: null, fileCount: 0, ambiguous, amend: null, tail: '', nameWord: nameWordFor });

const ROAD = { fromCity: 'Yiwu', toCity: 'Toshkent' };

/**
 * «Bo‘ldi» pressed. Re-anchored (docs/SAKKIZ-R3.md §11, P2): the press only
 * enqueues — the reading is the job, run here through the one drive helper,
 * which hands what it sends to `ctx`.
 */
async function pressDone(ctx: ReturnType<typeof fakeCtx>, chatId: bigint) {
  await handleCalcCallback(ctx, chatId, 'done');
  await driveReading(chatId, ctx);
  expect(activeIntake(chatId)?.analysing ?? null).toBeNull();
}

/** «1,200 kg» — the material's weight, written two ways. */
const KG_1200 = { field: 'weightKg' as const, text: '1,200', decimal: 1.2, thousands: 1200 };

beforeEach(() => {
  model.analyze.mockReset();
  bot.assistant.mockClear();
  resetReadingDrive();
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('which totals rows are ⚠️', () => {
  const lines = { goods: [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }, { name: 'Shim', quantity: 200, volumeM3: 1.6 }] };

  it('every section marks a missing brutto and cube — rastamojka too (regression-22, MR-9)', () => {
    // R2's `totalsQuestion` said «rastamojka never asks» while MR-9's
    // REQUIRED_FIELDS asks brutto and m³ there: one home now, `missingFields`
    // minus the line fields (docs/SAKKIZ-R3.md §11, re-check p3-5).
    for (const section of ['yolkira', 'podklyuch', 'rastamojka'] as const) {
      expect(openTotals(section, {}), section).toEqual(['weightKg', 'volumeM3']);
    }
  });

  it('kg when the cube is stated or summable; m3 when only the kilos are; nothing when both', () => {
    expect(openTotals('yolkira', { volumeM3: 12 })).toEqual(['weightKg']);
    expect(openTotals('yolkira', lines)).toEqual(['weightKg']);
    expect(openTotals('yolkira', { weightKg: 3500 })).toEqual(['volumeM3']);
    expect(openTotals('yolkira', { weightKg: 3500, ...lines })).toEqual([]);
  });

  it('the table never asks the kilos the seller already typed (product-fit-7)', () => {
    const text = table('yolkira', { ...ROAD, weightKg: 3500, goods: [{ name: 'Kurtka', quantity: 300 }] });
    expect(text).toContain('✅ Og‘irlik (brutto): 3500 kg');
    expect(text).toContain('⚠️ umumiy hajmi (kub) — yozilmagan');
    expect(text).toContain('«jami 12 kub»');
    expect(text).not.toContain('jami 3500 kg');
  });

  it('the brutto row says what is known, and where a summed cube came from', () => {
    const summed = table('yolkira', { ...ROAD, ...lines });
    expect(summed).toContain('⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
    expect(summed).toContain('✅ Hajm: 2.8 m³ (qatorlardan)');
    expect(summed).toContain('«jami 3500 kg»');
    expect(table('yolkira', { ...ROAD, volumeM3: 12 })).toContain('✅ Hajm: 12 kub');
  });

  it('a plain-door yolkira collection gets the table after its reading, both totals ⚠️ (the AI-podklyuch gate is gone)', async () => {
    const { chatId, state } = collection({ stage: 'material', ai: false, facts: { ...ROAD } });
    const ctx = fakeCtx();
    await deliverNextStep(ctx, chatId, state);
    const text = ctx.replies.at(-1)!;
    expect(text).toContain('⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
    expect(text).toContain('⚠️ umumiy hajmi (kub) — yozilmagan');
    expect(activeIntake(chatId)!.stage).toBe('review');
  });
});

describe('the answer', () => {
  it('a bare «3500» with only the brutto row ⚠️ is 3500 kg', async () => {
    const { chatId } = collection({ stage: 'review', facts: { ...ROAD, volumeM3: 12 } });
    await answer(fakeCtx(), chatId, '3500');
    const live = activeIntake(chatId)!;
    expect(live.facts.weightKg).toBe(3500);
    expect(live.facts.volumeM3).toBe(12);
    expect(live.totalsAnswer).toEqual({ weightKg: 3500, volumeM3: null, at: { material: 0, files: 0 } });
    // The text goes to the card with the per-line answers, not into the
    // material a re-read parses — and it says where it went (re-check p3-14).
    expect(live.answers).toEqual(['Umumiy: 3500']);
    expect(live.material).toEqual([]);
    expect(live.stage).toBe('review');
  });

  it('a bare «12» with only the cube ⚠️ is 12 m³; with BOTH ⚠️ it is refused in words', async () => {
    const m3 = collection({ stage: 'review', facts: { ...ROAD, weightKg: 3500 } });
    await answer(fakeCtx(), m3.chatId, '12');
    expect(activeIntake(m3.chatId)!.facts.volumeM3).toBe(12);

    const both = collection({ stage: 'review', facts: { ...ROAD } });
    const ctx = fakeCtx();
    await answer(ctx, both.chatId, '3500');
    expect(ctx.replies[0]).toContain('⚠️ Umumiy uchun birlik bilan yozing: «jami 3500 kg» yoki «jami 12 kub».');
    expect(activeIntake(both.chatId)!.facts.weightKg ?? null).toBeNull();
  });

  it('a bare answer holding TWO figures for the brutto row is refused, never read as one (review P3-R7)', async () => {
    for (const text of ['12 3500', '12 3 500']) {
      const { chatId } = collection({ stage: 'review', facts: { ...ROAD, volumeM3: 12, goods: [] } });
      const ctx = fakeCtx();
      await answer(ctx, chatId, text);
      expect(ctx.replies[0], text).toContain('⚠️ Umumiy uchun birlik bilan yozing');
      expect(activeIntake(chatId)!.facts.weightKg ?? null, text).toBeNull();
      // Kept for the card verbatim — it went nowhere.
      expect(activeIntake(chatId)!.answers).toEqual([text]);
      // Said again the same way: still never one weight.
      await answer(ctx, chatId, text);
      expect(activeIntake(chatId)!.facts.weightKg ?? null, text).toBeNull();
      expect(activeIntake(chatId)!.totalsAnswer.weightKg, text).toBeNull();
    }
    // One figure grouped by thousands is still one.
    const one = collection({ stage: 'review', facts: { ...ROAD, volumeM3: 12 } });
    await answer(fakeCtx(), one.chatId, '3 500');
    expect(activeIntake(one.chatId)!.facts.weightKg).toBe(3500);
  });

  it('the answer survives «➕ Yana ma’lumot» → «Bo‘ldi»: a re-read that finds no kilos keeps 3500', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka 300 dona 12 kub'], facts: { ...ROAD, volumeM3: 12 } });
    await answer(fakeCtx(), chatId, '3500');
    // More material, read again — the model finds the cube and no weight.
    updateIntake(chatId, { stage: 'material', material: [...activeIntake(chatId)!.material, 'Shim 50 dona'] });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    const out = await analyzeCollected(activeIntake(chatId)!);
    expect(out.facts.weightKg).toBe(3500);
    // …and the brutto row stays ✅: nothing it marked is missing.
    expect(openTotals('yolkira', out.facts)).toEqual([]);
  });

  it('through the door: «Bo‘ldi» after the answer keeps 3500 and the table says which weight (P3-1, PF-1)', async () => {
    const { chatId } = collection({
      stage: 'review',
      totalsAnswer: { weightKg: 3500, volumeM3: null, at: { material: 1, files: 0 } },
      material: ['Kurtka 300 dona 12 kub'],
      facts: { volumeM3: 12, weightKg: 3500 },
    });
    // The re-read finds the cube and no kilos.
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    const ctx = fakeCtx();
    await pressDone(ctx, chatId);
    expect(activeIntake(chatId)!.facts.weightKg).toBe(3500);
    expect(ctx.replies.at(-1)).toContain('✅ Og‘irlik (brutto): 3500 kg');
  });

  it('through the door: a re-read that still misses the kilos marks the brutto ⚠️ AGAIN (P3-1)', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka 300 dona 12 kub'], facts: { volumeM3: 12 } });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    const ctx = fakeCtx();
    await pressDone(ctx, chatId);
    const text = ctx.replies.at(-1)!;
    expect(text).toContain('⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
    expect(text).toContain('✅ Hajm: 12 kub');
    expect(openTotals('yolkira', activeIntake(chatId)!.facts)).toEqual(['weightKg']);
  });

  it('an answer typed WHILE the reading ran is put back by settleAnalysis, its ambiguity with it (P3-1, P3-3)', () => {
    const { chatId, state: snapshot } = collection({ analysing: 'tok', ambiguousTotals: [KG_1200] });
    // The seller answered «1200» to the brutto row while the model read.
    const live = updateIntake(chatId, { totalsAnswer: { weightKg: 1200, volumeM3: null, at: { material: 0, files: 0 } } })!;
    const analysed: IntakeState = {
      ...snapshot,
      facts: { volumeM3: 12, weightKg: null, goods: [] },
      ambiguousTotals: [KG_1200],
    };
    const out = settleAnalysis(live, snapshot, analysed, 'tok');
    expect(out.kind).toBe('done');
    if (out.kind === 'gone') return;
    expect(out.state.facts.weightKg).toBe(1200);
    expect(out.state.ambiguousTotals).toEqual([]);
  });

  it('a re-read that still misses the figure leaves its row ⚠️ — nothing remembers it as «asked»', async () => {
    // R2's «asked once» flag is retired with the question: the table marks
    // what the facts lack, every time it is drawn.
    const { state } = collection({ stage: 'material', material: ['Kurtka 300 dona'] });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    const out = await analyzeCollected(state);
    expect(out.facts.weightKg ?? null).toBeNull();
    expect(openTotals('yolkira', out.facts)).toEqual(['weightKg']);
  });
});

describe('a total typed two ways (review P3-3, P3-R2)', () => {
  const twoLines = [
    { name: 'Kurtka', quantity: 300, volumeM3: 1.2 },
    { name: 'Shim', quantity: 200, volumeM3: 1.6 },
  ];

  it('the answer to the brutto row retires its own «mi yoki» — the table no longer asks about it', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka 300 dona 1.2 kub, 1,200 kg'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 1200, goods: [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }] }));
    const ctx = fakeCtx();
    await pressDone(ctx, chatId);
    // Asked — and the row says WHY, since the seller typed a weight (re-check p3-7).
    const first = ctx.replies.at(-1)!;
    expect(first).toContain('⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — ikki xil yozilgan (pastda)');
    expect(first).toContain('«1,200 kg» — 1.2 mi yoki 1200 mi?');
    await answer(ctx, chatId, '1200');
    const after = ctx.edits.at(-1)!;
    expect(after).toContain('✅ Og‘irlik (brutto): 1200 kg');
    expect(after).not.toContain('mi yoki');
    expect(activeIntake(chatId)!.ambiguousTotals).toEqual([]);
  });

  it('…and a re-read of the same material does not bring it back', async () => {
    const { state } = collection({
      stage: 'material',
      totalsAnswer: { weightKg: 1200, volumeM3: null, at: { material: 2, files: 0 } },
      material: ['Kurtka 300 dona 1.2 kub, 1,200 kg', 'Shim 200 dona'],
    });
    model.analyze.mockResolvedValueOnce(reads({ goods: [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }] }));
    const out = await analyzeCollected(state);
    expect(out.facts.weightKg).toBe(1200);
    expect(out.ambiguousTotals).toEqual([]);
  });

  it('a cube typed two ways is ASKED, never answered by the lines’ Σ, and the table does not say «to‘liq»', async () => {
    const { state } = collection({ stage: 'material', material: ['Yiwu - Toshkent, 3500 kg, 2,500 kub'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 3500, volumeM3: 2500, goods: twoLines }));
    const out = await analyzeCollected(state);
    expect(out.facts.volumeM3 ?? null).toBeNull();
    expect(out.facts.volumeAmbiguous).toBe(true);
    expect(factsVolumeM3(out.facts)).toBeNull();
    expect(openTotals('yolkira', out.facts)).toEqual(['volumeM3']);
    // Re-anchored from the summary (re-check corpus-mig-seam-13): its ⚠️ row, never «to‘liq».
    const text = table('yolkira', out.facts, out.ambiguousTotals);
    expect(text).not.toContain('to‘liq');
    expect(text).toContain('⚠️ umumiy hajmi (kub) — ikki xil yozilgan (pastda)');
  });

  it('the answer «2.5» settles the cube: the flag and its «mi yoki» go, the typed figure stands', async () => {
    const { chatId } = collection({
      stage: 'review',
      tableMessageId: 900,
      ambiguousTotals: parseManualFacts('3500 kg, 2,500 kub').ambiguous,
      facts: { ...ROAD, weightKg: 3500, volumeAmbiguous: true, goods: twoLines },
    });
    const ctx = fakeCtx();
    await answer(ctx, chatId, '2.5');
    const live = activeIntake(chatId)!;
    expect(live.facts.volumeM3).toBe(2.5);
    expect(live.facts.volumeAmbiguous).toBeUndefined();
    expect(factsVolumeM3(live.facts)).toBe(2.5);
    expect(ctx.replies.at(-1)).not.toContain('mi yoki');
    expect(ctx.replies.at(-1)).toContain('✅ Hamma qator to‘liq');
    expect(ctx.edits.at(-1)).toContain('✅ Ma’lumot to‘liq');
  });
});

describe('material sent AFTER the answer (review CONC-2, re-driven through the table)', () => {
  const answered = (patch: Partial<IntakeState> = {}) =>
    collection({ stage: 'review', tableMessageId: 900, material: ['Kurtka 300 dona 12 kub'], facts: { ...ROAD, volumeM3: 12 }, ...patch });

  it('answer «jami 3500 kg», ➕ a forwarded «brutto 4200 kg», Bo‘ldi — asked with both figures, never 3500 in silence', async () => {
    const { chatId } = answered();
    const ctx = fakeCtx();
    await answer(ctx, chatId, 'jami 3500 kg');
    expect(activeIntake(chatId)!.facts.weightKg).toBe(3500);
    // The table answer carries R2's `at` mark: what it had seen.
    expect(activeIntake(chatId)!.totalsAnswer.at).toEqual({ material: 1, files: 0 });
    await handleCalcCallback(ctx, chatId, 'more');
    // A forward is material — the bot's `fileAsMaterial`, as a pushed line.
    updateIntake(chatId, { material: [...activeIntake(chatId)!.material, 'brutto 4200 kg'] });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    await pressDone(ctx, chatId);
    const live = activeIntake(chatId)!;
    expect(live.facts.weightKg ?? null).toBeNull();
    expect(ctx.replies.at(-1)).toContain(
      '⚠️ Siz 3500 kg deb javob bergansiz, keyin yuborilgan ma’lumotda 4200 kg — qaysi biri?',
    );
    // His answer settles it, and the doubt goes with it.
    await answer(ctx, chatId, '4200');
    expect(activeIntake(chatId)!.facts.weightKg).toBe(4200);
    expect(activeIntake(chatId)!.ambiguousTotals).toEqual([]);
    expect(ctx.edits.at(-1)).toContain('✅ Og‘irlik (brutto): 4200 kg');
    expect(ctx.edits.at(-1)).not.toContain('qaysi biri');
  });

  it('a FILE sent after the answer whose reading says otherwise is asked about too', async () => {
    const { chatId } = answered();
    await answer(fakeCtx(), chatId, '3500');
    updateIntake(chatId, { stage: 'material', fileCount: activeIntake(chatId)!.fileCount + 1 });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12, weightKg: 4200 }));
    const out = await analyzeCollected(activeIntake(chatId)!);
    expect(out.facts.weightKg ?? null).toBeNull();
    expect(out.ambiguousTotals).toEqual([{ field: 'weightKg', answered: 3500, stated: 4200 }]);
    // The answer is KEPT — the doubt is what holds the field open.
    expect(out.totalsAnswer).toMatchObject({ weightKg: 3500 });
  });

  it('the doubt is found again on every re-read until he answers — the document never wins in silence', async () => {
    const { chatId } = answered();
    const ctx = fakeCtx();
    await answer(ctx, chatId, '3500');
    updateIntake(chatId, { stage: 'material', material: [...activeIntake(chatId)!.material, 'brutto 4200 kg'] });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12 }));
    await pressDone(ctx, chatId);
    expect(activeIntake(chatId)!.ambiguousTotals).toEqual([{ field: 'weightKg', answered: 3500, stated: 4200 }]);
    // More material, and Bo‘ldi again: still neither figure taken.
    await handleCalcCallback(ctx, chatId, 'more');
    updateIntake(chatId, { material: [...activeIntake(chatId)!.material, 'Shim 50 dona'] });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12, weightKg: 4200 }));
    const again = await analyzeCollected(activeIntake(chatId)!);
    expect(again.facts.weightKg ?? null).toBeNull();
    expect(again.ambiguousTotals).toEqual([{ field: 'weightKg', answered: 3500, stated: 4200 }]);
    // His answer moves the mark past what doubted it: the next re-read keeps it.
    updateIntake(chatId, { ...again, stage: 'review' });
    await answer(ctx, chatId, '4200');
    updateIntake(chatId, { stage: 'material' });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12, weightKg: 4200 }));
    const settled = await analyzeCollected(activeIntake(chatId)!);
    expect(settled.facts.weightKg).toBe(4200);
    expect(settled.ambiguousTotals).toEqual([]);
  });

  it('what the answer had already seen never overrules it; the same figure again does not doubt it', async () => {
    // A re-read that now finds a figure in the OLD file: nothing came after the answer.
    const old = collection({
      stage: 'review',
      fileCount: 1,
      totalsAnswer: { weightKg: 3500, volumeM3: null, at: { material: 1, files: 1 } },
      material: ['Kurtka 300 dona 12 kub'],
      facts: { volumeM3: 12, weightKg: 3500 },
    });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12, weightKg: 4200 }));
    const out = await analyzeCollected(old.state);
    expect(out.facts.weightKg).toBe(3500);
    expect(out.ambiguousTotals).toEqual([]);

    const same = collection({
      stage: 'material',
      totalsAnswer: { weightKg: 3500, volumeM3: null, at: { material: 1, files: 0 } },
      material: ['Kurtka 300 dona 12 kub', 'brutto 3500 kg'],
    });
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12, weightKg: 3500 }));
    const again = await analyzeCollected(same.state);
    expect(again.facts.weightKg).toBe(3500);
    expect(again.ambiguousTotals).toEqual([]);
    expect(openTotals('yolkira', again.facts)).toEqual([]);
  });

  it('an old «1,200 kg» the answer settled does not hide a NEW figure typed after it', async () => {
    const { state } = collection({
      stage: 'material',
      totalsAnswer: { weightKg: 1200, volumeM3: null, at: { material: 1, files: 0 } },
      material: ['Kurtka 300 dona 1.2 kub, 1,200 kg', 'brutto 1300 kg'],
    });
    model.analyze.mockResolvedValueOnce(reads({ goods: [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }] }));
    const out = await analyzeCollected(state);
    expect(out.facts.weightKg ?? null).toBeNull();
    // The doubt names the NEW figure — never the «1.2 mi yoki 1200 mi?» he answered.
    expect(out.ambiguousTotals).toEqual([{ field: 'weightKg', answered: 1200, stated: 1300 }]);
  });

  it('a cube answered, then «jami 14 kub»: asked again, and the lines’ Σ does not answer for it', async () => {
    const lines = [{ name: 'Kurtka', quantity: 300, volumeM3: 1.2 }, { name: 'Shim', quantity: 200, volumeM3: 1.6 }];
    const { state } = collection({
      stage: 'material',
      totalsAnswer: { weightKg: null, volumeM3: 12, at: { material: 1, files: 0 } },
      material: ['3500 kg', 'jami 14 kub'],
    });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 3500, goods: lines }));
    const out = await analyzeCollected(state);
    expect(out.facts.volumeM3 ?? null).toBeNull();
    expect(factsVolumeM3(out.facts)).toBeNull();
    expect(openTotals('yolkira', out.facts)).toEqual(['volumeM3']);
    expect(out.ambiguousTotals).toEqual([{ field: 'volumeM3', answered: 12, stated: 14 }]);
  });

  it('settleAnalysis keeps the reading’s verdict — the snapshot’s answer is not put back over a doubted field', () => {
    const answerMark = { weightKg: 3500, volumeM3: null, at: { material: 1, files: 0 } };
    const { chatId, state: snapshot } = collection({ analysing: 'tok', totalsAnswer: answerMark, material: ['a', 'b'] });
    const live = activeIntake(chatId)!;
    const doubt = { field: 'weightKg' as const, answered: 3500, stated: 4200 };
    const analysed: IntakeState = {
      ...snapshot,
      facts: { volumeM3: 12, weightKg: null, goods: [] },
      ambiguousTotals: [doubt],
    };
    const out = settleAnalysis(live, snapshot, analysed, 'tok');
    if (out.kind === 'gone') throw new Error('gone');
    expect(out.state.facts.weightKg ?? null).toBeNull();
    expect(out.state.totalsAnswer.weightKg).toBe(3500);
    expect(out.state.ambiguousTotals).toEqual([doubt]);
  });
});

describe('an answer with no collection to answer (judge concurrency-5, re-anchored onto orphanAnswerSentence)', () => {
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
    const ctx = staffCtx();
    await answerStaffText(ctx, BigInt(-9_700_000_003), 'staff-1', '+998 90 123 45 67', {
      backlog: false,
      messageId: 3,
      once: null,
      waitDeclined: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.replies).not.toContain(NO_OPEN_COLLECTION);
    expect(bot.assistant).toHaveBeenCalledTimes(1);
  });

  it('Door B’s «🔍» replays a FORWARDED customer message: «12 kub 3500 kg» is searched, never called a lost answer', async () => {
    const ctx = staffCtx();
    await answerStaffText(ctx, BigInt(-9_700_000_004), 'staff-1', '12 kub 3500 kg', {
      backlog: false,
      messageId: null,
      once: 'q:-9700000004:1:search' as unknown as OnceKey,
      waitDeclined: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.replies).not.toContain(NO_OPEN_COLLECTION);
    expect(bot.assistant).toHaveBeenCalledTimes(1);
  });

  it('a figure the ⏰ wait declined («Bu sana emas» said already) is not told a collection was lost', async () => {
    const ctx = staffCtx();
    await answerStaffText(ctx, BigInt(-9_700_000_005), 'staff-1', '3500', {
      backlog: false,
      messageId: 5,
      once: null,
      waitDeclined: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.replies).not.toContain(NO_OPEN_COLLECTION);
    expect(bot.assistant).toHaveBeenCalledTimes(1);
  });

  it('is told there is no open collection, and the paid assistant is never asked', async () => {
    const chatId = BigInt(-9_700_000_001);
    const ctx = staffCtx();
    // Re-anchored (review REG-3; §2.8): a WORDED figure is the lost answer's evidence.
    await answerStaffText(ctx, chatId, 'staff-1', '3500 kg', { backlog: false, messageId: 1, once: null, waitDeclined: false });
    // The assistant is dispatched off the poller; give it the tick it takes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bot.assistant).not.toHaveBeenCalled();
    expect(ctx.replies).toEqual([NO_OPEN_COLLECTION]);
  });

  it('a BARE figure with no collection is told what a lookup that found nothing is told — never «Ochiq hisoblatish yo‘q» (review REG-3)', async () => {
    for (const [n, text] of [[6, '777'], [7, '150'], [8, '12'], [9, '3500']] as const) {
      const ctx = staffCtx();
      await answerStaffText(ctx, BigInt(-9_700_000_000 - n), 'staff-1', text, {
        backlog: false,
        messageId: n,
        once: null,
        waitDeclined: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ctx.replies, text).toEqual([BARE_FIGURE_NOT_FOUND]);
      expect(ctx.replies[0]).toMatch(/^Topilmadi\. Mijoz kodi \(GS777\)/u);
    }
    expect(bot.assistant).not.toHaveBeenCalled();
  });

  it('tells a worded figure from a bare one', () => {
    for (const text of ['3500 kg', '12 kub', '12 kub 3500 kg', '3 500 кг', '12 m³']) expect(totalsAnswerShape(text), text).toBe('worded');
    for (const text of ['777', '3 500', '12 3500', '1,5']) expect(totalsAnswerShape(text), text).toBe('bare');
    for (const text of ['GS777', 'Kurtka 300 kg', '+998 90 123 45 67', '']) expect(totalsAnswerShape(text), text).toBeNull();
  });

  it('any other words still reach the assistant', async () => {
    const chatId = BigInt(-9_700_000_002);
    const ctx = staffCtx();
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
