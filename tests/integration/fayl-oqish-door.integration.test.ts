import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * docs/FAYL-OQISH.md §1.3 and §1.6 end to end (P-door): an AI-door job whose
 * reading is not whole lands for the VED ALONE — «👤 VED hisoblasin», or a
 * «✅» pressed over such a reading — and the record says so where every later
 * reader looks: the request's door is «🧮» (so the pass prepares the card
 * silently and a later «➕» re-passes silently too), the ✅ says why the AI did
 * not compute, the card's note says the AI door collected it. The choice is
 * DURABLE (`landAs`): the sweep resuming a landing cut after its note lands it
 * the same way, with no press to ask.
 *
 * The landing, the card, the request and the add writer are real; the pass's
 * queue is a spy, `openCalcRequest` can be made to throw once, and the sweep's
 * one send is stood in for.
 */
const queue = vi.hoisted(() => ({ spy: vi.fn(async () => true) }));
vi.mock('@/modules/wms/calc/prefill-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/prefill-queue')>()),
  queueCalcPrefill: queue.spy,
}));
const fault = vi.hoisted(() => ({ throwOnce: false, gate: null as null | Promise<void> }));
vi.mock('@/modules/wms/calc/service', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/calc/service')>();
  return {
    ...real,
    openCalcRequest: async (...args: Parameters<typeof real.openCalcRequest>) => {
      if (fault.throwOnce) {
        fault.throwOnce = false;
        throw new Error('the process died between the note and the request');
      }
      if (fault.gate) await fault.gate;
      return real.openCalcRequest(...args);
    },
  };
});
vi.mock('@/modules/platform/telegram/send', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/send')>()),
  sendText: vi.fn(async () => ({
    ok: true,
    status: 200,
    description: '',
    messageId: 67_001,
    retryAfter: null,
    permanent: false,
    botDown: false,
    usedFallback: false,
  })),
  editMarkup: vi.fn(async () => ({ ok: true, status: 200, description: '', messageId: null, retryAfter: null, permanent: false, botDown: false, usedFallback: false })),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequestItems, calcRequests, crmActivities, events, leads, tasks, telegramLinks, users } from '@/modules/platform/db/schema';
import { sendText } from '@/modules/platform/telegram/send';
import {
  __forgetIntakeMemory,
  activeIntake,
  endIntake,
  flushIntakeWrites,
  hydrateIntakes,
  peekIntake,
  setDurableIntakes,
  startIntake,
  updateIntake,
} from '@/modules/platform/telegram/calc-store';
import type { IntakeState } from '@/modules/platform/telegram/calc-intake';
import { __resetIntakeSweep, runIntakeSweep } from '@/modules/platform/telegram/calc-intake-sweep';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { landCollectedIntake } from '@/modules/platform/telegram/staff-bot';
import { AI_QUEUED, PLAIN_QUEUED } from '@/modules/platform/telegram/calc-dialog';
import { amendWords, amendSubmissionOf, unreadRepassLine } from '@/modules/platform/telegram/calc-amend';
import { amendRequest } from '@/modules/wms/calc/amend';
import { requestIntakeDoor } from '@/modules/wms/calc/intake-door';
import { directPass, silentPass } from '@/modules/wms/calc/jobs';
import { storedRequestFacts } from '@/modules/wms/calc/service';

const STAMP = String(Date.now()).slice(-7);
let seq = 0;
const staffIds: string[] = [];
const chats: bigint[] = [];
const notes: string[] = [];
const requests: string[] = [];

const PDF = { attachmentId: 'pdf-door-1', name: 'invoice.pdf', bytes: 10 };
const KURTKA = [{ name: 'Kurtka', quantity: 300, weightKg: 150, tnvedCode: '6201400000' }];

/** A staff chat (one person, one link) with an AI-door collection at its table. */
async function collected(patch: Partial<IntakeState>, section: IntakeState['section'] = 'rastamojka'): Promise<{ chat: bigint; staffId: string; noteId: string }> {
  seq += 1;
  const chat = BigInt(`-79${STAMP}${String(seq).padStart(2, '0')}`);
  chats.push(chat);
  const [u] = await db
    .insert(users)
    .values({ phone: `+99879${STAMP}${String(seq).padStart(2, '0')}`, fullName: `Fayl eshik ${STAMP}-${seq}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  const staffId = u!.id;
  staffIds.push(staffId);
  await db.insert(telegramLinks).values({ userId: staffId, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
  const state = startIntake(chat, section, { ai: true, staffId });
  notes.push(state.noteId);
  updateIntake(chat, {
    stage: 'review',
    clientHintRaw: `Fayl ${STAMP}-${seq} +99894${STAMP}${seq % 10}`,
    ...patch,
  });
  return { chat, staffId, noteId: state.noteId };
}

/** A press with no message (the dispatcher's pre-answered ctx). */
function press() {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 9_500 + replies.length };
      },
    },
  };
}

async function landedOn(noteId: string): Promise<{ id: string; door: string | null; items: number }> {
  const rows = (await db.execute(sql`
    SELECT id::text AS id, intake_door AS door, item_count AS items FROM calc_requests WHERE note_id = ${noteId}::uuid`)) as unknown as {
    id: string;
    door: string | null;
    items: number;
  }[];
  expect(rows, 'one request on the note').toHaveLength(1);
  requests.push(rows[0]!.id);
  return rows[0]!;
}

const noteText = async (noteId: string) =>
  (await db.select({ note: crmActivities.note }).from(crmActivities).where(eq(crmActivities.id, noteId)))[0]?.note ?? '';

const passesFor = (requestId: string) =>
  (queue.spy.mock.calls as unknown as [{ requestId: string; pass?: string }][]).filter(([c]) => c.requestId === requestId);

beforeEach(() => {
  queue.spy.mockClear();
  vi.mocked(sendText).mockClear();
  fault.throwOnce = false;
  fault.gate = null;
});

afterEach(() => {
  setDurableIntakes(false);
  __forgetIntakeMemory();
  __resetIntakeSweep();
});

afterAll(async () => {
  for (const chat of chats) endIntake(chat);
  const rows = await db
    .select({ id: calcRequests.id, taskId: calcRequests.taskId })
    .from(calcRequests)
    .where(inArray(calcRequests.noteId, notes));
  const ids = [...new Set([...requests, ...rows.map((r) => r.id)])];
  const cards = (
    await db.select({ entityId: crmActivities.entityId }).from(crmActivities).where(inArray(crmActivities.id, notes))
  ).map((r) => r.entityId);
  if (ids.length) {
    await db.execute(sql`DELETE FROM calc_amendments WHERE request_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, ids));
    await db.delete(calcRequests).where(inArray(calcRequests.id, ids));
  }
  const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
  if (taskIds.length) {
    await db.delete(events).where(inArray(events.entityId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  if (cards.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, cards));
    await db.delete(leads).where(inArray(leads.id, cards));
  }
  if (staffIds.length) {
    await db.execute(sql`DELETE FROM telegram_calc_intakes WHERE staff_id IN (${sql.join(staffIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, staffIds));
    // An audited fixture is deactivated, never deleted (audit_log FK).
    await db.update(users).set({ active: false }).where(inArray(users.id, staffIds));
  }
  await pgClient.end();
});

describe('«👤 VED hisoblasin» lands for the VED alone (§1.3 a)', () => {
  it('a zero-goods AI collection: the «🧮» door on the row, the VED words, no AI_QUEUED — and a rastamojka of nothing owes no pass (§1.3 c)', async () => {
    const { chat, noteId } = await collected({ fileCount: 1, pdfs: [PDF], aiUsed: true, facts: { weightKg: 300, volumeM3: 2 } });
    const { ctx, replies } = press();
    await handleCalcCallback(ctx, chat, 'to_ved');
    const tick = replies.find((t) => t.startsWith('✅'));
    expect(tick, replies.join(' | ')).toContain(
      '🧮 VED navbatiga tushdi — AI hisoblamadi: fayldagi tovarlar o‘qilmadi. VED xodimi fayllarni ko‘rib, javobni shu yerga yuboradi.',
    );
    expect(tick).not.toContain(AI_QUEUED);
    const landed = await landedOn(noteId);
    expect(landed).toMatchObject({ door: 'plain', items: 0 });
    expect(passesFor(landed.id)).toEqual([]);
    expect(await noteText(noteId)).toContain('🤖 AI eshigidan keldi — AI hisoblamadi: fayldagi tovarlar o‘qilmadi. O‘qilgan: tovar yo‘q.');
    expect(activeIntake(chat)).toBeNull();
  });

  it('«✅ Tasdiqlash» pressed over a reading that is not whole (an old table, a redelivery) lands the same way — and the pass is queued, silent on that door', async () => {
    const { chat, noteId } = await collected({
      fileCount: 2,
      pdfs: [PDF],
      invoiceGoods: KURTKA,
      aiUsed: false,
      aiFailure: 'not_configured',
      facts: { weightKg: 300, volumeM3: 2, goods: KURTKA },
    });
    const { ctx, replies } = press();
    await handleCalcCallback(ctx, chat, 'save');
    const tick = replies.find((t) => t.startsWith('✅'));
    expect(tick, replies.join(' | ')).toContain('AI hisoblamadi: 1 ta PDF o‘qilmadi.');
    expect(tick).not.toContain(AI_QUEUED);
    expect(tick).not.toContain(PLAIN_QUEUED);
    const landed = await landedOn(noteId);
    expect(landed).toMatchObject({ door: 'plain', items: 1 });
    // The model-free half still prepares the card for the VED (door-ved-no-prep)…
    expect(passesFor(landed.id)).toHaveLength(1);
    // …and a «🧮» row's customs pass is silent toward the seller.
    expect(silentPass(await requestIntakeDoor(landed.id), true)).toBe(true);
  });

  it('the landing finished AGAIN (a press after a crash) obeys the same zero-goods rule: `retried()` queues no pass either', async () => {
    const { chat, staffId, noteId } = await collected({ fileCount: 1, pdfs: [PDF], aiUsed: true, facts: { weightKg: 300, volumeM3: 2 }, landAs: 'ved' });
    const first = await landCollectedIntake(chat, staffId, 'Fayl eshik');
    expect(first?.queued).toBe(true);
    // The crash: the collection survived its landing, and the next press finishes it.
    const again = await landCollectedIntake(chat, staffId, 'Fayl eshik');
    expect(again?.outcome).toBe('retried');
    const landed = await landedOn(noteId);
    expect(landed.door).toBe('plain');
    expect(passesFor(landed.id)).toEqual([]);
    endIntake(chat);
  });

  it('a podklyuch of no goods keeps its pass — the road is priced from the totals', async () => {
    const { chat, noteId } = await collected(
      { fileCount: 1, pdfs: [PDF], aiUsed: true, route: { zone: 'cn', fromCity: 'Yiwu', toCity: 'Toshkent' }, facts: { weightKg: 300, volumeM3: 2, fromCity: 'Yiwu', toCity: 'Toshkent' } },
      'podklyuch',
    );
    const { ctx } = press();
    await handleCalcCallback(ctx, chat, 'to_ved');
    const landed = await landedOn(noteId);
    expect(landed).toMatchObject({ door: 'plain', items: 0 });
    expect(passesFor(landed.id)).toHaveLength(1);
  });

  it('a WHOLE reading’s «✅» lands as the AI door, and its choice is written (control)', async () => {
    const { chat, noteId } = await collected({ fileCount: 1, invoiceGoods: KURTKA, aiUsed: true, facts: { weightKg: 300, volumeM3: 2, goods: KURTKA } });
    const { ctx, replies } = press();
    await handleCalcCallback(ctx, chat, 'save');
    const landed = await landedOn(noteId);
    expect(landed.door).toBe('ai');
    expect(replies.find((t) => t.startsWith('✅'))).not.toContain('AI hisoblamadi');
    expect(await noteText(noteId)).not.toContain('AI eshigidan keldi');
  });

  it('«👤» on a plain collection is stale — it was never drawn there', async () => {
    const { chat, noteId } = await collected({ ai: false, fileCount: 1, pdfs: [PDF], facts: { weightKg: 300 } });
    const { ctx, replies } = press();
    await handleCalcCallback(ctx, chat, 'to_ved');
    expect(replies).toEqual(['Bu tugma eskirgan.']);
    expect(activeIntake(chat)?.noteId).toBe(noteId);
  });
});

describe('the choice is durable: the sweep resumes a cut landing the way it was pressed (door-aipass-home)', () => {
  it('the press writes its choice to the durable state BEFORE anything lands', async () => {
    setDurableIntakes(true);
    const { chat, noteId } = await collected({ fileCount: 1, invoiceGoods: KURTKA, aiUsed: true, facts: { weightKg: 300, volumeM3: 2, goods: KURTKA } });
    // The collection is in its row as it stood before the press — and nothing
    // here flushes again: the press's own write is what the row must show.
    expect(await flushIntakeWrites()).toBe(true);
    let open: () => void = () => {};
    fault.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { ctx } = press();
    const pressing = handleCalcCallback(ctx, chat, 'to_ved');
    // The note is on its card, the request held back: the choice is already in the ROW.
    await vi.waitFor(async () => {
      expect((await db.select({ id: crmActivities.id }).from(crmActivities).where(eq(crmActivities.id, noteId))).length).toBe(1);
    }, { timeout: 15_000, interval: 20 });
    const rows = (await db.execute(sql`SELECT state ->> 'landAs' AS land_as FROM telegram_calc_intakes WHERE note_id = ${noteId}::uuid`)) as unknown as {
      land_as: string | null;
    }[];
    expect(rows[0]?.land_as).toBe('ved');
    open();
    await pressing;
    expect((await landedOn(noteId)).door).toBe('plain');
  }, 30_000);

  it('👤 pressed, the landing cut after its note → the resume is still «🧮», its ✅ the VED words', async () => {
    setDurableIntakes(true);
    // A WHOLE reading: only the press makes it the VED's — a resume that re-derived
    // the landing from the reading alone would land it as the AI door.
    const { chat, staffId, noteId } = await collected({
      fileCount: 1,
      invoiceGoods: KURTKA,
      aiUsed: true,
      facts: { weightKg: 300, volumeM3: 2, goods: KURTKA },
      landAs: 'ved',
    });
    // The crash as the press leaves it (calc-landed-already's (b)): its choice
    // written, the note on its card, the request never opened.
    fault.throwOnce = true;
    const cut = await landCollectedIntake(chat, staffId, 'Fayl eshik');
    expect(cut?.queued).toBe(false);
    expect((await db.select({ id: calcRequests.id }).from(calcRequests).where(eq(calcRequests.noteId, noteId))).length).toBe(0);
    // As a crash leaves it: the row written, memory gone, the process restored.
    expect(await flushIntakeWrites()).toBe(true);
    __forgetIntakeMemory();
    await hydrateIntakes();
    expect(peekIntake(chat)?.landAs).toBe('ved');
    vi.mocked(sendText).mockClear();
    await runIntakeSweep(Date.now());
    const said = vi.mocked(sendText).mock.calls.map(([m]) => String(m.text)).find((t) => t.startsWith('✅'));
    expect(said).toContain('🧮 VED navbatiga tushdi — AI hisoblamadi: «👤 VED hisoblasin» bosildi.');
    expect(said).not.toContain(AI_QUEUED);
    expect((await landedOn(noteId)).door).toBe('plain');
  });
});

describe('after a VED landing, «➕» brings no AI figure back (door-ved-then-add)', () => {
  it('the addition re-passes on the «🧮» row: silent toward the seller, plainLine words, never «AI qayta hisoblayapti»', async () => {
    const { chat, staffId, noteId } = await collected({ fileCount: 1, pdfs: [PDF], aiUsed: true, facts: { weightKg: 300, volumeM3: 2 } });
    const { ctx } = press();
    await handleCalcCallback(ctx, chat, 'to_ved');
    const landed = await landedOn(noteId);
    queue.spy.mockClear();
    const out = await amendRequest({
      requestId: landed.id,
      staffId,
      staffName: 'Fayl eshik',
      noteId: randomUUID(),
      chatId: chat,
      submission: {
        rowAnswers: [],
        newLines: [{ name: 'Shim', quantity: 50 }],
        totals: null,
        route: null,
        conflicts: [],
        doubtedTotals: [],
        material: ['Shim 50 dona'],
        fileCount: 0,
      },
    });
    expect(out.kind).toBe('applied');
    const door = await requestIntakeDoor(landed.id);
    expect(door).toBe('plain');
    // The addition's own pass is past the mute by its name, and the door's silence outranks it.
    expect(directPass('amend:x', door)).toBe(true);
    expect(silentPass(door, true)).toBe(true);
    const words = await amendWords(out as Parameters<typeof amendWords>[0], false, door, true);
    expect(words).toContain('🤖 AI kartani VED uchun qayta tayyorlaydi — narxni VED beradi.');
    expect(words).not.toContain('AI qayta hisoblayapti');
  });
});

describe('an AI-door addition whose own reading is not whole re-runs nothing (§1.6)', () => {
  it('written, no `amend:` pass, the words say what was not read', async () => {
    const { chat, staffId, noteId } = await collected({ fileCount: 1, invoiceGoods: KURTKA, aiUsed: true, facts: { weightKg: 300, volumeM3: 2, goods: KURTKA } });
    const { ctx } = press();
    await handleCalcCallback(ctx, chat, 'save');
    const landed = await landedOn(noteId);
    expect(landed.door).toBe('ai');
    queue.spy.mockClear();
    // The add collection's submission, as the save builds it over a reading that did not read its PDF.
    const stored = await storedRequestFacts(landed.id);
    const addChat = chat - 50n;
    chats.push(addChat);
    startIntake(addChat, 'rastamojka', { ai: true, staffId, amend: stored!.base });
    const state = updateIntake(addChat, {
      stage: 'review',
      fileCount: 1,
      pdfs: [PDF],
      aiUsed: false,
      aiFailure: 'not_configured',
      facts: { goods: [...stored!.base.items.map((i) => ({ name: i.name, itemId: i.itemId, seq: i.seq, quantity: i.quantity })), { name: 'Shim', quantity: 50 }] },
    })!;
    const { addReadingUnread } = await import('@/modules/platform/telegram/calc-amend');
    const unread = await addReadingUnread(state);
    expect(unread).toBe('1 ta PDF');
    const out = await amendRequest({
      requestId: landed.id,
      staffId,
      staffName: 'Fayl eshik',
      noteId: randomUUID(),
      chatId: chat,
      submission: amendSubmissionOf(state, unread),
    });
    expect(out.kind).toBe('applied');
    expect(passesFor(landed.id)).toEqual([]);
    const words = await amendWords(out as Parameters<typeof amendWords>[0], false, 'ai', true);
    expect(words).toContain(unreadRepassLine('1 ta PDF'));
    expect(words).not.toContain('AI qayta hisoblayapti');
  });
});
