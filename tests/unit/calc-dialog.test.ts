import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

/**
 * The bot's table stage through the real handlers (docs/SAKKIZ-R3.md §8.2,
 * his 1.10 c and 1.11 c): an answer is read by the address parser, written
 * once, echoed with its own ↩️ and the confirm, and the table above it is
 * edited in place. The model and the budget are stand-ins; Telegram is a fake
 * that records what was said and what was edited.
 *
 * Since the two doors (docs/IKKI-ESHIK.md §2.2, §3.4, his 2a and 4a) NEITHER
 * door echoes: the plain «🧮» door writes an answer quietly and asks nothing,
 * and the AI door edits its table — the answer's result in its last block,
 * the ↩️ on its keyboard, a 👍 under the message, and ONE short reply only for
 * what was refused or must be asked. The echo tests that sat here on `ai:
 * true` collections were re-anchored 2026-11-09 to pin the echo's ABSENCE and
 * the table's block; the echo itself lives on for a request from before the
 * doors (a NULL-door add collection, §0.2), which the add-collection tests
 * below still pin. The `ai: false` ones stay plain (the «3: 50 dona\n5: 20
 * kg» probe is that door's own pin), and the conflict buttons pin their
 * ABSENCE (his 1a, §1.1).
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
// The reading job bills each answered reading itself (docs/SAKKIZ-R3.md §7.2.10);
// `aiCalcAvailable` is what the AI table's «kod yo‘q» row promises by (§3.1).
const budget = vi.hoisted(() => ({ available: true }));
vi.mock('@/modules/wms/calc/ai-cost', () => ({
  aiCalcBudgetLeft: async () => 100,
  aiCalcAvailable: async () => budget.available,
  recordAiPass: async () => {},
}));
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
  TABLE_SUPERSEDED,
  deliverNextStep,
  editTableSoon,
  orphanAnswerSentence,
  pressCancel,
  pressCertificate,
  pressPick,
  pressUndo,
  routeCollectorText,
  tableEditsSettled,
} from '@/modules/platform/telegram/calc-dialog';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import type { AmendBase } from '@/modules/wms/calc/amend-types';
import { AI_TABLE_COMPLETE, CODE_GAP_AI } from '@/modules/wms/calc/intake';

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
  const reactions: { id: number; emoji: string }[] = [];
  return {
    replies,
    edits,
    toasts,
    reactions,
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
      async setMessageReaction(_chat: string, id: number, reaction: { type: 'emoji'; emoji: string }[]) {
        reactions.push({ id, emoji: reaction[0]!.emoji });
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
/** A typed message, routed as the collector routes it, the table's edit settled; its own id. */
async function say(ctx: Ctx, chatId: bigint, text: string, opts: Partial<{ forwarded: boolean; replyTo: number | null }> = {}) {
  const msg = typed(opts);
  await routeCollectorText(ctx, chatId, activeIntake(chatId)!, text, msg);
  await tableEditsSettled();
  return msg.messageId;
}
/** The table as the seller now reads it: its newest edit, or the table as sent. */
const tableNow = (ctx: Ctx, table: Sent) => ctx.edits.filter((e) => e.id === table.id).at(-1) ?? table;
/** The AI table's ↩️ (§3.4) — the newest answer not taken back. */
const undoButton = (tag: string) => ({ text: '↩️ Oxirgi javobni bekor qilish', callback_data: `cu:${tag}` });
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
  budget.available = true;
});
afterEach(async () => {
  await tableEditsSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('an answer in the table stage', () => {
  it('on the AI door sends NO message: kept in `lineAnswers`, a 👍, and the table edited — its last block what the answer wrote, its keyboard the ↩️ (docs/IKKI-ESHIK.md §3.4, his 4a)', async () => {
    // Re-anchored 2026-11-09: this pinned the echo «✅ 2-qator «Sumka»: 50 dona yozildi» with its own ↩️ and confirm.
    const goods = [line('Kurtka qishki', { quantity: 300, weightKg: 150, tnvedCode: '6201400000' }), line('Sumka', { tnvedCode: '4202920000' })];
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text).toContain('⚠️ 2. Sumka');
    const id = await say(ctx, chatId, '2: 50 dona');
    expect(ctx.replies).toEqual([table]);
    expect(ctx.reactions).toEqual([{ id, emoji: '👍' }]);
    const live = activeIntake(chatId)!;
    expect(live.lineAnswers).toEqual([{ index: 1, name: 'Sumka', patch: { quantity: 50 }, itemId: null }]);
    // The echo's RECORD stays — the undo reads it — with no message of its own.
    expect(live.echoes).toHaveLength(1);
    expect(live.echoes[0]!.messageId).toBeNull();
    const now = tableNow(ctx, table);
    expect(now.text).toContain('✅ 2. Sumka — 50 dona · 4202920000');
    // The last block, right above the buttons: what the answer did, then the state.
    expect(now.text.split('\n').slice(-2)).toEqual(['✍️ Oxirgi javob: 2-qator «Sumka» — 50 dona', AI_TABLE_COMPLETE]);
    expect(buttons(now)).toEqual([
      undoButton(live.echoes[0]!.tag),
      { text: '✅ Tasdiqlash', callback_data: 'c:save' },
      { text: '📄 Sertifikat: bor', callback_data: 'c:cert_n' },
      { text: '➕ Yana ma’lumot', callback_data: 'c:more' },
      { text: '✖️ Bekor qilish', callback_data: 'c:cancel' },
    ]);
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
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Shapka'), line('Sumka')] } });
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

  it('after every answer the table says what it wrote and what is still open; the completing one closes on «AI hisoblaydi» (§3.4, product-fit-2)', async () => {
    // Re-anchored 2026-11-09: the state the echo said («⚠️ Yana 1 ta: 3-qator …», «Hamma qator to‘liq») is the table's last block now.
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka'), line('Shim')] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, '2: 50 dona');
    const first = tableNow(ctx, table);
    expect(first.text).toContain('✍️ Oxirgi javob: 2-qator «Sumka» — 50 dona\n⚠️ Yana 1 ta: 3-qator.\n✍️ Bir xabarda');
    expect(first.text).toContain('Bilmagan qatoringizni VED to‘ldiradi — «✅ Tasdiqlash» ni hozir ham bosishingiz mumkin.');
    expect(buttons(first).map((b) => b.callback_data)).toContain('c:save');
    await say(ctx, chatId, 'Shim 20 kg');
    const second = tableNow(ctx, table);
    expect(second.text.split('\n').slice(-2)).toEqual(['✍️ Oxirgi javob: 3-qator «Shim» — 20 kg', AI_TABLE_COMPLETE]);
    expect(buttons(second).map((b) => b.callback_data)).toContain('c:save');
    expect(ctx.replies).toEqual([table]);
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
  it('a bare figure gets ONE short reply — the question and its buttons, no ✅, no confirm, no ↩️; the pick writes the TARGET row and sends nothing (§3.4)', async () => {
    // Re-anchored 2026-11-09: the pick used to send its own echo with ↩️ and the confirm.
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka')] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, '2: 50');
    const asked = ctx.replies.at(-1)!;
    expect(asked.text).toBe('50 — qaysi birlikda?');
    expect(buttons(asked)).toEqual([
      { text: '50 dona', callback_data: 'c:pick_0' },
      { text: '50 kg', callback_data: 'c:pick_1' },
    ]);
    // Not every segment was written: no 👍.
    expect(ctx.reactions).toEqual([]);
    expect(activeIntake(chatId)!.offersMessageId).toBe(asked.id);
    await pressPick(from(ctx, asked.id), chatId, activeIntake(chatId)!, 1);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.facts.goods?.[1]).toEqual(line('Sumka', { weightKg: 50 }));
    expect(ctx.replies.at(-1)).toBe(asked);
    const now = tableNow(ctx, table);
    expect(now.text).toContain('✍️ Oxirgi javob: 2-qator «Sumka» — 50 kg');
    expect(buttons(now)[0]).toEqual(undoButton(activeIntake(chatId)!.echoes[0]!.tag));
    expect([...buttons(asked), ...buttons(now)].some((b) => b.callback_data === 'c:skip')).toBe(false);
  });

  it('a pick from an OLDER offer message while newer offers are live is «eskirgan», and nothing is written (regression-23)', async () => {
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka'), line('Sumka')] } });
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

  it('the add table draws NO conflict button — the line says the VED decides; a typed figure still resolves it, and ↩️ gives it back to the VED (his 1a, §1.1)', async () => {
    const { chatId } = open();
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text).toContain('↳ faylda 200 dona, so‘rovda 300 — VED hal qiladi');
    // The R3 question «qo‘shilsinmi, o‘rniga yoki VED hal qilsinmi?» and its three buttons are gone.
    expect(buttons(table).filter((b) => b.callback_data.startsWith('c:conf_'))).toEqual([]);
    await say(ctx, chatId, '1: 500 dona');
    expect(activeIntake(chatId)!.facts.goods?.[0]?.quantity).toBe(500);
    expect(activeIntake(chatId)!.conflicts[0]!.choice).toBe('add');
    const echo = ctx.replies.at(-1)!;
    const tag = activeIntake(chatId)!.echoes[0]!.tag;
    await pressUndo(from(ctx, echo.id), chatId, tag);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.facts.goods?.[0]?.quantity).toBe(300);
    // The VED's again (R3 interp 9) — never the unanswered null a table drew as buttons.
    expect(activeIntake(chatId)!.conflicts[0]!.choice).toBe('ved');
    expect(buttons(ctx.edits.at(-1)).filter((b) => b.callback_data.startsWith('c:conf_'))).toEqual([]);
  });

  it('an old «📨 VED» button answers «eskirgan» and writes nothing (§1.3)', async () => {
    const { chatId } = open();
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await handleCalcCallback(from(ctx, table.id), chatId, 'conf_0_ved');
    expect(ctx.texts().at(-1)).toBe('Bu tugma eskirgan — fayllar o‘zi solishtirildi.');
    expect(activeIntake(chatId)!.facts.goods?.[0]?.quantity).toBe(300);
    expect(activeIntake(chatId)!.conflicts[0]!.choice).toBeNull();
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

describe('the certificate stays on the AI door’s table keyboard (docs/IKKI-ESHIK.md §3.3, product-fit-20)', () => {
  it('the table carries it and the toggle; an answer’s short reply carries none; «yo‘q» pressed on the table sets it and redraws it', async () => {
    // Re-anchored 2026-11-09: this pinned the certificate riding on the echo, which the AI door no longer sends (§3.4).
    const { chatId } = collection({ stage: 'review', ai: true, hasCertificate: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka')] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text).toContain('📄 Sertifikat: bor');
    expect(buttons(table)).toContainEqual({ text: '📄 Sertifikat: bor', callback_data: 'c:cert_n' });
    await say(ctx, chatId, '2: 50');
    const asked = ctx.replies.at(-1)!;
    expect(asked.text).not.toContain('Sertifikat');
    expect(buttons(asked).map((b) => b.callback_data)).toEqual(['c:pick_0', 'c:pick_1']);
    await pressCertificate(from(ctx, table.id, { text: table.text, reply_markup: table.extra?.reply_markup }), chatId, false);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.hasCertificate).toBe(false);
    const now = tableNow(ctx, table);
    expect(now.text).toContain('📄 Sertifikat: yo‘q');
    expect(buttons(now)).toContainEqual({ text: '📄 Sertifikat: yo‘q', callback_data: 'c:cert_y' });
  });

  it('an echo a collection hydrated from before the doors still carries it: «yo‘q» pressed there edits that echo and the table', async () => {
    const { chatId } = collection({ stage: 'review', ai: true, hasCertificate: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka', { quantity: 50 })] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    const old = {
      text: '✅ 2-qator «Sumka»: 50 dona yozildi\n✅ Hamma qator to‘liq — «✅ Tasdiqlash» ni bosing.\n📄 Sertifikat: bor',
      reply_markup: { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'c:save' }], [{ text: '📄 Sertifikat: bor', callback_data: 'c:cert_n' }]] },
    };
    await pressCertificate(from(ctx, 555, old), chatId, false);
    await tableEditsSettled();
    const echoEdit = ctx.edits.find((e) => e.id === 555)!;
    expect(echoEdit.text).toContain('📄 Sertifikat: yo‘q');
    expect(buttons(echoEdit)).toContainEqual({ text: '📄 Sertifikat: yo‘q', callback_data: 'c:cert_y' });
    expect(tableNow(ctx, table).text).toContain('📄 Sertifikat: yo‘q');
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
  it('«Yiwu → Toshkent», then «➕ Yana ma’lumot» + «Bo‘ldi»: the route is still there; the NEW table’s ↩️ takes it away', async () => {
    // Re-anchored 2026-11-09: the ↩️ pressed was the echo's; on the AI door it is the table's (§3.4).
    const { chatId } = collection({ stage: 'review', ai: true, material: ['Kurtka 300 dona'], facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] } }, 'yolkira');
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, 'Yiwu → Toshkent');
    expect(activeIntake(chatId)!.facts).toMatchObject({ fromCity: 'Yiwu', toCity: 'Toshkent' });
    expect(tableNow(ctx, table).text).toContain('✍️ Oxirgi javob: yo‘nalish — Yiwu → Toshkent');
    const tag = activeIntake(chatId)!.echoes[0]!.tag;
    await handleCalcCallback(ctx, chatId, 'more');
    updateIntake(chatId, { material: ['Kurtka 300 dona', 'Shim 50 dona'] });
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300 }), line('Shim', { quantity: 50 })] }));
    await pressDone(ctx, chatId);
    expect(activeIntake(chatId)!.facts).toMatchObject({ fromCity: 'Yiwu', toCity: 'Toshkent' });
    // The new table still names the answer its ↩️ undoes.
    const fresh = ctx.replies.at(-1)!;
    expect(fresh.id).toBe(activeIntake(chatId)!.tableMessageId);
    expect(fresh.text).toContain('✍️ Oxirgi javob: yo‘nalish — Yiwu → Toshkent');
    expect(buttons(fresh)[0]).toEqual(undoButton(tag));
    await pressUndo(from(ctx, fresh.id), chatId, tag);
    await tableEditsSettled();
    const live = activeIntake(chatId)!;
    expect(live.facts.fromCity ?? null).toBeNull();
    expect(live.facts.toCity ?? null).toBeNull();
    expect(live.routeAnswer).toBeNull();
    expect(tableNow(ctx, fresh).text).toContain('↩️ Bekor qilindi: yo‘nalish — Yiwu → Toshkent');
    expect(buttons(tableNow(ctx, fresh)).some((b) => b.callback_data.startsWith('cu:'))).toBe(false);
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
    const { chatId } = collection({ stage: 'review', ai: true, material: ['Kurtka 300 dona'], facts: { volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] } }, 'yolkira');
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
    // Re-anchored 2026-11-09: the «3500 → 4200» and its ↩️ are on the table now (§3.4), not on an echo.
    const { chatId } = collection({ stage: 'review', ai: true, material: ['Kurtka 300 dona'], facts: { volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] } }, 'yolkira');
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, 'jami 3500 kg');
    await handleCalcCallback(ctx, chatId, 'more');
    await say(ctx, chatId, 'brutto 4200 kg');
    const live = activeIntake(chatId)!;
    expect(live.material).toEqual(['Kurtka 300 dona']);
    expect(live.facts.weightKg).toBe(4200);
    expect(ctx.texts().some((t) => t.includes('yozildi'))).toBe(false);
    const now = tableNow(ctx, table);
    expect(now.text).toContain('✍️ Oxirgi javob: umumiy brutto — 3500 → 4200 kg');
    expect(buttons(now)[0]).toEqual(undoButton(live.echoes.at(-1)!.tag));
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

/** The review’s findings on the shipped table (p3-review-spec, p3-review-adversary), each a probe made a test. */
describe('the review’s fixes', () => {
  const TABLE_MOVED = '⚠️ Jadval yangilandi — javobni yangi jadvalga qarab qayta yozing.';
  const item = (itemId: string, seq: number, name: string, extra: Partial<AmendBase['items'][number]> = {}): AmendBase['items'][number] => ({
    itemId,
    seq,
    name,
    quantity: null,
    weightKg: null,
    volumeM3: null,
    measureUnit: null,
    measureQty: null,
    tnvedCode: null,
    law: null,
    confirmed: false,
    ...extra,
  });
  const base = (items: AmendBase['items']): AmendBase => ({
    requestId: 'r-9',
    cardLabel: 'B-00999',
    entityType: 'deal',
    entityId: 'd-9',
    leadOpen: null,
    section: 'rastamojka',
    clientLabel: null,
    openedRev: 1,
    items,
    weightKg: 3500,
    volumeM3: 12,
    fromCity: null,
    toCity: null,
  });
  /** An add collection over one stored «Kurtka» 300 dona, the file saying 200. */
  const conflicted = (code: string | null = null) =>
    collection(
      {
        stage: 'review',
        standingAtOpen: 'open',
        facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300, seq: 1, itemId: 'i1', ...(code ? { tnvedCode: code } : {}) })] },
        conflicts: [{ itemId: 'i1', seq: 1, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: null }],
      },
      'rastamojka',
      base([item('i1', 1, 'Kurtka', { quantity: 300, tnvedCode: code })]),
    );

  it('a figure in ANOTHER field leaves the conflict open — the file’s 200 dona is neither written nor dropped (spec-1, adv-9)', async () => {
    const { chatId } = conflicted();
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    await say(ctx, chatId, '1: 150 kg');
    const live = activeIntake(chatId)!;
    expect(live.conflicts[0]!.choice).toBeNull();
    expect(live.lineAnswers).toEqual([{ index: 0, name: 'Kurtka', patch: { weightKg: 150 }, itemId: 'i1' }]);
    // The line is a statement since his 1a (docs/IKKI-ESHIK.md §1.1, intake.ts `conflictText`).
    expect(ctx.edits.at(-1)!.text).toContain('↳ faylda 200 dona, so‘rovda 300 — VED hal qiladi');
    // A conflict opens nothing since his 1a (docs/IKKI-ESHIK.md §1.1, intake.ts `tableOpenOf`): the
    // file's 200 is the VED's, so the rows ARE complete (this pinned the opposite while it was asked).
    expect(ctx.texts().at(-1)).toContain('Hamma qator to‘liq');
    // The count itself answers it.
    await say(ctx, chatId, '1: 400 dona');
    expect(activeIntake(chatId)!.conflicts[0]!.choice).toBe('rep');
  });

  /** A «📨 VED» echo a collection hydrated from before his 1a still carries (the button is gone, §1.1). */
  const vedEcho = (chatId: bigint) => {
    updateIntake(chatId, {
      conflicts: [{ itemId: 'i1', seq: 1, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: 'ved' }],
      echoes: [
        { tag: 'ved00001', messageId: 777, lines: [{ index: 0, no: 1, itemId: 'i1', name: 'Kurtka', before: { quantity: 300 }, patch: {} }], totals: null, undone: false },
      ],
    });
    return { id: 777, tag: 'ved00001' };
  };

  it('a hydrated «📨 VED», then a typed 400, then ↩️ under the VED echo: the 400 stands and the row is named (spec-2, adv-10)', async () => {
    const { chatId } = conflicted();
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    const ved = vedEcho(chatId);
    await say(ctx, chatId, '1: 400 dona');
    // A typed answer to the figure overrides the VED choice — he answered after all.
    expect(activeIntake(chatId)!.conflicts[0]!.choice).toBe('rep');
    await pressUndo(from(ctx, ved.id), chatId, ved.tag);
    await tableEditsSettled();
    const live = activeIntake(chatId)!;
    expect(live.facts.goods?.[0]?.quantity).toBe(400);
    expect(live.lineAnswers).toEqual([{ index: 0, name: 'Kurtka', patch: { quantity: 400 }, itemId: 'i1' }]);
    expect(live.conflicts[0]!.choice).toBe('rep');
    expect(ctx.edits.find((e) => e.id === ved.id)!.text).toBe('⚠️ 1-qator keyin o‘zgartirilgan — u bekor qilinmadi.');
  });

  it('↩️ under a hydrated VED echo nothing later changed: the conflict stays the VED’s — it is no question to open again (§1.1)', async () => {
    const { chatId } = conflicted();
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    const ved = vedEcho(chatId);
    await pressUndo(from(ctx, ved.id), chatId, ved.tag);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.conflicts[0]!.choice).toBe('ved');
    expect(activeIntake(chatId)!.facts.goods?.[0]?.quantity).toBe(300);
    expect(ctx.edits.find((e) => e.id === ved.id)!.text).toBe('↩️ Bekor qilindi: 1-qator «Kurtka» — VED hal qiladi');
  });

  it('five conflicts: no button for any, each named the VED’s (his 1a — this pinned three buttons at a time, spec-9)', async () => {
    const names = ['Kurtka', 'Shim', 'Sumka', 'Shapka', 'Futbolka'];
    const items = names.map((name, i) => item(`i${i + 1}`, i + 1, name, { quantity: 100 }));
    const { chatId } = collection(
      {
        stage: 'review',
        standingAtOpen: 'open',
        facts: { weightKg: 3500, volumeM3: 12, goods: names.map((name, i) => line(name, { quantity: 100, seq: i + 1, itemId: `i${i + 1}` })) },
        conflicts: names.map((_n, i) => ({ itemId: `i${i + 1}`, seq: i + 1, field: 'quantity' as const, unit: 'dona', stored: 100, read: 50, choice: null })),
      },
      'rastamojka',
      base(items),
    );
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(buttons(table).filter((b) => b.callback_data.startsWith('c:conf_'))).toEqual([]);
    expect(table.text.match(/faylda 50 dona, so‘rovda 100 — VED hal qiladi/gu)).toHaveLength(5);
  });

  it('a code typed over a stored row’s own is kept for the VED, never drawn on the row; ↩️ takes it back (adv-11)', async () => {
    const { chatId } = conflicted('6201400000');
    updateIntake(chatId, { conflicts: [] });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    await say(ctx, chatId, '1: kod 6201930000 50 dona');
    const echo = ctx.replies.at(-1)!;
    expect(echo.text).toContain('⚠️ 1-qatorda kod bor (6201400000) — yangi kod yozilmadi, VED ga aytiladi.');
    expect(echo.text).not.toContain('kod 6201930000');
    const live = activeIntake(chatId)!;
    expect(live.facts.goods?.[0]).toMatchObject({ tnvedCode: '6201400000', quantity: 50 });
    expect(live.lineAnswers).toEqual([{ index: 0, name: 'Kurtka', patch: { quantity: 50, tnvedCode: '6201930000' }, itemId: 'i1' }]);
    // A re-read puts the answer back without drawing the kept code.
    expect(placeByName([line('Kurtka', { itemId: 'i1', tnvedCode: '6201400000' })], live.lineAnswers).goods[0]).toEqual(
      line('Kurtka', { itemId: 'i1', tnvedCode: '6201400000', quantity: 50 }),
    );
    await pressUndo(from(ctx, echo.id), chatId, live.echoes.at(-1)!.tag);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.lineAnswers).toEqual([]);
    expect(activeIntake(chatId)!.facts.goods?.[0]).toMatchObject({ tnvedCode: '6201400000', quantity: 300 });
  });

  it('an orphan answer never takes the line a later correction holds (spec-10, adv-6)', () => {
    const placed = placeByName(
      [line('Kurtka'), line('Kurtka')],
      [
        { index: -1, name: 'Kurtka', patch: { quantity: 200 } },
        { index: 0, name: 'Kurtka', patch: { quantity: 100, weightKg: 150 } },
      ],
    );
    expect(placed.goods).toEqual([line('Kurtka', { quantity: 100, weightKg: 150 }), line('Kurtka', { quantity: 200 })]);
    expect(placed.entries.map((e) => e.index)).toEqual([1, 0]);
  });

  it('a correction keeps its answer’s place in the list', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka'), line('Kurtka')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '1: 100 dona');
    await say(ctx, chatId, '2: 200 dona');
    await say(ctx, chatId, '1: 150 kg');
    expect(activeIntake(chatId)!.lineAnswers.map((e) => [e.index, e.patch])).toEqual([
      [0, { quantity: 100, weightKg: 150 }],
      [1, { quantity: 200 }],
    ]);
  });

  it('seventy-five rows answered in one message: no message, and the table — its last block counted, never cut — fits in 4096 (adv-3, §3.4)', async () => {
    // Re-anchored 2026-11-09: this pinned the seventy-five-row ECHO fitting in 4096; the AI door sends none.
    const names = Array.from({ length: 75 }, (_v, i) => `Tovar ${String(i + 1).padStart(2, '0')} uzun nomli mahsulot qatori`);
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: names.map((n) => line(n, { tnvedCode: '4202920000' })) } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, names.map((_n, i) => `${i + 1}: 5 dona`).join('\n'));
    expect(ctx.replies).toEqual([table]);
    expect(activeIntake(chatId)!.lineAnswers).toHaveLength(75);
    const now = tableNow(ctx, table);
    expect(now.text.length).toBeLessThanOrEqual(4096);
    expect(now.text).toContain(
      [
        '✍️ Oxirgi javob:',
        '· 1-qator «Tovar 01 uzun nomli mahsulot qatori» — 5 dona',
        '· 2-qator «Tovar 02 uzun nomli mahsulot qatori» — 5 dona',
        '· 3-qator «Tovar 03 uzun nomli mahsulot qatori» — 5 dona',
        '· … va yana 72 ta',
        AI_TABLE_COMPLETE,
      ].join('\n'),
    );
  });

  it('no message to refuse: a transport that refuses every send is never asked to send, and the table is written (adv-3, §3.4)', async () => {
    // Re-anchored 2026-11-09: this pinned a refused ECHO leaving a truthful table; the AI door sends none.
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka')] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    const refusing = Object.assign(Object.create(ctx) as Ctx, {
      reply: async () => {
        throw Object.assign(new Error('400'), { description: 'Bad Request: message is too long' });
      },
    });
    await routeCollectorText(refusing, chatId, activeIntake(chatId)!, '2: 50 dona', typed());
    await tableEditsSettled();
    expect(activeIntake(chatId)!.facts.goods?.[1]).toEqual(line('Sumka', { quantity: 50 }));
    expect(ctx.edits.at(-1)).toMatchObject({ id: table.id });
    expect(ctx.edits.at(-1)!.text).toContain('2. Sumka — 50 dona');
  });

  it('one message’s buttons for two rows: both picks write, and a row’s second button is spent (adv-7)', async () => {
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka'), line('Sumka')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '1: 50\n2: 70');
    const asked = ctx.replies.at(-1)!;
    expect(buttons(asked).map((b) => b.text)).toEqual(['1-qator: 50 dona', '1-qator: 50 kg', '2-qator: 70 dona', '2-qator: 70 kg']);
    await pressPick(from(ctx, asked.id), chatId, activeIntake(chatId)!, 0);
    await tableEditsSettled();
    await pressPick(from(ctx, asked.id), chatId, activeIntake(chatId)!, 3);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.facts.goods).toEqual([line('Kurtka', { quantity: 50 }), line('Sumka', { weightKg: 70 })]);
    await pressPick(from(ctx, asked.id), chatId, activeIntake(chatId)!, 1);
    expect(ctx.texts().at(-1)).toBe('Bu tugma eskirgan.');
    expect(activeIntake(chatId)!.facts.goods?.[0]).toEqual(line('Kurtka', { quantity: 50 }));
  });

  it('a row whose buttons do not fit is asked in words, never dropped (adv-8)', async () => {
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka'), line('Sumka'), line('Shim')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, '1: 1,200\n2: 50\n3: 70');
    const echo = ctx.replies.at(-1)!;
    expect(echo.text).toContain('1-qator: 1.2 mi yoki 1200 mi?');
    expect(echo.text).toContain('2-qator: 50 — qaysi birlikda?');
    expect(echo.text).toContain('⚠️ 3-qator: 70 — qaysi birlikda? Yozib javob bering, masalan «3: 70 kg».');
    expect(buttons(echo)).toHaveLength(6);
  });

  it('the reading landed between the parse and the write: nothing written over it, the words kept (adv-12)', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 }), line('Sumka')] } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    const read = activeIntake(chatId)!;
    const reading = [line('Shim'), line('Kurtka', { quantity: 3 }), line('Sumka')];
    updateIntake(chatId, { facts: { weightKg: 3500, volumeM3: 12, goods: reading } });
    await routeCollectorText(ctx, chatId, read, '2: 50 dona', typed());
    await tableEditsSettled();
    expect(ctx.texts().at(-1)).toBe(TABLE_MOVED);
    const live = activeIntake(chatId)!;
    expect(live.facts.goods).toEqual(reading);
    expect(live.lineAnswers).toEqual([]);
    expect(live.answers).toEqual(['2-qator: 2: 50 dona']);
  });

  it('while the addition is being written, a pick writes nothing — and the retired conflict button only says so (adv-13)', async () => {
    const { chatId } = conflicted();
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    updateIntake(chatId, { stage: 'review' });
    await say(ctx, chatId, '1: 50');
    const asked = ctx.replies.at(-1)!;
    updateIntake(chatId, { saving: { token: 't', at: Date.now(), jobId: null } });
    await pressPick(from(ctx, asked.id), chatId, activeIntake(chatId)!, 0);
    expect(ctx.texts().at(-1)).toBe('⏳ Qo‘shimcha yozilmoqda — natija kelgach yozing.');
    await handleCalcCallback(from(ctx, table.id), chatId, 'conf_0_add');
    expect(ctx.texts().at(-1)).toBe('Bu tugma eskirgan — fayllar o‘zi solishtirildi.');
    const live = activeIntake(chatId)!;
    expect(live.facts.goods?.[0]?.quantity).toBe(300);
    expect(live.conflicts[0]!.choice).toBeNull();
    updateIntake(chatId, { saving: null });
  });

  it('a 429 on the table edit sends no second table, and the next answer draws it again (adv-16)', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 3 })] } });
    const ctx = fakeCtx({ editError: Object.assign(new Error('429'), { description: 'Too Many Requests: retry after 30' }) });
    await drawn(ctx, chatId);
    updateIntake(chatId, { tableHash: null }, { quiet: true });
    editTableSoon(ctx, chatId);
    await tableEditsSettled();
    expect(ctx.replies).toHaveLength(1);
    expect(activeIntake(chatId)!.tableHash).toBeNull();
  });

  it('«;» alone is asked, never an empty message (adv-17)', async () => {
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka')] } });
    const ctx = fakeCtx();
    await say(ctx, chatId, ';');
    expect(ctx.texts().at(-1)).toBe('⚠️ Qaysi qatorga? Raqami bilan yozing: «3: 50 dona». Umumiy og‘irlik bo‘lsa: «jami 3500 kg».');
  });

  it('an answer while collecting again points at «Bo‘ldi», never at a «Tasdiqlash» the guard refuses (adv-18)', async () => {
    // Re-anchored 2026-11-09: what the echo said is the table's now (§3.4) — the table that points down keeps only its ↩️.
    const { chatId } = collection({ stage: 'review', ai: true, material: ['x'], facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka'), line('Shim')] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    updateIntake(chatId, { stage: 'material', material: ['x', 'y'] });
    const id = await say(ctx, chatId, '1: 50 dona');
    expect(ctx.replies).toEqual([table]);
    expect(ctx.reactions).toEqual([{ id, emoji: '👍' }]);
    const now = tableNow(ctx, table);
    expect(now.text).toContain('✍️ Oxirgi javob: 1-qator «Kurtka» — 50 dona\n⚠️ Yana 1 ta: 2-qator.');
    expect(now.text.split('\n').at(-1)).toBe(TABLE_SUPERSEDED);
    expect(now.text).not.toContain('Tasdiqlash');
    expect(buttons(now)).toEqual([undoButton(activeIntake(chatId)!.echoes[0]!.tag)]);
  });
});

/**
 * The AI door's table through the real handlers (docs/IKKI-ESHIK.md §3.1-§3.4,
 * his 4a and 5a): a code the model proposed is marked as its proposal, a row
 * with no code is told who finds it — by whether the AI will run today — an
 * answer sends no message of its own, and what is refused or asked gets ONE
 * short reply carrying nothing else.
 */
describe('the AI door’s table (§3.1-§3.4)', () => {
  const coded = (source: 'model' | 'row') =>
    collection({
      stage: 'review',
      ai: true,
      facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300, tnvedCode: '6201400000', tnvedSource: source }), line('Sumka', { quantity: 50 })] },
    });

  it('heads with the door; a model’s code is «(AI taklifi)»; a row with no code is ℹ️ «AI hisoblashda topadi» — while the AI is available', async () => {
    const { chatId } = coded('model');
    const table = await drawn(fakeCtx(), chatId);
    const lines = table.text.split('\n');
    expect(lines[0]).toBe('🤖 AI rastamojka · 🛃 Rastamojka');
    expect(table.text).toContain('✅ 1. Kurtka — 300 dona · 6201400000 (AI taklifi)');
    expect(table.text).toContain(`ℹ️ 2. Sumka — 50 dona\n   ↳ ${CODE_GAP_AI}`);
    // A code is not the seller's part: the table is complete, and asks nothing about it.
    expect(lines.at(-1)).toBe(AI_TABLE_COMPLETE);
    expect(table.text).not.toContain('✍️');
  });

  it('…and «VED xodimi qo‘yadi» when it is not (no key, or the day’s budget spent) — read for the draw, and the closing promises no AI figure', async () => {
    budget.available = false;
    const { chatId } = coded('model');
    const table = await drawn(fakeCtx(), chatId);
    expect(table.text).toContain('ℹ️ 2. Sumka — 50 dona\n   ↳ kod yo‘q — VED xodimi qo‘yadi');
    expect(table.text).not.toContain('AI hisoblashda topadi');
    expect(table.text.split('\n').at(-1)).toBe('✅ Ma’lumot to‘liq — «✅ Tasdiqlash» ni bosing, so‘rov VED ga tushadi.');
  });

  it('a code TYPED onto the model’s row is the row’s own — the mark goes; ↩️ puts the model’s code and its mark back', async () => {
    const { chatId } = coded('model');
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, '1: kod 6201930000');
    expect(activeIntake(chatId)!.facts.goods?.[0]).toMatchObject({ tnvedCode: '6201930000', tnvedSource: 'row' });
    const typedTable = tableNow(ctx, table).text;
    expect(typedTable).toContain('1. Kurtka — 300 dona · 6201930000\n');
    expect(typedTable).not.toContain('(AI taklifi)');
    expect(typedTable).toContain('✍️ Oxirgi javob: 1-qator «Kurtka» — kod 6201930000');
    await pressUndo(from(ctx, table.id), chatId, activeIntake(chatId)!.echoes[0]!.tag);
    await tableEditsSettled();
    expect(activeIntake(chatId)!.facts.goods?.[0]).toMatchObject({ tnvedCode: '6201400000', tnvedSource: 'model' });
    expect(tableNow(ctx, table).text).toContain('· 6201400000 (AI taklifi)');
    expect(ctx.replies).toEqual([table]);
  });

  it('a refusal alone: ONE short reply with its words — no 👍, no «✅ Yozildi», no confirm, no certificate, no ↩️', async () => {
    const { chatId } = coded('row');
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    await say(ctx, chatId, '7: 5 dona');
    const reply = ctx.replies.at(-1)!;
    expect(reply.text).toBe('⚠️ 7-qator yo‘q (jami 2 ta qator)');
    expect(buttons(reply)).toEqual([]);
    expect(ctx.reactions).toEqual([]);
    expect(activeIntake(chatId)!.echoes).toEqual([]);
  });

  it('half written, half refused: the written half reaches the table, the reply carries ONLY the refused part, and no 👍', async () => {
    const { chatId } = coded('row');
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, '2: 20 kg\n9: 5 dona');
    expect(activeIntake(chatId)!.facts.goods?.[1]).toMatchObject({ name: 'Sumka', quantity: 50, weightKg: 20 });
    expect(ctx.replies).toHaveLength(2);
    expect(ctx.replies.at(-1)!.text).toBe('⚠️ 9-qator yo‘q (jami 2 ta qator)');
    expect(ctx.reactions).toEqual([]);
    expect(tableNow(ctx, table).text).toContain('✍️ Oxirgi javob: 2-qator «Sumka» — 20 kg');
  });

  it('the ↩️ names the NEWEST answer not taken back: two answers, one undo — the button moves to the first, and the block says both', async () => {
    const { chatId } = collection({ stage: 'review', ai: true, facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka'), line('Sumka')] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(buttons(table).some((b) => b.callback_data.startsWith('cu:'))).toBe(false);
    await say(ctx, chatId, '1: 30 dona');
    await say(ctx, chatId, '2: 40 kg');
    const [first, second] = activeIntake(chatId)!.echoes;
    expect(buttons(tableNow(ctx, table))[0]).toEqual(undoButton(second!.tag));
    await pressUndo(from(ctx, table.id), chatId, second!.tag);
    await tableEditsSettled();
    const now = tableNow(ctx, table);
    expect(buttons(now)[0]).toEqual(undoButton(first!.tag));
    expect(now.text).toContain('↩️ Bekor qilindi: 2-qator «Sumka» — 40 kg\n✍️ Oxirgi javob: 1-qator «Kurtka» — 30 dona');
    // A redelivered press of the drawn tag is idempotent.
    await pressUndo(from(ctx, table.id), chatId, second!.tag);
    expect(ctx.toasts.at(-1)).toBe('Allaqachon bekor qilingan');
    expect(activeIntake(chatId)!.facts.goods?.[0]).toMatchObject({ quantity: 30 });
    expect(ctx.replies).toEqual([table]);
  });

  it('an addition the VED has started on says «📝 VED ga yuboriladi» in the block, its keyboard the ↩️ and «📨 VED ga yuborish» (§3.7)', async () => {
    const amend = {
      requestId: 'r-7', cardLabel: 'B-00777', entityType: 'deal', entityId: 'd-7', leadOpen: null, section: 'rastamojka',
      clientLabel: null, openedRev: 1, weightKg: 3500, volumeM3: 12, fromCity: null, toCity: null, door: 'ai',
      items: [{ itemId: 'i1', seq: 1, name: 'Kurtka', quantity: null, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: '6201400000', law: null, confirmed: false }],
    } as AmendBase;
    const { chatId } = collection(
      { stage: 'review', standingAtOpen: 'started', facts: { weightKg: 3500, volumeM3: 12, lineWeightsStated: true, goods: [line('Kurtka', { seq: 1, itemId: 'i1', tnvedCode: '6201400000' })] } },
      'rastamojka',
      amend,
    );
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, '1: 150 dona');
    expect(ctx.replies).toEqual([table]);
    const now = tableNow(ctx, table);
    expect(now.text).toContain('📝 VED ga yuboriladi: 1-qator «Kurtka» — 150 dona');
    expect(now.text).toContain('✅ Ma’lumot to‘liq — «📨 VED ga yuborish» ni bosing.');
    expect(buttons(now).map((b) => b.callback_data)).toEqual([`cu:${activeIntake(chatId)!.echoes[0]!.tag}`, 'c:save', 'c:more', 'c:cancel']);
  });

  it('a request from before the doors (NULL) keeps today’s echo and draws no ↩️ on its table (§0.2)', async () => {
    const amend = {
      requestId: 'r-8', cardLabel: 'B-00888', entityType: 'deal', entityId: 'd-8', leadOpen: null, section: 'rastamojka',
      clientLabel: null, openedRev: 1, weightKg: 3500, volumeM3: 12, fromCity: null, toCity: null,
      items: [{ itemId: 'i1', seq: 1, name: 'Kurtka', quantity: null, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: null, law: null, confirmed: false }],
    } as AmendBase;
    const { chatId } = collection(
      { stage: 'review', standingAtOpen: 'open', facts: { weightKg: 3500, volumeM3: 12, lineWeightsStated: true, goods: [line('Kurtka', { seq: 1, itemId: 'i1' })] } },
      'rastamojka',
      amend,
    );
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, '1: 150 dona');
    const echo = ctx.replies.at(-1)!;
    expect(echo.text).toContain('✅ 1-qator «Kurtka»: 150 dona yozildi');
    expect(buttons(echo)[0]!.callback_data).toBe(`cu:${activeIntake(chatId)!.echoes[0]!.tag}`);
    expect(buttons(tableNow(ctx, table)).some((b) => b.callback_data.startsWith('cu:'))).toBe(false);
    expect(tableNow(ctx, table).text).not.toContain('Oxirgi javob');
    expect(ctx.reactions).toEqual([]);
  });
});
