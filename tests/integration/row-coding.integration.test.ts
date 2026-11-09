import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  deals,
  dealStages,
  events,
  tasks,
  tnvedAssignments,
  users,
} from '@/modules/platform/db/schema';
import { AI_CODE_NOTE } from '@/modules/wms/calc/code-source';
import { landingItems, type CalcGoodsFact } from '@/modules/wms/calc/intake';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { productKey } from '@/modules/wms/tnved/service';

/**
 * The INSERT's half of the one coding function (docs/IKKI-ESHIK.md §3.1): a
 * row the reading coded by the MODEL lands with `AI_CODE_NOTE` after its own
 * note; a code the row stated, the memory gave or the book gave lands none;
 * a code the collection carries is stored as it is — the table asked its
 * unit — even where the book now knows the name; and a row with no code is
 * coded by the book, as every door's rows always were. Through
 * `landingItems`, the bot's own mapping, so the source is the one the
 * collection carries. Fixtures are this file's own (#183): the book rows it
 * writes are removed, because a `tnved_assignments` row prefills codes for
 * any later spec using the same name.
 */
const SUFFIX = String(Date.now()).slice(-6);
const N = (s: string) => `RC-${SUFFIX} ${s}`;

let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const bookNames = [N('kitob'), N('model-va-kitob')];

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99894${String(Date.now()).slice(-7)}`, fullName: `Row coding fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  const [client] = await db.insert(clients).values({ clientCode: `RC${SUFFIX}`, name: `Row coding fixture ${SUFFIX}` }).returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `RC-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Row coding fixture', createdBy: actorId })
    .returning();
  dealId = deal!.id;
  await db.insert(tnvedAssignments).values([
    { productKey: productKey(bookNames[0]!), productNameZh: bookNames[0]!, tnvedCode: '6505009000', source: 'manual' },
    { productKey: productKey(bookNames[1]!), productNameZh: bookNames[1]!, tnvedCode: '8516000000', source: 'manual' },
  ] as never);
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  await db.delete(tnvedAssignments).where(inArray(tnvedAssignments.productKey, bookNames.map(productKey)));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function land(goods: CalcGoodsFact[]) {
  const result = await openCalcRequest(
    {
      intakeDoor: 'ai',
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      weightKg: 500,
      volumeM3: 10,
      // No shipment weight on the facts: a lone line would copy it into its
      // note, which is not this file's question.
      items: landingItems({ fromCity: null, toCity: null, weightKg: null, volumeM3: 10, goods }),
      source: 'bot',
    },
    { actorId },
  );
  madeRequests.push(result.id);
  return db
    .select({ name: calcRequestItems.name, tnvedCode: calcRequestItems.tnvedCode, note: calcRequestItems.note })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, result.id))
    .orderBy(calcRequestItems.seq);
}

describe('the INSERT codes a row the way the reading did, and marks the model’s code', () => {
  it('a reading-model code lands AI_CODE_NOTE after the row’s own note; row, memory and book codes land none', async () => {
    const rows = await land([
      { name: N('model'), quantity: 40, tnvedCode: '7323930000', tnvedSource: 'model', note: 'sotuvchi: 20 мест' },
      { name: N('model-bare'), quantity: 10, tnvedCode: '7323930000', tnvedSource: 'model' },
      { name: N('xotira'), quantity: 300, tnvedCode: '6201930000', tnvedSource: 'memory' },
      { name: N('kitobdan'), quantity: 200, tnvedCode: '6203420000', tnvedSource: 'book' },
      { name: N('o‘zi'), quantity: 50, tnvedCode: '4202920000', tnvedSource: 'row' },
      { name: N('eski'), quantity: 50, tnvedCode: '4202920000' },
      { name: N('kitob'), quantity: 5 },
    ]);
    expect(rows).toEqual([
      { name: N('model'), tnvedCode: '7323930000', note: `sotuvchi: 20 мест · ${AI_CODE_NOTE}` },
      { name: N('model-bare'), tnvedCode: '7323930000', note: AI_CODE_NOTE },
      { name: N('xotira'), tnvedCode: '6201930000', note: null },
      { name: N('kitobdan'), tnvedCode: '6203420000', note: null },
      { name: N('o‘zi'), tnvedCode: '4202920000', note: null },
      { name: N('eski'), tnvedCode: '4202920000', note: null },
      // No code of its own: the book answers, as at every door.
      { name: N('kitob'), tnvedCode: '6505009000', note: null },
    ]);
  });

  it('a model code the table asked by is stored as it is, though the book now knows the name', async () => {
    const rows = await land([{ name: N('model-va-kitob'), quantity: 5, tnvedCode: '8509400000', tnvedSource: 'model' }]);
    expect(rows).toEqual([{ name: N('model-va-kitob'), tnvedCode: '8509400000', note: AI_CODE_NOTE }]);
  });

  it('a model code the door refuses is no code: no AI note, the door’s own words — and the book may answer', async () => {
    const rows = await land([
      { name: N('nine'), quantity: 5, tnvedCode: '640399000', tnvedSource: 'model' },
      { name: N('kitob'), quantity: 5, tnvedCode: 'kurtka', tnvedSource: 'model' },
    ]);
    expect(rows[0]).toMatchObject({ tnvedCode: null });
    expect(rows[0]!.note).toContain('9 xonali');
    expect(rows[0]!.note).not.toContain(AI_CODE_NOTE);
    expect(rows[1]).toMatchObject({ tnvedCode: '6505009000' });
    expect(rows[1]!.note).not.toContain(AI_CODE_NOTE);
  });
});
