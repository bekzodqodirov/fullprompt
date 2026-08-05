import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  deals,
  events,
  leadStages,
  leads,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { closedLeadCounts, listLeads } from '@/modules/wms/crm/service';
import { closedDealCounts, createDeal, listDeals } from '@/modules/wms/deals/service';

/**
 * The board's filter, and the one thing it must not get wrong.
 *
 * A board's closed columns show a RECENT SLICE and print the true total
 * underneath it («+143 · show all», round 47). So a filter has to reach two
 * queries, not one: filter the cards and not the counts and a column matching
 * two jobs advertises a hundred and forty-three behind them. Both halves share
 * one predicate for exactly that reason, and this file is what says so.
 *
 * The other half is where the filtering happens. It is in SQL, because the
 * open list is capped at 300 rows and the closed one at 20 — filter the
 * fetched array instead and «nothing found» becomes a claim about the newest
 * twenty rather than about the database.
 */

const SUFFIX = String(Date.now()).slice(-7);
const NEEDLE = `Filtr${SUFFIX}`;

let actorId = '';
let openStageId = '';
let closedStageId = '';
let clientId = '';
const leadIds: string[] = [];
const dealIds: string[] = [];

const ctx = () => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  actorId = admins[0]!.id;

  const stages = await db.select().from(leadStages).orderBy(asc(leadStages.sortOrder));
  openStageId = stages.find((row) => row.kind === 'open')!.id;
  closedStageId = stages.find((row) => row.kind !== 'open')!.id;

  // One matching lead in an OPEN column, one matching and one not in a CLOSED
  // one: the closed pair is what makes the counts assertion mean something.
  const rows = await db
    .insert(leads)
    .values([
      { name: `${NEEDLE} ochiq`, stageId: openStageId, ownerId: actorId, createdBy: actorId },
      { name: `${NEEDLE} yopiq`, stageId: closedStageId, ownerId: actorId, createdBy: actorId },
      { name: `Boshqa ${SUFFIX}`, stageId: closedStageId, ownerId: actorId, createdBy: actorId },
      {
        name: `Telefonli ${SUFFIX}`,
        phone: '+998911234567',
        stageId: openStageId,
        ownerId: actorId,
        createdBy: actorId,
      },
      {
        name: `Firmali ${SUFFIX}`,
        company: `${NEEDLE} MCHJ`,
        stageId: openStageId,
        ownerId: actorId,
        createdBy: actorId,
      },
    ])
    .returning();
  leadIds.push(...rows.map((row) => row.id));

  const client = await createClient(
    { name: `Filtr mijoz ${SUFFIX}`, clientCode: `FLT${SUFFIX}` },
    ctx(),
  );
  clientId = client.id;
  dealIds.push(await createDeal({ clientId, title: `${NEEDLE} bitim` }, ctx()));
  dealIds.push(await createDeal({ clientId, title: `Boshqa bitim ${SUFFIX}` }, ctx()));
});

afterAll(async () => {
  await db.delete(events).where(inArray(events.entityId, [...leadIds, ...dealIds]));
  await db.delete(deals).where(inArray(deals.id, dealIds));
  await db.delete(leads).where(inArray(leads.id, leadIds));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe('what the box finds on the lead board', () => {
  it('matches a name', async () => {
    const rows = await listLeads({ q: `${NEEDLE} ochiq` });
    expect(rows.map((row) => row.lead.name)).toEqual([`${NEEDLE} ochiq`]);
  });

  it('matches a company, not only a name', async () => {
    const rows = await listLeads({ q: `${NEEDLE} MCHJ` });
    expect(rows.map((row) => row.lead.name)).toEqual([`Firmali ${SUFFIX}`]);
  });

  it('matches a phone by its last nine digits, as the global search does', async () => {
    const rows = await listLeads({ q: '911234567' });
    expect(rows.some((row) => row.lead.name === `Telefonli ${SUFFIX}`)).toBe(true);
  });

  it('finds nothing when there is nothing, rather than everything', async () => {
    expect(await listLeads({ q: `yo'q-${SUFFIX}` })).toEqual([]);
  });

  it('is ignored when the box is empty or blank', async () => {
    const all = await listLeads({ ownerId: actorId });
    expect((await listLeads({ ownerId: actorId, q: '   ' })).length).toBe(all.length);
  });
});

describe('the counts are filtered by the same question as the cards', () => {
  it('counts only the matching closed leads', async () => {
    // Two closed leads were made, one matching. Unfiltered the column holds
    // both; filtered it must hold one — the number under «+N · show all».
    const unfiltered = await closedLeadCounts(actorId);
    const filtered = await closedLeadCounts(actorId, NEEDLE);
    expect(unfiltered[closedStageId]).toBeGreaterThanOrEqual(2);
    expect(filtered[closedStageId]).toBe(1);
  });

  it('agrees with the rows it is printed beside', async () => {
    // The assertion the whole feature rests on: whatever the closed slice
    // shows, the total must be the same query's answer.
    const shown = await listLeads({ ownerId: actorId, closedOnly: true, q: NEEDLE, limit: 400 });
    const totals = await closedLeadCounts(actorId, NEEDLE);
    const perStage = new Map<string, number>();
    for (const row of shown) {
      perStage.set(row.lead.stageId, (perStage.get(row.lead.stageId) ?? 0) + 1);
    }
    for (const [stageId, total] of Object.entries(totals)) {
      expect(perStage.get(stageId) ?? 0, `stage ${stageId}`).toBe(total);
    }
  });
});

describe('what the box finds on the deal board', () => {
  it('matches a title', async () => {
    const rows = await listDeals({ q: `${NEEDLE} bitim` });
    expect(rows.map((row) => row.title)).toEqual([`${NEEDLE} bitim`]);
  });

  it('matches the CLIENT CODE, which is what people actually type', async () => {
    const rows = await listDeals({ q: `FLT${SUFFIX}` });
    expect(rows.length).toBe(2);
  });

  it('matches the deal code', async () => {
    const [first] = await listDeals({ q: `${NEEDLE} bitim` });
    expect((await listDeals({ q: first!.code })).map((row) => row.id)).toEqual([first!.id]);
  });

  it('counts the closed ones through the same predicate, joins and all', async () => {
    // `closedDealCounts` had no clients join; the shared predicate reaches the
    // client code, so it needed one or it would be a missing-FROM SQL error.
    await expect(closedDealCounts(undefined, `FLT${SUFFIX}`)).resolves.toBeTypeOf('object');
  });
});
