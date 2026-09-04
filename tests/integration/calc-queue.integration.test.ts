import 'dotenv/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
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
import {
  calcQueue,
  calcQueueCounts,
  calcRequestDetail,
  finishCalcRequest,
  notifyOverdueCalcs,
  openCalcFor,
  openCalcRequest,
  releaseCalcRequest,
  returnCalcRequest,
  takeCalcRequest,
  rekeyLeadCalcRequests,
} from '@/modules/wms/calc/service';

/**
 * VED phase A — the queue against a real database.
 *
 * The fixture mints its OWN lead and deal rather than borrowing seeded ones:
 * a calc request is visible on the card and in a company-wide queue, so a
 * request left on somebody else's record would change what the next spec
 * renders (#183). Every id this file creates is torn down in reverse
 * dependency order, and the per-run tag carries a counter beside the clock
 * (#598 — a fast file spends many tests inside one millisecond).
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `VEDA-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let vedPool: string[] = [];
let clientId = '';
let dealId = '';
let leadId = '';
let stageId = '';
const madeRequests: string[] = [];
const madeNotes: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  // A requester of this file's OWN, deactivated at the end.
  //
  // Not the first seeded user: the service caps how many open requests one
  // person may hold, and on a long-lived database that person is carrying
  // every other run's leftovers — the cap would then refuse this file's
  // fixtures and the failure would name the wrong rule (#653, a different
  // oracle rather than a worse one).
  const [fixtureActor] = await db
    .insert(users)
    .values({
      phone: `+99890${String(Date.now()).slice(-7)}`,
      fullName: `VED fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = fixtureActor!.id;
  // The POOL the rota picks from — everyone whose editable grants say
  // `ved.docs`. Which of them wins is the rota's business (fewest open,
  // longest-since, never-had-one first), and asserting a particular winner
  // would be asserting the seed's shape rather than the rule: on a fresh
  // database super_admin and admin hold it too.
  const pool = await db.execute<{ id: string }>(`
    SELECT DISTINCT u.id FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE p.code = 'ved.docs' AND u.active = true
  `);
  vedPool = pool.map((row) => row.id);
  expect(vedPool.length, 'the fixture needs at least one ved.docs holder').toBeGreaterThan(0);

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `VD${SUFFIX}`, name: `VED fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;

  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  stageId = stage!.id;
  const [deal] = await db
    .insert(deals)
    .values({
      code: `VD-${SUFFIX}`,
      clientId,
      stageId,
      title: 'VED fixture deal',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;

  const leadStage = await db.execute<{ id: string }>(
    `SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
  );
  const [lead] = await db
    .insert(leads)
    .values({
      name: `VED fixture lead ${SUFFIX}`,
      stageId: leadStage[0]!.id,
      createdBy: actorId,
    })
    .returning();
  leadId = lead!.id;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((row) => row.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      // Events point at the task; they go first or the delete is refused.
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeNotes.length > 0) {
    await db.delete(crmActivities).where(inArray(crmActivities.id, madeNotes));
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, leadId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  // The fixture requester leaves too — deactivated rather than deleted,
  // because the audit trail stamps it and audit_log refuses deletes.
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(overrides: Partial<Parameters<typeof openCalcRequest>[0]> = {}) {
  const result = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'podklyuch',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 300,
      volumeM3: 2,
      items: [{ name: `monitor ${tag()}`, quantity: 10 }],
      source: 'card',
      ...overrides,
    },
    ctx(),
  );
  madeRequests.push(result.id);
  return result;
}

describe('a request is a JOB, not a card state', () => {
  it('a second submission on the same card opens its OWN request', async () => {
    // The old partial unique index made this a refusal, and the landing rule
    // sends every repeat client to the same open deal — so «one open request
    // per card» would merge Monday's monitors with Thursday's chairs, and the
    // freight band is computed from TOTAL kg ÷ TOTAL m³.
    const first = await open();
    const second = await open({ items: [{ name: `chair ${tag()}` }] });
    expect(second.id).not.toBe(first.id);
    const onCard = await openCalcFor('deal', dealId);
    expect(onCard.length).toBeGreaterThanOrEqual(2);
  });

  it('carries the facts, the goods and every column 0085 added', async () => {
    // Nothing mechanically proves the drizzle table and the SQL agree — the
    // snapshots stopped at 0009 — so this reads every new column back.
    const { id } = await open({ items: [{ name: `pallet ${tag()}`, quantity: 4, unit: 'dona' }] });
    const row = await calcRequestDetail(id);
    expect(row).not.toBeNull();
    expect(row!.section).toBe('podklyuch');
    expect(row!.fromCity).toBe('Yiwu');
    expect(row!.toCity).toBe('Toshkent');
    expect(row!.weightKg).toBe(300);
    expect(row!.volumeM3).toBe(2);
    expect(row!.source).toBe('card');
    expect(row!.itemCount).toBe(1);
    expect(row!.items[0]!.unit).toBe('dona');
    expect(row!.completedAt).toBeNull();
  });

  it('the checklist can be SATISFIED — both screens carry what it asks about', async () => {
    // The per-line question (`itemMeasure`) is answered from
    // the facts the SCREEN builds, and both screens projected the item to
    // `{name}` alone — so quantity and weight read null whatever is stored,
    // and both chips rendered on every rastamojka request for ever,
    // including one the machine had just priced in full. A warning that
    // fires on everything names nothing (#649).
    const { id } = await open({
      section: 'rastamojka',
      items: [
        { name: `krujka ${tag()}`, quantity: 100, weightKg: 200 },
        { name: `plitka ${tag()}`, quantity: 50, weightKg: 100 },
      ],
    });
    const row = await calcRequestDetail(id);
    expect(row!.missing).toEqual([]);

    const listed = (await calcQueue()).find((r) => r.id === id);
    expect(listed, 'the queue must show the same request').toBeTruthy();
    expect(listed!.missing).toEqual([]);

    // A line stating a WEIGHT alone is complete — `unitsForRow` prices it per
    // kg, which is 74 % of the customs file.
    const byWeight = await open({
      section: 'rastamojka',
      items: [{ name: `kg-only ${tag()}`, weightKg: 200 }],
    });
    expect((await calcRequestDetail(byWeight.id))!.missing).toEqual([]);

    // …and it still SAYS so when a line states NEITHER. TWO lines, because
    // with one the shipment's own weight IS that line's and the request is
    // complete without anybody typing anything — the derivation, visible.
    const bare = await open({
      section: 'rastamojka',
      items: [{ name: `sonli ${tag()}`, quantity: 3 }, { name: `nomsiz ${tag()}` }],
    });
    expect((await calcRequestDetail(bare.id))!.missing).toEqual(['itemMeasure']);

    // …and a row the VED measured in the law's own unit closes it too. The
    // screens read the measure pair off the ROWS, which the item projection
    // they render does not carry.
    await db
      .update(calcRequestItems)
      .set({ measureUnit: 'm2', measureQty: '12.5000' })
      .where(eq(calcRequestItems.requestId, bare.id));
    expect((await calcRequestDetail(bare.id))!.missing).toEqual([]);
  });
});

describe('the queue hands the work out and takes it back', () => {
  it('assigns on open, so the clock accuses somebody from second zero', async () => {
    const { assigneeId } = await open();
    expect(assigneeId).toBeTruthy();
    expect(vedPool, 'a request is handed to a ved.docs holder').toContain(assigneeId);
  });

  it('shows an UNTAKEN request — the row the screen exists for', async () => {
    const { id } = await open();
    await releaseCalcRequest(id, ctx());
    const rows = await calcQueue();
    const mine = rows.find((row) => row.id === id);
    // An inner join onto the assignee would drop exactly this row, the card
    // panel would then say «no request», and the seller would send again.
    expect(mine, 'an unassigned request must still be in the queue').toBeTruthy();
    expect(mine!.assigneeId).toBeNull();
    expect((await openCalcFor('deal', dealId)).some((row) => row.id === id)).toBe(true);
  });

  it('exactly one taker wins a race, and the loser is told which', async () => {
    const { id } = await open();
    await releaseCalcRequest(id, ctx());
    const before = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.entityId, dealId), eq(tasks.status, 'open')));
    const settled = await Promise.allSettled([
      takeCalcRequest(id, { actorId: vedPool[0]! }),
      takeCalcRequest(id, { actorId: vedPool[0]! }),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const row = await calcRequestDetail(id);
    expect(row!.assigneeId).toBe(vedPool[0]!);
    const after = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.entityId, dealId), eq(tasks.status, 'open')));
    // Exactly ONE new task: the loser's would be an open, timed job that no
    // request points at, and closing it would then do nothing at all.
    expect(after.length - before.length).toBe(1);
  });

  it('the counters and the rows answer the same question', async () => {
    const counts = await calcQueueCounts();
    const rows = await calcQueue();
    expect(counts.open).toBe(rows.length);
  });
});

describe('the endings', () => {
  it('a bounce-back needs a reason and ends the request', async () => {
    const { id } = await open();
    await expect(returnCalcRequest(id, ' ', ctx())).rejects.toThrow('reason_required');
    await returnCalcRequest(id, 'kub yozilmagan', ctx());
    const row = await calcRequestDetail(id);
    expect(row!.completedVia).toBe('returned');
    expect(row!.returnReason).toBe('kub yozilmagan');
    // …and the card is free to carry a new request straight away.
    const again = await open();
    expect(again.id).not.toBe(id);
  });

  it('finishing records the ANSWER, not just the fact that it ended', async () => {
    const { id } = await open();
    await finishCalcRequest(id, { amount: 480, currency: 'USD', note: '3 guruh' }, ctx());
    const row = await calcRequestDetail(id);
    expect(row!.completedVia).toBe('task');
    expect(row!.answerAmount).toBe(480);
    expect(row!.answerCurrency).toBe('USD');
    expect(row!.answerNote).toBe('3 guruh');
  });

  it('a closed request cannot be closed twice', async () => {
    const { id } = await open();
    await finishCalcRequest(id, { amount: 100, currency: 'USD', note: '' }, ctx());
    await expect(
      finishCalcRequest(id, { amount: 200, currency: 'USD', note: '' }, ctx()),
    ).rejects.toThrow('already_closed');
  });
});

describe('the late sweep', () => {
  it('claims each row before it speaks, and speaks once', async () => {
    const { id } = await open();
    // Past its deadline, unannounced — the shape the sweep looks for.
    await db
      .update(calcRequests)
      .set({ dueAt: new Date(Date.now() - 3_600_000), overdueNotifiedAt: null })
      .where(eq(calcRequests.id, id));
    const first = await notifyOverdueCalcs();
    expect(first).toBeGreaterThanOrEqual(1);
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.overdueNotifiedAt).not.toBeNull();
    // A second sweep in the same minute must find nothing of ours: the claim
    // is the UPDATE, so two overlapping drains split the work (0082's rule).
    const stillLate = await db
      .select({ id: calcRequests.id })
      .from(calcRequests)
      .where(and(eq(calcRequests.id, id), isNull(calcRequests.overdueNotifiedAt)));
    expect(stillLate).toHaveLength(0);
  });
});

describe('a lead’s request follows the cargo onto the deal', () => {
  it('re-keys on win, so the deal’s own save can stop the clock', async () => {
    const { id } = await openCalcRequest(
      {
        entityType: 'lead',
        entityId: leadId,
        section: 'yolkira',
        fromCity: 'Guangzhou',
        toCity: 'Toshkent',
        weightKg: 100,
        volumeM3: 1,
        items: [{ name: `lamp ${tag()}` }],
        source: 'bot',
      },
      ctx(),
    );
    madeRequests.push(id);
    const moved = await rekeyLeadCalcRequests(leadId, dealId);
    expect(moved).toBe(1);
    const row = await calcRequestDetail(id);
    expect(row!.entityType).toBe('deal');
    expect(row!.entityId).toBe(dealId);
  });
});

describe('the materials are the seller’s own note', () => {
  it('mints the note under the id the files were pre-bound to', async () => {
    const noteId = crypto.randomUUID();
    madeNotes.push(noteId);
    const { id } = await open({
      note: { id: noteId, text: 'invoice ilova' },
      items: [{ name: `cable ${tag()}` }],
    });
    const row = await calcRequestDetail(id);
    expect(row!.noteId).toBe(noteId);
    const note = await db.query.crmActivities.findFirst({ where: eq(crmActivities.id, noteId) });
    expect(note?.note).toBe('invoice ilova');
  });

  it('refuses to ADOPT a note that already exists', async () => {
    // A posted uuid must never attach somebody else's note — and its files —
    // to a request, because the attachment gate widens on exactly this link.
    const noteId = crypto.randomUUID();
    madeNotes.push(noteId);
    await open({ note: { id: noteId, text: 'birinchi' }, items: [{ name: `box ${tag()}` }] });
    await expect(
      openCalcRequest(
        {
          entityType: 'deal',
          entityId: dealId,
          section: 'podklyuch',
          items: [{ name: `box ${tag()}` }],
          note: { id: noteId, text: 'ikkinchi' },
          source: 'card',
        },
        ctx(),
      ),
    ).rejects.toThrow('note_taken');
  });
});
