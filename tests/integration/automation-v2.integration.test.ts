import 'dotenv/config';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  automationFires,
  automationRules,
  leadStages as leadStagesTable,
  leads,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { runStaleAutomation, saveRule } from '@/modules/platform/automation/service';
import { createLead } from '@/modules/wms/crm/service';

/**
 * Round 86 against a real database: a rule that fires because NOTHING
 * happened, a rule that filters, and a rule that says the customer's name.
 *
 * Every stage here is MINTED and deleted afterwards, for the reason
 * `automation.integration` records: a trigger on a seeded column is pulled by
 * every other file's lead as well as this one's, and the fire count is then
 * evidence about the whole suite rather than about the rule (#183).
 */

const STAMP = Date.now();
let authorId: string;
let ownerId: string;
const ruleIds: string[] = [];
const madeStages: string[] = [];
const madeLeads: string[] = [];
const ctx = (actorId: string) => ({ actorId, ip: null, userAgent: null });

/** A column of this file's own. */
async function mintStage(name: string): Promise<string> {
  const [stage] = await db
    .insert(leadStagesTable)
    .values({ name: `SA-${STAMP} ${name}`, kind: 'open', color: 'blue', sortOrder: 9600, active: true })
    .returning();
  madeStages.push(stage!.id);
  return stage!.id;
}

/**
 * A lead that has been sitting still for `days`.
 *
 * `updated_at` is pushed back by hand because that is the ONLY way to make a
 * card old inside a test — and it is also exactly what the sweep reads, so the
 * fixture states the fact under test rather than simulating around it.
 */
async function mintStaleLead(
  stageId: string,
  days: number,
  extra: { name?: string; quotedAmount?: number; quotedVolumeM3?: number } = {},
): Promise<string> {
  // `createLead` answers with the ROW, unlike `createDeal` which answers with
  // an id — reading it as an id gives postgres «[object Object]» for a uuid.
  const { id } = await createLead(
    { ...extra, name: `SA-${STAMP} ${extra.name ?? 'lid'}`, stageId, ownerId },
    ctx(authorId),
  );
  madeLeads.push(id);
  await db
    .update(leads)
    .set({ updatedAt: sql`now() - ${`${days} days`}::interval` })
    .where(eq(leads.id, id));
  return id;
}

async function mintStaleRule(
  stageId: string,
  title: string,
  extra: Partial<Parameters<typeof saveRule>[0]> = {},
): Promise<string> {
  const id = await saveRule(
    {
      name: `SA-${STAMP} ${title}`,
      triggerType: 'lead_stale',
      triggerStageId: stageId,
      triggerEvent: null,
      staleDays: 3,
      actionType: 'create_task',
      actionConfig: { title, assignee: 'owner', dueDays: 1, priority: 2 },
      ...extra,
    },
    ctx(authorId),
  );
  ruleIds.push(id);
  return id;
}

const tasksTitled = async (title: string) =>
  db.select().from(tasks).where(eq(tasks.title, title));

beforeAll(async () => {
  const staff = await db.select().from(users).where(eq(users.active, true)).limit(2);
  authorId = staff[0]!.id;
  ownerId = (staff[1] ?? staff[0])!.id;
});

afterAll(async () => {
  // A rule is CONFIGURATION: it changes what every later sweep does.
  if (ruleIds.length) await db.delete(automationRules).where(inArray(automationRules.id, ruleIds));
  await db.delete(tasks).where(like(tasks.title, `SA-${STAMP}%`));
  if (madeLeads.length) {
    await db.delete(automationFires).where(inArray(automationFires.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  if (madeStages.length) {
    const home = (await db.select().from(leadStagesTable)).find(
      (stage) => !madeStages.includes(stage.id),
    )!;
    await db.update(leads).set({ stageId: home.id }).where(inArray(leads.stageId, madeStages));
    await db.delete(leadStagesTable).where(inArray(leadStagesTable.id, madeStages));
  }
  await pgClient.end();
});

describe('the rule that fires because nothing happened', () => {
  it('opens ONE task for a forgotten lead, and does not open a second one on the next sweep', async () => {
    const stageId = await mintStage('qotgan');
    const title = `SA-${STAMP} eslat`;
    const ruleId = await mintStaleRule(stageId, title);
    const leadId = await mintStaleLead(stageId, 5);

    expect(await runStaleAutomation()).toBe(1);
    const first = await tasksTitled(title);
    expect(first).toHaveLength(1);
    expect(first[0]!.assigneeId).toBe(ownerId);
    expect(first[0]!.entityType).toBe('lead');
    expect(first[0]!.entityId).toBe(leadId);
    // Acts with its AUTHOR's authority, like every other rule action.
    expect(first[0]!.createdBy).toBe(authorId);

    // The condition is still true — the lead is still old, still in the same
    // column. Without the claim this is where a task appears every hour.
    await runStaleAutomation();
    await runStaleAutomation();
    expect(await tasksTitled(title)).toHaveLength(1);

    const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, ruleId));
    expect(rule!.fireCount).toBe(1);
  });

  it('a lead touched since the reminder and forgotten AGAIN is reminded again', async () => {
    const stageId = await mintStage('qayta');
    const title = `SA-${STAMP} qayta eslat`;
    await mintStaleRule(stageId, title);
    const leadId = await mintStaleLead(stageId, 5);

    await runStaleAutomation();
    expect(await tasksTitled(title)).toHaveLength(1);

    /**
     * The sequence the rule promises to handle: reminded in March, worked on
     * in April, quiet ever since. Both halves have to be pushed back, and
     * that is not fixture convenience — it is the whole shape of the fact.
     * The reminder is OLD, the last touch is NEWER THAN THE REMINDER, and the
     * card is STILL past the threshold. Move only `updated_at` and the touch
     * lands before the reminder, which is a card that was never worked on.
     */
    await db
      .update(automationFires)
      .set({ firedAt: sql`now() - '10 days'::interval` })
      .where(eq(automationFires.entityId, leadId));
    await db
      .update(leads)
      .set({ updatedAt: sql`now() - '4 days'::interval` })
      .where(eq(leads.id, leadId));

    await runStaleAutomation();
    expect(await tasksTitled(title)).toHaveLength(2);
  });

  it('a lead nobody has forgotten yet is left alone', async () => {
    const stageId = await mintStage('yangi');
    const title = `SA-${STAMP} tegmasin`;
    await mintStaleRule(stageId, title);
    await mintStaleLead(stageId, 1);

    expect(await runStaleAutomation()).toBe(0);
    expect(await tasksTitled(title)).toHaveLength(0);
  });
});

describe('conditions narrow a rule', () => {
  it('fires on the big lead and stays silent on the small one', async () => {
    const stageId = await mintStage('shartli');
    const title = `SA-${STAMP} katta yuk`;
    await mintStaleRule(stageId, title, {
      conditions: [{ field: 'volumeM3', op: 'gt', value: '5' }],
    });
    const big = await mintStaleLead(stageId, 4, { name: 'katta', quotedVolumeM3: 9 });
    const small = await mintStaleLead(stageId, 4, { name: 'kichik', quotedVolumeM3: 2 });

    expect(await runStaleAutomation()).toBe(1);
    const opened = await tasksTitled(title);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.entityId).toBe(big);

    // The lead it skipped was never claimed, so it is still reachable the day
    // its cargo grows — a filtered-out card must not be silently spent. Asked
    // about THIS test's two leads only: the earlier tests' leads are claimed,
    // correctly, and a sweep over `madeLeads` would be reading their history.
    const claims = await db
      .select()
      .from(automationFires)
      .where(inArray(automationFires.entityId, [big, small]));
    expect(claims.map((c) => c.entityId)).toEqual([big]);
  });
});

describe('placeholders say which customer', () => {
  it('a task title carries the lead’s own name and price', async () => {
    const stageId = await mintStage('ismli');
    await mintStaleRule(stageId, '{ism} — {narx}$ · {etap}', {
      actionConfig: {
        title: `SA-${STAMP} {ism} — {narx}$`,
        assignee: 'owner',
        dueDays: 1,
        priority: 2,
      },
    });
    await mintStaleLead(stageId, 4, { name: 'Aziz aka', quotedAmount: 900 });

    await runStaleAutomation();
    const [task] = await db
      .select()
      .from(tasks)
      .where(like(tasks.title, `SA-${STAMP} SA-${STAMP}%`));
    // The name is the lead's real one (createLead prefixes it), the price is
    // printed the way a person writes it and not as postgres stores it.
    expect(task!.title).toContain('Aziz aka');
    expect(task!.title).toContain('900$');
    expect(task!.title).not.toContain('900.00');
    expect(task!.title).not.toContain('{ism}');
  });
});

describe('what a saved rule keeps', () => {
  it('blanks the days on a kind that does not read them, so the row never says what the engine ignores', async () => {
    const stageId = await mintStage('etapli');
    const id = await saveRule(
      {
        name: `SA-${STAMP} etap qoidasi`,
        triggerType: 'lead_stage',
        triggerStageId: stageId,
        triggerEvent: null,
        staleDays: 9,
        conditions: [{ field: 'source', op: 'not_empty', value: '' }],
        actionType: 'create_task',
        actionConfig: { title: `SA-${STAMP} x`, assignee: 'owner', dueDays: null, priority: 2 },
      },
      ctx(authorId),
    );
    ruleIds.push(id);
    const [row] = await db.select().from(automationRules).where(eq(automationRules.id, id));
    expect(row!.staleDays).toBeNull();
    expect(row!.conditions).toEqual([{ field: 'source', op: 'not_empty', value: '' }]);
  });
});
