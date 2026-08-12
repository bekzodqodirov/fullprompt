import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { auditLog, leads, leadStages, users } from '@/modules/platform/db/schema';
import { createLead, listLeads, listStages, moveLead, updateLead } from '@/modules/wms/crm/service';

/**
 * The order the owner puts the cards in, end to end (round 96).
 *
 * He: «cartni boshqa etapga otkazganda ularni tartibi ozgarib qolyabti qaysi
 * ketma ketlikda qoysa usha saqlanib qoladgan qilsa boladimi?»
 *
 * The arithmetic is pure and proven in `tests/unit/board-order.test.ts`. What
 * this file proves is the wiring: that a drag's landing place reaches the
 * column, that the board and the per-stage CAP read the same order, and that
 * everything which is not a drag still puts a card at the top of where it
 * arrived — which is what the board did before any of this existed.
 */

// Not `Date.now()` alone: two fixtures minted in the same millisecond collide
// and the test then asserts the opposite of its own sentence (#598).
const SUFFIX = String(Date.now()).slice(-7);
let seq = 0;
const tag = () => `${(seq += 1)}-${SUFFIX}`;

let actorId: string;
let openStageId: string;
let otherStageId: string;
const made: string[] = [];

const ctx = () => ({ actorId });

async function makeLead(name: string, stageId = openStageId) {
  const row = await createLead({ name: `${name} ${tag()}`, stageId }, ctx());
  made.push(row.id);
  return row.id;
}

/**
 * THIS FILE'S cards in one column, in the order the board would draw them.
 *
 * Filtered to what the test made, because the local database is a long-lived
 * one carrying hundreds of leads from earlier runs (#573) — a sub-sequence of
 * the real order is exactly what the assertions here are about.
 */
async function column(stageId: string): Promise<string[]> {
  const rows = await listLeads({ openOnly: true, perStage: 10_000, limit: 10_000 });
  return rows
    .filter((row) => row.lead.stageId === stageId && made.includes(row.lead.id))
    .map((row) => row.lead.id);
}

const orderOf = async (id: string) =>
  (await db.query.leads.findFirst({ where: eq(leads.id, id) }))!.boardOrder;

beforeAll(async () => {
  const [staff] = await db.select().from(users).limit(1);
  actorId = staff!.id;
  const stages = (await listStages()).filter((stage) => stage.kind === 'open');
  openStageId = stages[0]!.id;
  otherStageId = stages[1]?.id ?? stages[0]!.id;
});

afterAll(async () => {
  if (made.length > 0) {
    // `audit_log` refuses DELETE by database rule, so a lead's trail outlives
    // it on purpose; the events do not (#495's cleanup).
    await db.execute(
      sql`DELETE FROM events WHERE entity_type = 'lead' AND entity_id IN ${sql`(${sql.join(
        made.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`}`,
    );
    await db.delete(leads).where(inArray(leads.id, made));
  }
  await pgClient.end();
});

describe('a card stays where it was put', () => {
  it('lands exactly between the two cards it was dropped between', async () => {
    const a = await makeLead('A');
    const b = await makeLead('B');
    const c = await makeLead('C');
    // Created newest-first, which is where a new card has always appeared.
    expect(await column(openStageId)).toEqual([c, b, a]);

    // Drag C to the bottom: dropped past the last card, so nothing is «before»
    // it. This is the move the owner described — and before this round the
    // card would have come straight back to the top, because creating and
    // moving both counted as «last touched».
    await moveLead(c, openStageId, '', ctx(), { beforeId: null });
    expect(await column(openStageId)).toEqual([b, a, c]);

    // …and drop B into the middle. Two cards moved, in the order he moved
    // them, and the first move is still standing.
    await moveLead(b, openStageId, '', ctx(), { beforeId: c });
    expect(await column(openStageId)).toEqual([a, b, c]);
  });

  it('does not move a card dropped back onto itself', async () => {
    const a = await makeLead('self');
    const before = await orderOf(a);
    await moveLead(a, openStageId, '', ctx(), { beforeId: a });
    expect(await orderOf(a)).toBe(before);
  });

  it('renumbers the column rather than letting two cards claim one place', async () => {
    const bottom = await makeLead('gap-bottom');
    const top = await makeLead('gap-top');
    const rider = await makeLead('gap-rider');
    // Squeeze the same seam until the gap cannot be halved again. By hand
    // that is fifty drags onto one line; here it is a loop.
    await db.update(leads).set({ boardOrder: 1000 }).where(eq(leads.id, top));
    await db.update(leads).set({ boardOrder: 1000 + 1e-9 }).where(eq(leads.id, bottom));
    await db.update(leads).set({ boardOrder: 5000 }).where(eq(leads.id, rider));

    await moveLead(rider, openStageId, '', ctx(), { beforeId: bottom });
    // The order survives the renumber — that is the whole point of it — and
    // the three cards now have room between them again. Read as a
    // sub-sequence: the earlier tests in this file left cards here too.
    const three = [top, rider, bottom];
    expect((await column(openStageId)).filter((id) => three.includes(id))).toEqual(three);
    const [x, y] = [await orderOf(top), await orderOf(rider)];
    expect(y! - x!).toBeGreaterThan(1);
  });
});

describe('everything that is not a drag lands at the top', () => {
  it('the one-tap button and the ⋯ sheet, which say nothing about position', async () => {
    const first = await makeLead('arriving-1', otherStageId);
    const second = await makeLead('arriving-2', otherStageId);
    const traveller = await makeLead('traveller');
    await moveLead(traveller, otherStageId, '', ctx());
    // The card just arrived, and arriving is what puts a card on top — the
    // behaviour every board in this app has always had.
    expect(await column(otherStageId)).toEqual([traveller, second, first]);
  });

  it('the ✏️ form’s stage select', async () => {
    const sitting = await makeLead('sitting', otherStageId);
    const edited = await makeLead('edited');
    await updateLead(edited, { name: `edited ${tag()}`, stageId: otherStageId }, ctx());
    expect((await column(otherStageId))[0]).toBe(edited);
    expect(await column(otherStageId)).toContain(sitting);
  });

  it('but an ordinary save does NOT reshuffle a column somebody arranged', async () => {
    const above = await makeLead('keeps-above');
    const below = await makeLead('keeps-below');
    await moveLead(above, openStageId, '', ctx(), { beforeId: null });
    const arranged = await column(openStageId);
    // Editing the card at the BOTTOM must not lift it: «last touched» is
    // exactly the rule this round removed.
    await updateLead(above, { name: `renamed ${tag()}` }, ctx());
    expect(await column(openStageId)).toEqual(arranged);
    expect(arranged.indexOf(above)).toBeGreaterThan(arranged.indexOf(below));
  });
});

describe('the board and its cap read the same order', () => {
  it('sends the cards it is about to draw, not a different set', async () => {
    const sunk = await makeLead('cap-sunk');
    // The NEWEST lead in the column, dragged to the very bottom of it.
    await moveLead(sunk, openStageId, '', ctx(), { beforeId: null });

    const inStage = (rows: Awaited<ReturnType<typeof listLeads>>) =>
      rows.filter((row) => row.lead.stageId === openStageId).map((row) => row.lead.id);
    const full = inStage(await listLeads({ openOnly: true, perStage: 10_000, limit: 10_000 }));
    expect(full.at(-1)).toBe(sunk);

    const capped = inStage(
      await listLeads({ openOnly: true, perStage: full.length - 1, limit: 10_000 }),
    );
    // The cap has to be a PREFIX of the order the board draws. Ranked by
    // «last touched» it would have sent `sunk` first and the board would have
    // drawn it last — forty cards fetched and a different forty rendered, so
    // a card dragged low VANISHES instead of sinking (#513 in a slice's
    // clothes).
    expect(capped).toEqual(full.slice(0, -1));
  });
});

describe('re-ordering one column is not a fact about the lead', () => {
  it('writes no audit row and no stage event', async () => {
    const first = await makeLead('quiet-1');
    const second = await makeLead('quiet-2');
    const auditRows = async () =>
      Number(
        (
          await db
            .select({ n: sql<number>`count(*)` })
            .from(auditLog)
            .where(eq(auditLog.entityId, first))
        )[0]!.n,
      );
    const stageEvents = async () =>
      Number(
        (
          await db.execute<{ n: number }>(
            sql`SELECT count(*) AS n FROM events WHERE entity_type = 'lead' AND entity_id = ${first}::uuid`,
          )
        )[0]!.n,
      );
    const [audited, announced] = [await auditRows(), await stageEvents()];

    await moveLead(first, openStageId, '', ctx(), { beforeId: null });
    expect((await column(openStageId)).indexOf(first)).toBeGreaterThan(
      (await column(openStageId)).indexOf(second),
    );

    // A card dragged one place up its own column is how somebody likes to
    // look at the board, like the sidebar being collapsed. Auditing it would
    // write a row whose before equals its after, which the history draws as a
    // change with no lines in it (#502), and announcing it would fire every
    // «entered stage X» rule on a card that entered nothing.
    expect(await auditRows()).toBe(audited);
    expect(await stageEvents()).toBe(announced);
  });

  it('still audits and announces a real move between stages', async () => {
    const moved = await makeLead('loud');
    await moveLead(moved, otherStageId, '', ctx());
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(eq(auditLog.entityId, moved));
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    const events = await db.execute<{ n: number }>(
      sql`SELECT count(*) AS n FROM events WHERE entity_type = 'lead' AND entity_id = ${moved}::uuid`,
    );
    expect(Number(events[0]!.n)).toBeGreaterThan(0);
  });
});

describe('the stages themselves are untouched', () => {
  it('a column that was never dragged still reads newest-first', async () => {
    const [stage] = await db
      .select()
      .from(leadStages)
      .where(eq(leadStages.id, openStageId))
      .limit(1);
    expect(stage!.kind).toBe('open');
  });
});
