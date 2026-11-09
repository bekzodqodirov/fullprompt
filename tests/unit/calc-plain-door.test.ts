import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

/**
 * The plain door «🧮 Hisoblatish» in the chat, and what both doors share
 * there (docs/IKKI-ESHIK.md §1.1, §1.3-§1.6, §2.1-§2.3, §2.5, §2.6 — his 1a,
 * 2a, 3a): after «Bo‘ldi» a SUMMARY that asks nothing; a typed text after it
 * written quietly, pointed at «Tasdiqlash», or filed as material; ONE
 * «Qabul qilindi» prompt kept as the last message; the customer and the zone
 * asked once per collection; no conflict button on either door. Through the
 * real handlers; the model and the budget are stand-ins and Telegram a fake
 * that records what was said, edited, deleted and reacted to.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100, recordAiPass: async () => {} }));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import type { Context } from 'grammy';
import { activeIntake, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import {
  AI_QUEUED,
  NO_OPEN_COLLECTION,
  PLAIN_QUEUED,
  TABLE_SUPERSEDED,
  clientAnswer,
  collectionDoor,
  deliverNextStep,
  drawPromptSoon,
  intakePromptText,
  plainAck,
  plainVerdict,
  pressPick,
  routeCollectorText,
  tableEditsSettled,
} from '@/modules/platform/telegram/calc-dialog';
import { addPointerWords, collectorScope, nothingNewToRead } from '@/modules/platform/telegram/calc-store';
import { CLIENT_QUESTION } from '@/modules/platform/telegram/calc-keyboards';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { amendWords, SAVE_WORDS, type Told } from '@/modules/platform/telegram/calc-amend';
import { fitTelegram, intakeTableText, type TableInput } from '@/modules/wms/calc/intake';
import { parseTableAnswer, nameWordFor, type TableRef } from '@/modules/wms/calc/line-address';
import { SELLER_TAIL_NO_ASK } from '@/modules/wms/calc/tail-words';
import type { AmendBase } from '@/modules/wms/calc/amend-types';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}, section: IntakeState['section'] = 'rastamojka', amend: AmendBase | null = null) {
  seq += 1;
  const chatId = BigInt(-9_700_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-test', amend });
  return { chatId, state: updateIntake(chatId, patch)! };
}

type Sent = { id: number; text: string; extra?: Record<string, unknown> };
/** Telegram as a recorder: replies, edits, deletes and reactions; `deleteFails` keeps old copies standing. */
function fakeCtx(opts: { deleteFails?: boolean } = {}) {
  let next = 100;
  const replies: Sent[] = [];
  const edits: Sent[] = [];
  const deleted: number[] = [];
  const reactions: { id: number; emoji: string }[] = [];
  return {
    replies,
    edits,
    deleted,
    reactions,
    texts: () => replies.map((r) => r.text),
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
      async deleteMessage(_chat: string, id: number) {
        if (opts.deleteFails) throw Object.assign(new Error('400'), { description: 'Bad Request: message can’t be deleted' });
        deleted.push(id);
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
const from = (ctx: Ctx, id: number) => Object.assign(Object.create(ctx) as Ctx, { callbackQuery: { message: { message_id: id } } });
const buttons = (sent: Sent | undefined) =>
  ((sent?.extra?.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat();

let messageId = 5_000;
/**
 * A typed message, routed as the collector routes it — inside the bot's own
 * message scope (`collectorScope`), so what TAKES it (`takenUpTo`) is
 * production's: a helper that wrote `takenUpTo` itself pinned a path
 * production never takes (review PC-SPEC-2 — the zone question was edited
 * above an untaken «Yiwu»). The table's edit and the prompt's draw settled.
 */
async function say(ctx: Ctx, chatId: bigint, text: string, opts: Partial<{ forwarded: boolean }> = {}) {
  const id = (messageId += 1);
  const scoped = { chat: { id: Number(chatId) }, message: { message_id: id }, api: { config: { use() {} } } } as unknown as Context;
  await collectorScope()(scoped, () =>
    routeCollectorText(ctx, chatId, activeIntake(chatId)!, text, { date: 0, messageId: id, forwarded: opts.forwarded ?? false, replyTo: null }),
  );
  await tableEditsSettled();
  await keptLastSettled();
  return id;
}
async function drawn(ctx: Ctx, chatId: bigint) {
  await deliverNextStep(ctx, chatId, activeIntake(chatId)!);
  return ctx.replies.at(-1)!;
}

const THREE = [line('Kurtka', { quantity: 300 }), line('Sumka', { quantity: 100 }), line('Shim', { quantity: 200 })];

beforeEach(() => {
  model.analyze.mockReset();
  resetReadingDrive();
});
afterEach(async () => {
  await tableEditsSettled();
  await keptLastSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('the plain door’s summary (§2.1, his 2a)', () => {
  it('heads with the door, marks a gap ℹ️ with the VED’s words, asks nothing, and closes on «Tasdiqlash»', async () => {
    const { chatId } = collection({ stage: 'review', clientHintRaw: 'GS777', facts: { volumeM3: 12, goods: [line('Kurtka', { quantity: 300 }), line('Sumka')] } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(table.text.split('\n')[0]).toBe('🧮 Hisoblatish · 🛃 Rastamojka');
    expect(table.text).toContain('ℹ️ 2. Sumka\n   ↳ dona yoki kg yo‘q — VED xodimi so‘raydi');
    // The landing pass's own lenta words for a seller's fact — never restated.
    expect(table.text).toContain(`yo‘q ${SELLER_TAIL_NO_ASK.lenta}`);
    expect(table.text).toContain('ℹ️ umumiy brutto og‘irligi (kg, qadoq bilan) yo‘q — VED xodimi so‘raydi');
    expect(table.text).not.toMatch(/⚠️ \d|⚠️ umumiy|✍️|Bir xabarda|Sertifikat/u);
    expect(table.text).toContain('ℹ️ Yetishmaganini VED xodimi o‘zi so‘raydi — «✅ Tasdiqlash» ni hozir bosishingiz mumkin.');
    expect(table.text.split('\n').at(-1)).toBe(
      'Qator raqami bilan yozsangiz («3: 150 kg», «jami 3500 kg») — shu yerda yangilanadi. Yana ma’lumot bo‘lsa — yuboring.',
    );
    expect(buttons(table).map((b) => b.text)).toEqual(['✅ Tasdiqlash', '➕ Yana ma’lumot', '✖️ Bekor qilish']);
  });

  it('complete: «✅ Ma’lumot to‘liq — … so‘rov VED ga tushadi.»', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const table = await drawn(fakeCtx(), chatId);
    expect(table.text).toContain('✅ Ma’lumot to‘liq — «✅ Tasdiqlash» ni bosing, so‘rov VED ga tushadi.');
    expect(table.text).not.toContain('ℹ️');
  });

  it('the AI door keeps its table; a NULL-door add collection keeps today’s; a plain-door add collection summarises (§2.6)', async () => {
    const ai = collection({ stage: 'review', ai: true, facts: { volumeM3: 12, goods: [line('Sumka')] } });
    expect((await drawn(fakeCtx(), ai.chatId)).text).toContain('⚠️ 1. Sumka');
    const base = (door?: 'plain' | 'ai' | null): AmendBase => ({
      requestId: 'r-1', cardLabel: 'B-00123', entityType: 'deal', entityId: 'd-1', leadOpen: null, section: 'rastamojka',
      clientLabel: null, openedRev: 1, weightKg: 3500, volumeM3: 12, fromCity: null, toCity: null,
      items: [{ itemId: 'i1', seq: 1, name: 'Sumka', quantity: null, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: null, law: null, confirmed: false }],
      ...(door !== undefined ? { door } : {}),
    });
    // A stored row's weight is its own (openAdd's `lineWeightsStated`) — never the brutto's copy.
    const facts = { weightKg: 3500, volumeM3: 12, lineWeightsStated: true, goods: [line('Sumka', { seq: 1, itemId: 'i1' })] };
    const legacy = collection({ stage: 'review', standingAtOpen: 'open', facts }, 'rastamojka', base());
    expect((await drawn(fakeCtx(), legacy.chatId)).text).toContain('⚠️ 1. Sumka');
    const plain = collection({ stage: 'review', standingAtOpen: 'open', facts }, 'rastamojka', base('plain'));
    const text = (await drawn(fakeCtx(), plain.chatId)).text;
    expect(text).toContain('ℹ️ 1. Sumka');
    expect(text).toContain('ℹ️ Yetishmaganini VED xodimi o‘zi so‘raydi — «✅ Qo‘shish» ni hozir bosishingiz mumkin.');
  });

  it('the door of a collection: first by its flag, an addition by its request, a seeded one by its source (§0.3)', () => {
    const base = { requestId: 'r' } as AmendBase;
    expect(collectionDoor({ ai: false, amend: null, seed: null })).toBe('plain');
    expect(collectionDoor({ ai: true, amend: null, seed: null })).toBe('ai');
    expect(collectionDoor({ ai: false, amend: { ...base, door: 'plain' }, seed: null })).toBe('plain');
    expect(collectionDoor({ ai: true, amend: base, seed: null })).toBeNull();
    expect(collectionDoor({ ai: false, amend: null, seed: [], seedDoor: 'plain' })).toBe('plain');
    // A seeded collection from before the doors: legacy, whatever its flag says.
    expect(collectionDoor({ ai: false, amend: null, seed: [] })).toBeNull();
  });
});

describe('no conflict button on either door (his 1a, §1.1)', () => {
  it('the add table names the conflict the VED’s and draws no `conf_N_*` — plain and AI alike', async () => {
    for (const door of ['plain', 'ai'] as const) {
      const amend = {
        requestId: 'r-2', cardLabel: 'B-00124', entityType: 'deal', entityId: 'd-2', leadOpen: null, section: 'rastamojka',
        clientLabel: null, openedRev: 1, weightKg: 3500, volumeM3: 12, fromCity: null, toCity: null, door,
        items: [{ itemId: 'i1', seq: 1, name: 'Kurtka', quantity: 300, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: null, law: null, confirmed: false }],
      } as AmendBase;
      const { chatId } = collection(
        {
          stage: 'review',
          standingAtOpen: 'open',
          facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300, seq: 1, itemId: 'i1' })] },
          conflicts: [{ itemId: 'i1', seq: 1, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: null }],
        },
        'rastamojka',
        amend,
      );
      const table = await drawn(fakeCtx(), chatId);
      expect(table.text, door).toContain('↳ faylda 200 dona, so‘rovda 300 — VED hal qiladi');
      expect(buttons(table).filter((b) => b.callback_data.startsWith('c:conf_')), door).toEqual([]);
    }
  });
});

describe('a typed text after the plain summary (§2.2)', () => {
  it('(a) placed whole — written quietly, the summary edited, a 👍, and NO message', async () => {
    const { chatId } = collection({ stage: 'review', material: ['ro‘yxat'], facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    const before = ctx.replies.length;
    const id = await say(ctx, chatId, '3: 150 kg');
    const live = activeIntake(chatId)!;
    expect(live.facts.goods?.[2]).toEqual(line('Shim', { quantity: 200, weightKg: 150 }));
    expect(live.facts.weightKg).toBe(3500);
    expect(live.lineAnswers).toEqual([{ index: 2, name: 'Shim', patch: { weightKg: 150 }, itemId: null }]);
    expect(live.material).toEqual(['ro‘yxat']);
    expect(live.answers).toEqual(['3-qator: 3: 150 kg']);
    expect(ctx.replies.length).toBe(before);
    expect(ctx.reactions).toEqual([{ id, emoji: '👍' }]);
    expect(ctx.edits.at(-1)).toMatchObject({ id: table.id });
    expect(ctx.edits.at(-1)!.text).toContain('✅ 3. Shim — 200 dona · 150 kg');
  });

  it('(a) a figure that would ASK is kept for the VED as words — no buttons, no question', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka'), line('Sumka')] } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    const before = ctx.replies.length;
    await say(ctx, chatId, '2: 50');
    const live = activeIntake(chatId)!;
    expect(ctx.replies.length).toBe(before);
    expect(live.offers).toEqual([]);
    expect(live.facts.goods?.[1]).toEqual(line('Sumka'));
    expect(live.answers).toEqual(['2-qator: 2: 50']);
  });

  it('(a) an addressed refusal gets its one line, and nothing is written', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    await say(ctx, chatId, '7: 5 dona');
    expect(ctx.texts().at(-1)).toBe('⚠️ 7-qator yo‘q (jami 3 ta qator)');
    expect(buttons(ctx.replies.at(-1))).toEqual([]);
    expect(ctx.reactions).toEqual([]);
    expect(activeIntake(chatId)!.facts.goods).toEqual(THREE);
  });

  it('(b) no digit and no goods — «ok» — writes nothing and points at «Tasdiqlash»', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    for (const text of ['ok', 'rahmat']) {
      await say(ctx, chatId, text);
      expect(ctx.texts().at(-1), text).toBe('Tasdiqlash uchun «✅ Tasdiqlash» ni bosing. Yana ma’lumot bo‘lsa — yuboring.');
    }
    const live = activeIntake(chatId)!;
    expect(live.stage).toBe('review');
    expect(live.material).toEqual([]);
  });

  it('(c) anything else is material: the summary points down and loses its buttons, ONE prompt below', async () => {
    const { chatId } = collection({ stage: 'review', clientHintRaw: 'GS777', material: ['ro‘yxat'], facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    await say(ctx, chatId, 'Shapka 30 dona');
    const live = activeIntake(chatId)!;
    expect(live.stage).toBe('material');
    expect(live.material).toEqual(['ro‘yxat', 'Shapka 30 dona']);
    const edit = ctx.edits.filter((e) => e.id === table.id).at(-1)!;
    expect(edit.text.split('\n').at(-1)).toBe(TABLE_SUPERSEDED);
    expect(buttons(edit)).toEqual([]);
    const prompt = ctx.replies.at(-1)!;
    expect(prompt.text.split('\n')[0]).toBe('Mijoz: GS777');
    expect(prompt.text).toContain('Qabul qilindi: ✍️ 2 ta xabar');
    expect(buttons(prompt).map((b) => b.callback_data)).toEqual(['c:done', 'c:cancel']);
    expect(live.promptMessageId).toBe(prompt.id);
  });

  it('collecting after a first reading reads the same way — «Sumka 80 kg» is the row’s, never material', async () => {
    const { chatId } = collection({ stage: 'material', material: ['ro‘yxat', 'yana'], facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    await say(ctx, chatId, 'Sumka 80 kg');
    const live = activeIntake(chatId)!;
    expect(live.facts.goods?.[1]).toEqual(line('Sumka', { quantity: 100, weightKg: 80 }));
    expect(live.material).toEqual(['ro‘yxat', 'yana']);
    expect(live.stage).toBe('material');
    expect(ctx.replies).toEqual([]);
  });

  it('`plainVerdict`: per segment — what is placed is written, goods are material, a courtesy word is nothing (review PC-ADV-1)', () => {
    const rows = THREE.map((g, i) => ({ no: i + 1, index: i, seq: null, name: g.name, needs: [] }));
    const ref: TableRef = { rows, open: [], preferred: [], stage: 'review' };
    const verdict = (text: string, stage: IntakeState['stage'] = 'review') => plainVerdict(parseTableAnswer(text, ref), stage);
    for (const text of ['3: 150 kg', 'Sumka 80 kg', 'jami 3500 kg', '7: 5 dona', '3: 640399000', 'Sumka']) {
      expect(verdict(text), text).toMatchObject({ kind: 'write', goods: null });
    }
    // A row's answer with a courtesy word under it is the row's answer — never material.
    expect(verdict('3: 150 kg\nrahmat')).toMatchObject({ kind: 'write', goods: null, segments: [{ raw: '3: 150 kg' }] });
    // Beside it, ONE figure placed nowhere rides along (its NO_ADDRESS line); new goods go to material on their own.
    expect(verdict('3: 150 kg\n5 dona')).toMatchObject({ kind: 'write', goods: null, segments: [{ raw: '3: 150 kg' }, { raw: '5 dona' }] });
    expect(verdict('3: 150 kg\nShapka 20 dona')).toMatchObject({ kind: 'write', goods: 'Shapka 20 dona', segments: [{ raw: '3: 150 kg' }] });
    // Nothing placed: goods are the whole text's material, a lone figure is the VED's words.
    for (const text of ['Shapka 30 dona', 'Shapka', 'Ayollar sumkasi', 'Shapka va shim', 'qachon tayyor bo‘ladi?']) {
      expect(verdict(text), text).toEqual({ kind: 'material' });
    }
    expect(verdict('150 kg')).toEqual({ kind: 'unplaced' });
    for (const text of ['ok', 'rahmat', 'Ok, rahmat aka!', 'хорошо', '👍', 'xo‘p']) expect(verdict(text), text).toEqual({ kind: 'nudge' });
    // A number naming OTHER goods is a refusal in the summary — and, collecting after «➕», the seller’s list (review PC-ADV-3).
    expect(verdict('1. Shapka 50 dona 20 kg\n2. Kepka 30 dona 10 kg').kind).toBe('write');
    expect(verdict('1. Shapka 50 dona 20 kg\n2. Kepka 30 dona 10 kg', 'material')).toEqual({ kind: 'material' });
    expect(plainAck('Shapka')).toBe(false);
  });

  it('beside a row’s answer: «rahmat» is nothing, a figure placed nowhere is told how, new goods are the next reading’s', async () => {
    const { chatId } = collection({ stage: 'review', clientHintRaw: 'GS777', material: ['ro‘yxat'], facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    const before = ctx.replies.length;
    const thanks = await say(ctx, chatId, '3: 150 kg\nrahmat');
    let live = activeIntake(chatId)!;
    expect(live.facts.goods?.[2]).toEqual(line('Shim', { quantity: 200, weightKg: 150 }));
    expect(live.facts.weightKg).toBe(3500);
    expect(live.material).toEqual(['ro‘yxat']);
    expect(ctx.replies.length).toBe(before);
    expect(ctx.reactions).toEqual([{ id: thanks, emoji: '👍' }]);
    await say(ctx, chatId, '2: 80 kg\n5 dona');
    live = activeIntake(chatId)!;
    expect(live.facts.goods?.[1]).toEqual(line('Sumka', { quantity: 100, weightKg: 80 }));
    expect(live.material).toEqual(['ro‘yxat']);
    expect(ctx.texts().at(-1)).toBe('⚠️ Qaysi qatorga? Raqami bilan yozing: «3: 50 dona». Umumiy og‘irlik bo‘lsa: «jami 3500 kg».');
    expect(ctx.reactions).toHaveLength(1);
    await say(ctx, chatId, '1: 40 kg\nShapka 20 dona');
    live = activeIntake(chatId)!;
    expect(live.facts.goods?.[0]).toEqual(line('Kurtka', { quantity: 300, weightKg: 40 }));
    expect(live.material).toEqual(['ro‘yxat', 'Shapka 20 dona']);
    expect(live.stage).toBe('material');
    expect(ctx.edits.filter((e) => e.id === table.id).at(-1)!.text.split('\n').at(-1)).toBe(TABLE_SUPERSEDED);
    expect(live.answers).toEqual(['3: 150 kg\nrahmat', '2: 80 kg\n5 dona', '1: 40 kg\nShapka 20 dona']);
  });

  it('a lone figure the table cannot place is the VED’s words, never material (review PC-ADV-1)', async () => {
    const { chatId } = collection({ stage: 'review', material: ['ro‘yxat'], facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    await say(ctx, chatId, '150 kg');
    const live = activeIntake(chatId)!;
    expect(live.material).toEqual(['ro‘yxat']);
    expect(live.stage).toBe('review');
    expect(live.answers).toEqual(['150 kg']);
    expect(live.facts.weightKg).toBe(3500);
    expect(ctx.texts().at(-1)).toBe('⚠️ Qaysi qatorga? Raqami bilan yozing: «3: 50 dona». Umumiy og‘irlik bo‘lsa: «jami 3500 kg».');
  });

  it('a forgotten product with no figure is material — on the summary and after «➕» alike (review PC-SPEC-1, PC-ADV-4)', async () => {
    for (const stage of ['review', 'material'] as const) {
      const { chatId } = collection({ stage, material: ['x'], readMark: { material: 1, files: 0 }, facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
      const ctx = fakeCtx();
      await drawn(ctx, chatId);
      updateIntake(chatId, { stage }, { quiet: true });
      for (const text of ['Shapka', 'Ayollar sumkasi']) await say(ctx, chatId, text);
      const live = activeIntake(chatId)!;
      expect(live.material, stage).toEqual(['x', 'Shapka', 'Ayollar sumkasi']);
      expect(live.stage, stage).toBe('material');
      expect(ctx.texts().some((t) => t.startsWith('Tasdiqlash uchun')), stage).toBe(false);
    }
  });

  it('a row’s figure the seller must retype is never asked — kept for the VED, a 👍 (review PC-SPEC-3)', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    const before = ctx.replies.length;
    const texts = ['3: 640399000', '3: 50 dona 20 dona', '3: 150 kg 160 kg', '3: 20 karobka'];
    for (const text of texts) await say(ctx, chatId, text);
    expect(ctx.replies.length).toBe(before);
    expect(ctx.reactions).toHaveLength(texts.length);
    expect(activeIntake(chatId)!.facts.goods).toEqual(THREE);
    expect(activeIntake(chatId)!.answers).toEqual(texts.map((t) => `3-qator: ${t}`));
  });

  it('collecting after «➕» on a summary: a numbered list of OTHER goods is the seller’s list, never «press ➕» (review PC-ADV-3)', async () => {
    const { chatId } = collection({ stage: 'review', material: ['x'], facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    updateIntake(chatId, { stage: 'material' });
    const list = '1. Shapka 50 dona 20 kg\n2. Kepka 30 dona 10 kg';
    await say(ctx, chatId, list);
    const live = activeIntake(chatId)!;
    expect(live.material).toEqual(['x', list]);
    expect(ctx.texts().some((t) => t.includes('yangi tovar bo‘lsa «➕ Yana ma’lumot» ni bosing')), 'no press-➕ loop').toBe(false);
  });

  it('«➕» and nothing sent since the reading: the summary keeps its buttons and its closing (review PC-ADV-6, PC-SPEC-5)', async () => {
    const { chatId } = collection({ stage: 'review', material: ['ro‘yxat'], readMark: { material: 1, files: 0 }, facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    updateIntake(chatId, { stage: 'material' });
    await say(ctx, chatId, '3: 150 kg');
    const edit = ctx.edits.filter((e) => e.id === table.id).at(-1)!;
    expect(edit.text).not.toContain(TABLE_SUPERSEDED);
    expect(edit.text).toContain('✅ Ma’lumot to‘liq — «✅ Tasdiqlash» ni bosing, so‘rov VED ga tushadi.');
    expect(buttons(edit).map((b) => b.text)).toEqual(['✅ Tasdiqlash', '➕ Yana ma’lumot', '✖️ Bekor qilish']);
    // «ok» there points at the ✅ that still stands, never at «Bo‘ldi».
    await say(ctx, chatId, 'ok');
    expect(ctx.texts().at(-1)).toBe('Tasdiqlash uchun «✅ Tasdiqlash» ni bosing. Yana ma’lumot bo‘lsa — yuboring.');
    // Something sent since: the marker, and the closing gone with the ✅ it named.
    await say(ctx, chatId, 'Shapka 30 dona');
    const marked = ctx.edits.filter((e) => e.id === table.id).at(-1)!;
    expect(marked.text.split('\n').at(-1)).toBe(TABLE_SUPERSEDED);
    expect(marked.text).not.toContain('Ma’lumot to‘liq');
    expect(marked.text).not.toContain('Qator raqami bilan yozsangiz');
    await say(ctx, chatId, 'ok');
    expect(ctx.texts().at(-1)).toBe('Yangi ma’lumot hali o‘qilmagan — avval «Bo‘ldi» ni bosing.');
  });

  it('the nudge joins the collection’s own messages, so the prompt knows it is not last (review PC-ADV-4)', async () => {
    const { chatId } = collection({ stage: 'review', facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    await say(ctx, chatId, 'rahmat');
    expect(activeIntake(chatId)!.ownMessageIds).toContain(ctx.replies.at(-1)!.id);
  });

  it('a unit button an older table drew answers «Bu tugma eskirgan.» on the plain door (§1.3)', async () => {
    const { chatId } = collection({
      stage: 'review',
      facts: { weightKg: 3500, volumeM3: 12, goods: THREE },
      offers: [{ unit: 'dona', value: 50, target: { line: 2 } }],
      offersMessageId: 77,
    });
    const ctx = fakeCtx();
    await pressPick(from(ctx, 77), chatId, activeIntake(chatId)!, 0);
    expect(ctx.texts()).toEqual(['Bu tugma eskirgan.']);
    expect(activeIntake(chatId)!.facts.goods).toEqual(THREE);
  });
});

describe('the ONE prompt (§1.4)', () => {
  const fit = { sheetFit: (texts: readonly string[]) => ({ kept: texts.map(() => 5), total: texts.map(() => 9) }), fitTelegram };

  it('a pure function of the collection: the customer, the counts, a line per model-read file and the receipt notes', () => {
    const { state } = collection({
      stage: 'material',
      clientHintRaw: 'GS777',
      material: ['Kurtka'],
      fileCount: 3,
      pdfs: [{ attachmentId: 'p', name: 'inv.pdf', bytes: 10 }],
      sheetTexts: [{ text: 'a\nb', cut: false, cellsCut: false, label: '«list.xlsx»' }],
      fileNotes: ['📄 «A.xlsx» — 3 ta tovar o‘qildi.'],
    });
    const text = intakePromptText(state, fit);
    expect(text.split('\n')).toEqual([
      'Mijoz: GS777',
      'Qabul qilindi: ✍️ 1 ta xabar · 📎 3 ta fayl',
      '📄 «inv.pdf» — AI o‘qiydi.',
      '📄 «list.xlsx» — jadval sarlavhasini topa olmadim, AI o‘qiydi.',
      '⚠️ Jadval katta: AI faqat birinchi 5 / 9 qatorini o‘qiydi — qolganini VED fayldan ko‘radi.',
      '📄 «A.xlsx» — 3 ta tovar o‘qildi.',
      'Yana yuboring yoki «Bo‘ldi» ni bosing.',
    ]);
  });

  it('cut to Telegram’s 4096, the closing kept — a door’s lead inside the cut (review PC-ADV-8)', () => {
    const { state } = collection({ stage: 'material', material: ['x'], fileNotes: Array.from({ length: 400 }, (_v, i) => `📄 «F${i}.xlsx» — ${i} ta tovar o‘qildi.`) });
    const text = intakePromptText(state, fit);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/… va yana \d+ ta qator/u);
    expect(text.split('\n').at(-1)).toBe('Yana yuboring yoki «Bo‘ldi» ni bosing.');
    const lead = '▶️ Davom etamiz — 3 ta fayl qo‘shildi.';
    const led = intakePromptText(state, fit, lead);
    expect(led.length).toBeLessThanOrEqual(4096);
    expect(led.split('\n')[0]).toBe(lead);
  });

  it('a lead survives the burst it was queued in — a later draw in the same burst says it (review PC-SPEC-13)', async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka'] });
    const ctx = fakeCtx();
    drawPromptSoon(ctx, chatId, '▶️ Davom etamiz — 3 ta fayl qo‘shildi.');
    // The take's own draw and an album part, coalesced into the same run.
    drawPromptSoon(ctx, chatId);
    drawPromptSoon(ctx, chatId);
    await keptLastSettled();
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]!.text.split('\n')[0]).toBe('▶️ Davom etamiz — 3 ta fayl qo‘shildi.');
    // Said once: the next burst's draw does not repeat it.
    drawPromptSoon(ctx, chatId);
    await keptLastSettled();
    expect(ctx.edits.at(-1)!.text).not.toContain('Davom etamiz');
  });

  it('kept LAST: edited while nothing is newer, moved below what arrived and the old copy deleted', async () => {
    const { chatId } = collection({ stage: 'material', clientHintRaw: 'GS777', material: ['Kurtka'] });
    const ctx = fakeCtx();
    drawPromptSoon(ctx, chatId);
    await keptLastSettled();
    const first = ctx.replies.at(-1)!;
    // A redraw with nothing newer edits it in place.
    drawPromptSoon(ctx, chatId);
    await keptLastSettled();
    expect(ctx.replies.at(-1)).toBe(first);
    expect(ctx.edits.at(-1)?.id).toBe(first.id);
    // Material below it moves it — ONCE for a burst.
    updateIntake(chatId, { material: ['Kurtka', 'Shim', 'Sumka'], takenUpTo: first.id + 50 });
    for (let i = 0; i < 3; i += 1) drawPromptSoon(ctx, chatId);
    await keptLastSettled();
    const moved = ctx.replies.at(-1)!;
    expect(moved).not.toBe(first);
    expect(ctx.replies.filter((r) => r.text.startsWith('Mijoz: GS777'))).toHaveLength(2);
    expect(ctx.deleted).toEqual([first.id]);
    expect(activeIntake(chatId)!.promptMessageId).toBe(moved.id);
  });

  it('a copy that cannot be deleted stays among the collection’s own, so its «Bo‘ldi» still works', async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka'], promptMessageId: 40 });
    updateIntake(chatId, { takenUpTo: 60 }, { quiet: true });
    const ctx = fakeCtx({ deleteFails: true });
    drawPromptSoon(ctx, chatId);
    await keptLastSettled();
    expect(activeIntake(chatId)!.ownMessageIds).toContain(40);
    expect(activeIntake(chatId)!.promptMessageId).toBe(ctx.replies.at(-1)!.id);
  });

  it('a reading settles it: the table is the control, and the first material after it draws a NEW prompt below', async () => {
    const { chatId } = collection({ stage: 'review', material: ['Kurtka'], promptMessageId: 40, facts: { weightKg: 3500, volumeM3: 12, goods: THREE } });
    const ctx = fakeCtx();
    const table = await drawn(ctx, chatId);
    expect(activeIntake(chatId)!.promptMessageId).toBeNull();
    await say(ctx, chatId, 'Shapka 30 dona', { forwarded: true });
    const prompt = ctx.replies.at(-1)!;
    expect(prompt.id).toBeGreaterThan(table.id);
    expect(prompt.text).toContain('Qabul qilindi');
    expect(ctx.deleted).toEqual([]);
  });
});

describe('the customer and the zone are asked ONCE (§1.5, §1.6)', () => {
  it('a goods list at the customer question: ONE message — what became of it, the counts, the question once', async () => {
    const { chatId } = collection({ stage: 'client', promptMessageId: 30 });
    updateIntake(chatId, { takenUpTo: 30 }, { quiet: true });
    const ctx = fakeCtx();
    await say(ctx, chatId, 'Kurtka 300 dona 150 kg\nShim 200 dona 80 kg');
    expect(ctx.replies).toHaveLength(1);
    const asked = ctx.replies[0]!.text;
    expect(asked).toBe(
      `✍️ Ma’lumot sifatida olindi — tovar ro‘yxatiga o‘xshaydi.\n\nQabul qilindi: ✍️ 1 ta xabar.\n\n${CLIENT_QUESTION}`,
    );
    expect(asked.match(/Mijozni/gu)).toHaveLength(1);
    expect(ctx.deleted).toEqual([30]);
    expect(ctx.replies[0]!.extra).toMatchObject({ parse_mode: 'Markdown' });
  });

  it('`clientAnswer` asks once: the first send’s line no longer re-asks above the question', () => {
    const { state } = collection({ stage: 'client' });
    const answer = clientAnswer(state, 'Kurtka 300 dona', { material: true, couldBeCustomer: false, why: 'goods' });
    expect(answer.kind).toBe('material');
    if (answer.kind !== 'material') return;
    expect(answer.lead).toBe('✍️ Ma’lumot sifatida olindi — tovar ro‘yxatiga o‘xshaydi.');
    expect(answer.say).not.toContain('Mijozni bitta qatorda yozing');
    expect(answer.say.match(/Mijozni/gu)).toHaveLength(1);
    // The same list sent again: the repeat's line says why, and the question is still asked once (review PC-SPEC-11).
    const again = clientAnswer({ ...state, ...answer.patch }, 'Kurtka 300 dona', { material: true, couldBeCustomer: false, why: 'goods' });
    expect(again.kind === 'material' && again.say).toBe(`✍️ Bu matn allaqachon olingan — ikkinchi marta qo‘shilmadi. Tovar ro‘yxati mijoz bo‘la olmaydi.\n\n${CLIENT_QUESTION}`);
  });

  it('named: the prompt, first line «Mijoz: GS777» — or, with nothing sent yet, what to send', async () => {
    const holding = collection({ stage: 'client', fileCount: 2 });
    const ctx = fakeCtx();
    await say(ctx, holding.chatId, 'GS777');
    expect(ctx.texts().at(-1)!.split('\n').slice(0, 2)).toEqual(['Mijoz: GS777', 'Qabul qilindi: 📎 2 ta fayl']);
    expect(ctx.texts().at(-1)).not.toContain('Tovar ro‘yxatini yuboring');
    const empty = collection({ stage: 'client' });
    const ctx2 = fakeCtx();
    await say(ctx2, empty.chatId, 'GS777');
    expect(ctx2.texts().at(-1)).toContain('Tovar ro‘yxatini yuboring');
  });

  it('the zone question counts what arrived and is asked once, kept last', async () => {
    const { chatId } = collection({ stage: 'section', ai: true, fileCount: 4, promptMessageId: 30 }, 'podklyuch');
    const ctx = fakeCtx();
    await say(ctx, chatId, 'Yiwu');
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]!.text).toBe('Qabul qilindi: 📎 4 ta fayl.\nAvval yuk qayerdan chiqishini tanlang:');
    expect(buttons(ctx.replies[0]).some((b) => b.callback_data.startsWith('c:z'))).toBe(true);
    expect(ctx.deleted).toEqual([30]);
  });

  it('«Bo‘ldi» at the customer question redraws the one question — never a second copy', async () => {
    const { chatId } = collection({ stage: 'client', material: ['x'] });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await keptLastSettled();
    await handleCalcCallback(ctx, chatId, 'done');
    await keptLastSettled();
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.edits).toHaveLength(1);
  });
});

describe('the refusals and the outcome line follow the door (§2.5, §2.6)', () => {
  it('no open collection: no request in hand, so today’s words — the legacy door’s (§0.2, review PC-SPEC-10)', () => {
    expect(NO_OPEN_COLLECTION).toBe(
      'Ochiq hisoblatish yo‘q (24 soatdan oshgan yoki tugatilgan). Qo‘shimcha bo‘lsa — ✅ yoki AI javobi ostidagi «➕ Shu so‘rovga qo‘shish» ni bosing, yoki AI javobiga reply qilib yozing. Yangi hisob — «🧮 Hisoblatish».',
    );
    expect(addPointerWords(null)).toContain('AI javobiga reply qilib yozing');
    expect(addPointerWords('ai')).toBe(addPointerWords(null));
    expect(addPointerWords('plain')).not.toContain('AI javobi');
  });

  it('an applied addition’s line: a «🧮» request’s re-run promises the VED, never a result in the chat', async () => {
    const applied = (section: 'rastamojka' | 'yolkira'): Told =>
      ({ kind: 'applied', amendmentId: 'a', rev: 1, queued: true, lines: [], change: { section, card: 'B-1' } }) as unknown as Told;
    const plain = await amendWords(applied('rastamojka'), false, 'plain');
    expect(plain).toContain('🤖 AI kartani VED uchun qayta tayyorlaydi — narxni VED beradi.');
    expect(plain).not.toContain(SAVE_WORDS.aiLine.trim());
    for (const door of ['ai', null] as const) {
      expect(await amendWords(applied('rastamojka'), false, door), String(door)).toContain(SAVE_WORDS.aiLine.trim());
    }
    // The tariff answers in the chat on either door (his 2.5 b).
    expect(await amendWords(applied('yolkira'), false, 'plain')).toContain(SAVE_WORDS.tariffLine.trim());
  });

  it('the ✅ queue lines are exported once, for both senders', () => {
    expect(PLAIN_QUEUED).toBe('🧮 VED navbatiga tushdi — VED xodimi hisoblab, javobni shu yerga yuboradi.');
    expect(AI_QUEUED).toBe('🤖 AI hisoblayapti — taxminiy natija bir necha daqiqada shu yerga keladi. Rasmiy narxni VED xodimi beradi.');
  });
});

describe('the reading settles the prompt through the job too', () => {
  it('«Bo‘ldi» → the reading → the table; the prompt is cleared, the next material draws a new one', async () => {
    const { chatId } = collection({ stage: 'material', clientHintRaw: 'GS777', material: ['Kurtka 300 dona'], promptMessageId: 41 });
    model.analyze.mockResolvedValueOnce({
      ok: true,
      facts: { fromCity: null, toCity: null, weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300 })] },
      steps: [],
      usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
      answered: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    const live = activeIntake(chatId)!;
    expect(live.stage).toBe('review');
    expect(live.promptMessageId).toBeNull();
    expect(ctx.texts().at(-1)!.split('\n')[0]).toBe('🧮 Hisoblatish · 🛃 Rastamojka');
    // What the reading read is its mark (review PC-ADV-6): «➕» and nothing
    // sent is nothing new; one more message is.
    expect(live.readMark).toEqual({ material: 1, files: 0 });
    expect(nothingNewToRead(live)).toBe(true);
    expect(nothingNewToRead({ ...live, material: [...live.material, 'Shim'] })).toBe(false);
  });

  it('the summary’s words and the parser read the same rows (`nameWordFor` is the parser’s)', () => {
    const input: TableInput = {
      section: 'rastamojka',
      facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka'), line('Sumka')] },
      laws: new Map(),
      clientLabel: null,
      fileCount: 0,
      ambiguous: [],
      amend: null,
      tail: '',
      nameWord: nameWordFor,
      plain: true,
    };
    const text = intakeTableText(input);
    expect(text).not.toContain('✍️');
    expect(text.match(/ℹ️ \d\./gu)).toHaveLength(2);
  });
});

describe('a file speaks only to refuse (§1.4); a typed code is the seller’s (review PF-ADV-11)', () => {
  it('`refusalOf`: an informational answer is a line of the prompt — only a refusal is a message', async () => {
    const { refusalOf } = await import('@/modules/platform/telegram/calc-files');
    expect(refusalOf({ patch: { fileNotes: ['📄 «A.xlsx» — 3 ta tovar o‘qildi.'] }, say: '📄 «A.xlsx» — 3 ta tovar o‘qildi.' })).toBeNull();
    expect(refusalOf({ patch: { pdfs: [] }, say: '📄 «B.pdf» — AI o‘qiydi.' })).toBeNull();
    expect(refusalOf({ patch: { sheetTexts: [] }, say: '📄 «C.xlsx» — jadval sarlavhasini topa olmadim, AI o‘qiydi.' })).toBeNull();
    expect(refusalOf({ patch: { imagesSkipped: 1 }, say: '📷 «D.heic» — HEIC rasm, o‘qib bo‘lmaydi.' })).toBe('📷 «D.heic» — HEIC rasm, o‘qib bo‘lmaydi.');
    expect(refusalOf({ patch: {}, say: '📄 «E.docx» — Word fayl o‘qilmaydi.' })).toBe('📄 «E.docx» — Word fayl o‘qilmaydi.');
    expect(refusalOf({ patch: { imagesSkipped: 1 }, say: null })).toBeNull();
  });

  it('a code typed onto a row lands as the row’s own — never the model’s proposal it replaced', async () => {
    const { chatId } = collection({
      stage: 'review',
      facts: { weightKg: 3500, volumeM3: 12, goods: [line('Kurtka', { quantity: 300, tnvedCode: '6201400000', tnvedSource: 'model' })] },
    });
    const ctx = fakeCtx();
    await drawn(ctx, chatId);
    await say(ctx, chatId, '1: kod 6201930000');
    const live = activeIntake(chatId)!;
    expect(live.facts.goods?.[0]).toMatchObject({ tnvedCode: '6201930000', tnvedSource: 'row' });
    expect(live.lineAnswers[0]!.patch).toMatchObject({ tnvedCode: '6201930000', tnvedSource: 'row' });
  });
});
