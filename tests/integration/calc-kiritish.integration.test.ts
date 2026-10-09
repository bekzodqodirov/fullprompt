import 'dotenv/config';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  leads,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { analyzeCollected, startIntake } from '@/modules/platform/telegram/calc-intake';
import { invoiceFacts } from '@/modules/wms/calc/intake';
import { landIntake } from '@/modules/wms/calc/intake-land';
import { openCalcRequest, requestAsks } from '@/modules/wms/calc/service';
import { parseGoods } from '@/modules/wms/deals/goods-import';

/**
 * P1 «Kiritish», end to end against the database: every door lands each
 * line's figures in the column its unit names, read back from the stored
 * row — which is what the VED's table, the checklist and the engine read.
 *
 * The owner's sentence: «tnved code va dona m2 juftda otadgan tovarlarni
 * kirgizadgan joyi yoqku». «Kafel, 120, m2» used to land as 120 PIECES with
 * «m2» as display text, and an invoice's code column was thrown away.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `KIR-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let dealId = '';
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99894${String(Date.now()).slice(-7)}`,
      fullName: `Kiritish fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `KR${SUFFIX}`, name: `Kiritish fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `KR-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'Kiritish fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;
});

afterAll(async () => {
  // Everything this file opened was requested by its own fixture user, so
  // «requested by me» is exactly this file's rows — deepest first.
  const rows = await db
    .select({ id: calcRequests.id, taskId: calcRequests.taskId, entityType: calcRequests.entityType, entityId: calcRequests.entityId })
    .from(calcRequests)
    .where(eq(calcRequests.requestedBy, actorId));
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, ids));
    await db.delete(calcRequests).where(inArray(calcRequests.id, ids));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    const leadIds = rows.filter((r) => r.entityType === 'lead').map((r) => r.entityId);
    if (leadIds.length > 0) {
      await db.delete(crmActivities).where(inArray(crmActivities.entityId, leadIds));
      await db.delete(leads).where(inArray(leads.id, leadIds));
    }
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  // An audited fixture user is deactivated, never deleted (audit_log FK).
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function storedItems(requestId: string) {
  return db
    .select()
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId))
    .orderBy(asc(calcRequestItems.seq));
}

describe('the door routes every row once (P1.2)', () => {
  it('«Kafel, 120, m2» / «Kurtka, 500, kg» / «Futbolka, 20, karobka» land where their units say', async () => {
    const opened = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: dealId,
        section: 'rastamojka',
        fromCity: null,
        toCity: null,
        weightKg: 900,
        volumeM3: 4,
        // The old «nomi, soni, birlik» shape every door used to hand over.
        items: [
          { name: `Kafel ${tag()}`, quantity: 120, unit: 'm2' },
          { name: `Kurtka ${tag()}`, quantity: 500, unit: 'kg' },
          { name: `Futbolka ${tag()}`, quantity: 20, unit: 'karobka' },
          { name: `Tufli ${tag()}`, measureUnit: 'juft', measureQty: 40, tnvedCode: '6403.99.00.00' },
          { name: `Sviter ${tag()}`, quantity: 300, unit: 'шт', weightKg: 150, tnvedCode: '901210000' },
        ],
        source: 'card',
      },
      ctx(),
    );
    const rows = await storedItems(opened.id);
    const shape = rows.map((r) => ({
      quantity: r.quantity === null ? null : Number(r.quantity),
      weightKg: r.weightKg === null ? null : Number(r.weightKg),
      measureUnit: r.measureUnit,
      measureQty: r.measureQty === null ? null : Number(r.measureQty),
      tnvedCode: r.tnvedCode,
      note: r.note,
    }));
    expect(shape).toEqual([
      // A pair, never 120 pieces — the seller's words stay in the note.
      { quantity: null, weightKg: null, measureUnit: 'm2', measureQty: 120, tnvedCode: null, note: 'sotuvchi: 120 m2' },
      { quantity: null, weightKg: 500, measureUnit: null, measureQty: null, tnvedCode: null, note: 'sotuvchi: 500 kg' },
      // The line now OWES its count; a carton is never a piece.
      { quantity: null, weightKg: null, measureUnit: null, measureQty: null, tnvedCode: null, note: 'sotuvchi: 20 karobka' },
      { quantity: null, weightKg: null, measureUnit: 'juft', measureQty: 40, tnvedCode: '6403990000', note: null },
      // A count word is a count; a typed nine-place code is a question.
      {
        quantity: 300,
        weightKg: 150,
        measureUnit: null,
        measureQty: null,
        tnvedCode: null,
        note: 'TNVED «901210000» — 9 xonali: boshida 0 tushib qolganmi?',
      },
    ]);
  });

  it('the stored request asks what the LAW needs, read back with the book', async () => {
    // A 6110 sweater stating only kg owes its count («boj kamida $1/dona»);
    // a 9403 table stating only dona owes its net weight. The seeded book
    // carries both laws (pp3818).
    const opened = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: dealId,
        section: 'rastamojka',
        fromCity: null,
        toCity: null,
        weightKg: 900,
        volumeM3: 4,
        items: [
          { name: `Sviter ${tag()}`, weightKg: 150, tnvedCode: '6110200000' },
          { name: `Stol ${tag()}`, quantity: 40, tnvedCode: '9403600000' },
          { name: `Monitor ${tag()}`, quantity: 10 },
        ],
        source: 'card',
      },
      ctx(),
    );
    const asks = await requestAsks(opened.id);
    expect(asks.missing).toEqual(['lineNeed']);
    expect(asks.lines.map((l) => [l.seq, l.units])).toEqual([
      [1, ['dona']],
      [2, ['kg']],
    ]);
    expect(asks.lines[0]!.pinned[0]).toMatchObject({ why: 'duty', rate: 1 });
  });
});

describe('the bot’s invoice keeps its code column (P1.6)', () => {
  it('a «Код ТН ВЭД товара» sheet lands its codes and its units through landIntake', async () => {
    const rows = [
      ['№', 'Код ТН ВЭД товара', 'Наименование', 'Кол-во', 'Ед. изм.', 'Вес нетто, кг'],
      [1, '6907210000', `Плитка ${tag()}`, 120, 'м2', 900],
      [2, '6201930000', `Куртка ${tag()}`, 300, 'шт', 150],
    ];
    const goods = invoiceFacts(parseGoods(rows).goods);
    const before = await db
      .select({ id: calcRequests.id })
      .from(calcRequests)
      .where(eq(calcRequests.requestedBy, actorId));
    const target = await landIntake({
      noteId: uuidv4(),
      section: 'rastamojka',
      facts: { weightKg: 1100, volumeM3: 5, goods },
      steps: [],
      fileCount: 1,
      material: [],
      collectedBy: actorId,
      collectedByName: 'Kiritish fixture',
      client: null,
      leadName: `Kiritish lead ${SUFFIX}`,
      leadPhone: `+99893${String(Date.now()).slice(-7)}`,
    });
    expect(target.kind).toBe('lead');
    const after = await db
      .select({ id: calcRequests.id })
      .from(calcRequests)
      .where(
        and(
          eq(calcRequests.requestedBy, actorId),
          eq(calcRequests.entityType, 'lead'),
          eq(calcRequests.entityId, target.id),
        ),
      );
    const landed = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(landed).toHaveLength(1);
    const items = await storedItems(landed[0]!.id);
    expect(
      items.map((r) => [
        r.tnvedCode,
        r.quantity === null ? null : Number(r.quantity),
        r.measureUnit,
        r.measureQty === null ? null : Number(r.measureQty),
        r.weightKg === null ? null : Number(r.weightKg),
      ]),
    ).toEqual([
      // «120 м2» is the pair, never 120 pieces; the code is the file's own.
      ['6907210000', null, 'm2', 120, 900],
      ['6201930000', 300, null, null, 150],
    ]);
  });
});

describe('«➕ Yana ma’lumot» keeps the per-line answers (P1.3)', () => {
  it('a re-analysis puts the seller’s answers back on their lines, by name', async () => {
    // The audit's finding: the re-read rebuilt the goods from the material
    // and threw every typed count away, while the seller believed those
    // lines were answered. No model here (no key in the suite): the invoice
    // is the goods list, and the answers go back on top of it.
    const chat = BigInt(`9${SUFFIX}`);
    const state = startIntake(chat, 'rastamojka');
    const analysed = await analyzeCollected({
      ...state,
      stage: 'material',
      material: ['qo‘shimcha: Plitka va Kurtka'],
      // The re-read lists the lines in a DIFFERENT order from the one the
      // answers were given against.
      invoiceGoods: [{ name: 'Kurtka', weightKg: 150 }, { name: 'Plitka' }],
      lineAnswers: [
        { index: 0, name: 'Plitka', patch: { measureUnit: 'm2', measureQty: 120 } },
        { index: 1, name: 'Kurtka', patch: { quantity: 300 } },
      ],
      lineDone: [0, 1],
    });
    expect(analysed.facts.goods).toEqual([
      { name: 'Kurtka', weightKg: 150, quantity: 300 },
      { name: 'Plitka', measureUnit: 'm2', measureQty: 120 },
    ]);
    // …and the lines dealt with stay dealt with.
    expect(analysed.lineDone).toEqual([0, 1]);
  });

  it('a total written two ways is asked — the model does not get to answer it either', async () => {
    const chat = BigInt(`8${SUFFIX}`);
    const state = startIntake(chat, 'podklyuch');
    const analysed = await analyzeCollected({ ...state, stage: 'material', material: ['Yiwu → Toshkent, 1,200 kg, 4 kub'] });
    expect(analysed.facts.weightKg).toBeNull();
    expect(analysed.facts.volumeM3).toBe(4);
    expect(analysed.ambiguousTotals).toEqual([
      { field: 'weightKg', text: '1,200', decimal: 1.2, thousands: 1200 },
    ]);
  });
});
