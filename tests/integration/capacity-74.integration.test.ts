import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  events,
  leadStages,
  leads,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import {
  OPEN_PER_STAGE,
  closedLeadCounts,
  createLead,
  listLeads,
  openLeadCounts,
} from '@/modules/wms/crm/service';

/**
 * Round 74: the funnel at the owner's projected volume.
 *
 * The capacity round measured what 100 leads a day does to this board, and
 * the answer was not slowness — it was a screen that lies. One cap of 300
 * shared across every column, sorted by stage order, meant the first stage
 * took all 300 and the rest rendered EMPTY: at 36,000 leads the board said
 * «Yangi 300 · Bog'lanildi 0 · Ma'lumot olindi 0» while each of those held
 * ~4,500. These tests hold the two halves of the fix — a per-column slice,
 * and a header that still tells the truth about what the column holds.
 */

const MARK = `R74-${String(Date.now()).slice(-7)}`;
// Comfortably past the per-column cap, small enough to stay a fast test.
const PER_STAGE_ROWS = OPEN_PER_STAGE + 15;

let actorId = '';
let otherId = '';
let stageA = '';
let stageB = '';
const made: string[] = [];

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
  const everyone = await db.select({ id: users.id }).from(users).limit(5);
  otherId = everyone.find((row) => row.id !== actorId)!.id;

  const open = await db
    .select()
    .from(leadStages)
    .where(eq(leadStages.kind, 'open'))
    .orderBy(asc(leadStages.sortOrder));
  stageA = open[0]!.id;
  stageB = open[1]!.id;

  // Two open columns, each holding more than one column's worth.
  for (const stageId of [stageA, stageB]) {
    for (let i = 0; i < PER_STAGE_ROWS; i++) {
      const lead = await createLead({ name: `${MARK} ${i}`, stageId, ownerId: actorId }, ctx());
      made.push(lead.id);
    }
  }
});

afterAll(async () => {
  await db.delete(events).where(inArray(events.entityId, made));
  await db.delete(leads).where(inArray(leads.id, made));
  await pgClient.end();
});

describe('the open board is capped per COLUMN, not across the board', () => {
  it('gives every column its own slice instead of emptying the later ones', async () => {
    const rows = await listLeads({ q: MARK, openOnly: true });
    const perStage = new Map<string, number>();
    for (const row of rows) {
      perStage.set(row.lead.stageId, (perStage.get(row.lead.stageId) ?? 0) + 1);
    }
    // The red-proof target: with one shared LIMIT the second column is 0.
    expect(perStage.get(stageA)).toBe(OPEN_PER_STAGE);
    expect(perStage.get(stageB)).toBe(OPEN_PER_STAGE);
  });

  it('honours a caller that asks for a different slice', async () => {
    const rows = await listLeads({ q: MARK, openOnly: true, perStage: 5 });
    expect(rows.length).toBe(10);
  });

  it('answers an empty result without asking the second query', async () => {
    // `inArray` with an empty list is a SQL error, so the empty case has to
    // return before it is built — the same guard round 31 needed on values().
    const rows = await listLeads({ q: `${MARK}-nothing-matches`, openOnly: true });
    expect(rows).toEqual([]);
  });
});

describe('the header tells the truth the slice cannot', () => {
  it('counts every open lead the column holds, not the ones on screen', async () => {
    const totals = await openLeadCounts({ q: MARK });
    expect(totals[stageA]).toBe(PER_STAGE_ROWS);
    expect(totals[stageB]).toBe(PER_STAGE_ROWS);
  });

  it('hears the same filters as the rows (#513)', async () => {
    // A filter the counts do not hear turns every column header into a lie.
    const none = await openLeadCounts({ q: `${MARK}-nothing-matches` });
    expect(none[stageA] ?? 0).toBe(0);
    const closed = await closedLeadCounts({ q: MARK });
    expect(closed[stageA] ?? 0).toBe(0);
  });
});

describe('a lead nobody owns is everybody’s', () => {
  it('appears on a seller’s own board, where it used to appear on nobody’s', async () => {
    const orphan = await createLead({ name: `${MARK} egasiz`, stageId: stageA }, ctx());
    made.push(orphan.id);
    // Deliberately unowned — the state the bot, an import and a cleared
    // picker all produce.
    await db.update(leads).set({ ownerId: null }).where(eq(leads.id, orphan.id));

    // The red-proof target: with `eq(ownerId, …)` alone this is empty.
    const seenByOther = await listLeads({ q: `${MARK} egasiz`, ownerId: otherId, openOnly: true });
    expect(seenByOther.map((row) => row.lead.id)).toContain(orphan.id);

    // And the counts follow, because both read one builder.
    const totals = await openLeadCounts({ q: `${MARK} egasiz`, ownerId: otherId });
    expect(totals[stageA]).toBe(1);
  });

  it('still keeps a colleague’s OWNED lead off my board', async () => {
    const theirs = await createLead(
      { name: `${MARK} boshqaniki`, stageId: stageA, ownerId: actorId },
      ctx(),
    );
    made.push(theirs.id);
    const mine = await listLeads({ q: `${MARK} boshqaniki`, ownerId: otherId, openOnly: true });
    expect(mine).toEqual([]);
  });
});
