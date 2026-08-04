import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  leadStages,
  leads,
  partners,
  partnerTypes,
  roles,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { globalSearch, type SearchActor } from '@/modules/wms/search/service';

/**
 * The search's fences, against real rows.
 *
 * The rule this file exists to hold: a search that finds more than the
 * screens do is a back door (`wms/bot/lookup.ts`). Every assertion below is
 * one screen's own rule, asked of the search instead.
 */

const SUFFIX = String(Date.now()).slice(-7);

const ALL = new Set([
  'crm.leads',
  'crm.leads.view_all',
  'clients.manage',
  'finance.view',
  'plans.manage',
]);

let owner = '';
let colleague = '';
let boxCode = '';
let boxWarehouse = '';
let otherWarehouse = '';
let leadName = '';

function actorOf(over: Partial<SearchActor>): SearchActor {
  return {
    id: owner,
    permissions: ALL,
    warehouseScoped: false,
    warehouseIds: [],
    ...over,
  };
}

beforeAll(async () => {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  owner = admins[0]!.id;
  const others = await db.select({ id: users.id }).from(users).limit(5);
  colleague = others.find((row) => row.id !== owner)!.id;

  const placed = await db
    .select({ code: boxes.shortCode, warehouseId: boxes.currentWarehouseId })
    .from(boxes)
    .where(sql`${boxes.currentWarehouseId} IS NOT NULL AND ${boxes.currentBatchId} IS NULL`)
    .limit(1);
  boxCode = placed[0]!.code;
  boxWarehouse = placed[0]!.warehouseId!;

  const houses = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .orderBy(asc(warehouses.code));
  otherWarehouse = houses.find((row) => row.id !== boxWarehouse)!.id;

  // A lead of my own, so the ownership rule has something to hide.
  const [stage] = await db.select().from(leadStages).orderBy(asc(leadStages.sortOrder)).limit(1);
  leadName = `Qidiruv sinov ${SUFFIX}`;
  await db.insert(leads).values({
    name: leadName,
    stageId: stage!.id,
    ownerId: colleague,
    createdBy: owner,
  });

  const [type] = await db.select().from(partnerTypes).limit(1);
  await db.insert(partners).values({
    name: `Qidiruv partner ${SUFFIX}`,
    typeId: type!.id,
    createdBy: owner,
  });
});

afterAll(async () => {
  await db.delete(leads).where(eq(leads.name, leadName));
  await db.delete(partners).where(eq(partners.name, `Qidiruv partner ${SUFFIX}`));
  await pgClient.end();
});

describe('the warehouse fence', () => {
  it('finds a box for somebody who is not warehouse-scoped', async () => {
    const hits = await globalSearch(actorOf({}), boxCode);
    expect(hits.some((hit) => hit.kind === 'box' && hit.code === boxCode)).toBe(true);
  });

  it('finds it for the warehouse it is actually in', async () => {
    const hits = await globalSearch(
      actorOf({ warehouseScoped: true, warehouseIds: [boxWarehouse] }),
      boxCode,
    );
    expect(hits.some((hit) => hit.kind === 'box')).toBe(true);
  });

  it('hides it from another warehouse — the box exists, the search denies it', async () => {
    const hits = await globalSearch(
      actorOf({ warehouseScoped: true, warehouseIds: [otherWarehouse] }),
      boxCode,
    );
    expect(hits.some((hit) => hit.kind === 'box')).toBe(false);
  });

  it('shows nothing to a scoped person with no warehouse at all', async () => {
    // `warehouseScope` cannot express "no filter" for a scoped actor — it
    // matches nothing rather than everything, and that is load-bearing here.
    const hits = await globalSearch(
      actorOf({ warehouseScoped: true, warehouseIds: [] }),
      boxCode,
    );
    expect(hits).toHaveLength(0);
  });
});

describe('the funnel’s own ownership rule', () => {
  it('shows a colleague’s lead to somebody who may see everyone’s', async () => {
    const hits = await globalSearch(actorOf({}), leadName);
    expect(hits.some((hit) => hit.kind === 'lead')).toBe(true);
  });

  it('hides it from somebody who may only see their own', async () => {
    const narrowed = new Set([...ALL].filter((code) => code !== 'crm.leads.view_all'));
    const hits = await globalSearch(actorOf({ permissions: narrowed }), leadName);
    expect(hits.some((hit) => hit.kind === 'lead')).toBe(false);
  });

  it('says nothing about leads at all without the funnel permission', async () => {
    const hits = await globalSearch(actorOf({ permissions: new Set(['clients.manage']) }), leadName);
    expect(hits.some((hit) => hit.kind === 'lead')).toBe(false);
  });
});

describe('counterparties are money', () => {
  it('are found by somebody holding the finance grant', async () => {
    const hits = await globalSearch(actorOf({}), `Qidiruv partner ${SUFFIX}`);
    expect(hits.some((hit) => hit.kind === 'partner')).toBe(true);
  });

  it('do not exist for the warehouse', async () => {
    const hits = await globalSearch(
      actorOf({ permissions: new Set(['scan.load']) }),
      `Qidiruv partner ${SUFFIX}`,
    );
    expect(hits.some((hit) => hit.kind === 'partner')).toBe(false);
  });
});

describe('what a result row may say', () => {
  it('carries no money — a row gets you to a card, it does not answer about it', async () => {
    const hits = await globalSearch(actorOf({}), 'GS');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const keys = Object.keys(hit).sort();
      expect(keys).toEqual(['code', 'href', 'id', 'kind', 'label'].filter((key) => key in hit));
    }
  });

  it('refuses a query too short to mean anything', async () => {
    expect(await globalSearch(actorOf({}), 'G')).toHaveLength(0);
  });
});
