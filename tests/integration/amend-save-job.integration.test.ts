import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * «✅ Qo‘shish» as a pg-boss job (docs/SAKKIZ-R3.md §9.6, durability-4/5/9/15):
 * the press freezes the collection and enqueues; the job writes ONCE (the
 * note id is the once-key), says the outcome ONCE, and a repeat — pg-boss's
 * redelivery after a kill, an expired run's twin, a second enqueue — redoes
 * only what is missing. The queue is stood in (the payload is captured and
 * run by hand), the sender is the no-network transport.
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));
vi.mock('@/modules/wms/calc/prefill-queue', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/prefill-queue')>()),
  ticketStanding: vi.fn(async () => 'none' as const),
  queueCalcPrefill: vi.fn(async () => true),
}));
vi.mock('@/modules/wms/crm/internal-chat', async (original) => {
  const real = await original<typeof import('@/modules/wms/crm/internal-chat')>();
  return { ...real, announceNote: vi.fn(real.announceNote) };
});
vi.mock('@/modules/platform/telegram/calc-store', async (original) => {
  const real = await original<typeof import('@/modules/platform/telegram/calc-store')>();
  return { ...real, loadIntake: vi.fn(real.loadIntake) };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcAmendments,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  dealStages,
  events,
  notifications,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { enqueue } from '@/modules/platform/jobs/boss';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import {
  activeIntake,
  endIntake,
  IntakesNotReady,
  loadIntake,
  startIntake,
  updateIntake,
} from '@/modules/platform/telegram/calc-store';
import {
  releaseDeadSave,
  requeueAmendSave,
  runAmendSave,
  saveAmendment,
  SAVE_WORDS,
  type AmendSaveJob,
} from '@/modules/platform/telegram/calc-amend';
import { registerStaffBot } from '@/modules/platform/telegram/staff-handlers';
import { announceNote } from '@/modules/wms/crm/internal-chat';
import { queueCalcPrefill } from '@/modules/wms/calc/prefill-queue';
import { openCalcRequest, storedRequestFacts } from '@/modules/wms/calc/service';

const SUFFIX = String(Date.now()).slice(-6);
let chatSeq = 0;
const nextChat = () => BigInt(`-96${SUFFIX}${String((chatSeq += 1)).padStart(2, '0')}`);
let sellerId = '';
let clientId = '';
let openDealStage = '';
const madeDeals: string[] = [];
const madeRequests: string[] = [];
const chats: bigint[] = [];
/** Every sendMessage the transport saw: chat and text. */
const sent: { chat: string; text: string }[] = [];
/** The next N sendMessage calls fail with a 500 — a process killed before its words. */
let failSends = 0;

beforeAll(async () => {
  const [seller] = await db
    .insert(users)
    .values({ phone: `+99893${String(Date.now()).slice(-7)}`, fullName: `Ali ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  sellerId = seller!.id;
  const [client] = await db.insert(clients).values({ clientCode: `AJ${SUFFIX}`, name: `Job mijoz ${SUFFIX}` }).returning();
  clientId = client!.id;
  openDealStage = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  process.env.TELEGRAM_BOT_TOKEN = 'amend-job-token';
  __setTelegramTransport(async (url, init) => {
    if (url.endsWith('/sendMessage') && typeof init.body === 'string') {
      if (failSends > 0) {
        failSends -= 1;
        return new Response(JSON.stringify({ ok: false, error_code: 500, description: 'Internal' }), { status: 500 });
      }
      const body = JSON.parse(init.body) as { text?: string; chat_id?: string | number };
      sent.push({ chat: String(body.chat_id), text: String(body.text ?? '') });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1 } } }), { status: 200 });
  });
});

afterEach(async () => {
  for (const chat of chats.splice(0)) endIntake(chat);
  if (madeRequests.length > 0) {
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(), completedVia: 'lines' })
      .where(and(inArray(calcRequests.id, madeRequests), sql`${calcRequests.completedAt} IS NULL`));
  }
  vi.mocked(enqueue).mockClear();
  vi.mocked(queueCalcPrefill).mockClear();
  vi.mocked(announceNote).mockClear();
  vi.mocked(loadIntake).mockClear();
  sent.length = 0;
  failSends = 0;
});

afterAll(async () => {
  __setTelegramTransport(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  await db.delete(notifications).where(eq(notifications.userId, sellerId));
  if (madeRequests.length > 0) {
    await db.delete(calcAmendments).where(inArray(calcAmendments.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.execute(sql`DELETE FROM crm_activities WHERE calc_request_id IN (${sql.join(
      madeRequests.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const ids = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (ids.length > 0) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(tasks).where(inArray(tasks.id, ids));
    }
  }
  if (madeDeals.length > 0) await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeDeals));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, sellerId));
  await pgClient.end();
});

/** A landed request and an add collection on it, as the door opens it. */
async function addCollection(): Promise<{ chatId: bigint; requestId: string; itemId: string }> {
  const [deal] = await db
    .insert(deals)
    .values({ code: `AJ-${SUFFIX}-${madeDeals.length}`, clientId, stageId: openDealStage, title: 'Job', createdBy: sellerId })
    .returning();
  madeDeals.push(deal!.id);
  const r = await openCalcRequest(
    { entityType: 'deal', entityId: deal!.id, section: 'rastamojka', items: [{ name: `Sumka ${SUFFIX}`, quantity: 10 }], source: 'card' },
    { actorId: sellerId },
  );
  madeRequests.push(r.id);
  const stored = (await storedRequestFacts(r.id))!;
  const chatId = nextChat();
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { ai: true, staffId: sellerId, amend: stored.base });
  updateIntake(chatId, {
    stage: 'review',
    facts: stored.facts,
    standingAtOpen: 'open',
    lineAnswers: [{ index: 0, name: `Sumka ${SUFFIX}`, patch: { quantity: 50 }, itemId: stored.base.items[0]!.itemId }],
    material: ['packing list'],
    fileCount: 1,
  });
  return { chatId, requestId: r.id, itemId: stored.base.items[0]!.itemId };
}

/** «✅ Qo‘shish», and the job it enqueued. */
async function press(chatId: bigint): Promise<AmendSaveJob> {
  // The landing's own jobs (the VED's task ping) are not the press's.
  vi.mocked(enqueue).mockClear();
  const replies: string[] = [];
  await saveAmendment({ reply: async (text) => (replies.push(text), { message_id: 7 }) }, chatId, activeIntake(chatId)!);
  expect(replies).toEqual([SAVE_WORDS.saving]);
  const calls = vi.mocked(enqueue).mock.calls.filter(([queue]) => queue === 'calc.amend-save');
  expect(calls).toHaveLength(1);
  const [queue, data, options] = calls[0]!;
  expect(queue).toBe('calc.amend-save');
  expect(options).toMatchObject({ expireInSeconds: 120, retryLimit: 3 });
  expect(options).not.toHaveProperty('singletonKey');
  vi.mocked(enqueue).mockClear();
  return data as AmendSaveJob;
}

const cardNotes = (requestId: string) =>
  db.execute<{ id: string }>(sql`
    SELECT a.id::text AS id FROM crm_activities a JOIN calc_requests r ON r.id = ${requestId}::uuid
     WHERE a.entity_id = r.entity_id AND a.calc_request_id IS NULL
  `);

const outcomeWords = (chatId: bigint) => sent.filter((s) => s.chat === chatId.toString() && s.text.startsWith('✅ So‘rovga qo‘shildi'));

describe('the press and the job', () => {
  it('the press freezes the collection and enqueues ONE job; the job says the outcome once and ends it', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    expect(activeIntake(c.chatId)!.saving).toMatchObject({ token: job.savingToken });
    expect(job.submission!.rowAnswers).toEqual([{ itemId: c.itemId, patch: { quantity: 50 } }]);
    await runAmendSave(job, 0);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
    const [row] = await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, job.noteId));
    expect(row!.outcome).toBe('applied');
    expect(row!.outcomeSentAt).not.toBeNull();
    expect(activeIntake(c.chatId)).toBeNull();
  });

  it('two enqueues of one note → ONE row, ONE card note, ONE reply; the second answers `duplicate`', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    await runAmendSave(job, 0);
    await runAmendSave({ ...job }, 0);
    expect(await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, job.noteId))).toHaveLength(1);
    expect(await cardNotes(c.requestId)).toHaveLength(1);
    expect(sent.filter((s) => s.chat === c.chatId.toString())).toHaveLength(1);
  });

  it('killed after the commit, before the words → the redelivery says them once; the re-pass and the ping once', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    failSends = 1;
    await expect(runAmendSave(job, 0)).rejects.toThrow('amend words not delivered');
    expect(outcomeWords(c.chatId)).toHaveLength(0);
    // pg-boss redelivers the same job.
    await runAmendSave(job, 1);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
    expect(vi.mocked(queueCalcPrefill)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(announceNote)).toHaveBeenCalledTimes(1);
    expect(activeIntake(c.chatId)).toBeNull();
    // And once more: nothing more is said.
    await runAmendSave(job, 2);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
  });

  it('killed between the commit and the re-pass → the redelivery queues the re-pass, pings and speaks, each once (durability-5)', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    // The process dies after `amendRequest`'s transaction committed: no
    // re-pass reached the queue, no ping, no words.
    vi.mocked(queueCalcPrefill).mockRejectedValueOnce(new Error('killed'));
    await expect(runAmendSave(job, 0)).rejects.toThrow('killed');
    expect(vi.mocked(announceNote)).not.toHaveBeenCalled();
    expect(outcomeWords(c.chatId)).toHaveLength(0);
    const [row] = await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, job.noteId));
    expect(row!.outcome).toBe('applied');
    // pg-boss redelivers the same job: `duplicate`, and the missing effects.
    await runAmendSave(job, 1);
    expect(vi.mocked(queueCalcPrefill)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(queueCalcPrefill).mock.calls[1]![0]).toMatchObject({ pass: `amend:${row!.id}`, atRev: row!.rev });
    expect(vi.mocked(announceNote)).toHaveBeenCalledTimes(1);
    const words = outcomeWords(c.chatId);
    expect(words).toHaveLength(1);
    // The words read the row AFTER the redo: the re-pass it just queued is
    // not reported as refused.
    expect(words[0]!.text).toContain(SAVE_WORDS.aiLine.trim());
    expect(words[0]!.text).not.toContain(SAVE_WORDS.queueRefused.trim());
    expect(activeIntake(c.chatId)).toBeNull();
    // A third delivery: nothing left to do, nothing said.
    await runAmendSave(job, 2);
    expect(vi.mocked(queueCalcPrefill)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(announceNote)).toHaveBeenCalledTimes(1);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
  });

  it('an addition recorded and never told, the collection still frozen → re-enqueued, the words once (durability-4)', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    failSends = 1;
    await runAmendSave(job, 0).catch(() => {});
    // What the hydrate finds: the collection kept, frozen, its amendment untold.
    const kept = activeIntake(c.chatId)!;
    expect(kept.saving).not.toBeNull();
    const [row] = await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, job.noteId));
    expect(row!.outcomeSentAt).toBeNull();
    // P1's hydrate hands it back to the queue with the save job's options.
    expect(await requeueAmendSave(c.chatId, kept)).toBe(true);
    const calls = vi.mocked(enqueue).mock.calls.filter(([queue]) => queue === 'calc.amend-save');
    expect(calls).toHaveLength(1);
    const [, again, options] = calls[0]!;
    expect(again).toMatchObject({ noteId: job.noteId, requestId: c.requestId, amendmentId: null, savingToken: job.savingToken });
    expect(options).toMatchObject({ expireInSeconds: 120, retryLimit: 3 });
    expect((options as { id: string }).id).not.toBe(kept.saving!.jobId);
    expect(activeIntake(c.chatId)!.saving!.jobId).toBe((options as { id: string }).id);
    await runAmendSave(again as AmendSaveJob, 0);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
    expect(activeIntake(c.chatId)).toBeNull();
    expect(await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, job.noteId))).toHaveLength(1);
  });

  it('a text while the save runs → the frozen words, nothing appended', async () => {
    const c = await addCollection();
    await press(c.chatId);
    const before = [...activeIntake(c.chatId)!.material];
    const handlers: { filter: unknown; fn: (ctx: unknown, next: () => Promise<void>) => Promise<void> }[] = [];
    const fake = {
      on: (filter: unknown, fn: (ctx: unknown, next: () => Promise<void>) => Promise<void>) => void handlers.push({ filter, fn }),
      command: () => undefined,
      callbackQuery: () => undefined,
      use: () => undefined,
    };
    registerStaffBot(fake as never);
    const onText = handlers.find((h) => h.filter === 'message:text');
    expect(onText, 're-anchor: the text ladder moved').toBeDefined();
    const replies: string[] = [];
    let passed = false;
    await onText!.fn(
      {
        chat: { id: Number(c.chatId), type: 'private' },
        from: { id: 1 },
        message: { text: 'yana 20 dona', date: Math.floor(Date.now() / 1000), message_id: 501 },
        reply: async (text: string) => (replies.push(text), { message_id: 502 }),
      },
      async () => {
        passed = true;
      },
    );
    expect(replies).toEqual(['⏳ Qo‘shimcha yozilmoqda — natija kelgach yozing.']);
    expect(passed).toBe(false);
    expect(activeIntake(c.chatId)!.material).toEqual(before);
  });

  it('two runs of one save job in one process (the expiry race) → one write, one card note, the words once', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    await Promise.all([runAmendSave(job, 0), runAmendSave({ ...job }, 0)]);
    expect(await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, job.noteId))).toHaveLength(1);
    expect(await cardNotes(c.requestId)).toHaveLength(1);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
  });

  it('a job fetched before this process restored its collections waits; never restored → throws, says nothing', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    vi.mocked(loadIntake).mockImplementationOnce(async () => {
      throw new IntakesNotReady();
    });
    await expect(runAmendSave(job, 0)).rejects.toThrow(IntakesNotReady);
    expect(sent).toEqual([]);
    expect(await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, job.noteId))).toHaveLength(0);
    let restored = false;
    vi.mocked(loadIntake).mockImplementationOnce(async (chat) => {
      await new Promise((r) => setTimeout(r, 50));
      restored = true;
      return activeIntake(chat);
    });
    await runAmendSave(job, 1);
    expect(restored).toBe(true);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
  });

  it('the queue refusing the job lets the collection go and says so', async () => {
    const c = await addCollection();
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('queue down'));
    const replies: string[] = [];
    await saveAmendment({ reply: async (text) => (replies.push(text), { message_id: 7 }) }, c.chatId, activeIntake(c.chatId)!);
    expect(replies).toEqual([SAVE_WORDS.failed]);
    expect(activeIntake(c.chatId)!.saving).toBeNull();
  });

  it('nothing to add → the «Hech narsa o‘zgarmadi» words, the collection kept and let go', async () => {
    const c = await addCollection();
    updateIntake(c.chatId, { lineAnswers: [], material: [], fileCount: 0 });
    const job = await press(c.chatId);
    await runAmendSave(job, 0);
    expect(sent.map((s) => s.text)).toEqual([SAVE_WORDS.empty]);
    expect(activeIntake(c.chatId)).not.toBeNull();
    expect(activeIntake(c.chatId)!.saving).toBeNull();
  });

  it('the last attempt throwing AFTER its commit tells the outcome — never «Qo‘shib bo‘lmadi» about a written addition (adv-4)', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    vi.mocked(queueCalcPrefill).mockRejectedValueOnce(new Error('killed'));
    await expect(runAmendSave(job, 3)).rejects.toThrow('killed');
    expect(sent.map((s) => s.text)).not.toContain(SAVE_WORDS.failed);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
    expect(activeIntake(c.chatId)).toBeNull();
    // The settle redid the missing re-pass before speaking.
    expect(vi.mocked(queueCalcPrefill)).toHaveBeenCalledTimes(2);
  });

  it('the sweep’s release of a dead save asks the RECORD: a committed, untold addition is told and ended (adv-4)', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    failSends = 1;
    await runAmendSave(job, 0).catch(() => {});
    expect(activeIntake(c.chatId)!.saving).not.toBeNull();
    await releaseDeadSave(c.chatId, activeIntake(c.chatId)!);
    expect(sent.map((s) => s.text)).not.toContain(SAVE_WORDS.failed);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
    expect(activeIntake(c.chatId)).toBeNull();
    const [row] = await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, job.noteId));
    expect(row!.outcomeSentAt).not.toBeNull();
  });

  it('the last attempt’s words undelivered: no throw, kept frozen — the sweep tells it once (adv-4, spec-14)', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    failSends = 1;
    await runAmendSave(job, 3);
    expect(activeIntake(c.chatId)!.saving).not.toBeNull();
    expect(sent.map((s) => s.text)).toEqual([]);
    await releaseDeadSave(c.chatId, activeIntake(c.chatId)!);
    expect(outcomeWords(c.chatId)).toHaveLength(1);
    expect(activeIntake(c.chatId)).toBeNull();
  });

  it('a dead save with NO record: let go and told «qayta bosing» — only when it was this note’s collection (adv-4, adv-11)', async () => {
    const c = await addCollection();
    await press(c.chatId);
    const frozen = activeIntake(c.chatId)!;
    await releaseDeadSave(c.chatId, frozen);
    expect(sent.map((s) => s.text)).toEqual([SAVE_WORDS.failed]);
    expect(activeIntake(c.chatId)!.saving).toBeNull();
    // Another collection now holds the chat: the old note's release says nothing at its buttons.
    sent.length = 0;
    endIntake(c.chatId);
    startIntake(c.chatId, 'yolkira', { staffId: sellerId });
    await releaseDeadSave(c.chatId, frozen);
    expect(sent).toEqual([]);
  });

  it('the last attempt failing lets the collection go with «Qo‘shib bo‘lmadi — qayta bosing»', async () => {
    const c = await addCollection();
    const job = await press(c.chatId);
    const broken = { ...job, requestId: 'not-a-uuid' };
    await expect(runAmendSave(broken, 3)).rejects.toThrow();
    expect(sent.map((s) => s.text)).toEqual([SAVE_WORDS.failed]);
    expect(activeIntake(c.chatId)!.saving).toBeNull();
    void randomUUID;
  });
});
