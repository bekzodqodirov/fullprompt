import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

/**
 * The bot's table stage through the real handlers (docs/SAKKIZ-R3.md §8.2,
 * his 1.10 c and 1.11 c): an answer is read by the address parser, written
 * once, echoed with its own ↩️ and the confirm, and the table above it is
 * edited in place. The model and the budget are stand-ins; Telegram is a fake
 * that records what was said and what was edited.
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

import {
  activeIntake,
  analyzeCollected,
  endIntake,
  placeByName,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import {
  BARE_FIGURE_NOT_FOUND,
  NO_OPEN_COLLECTION,
  PAUSE_LINE,
  deliverNextStep,
  editTableSoon,
  orphanAnswerSentence,
  pressCancel,
  pressCertificate,
  pressConflict,
  pressPick,
  pressUndo,
  routeCollectorText,
  tableEditsSettled,
} from '@/modules/platform/telegram/calc-dialog';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import type { AmendBase } from '@/modules/wms/calc/amend-types';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}, section: IntakeState['section'] = 'rastamojka', amend: AmendBase | null = null) {
  seq += 1;
  const chatId = BigInt(-9_800_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-test', amend });
  return { chatId, state: updateIntake(chatId, patch)! };
}

type Sent = { id: number; text: string; extra?: Record<string, unknown> };
/** Replies and edits, as Telegram would have them; `editError` makes every edit refuse with it. */
function fakeCtx(opts: { editError?: unknown } = {}) {
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
        if (opts.editError) throw opts.editError;
        edits.push({ id, text, extra });
        return true;
      },
    },
  };
}
type Ctx = ReturnType<typeof fakeCtx>;
/** The same ctx, as pressed from message `id` (a callback). */
const from = (ctx: Ctx, id: number, message: Record<string, unknown> = {}) =>
  Object.assign(Object.create(ctx) as Ctx, { callbackQuery: { message: { message_id: id, ...message } } });

const buttons = (sent: Sent | undefined) =>
  ((sent?.extra?.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat();

let messageId = 1000;
const typed = (opts: Partial<{ forwarded: boolean; replyTo: number | null }> = {}) => ({
  date: 0,
  messageId: (messageId += 1),
  forwarded: opts.forwarded ?? false,
  replyTo: opts.replyTo ?? null,
});
/** A typed message, routed as the collector routes it, the table's edit settled. */
async function say(ctx: Ctx, chatId: bigint, text: string, opts: Partial<{ forwarded: boolean; replyTo: number | null }> = {}) {
  await routeCollectorText(ctx, chatId, activeIntake(chatId)!, text, typed(opts));
  await tableEditsSettled();
}
/** The table, sent as a reading sends it. */
async function drawn(ctx: Ctx, chatId: bigint) {
  await deliverNextStep(ctx, chatId, activeIntake(chatId)!);
  return ctx.replies.at(-1)!;
}

const reads = (facts: Partial<CalcFacts>) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods: [], ...facts },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
  answered: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
});

/** «Bo‘ldi» pressed: the press only enqueues, so the reading job is run here (P2's one drive). */
async function pressDone(ctx: Ctx, chatId: bigint) {
  await handleCalcCallback(ctx, chatId, 'done');
  await driveReading(chatId, ctx);
  expect(activeIntake(chatId)?.analysing ?? null).toBeNull();
  await tableEditsSettled();
}

const FIVE = [line('Kurtka', { quantity: 300 }), line('Krossovka', { quantity: 40 }), line('Sumka'), line('Shapka', { quantity: 30 }), line('Shim')];

beforeEach(() => {
  model.analyze.mockReset();
  resetReadingDrive();
});
afterEach(async () => {
  await tableEditsSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('an answer in the table stage', () => {
  it('is echoed in its exact words, kept in `lineAnswers`, and the table above it is edited', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka qishki', { quantity: 300, weightKg: 150 }), line('Sumka')] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text).toContain('⚠️ 2. Sumka');
    await say(ctx, chatId, '2: 50 dona');
    const echo = ctx.replies.at(-1)!;
    expect(echo.text).toBe('✅ 2-qator «Sumka»: 50 dona yozildi\n✅ Hamma qator to‘liq — «✅ Tasdiqlash» ni bosing.');
    const tag = activeIntake(chatId)!.echoes[0]!.tag;
    expect(buttons(echo)).toEqual([
      { text: '↩️ Shu javobni bekor qilish', callback_data: `cu:${tag}` },
      { text: '✅ Tasdiqlash', callback_data: 'c:save' },
    ]);
    expect(activeIntake(chatId)!.lineAnswers).toEqual([{ index: 1, name: 'Sumka', patch: { quantity: 50 }, itemId: null }]);
    expect(ctx.edits.at(-1)).toMatchObject({ id: ctx.replies[0]!.id });
    expect(ctx.edits.at(-1)!.text).toContain('✅ 2. Sumka — 50 dona');
    expect(ctx.edits.at(-1)!.text).toContain('✅ Ma’lumot to‘liq. Tasdiqlaysizmi?');
  });

  it('the probe «3: 50 dona\\n5: 20 kg»: the material is unchanged, and the next reading takes no 20 kg brutto from it', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka, Krossovka, Sumka, Shapka, Shim'], facts: { volumeM3: 12, goods: FIVE } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    await say(ctx, chatId, '3: 50 dona\n5: 20 kg');
    const live = activeIntake(chatId)!;
    model.analyze.mockResolvedValueOnce(reads({ volumeM3: 12, goods: FIVE }));
    const out = await analyzeCollected({ ...live, stage: 'material' });
    // Row 5's netto is never the truck's brutto.
    expect(out.facts.weightKg ?? null).toBeNull();
    expect(out.facts.goods?.[2]).toMatchObject({ name: 'Sumka', quantity: 50 });
    expect(out.facts.goods?.[4]).toMatchObject({ name: 'Shim', weightKg: 20 });
    expect(live.material).toEqual(['Kurtka, Krossovka, Sumka, Shapka, Shim']);
    expect(live.answers).toEqual(['3: 50 dona\n5: 20 kg']);
  });

  it('an unaddressed short text with two open rows and no unit fit is asked, and nothing is written', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Shapka'), line('Sumka')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '300');
    expect(ctx.texts().at(-1)).toBe('⚠️ Qaysi qatorga? Raqami bilan yozing: «3: 50 dona». Umumiy og‘irlik bo‘lsa: «jami 3500 kg».');
    expect(buttons(ctx.replies.at(-1))).toEqual([]);
    const live = activeIntake(chatId)!;
    expect(live.lineAnswers).toEqual([]);
    expect(live.facts.goods).toEqual([line('Shapka'), line('Sumka')]);
    expect(live.answers).toEqual(['300']);
  });

  it('an ADDRESSED answer in the collecting stage after a reading is an answer, not material', async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'], facts: { goods: [line('Kurtka'), line('Shim')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '1: 50 dona');
    const live = activeIntake(chatId)!;
    expect(live.stage).toBe('material');
    expect(live.material).toEqual(['x']);
    expect(live.facts.goods?.[0]).toEqual(line('Kurtka', { quantity: 50 }));
  });

  it('a forward in the table stage is material — a customer’s words are his, never the seller’s answer', async () => {
    const { chatId } = collection({ stage: 'review', material: ['x'], facts: { goods: [line('Kurtka'), line('Shim')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '1: 50 dona', { forwarded: true });
    const live = activeIntake(chatId)!;
    expect(live.stage).toBe('material');
    expect(live.material).toEqual(['x', '1: 50 dona']);
    expect(live.lineAnswers).toEqual([]);
  });

  it('a reply to a FOREIGN bot message is not a table answer (regression-5)', async () => {
    const { chatId } = collection({ stage: 'review', facts: { goods: [line('Kurtka'), line('Krossovka')] } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    await say(ctx, chatId, '2: 40 juft', { replyTo: 7 });
    const live = activeIntake(chatId)!;
    expect(live.facts.goods?.[1]).toEqual(line('Krossovka'));
    expect(live.answers).toEqual(['2: 40 juft']);
    expect(ctx.texts().at(-1)).toBe('⚠️ Qaysi qatorga? Raqami bilan yozing: «3: 50 dona». Umumiy og‘irlik bo‘lsa: «jami 3500 kg».');
    // A reply to the collection's OWN table is an answer.
    await say(ctx, chatId, '2: 40 juft', { replyTo: live.tableMessageId });
    expect(activeIntake(chatId)!.facts.goods?.[1]).toEqual(line('Krossovka', { measureUnit: 'juft', measureQty: 40 }));
  });

  it('every echo that wrote something carries the confirm and what is still missing; the completing one says «Hamma qator to‘liq» (product-fit-2)', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka'), line('Shim')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '2: 50 dona');
    const first = ctx.replies.at(-1)!;
    expect(first.text).toContain('⚠️ Yana 1 ta: 3-qator. Bilmasangiz — «✅ Tasdiqlash», qolganini VED to‘ldiradi.');
    expect(buttons(first).map((b) => b.callback_data)).toContain('c:save');
    await say(ctx, chatId, 'Shim 20 kg');
    const second = ctx.replies.at(-1)!;
    expect(second.text).toContain('✅ Hamma qator to‘liq — «✅ Tasdiqlash» ni bosing.');
    expect(buttons(second).map((b) => b.callback_data)).toContain('c:save');
  });

  it('`answers` says where each answer went (re-check p3-14)', async () => {
    const { chatId } = collection({ stage: 'review', facts: { volumeM3: 12, goods: [line('Kurtka', { quantity: 1 }), line('Krossovka')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '2: 40 juft');
    await say(ctx, chatId, 'jami 3500 kg');
    expect(activeIntake(chatId)!.answers).toEqual(['2-qator: 2: 40 juft', 'Umumiy: jami 3500 kg']);
  });
});

describe('a bare figure is answered by a tap (judge UX4, product-fit-9)', () => {
  it('the pick writes the offer’s TARGET row, with its own echo and ↩️ — and no ⏭ anywhere', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '2: 50');
    const asked = ctx.replies.at(-1)!;
    expect(asked.text).toContain('50 — qaysi birlikda?');
    expect(buttons(asked)).toEqual([
      { text: '50 dona', callback_data: 'c:pick_0' },
      { text: '50 kg', callback_data: 'c:pick_1' },
    ]);
    expect(activeIntake(chatId)!.offersMessageId).toBe(asked.id);
    await pressPick(from(ctx, asked.id), chatId, activeIntake(chatId)!, 1);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.facts.goods?.[1]).toEqual(line('Sumka', { weightKg: 50 }));
    const echo = ctx.replies.at(-1)!;
    expect(echo.text).toContain('✅ 2-qator «Sumka»: 50 kg yozildi');
    expect(buttons(echo).map((b) => b.callback_data)).toEqual([`cu:${activeIntake(chatId)!.echoes[0]!.tag}`, 'c:save']);
    expect(buttons(echo).some((b) => b.callback_data === 'c:skip')).toBe(false);
  });

  it('a pick from an OLDER offer message while newer offers are live is «eskirgan», and nothing is written (regression-23)', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka'), line('Sumka')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '1: 50');
    const older = ctx.replies.at(-1)!;
    await say(ctx, chatId, '2: 70');
    expect(activeIntake(chatId)!.offersMessageId).toBe(ctx.replies.at(-1)!.id);
    await pressPick(from(ctx, older.id), chatId, activeIntake(chatId)!, 0);
    expect(ctx.texts().at(-1)).toBe('Bu tugma eskirgan.');
    expect(activeIntake(chatId)!.facts.goods).toEqual([line('Kurtka'), line('Sumka')]);
  });
});

describe('the table edit (performance-5)', () => {
  it('an identical render sends nothing; «message is not modified» sends no fresh table', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 })] } });
    const ctx = fakeCtx({ editError: Object.assign(new Error('400'), { description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' }) });
    await drawn(ctx, chatId);
    editTableSoon(ctx, chatId);
    await tableEditsSettled();
    expect(ctx.replies).toHaveLength(1);
    // A render the hash does not know is tried; Telegram says nothing changed.
    updateIntake(chatId, { tableHash: null }, { quiet: true });
    editTableSoon(ctx, chatId);
    await tableEditsSettled();
    expect(ctx.replies).toHaveLength(1);
  });

  it('another refusal (too old, deleted) sends a fresh table and keeps its id', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 })] } });
    const ctx = fakeCtx({ editError: Object.assign(new Error('400'), { description: 'Bad Request: message to edit not found' }) });
    await drawn(ctx, chatId);
    updateIntake(chatId, { tableHash: null }, { quiet: true });
    editTableSoon(ctx, chatId);
    await tableEditsSettled();
    expect(ctx.replies).toHaveLength(2);
    expect(activeIntake(chatId)!.tableMessageId).toBe(ctx.replies[1]!.id);
  });
});

describe('placeByName’s probe (§8.2.8)', () => {
  it('Kurtka 100 and Kurtka 200, re-read [Shim, Kurtka, Kurtka]: 100 → line 2, 200 → line 3', () => {
    const answers = [
      { index: 0, name: 'Kurtka', patch: { quantity: 100 } },
      { index: 1, name: 'Kurtka', patch: { quantity: 200 } },
    ];
    const placed = placeByName([line('Shim'), line('Kurtka'), line('Kurtka')], answers);
    expect(placed.goods).toEqual([line('Shim'), line('Kurtka', { quantity: 100 }), line('Kurtka', { quantity: 200 })]);
    expect(placed.entries.map((e) => e.index)).toEqual([1, 2]);
  });

  it('a stored row is found by its item id first', () => {
    const placed = placeByName(
      [line('Kurtka', { itemId: 'b' }), line('Kurtka', { itemId: 'a' })],
      [{ index: 0, name: 'Kurtka', itemId: 'a', patch: { quantity: 5 } }],
    );
    expect(placed.entries.map((e) => e.index)).toEqual([1]);
  });
});

describe('the write-back (regression-7)', () => {
  it('[Kurtka] answered → re-read [Shim, Kurtka] → answer row 1: the next reading still carries Kurtka’s figure', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka'], facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '1: 150 kg');
    await handleCalcCallback(ctx, chatId, 'more');
    updateIntake(chatId, { material: ['Kurtka', 'Shim ham'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 3500, volumeM3: 12, goods: [line('Shim'), line('Kurtka')] }));
    await pressDone(ctx, chatId);
    expect(activeIntake(chatId)!.facts.goods).toEqual([line('Shim'), line('Kurtka', { weightKg: 150 })]);
    await say(ctx, chatId, '1: 20 kg');
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 3500, volumeM3: 12, goods: [line('Shim'), line('Kurtka')] }));
    const out = await analyzeCollected({ ...activeIntake(chatId)!, stage: 'material' });
    expect(out.facts.goods).toEqual([line('Shim', { weightKg: 20 }), line('Kurtka', { weightKg: 150 })]);
  });
});

describe('a conflict on an add collection’s stored row (product-fit-17)', () => {
  const amend: AmendBase = {
    requestId: 'r-1',
    cardLabel: 'B-00123',
    entityType: 'deal',
    entityId: 'd-1',
    leadOpen: null,
    section: 'rastamojka',
    clientLabel: null,
    openedRev: 1,
    items: [
      {
        itemId: 'i1',
        seq: 1,
        name: 'Kurtka',
        quantity: 300,
        weightKg: null,
        volumeM3: null,
        measureUnit: null,
        measureQty: null,
        tnvedCode: null,
        law: null,
        confirmed: false,
      },
    ],
    weightKg: 3500,
    volumeM3: 12,
    fromCity: null,
    toCity: null,
  };
  const open = () =>
    collection(
      {
        stage: 'review',
        facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300, seq: 1, itemId: 'i1' })] },
        conflicts: [{ itemId: 'i1', seq: 1, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: null }],
      },
      'rastamojka',
      amend,
    );

  it('the add table draws its three buttons; «qo‘shilsin» writes 500 with an echo and ↩️, and ↩️ leaves it unanswered again', async () => {
    const { chatId } = open();
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text).toContain('↳ faylda 200 dona, so‘rovda 300 — qo‘shilsinmi (500), o‘rniga (200) yoki VED hal qilsinmi?');
    expect(buttons(table).slice(0, 3)).toEqual([
      { text: '➕ 1-qator: 500 dona', callback_data: 'c:conf_0_add' },
      { text: '🔁 1-qator: 200 dona', callback_data: 'c:conf_0_rep' },
      { text: '📨 1-qator: VED', callback_data: 'c:conf_0_ved' },
    ]);
    await pressConflict(from(ctx, table.id), chatId, activeIntake(chatId)!, 0, 'add');
    await tableEditsSettled();
    expect(activeIntake(chatId)!.facts.goods?.[0]?.quantity).toBe(500);
    expect(activeIntake(chatId)!.conflicts[0]!.choice).toBe('add');
    const echo = ctx.replies.at(-1)!;
    expect(echo.text).toContain('✅ 1-qator «Kurtka»: 300 + 200 = 500 dona yozildi');
    const tag = activeIntake(chatId)!.echoes[0]!.tag;
    expect(buttons(echo).map((b) => b.callback_data)).toEqual([`cu:${tag}`, 'c:save']);
    expect(buttons(echo).at(-1)!.text).toBe('✅ Qo‘shish');

    await pressUndo(from(ctx, echo.id), chatId, tag);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.facts.goods?.[0]?.quantity).toBe(300);
    expect(activeIntake(chatId)!.conflicts[0]!.choice).toBeNull();
  });

  it('«VED» writes nothing and names it for the VED', async () => {
    const { chatId } = open();
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await pressConflict(from(ctx, table.id), chatId, activeIntake(chatId)!, 0, 'ved');
    await tableEditsSettled();
    expect(activeIntake(chatId)!.facts.goods?.[0]?.quantity).toBe(300);
    expect(activeIntake(chatId)!.conflicts[0]!.choice).toBe('ved');
    expect(ctx.texts().at(-1)).toContain('📨 1-qator «Kurtka»: VED hal qiladi');
    // A conflict already answered is «eskirgan».
    await pressConflict(from(ctx, table.id), chatId, activeIntake(chatId)!, 0, 'add');
    expect(ctx.texts().at(-1)).toBe('Bu tugma eskirgan.');
  });

  it('opened on a job the VED has started: the echo says «📝 VED ga yuboriladi», its button «📨 VED ga yuborish» (product-fit-18)', async () => {
    const { chatId } = open();
    updateIntake(chatId, { standingAtOpen: 'started', conflicts: [] });
    const ctx = fakeCtx();
    await say(ctx, chatId, '1: 150 kg');
    const echo = ctx.replies.at(-1)!;
    expect(echo.text.startsWith('📝 VED ga yuboriladi: 1-qator «Kurtka»: 150 kg')).toBe(true);
    expect(echo.text).not.toContain('yozildi');
    expect(buttons(echo).at(-1)).toEqual({ text: '📨 VED ga yuborish', callback_data: 'c:save' });
  });
});

describe('the certificate rides with the confirm on the AI door (product-fit-20)', () => {
  it('an echo carrying «✅ Tasdiqlash» shows «📄 Sertifikat: bor» and the toggle; «yo‘q» pressed there sets it, edits the echo and the table', async () => {
    const { chatId } = collection({ stage: 'review', ai: true, hasCertificate: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka')] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, '2: 50 dona');
    const echo = ctx.replies.at(-1)!;
    expect(echo.text).toContain('📄 Sertifikat: bor');
    expect(buttons(echo)).toContainEqual({ text: '📄 Sertifikat: bor', callback_data: 'c:cert_n' });
    const editsBefore = ctx.edits.length;
    await pressCertificate(from(ctx, echo.id, { text: echo.text, reply_markup: echo.extra?.reply_markup }), chatId, false);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.hasCertificate).toBe(false);
    const after = ctx.edits.slice(editsBefore);
    const echoEdit = after.find((e) => e.id === echo.id)!;
    expect(echoEdit.text).toContain('📄 Sertifikat: yo‘q');
    expect(buttons(echoEdit)).toContainEqual({ text: '📄 Sertifikat: yo‘q', callback_data: 'c:cert_y' });
    expect(after.find((e) => e.id === table.id)!.text).toContain('📄 Sertifikat: yo‘q');
  });
});

describe('«✖️ Bekor qilish» asks once before it throws away a day’s collection (product-fit-12)', () => {
  const full = () => collection({ stage: 'review', material: ['a', 'b', 'c'], fileCount: 2, facts: { goods: [line('Kurtka')] } });

  it('from the table: the question, nothing ended; «🗑 Ha, o‘chirish» ends it', async () => {
    const { chatId } = full();
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await pressCancel(from(ctx, table.id, { text: table.text }), chatId, activeIntake(chatId), false);
    expect(ctx.texts().at(-1)).toBe('🗑 Hammasi o‘chadi: 3 ta xabar, 2 ta fayl. O‘chiramizmi?');
    expect(buttons(ctx.replies.at(-1)).map((b) => b.callback_data)).toEqual(['c:cancel_y', 'c:resume']);
    expect(activeIntake(chatId)).not.toBeNull();
    await pressCancel(from(ctx, ctx.replies.at(-1)!.id), chatId, activeIntake(chatId), true);
    expect(ctx.texts().at(-1)).toBe('Bekor qilindi.');
    expect(activeIntake(chatId)).toBeNull();
  });

  it('from the reminder (a ⏸ message, which asked already): ended at once', async () => {
    const { chatId } = full();
    const ctx = fakeCtx();
    await pressCancel(from(ctx, 55, { text: '⏸ Hisoblatish to‘xtab turibdi — davom etamizmi?' }), chatId, activeIntake(chatId), false);
    expect(ctx.texts()).toEqual(['Bekor qilindi.']);
    expect(activeIntake(chatId)).toBeNull();
  });
});

describe('a route answer survives a re-read (durability-17)', () => {
  it('«Yiwu → Toshkent», then «➕ Yana ma’lumot» + «Bo‘ldi»: the route is still there; ↩️ takes it away', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka 300 dona'], facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] } }, 'yolkira');
    const ctx = fakeCtx();
    await say(ctx, chatId, 'Yiwu → Toshkent');
    expect(activeIntake(chatId)!.facts).toMatchObject({ fromCity: 'Yiwu', toCity: 'Toshkent' });
    const echo = ctx.replies.at(-1)!;
    expect(echo.text).toContain('✅ yo‘nalish: Yiwu → Toshkent yozildi');
    const tag = activeIntake(chatId)!.echoes[0]!.tag;
    await handleCalcCallback(ctx, chatId, 'more');
    updateIntake(chatId, { material: ['Kurtka 300 dona', 'Shim 50 dona'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300 }), line('Shim', { quantity: 50 })] }));
    await pressDone(ctx, chatId);
    expect(activeIntake(chatId)!.facts).toMatchObject({ fromCity: 'Yiwu', toCity: 'Toshkent' });
    await pressUndo(from(ctx, echo.id), chatId, tag);
    await tableEditsSettled();
    const live = activeIntake(chatId)!;
    expect(live.facts.fromCity ?? null).toBeNull();
    expect(live.facts.toCity ?? null).toBeNull();
    expect(live.routeAnswer).toBeNull();
  });
});

describe('a totals answer and the material it had seen (R2 CONC-2, re-check p3-3)', () => {
  it('«jami 3500 kg», then «Bo‘ldi» over the same material: 3500 kept, no doubt', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka 300 dona, 4200 kg'], facts: { volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] } }, 'yolkira');
    const ctx = fakeCtx();
    await say(ctx, chatId, 'jami 3500 kg');
    expect(activeIntake(chatId)!.totalsAnswer).toEqual({ weightKg: 3500, volumeM3: null, at: { material: 1, files: 0 } });
    model.analyze.mockResolvedValueOnce(reads({ fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 4200, volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] }));
    await pressDone(ctx, chatId);
    const live = activeIntake(chatId)!;
    expect(live.facts.weightKg).toBe(3500);
    expect(live.ambiguousTotals).toEqual([]);
  });

  it('answered, ➕ a FORWARDED «brutto 4200 kg», «Bo‘ldi»: asked with both figures, never 3500 in silence', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka 300 dona'], facts: { volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] } }, 'yolkira');
    const ctx = fakeCtx();
    await say(ctx, chatId, 'jami 3500 kg');
    await handleCalcCallback(ctx, chatId, 'more');
    await say(ctx, chatId, 'brutto 4200 kg', { forwarded: true });
    expect(activeIntake(chatId)!.material).toEqual(['Kurtka 300 dona', 'brutto 4200 kg']);
    model.analyze.mockResolvedValueOnce(reads({ fromCity: 'Yiwu', toCity: 'Toshkent', volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] }));
    await pressDone(ctx, chatId);
    expect(activeIntake(chatId)!.facts.weightKg ?? null).toBeNull();
    expect(ctx.texts().at(-1)).toContain('⚠️ Siz 3500 kg deb javob bergansiz, keyin yuborilgan ma’lumotda 4200 kg — qaysi biri?');
  });

  it('the same «brutto 4200 kg» TYPED while collecting is a totals answer: «3500 → 4200», with its ↩️ — never a silent replace', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka 300 dona'], facts: { volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] } }, 'yolkira');
    const ctx = fakeCtx();
    await say(ctx, chatId, 'jami 3500 kg');
    await handleCalcCallback(ctx, chatId, 'more');
    await say(ctx, chatId, 'brutto 4200 kg');
    const live = activeIntake(chatId)!;
    expect(live.material).toEqual(['Kurtka 300 dona']);
    expect(live.facts.weightKg).toBe(4200);
    const echo = ctx.replies.at(-1)!;
    expect(echo.text).toContain('✅ umumiy brutto: 3500 → 4200 kg yozildi');
    expect(buttons(echo)[0]!.callback_data).toBe(`cu:${live.echoes.at(-1)!.tag}`);
  });
});

describe('a text with no collection to answer (§2.8, re-check p3-2)', () => {
  it('«777» → the lookup’s own answer; parked → the pause line; «3500 kg» / «jami 3500 kg» → no open collection', async () => {
    expect(await orphanAnswerSentence('777', null)).toEqual({ text: BARE_FIGURE_NOT_FOUND, keyboard: null });
    const parked = collection({ stage: 'review' }).state;
    const paused = await orphanAnswerSentence('777', parked);
    expect(paused?.text).toBe(PAUSE_LINE);
    expect(paused?.keyboard?.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(['c:resume', 'c:cancel']);
    expect((await orphanAnswerSentence('3500 kg', null))?.text).toBe(NO_OPEN_COLLECTION);
    expect((await orphanAnswerSentence('jami 3500 kg', null))?.text).toBe(NO_OPEN_COLLECTION);
    // Anything else is the assistant's.
    expect(await orphanAnswerSentence('bu oy qancha kub keldi', null)).toBeNull();
  });
});
