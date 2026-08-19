import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  crmActivities,
  events,
  leadStages,
  leads,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import {
  addActivity,
  closedLeadCounts,
  createLead,
  listLeads,
  moveLead,
  updateLead,
} from '@/modules/wms/crm/service';

/**
 * Round 71: the filter panel's questions, asked of the service directly.
 *
 * Two rules carry the round. A lead now HOLDS the service price hisoblatish
 * produced (the owner's override of #108: «shu narx yutildimi yo'qmi etapiga
 * o'tadi»), so it must be written, audited once per real change, and
 * filterable. And every new filter must reach the closed COUNTS through the
 * same predicate as the rows (#513) — a board that filters its cards and not
 * its «+N · show all» footer is lying about the year's work.
 */

const SUFFIX = String(Date.now()).slice(-7);
const MARK = `R71-${SUFFIX}`;

let actorId = '';
let openStageId = '';
let closedStageId = '';
const made: string[] = [];

const ctx = () => ({ actorId, ip: null, userAgent: null });

/** Only the rows this file minted — the database is shared with everything. */
const mine = (rows: Awaited<ReturnType<typeof listLeads>>) =>
  rows.filter((row) => made.includes(row.lead.id));

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
  // The WON stage specifically: round 107 made a lead unable to be BORN
  // closed, so the fixture below wins its closed lead through moveLead's
  // internal door — deterministic only against a stage that needs no reason.
  closedStageId = stages.find((row) => row.kind === 'won')!.id;

  // Three quoted leads and an unquoted one; the cheap CLOSED one is what the
  // counts assertion leans on.
  const cheap = await createLead(
    { name: `${MARK} arzon`, stageId: openStageId, quotedAmount: 300, quotedVolumeM3: 2 },
    ctx(),
  );
  const dear = await createLead(
    {
      name: `${MARK} qimmat`,
      stageId: openStageId,
      quotedAmount: 2500,
      quotedWeightKg: 900,
      quotedCurrency: 'USD',
    },
    ctx(),
  );
  // Born OPEN, then won through the service's own internal door: a lead can
  // no longer be created straight into a closed stage (round 107), and this
  // file's subject is the FILTERS, not the win ceremony.
  const closedCheap = await createLead(
    { name: `${MARK} yopiq arzon`, stageId: openStageId, quotedAmount: 200 },
    ctx(),
  );
  await moveLead(closedCheap.id, closedStageId, '', ctx(), undefined, { viaConvert: true });
  const bare = await createLead({ name: `${MARK} narxsiz`, stageId: openStageId }, ctx());
  made.push(cheap.id, dear.id, closedCheap.id, bare.id);

  await addActivity(
    {
      entityType: 'lead',
      entityId: dear.id,
      kind: 'note',
      note: `Mijoz paxta mato so'radi ${SUFFIX}`,
    },
    ctx(),
  );
});

afterAll(async () => {
  await db.delete(crmActivities).where(inArray(crmActivities.entityId, made));
  await db.delete(events).where(inArray(events.entityId, made));
  await db.delete(leads).where(inArray(leads.id, made));
  await pgClient.end();
});

describe('the quote on a lead', () => {
  it('is stored exactly as the database will return it — no phantom diffs', async () => {
    const [row] = await db.select().from(leads).where(eq(leads.id, made[1]!));
    expect(row!.quotedAmount).toBe('2500.00');
    expect(row!.quotedCurrency).toBe('USD');
    expect(row!.quotedWeightKg).toBe('900.000');
  });

  it('a re-save with the same numbers writes NO audit row', async () => {
    // #503's lesson, one table over: "2500" string-compared against the
    // stored "2500.00" would report a change on every save, re-stamp
    // updated_at, and reshuffle the owner's board for nothing.
    const before = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, made[1]!))
      .orderBy(desc(auditLog.createdAt));
    await updateLead(
      made[1]!,
      {
        name: `${MARK} qimmat`,
        stageId: openStageId,
        ownerId: actorId,
        quotedAmount: 2500,
        quotedWeightKg: 900,
        quotedCurrency: 'USD',
      },
      ctx(),
    );
    const after = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, made[1]!))
      .orderBy(desc(auditLog.createdAt));
    expect(after.length).toBe(before.length);
  });

  it('a real price change is audited with the numbers', async () => {
    await updateLead(
      made[0]!,
      { name: `${MARK} arzon`, stageId: openStageId, ownerId: actorId, quotedAmount: 450, quotedVolumeM3: 2 },
      ctx(),
    );
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, made[0]!))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(entry!.after).toMatchObject({ quotedAmount: '450.00' });
    // Back for the range assertions below.
    await updateLead(
      made[0]!,
      { name: `${MARK} arzon`, stageId: openStageId, ownerId: actorId, quotedAmount: 300, quotedVolumeM3: 2 },
      ctx(),
    );
  });
});

describe('what the panel filters by', () => {
  it('a price range keeps the quoted leads inside it and drops the unquoted', async () => {
    const rows = mine(await listLeads({ q: MARK, amountMin: 250, amountMax: 1000 }));
    expect(rows.map((row) => row.lead.name).sort()).toEqual([`${MARK} arzon`]);
  });

  it('kub and kg ranges answer from the quote sizes', async () => {
    const byVol = mine(await listLeads({ q: MARK, volMin: 1 }));
    expect(byVol.map((row) => row.lead.name)).toEqual([`${MARK} arzon`]);
    const byKg = mine(await listLeads({ q: MARK, kgMin: 500, kgMax: 1000 }));
    expect(byKg.map((row) => row.lead.name)).toEqual([`${MARK} qimmat`]);
  });

  it('the lenta search finds a card by what was written on it', async () => {
    const rows = mine(await listLeads({ q: MARK, lenta: `paxta mato so'radi ${SUFFIX}` }));
    expect(rows.map((row) => row.lead.name)).toEqual([`${MARK} qimmat`]);
  });

  it("and by the lead's own note, which renders on the same lenta", async () => {
    await updateLead(
      made[3]!,
      { name: `${MARK} narxsiz`, stageId: openStageId, ownerId: actorId, note: `shisha idish ${SUFFIX}` },
      ctx(),
    );
    const rows = mine(await listLeads({ q: MARK, lenta: `shisha idish ${SUFFIX}` }));
    expect(rows.map((row) => row.lead.name)).toEqual([`${MARK} narxsiz`]);
  });

  it('a date range brackets created_at inclusively', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const none = mine(await listLeads({ q: MARK, createdTo: '2020-01-01' }));
    expect(none).toEqual([]);
    const all = mine(await listLeads({ q: MARK, createdFrom: today, createdTo: today }));
    expect(all.length).toBe(4);
  });
});

describe('the counts hear every new filter', () => {
  it('a price range reaches the closed totals through the same predicate', async () => {
    // The red-proof target: unshare `leadBoardWhere` from `closedLeadCounts`
    // and the closed cheap lead stays in this count while leaving the rows.
    const filtered = await closedLeadCounts({ q: MARK, amountMin: 1000 });
    expect(filtered[closedStageId] ?? 0).toBe(0);
    const within = await closedLeadCounts({ q: MARK, amountMax: 250 });
    expect(within[closedStageId]).toBe(1);
  });
});
