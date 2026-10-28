import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * ONE machine message per calculation request (docs/SAKKIZ-R2.md §6.8,
 * concurrency-1), through the REAL worker on a stand-in boss.
 *
 * pg-boss re-delivers a job whose process died, and a job past its expiry
 * runs again beside the first. Each run used to speak — a second reply, a
 * second lenta note, a «hisoblay olmadi» after a real answer. The handler is
 * run twice on one job here, the way the queue would run it.
 *
 * The drain's kick is stood in (#530's idiom): the ROWS it would send are
 * what is asserted, and no pg-boss starts inside the test process.
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
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
import { getSetting } from '@/modules/platform/settings/service';
import { openCalcRequest, returnCalcRequest } from '@/modules/wms/calc/service';
import { prefillTicket } from '@/modules/wms/calc/prefill';
import { sayOnce } from '@/modules/wms/calc/say-once';
import {
  JOB_CALC_PREFILL,
  JOB_CALC_TARIFF_REPLY,
  PASS_FAILED,
  registerCalcPrefillWorker,
  type CalcPrefillJob,
} from '@/modules/wms/calc/jobs';
import { AI_REPLY_HEAD, TARIFF_REPLY_HEAD } from '@/modules/wms/calc/reply-heads';

const SUFFIX = String(Date.now()).slice(-6);
let actorId = '';
let clientId = '';
const madeDeals: string[] = [];
const madeRequests: string[] = [];
type Handler = (jobs: { id: string; name: string; data: CalcPrefillJob; retryCount: number }[]) => Promise<void>;
const handlers = new Map<string, Handler>();

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99895${String(Date.now()).slice(-7)}`, fullName: `Once fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  const [client] = await db.insert(clients).values({ clientCode: `ON${SUFFIX}`, name: `Once fixture ${SUFFIX}` }).returning();
  clientId = client!.id;
  // The worker exactly as `boss.ts` registers it — both queues.
  const boss = {
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async (name: string, _opts: unknown, handler: Handler) => {
      handlers.set(name, handler);
      return 'w';
    }),
  };
  await registerCalcPrefillWorker(boss as never);
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.userId, actorId));
  if (madeDeals.length > 0) {
    await db.delete(crmActivities).where(and(eq(crmActivities.entityType, 'deal'), inArray(crmActivities.entityId, madeDeals)));
  }
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const ids = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (ids.length > 0) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(tasks).where(inArray(tasks.id, ids));
    }
  }
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function freshDeal(): Promise<string> {
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `ON-${SUFFIX}-${madeDeals.length}`, clientId, stageId: stage!.id, title: 'Once fixture', createdBy: actorId })
    .returning();
  madeDeals.push(deal!.id);
  return deal!.id;
}

/** The machine's messages for one request — the rows the drain would send. */
const said = (requestId: string, userId = actorId) =>
  db
    .select({ payload: notifications.payload, status: notifications.status, error: notifications.error })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, 'CalcPrefilled'),
        sql`${notifications}.payload->>'requestId' = ${requestId}`,
      ),
    );

/** The machine's notes on a card's lenta. */
const machineNotes = (dealId: string) =>
  db
    .select({ note: crmActivities.note })
    .from(crmActivities)
    .where(and(eq(crmActivities.entityType, 'deal'), eq(crmActivities.entityId, dealId), isNull(crmActivities.createdBy)));

describe('one machine message per request, however often the queue runs the job', () => {
  it('a yolkira job run twice (retry 0, then 1): ONE reply row and ONE lenta note', async () => {
    // The premise: the lenta copy is switched on, or «one note» would be zero.
    expect(await getSetting('ai_calc_reply_lenta')).toBeTruthy();
    const dealId = await freshDeal();
    const r = await openCalcRequest(
      { entityType: 'deal', entityId: dealId, section: 'yolkira', freightZone: 'cn', weightKg: 500, volumeM3: 10, items: [{ name: `Yuk ${SUFFIX}` }], source: 'card' },
      { actorId },
    );
    madeRequests.push(r.id);
    const data: CalcPrefillJob = { requestId: r.id, staffId: actorId, rev: await prefillTicket(r.id), section: 'yolkira' };
    const run = handlers.get(JOB_CALC_TARIFF_REPLY)!;
    await run([{ id: 'j1', name: JOB_CALC_TARIFF_REPLY, data, retryCount: 0 }]);
    await run([{ id: 'j1', name: JOB_CALC_TARIFF_REPLY, data, retryCount: 1 }]);

    const rows = await said(r.id);
    expect(rows).toHaveLength(1);
    expect(String((rows[0]!.payload as { text: string }).text).startsWith(TARIFF_REPLY_HEAD)).toBe(true);
    const notes = await machineNotes(dealId);
    expect(notes.filter((n) => (n.note ?? '').startsWith(TARIFF_REPLY_HEAD))).toHaveLength(1);
  });

  it('a customs job whose first run answered and «died»: the retry sends no «hisoblay olmadi»', async () => {
    const dealId = await freshDeal();
    const r = await openCalcRequest(
      { entityType: 'deal', entityId: dealId, section: 'rastamojka', items: [{ name: `Profil ${SUFFIX}`, tnvedCode: '3916100000', weightKg: 100 }], source: 'card' },
      { actorId },
    );
    madeRequests.push(r.id);
    const queuedAt = await prefillTicket(r.id);
    const data: CalcPrefillJob = { requestId: r.id, staffId: actorId, rev: queuedAt, section: 'rastamojka' };
    const run = handlers.get(JOB_CALC_PREFILL)!;
    await run([{ id: 'j2', name: JOB_CALC_PREFILL, data, retryCount: 0 }]);
    // The premise: the first run's own writes moved the revision, so the
    // re-delivery reads `touched` → `unfinished` → PASS_FAILED.
    expect(await prefillTicket(r.id)).not.toBe(queuedAt);
    await run([{ id: 'j2', name: JOB_CALC_PREFILL, data, retryCount: 1 }]);

    const rows = await said(r.id);
    expect(rows).toHaveLength(1);
    const text = String((rows[0]!.payload as { text: string }).text);
    expect(text.startsWith(AI_REPLY_HEAD)).toBe(true);
    expect(text).not.toBe(PASS_FAILED);
  });
});

describe('overlapping runs — the advisory lock, not the EXISTS alone', () => {
  it('a burst of simultaneous sayOnce calls for one request queues exactly ONE row', async () => {
    // The cases above run the handler one call AFTER another, which READ
    // COMMITTED's «already said?» answers by itself — so deleting the lock
    // left them green (the review's P1-R3). Overlap is what the lock is for:
    // a job past its expiry runs beside the first, and two transactions that
    // each read «nothing said yet» both insert. Measured without the lock:
    // seven rows of eight on one burst in three. So the burst is repeated —
    // each with its own request key, the drain's kick stood in above.
    for (let burst = 0; burst < 20; burst += 1) {
      const requestId = randomUUID();
      const spoke = await Promise.all(
        Array.from({ length: 8 }, (_, k) =>
          sayOnce(requestId, 'landing', { userIds: [actorId], type: 'CalcPrefilled', text: `burst ${burst} run ${k}` }),
        ),
      );
      expect(spoke.filter(Boolean), `burst ${burst}: one run speaks`).toHaveLength(1);
      expect(await said(requestId), `burst ${burst}: one row`).toHaveLength(1);
    }
  });
});

describe('the speaking door and its claim (R2 late pass)', () => {
  /** A hand-back opens the requester's own task — swept here, not left to the next file. */
  const sweepHandBacks = async (dealId: string) => {
    const made = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.entityId, dealId), like(tasks.title, '↩️%')));
    const ids = made.map((t) => t.id);
    if (ids.length > 0) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(tasks).where(inArray(tasks.id, ids));
    }
  };

  it('a reply is not spoken on a request the VED has closed; a stand-down sentence still is (review CONC-1)', async () => {
    const dealId = await freshDeal();
    const r = await openCalcRequest(
      { entityType: 'deal', entityId: dealId, section: 'rastamojka', items: [{ name: `Yopiq ${SUFFIX}` }], source: 'card' },
      { actorId },
    );
    madeRequests.push(r.id);
    try {
      // «Готово» or a hand-back, after the pass's last step and before it speaks.
      await returnCalcRequest(r.id, 'VED qaytardi — test', { actorId });
      const reply = { userIds: [actorId], type: 'CalcPrefilled', text: `${AI_REPLY_HEAD} · yopiq so‘rov` };
      expect(await sayOnce(r.id, 'landing', reply, { whileOpen: true })).toBe(false);
      expect(await said(r.id), 'the reply is not queued').toHaveLength(0);
      // The door refuses the REPLY only: the closed sentence is the one message.
      expect(await sayOnce(r.id, 'landing', { userIds: [actorId], type: 'CalcPrefilled', text: 'yopilgan' })).toBe(true);
      expect(await said(r.id)).toHaveLength(1);
    } finally {
      await sweepHandBacks(dealId);
    }
  });

  it('a requester who can no longer log in still leaves the claim — one machine note however often the job runs (review CONC-4)', async () => {
    const [leaver] = await db
      .insert(users)
      .values({ phone: `+99896${String(Date.now()).slice(-7)}`, fullName: `Once leaver ${SUFFIX}`, passwordHash: 'x' })
      .returning();
    try {
      const dealId = await freshDeal();
      const r = await openCalcRequest(
        { entityType: 'deal', entityId: dealId, section: 'yolkira', freightZone: 'cn', weightKg: 500, volumeM3: 10, items: [{ name: `Ketgan ${SUFFIX}` }], source: 'card' },
        { actorId: leaver!.id },
      );
      madeRequests.push(r.id);
      // The seller leaves after asking; the job runs — and is re-delivered.
      await db.update(users).set({ active: false }).where(eq(users.id, leaver!.id));
      const data: CalcPrefillJob = { requestId: r.id, staffId: leaver!.id, rev: await prefillTicket(r.id), section: 'yolkira' };
      const run = handlers.get(JOB_CALC_TARIFF_REPLY)!;
      await run([{ id: 'j3', name: JOB_CALC_TARIFF_REPLY, data, retryCount: 0 }]);
      await run([{ id: 'j3', name: JOB_CALC_TARIFF_REPLY, data, retryCount: 1 }]);

      const rows = await said(r.id, leaver!.id);
      expect(rows, 'ONE claim row, which the drain never sends').toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'muted', error: 'cannot log in' });
      const notes = await machineNotes(dealId);
      expect(notes.filter((n) => (n.note ?? '').startsWith(TARIFF_REPLY_HEAD)), 'one machine note on the card').toHaveLength(1);
    } finally {
      await db.delete(notifications).where(eq(notifications.userId, leaver!.id));
      await db.update(users).set({ active: false }).where(eq(users.id, leaver!.id));
    }
  });

  it('the claim reads from the day the request was asked, never the seller’s whole history (review perf-5)', async () => {
    const dealId = await freshDeal();
    const r = await openCalcRequest(
      { entityType: 'deal', entityId: dealId, section: 'rastamojka', items: [{ name: `Tarix ${SUFFIX}` }], source: 'card' },
      { actorId },
    );
    madeRequests.push(r.id);
    // A row dated well before the request existed can only be outside the
    // floor — planted to SEE the floor: unbounded, it would read as a claim.
    await db.insert(notifications).values({
      userId: actorId,
      channel: 'telegram',
      type: 'CalcPrefilled',
      payload: { requestId: r.id, text: 'eski' },
      status: 'sent',
      createdAt: new Date(Date.now() - 3 * 86_400_000),
    });
    expect(await sayOnce(r.id, 'landing', { userIds: [actorId], type: 'CalcPrefilled', text: 'yangi' })).toBe(true);
  });
});
