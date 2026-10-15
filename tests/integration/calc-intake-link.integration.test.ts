import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The landing hands the AI pass to pg-boss; this file asks the landing and the
// pass directly, so the queue is stood in for and nothing else is.
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: async () => {},
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  dealLines,
  deals,
  events,
  leads,
  roles,
  tasks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { userPermissions } from '@/modules/platform/rbac/authorize';
import { landingLinkFor } from '@/modules/platform/telegram/staff-bot';
import { mayOpenLead } from '@/modules/wms/crm/lead-door';
import { landIntake } from '@/modules/wms/calc/intake-land';
import { aiPrefill } from '@/modules/wms/calc/prefill';
import type { CalcFacts, CalcSection } from '@/modules/wms/calc/intake';

/**
 * The bot's ✅ after a «Hisoblatish», end to end: the landing decides whose
 * card it is, and the link is chosen for the SENDER (`landingLinkFor` →
 * `calcJobHrefFor`). The old reply printed `/crm/leads/<id>` to everyone — and
 * a stranger's lead is created under its sender, so the VED, who holds no
 * `crm.leads`, was sent a card the CRM bounces him from.
 *
 * People are minted like deal-ved's (`mintPerson`) and DEACTIVATED at the end,
 * never deleted (the audit log's FK, round 112). Cards, requests and their
 * tasks are removed the way calc-intake.integration does.
 */
const S = String(Date.now()).slice(-6);
const APP = (process.env.APP_URL ?? '').replace(/\/$/, '');
let seq = 0;
const madeUsers: string[] = [];
const madeLeads: string[] = [];
const madeClients: string[] = [];

type Person = { id: string; permissions: Set<string> };
const P = {} as Record<'ved' | 'a' | 'b', Person>;

async function mintPerson(label: string, roleCodes: string[]): Promise<Person> {
  seq += 1;
  // The counter at the FRONT: two people minted in one millisecond must not collide (#598).
  const [user] = await db
    .insert(users)
    .values({
      phone: `+99877${String(seq).padStart(2, '0')}${S}`,
      fullName: `Havola ${label} ${S}`,
      passwordHash: 'x',
      locale: 'uz',
    })
    .returning({ id: users.id });
  madeUsers.push(user!.id);
  for (const code of roleCodes) {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code));
    await db.insert(userRoles).values({ userId: user!.id, roleId: role!.id });
  }
  return { id: user!.id, permissions: await userPermissions(user!.id) };
}

function land(
  sender: Person,
  opts: { section: CalcSection; facts: CalcFacts; phone?: string | null; client?: { id: string; clientCode: string; name: string } | null },
) {
  return landIntake({
    noteId: uuidv4(),
    section: opts.section,
    facts: opts.facts,
    steps: [],
    fileCount: 0,
    collectedBy: sender.id,
    collectedByName: 'Bot xodim',
    client: opts.client ?? null,
    leadName: `Havola notanish ${S}`,
    leadPhone: opts.phone ?? null,
  });
}

const road: CalcFacts = { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 80, volumeM3: 1, goods: [] };
const customs: CalcFacts = { weightKg: 120, volumeM3: 2, goods: [{ name: 'Kurtka', quantity: 40 }] };

beforeAll(async () => {
  P.ved = await mintPerson('VED', ['ved_manager']);
  P.a = await mintPerson('A', ['sales_manager']);
  P.b = await mintPerson('B', ['sales_manager']);
});

afterAll(async () => {
  const requests = madeUsers.length
    ? await db
        .select({ id: calcRequests.id, taskId: calcRequests.taskId })
        .from(calcRequests)
        .where(inArray(calcRequests.requestedBy, madeUsers))
    : [];
  const requestIds = requests.map((r) => r.id);
  const taskIds = requests.map((r) => r.taskId).filter((t): t is string => Boolean(t));
  if (requestIds.length) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, requestIds));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, requestIds));
    await db.delete(calcRequests).where(inArray(calcRequests.id, requestIds));
  }
  if (taskIds.length) {
    await db.delete(events).where(inArray(events.entityId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  const dealRows = madeClients.length
    ? await db.select({ id: deals.id }).from(deals).where(inArray(deals.clientId, madeClients))
    : [];
  const dealIds = dealRows.map((d) => d.id);
  if (dealIds.length) {
    await db.delete(events).where(inArray(events.entityId, dealIds));
    await db
      .delete(crmActivities)
      .where(and(eq(crmActivities.entityType, 'deal'), inArray(crmActivities.entityId, dealIds)));
    await db.delete(dealLines).where(inArray(dealLines.dealId, dealIds));
    await db.delete(deals).where(inArray(deals.id, dealIds));
  }
  if (madeClients.length) await db.delete(clients).where(inArray(clients.id, madeClients));
  if (madeLeads.length) {
    await db.delete(events).where(inArray(events.entityId, madeLeads));
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  if (madeUsers.length) {
    await db.delete(userRoles).where(inArray(userRoles.userId, madeUsers));
    await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

describe('L1 — the VED lands a stranger: his own lead, and a link he can open', () => {
  let leadId = '';
  let requestId = '';

  it('the lead is the VED’s, the job is queued, and the ✅ links the calculation', async () => {
    const target = await land(P.ved, { section: 'rastamojka', facts: customs, phone: `+99833${S}01` });
    madeLeads.push(target.id);
    leadId = target.id;
    requestId = target.requestId ?? '';
    expect(target.kind).toBe('lead');
    expect(target.leadOwnerId).toBe(P.ved.id);
    expect(target.queued).toBe(true);
    expect(requestId).not.toBe('');

    expect(await landingLinkFor(P.ved.id, target)).toBe(`${APP}/hisoblash/${requestId}`);
    // …and the link the old reply printed is a door the CRM card bounces him from.
    expect(mayOpenLead({ id: P.ved.id, permissions: P.ved.permissions }, { ownerId: target.leadOwnerId })).toBe(false);
  });

  it('L4 — the AI-VED’s answer to him links the same screen; the lenta’s copy links nothing', async () => {
    expect(requestId).not.toBe('');
    const out = await aiPrefill(requestId, { actorId: null }, { configured: false, replyTo: P.ved.id });
    expect(out.text).toContain(`/hisoblash/${requestId}`);
    expect(out.text).not.toContain('/crm/leads/');
    expect(out.lentaText).not.toContain('/hisoblash/');
    expect(out.lentaText).not.toContain('/crm/leads/');
    // The two renderings are ONE answer — the lenta's copy is the text minus its link.
    expect(out.lentaText.split('\n').length).toBe(out.text.split('\n').length - 1);
    expect(leadId).not.toBe('');
  });
});

describe('L2 — a request that JOINS a colleague’s lead by phone', () => {
  it('the first seller gets his card; the second gets no link line at all', async () => {
    const phone = `+99833${S}02`;
    const first = await land(P.a, { section: 'yolkira', facts: road, phone });
    madeLeads.push(first.id);
    expect(first.leadOwnerId).toBe(P.a.id);
    expect(await landingLinkFor(P.a.id, first)).toBe(`${APP}/crm/leads/${first.id}`);

    const second = await land(P.b, { section: 'yolkira', facts: road, phone });
    expect(second.id).toBe(first.id);
    expect(second.leadOwnerId).toBe(P.a.id);
    expect(await landingLinkFor(P.b.id, second)).toBeNull();
  });
});

describe('L3 — the VED lands a coded client: the deal card admits him', () => {
  it('links /bitimlar/<deal>', async () => {
    const [client] = await db
      .insert(clients)
      .values({ clientCode: `HV${S}`, name: `Havola mijoz ${S}` })
      .returning({ id: clients.id, clientCode: clients.clientCode, name: clients.name });
    madeClients.push(client!.id);
    const target = await land(P.ved, { section: 'yolkira', facts: road, client: client! });
    expect(target.kind).toBe('deal');
    expect(target.leadOwnerId).toBeNull();
    expect(await landingLinkFor(P.ved.id, target)).toBe(`${APP}/bitimlar/${target.id}`);
  });
});
