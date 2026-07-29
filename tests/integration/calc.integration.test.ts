import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequests,
  clients,
  dealLines,
  deals,
  leads,
  notifications,
  roles,
  tasks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { completeTask } from '@/modules/platform/tasks/service';
import { createDeal, saveLines } from '@/modules/wms/deals/service';
import { createLead } from '@/modules/wms/crm/service';
import {
  CalcError,
  calcDueMinutes,
  calcReport,
  notifyOverdueCalcs,
  requestCalc,
  vedPeople,
} from '@/modules/wms/calc/service';

/**
 * Hisoblash (round 28): the owner's clock on VED calculations, driven through
 * the REAL services — the request opens a real task, saving the deal's lines
 * stops the clock, closing the task stops a lead's, the sweep flags lateness
 * once, and the report answers «qanchada hisoblab berishyapti».
 */

const STAMP = Date.now();
let requesterId: string;
let vedId: string;
let outsiderId: string;
let clientId: string;
const ctx = () => ({ actorId: requesterId });
const madeRequests: string[] = [];
const madeTasks: string[] = [];
const madeDeals: string[] = [];
const madeLeads: string[] = [];

beforeAll(async () => {
  const staff = await db
    .select({ id: users.id, code: roles.code })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(users.active, true));
  requesterId = staff.find((row) => row.code === 'super_admin')!.id;
  const ved = await vedPeople();
  // Prefer a VED person who is not the requester, so the task notification
  // path (never to yourself) is the real one.
  vedId = (ved.find((person) => person.id !== requesterId) ?? ved[0]!).id;
  const vedIds = new Set(ved.map((person) => person.id));
  outsiderId = staff.find((row) => !vedIds.has(row.id))!.id;
  clientId = (
    await createClient(
      { clientCode: `HC${String(STAMP).slice(-7)}`, name: `Hisob mijoz ${STAMP}`, phones: [] },
      ctx(),
    )
  ).id;
});

afterAll(async () => {
  // FK order: requests point at tasks; lines point at deals.
  if (madeRequests.length) {
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  }
  await db.delete(notifications).where(eq(notifications.type, 'CalcOverdue'));
  if (madeTasks.length) await db.delete(tasks).where(inArray(tasks.id, madeTasks));
  for (const id of madeDeals) {
    await db.delete(dealLines).where(eq(dealLines.dealId, id));
    await db.delete(deals).where(eq(deals.id, id));
  }
  if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

async function requestFor(entityType: 'deal' | 'lead', entityId: string, items = 1) {
  const id = await requestCalc(
    { entityType, entityId, assigneeId: vedId, itemCount: items },
    ctx(),
  );
  madeRequests.push(id);
  const row = (await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) }))!;
  madeTasks.push(row.taskId);
  return row;
}

describe("the owner's scale sets the deadline", () => {
  it('30 minutes a line, two hours at most — his words as numbers', () => {
    expect(calcDueMinutes(1)).toBe(30);
    expect(calcDueMinutes(2)).toBe(60);
    expect(calcDueMinutes(3)).toBe(90);
    expect(calcDueMinutes(4)).toBe(120);
    expect(calcDueMinutes(10)).toBe(120);
  });
});

describe('a request is a real task with a real clock', () => {
  let dealId: string;

  it('opens a TIMED task on the VED person, due by the scale', async () => {
    dealId = await createDeal({ clientId, title: `Hisob ${STAMP}` }, ctx());
    madeDeals.push(dealId);
    const before = Date.now();
    const request = await requestFor('deal', dealId, 1);
    const task = (await db.query.tasks.findFirst({ where: eq(tasks.id, request.taskId) }))!;
    expect(task.assigneeId).toBe(vedId);
    expect(task.allDay).toBe(false);
    expect(task.priority).toBe(1);
    const minutes = (task.dueAt!.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThan(32);
  });

  it('one card, one open request — the second ask is refused', async () => {
    await expect(
      requestCalc({ entityType: 'deal', entityId: dealId, assigneeId: vedId, itemCount: 1 }, ctx()),
    ).rejects.toThrow('already_open');
  });

  it('a clock cannot be started on somebody who cannot stop it', async () => {
    const otherDeal = await createDeal({ clientId, title: `Hisob-x ${STAMP}` }, ctx());
    madeDeals.push(otherDeal);
    await expect(
      requestCalc(
        { entityType: 'deal', entityId: otherDeal, assigneeId: outsiderId, itemCount: 1 },
        ctx(),
      ),
    ).rejects.toThrow(CalcError);
  });

  it('SAVING the deal lines stops the clock — the work, not a button', async () => {
    await saveLines(
      dealId,
      [{ description: `Hisob tovar ${STAMP}` }],
      { actorId: vedId, ip: null, userAgent: null },
    );
    const request = (await db.query.calcRequests.findFirst({
      where: and(eq(calcRequests.entityType, 'deal'), eq(calcRequests.entityId, dealId)),
    }))!;
    expect(request.completedAt).not.toBeNull();
    expect(request.completedVia).toBe('lines');
    expect(request.completedBy).toBe(vedId);
    // The task went with it: the assignee never has to close it twice.
    const task = (await db.query.tasks.findFirst({ where: eq(tasks.id, request.taskId) }))!;
    expect(task.status).toBe('done');
  });

  it("closing the task stops a LEAD's clock — the only end a lead has", async () => {
    const lead = await createLead({ name: `Hisob lid ${STAMP}` }, ctx());
    madeLeads.push(lead.id);
    const request = await requestFor('lead', lead.id, 2);
    await completeTask(request.taskId, 'hisoblandi', {
      actorId: vedId,
      ip: null,
      userAgent: null,
      actor: { id: vedId, permissions: new Set<string>() },
    });
    const after = (await db.query.calcRequests.findFirst({
      where: eq(calcRequests.id, request.id),
    }))!;
    expect(after.completedAt).not.toBeNull();
    expect(after.completedVia).toBe('task');
  });
});

describe('lateness is announced once, and the report answers the question', () => {
  it('the sweep flags a late calculation exactly once', async () => {
    const dealId = await createDeal({ clientId, title: `Hisob-late ${STAMP}` }, ctx());
    madeDeals.push(dealId);
    const request = await requestFor('deal', dealId, 1);
    await db
      .update(calcRequests)
      .set({ dueAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(calcRequests.id, request.id));

    expect(await notifyOverdueCalcs()).toBe(1);
    const flagged = (await db.query.calcRequests.findFirst({
      where: eq(calcRequests.id, request.id),
    }))!;
    expect(flagged.overdueNotifiedAt).not.toBeNull();
    // The waiting salesperson heard about it; the assignee did not need to —
    // the overdue task is already screaming on their /bugun.
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, 'CalcOverdue'), eq(notifications.userId, requesterId)));
    expect(told.length).toBeGreaterThan(0);
    // Once means once.
    expect(await notifyOverdueCalcs()).toBe(0);
  });

  it('the report counts, times and queues per VED person', async () => {
    const rows = await calcReport(new Date(Date.now() - 3_600_000), new Date());
    const mine = rows.find((row) => row.assigneeId === vedId)!;
    expect(mine).toBeTruthy();
    // Two finished in this file (lines + task), one still open (the late one).
    expect(mine.done).toBeGreaterThanOrEqual(2);
    expect(mine.avgMinutes).not.toBeNull();
    expect(mine.open).toBeGreaterThanOrEqual(1);
    expect(mine.oldestOpenMinutes).not.toBeNull();
  });
});
