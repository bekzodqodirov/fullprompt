import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  aiCalcPasses,
  calcRequestItems,
  calcRequests,
  clients,
  deals,
  dealStages,
  events,
  settings,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { aiCalcBudgetLeft, recordAiPass } from '@/modules/wms/calc/ai-cost';
import { getSetting, setSetting } from '@/modules/platform/settings/service';

/**
 * What the AI VED hodimi costs, and when it stops for the day (0096).
 *
 * A SOFT budget, stated as such: the count is read before a pass and the rows
 * are written after, so two workers draining at once could both cross a cap
 * they are about to reach. The queue has one worker and the cap is 200 a
 * day — the failure mode is a couple of calls over, not a runaway — and an
 * atomic claim would need a lock on the path that must never hold one (#714).
 *
 * The SETTING is global CONFIGURATION, so this file snapshots and restores it
 * (#183, #716's lesson: snapshot once in `beforeAll`, never per test, or the
 * «original» becomes whatever the previous test wrote).
 */
const SUFFIX = String(Date.now()).slice(-6);
let actorId = '';
let clientId = '';
let dealId = '';
let requestId = '';
let originalLimit: unknown = null;

beforeAll(async () => {
  originalLimit = await getSetting('ai_calc_daily_limit');
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99893${String(Date.now()).slice(-7)}`,
      fullName: `AI cost fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `AC${SUFFIX}`, name: `AI cost fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `AC-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'AI cost fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;
  const opened = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      weightKg: 100,
      volumeM3: 2,
      items: [{ name: `kostyum ${SUFFIX}`, quantity: 10 }],
      source: 'card',
    },
    { actorId },
  );
  requestId = opened.id;
});

afterAll(async () => {
  await setSetting('ai_calc_daily_limit', originalLimit as never, actorId);
  await db.delete(aiCalcPasses).where(eq(aiCalcPasses.requestId, requestId));
  await db.delete(calcRequestItems).where(eq(calcRequestItems.requestId, requestId));
  const rows = await db
    .select({ taskId: calcRequests.taskId })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  await db.delete(calcRequests).where(eq(calcRequests.id, requestId));
  const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
  if (taskIds.length > 0) {
    await db.delete(events).where(inArray(events.entityId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  void settings;
  await pgClient.end();
});

describe('the AI pass keeps a bill', () => {
  it('records a row per call, with the tokens it used', async () => {
    await recordAiPass({
      requestId,
      staffId: actorId,
      kind: 'grouping',
      model: 'claude-opus-5',
      inputTokens: 1200,
      outputTokens: 340,
    });
    const [row] = await db
      .select()
      .from(aiCalcPasses)
      .where(eq(aiCalcPasses.requestId, requestId));
    expect(row!.kind).toBe('grouping');
    expect(row!.inputTokens).toBe(1200);
    expect(row!.outputTokens).toBe(340);
  });

  it('never throws — a ledger that cannot be written must not cost the answer', async () => {
    // A request that does not exist violates the FK. The pass it was
    // measuring has already happened and the seller is waiting for it.
    await expect(
      recordAiPass({
        requestId: '00000000-0000-0000-0000-000000000000',
        kind: 'pick',
        model: 'x',
      }),
    ).resolves.toBeUndefined();
  });

  it('the day’s budget counts down and reaches zero', async () => {
    // Counted with the FUNCTION's own predicate — today, not all time — or
    // this asserts about rows another day left behind (#713's rule about
    // claiming on a shared table).
    const [used] = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ai_calc_passes WHERE created_at >= date_trunc('day', now())`,
    );
    await setSetting('ai_calc_daily_limit', Number(used!.n) + 1, actorId);
    expect(await aiCalcBudgetLeft()).toBe(1);

    await recordAiPass({ requestId, staffId: actorId, kind: 'pick', model: 'claude-opus-5' });
    expect(await aiCalcBudgetLeft()).toBe(0);
  });

  it('an unreadable cap stops being a cap, never the feature', async () => {
    // 0 and «not a number» both mean «no limit configured»: a cap nobody can
    // read must not silently switch the machine off for a day.
    await setSetting('ai_calc_daily_limit', 0, actorId);
    expect(await aiCalcBudgetLeft()).toBe(Number.POSITIVE_INFINITY);
  });
});
