import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A landing pressed again, and a landing cut off halfway (docs/SAKKIZ-R3.md
 * §6.2.15, durability-3): Uch band's landing converges by NOTE — the note's
 * own card (`cardOfNote`, 'retried'), its root request (`rootRequestOfNote`),
 * K2's note lock for a concurrent twin — so «Tasdiqlash» pressed again after
 * a crash, or the sweep finishing what a crash cut off, ends in ONE request on
 * ONE card, said once with the retried words.
 *
 * The landing, the card and the request are real; the queue (the AI pass) is
 * a spy, `openCalcRequest` can be made to throw once or wait, and the sweep's
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
    messageId: 66_001,
    retryAfter: null,
    permanent: false,
    botDown: false,
    usedFallback: false,
  })),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequests, crmActivities, events, leads, tasks, telegramLinks, users } from '@/modules/platform/db/schema';
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
import { __resetIntakeSweep, runIntakeSweep } from '@/modules/platform/telegram/calc-intake-sweep';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { landCollectedIntake } from '@/modules/platform/telegram/staff-bot';

const STAMP = String(Date.now()).slice(-7);
let seq = 0;
let staffId = '';
const staffIds: string[] = [];
const chats: bigint[] = [];
const notes: string[] = [];

/** A staff chat with a collection that reached its table, for a stranger with a phone. */
async function reviewed(): Promise<bigint> {
  seq += 1;
  const chatId = BigInt(`-78${STAMP}${String(seq).padStart(2, '0')}`);
  chats.push(chatId);
  // One staff member per chat: a person has one Telegram link.
  const [u] = await db
    .insert(users)
    .values({ phone: `+99878${STAMP}${String(seq).padStart(2, '0')}`, fullName: `Qayta qo‘nish ${STAMP}-${seq}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  staffId = u!.id;
  staffIds.push(staffId);
  await db.insert(telegramLinks).values({ userId: staffId, telegramChatId: chatId, status: 'linked', linkedAt: new Date() });
  const state = startIntake(chatId, 'rastamojka', { staffId });
  notes.push(state.noteId);
  updateIntake(chatId, {
    stage: 'review',
    clientHintRaw: `Qayta ${STAMP}-${seq} +99893${STAMP}${seq}`,
    material: ['Kurtka 300 dona 150 kg'],
    facts: { weightKg: 150, volumeM3: 1, goods: [{ name: 'Kurtka', quantity: 300 }] },
  });
  return chatId;
}

/** A «Tasdiqlash» press with no message (the dispatcher's pre-answered ctx). */
function press() {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 9_000 + replies.length };
      },
    },
  };
}

const requestsOn = async (noteId: string) =>
  (await db.select({ id: calcRequests.id }).from(calcRequests).where(eq(calcRequests.noteId, noteId))).length;

const sweepTicks = () =>
  vi.mocked(sendText).mock.calls.filter(([m]) => String(m.text).startsWith('✅')).length;

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
    .select({ id: calcRequests.id, taskId: calcRequests.taskId, entityId: calcRequests.entityId })
    .from(calcRequests)
    .where(inArray(calcRequests.noteId, notes));
  const cards = (
    await db.select({ entityId: crmActivities.entityId }).from(crmActivities).where(inArray(crmActivities.id, notes))
  ).map((r) => r.entityId);
  if (rows.length) await db.delete(calcRequests).where(inArray(calcRequests.id, rows.map((r) => r.id)));
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

describe('a landing in flight belongs to its press (§6.2.15, re-check v2-11)', () => {
  it('a tick while the press is landing — the note committed, the request not yet — sends no second ✅', async () => {
    setDurableIntakes(true);
    const chat = await reviewed();
    const noteId = peekIntake(chat)!.noteId;
    let open: () => void = () => {};
    fault.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { ctx, replies } = press();
    const pressing = handleCalcCallback(ctx, chat, 'save');
    // The note is on its card before the request is opened.
    await vi.waitFor(async () => {
      const rows = await db.select({ id: crmActivities.id }).from(crmActivities).where(eq(crmActivities.id, noteId));
      expect(rows).toHaveLength(1);
    }, { timeout: 15_000, interval: 50 });
    await runIntakeSweep(Date.now());
    expect(sweepTicks()).toBe(0);
    open();
    await pressing;
    expect(replies.filter((t) => t.startsWith('✅')), replies.join(' | ')).toHaveLength(1);
    expect(sweepTicks()).toBe(0);
    expect(await requestsOn(noteId)).toBe(1);
  }, 30_000);
});

describe('«Tasdiqlash» again after a crash (durability-3)', () => {
  it('(a) landed and kept: the ✅ names the same card with the retried words, and one request carries the note', async () => {
    const chat = await reviewed();
    const noteId = peekIntake(chat)!.noteId;
    const first = await landCollectedIntake(chat, staffId, 'Qayta qo‘nish');
    expect(first?.requestId).toBeTruthy();
    // The crash: the collection survived its landing.
    expect(activeIntake(chat)).not.toBeNull();
    const { ctx, replies } = press();
    await handleCalcCallback(ctx, chat, 'save');
    const tick = replies.find((t) => t.startsWith('✅'));
    expect(tick).toContain(`✅ Saqlandi — oldingi urinishda ochilgan lid: ${first!.label}`);
    expect(await requestsOn(noteId)).toBe(1);
    expect(queue.spy).toHaveBeenCalledTimes(1);
    expect(activeIntake(chat)).toBeNull();
  });

  it('(b) cut between the note and the request: the hydrate keeps it, the next press finishes it on the same card', async () => {
    setDurableIntakes(true);
    const chat = await reviewed();
    const noteId = peekIntake(chat)!.noteId;
    fault.throwOnce = true;
    const cut = await landCollectedIntake(chat, staffId, 'Qayta qo‘nish');
    expect(cut?.queued).toBe(false);
    expect(await requestsOn(noteId)).toBe(0);
    // As a crash leaves it: the row written, memory gone, the process restored.
    expect(await flushIntakeWrites()).toBe(true);
    __forgetIntakeMemory();
    await hydrateIntakes();
    expect(peekIntake(chat)?.noteId).toBe(noteId);
    const { ctx, replies } = press();
    await handleCalcCallback(ctx, chat, 'save');
    const tick = replies.find((t) => t.startsWith('✅'));
    expect(tick).toContain(`✅ Saqlandi — oldingi urinishda ochilgan lid: ${cut!.label}`);
    expect(await requestsOn(noteId)).toBe(1);
    const [card] = await db.select({ entityId: crmActivities.entityId }).from(crmActivities).where(eq(crmActivities.id, noteId));
    const [request] = await db.select({ entityId: calcRequests.entityId }).from(calcRequests).where(eq(calcRequests.noteId, noteId));
    expect(request!.entityId).toBe(card!.entityId);
    expect(queue.spy).toHaveBeenCalledTimes(1);
  });
});
