import 'dotenv/config';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The deal actions read a session; this file stands in for it (and for Next's
// cache and the job queue) and for nothing else — batch-reroute's shape: a
// service-level test of a form-fed path proves the service, not the system
// (#531), so the last block presses the actions the buttons call.
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => session.user,
  requestMeta: async () => ({ ip: null, userAgent: 'deal-ved.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: async () => {},
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  dealLines,
  dealStages,
  deals,
  events,
  leads,
  notifications,
  receipts,
  roles,
  tasks,
  userRoles,
  userWarehouses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { actorGrants } from '@/modules/platform/rbac/authorize';
import {
  closedDealCounts,
  linkReceipt,
  listDeals,
  openDealCounts,
} from '@/modules/wms/deals/service';
import { globalSearch } from '@/modules/wms/search/service';
import { mayOpenCalcCard } from '@/modules/wms/calc/card-door';
import { vedFlowCounts } from '@/modules/wms/home/role-flows';
import { landIntake } from '@/modules/wms/calc/intake-land';
import { processPendingEvents, usersWithRoles } from '@/modules/platform/notifications/service';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import {
  bulkMoveDealsAction,
  createDealAction,
  linkReceiptAction,
  moveDealAction,
  saveLinesAction,
  setDiscountAction,
  updateDealAction,
} from '@/app/(protected)/bitimlar/actions';
import { submitCalcAction, threadCalcAnalyzeAction } from '@/app/(protected)/hisoblash/actions';

/**
 * The VED on the deal card — the owner's 17a with G1-G4 a (2026-10-07).
 *
 *   G3 — his board is ONE sentence (`deals/ved-work.ts`): the rows, the true
 *        column totals, his home number, his ⌘K and the calc card door all
 *        answer it, so they cannot disagree (#513).
 *   G2 — a deal the bot mints for a request sent by somebody who cannot work
 *        a deal's terms opens in the client's seller's name, or ownerless.
 *   G1 — linking a prixod stays his, audited under his name.
 *   17a — the terms are refused in the ACTION, not only off the page.
 */

const S = String(Date.now()).slice(-6);
/** When this file started — the window its own queue rows live in. */
const FILE_START = new Date();
let seq = 0;
const madeUsers: string[] = [];
const madeClients: string[] = [];
const madeLeads: string[] = [];

type Person = { id: string; permissions: Set<string>; warehouseScoped: boolean; warehouseIds: string[] };
const P = {} as Record<'ved' | 's' | 's2' | 's3' | 'x' | 'w' | 'admin', Person>;
let warehouseId = '';
let openStageId = '';
let wonStageId = '';

async function mintPerson(
  label: string,
  roleCodes: string[],
  opts: { active?: boolean; warehouseIds?: string[] } = {},
): Promise<Person> {
  seq += 1;
  // The counter at the FRONT: a phone is sliced nowhere, but two people
  // minted in one millisecond must not collide (#598).
  const [user] = await db
    .insert(users)
    .values({
      phone: `+9989${String(seq).padStart(2, '0')}${S}`,
      fullName: `VED bitim ${label} ${S}`,
      passwordHash: 'x',
      locale: 'uz',
      active: opts.active ?? true,
    })
    .returning({ id: users.id });
  madeUsers.push(user!.id);
  for (const code of roleCodes) {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code));
    await db.insert(userRoles).values({ userId: user!.id, roleId: role!.id });
  }
  for (const wh of opts.warehouseIds ?? []) {
    await db.insert(userWarehouses).values({ userId: user!.id, warehouseId: wh });
  }
  const grants = await actorGrants(user!.id);
  return { id: user!.id, ...grants };
}

async function mintClient(suffix: string, salesManagerId: string | null) {
  const code = `VO${S}${suffix}`;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: code, name: `VED bitim mijoz ${suffix} ${S}`, salesManagerId })
    .returning({ id: clients.id, clientCode: clients.clientCode, name: clients.name });
  madeClients.push(row!.id);
  return row!;
}

async function mintDeal(
  clientId: string,
  code: string,
  stageId: string,
  lines: (string | null)[] = [],
  ownerId: string | null = null,
) {
  const [row] = await db
    .insert(deals)
    .values({ code, clientId, stageId, ownerId, createdBy: P.s.id, title: `VED bitim ${code}` })
    .returning({ id: deals.id });
  for (const [i, tnved] of lines.entries()) {
    await db
      .insert(dealLines)
      .values({ dealId: row!.id, seq: i + 1, description: `Tovar ${i + 1}`, tnvedCode: tnved });
  }
  return row!.id;
}

/** A finished request on a deal — it never sits in the company queue. */
async function mintClosedRequest(dealId: string) {
  await db.insert(calcRequests).values({
    entityType: 'deal',
    entityId: dealId,
    requestedBy: P.s.id,
    itemCount: 0,
    dueAt: new Date(),
    completedAt: new Date(),
    completedVia: 'lines',
  });
}

async function signIn(person: Person) {
  const row = (await db.query.users.findFirst({ where: eq(users.id, person.id) }))!;
  session.user = {
    id: row.id,
    phone: row.phone,
    username: row.username,
    fullName: row.fullName,
    locale: row.locale,
    active: true,
    sessionId: '00000000-0000-4000-8000-0000000d1700',
  };
}

beforeAll(async () => {
  const [wh] = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(eq(warehouses.active, true))
    .limit(1);
  warehouseId = wh!.id;
  const stages = await db.select().from(dealStages).where(eq(dealStages.active, true));
  const sorted = [...stages].sort((a, b) => a.sortOrder - b.sortOrder);
  openStageId = sorted.find((s) => s.kind === 'open')!.id;
  wonStageId = sorted.find((s) => s.kind === 'won')!.id;

  P.s = await mintPerson('S', ['sales_manager']);
  P.ved = await mintPerson('VED', ['ved_manager']);
  P.s2 = await mintPerson('S2', ['sales_manager']);
  P.s3 = await mintPerson('S3', ['sales_manager']);
  P.x = await mintPerson('X', ['sales_manager'], { active: false });
  P.w = await mintPerson('W', ['warehouse_operator'], { warehouseIds: [warehouseId] });
  P.admin = await mintPerson('admin', ['admin']);
});

afterAll(async () => {
  session.user = null;
  const dealRows = madeClients.length
    ? await db.select({ id: deals.id }).from(deals).where(inArray(deals.clientId, madeClients))
    : [];
  const dealIds = dealRows.map((d) => d.id);
  // Deepest first. The queue rows this file's landings opened, by window AND
  // by card — `landIntake` mints deals of its own.
  if (dealIds.length) {
    const requests = await db
      .select({ id: calcRequests.id, taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(and(eq(calcRequests.entityType, 'deal'), inArray(calcRequests.entityId, dealIds)));
    const requestIds = requests.map((r) => r.id);
    const taskIds = requests.map((r) => r.taskId).filter((id): id is string => Boolean(id));
    if (requestIds.length) {
      await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, requestIds));
      await db.delete(calcRequests).where(inArray(calcRequests.id, requestIds));
    }
    const boundTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.entityType, 'deal'), inArray(tasks.entityId, dealIds)));
    const allTasks = [...new Set([...taskIds, ...boundTasks.map((t) => t.id)])];
    if (allTasks.length) {
      await db.delete(events).where(inArray(events.entityId, allTasks));
      await db.delete(tasks).where(inArray(tasks.id, allTasks));
    }
    await db.delete(events).where(inArray(events.entityId, dealIds));
    await db
      .delete(crmActivities)
      .where(and(eq(crmActivities.entityType, 'deal'), inArray(crmActivities.entityId, dealIds)));
    await db.delete(receipts).where(inArray(receipts.clientId, madeClients));
    await db.delete(dealLines).where(inArray(dealLines.dealId, dealIds));
    await db.delete(deals).where(inArray(deals.id, dealIds));
  }
  if (madeLeads.length) {
    const requests = await db
      .select({ id: calcRequests.id, taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(and(eq(calcRequests.entityType, 'lead'), inArray(calcRequests.entityId, madeLeads)));
    const requestIds = requests.map((r) => r.id);
    const boundTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.entityType, 'lead'), inArray(tasks.entityId, madeLeads)));
    const leadTasks = [
      ...new Set([...requests.map((r) => r.taskId).filter((id): id is string => Boolean(id)), ...boundTasks.map((t) => t.id)]),
    ];
    if (requestIds.length) {
      await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, requestIds));
      await db.delete(calcRequests).where(inArray(calcRequests.id, requestIds));
    }
    if (leadTasks.length) {
      await db.delete(events).where(inArray(events.entityId, leadTasks));
      await db.delete(tasks).where(inArray(tasks.id, leadTasks));
    }
    await db.delete(events).where(inArray(events.entityId, madeLeads));
    await db
      .delete(crmActivities)
      .where(and(eq(crmActivities.entityType, 'lead'), inArray(crmActivities.entityId, madeLeads)));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  if (madeClients.length) {
    await db.delete(receipts).where(inArray(receipts.clientId, madeClients));
    await db.delete(clients).where(inArray(clients.id, madeClients));
  }
  // Audited people are DEACTIVATED, never deleted (audit_log's FK, round 112).
  if (madeUsers.length) {
    await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  }
  // Nothing this file's senders opened may outlive it in the company queue.
  const left = madeUsers.length
    ? await db
        .select({ id: calcRequests.id })
        .from(calcRequests)
        .where(and(inArray(calcRequests.requestedBy, madeUsers), gte(calcRequests.requestedAt, FILE_START)))
    : [];
  if (left.length) console.warn('[deal-ved] calc requests left behind:', left.length);
  await pgClient.end();
});

// ---------------------------------------------------------------------------

describe('G3 — the VED board is ONE sentence (#513)', () => {
  const ids = {} as Record<'A' | 'A2' | 'B' | 'C' | 'D' | 'E', string>;
  const needle = `VW${S}`;

  beforeAll(async () => {
    const client = await mintClient('P', P.s.id);
    ids.A = await mintDeal(client.id, `${needle}-A`, openStageId, ['8471600000']);
    await mintClosedRequest(ids.A);
    ids.A2 = await mintDeal(client.id, `${needle}-A2`, wonStageId);
    await mintClosedRequest(ids.A2);
    ids.B = await mintDeal(client.id, `${needle}-B`, openStageId, [null, '  ', '8471600000']);
    ids.C = await mintDeal(client.id, `${needle}-C`, openStageId, ['8471600000', '6403120000']);
    ids.D = await mintDeal(client.id, `${needle}-D`, wonStageId, [null]);
    ids.E = await mintDeal(client.id, `${needle}-E`, openStageId);
  });

  it('the rows are {A, A2, B} and only B is TNVED-less', async () => {
    const open = await listDeals({ q: needle, vedWork: true, openOnly: true });
    const closed = await listDeals({ q: needle, vedWork: true, closedOnly: true });
    const rows = [...open, ...closed];
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([ids.A, ids.A2, ids.B]));
    for (const row of rows) expect(row.tnvedMissing, row.code).toBe(row.id === ids.B);
    // A board without the slice is the whole company's (C and E are on it),
    // pays nothing for the chip and reads false everywhere.
    const sellerRows = await listDeals({ q: needle, openOnly: true });
    const sellerIds = new Set(sellerRows.map((r) => r.id));
    for (const id of [ids.A, ids.B, ids.C, ids.E]) expect(sellerIds.has(id), id).toBe(true);
    for (const row of sellerRows) expect(row.tnvedMissing).toBe(false);
  });

  it('the true column totals hear the same sentence', async () => {
    const open = await listDeals({ q: needle, vedWork: true, openOnly: true });
    const closed = await listDeals({ q: needle, vedWork: true, closedOnly: true });
    const perStage = new Map<string, number>();
    for (const row of [...open, ...closed]) perStage.set(row.stageId, (perStage.get(row.stageId) ?? 0) + 1);
    const counts = {
      ...(await openDealCounts({ q: needle, vedWork: true })),
      ...(await closedDealCounts({ q: needle, vedWork: true })),
    };
    expect(counts).toEqual(Object.fromEntries(perStage));
  });

  it('⌘K finds the same slice for the VED, his own for a seller, everything for an admin', async () => {
    const dealHits = async (person: Person) =>
      new Set((await globalSearch(person, needle)).filter((h) => h.kind === 'deal').map((h) => h.id));
    expect(await dealHits(P.ved)).toEqual(new Set([ids.A, ids.A2, ids.B]));
    // S created these rows but OWNS none of them: the seller's rule is the owner.
    expect(await dealHits(P.s)).toEqual(new Set());
    const admin = await dealHits(P.admin);
    for (const id of Object.values(ids)) expect(admin.has(id), id).toBe(true);
  });

  it('the calc card door agrees with the slice’s calc arm', async () => {
    const door = async (id: string) => mayOpenCalcCard(P.ved, { entityType: 'deal', entityId: id });
    expect(await door(ids.A)).toBe(true);
    expect(await door(ids.A2)).toBe(true);
    for (const id of [ids.B, ids.C, ids.D, ids.E]) expect(await door(id), id).toBe(false);
  });
});

describe('the lenta filter on his board asks only the lentas he reads (15a, DEAL17-1)', () => {
  const ids = {} as Record<'calc' | 'hidden' | 'own', string>;
  const needle = `VL${S}`;
  // One word in three places: a calc deal's lenta (his to read), a
  // TNVED-less deal's lenta (not his — no calc request, so ClientFeed
  // refuses him), and a TNVED-less deal's OWN note (the card prints it).
  const word = `yashirin${S}`;

  beforeAll(async () => {
    const client = await mintClient('LF', P.s.id);
    ids.calc = await mintDeal(client.id, `${needle}-K`, openStageId, ['8471600000']);
    await mintClosedRequest(ids.calc);
    ids.hidden = await mintDeal(client.id, `${needle}-H`, openStageId, [null]);
    ids.own = await mintDeal(client.id, `${needle}-O`, openStageId, [null]);
    await db.update(deals).set({ note: `bitim izohi ${word}` }).where(eq(deals.id, ids.own));
    for (const id of [ids.calc, ids.hidden]) {
      await db.insert(crmActivities).values({
        entityType: 'deal',
        entityId: id,
        kind: 'note',
        note: `lenta izohi ${word}`,
        createdBy: P.s.id,
      });
    }
  });

  it('all three are on his board; the word finds only what his cards print', async () => {
    // The premise: the hidden deal IS in his slice, and its lenta is not his.
    const slice = await listDeals({ q: needle, vedWork: true, openOnly: true });
    expect(new Set(slice.map((r) => r.id))).toEqual(new Set([ids.calc, ids.hidden, ids.own]));
    expect(await mayOpenCalcCard(P.ved, { entityType: 'deal', entityId: ids.hidden })).toBe(false);
    expect(await mayOpenCalcCard(P.ved, { entityType: 'deal', entityId: ids.calc })).toBe(true);

    const filters = { q: needle, vedWork: true, lenta: word };
    const rows = [
      ...(await listDeals({ ...filters, openOnly: true })),
      ...(await listDeals({ ...filters, closedOnly: true })),
    ];
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([ids.calc, ids.own]));
    // The column totals are the same question — a count is the oracle.
    expect(await openDealCounts(filters)).toEqual({ [openStageId]: 2 });
    expect(await closedDealCounts(filters)).toEqual({});
  });

  it('a seller’s board, which reads every lenta, still finds all three', async () => {
    const rows = await listDeals({ q: needle, lenta: word, openOnly: true });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([ids.calc, ids.hidden, ids.own]));
    expect(await openDealCounts({ q: needle, lenta: word })).toEqual({ [openStageId]: 3 });
  });
});

describe('the home row counts DEALS on the same sentence', () => {
  it('a deal with two uncoded positions adds ONE', async () => {
    const before = (await vedFlowCounts()).tnvedMissing;
    const client = await mintClient('H', null);
    await mintDeal(client.id, `VH${S}-1`, openStageId, [null, ' ', '8471600000']);
    const after = (await vedFlowCounts()).tnvedMissing;
    // The old LINE count would answer 2 here.
    expect(after - before).toBe(1);
  });
});

describe('G2 — whose deal the bot mints', () => {
  const land = (sender: Person, client: { id: string; clientCode: string; name: string }) =>
    landIntake({
      noteId: uuidv4(),
      section: 'yolkira',
      facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 80, volumeM3: 1, goods: [] },
      steps: [],
      fileCount: 0,
      collectedBy: sender.id,
      collectedByName: 'Bot xodim',
      client,
      leadName: client.clientCode,
      leadPhone: null,
    });
  const ownerOf = async (dealId: string) =>
    (await db.query.deals.findFirst({ where: eq(deals.id, dealId) }))!;

  it('(i) the VED sends, the client has a seller → the seller’s deal; the request stays the VED’s', async () => {
    const client = await mintClient('I', P.s.id);
    const target = await land(P.ved, client);
    expect(target.kind).toBe('deal');
    const deal = await ownerOf(target.id);
    expect(deal.ownerId).toBe(P.s.id);
    expect(deal.createdBy).toBe(P.ved.id);
    const [created] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'deal'), eq(auditLog.entityId, target.id), eq(auditLog.action, 'create')));
    expect(created!.actorId).toBe(P.ved.id);
    const [request] = await db
      .select()
      .from(calcRequests)
      .where(and(eq(calcRequests.entityType, 'deal'), eq(calcRequests.entityId, target.id)));
    expect(request!.requestedBy).toBe(P.ved.id);
  });

  it('(ii) the VED sends, the client has no seller → ownerless (and both alert inputs are empty)', async () => {
    const client = await mintClient('J', null);
    const target = await land(P.ved, client);
    const deal = await ownerOf(target.id);
    expect(deal.ownerId).toBeNull();
    // (viii) the two inputs `buildRecipients` reads for DealDeviation —
    // `payload.ownerId ?? client.salesManagerId` — are both empty, so its
    // alerts fall to admin + super_admin (today's fallback).
    const row = await db.query.clients.findFirst({ where: eq(clients.id, client.id) });
    expect(row!.salesManagerId).toBeNull();
  });

  it('(iii) the VED sends, the client’s seller cannot log in → ownerless', async () => {
    const client = await mintClient('K', P.x.id);
    expect((await ownerOf((await land(P.ved, client)).id)).ownerId).toBeNull();
  });

  it('(iv) a seller sends for a sellerless client → the seller keeps it (as today)', async () => {
    const client = await mintClient('L', null);
    expect((await ownerOf((await land(P.s, client)).id)).ownerId).toBe(P.s.id);
  });

  it('(v) a seller sends for ANOTHER seller’s client → the sender keeps it (as today; Q1)', async () => {
    const client = await mintClient('M', P.s3.id);
    expect((await ownerOf((await land(P.s, client)).id)).ownerId).toBe(P.s.id);
  });

  it('(vi) warehouse staff send → the client’s seller, or nobody', async () => {
    const withSeller = await mintClient('N', P.s.id);
    expect((await ownerOf((await land(P.w, withSeller)).id)).ownerId).toBe(P.s.id);
    const without = await mintClient('Q', null);
    expect((await ownerOf((await land(P.w, without)).id)).ownerId).toBeNull();
  });

  it('(viii) Q7 a — an ownerless bot deal tells no admin, with the calc stage set and the event queue drained', async () => {
    // The landing's one EVENT is the move into «hisoblatish» (DealStageChanged),
    // and it fires only when the owner has picked that stage — so the stage is
    // picked here. CONFIGURATION, put back in `finally` (#183).
    const prior = await getSetting('deal_calc_stage');
    const opens = (await db.select().from(dealStages).where(and(eq(dealStages.active, true), eq(dealStages.kind, 'open'))))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const calcStage = opens[1]!;
    await setSetting('deal_calc_stage', calcStage.id, null);
    try {
      const [{ now }] = (await db.execute<{ now: string }>(sql`SELECT now()::text AS now`)) as unknown as [{ now: string }];
      const client = await mintClient('Y', null);
      const target = await land(P.ved, client);
      const deal = await ownerOf(target.id);
      expect(deal.ownerId).toBeNull();
      expect(deal.stageId).toBe(calcStage.id);
      const moved = await db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.type, 'DealStageChanged'), sql`${events.payload} ->> 'dealId' = ${target.id}`));
      expect(moved).toHaveLength(1);
      // Drain it the way the per-minute sweep would (the queue is mocked here).
      await processPendingEvents();
      const admins = await usersWithRoles(['admin', 'super_admin']);
      expect(admins).toContain(P.admin.id);
      const told = await db
        .select({ type: notifications.type, userId: notifications.userId })
        .from(notifications)
        .where(
          and(
            inArray(notifications.userId, admins),
            sql`${notifications.createdAt} >= ${now}::timestamptz`,
            sql`(${notifications.payload}::text LIKE ${`%${target.id}%`} OR ${notifications.payload}::text LIKE ${`%${deal.code}%`})`,
          ),
        );
      expect(told).toEqual([]);
    } finally {
      await setSetting('deal_calc_stage', prior, null);
    }
  });

  it('(ix) Q5 a — the VED sends for a STRANGER → the lead it opens is the VED’s', async () => {
    seq += 1;
    const target = await landIntake({
      noteId: uuidv4(),
      section: 'yolkira',
      facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 80, volumeM3: 1, goods: [] },
      steps: [],
      fileCount: 0,
      collectedBy: P.ved.id,
      collectedByName: 'Bot VED',
      client: null,
      leadName: `VED notanish ${S}`,
      leadPhone: `+99897${String(seq).padStart(2, '0')}${S}`,
    });
    madeLeads.push(target.id);
    expect(target.kind).toBe('lead');
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, target.id) });
    expect(lead!.ownerId).toBe(P.ved.id);
    expect(lead!.createdBy).toBe(P.ved.id);
  });

  it('(vii) an existing open deal is reused with its owner untouched', async () => {
    const client = await mintClient('R', P.s.id);
    const existing = await mintDeal(client.id, `VR${S}-1`, openStageId, [], P.s2.id);
    const target = await land(P.ved, client);
    expect(target.id).toBe(existing);
    expect((await ownerOf(existing)).ownerId).toBe(P.s2.id);
  });
});

describe('G1 — linking a prixod is the VED’s, audited under his name', () => {
  it('link then detach: two receipt audit rows carrying his id', async () => {
    const client = await mintClient('T', P.s.id);
    const dealId = await mintDeal(client.id, `VT${S}-1`, openStageId, [null]);
    const [receipt] = await db
      .insert(receipts)
      .values({
        number: `VT${S}-R`,
        warehouseId,
        clientId: client.id,
        status: 'confirmed',
        createdBy: P.s.id,
        confirmedAt: new Date(),
      })
      .returning({ id: receipts.id });
    const r = receipt!.id;
    await linkReceipt(r, dealId, { actorId: P.ved.id });
    await linkReceipt(r, null, { actorId: P.ved.id });
    const trail = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, r)))
      .orderBy(auditLog.createdAt, auditLog.id);
    expect(trail).toHaveLength(2);
    for (const row of trail) expect(row.actorId).toBe(P.ved.id);
    const linked = trail.find((row) => (row.after as { deal: string | null }).deal === dealId);
    const detached = trail.find((row) => (row.after as { deal: string | null }).deal === null);
    expect(linked).toBeDefined();
    expect(detached).toBeDefined();
  });
});

describe('17a — the actions refuse the terms and keep the work', () => {
  it('as the VED: every terms action says deal_terms_only and moves nothing', async () => {
    const client = await mintClient('U', P.s.id);
    const dealId = await mintDeal(client.id, `VU${S}-1`, openStageId, [null]);
    await signIn(P.ved);

    expect(await moveDealAction(dealId, wonStageId, '')).toEqual({ error: 'deal_terms_only' });
    expect(await bulkMoveDealsAction([dealId], wonStageId, '')).toEqual({ error: 'deal_terms_only' });
    const discount = new FormData();
    discount.set('amount', '10');
    discount.set('reason', 'zarar');
    expect(await setDiscountAction(dealId, {}, discount)).toEqual({ error: 'deal_terms_only' });
    const edit = new FormData();
    edit.set('clientId', client.id);
    edit.set('title', 'VED o‘zgartirdi');
    expect(await updateDealAction(dealId, {}, edit)).toEqual({ error: 'deal_terms_only' });
    const create = new FormData();
    create.set('clientId', client.id);
    expect(await createDealAction({}, create)).toEqual({ error: 'deal_terms_only' });

    const after = (await db.query.deals.findFirst({ where: eq(deals.id, dealId) }))!;
    expect(after.stageId).toBe(openStageId);
    expect(Number(after.discountAmount)).toBe(0);
    expect(after.title).toBe(`VED bitim VU${S}-1`);
  });

  it('as the VED: asking for a calculation on a deal, or from a client chat, is refused', async () => {
    const client = await mintClient('V', P.s.id);
    const dealId = await mintDeal(client.id, `VV${S}-1`, openStageId);
    await signIn(P.ved);
    const refused = await submitCalcAction({
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      fromCity: '',
      toCity: '',
      weightKg: null,
      volumeM3: null,
      goods: [],
      noteId: uuidv4(),
      noteText: '',
      revalidate: `/bitimlar/${dealId}`,
    });
    expect(refused).toEqual({ error: 'deal_terms_only' });
    expect(
      await threadCalcAnalyzeAction({
        entity: { kind: 'client', id: client.id },
        section: 'rastamojka',
        messageIds: [uuidv4()],
      }),
    ).toEqual({ error: 'deal_terms_only' });
    expect(
      await threadCalcAnalyzeAction({
        entity: { kind: 'deal', id: dealId },
        section: 'rastamojka',
        messageIds: [uuidv4()],
      }),
    ).toEqual({ error: 'deal_terms_only' });
  });

  it('as the VED: positions and prixod linking go through', async () => {
    const client = await mintClient('W', P.s.id);
    const dealId = await mintDeal(client.id, `VX${S}-1`, openStageId, [null]);
    const [receipt] = await db
      .insert(receipts)
      .values({
        number: `VX${S}-R`,
        warehouseId,
        clientId: client.id,
        status: 'confirmed',
        createdBy: P.s.id,
        confirmedAt: new Date(),
      })
      .returning({ id: receipts.id });
    await signIn(P.ved);
    const lines = new FormData();
    lines.append('lineDescription', 'Klaviatura');
    lines.append('lineTnved', '8471600000');
    expect(await saveLinesAction(dealId, {}, lines)).toEqual({ ok: true });
    const saved = await db.select().from(dealLines).where(eq(dealLines.dealId, dealId));
    expect(saved.map((l) => l.tnvedCode)).toEqual(['8471600000']);

    expect(await linkReceiptAction(receipt!.id, dealId)).toEqual({ ok: true });
    const linked = await db.query.receipts.findFirst({ where: eq(receipts.id, receipt!.id) });
    expect(linked!.dealId).toBe(dealId);
  });

  it('as a seller the same terms action goes through — per person, not per card', async () => {
    const client = await mintClient('X', P.s.id);
    const dealId = await mintDeal(client.id, `VY${S}-1`, openStageId);
    await signIn(P.s);
    expect(await moveDealAction(dealId, wonStageId, '')).toEqual({ ok: true });
    const after = (await db.query.deals.findFirst({ where: eq(deals.id, dealId) }))!;
    expect(after.stageId).toBe(wonStageId);
    session.user = null;
    // The moves' own events, so the shared queue holds nothing of this file's.
    await db.execute(sql`DELETE FROM events WHERE entity_id = ${dealId}::uuid`);
  });
});
