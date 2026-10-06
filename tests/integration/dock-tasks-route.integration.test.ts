import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The dock's task list (review access-3): an open calc job's TITLE took the
 * reader to the lead card, and the CRM layout sends a VED without
 * `crm.leads` home from it — the dead door the round removed from the task
 * list, alive on the dock. The route now answers each row's `aboutHref` by
 * the task list's own rule; this asks the ROUTE, with the actor stood in.
 */
const override = vi.hoisted(() => ({ actor: null as null | { id: string; permissions: Set<string> } }));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    getActor: async () => override.actor as Awaited<ReturnType<typeof real.getActor>>,
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequests, leads, leadStages, tasks, users } from '@/modules/platform/db/schema';
import { GET as dockTasks } from '@/app/api/dock/tasks/route';

const STAMP = String(Date.now()).slice(-7);
const people: string[] = [];
let leadId: string;
let requestId: string;
let calcTask: string;

beforeAll(async () => {
  const mint = async (n: number) => {
    const [row] = await db
      .insert(users)
      .values({ phone: `+99894${String(Number(STAMP) + n).padStart(7, '0').slice(-7)}`, fullName: `Dock ${STAMP}-${n}`, passwordHash: 'x', locale: 'uz', active: true })
      .returning({ id: users.id });
    people.push(row!.id);
    return row!.id;
  };
  const seller = await mint(1);
  const ved = await mint(2);
  const [stage] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')).limit(1);
  const [lead] = await db
    .insert(leads)
    .values({ name: `Dock lid ${STAMP}`, stageId: stage!.id, createdBy: seller, ownerId: seller })
    .returning({ id: leads.id });
  leadId = lead!.id;
  const [request] = await db
    .insert(calcRequests)
    .values({ entityType: 'lead', entityId: leadId, requestedBy: seller, itemCount: 1, dueAt: new Date(Date.now() + 3_600_000) })
    .returning({ id: calcRequests.id });
  requestId = request!.id;
  const [task] = await db
    .insert(tasks)
    .values({ title: `Hisoblash ${STAMP}`, assigneeId: ved, createdBy: seller, origin: 'calc', boundId: requestId, entityType: 'lead', entityId: leadId })
    .returning({ id: tasks.id });
  calcTask = task!.id;
  await db.update(calcRequests).set({ taskId: calcTask }).where(eq(calcRequests.id, requestId));
});

afterAll(async () => {
  await db.update(calcRequests).set({ taskId: null }).where(eq(calcRequests.id, requestId));
  await db.delete(tasks).where(eq(tasks.id, calcTask));
  await db.delete(calcRequests).where(eq(calcRequests.id, requestId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.update(users).set({ active: false }).where(inArray(users.id, people));
  await pgClient.end();
});

async function rowFor(permissions: string[]) {
  override.actor = { id: people[1]!, permissions: new Set(permissions) };
  const body = (await (await dockTasks()).json()) as { undated: { id: string; aboutHref: string | null; calc: unknown }[] };
  return body.undated.find((row) => row.id === calcTask)!;
}

describe('the dock links an open calc job’s title by the task list’s own rule (review access-3)', () => {
  it('a VED’s title goes to the JOB, never to the lead card the CRM bounces him from', async () => {
    const row = await rowFor(['ved.docs']);
    expect(row).toMatchObject({ aboutHref: `/hisoblash/${requestId}`, calc: { href: `/hisoblash/${requestId}`, mayOpen: true } });
  });

  it('anybody else keeps the card link, and the job reads as a chip', async () => {
    const row = await rowFor(['crm.leads']);
    expect(row).toMatchObject({ aboutHref: `/crm/leads/${leadId}`, calc: { href: `/hisoblash/${requestId}`, mayOpen: false } });
  });
});
