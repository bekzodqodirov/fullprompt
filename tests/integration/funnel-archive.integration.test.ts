import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { leads, tasks, users } from '@/modules/platform/db/schema';
import {
  closedLeadCounts,
  createLead,
  listLeads,
  listStages,
  moveLead,
} from '@/modules/wms/crm/service';
import { peoplePulse, taskPulse, undatedOpen } from '@/modules/platform/tasks/analytics';
import { createTask, completeTask, taskSchema } from '@/modules/platform/tasks/service';

/**
 * Round 47, two of the owner's answers.
 *
 * Item 6 — «lost bo'lganlar va yutuq bo'lganlar juda chalg'itadi, ular nima
 * qilinadi keyinchalik». Nothing is deleted: the board shows a RECENT slice of
 * the finished columns and the header keeps the true total, so a funnel with
 * two hundred closed leads still reads as two hundred while showing twenty.
 *
 * Item 12 — the day, across everybody. What is asserted is the boundary that
 * is easy to get wrong: overdue and due-today are different questions, and a
 * finished task is neither.
 */

const runId = Date.now().toString().slice(-6);
let ownerId: string;
let openStageId: string;
let wonStageId: string;
const madeLeads: string[] = [];
const madeTasks: string[] = [];

beforeAll(async () => {
  const [user] = await db.select().from(users).orderBy(users.createdAt).limit(1);
  ownerId = user!.id;
  const stages = await listStages();
  openStageId = stages.find((s) => s.kind === 'open')!.id;
  wonStageId = stages.find((s) => s.kind === 'won')!.id;
});

afterAll(async () => {
  // Leftovers in an integration file are worse than in Playwright — vitest
  // orders files by a duration cache, so the next reader is unpredictable
  // (#380).
  if (madeTasks.length > 0) await db.delete(tasks).where(inArray(tasks.id, madeTasks));
  if (madeLeads.length > 0) await db.delete(leads).where(inArray(leads.id, madeLeads));
  await pgClient.end();
});

describe('the funnel keeps its finished cards without showing all of them', () => {
  it('caps the closed slice, counts the whole column, and keeps the newest', async () => {
    const ctx = { actorId: ownerId };
    const before = (await closedLeadCounts({}))[wonStageId] ?? 0;

    // Three wins, in a known order.
    const names: string[] = [];
    for (const n of [1, 2, 3]) {
      const name = `Arxiv sinov ${runId}-${n}`;
      names.push(name);
      const lead = await createLead({ name, stageId: openStageId, ownerId }, ctx);
      madeLeads.push(lead.id);
      // `viaConvert`: the archive mechanics are this file's subject, not the
      // win ceremony (round 107 made bare won moves a refusal).
      await moveLead(lead.id, wonStageId, '', ctx, undefined, { viaConvert: true });
    }

    // The column really holds three more than it did.
    expect((await closedLeadCounts({}))[wonStageId]).toBe(before + 3);

    // An OPEN lead created last, so it is the newest row of all. This is what
    // makes the next assertion mean something: the closed slice is ordered
    // newest-first, so a missing kind filter would put this one at the top of
    // it — a live lead sitting in the «won» column's archive.
    const live = await createLead(
      { name: `Ochiq sinov ${runId}`, stageId: openStageId, ownerId },
      ctx,
    );
    madeLeads.push(live.id);

    // The board asks for a slice; it must be the RECENT end of the FINISHED
    // column, not simply the newest rows in the funnel.
    const slice = await listLeads({ closedOnly: true, limit: 2 });
    expect(slice).toHaveLength(2);
    expect(slice.map((row) => row.lead.id)).not.toContain(live.id);
    for (const row of slice) expect(row.stageKind).not.toBe('open');

    // «Keeps the newest» is asserted about THIS test's own three wins, in
    // their own order — not by demanding that they top a two-row window.
    //
    // The closed slice is one FLAT limit ordered by `board_order` across
    // every finished column, and each column is numbered independently
    // (0075: a move goes to the top of ITS column). So a lead another file
    // has just lost legitimately outranks a lead this file has just won, and
    // the old assertion — «my third win is in the newest TWO closed rows» —
    // was really a claim about what every other integration file had done
    // first. That made it hostage to vitest's duration-cache file order
    // (#380): adding tests anywhere could reshuffle the run and turn this
    // red, which is exactly what round 102 did.
    const wide = await listLeads({ closedOnly: true, limit: 200 });
    const mine = wide.filter((row) => names.includes(row.lead.name)).map((row) => row.lead.name);
    expect(mine, 'all three wins are in the archive').toEqual([names[2], names[1], names[0]]);

    // And the kind filter itself, asserted where it can actually be seen.
    // The two-row window above cannot prove it: an open lead only surfaces
    // there if it happens to outrank every other closed row, which is again a
    // claim about the rest of the database. Over the WIDE slice it is a claim
    // about the query — with the filter stripped, `live` is in here and so
    // are hundreds of open leads.
    expect(wide.map((row) => row.lead.id), 'no open lead in the archive').not.toContain(live.id);
    for (const row of wide) expect(row.stageKind).not.toBe('open');

    // The open list is the complement: a won lead is not on it.
    const open = await listLeads({ openOnly: true });
    expect(open.map((row) => row.lead.id)).not.toContain(madeLeads[0]);

    // Which is what the board's «+N» is computed from: total minus shown.
    const shown = slice.filter((row) => row.lead.stageId === wonStageId).length;
    expect((await closedLeadCounts({}))[wonStageId]! - shown).toBeGreaterThan(0);
  });

  it('scopes the count to the owner the board is scoped to', async () => {
    const mine = await closedLeadCounts({ ownerId });
    const everyone = await closedLeadCounts({});
    expect(mine[wonStageId] ?? 0).toBeLessThanOrEqual(everyone[wonStageId] ?? 0);
    // The three above are this user's, so his own count cannot be zero.
    expect(mine[wonStageId] ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe('the day, across everybody', () => {
  it('separates late from due-today, and stops counting a task once it is done', async () => {
    const ctx = { actorId: ownerId };
    const taskCtx = { actorId: ownerId, actor: { id: ownerId, permissions: new Set<string>() } };
    const now = new Date('2026-08-04T09:00:00Z');

    const base = await taskPulse(now);

    // Yesterday — late by any reading of the clock.
    const late = await createTask(
      taskSchema.parse({ title: `Kechikkan ${runId}`, assigneeId: ownerId, dueAt: '2026-08-03' }),
      ctx,
    );
    madeTasks.push(late.id);
    // Later today, local time.
    const today = await createTask(
      taskSchema.parse({ title: `Bugungi ${runId}`, assigneeId: ownerId, dueAt: '2026-08-04' }),
      ctx,
    );
    madeTasks.push(today.id);

    const after = await taskPulse(now);
    expect(after.overdue).toBe(base.overdue + 1);
    expect(after.dueToday).toBe(base.dueToday + 1);
    expect(after.open).toBe(base.open + 2);

    // The person's row says the same thing.
    const people = await peoplePulse(now);
    const mine = people.find((row) => row.userId === ownerId)!;
    expect(mine.overdue).toBeGreaterThanOrEqual(1);
    expect(mine.dueToday).toBeGreaterThanOrEqual(1);

    // Finishing the late one takes it off BOTH counts — a done task is not
    // work, however late it was.
    await completeTask(late.id, 'bajarildi', taskCtx);
    const closed = await taskPulse(now);
    expect(closed.overdue).toBe(base.overdue);
    expect(closed.open).toBe(base.open + 1);
  });

  it('counts open work that nobody dated — the pile no «bugun» can show', async () => {
    const ctx = { actorId: ownerId };
    const before = await undatedOpen();
    const task = await createTask(
      taskSchema.parse({ title: `Muddatsiz ${runId}`, assigneeId: ownerId }),
      ctx,
    );
    madeTasks.push(task.id);
    expect(await undatedOpen()).toBe(before + 1);
    // It is open work, so it is on the open count too — just not on any day.
    const pulse = await taskPulse(new Date('2026-08-04T09:00:00Z'));
    expect(pulse.open).toBeGreaterThan(0);
    await db.delete(tasks).where(eq(tasks.id, task.id));
    expect(await undatedOpen()).toBe(before);
  });
});
