import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  crmActivities,
  inboundRoutes,
  leadIntakes,
  leads,
  users,
} from '@/modules/platform/db/schema';
import { landInboundLead } from '@/modules/wms/crm/inbound';
import {
  createRoute,
  deleteRoute,
  moveRoute,
  nextInboundOwner,
  RoutingError,
  setRotaMembers,
} from '@/modules/wms/crm/routing';

/**
 * Taqsimot against a real database (round 96): a rule's pool wins over the
 * general rotation, the fairness inside the pool is the rota's own, and a rule
 * whose people have all left falls BACK rather than dropping the lead unowned.
 */

const STAMP = String(Date.now()).slice(-7);
let vipSeller = '';
let vipSpare = '';
let generalSeller = '';
let actorId = '';
const routeIds: string[] = [];
let previouslyFlagged: string[] = [];

// ONE distinguishing character, so the result is exactly 13 chars — a slice
// here once cut the tail off and made every phone THE SAME number, which
// turned this file's arrivals into one joined-then-capped enquiry.
const P = (tail: string) => `+9989${STAMP}${tail}`;

const arrival = (over: Record<string, unknown> = {}) => ({
  channel: 'form' as const,
  sourceKey: 'instagram',
  name: `Routing lid ${STAMP}`,
  phone: P('1'),
  note: 'kichik savol',
  ...over,
});

beforeAll(async () => {
  // A long-lived local database is a different oracle (#653): anybody left
  // flagged by earlier runs would join this file's «general rotation» and
  // break its exact-winner assertions. Snapshot, clear, restore in afterAll.
  const flagged = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.inboundRota, true));
  previouslyFlagged = flagged.map((row) => row.id);
  if (previouslyFlagged.length) {
    await db
      .update(users)
      .set({ inboundRota: false })
      .where(inArray(users.id, previouslyFlagged));
  }

  const mint = async (suffix: string, inRota: boolean) => {
    const [row] = await db
      .insert(users)
      .values({
        phone: `+99894${STAMP.slice(-5)}${suffix}`,
        fullName: `Routing hodim ${suffix} ${STAMP}`,
        passwordHash: 'x',
        active: true,
        inboundRota: inRota,
      })
      .returning({ id: users.id });
    return row!.id;
  };
  vipSeller = await mint('01', false);
  vipSpare = await mint('02', false);
  generalSeller = await mint('03', true);
  const [seeded] = await db.select({ id: users.id }).from(users).limit(1);
  actorId = seeded!.id;
});

afterAll(async () => {
  // A ROUTE is configuration (#183): while it exists it claims every matching
  // arrival the rest of the suite lands. Deleted first, and the flag goes with
  // the users. The general seller's flag must go even if an assertion above
  // failed, or he joins every later rotation.
  if (routeIds.length) await db.delete(inboundRoutes).where(inArray(inboundRoutes.id, routeIds));
  await db.delete(leadIntakes).where(like(leadIntakes.name, `%${STAMP}%`));
  const made = await db.select({ id: leads.id }).from(leads).where(like(leads.name, `%${STAMP}%`));
  for (const row of made) {
    await db.delete(crmActivities).where(eq(crmActivities.entityId, row.id));
  }
  await db.delete(leads).where(like(leads.name, `%${STAMP}%`));
  await db.delete(users).where(like(users.fullName, `Routing hodim %${STAMP}`));
  if (previouslyFlagged.length) {
    await db
      .update(users)
      .set({ inboundRota: true })
      .where(inArray(users.id, previouslyFlagged));
  }
  await pgClient.end();
});

describe('a rule claims its stream', () => {
  it('sends the matching arrival to the rule pool, not to the general rotation', async () => {
    const routeId = await createRoute(
      { sourceKey: 'instagram', keyword: null, userIds: [vipSeller] },
      { actorId, ip: null, userAgent: null },
    );
    routeIds.push(routeId);

    const landed = await landInboundLead(arrival({ name: `Routing oqim ${STAMP}` }));
    expect(landed.outcome).toBe('created');
    const [lead] = await db.select().from(leads).where(eq(leads.id, landed.leadId!));
    // The general seller is ticked and has fewer leads than anybody — without
    // the route he would win. The rule's pool decides instead.
    expect(lead!.ownerId).toBe(vipSeller);

    const [route] = await db.select().from(inboundRoutes).where(eq(inboundRoutes.id, routeId));
    expect(route!.assignedCount).toBe(1);
  });

  it('a non-matching arrival falls through to the general rotation', async () => {
    const landed = await landInboundLead(
      arrival({ sourceKey: 'telegram', phone: P('2'), name: `Routing telegram ${STAMP}` }),
    );
    const [lead] = await db.select().from(leads).where(eq(leads.id, landed.leadId!));
    expect(lead!.ownerId).toBe(generalSeller);
  });

  it('order is meaning: moving a rule up changes who wins', async () => {
    const keywordRoute = await createRoute(
      { sourceKey: null, keyword: 'konteyner', userIds: [vipSpare] },
      { actorId, ip: null, userAgent: null },
    );
    routeIds.push(keywordRoute);

    // Both rules match this arrival; the instagram rule stands first.
    const first = await landInboundLead(
      arrival({ phone: P('3'), name: `Routing tartib A ${STAMP}`, note: 'konteyner kerak' }),
    );
    const [a] = await db.select().from(leads).where(eq(leads.id, first.leadId!));
    expect(a!.ownerId).toBe(vipSeller);

    await moveRoute(keywordRoute, 'up', { actorId, ip: null, userAgent: null });
    const second = await landInboundLead(
      arrival({ phone: P('4'), name: `Routing tartib B ${STAMP}`, note: 'konteyner kerak' }),
    );
    const [b] = await db.select().from(leads).where(eq(leads.id, second.leadId!));
    expect(b!.ownerId).toBe(vipSpare);
  });

  it('a rule whose people have ALL left falls back to the general rotation', async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, vipSeller));
    try {
      const landed = await landInboundLead(
        arrival({ phone: P('5'), name: `Routing fallback ${STAMP}` }),
      );
      const [lead] = await db.select().from(leads).where(eq(leads.id, landed.leadId!));
      // Unowned would mean a VIP stream quietly becoming leads nobody rings.
      expect(lead!.ownerId).toBe(generalSeller);
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, vipSeller));
    }
  });
});

describe('the pool and the rota share one fairness', () => {
  it('inside a pool the fewest-first rule decides, active members only', async () => {
    expect(await nextInboundOwner([vipSpare])).toBe(vipSpare);
    await db.update(users).set({ active: false }).where(eq(users.id, vipSpare));
    try {
      expect(await nextInboundOwner([vipSpare])).toBeNull();
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, vipSpare));
    }
  });

  it('the screen writes the participant set as a whole, and only actives join', async () => {
    await setRotaMembers([vipSeller, generalSeller], { actorId, ip: null, userAgent: null });
    const flagged = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [vipSeller, vipSpare, generalSeller]));
    const rows = await db
      .select({ id: users.id, inRota: users.inboundRota })
      .from(users)
      .where(inArray(users.id, flagged.map((row) => row.id)));
    expect(rows.find((row) => row.id === vipSeller)!.inRota).toBe(true);
    expect(rows.find((row) => row.id === vipSpare)!.inRota).toBe(false);
    expect(rows.find((row) => row.id === generalSeller)!.inRota).toBe(true);

    // Restore this file's baseline: only the general seller stays ticked.
    await setRotaMembers([generalSeller], { actorId, ip: null, userAgent: null });
  });

  it('a rule cannot be saved with nobody in it, and deleting one is final', async () => {
    await expect(
      createRoute({ sourceKey: null, keyword: 'x', userIds: [] }, { actorId, ip: null, userAgent: null }),
    ).rejects.toThrow(RoutingError);

    const doomed = await createRoute(
      { sourceKey: 'google', keyword: null, userIds: [generalSeller] },
      { actorId, ip: null, userAgent: null },
    );
    await deleteRoute(doomed, { actorId, ip: null, userAgent: null });
    const rows = await db.select().from(inboundRoutes).where(eq(inboundRoutes.id, doomed));
    expect(rows).toHaveLength(0);
  });
});

describe('the cleanup is a test (#154, round 57)', () => {
  it('leaves no route and no flagged user behind', async () => {
    if (routeIds.length) {
      await db.delete(inboundRoutes).where(inArray(inboundRoutes.id, routeIds));
      routeIds.length = 0;
    }
    await db
      .update(users)
      .set({ inboundRota: false })
      .where(like(users.fullName, `Routing hodim %${STAMP}`));

    const routes = await db.select().from(inboundRoutes);
    expect(routes.filter((row) => (row.userIds as string[]).includes(vipSeller))).toHaveLength(0);
    const flagged = await db
      .select()
      .from(users)
      .where(like(users.fullName, `Routing hodim %${STAMP}`));
    expect(flagged.every((row) => !row.inboundRota)).toBe(true);
  });
});
