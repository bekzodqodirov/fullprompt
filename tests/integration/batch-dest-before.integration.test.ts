import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The actions read a session; this file stands in for it (and for Next's
// cache) and for nothing else — batch-reroute.integration's shape: a
// service-level test of a form-fed path proves the service, not the system
// (#531), so the last block presses the actions the buttons call.
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => session.user,
  requestMeta: async () => ({ ip: null, userAgent: 'batch-dest-before.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  clients,
  clientTransactions,
  events,
  roles,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  changeDestBeforeDepartureAction,
  setSentToAgentAction,
} from '@/app/(protected)/batches/batch-actions-server';
import {
  changeDestBeforeDeparture,
  DestChangeError,
  formerDestinationsFor,
  rerouteHistory,
  type RerouteActor,
} from '@/modules/wms/batches/reroute';

/**
 * «Qabul skladini o'zgartirish» before departure — his 6a
 * (docs/NARX-VA-RAQAM.md §2.4 + §3.2.8), against real rows and the real
 * service, then through the action the button calls. The warehouses are this
 * file's own fixed codes, RETIRED at the end (audit_log FK); the trucks and
 * the money row are deleted; the audit rows stay (audit_log refuses DELETE).
 */

const STAMP = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `${String(seq++).padStart(2, '0')}${STAMP}`;
const META = { ip: null, userAgent: 'batch-dest-before.integration' };

const W = {} as Record<'org' | 'a' | 'b' | 'cn' | 'off', string>;
const CODES = { org: 'NRDO', a: 'NRDA', b: 'NRDB', cn: 'NRDC', off: 'NRDX' } as const;
let actorId = '';
let ownerId = '';
let clientId = '';
const trucks: string[] = [];
const moneyRows: string[] = [];

const person = (permissions: string[], warehouseIds: string[] = []): RerouteActor => ({
  id: actorId,
  fullName: 'Dest test',
  permissions: new Set(permissions),
  warehouseScoped: warehouseIds.length > 0,
  warehouseIds,
});
const logist = () => person(['plans.manage']);
const managerAtOrigin = () => person(['batches.depart_close'], [W.org]);
const managerElsewhere = () => person(['batches.depart_close'], [W.a]);
const plannerAtOrigin = () => person(['plans.manage'], [W.org]);
const packer = () => person(['scan.load'], [W.org]);

async function truck(
  status: 'forming' | 'loading' | 'in_transit' | 'arrived' | 'unloaded' | 'closed' | 'cancelled',
  dest = W.a,
): Promise<string> {
  const [row] = await db
    .insert(batches)
    .values({
      code: `NRD-${tag()}`,
      originWarehouseId: W.org,
      destWarehouseId: dest,
      status,
      // Everything past loading left, except a cancel before departure.
      departedAt: ['forming', 'loading', 'cancelled'].includes(status) ? null : new Date(),
      createdBy: actorId,
    })
    .returning({ id: batches.id });
  trucks.push(row!.id);
  return row!.id;
}

const destOf = async (id: string) => (await db.query.batches.findFirst({ where: eq(batches.id, id) }))!.destWarehouseId;
const destRows = (id: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, id), sql`${auditLog.after} ? 'destBeforeDeparture'`));

async function refusal(press: Promise<unknown>): Promise<string | null> {
  try {
    await press;
    return null;
  } catch (err) {
    if (err instanceof DestChangeError) return err.code;
    throw err;
  }
}

const change = (who: RerouteActor, id: string, seen: string, to: string) =>
  changeDestBeforeDeparture(who, id, { destWarehouseId: to, seenDestWarehouseId: seen }, META);

async function liveCharge(batchId: string) {
  const [row] = await db
    .insert(clientTransactions)
    .values({
      clientId,
      type: 'charge',
      amount: '10',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '10',
      txDate: '2026-11-08',
      batchId,
      createdBy: actorId,
    })
    .returning({ id: clientTransactions.id });
  moneyRows.push(row!.id);
}

beforeAll(async () => {
  async function ensure(code: string, country: string, type: string, active = true) {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) {
      await db.update(warehouses).set({ active }).where(eq(warehouses.id, existing.id));
      return existing.id;
    }
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `Dest ${code}`, country, type, timezone: 'Asia/Tashkent', batchPrefix: code, active })
      .returning();
    return wh!.id;
  }
  W.org = await ensure(CODES.org, 'CN', 'origin');
  W.a = await ensure(CODES.a, 'UZ', 'customs');
  W.b = await ensure(CODES.b, 'UZ', 'distribution');
  W.cn = await ensure(CODES.cn, 'CN', 'hub');
  W.off = await ensure(CODES.off, 'UZ', 'customs', false);
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  // A super_admin to sign the actions in with (the seed's owner on CI).
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, 'super_admin'), eq(users.active, true), sql`${users.phone} IS NOT NULL`))
    .limit(1);
  ownerId = owner!.id;
  const [c] = await db.insert(clients).values({ clientCode: `NRD${STAMP}`, name: `Dest ${STAMP}` }).returning();
  clientId = c!.id;
});

afterAll(async () => {
  try {
    if (moneyRows.length) await db.delete(clientTransactions).where(inArray(clientTransactions.id, moneyRows));
    if (trucks.length) {
      await db.delete(events).where(inArray(events.entityId, trucks));
      await db.delete(batches).where(inArray(batches.id, trucks));
    }
    if (clientId) await db.delete(clients).where(eq(clients.id, clientId));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.code, Object.values(CODES)));
  } finally {
    await pgClient.end();
  }
});

describe('a truck that has not left takes another receiving warehouse', () => {
  it('forming: the same truck, the new destination, its OWN audit key — no reroute, no «keladi»', async () => {
    const id = await truck('forming');
    const res = await change(logist(), id, W.a, W.b);
    expect(res.to).toEqual({ id: W.b, code: CODES.b });
    expect(res.from).toEqual({ id: W.a, code: CODES.a });
    expect(await destOf(id)).toBe(W.b);
    const rows = await destRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toEqual({ destBeforeDeparture: W.a });
    expect(rows[0]!.after).toEqual({ destBeforeDeparture: W.b });
    // The road reroute's readers never take it for a road reroute (P2-dest-5).
    expect(await rerouteHistory(id)).toEqual([]);
    expect((await formerDestinationsFor([id])).get(id)).toBeUndefined();
    const evs = await db.select().from(events).where(and(eq(events.entityId, id), eq(events.type, 'BatchRerouted')));
    expect(evs).toHaveLength(0);
  });

  it('loading, by the origin’s own warehouse manager (the cancel’s door)', async () => {
    const id = await truck('loading');
    await change(managerAtOrigin(), id, W.a, W.b);
    expect(await destOf(id)).toBe(W.b);
  });

  it('a planner scoped to the origin may too', async () => {
    const id = await truck('forming');
    await change(plannerAtOrigin(), id, W.a, W.b);
    expect(await destOf(id)).toBe(W.b);
  });

  it('on the road it is refused — the road has its own door — and nothing is written', async () => {
    const id = await truck('in_transit');
    expect(await refusal(change(logist(), id, W.a, W.b))).toBe('not_before_departure');
    expect(await destOf(id)).toBe(W.a);
    expect(await destRows(id)).toHaveLength(0);
  });

  it('a stale panel learns what the truck IS — cancelled, or already past the road — never «use the road door» (review D3)', async () => {
    const cancelled = await truck('cancelled');
    expect(await refusal(change(logist(), cancelled, W.a, W.b))).toBe('batch_cancelled');
    for (const status of ['arrived', 'unloaded', 'closed'] as const) {
      const id = await truck(status);
      expect(await refusal(change(logist(), id, W.a, W.b)), status).toBe('already_unloaded');
      expect(await destOf(id)).toBe(W.a);
      expect(await destRows(id)).toHaveLength(0);
    }
    expect(await destOf(cancelled)).toBe(W.a);
    expect(await destRows(cancelled)).toHaveLength(0);
  });
});

describe('what it refuses', () => {
  it('money on the truck: another COUNTRY is refused, the same country is allowed', async () => {
    const id = await truck('forming');
    await liveCharge(id);
    expect(await refusal(change(logist(), id, W.a, W.cn))).toBe('dest_money_country');
    expect(await destOf(id)).toBe(W.a);
    await change(logist(), id, W.a, W.b);
    expect(await destOf(id)).toBe(W.b);
  });

  it('without money another country is fine — nothing stored to re-read', async () => {
    const id = await truck('forming');
    await change(logist(), id, W.a, W.cn);
    expect(await destOf(id)).toBe(W.cn);
  });

  it('papers at the agent: refused until the tick is taken off', async () => {
    const id = await truck('loading');
    await db.update(batches).set({ sentToAgentAt: '2026-11-08' }).where(eq(batches.id, id));
    expect(await refusal(change(logist(), id, W.a, W.b))).toBe('dest_agent_sent');
    expect(await destOf(id)).toBe(W.a);
  });

  it('a stale page (a colleague changed it first) is «dest_changed», never a silent chain', async () => {
    const id = await truck('forming');
    await change(logist(), id, W.a, W.b);
    expect(await refusal(change(logist(), id, W.a, W.cn))).toBe('dest_changed');
    expect(await destOf(id)).toBe(W.b);
  });

  it('the target’s own state', async () => {
    const id = await truck('forming');
    expect(await refusal(change(logist(), id, W.a, W.a))).toBe('same_destination');
    expect(await refusal(change(logist(), id, W.a, W.org))).toBe('destination_is_origin');
    expect(await refusal(change(logist(), id, W.a, W.off))).toBe('target_inactive');
    expect(await refusal(change(logist(), id, W.a, 'garbage'))).toBe('bad_target');
    expect(await refusal(change(logist(), 'garbage', W.a, W.b))).toBe('batch_not_found');
    expect(await destRows(id)).toHaveLength(0);
  });

  it('the door: a manager at another warehouse and a packer are refused, on the locked row', async () => {
    const id = await truck('forming');
    expect(await refusal(change(managerElsewhere(), id, W.a, W.b))).toBe('forbidden');
    expect(await refusal(change(packer(), id, W.a, W.b))).toBe('forbidden');
    expect(await destOf(id)).toBe(W.a);
  });
});

describe('the buttons’ actions', () => {
  async function signIn(userId: string | null) {
    if (!userId) {
      session.user = null;
      return;
    }
    const row = (await db.query.users.findFirst({ where: eq(users.id, userId) }))!;
    session.user = {
      id: row.id,
      phone: row.phone,
      username: row.username,
      fullName: row.fullName,
      locale: row.locale,
      active: true,
      sessionId: '00000000-0000-4000-8000-0000000d0b00',
    };
  }

  it('changeDestBeforeDepartureAction: words for every answer', async () => {
    const id = await truck('forming');
    await signIn(ownerId);
    expect(await changeDestBeforeDepartureAction({ batchId: id, destWarehouseId: W.b, seenDestWarehouseId: W.a })).toEqual({
      ok: true,
      toCode: CODES.b,
    });
    expect(await changeDestBeforeDepartureAction({ batchId: id, destWarehouseId: W.a, seenDestWarehouseId: W.a })).toEqual({
      ok: false,
      error: 'dest_changed',
    });
    expect(await changeDestBeforeDepartureAction({ batchId: 'x' })).toEqual({ ok: false, error: 'validation' });
    await signIn(null);
    expect(await changeDestBeforeDepartureAction({ batchId: id, destWarehouseId: W.a, seenDestWarehouseId: W.b })).toEqual({
      ok: false,
      error: 'unauthenticated',
    });
  });

  it('«agentga yuborildi» is refused on a cancelled truck, under its row lock — a live one still ticks', async () => {
    await signIn(ownerId);
    const live = await truck('forming');
    const gone = await truck('forming');
    await db.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, gone));
    for (const id of [live, gone]) {
      const form = new FormData();
      form.set('batchId', id);
      form.set('want', 'sent');
      // An empty truck's papers stamp to the empty string (`paperStamp`).
      form.set('paperStamp', '');
      await setSentToAgentAction(form);
    }
    const sentAt = async (id: string) => (await db.query.batches.findFirst({ where: eq(batches.id, id) }))!.sentToAgentAt;
    expect(await sentAt(live)).not.toBeNull();
    expect(await sentAt(gone)).toBeNull();
    const ticks = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, gone), sql`${auditLog.after} ? 'sentToAgent'`));
    expect(ticks).toHaveLength(0);
    await signIn(null);
  });
});
