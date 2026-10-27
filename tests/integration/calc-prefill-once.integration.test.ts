import 'dotenv/config';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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
import { openCalcRequest } from '@/modules/wms/calc/service';
import { prefillTicket } from '@/modules/wms/calc/prefill';
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
const said = (requestId: string) =>
  db
    .select({ payload: notifications.payload, status: notifications.status })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, actorId),
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
