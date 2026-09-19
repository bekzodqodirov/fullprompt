import 'dotenv/config';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { leadStages, leads, notifications, users } from '@/modules/platform/db/schema';
import { dayCalls, STALE_DAYS } from '@/modules/wms/crm/day';
import { updateLead } from '@/modules/wms/crm/service';

/**
 * Whose calls the morning screen shows (owner's item 4).
 *
 * The fixture is his own complaint: two sellers with their own leads, one
 * lead nobody owns, and one of the supervisor's own that has been overdue for
 * a month. Everything here is a LEAD with a follow-up date — the client half
 * of `followUps` follows the identical rule and is covered by its own tests.
 */

const SUFFIX = String(Date.now()).slice(-6);
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
};

let boss: string;
let alisher: string;
let bekzod: string;
let openStage: string;
let nextStage: string;
const made: string[] = [];

async function mintLead(name: string, ownerId: string | null, dueOn: string | null) {
  const [row] = await db
    .insert(leads)
    .values({
      name,
      stageId: openStage,
      ownerId,
      nextActionAt: dueOn,
      nextActionNote: 'walk',
      createdBy: boss,
    })
    .returning({ id: leads.id });
  made.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  /**
   * Named, not positional. An unordered `limit(3)` is #524's shape — the rows
   * come back in whatever order the table hands them over — and the digest
   * half below needs these three to be a SUPERVISOR and two sellers, not
   * three arbitrary people.
   */
  const byPhone = async (phone: string) =>
    (await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)))[0]!.id;
  boss = await byPhone('+998900000001'); // super_admin — sees everything
  alisher = await byPhone('+998900000009'); // sales manager
  bekzod = await byPhone('+998900000003'); // logist, also a digest recipient
  const stages = await db
    .select({ id: leadStages.id, kind: leadStages.kind, sortOrder: leadStages.sortOrder })
    .from(leadStages)
    .where(eq(leadStages.kind, 'open'));
  openStage = stages[0]!.id;
  nextStage = stages[1]?.id ?? stages[0]!.id;

  await mintLead(`Mine bugun ${SUFFIX}`, boss, today);
  await mintLead(`Mine eski ${SUFFIX}`, boss, daysAgo(STALE_DAYS + 3));
  await mintLead(`Egasiz ${SUFFIX}`, null, today);
  await mintLead(`Alisher 1 ${SUFFIX}`, alisher, today);
  await mintLead(`Alisher 2 ${SUFFIX}`, alisher, daysAgo(1));
  await mintLead(`Bekzod 1 ${SUFFIX}`, bekzod, today);
});

afterAll(async () => {
  await db.delete(leads).where(inArray(leads.id, made));
  await db
    .delete(notifications)
    .where(inArray(notifications.id, digestRows));
  await pgClient.end();
});

const digestRows: string[] = [];

const mine = (rows: { title: string }[]) => rows.filter((row) => row.title.includes(SUFFIX));

describe('dayCalls', () => {
  it('gives a supervisor THEIR OWN list, not everybody’s', async () => {
    const calls = await dayCalls({ actorId: boss, seesAll: true, asOf: today });
    const titles = mine(calls.mine).map((row) => row.title);
    // Mine, plus the unclaimed one (round 74: an unowned lead is anybody's).
    expect(titles.sort()).toEqual([`Egasiz ${SUFFIX}`, `Mine bugun ${SUFFIX}`]);
    expect(titles.some((title) => title.startsWith('Alisher'))).toBe(false);
  });

  it('counts the others on the door without opening it', async () => {
    const calls = await dayCalls({ actorId: boss, seesAll: true, asOf: today });
    // The count is the door's promise; the sections are what it opens onto.
    expect(calls.othersCount).toBeGreaterThanOrEqual(3);
    expect(calls.others).toHaveLength(0);
  });

  it('opens into per-seller folds, biggest pile first', async () => {
    const calls = await dayCalls({
      actorId: boss,
      seesAll: true,
      asOf: today,
      includeOthers: true,
    });
    const ours = calls.others.filter((section) =>
      section.rows.some((row) => row.title.includes(SUFFIX)),
    );
    const alisherSection = ours.find((section) => section.ownerId === alisher)!;
    const bekzodSection = ours.find((section) => section.ownerId === bekzod)!;
    expect(mine(alisherSection.rows)).toHaveLength(2);
    expect(mine(bekzodSection.rows)).toHaveLength(1);
    expect(ours.indexOf(alisherSection)).toBeLessThan(ours.indexOf(bekzodSection));
    // Never the unclaimed one: it is in everybody's own list already.
    expect(
      calls.others.flatMap((section) => section.rows).some((row) => row.ownerId === null),
    ).toBe(false);
  });

  it('folds a call older than a week out of today’s work — without losing it', async () => {
    const calls = await dayCalls({ actorId: boss, seesAll: true, asOf: today });
    expect(mine(calls.mine).map((row) => row.title)).not.toContain(`Mine eski ${SUFFIX}`);
    expect(mine(calls.stale).map((row) => row.title)).toEqual([`Mine eski ${SUFFIX}`]);
  });

  it('shows a seller their own and the unclaimed, and no door at all', async () => {
    const calls = await dayCalls({ actorId: alisher, seesAll: false, asOf: today });
    expect(mine(calls.mine).map((row) => row.title).sort()).toEqual([
      `Alisher 1 ${SUFFIX}`,
      `Alisher 2 ${SUFFIX}`,
      `Egasiz ${SUFFIX}`,
    ]);
    expect(calls.othersCount).toBe(0);
    expect(calls.seesAll).toBe(false);
  });

  it('ignores a hand-typed «hammasi» from somebody who may not look', async () => {
    // A URL param is a forged post, not a permission (#514).
    const calls = await dayCalls({
      actorId: alisher,
      seesAll: false,
      asOf: today,
      includeOthers: true,
    });
    expect(calls.others).toHaveLength(0);
  });
});

describe('the ✏️ form takes a lead off the day screen', () => {
  const ctx = () => ({ actorId: boss, ip: null, userAgent: null });

  it('clears the follow-up when the save changed the stage', async () => {
    const id = await mintLead(`Forma ${SUFFIX}`, boss, today);
    await updateLead(
      id,
      { name: `Forma ${SUFFIX}`, stageId: nextStage, nextActionAt: today, nextActionNote: 'walk' },
      ctx(),
    );
    const row = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect(row!.nextActionAt, 'a stage change is the call being made').toBeNull();
    expect(row!.nextActionNote).toBeNull();
  });

  it('keeps a NEW date the seller typed in the same save', async () => {
    const id = await mintLead(`Forma ertaga ${SUFFIX}`, boss, today);
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const when = tomorrow.toISOString().slice(0, 10);
    await updateLead(
      id,
      {
        name: `Forma ertaga ${SUFFIX}`,
        stageId: nextStage,
        nextActionAt: when,
        nextActionNote: 'qayta qo‘ng‘iroq',
      },
      ctx(),
    );
    const row = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect(row!.nextActionAt, 'the person decided about their own day').toBe(when);
  });

  it('leaves the date alone on an ordinary save', async () => {
    const id = await mintLead(`Forma nom ${SUFFIX}`, boss, today);
    await updateLead(
      id,
      { name: `Forma nom 2 ${SUFFIX}`, stageId: openStage, nextActionAt: today, nextActionNote: 'walk' },
      ctx(),
    );
    const row = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect(row!.nextActionAt).toBe(today);
  });
});

/**
 * The morning Telegram message (his 4.3c).
 *
 * Read from the rows the digest writes rather than from its return value:
 * what the owner complained about is what ARRIVES, and `deliver` is where
 * the text becomes a message.
 */
describe('the morning message', () => {
  it('carries MY calls and the other sellers as counts', async () => {
    const { sendFollowUpDigest } = await import('@/modules/wms/crm/digest');
    const before = new Date();
    await sendFollowUpDigest();

    /**
     * Only the rows THIS run wrote. A sweep over every `CrmFollowUps` row
     * would also carry off another spec's, and a test that tidies up after
     * strangers asserts about them too (#713).
     */
    const rows = await db
      .select({ id: notifications.id, userId: notifications.userId, payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.type, 'CrmFollowUps'), gte(notifications.createdAt, before)));
    const fresh = rows.filter((row) => JSON.stringify(row.payload).includes(SUFFIX));
    digestRows.push(...rows.map((row) => row.id));
    expect(fresh.length, 'the digest wrote nothing this run').toBeGreaterThan(0);

    const bossText = fresh
      .filter((row) => row.userId === boss)
      .map((row) => (row.payload as { text: string }).text)
      .join('\n');
    expect(bossText, 'the supervisor got no message at all').not.toBe('');
    // His own list…
    expect(bossText).toContain(`Mine bugun ${SUFFIX}`);
    // …and NOT a hundred rows of somebody else's.
    expect(bossText).not.toContain(`Alisher 1 ${SUFFIX}`);
    // …but the counts, which is what a supervisor acts on.
    expect(bossText).toContain('👥 Sotuvchilar:');
    expect(bossText).toMatch(/ \d+ ta/);

    const sellerText = rows
      .filter((row) => row.userId === alisher)
      .map((row) => (row.payload as { text: string }).text)
      .join('\n');
    expect(sellerText, 'the seller got their own calls').toContain(`Alisher 1 ${SUFFIX}`);
    expect(sellerText, 'a seller is told nothing about colleagues').not.toContain(
      '👥 Sotuvchilar:',
    );
  });
});
