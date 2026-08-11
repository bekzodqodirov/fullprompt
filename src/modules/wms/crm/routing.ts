import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { inboundRoutes, leads, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { INBOUND_SOURCE_KEYS } from './inbound';

/**
 * Taqsimot: which stream of inbound leads lands on whom (round 96).
 *
 * The owner's design, in his words: «bizning firmada hamma sotuvchi, lekin
 * hamma lead bilan ishlamaydi» — so the rotation is made of PEOPLE
 * (`users.inbound_rota`), not roles; and «qaysi lead oqimi bilan kimlar
 * ishlashi» — so an ordered rule list runs first, top-down, FIRST MATCH WINS,
 * and only a lead no rule claims falls back to the general rotation.
 *
 * The decision over a loaded rule list is pure (`matchRoute`) and the fairness
 * inside a pool reuses the rota's own question (`nextInboundOwner` takes the
 * pool) — one counting rule, however the pool was chosen, so a rule cannot be
 * less fair than the queue it overrides.
 */

export interface RouteRow {
  id: string;
  sortOrder: number;
  sourceKey: string | null;
  keyword: string | null;
  userIds: string[];
  active: boolean;
}

export class RoutingError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** The settings audit's well-known id, matching /admin/settings' own. */
const SETTINGS_ENTITY_ID = '00000000-0000-0000-0000-000000000001';

/**
 * The first active rule this arrival satisfies, or null.
 *
 * Both conditions must hold when both are set; a rule with neither is a
 * catch-all, which is legitimate ABOVE the fallback (an explicit «everything
 * else goes to these people»). The keyword is a case-insensitive «contains»
 * over what the person wrote — name and note together, because an advert form
 * may put the telling word in either box.
 */
export function matchRoute(
  routes: RouteRow[],
  arrival: { sourceKey: string; text: (string | null | undefined)[] },
): RouteRow | null {
  const haystack = arrival.text.filter(Boolean).join('\n').toLowerCase();
  for (const route of routes) {
    if (!route.active) continue;
    if (route.userIds.length === 0) continue;
    if (route.sourceKey && route.sourceKey !== arrival.sourceKey) continue;
    if (route.keyword) {
      const needle = route.keyword.trim().toLowerCase();
      if (!needle || !haystack.includes(needle)) continue;
    }
    return route;
  }
  return null;
}

const userIdList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/** Every rule, in the order they are read. */
export async function listRoutes(): Promise<RouteRow[]> {
  const rows = await db
    .select()
    .from(inboundRoutes)
    .orderBy(asc(inboundRoutes.sortOrder), asc(inboundRoutes.createdAt));
  return rows.map((row) => ({
    id: row.id,
    sortOrder: row.sortOrder,
    sourceKey: row.sourceKey,
    keyword: row.keyword,
    userIds: userIdList(row.userIds),
    active: row.active,
  }));
}

/**
 * Whose turn it is, within a pool or in the general rotation.
 *
 * The rota's own rule, unchanged from round 83: fewest inbound leads in the
 * window, longest-since breaks a tie, never-had-one sorts FIRST. With no pool
 * the candidates are the people ticked on the taqsimot screen
 * (`users.inbound_rota`); with a pool they are the rule's members — but always
 * `active = true`, because a deactivated account must not collect calls
 * however it got into a list.
 */
export async function nextInboundOwner(pool?: string[]): Promise<string | null> {
  if (pool && pool.length === 0) return null;
  const since = new Date(Date.now() - 30 * 86_400_000);
  const membership = pool ? inArray(users.id, pool) : eq(users.inboundRota, true);
  const rows = await db
    .select({
      id: users.id,
      n: sql<number>`count(${leads.id})`,
      last: sql<Date | null>`max(${leads.inboundAt})`,
    })
    .from(users)
    .leftJoin(
      leads,
      and(eq(leads.ownerId, users.id), isNotNull(leads.inboundAt), gt(leads.inboundAt, since)),
    )
    .where(and(eq(users.active, true), membership))
    .groupBy(users.id)
    // NULLS FIRST is the whole point: a seller with no inbound lead yet is at
    // the front of the queue, not sorted arbitrarily among the rest.
    .orderBy(sql`count(${leads.id}) asc, max(${leads.inboundAt}) asc nulls first`)
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Route one arrival: match a rule, pick within its members, fall back.
 *
 * The fallback when a matched rule's members are ALL deactivated is the
 * general rotation, not «unowned» — a rule whose people have left must not
 * quietly turn its stream into leads nobody rings.
 */
export async function routeInboundOwner(arrival: {
  sourceKey: string;
  text: (string | null | undefined)[];
}): Promise<{ ownerId: string | null; routeId: string | null }> {
  const route = matchRoute(await listRoutes(), arrival);
  if (route) {
    const ownerId = await nextInboundOwner(route.userIds);
    if (ownerId) {
      await db
        .update(inboundRoutes)
        .set({ assignedCount: sql`${inboundRoutes.assignedCount} + 1` })
        .where(eq(inboundRoutes.id, route.id));
      return { ownerId, routeId: route.id };
    }
  }
  return { ownerId: await nextInboundOwner(), routeId: null };
}

/** The people on the taqsimot screen: every active user, ticked or not. */
export async function rotaMembers() {
  return db
    .select({ id: users.id, fullName: users.fullName, inRota: users.inboundRota })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(desc(users.inboundRota), asc(users.fullName));
}

/**
 * Replace the participant set. Replace-all on purpose — the screen shows every
 * active user with a checkbox, so the posted set IS the whole answer (#171:
 * none of the boxes is ever disabled).
 */
export async function setRotaMembers(userIds: string[], ctx: AuditContext): Promise<void> {
  const before = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.active, true), eq(users.inboundRota, true)));
  const wanted = new Set(userIds);
  const had = new Set(before.map((row) => row.id));
  const add = userIds.filter((id) => !had.has(id));
  const remove = [...had].filter((id) => !wanted.has(id));
  if (add.length) {
    await db
      .update(users)
      .set({ inboundRota: true })
      .where(and(inArray(users.id, add), eq(users.active, true)));
  }
  if (remove.length) {
    await db.update(users).set({ inboundRota: false }).where(inArray(users.id, remove));
  }
  if (add.length || remove.length) {
    await writeAudit(db, ctx, {
      entityType: 'settings',
      // The settings screen's own well-known id — membership is one company
      // setting, not a change to any single user's record.
      entityId: SETTINGS_ENTITY_ID,
      action: 'update',
      after: { inboundRota: { added: add.length, removed: remove.length } },
    });
  }
}

/** A new rule, appended at the end of the reading order. */
export async function createRoute(
  input: { sourceKey: string | null; keyword: string | null; userIds: string[] },
  ctx: AuditContext,
): Promise<string> {
  const sourceKey =
    input.sourceKey && (INBOUND_SOURCE_KEYS as readonly string[]).includes(input.sourceKey)
      ? input.sourceKey
      : null;
  const keyword = input.keyword?.trim().slice(0, 120) || null;
  if (input.userIds.length === 0) throw new RoutingError('members_required');
  // Members validated against the users table: a picker's bad value is a
  // forged post, and a jsonb list has no FK to refuse it unreadably later.
  const members = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, input.userIds), eq(users.active, true)));
  if (members.length === 0) throw new RoutingError('members_required');

  const [last] = await db
    .select({ max: sql<number>`coalesce(max(${inboundRoutes.sortOrder}), 0)` })
    .from(inboundRoutes);
  const [row] = await db
    .insert(inboundRoutes)
    .values({
      sortOrder: Number(last?.max ?? 0) + 1,
      sourceKey,
      keyword,
      userIds: members.map((m) => m.id),
      createdBy: ctx.actorId ?? null,
    })
    .returning({ id: inboundRoutes.id });
  await writeAudit(db, ctx, {
    entityType: 'inbound_route',
    entityId: row!.id,
    action: 'create',
    after: { sourceKey, keyword, members: members.length },
  });
  return row!.id;
}

export async function setRouteActive(id: string, active: boolean, ctx: AuditContext): Promise<void> {
  const [row] = await db
    .update(inboundRoutes)
    .set({ active })
    .where(eq(inboundRoutes.id, id))
    .returning({ id: inboundRoutes.id });
  if (!row) throw new RoutingError('route_not_found');
  await writeAudit(db, ctx, {
    entityType: 'inbound_route',
    entityId: id,
    action: 'update',
    after: { active },
  });
}

export async function deleteRoute(id: string, ctx: AuditContext): Promise<void> {
  const [row] = await db
    .delete(inboundRoutes)
    .where(eq(inboundRoutes.id, id))
    .returning({ id: inboundRoutes.id });
  if (!row) throw new RoutingError('route_not_found');
  await writeAudit(db, ctx, { entityType: 'inbound_route', entityId: id, action: 'delete' });
}

/**
 * Swap a rule one step up or down. Order IS meaning here (first match wins),
 * so the move is a swap of the two sortOrders in one transaction — a rewrite
 * of the whole column on every click would churn the audit for nothing.
 */
export async function moveRoute(id: string, dir: 'up' | 'down', ctx: AuditContext): Promise<void> {
  const routes = await listRoutes();
  const index = routes.findIndex((route) => route.id === id);
  if (index < 0) throw new RoutingError('route_not_found');
  const other = dir === 'up' ? routes[index - 1] : routes[index + 1];
  if (!other) return;
  const self = routes[index]!;
  await db.transaction(async (tx) => {
    await tx
      .update(inboundRoutes)
      .set({ sortOrder: other.sortOrder })
      .where(eq(inboundRoutes.id, self.id));
    await tx
      .update(inboundRoutes)
      .set({ sortOrder: self.sortOrder })
      .where(eq(inboundRoutes.id, other.id));
  });
  await writeAudit(db, ctx, {
    entityType: 'inbound_route',
    entityId: id,
    action: 'update',
    after: { moved: dir },
  });
}
