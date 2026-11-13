import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

/**
 * The carton arithmetic's doubt and the model's questions through the REAL
 * handlers (docs/AI-SORAYDI.md §3.0 «the kernel's minimal draw»; review
 * JN-15, JB-1, JB-6, JR-2, JR-19): the reading settles, the table asks, the
 * seller types the figure, the question closes — and stays closed through a
 * re-read; «↩️» opens it again. The model is a stand-in; Telegram is a fake
 * that records what was said and what was edited.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({
  aiCalcBudgetLeft: async () => 100,
  aiCalcAvailable: async () => true,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import { activeIntake, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { migrateIntakeState } from '@/modules/platform/telegram/calc-store';
import { deliverNextStep, pressUndo, routeCollectorText, tableEditsSettled } from '@/modules/platform/telegram/calc-dialog';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { aiGoodsLine } from '@/modules/wms/calc/intake-ai';
import { applyPacking } from '@/modules/wms/calc/carton-math';

type Sent = { id: number; text: string; extra?: Record<string, unknown> };
function fakeCtx() {
  let next = 100;
  const replies: Sent[] = [];
  const edits: Sent[] = [];
  return {
    replies,
    edits,
    async reply(text: string, extra?: Record<string, unknown>) {
      next += 1;
      replies.push({ id: next, text, extra });
      return { message_id: next };
    },
    async answerCallbackQuery() {
      return true;
    },
    api: {
      async editMessageText(_chat: string, id: number, text: string, extra?: Record<string, unknown>) {
        edits.push({ id, text, extra });
        return true;
      },
      async setMessageReaction() {
        return true;
      },
    },
  };
}
type Ctx = ReturnType<typeof fakeCtx>;
const from = (ctx: Ctx, id: number) => Object.assign(Object.create(ctx) as Ctx, { callbackQuery: { message: { message_id: id } } });
const tableNow = (ctx: Ctx, table: Sent) => ctx.edits.filter((e) => e.id === table.id).at(-1) ?? table;

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}) {
  seq += 1;
  const chatId = BigInt(-9_810_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test', ai: true });
  return { chatId, state: updateIntake(chatId, patch)! };
}
let messageId = 5000;
async function say(ctx: Ctx, chatId: bigint, text: string) {
  const msg = { date: 0, messageId: (messageId += 1), forwarded: false, replyTo: null };
  await routeCollectorText(ctx, chatId, activeIntake(chatId)!, text, msg);
  await tableEditsSettled();
}
async function drawn(ctx: Ctx, chatId: bigint) {
  await deliverNextStep(ctx, chatId, activeIntake(chatId)!);
  return ctx.replies.at(-1)!;
}
async function pressDone(ctx: Ctx, chatId: bigint) {
  await handleCalcCallback(ctx, chatId, 'done');
  await driveReading(chatId, ctx);
  await tableEditsSettled();
}

/** One good as the MODEL answers it — through the real mapping, so the packing and its arithmetic are the reading's own. */
const PACK = { cartons: 0, pieces_per_carton: 0, carton_weight_kg: 0, carton_weight_kind: 'unknown', carton_volume_m3: 0, l: 0, w: 0, h: 0, size_unit: 'unknown', size_of: 'unknown', piece_weight_kg: 0 };
const good = (name: string, over: Record<string, unknown> = {}, pack: Record<string, unknown> | null = null) =>
  aiGoodsLine({
    name,
    name_source: 'document',
    photo: 0,
    quantity: null,
    weight_kg: null,
    weight_kind: 'unknown',
    volume_m3: null,
    unit: null,
    measure_qty: null,
    packing: pack ? [{ ...PACK, ...pack }] : [],
    tnved_code: null,
    code_sure: true,
    note: null,
    ...over,
  } as Parameters<typeof aiGoodsLine>[0]);
const reads = (facts: Partial<CalcFacts>, extra: Record<string, unknown> = {}) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods: [], ...facts },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
  answered: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
  ...extra,
});

// The model's own contradiction (dg2-5): 0.083 m³ on the row AND 0.083 m³ per carton × 30 cartons.
const SUMKA = () => good('Sumka', { quantity: 60, weight_kg: 300, weight_kind: 'net', volume_m3: 0.083, tnved_code: '4202920000' }, { cartons: 30, carton_volume_m3: 0.083 });
const DOUBT = '   ↳ ❓ 0.083 m³ — bitta karobkanikimi yoki hammasinikimi? Hammasiniki bo‘lsa «1: 0.083 m³», bittasiniki bo‘lsa «1: 2.49 m³» deb yozing.';

beforeEach(() => {
  model.analyze.mockReset();
  resetReadingDrive();
});
afterEach(async () => {
  await tableEditsSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('the reading’s doubt is asked, answered by typing, and stays answered', () => {
  it('«Bo‘ldi» → the table asks; «1: 2.49 m³» closes the question; a re-read does not open it again', async () => {
    const { chatId } = collection({ stage: 'material', material: ['Sumka 30 karobka'] });
    const ctx = fakeCtx();
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 320, volumeM3: 2.49, goods: [SUMKA()] }));
    await pressDone(ctx, chatId);
    const table = ctx.replies.at(-1)!;
    // The model's figure is NOT multiplied over (JN-2): it stands, and is asked.
    expect(table.text).toContain('⚠️ 1. Sumka — 60 dona · 300 kg · 0.083 m³');
    expect(table.text).toContain(DOUBT);
    expect(table.text).not.toContain('Ma’lumot to‘liq');
    expect(table.text).toContain('❓ 1 ta savol javobsiz — javobini yozing.');

    await say(ctx, chatId, '1: 2.49 m³');
    const answered = tableNow(ctx, table);
    expect(answered.text).toContain('1. Sumka — 60 dona · 300 kg · 2.49 m³');
    expect(answered.text).not.toContain('↳ ❓');
    expect(answered.text).toContain('✅ Ma’lumot to‘liq');
    const row = activeIntake(chatId)!.facts.goods![0]!;
    expect(row.volumeM3).toBe(2.49);
    expect(row.derived?.person).toEqual(['volumeM3']);

    // «➕ Yana ma’lumot» → the model reads again and says the same thing: his figure stands, unasked.
    await handleCalcCallback(ctx, chatId, 'more');
    updateIntake(chatId, { material: ['Sumka 30 karobka', 'rangi qora'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 320, volumeM3: 2.49, goods: [SUMKA()] }));
    await pressDone(ctx, chatId);
    const again = ctx.replies.at(-1)!;
    expect(again.text).toContain('1. Sumka — 60 dona · 300 kg · 2.49 m³');
    expect(again.text).not.toContain('↳ ❓');
    const reread = activeIntake(chatId)!.facts.goods![0]!;
    expect(reread.volumeM3).toBe(2.49);
    expect(applyPacking(reread).doubts).toEqual([]);
  });

  it('«it is the whole row’s»: the SAME figure typed is an answer too — and a re-read that says it again does not re-ask', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Sumka 30 karobka'], facts: { weightKg: 320, volumeM3: 2.49, goods: [SUMKA()] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text).toContain(DOUBT);
    await say(ctx, chatId, '1: 0.083 m³');
    const now = tableNow(ctx, table);
    expect(now.text).toContain('1. Sumka — 60 dona · 300 kg · 0.083 m³');
    expect(now.text).not.toContain('↳ ❓');

    // The model reads again and writes the very same two numbers. His answer
    // is put back on the fresh row — where, unmarked, it IS the model's 0.083
    // again and the same question (review JN-15 b).
    await handleCalcCallback(ctx, chatId, 'more');
    updateIntake(chatId, { material: ['Sumka 30 karobka', 'rangi qora'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 320, volumeM3: 2.49, goods: [SUMKA()] }));
    await pressDone(ctx, chatId);
    const again = ctx.replies.at(-1)!;
    expect(again.text).toContain('1. Sumka — 60 dona · 300 kg · 0.083 m³');
    expect(again.text).not.toContain('↳ ❓');
    expect(activeIntake(chatId)!.facts.goods![0]!.derived?.person).toEqual(['volumeM3']);
  });

  it('«↩️» takes the answer back, and the question with it', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 320, volumeM3: 2.49, goods: [SUMKA()] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, '1: 2.49 m³');
    expect(tableNow(ctx, table).text).not.toContain('↳ ❓');
    const tag = activeIntake(chatId)!.echoes.at(-1)!.tag;
    await pressUndo(from(ctx, table.id), chatId, tag);
    await tableEditsSettled();
    const undone = tableNow(ctx, table);
    expect(undone.text).toContain('⚠️ 1. Sumka — 60 dona · 300 kg · 0.083 m³');
    expect(undone.text).toContain(DOUBT);
    expect(activeIntake(chatId)!.facts.goods![0]!.derived?.person).toBeUndefined();
  });

  it('a figure the BOT computed, corrected by the seller, is his from then on — «1: 2.6 m³» over «2.4 m³*»', async () => {
    // 20 cartons × 60×40×50 cm = 20 × 0.12 = 2.4 m³, computed by the bot.
    const stul = good('Stul', { quantity: 40, weight_kg: 300, weight_kind: 'net', tnved_code: '9401310000' }, { cartons: 20, l: 60, w: 40, h: 50, size_unit: 'cm', size_of: 'package' });
    expect(stul.volumeM3).toBe(2.4);
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 320, volumeM3: 2.4, goods: [stul] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text).toContain('1. Stul — 40 dona · 300 kg · 2.4 m³*');
    expect(table.text).toContain('* — bot hisoblagan');
    await say(ctx, chatId, '1: 2.6 m³');
    const now = tableNow(ctx, table);
    expect(now.text).toContain('1. Stul — 40 dona · 300 kg · 2.6 m³ ·');
    expect(now.text).not.toContain('* — bot hisoblagan');
    expect(now.text).not.toContain('↳ ❓');
    // The pass the judge ran (JB-1): through the arithmetic again, it is still 2.6.
    expect(applyPacking(activeIntake(chatId)!.facts.goods![0]!).line.volumeM3).toBe(2.6);

    // …and after a re-read, whose fresh row the bot computed 2.4 on again: his
    // 2.6 stands, unasked — never «2.6 yozilgan, karobkalar bo‘yicha 2.4 chiqadi».
    updateIntake(chatId, { material: ['Stul 20 karobka'] });
    await handleCalcCallback(ctx, chatId, 'more');
    updateIntake(chatId, { material: ['Stul 20 karobka', 'ofis uchun'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 320, volumeM3: 2.4, goods: [stul] }));
    await pressDone(ctx, chatId);
    const again = ctx.replies.at(-1)!;
    expect(again.text).toContain('1. Stul — 40 dona · 300 kg · 2.6 m³ ·');
    expect(again.text).not.toContain('↳ ❓');
    expect(again.text).not.toContain('* — bot hisoblagan');
  });
});

describe('the model’s questions are kept by the reading and drawn by the good’s name', () => {
  it('a reading’s questions settle into the collection; the next reading REPLACES them', async () => {
    const { chatId } = collection({ stage: 'material', material: ['rasm'] });
    const ctx = fakeCtx();
    const stul = good('Stul ofis uchun', { name_source: 'picture', photo: 1, quantity: 20, weight_kg: 100, weight_kind: 'net', tnved_code: '9401310000', code_sure: false });
    model.analyze.mockResolvedValueOnce(
      reads(
        { weightKg: 120, volumeM3: 2, goods: [stul] },
        { questions: [{ list: 'goods', row: 0, kind: 'material', text: 'Nimadan — plastikmi, metallmi?', about: 'Stul ofis uchun' }] },
      ),
    );
    await pressDone(ctx, chatId);
    expect(activeIntake(chatId)!.aiQuestions).toEqual([{ about: 'Stul ofis uchun', kind: 'material', text: 'Nimadan — plastikmi, metallmi?' }]);
    const table = ctx.replies.at(-1)!;
    expect(table.text).toContain('1. 📷 Stul ofis uchun — 20 dona · 100 kg');
    expect(table.text).toContain('🤖 AI so‘raydi:\n❓ «Stul ofis uchun»: Nimadan — plastikmi, metallmi?\nJavobini «➕ Yana ma’lumot» bilan yozib yuboring — AI qayta o‘qiydi.');
    // A «material» question does not hold the line.
    expect(table.text).toContain('✅ Ma’lumot to‘liq');

    // He answers through «➕ Yana ma’lumot»; the model reads again and asks nothing.
    await handleCalcCallback(ctx, chatId, 'more');
    updateIntake(chatId, { material: ['rasm', 'plastik stul'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 120, volumeM3: 2, goods: [stul] }));
    await pressDone(ctx, chatId);
    expect(activeIntake(chatId)!.aiQuestions).toEqual([]);
    expect(ctx.replies.at(-1)!.text).not.toContain('AI so‘raydi');
  });

  it('a collection open at the DEPLOY has no `aiQuestions`: hydrated it reads [], and its table draws (JR-19)', async () => {
    const { chatId, state } = collection({ stage: 'review', facts: { weightKg: 320, volumeM3: 2.49, goods: [{ name: 'Kurtka', quantity: 300, weightKg: 300, tnvedCode: '6201400000', tnvedSource: 'row' }] } });
    const old = { ...state } as Partial<IntakeState>;
    delete old.aiQuestions;
    const migrated = migrateIntakeState(old as IntakeState);
    expect(migrated.aiQuestions).toEqual([]);
    expect({ ...migrated, aiQuestions: undefined }).toEqual({ ...state, aiQuestions: undefined });
    // A stored value always wins.
    const asked = [{ about: null, kind: 'other' as const, text: 'Qaysi shahardan?' }];
    expect(migrateIntakeState({ ...state, aiQuestions: asked }).aiQuestions).toEqual(asked);
    // The live row itself without the field (a draw before any hydrate ran it through).
    updateIntake(chatId, { aiQuestions: undefined as unknown as IntakeState['aiQuestions'] });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text).toContain('✅ 1. Kurtka — 300 dona · 300 kg');
    expect(table.text).toContain('✅ Ma’lumot to‘liq');
  });
});

describe('a file’s line column nothing settled is asked under the table (§3.2 X5, review JN-12)', () => {
  // What the reader recorded for a G.W. column whose figures are 15 / 12 on
  // rows of 20 cartons with no TOTAL to settle it (ParsedGoods.asks): the
  // figure may be one carton’s or the line’s.
  const meta = (asks: { field: 'weightKg' | 'volumeM3'; title: string; rows: { name: string; value: number }[] }[]) => ({
    label: 'invoice.xlsx',
    shape: 'invoice' as const,
    weightKind: null,
    grossKg: null,
    grossColumn: true,
    volumeM3: null,
    rows: 2,
    text: null,
    asks,
  });
  const GW = { field: 'weightKg' as const, title: 'G.W.(KGS)', rows: [{ name: 'Sumka', value: 15 }, { name: 'Ryukzak', value: 12 }] };
  const ASK = '❓ «G.W.(KGS)» ustuni — bitta karobkanikimi yoki qatornikimi? Har qatorning umumiy og‘irligini (kg) yozing: «1: …».';
  const rows = () => [
    { name: 'Sumka', quantity: 400, weightKg: 15, tnvedCode: '4202920000', tnvedSource: 'row' as const },
    { name: 'Ryukzak', quantity: 300, weightKg: 12, tnvedCode: '4202920000', tnvedSource: 'row' as const },
  ];

  it('the AI door asks it and holds «Ma’lumot to‘liq»; the seller’s figures close it', async () => {
    const { chatId } = collection({ stage: 'review', goodsFiles: [meta([GW])], facts: { weightKg: 560, volumeM3: 1.2, goods: rows() } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text).toContain(ASK);
    expect(table.text).not.toContain('Ma’lumot to‘liq');

    // One row answered is not the column answered.
    await say(ctx, chatId, '1: 300 kg');
    expect(tableNow(ctx, table).text).toContain(ASK);
    await say(ctx, chatId, '2: 240 kg');
    const answered = tableNow(ctx, table);
    expect(answered.text).not.toContain('ustuni — bitta karobkanikimi');
    expect(answered.text).toContain('2. Ryukzak — 300 dona · 240 kg');
    expect(answered.text).toContain('✅ Ma’lumot to‘liq');
  });

  it('a row whose figure already differs from the file’s is no longer the file’s question; the plain door asks nothing', async () => {
    const goods = rows();
    goods[0]!.weightKg = 300;
    goods[1]!.weightKg = 240;
    const { chatId } = collection({ stage: 'review', goodsFiles: [meta([GW])], facts: { weightKg: 560, volumeM3: 1.2, goods } });
    const ctx = fakeCtx();
    expect((await drawn(ctx, chatId)).text).not.toContain('ustuni — bitta karobkanikimi');

    const plain = collection({ stage: 'review', goodsFiles: [meta([GW])], facts: { weightKg: 560, volumeM3: 1.2, goods: rows() } });
    updateIntake(plain.chatId, { ai: false });
    const ctx2 = fakeCtx();
    expect((await drawn(ctx2, plain.chatId)).text).not.toContain('ustuni — bitta karobkanikimi');
  });
});

describe('an add collection promises «AI qayta hisoblaydi» only once something is in it (review ask-break-6)', () => {
  const item = { itemId: 'i1', seq: 1, name: 'Kurtka', quantity: 300, weightKg: 150, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: '6201400000', law: null, confirmed: false };
  const amend = {
    requestId: 'req-1',
    cardLabel: 'B-00123',
    entityType: 'deal' as const,
    entityId: 'deal-1',
    leadOpen: null,
    section: 'rastamojka' as const,
    door: 'ai' as const,
    clientLabel: null,
    openedRev: 1,
    items: [item],
    weightKg: 3500,
    volumeM3: 12,
    fromCity: null,
    toCity: null,
  };
  const goods = () => [{ name: 'Kurtka', quantity: 300, weightKg: 150, seq: 1, itemId: 'i1', tnvedCode: '6201400000', tnvedSource: 'row' as const }];

  it('opened with nothing: no press promised; a row answered: «✅ Qo‘shish», AI recalculates', async () => {
    const { chatId } = collection({ stage: 'review', amend, facts: { weightKg: 3500, volumeM3: 12, goods: goods() } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text.split('\n').at(-1)).toBe('ℹ️ Hali hech narsa qo‘shilmadi — yangi tovar, javob yoki faylni shu yerga yuboring.');
    expect(table.text).not.toContain('AI qayta hisoblaydi');

    await say(ctx, chatId, '1: 180 kg');
    const now = tableNow(ctx, table);
    expect(now.text).toContain('1. Kurtka — 300 dona · 180 kg');
    expect(now.text).toContain('✅ Ma’lumot to‘liq — «✅ Qo‘shish» ni bosing, AI qayta hisoblaydi.');
  });
});
