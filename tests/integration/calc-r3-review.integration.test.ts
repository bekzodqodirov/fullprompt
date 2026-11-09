import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The merged round's review, its wms half (docs/SAKKIZ-R3.md; ship's
 * review-verified.json): the add door's write meets the VED's desktop save
 * (lmp-1, COMP-2), a lone line's copied weight (lmp-2), a waited addition
 * whose words never went out (dur-4), and a parked table's own parser
 * (PF-10). Each case runs the REAL writer — `amendRequest`, `saveTable`,
 * `finishCalcRequest` — with only the queues stood in.
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));
vi.mock('@/modules/wms/calc/prefill-queue', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/prefill-queue')>()),
  ticketStanding: vi.fn(async () => 'none' as const),
  queueCalcPrefill: vi.fn(async () => true),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcAmendments,
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  dealStages,
  events,
  notifications,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { enqueue } from '@/modules/platform/jobs/boss';
import { amendRequest, requeueWaitingAmendments } from '@/modules/wms/calc/amend';
import type { AmendSubmission } from '@/modules/wms/calc/amend-types';
import { landingItems, weightFromTotalNote } from '@/modules/wms/calc/intake';
import { finishCalcRequest, openCalcRequest } from '@/modules/wms/calc/service';
import { loadWorkspace, saveTable } from '@/modules/wms/calc/workspace';
import { startIntake, updateIntake, endIntake } from '@/modules/platform/telegram/calc-store';
import { orphanAnswerSentence, PAUSE_LINE } from '@/modules/platform/telegram/calc-dialog';

const SUFFIX = `${Date.now().toString(36)}${process.pid % 1000}`;
const STAMP = String(Date.now()).slice(-7);
let sellerId = '';
let vedId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const seller = () => ({ actorId: sellerId });
const ved = () => ({ actorId: vedId });

beforeAll(async () => {
  const [s] = await db
    .insert(users)
    .values({ phone: `+99893${STAMP}`, fullName: `R3 review seller ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  sellerId = s!.id;
  const [v] = await db
    .insert(users)
    .values({ phone: `+99894${STAMP}`, fullName: `R3 review VED ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  vedId = v!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `RR${SUFFIX.slice(-6).toUpperCase()}`, name: `R3 review client ${SUFFIX}`, phones: [] })
    .returning();
  clientId = c!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [d] = await db
    .insert(deals)
    .values({ code: `RR-${SUFFIX}`, clientId, stageId: stage!.id, title: 'R3 review', createdBy: sellerId })
    .returning();
  dealId = d!.id;
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcAmendments).where(inArray(calcAmendments.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    await db.execute(sql`DELETE FROM crm_activities WHERE calc_request_id IN (${sql.join(
      madeRequests.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(notifications).where(inArray(notifications.userId, [sellerId, vedId]));
  await db.delete(events).where(eq(events.entityId, dealId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.delete(clients).where(eq(clients.id, clientId));
  // DEACTIVATED, not deleted: audit_log points at them (round 107's rule).
  await db.update(users).set({ active: false }).where(inArray(users.id, [sellerId, vedId]));
  await pgClient.end();
});

async function request(input: Partial<Parameters<typeof openCalcRequest>[0]> = {}): Promise<string> {
  const opened = await openCalcRequest(
    {
      intakeDoor: null,
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      items: [{ name: `Sumka ${SUFFIX}`, quantity: 10, weightKg: 5 }],
      weightKg: 5,
      volumeM3: 1,
      fromCity: null,
      toCity: null,
      source: 'bot',
      ...input,
    },
    seller(),
  );
  madeRequests.push(opened.id);
  return opened.id;
}

const submission = (over: Partial<AmendSubmission>): AmendSubmission => ({
  rowAnswers: [],
  newLines: [],
  totals: null,
  route: null,
  conflicts: [],
  doubtedTotals: [],
  material: [],
  fileCount: 0,
  ...over,
});

const add = (requestId: string, sub: AmendSubmission) =>
  amendRequest({ requestId, staffId: sellerId, staffName: 'R3', noteId: randomUUID(), chatId: BigInt(-9_700_000 - madeRequests.length), submission: sub });

const itemOf = async (requestId: string) =>
  (await db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId)).orderBy(calcRequestItems.seq))[0]!;

describe('the VED’s desktop save over a screen a seller’s addition changed (review lmp-1)', () => {
  it('is refused `amended_since` — the seller’s 50 stays, nothing written', async () => {
    const id = await request();
    const drawn = (await loadWorkspace(id))!.rev;
    const row = await itemOf(id);
    const out = await add(id, submission({ rowAnswers: [{ itemId: row.id, patch: { quantity: 50 } }], material: ['1: 50 dona'] }));
    expect(out.kind).toBe('applied');
    await expect(
      saveTable(id, { items: [{ id: row.id, seq: row.seq, quantity: 12 }], adds: [] }, ved(), { sawRev: drawn }),
    ).rejects.toMatchObject({ code: 'amended_since' });
    expect(Number((await itemOf(id)).quantity)).toBe(50);
  });

  it('passes from a screen drawn after the addition, and after a colleague’s save (his 2b)', async () => {
    const id = await request();
    const row = await itemOf(id);
    await add(id, submission({ rowAnswers: [{ itemId: row.id, patch: { quantity: 50 } }], material: ['1: 50 dona'] }));
    const drawn = (await loadWorkspace(id))!.rev;
    // Another VED's save moves the clock — never a refusal between people.
    await saveTable(id, { items: [{ id: row.id, seq: row.seq, weightKg: 6 }], adds: [] }, ved());
    await saveTable(id, { items: [{ id: row.id, seq: row.seq, quantity: 12 }], adds: [] }, ved(), { sawRev: drawn });
    expect(Number((await itemOf(id)).quantity)).toBe(12);
  });

  it('a save with no screen revision (the machine, the add door, an old tab) is untouched', async () => {
    const id = await request();
    const row = await itemOf(id);
    await add(id, submission({ rowAnswers: [{ itemId: row.id, patch: { quantity: 50 } }], material: ['1: 50 dona'] }));
    await saveTable(id, { items: [{ id: row.id, seq: row.seq, quantity: 12 }], adds: [] }, ved());
    expect(Number((await itemOf(id)).quantity)).toBe(12);
  });
});

describe('«Готово» through P4’s REAL writer (review COMP-2)', () => {
  it('an applied addition after the load refuses the close, and its rev is the one the workspace now reads', async () => {
    const id = await request();
    const before = (await loadWorkspace(id))!.rev;
    const row = await itemOf(id);
    const out = await add(id, submission({ rowAnswers: [{ itemId: row.id, patch: { quantity: 50 } }], material: ['1: 50 dona'] }));
    expect(out.kind).toBe('applied');
    await expect(
      finishCalcRequest(id, { amountText: '480', currency: 'USD', note: 'mijozga', internalNote: 'ichki' }, ved(), before),
    ).rejects.toMatchObject({ code: 'amended_since' });
    const [amendment] = await db.select().from(calcAmendments).where(eq(calcAmendments.requestId, id));
    expect(amendment!.rev).toBe((await loadWorkspace(id))!.rev);
  });
});

describe('a lone line whose weight the landing copied from the brutto (review lmp-2)', () => {
  it('its answered weight leaves the brutto stale and the note no longer says «bruttodan»', async () => {
    const facts = { fromCity: null, toCity: null, weightKg: 500, volumeM3: 2, goods: [{ name: `Kurtka ${SUFFIX}`, quantity: 300 }] };
    const items = landingItems(facts as never);
    const id = await request({ items, weightKg: 500, volumeM3: 2 });
    const row = await itemOf(id);
    expect(weightFromTotalNote(row.note)).toBe('brutto');
    const out = await add(id, submission({ rowAnswers: [{ itemId: row.id, patch: { weightKg: 800 } }], material: ['1: 800 kg'] }));
    expect(out.kind).toBe('applied');
    expect(out.kind === 'applied' ? out.change.totalsStale : null).toContain('weightKg');
    const after = await itemOf(id);
    expect(Number(after.weightKg)).toBe(800);
    expect(weightFromTotalNote(after.note)).toBeNull();
  });

  it('a row with a weight of its own keeps its note and no stale brutto', async () => {
    const id = await request({ items: [{ name: `Shim ${SUFFIX}`, quantity: 20, weightKg: 40, note: 'qora' }], weightKg: 40 });
    const row = await itemOf(id);
    const out = await add(id, submission({ rowAnswers: [{ itemId: row.id, patch: { weightKg: 45 } }], material: ['1: 45 kg'] }));
    expect(out.kind === 'applied' ? out.change.totalsStale : null).toEqual([]);
    expect((await itemOf(id)).note).toBe('qora');
  });
});

describe('a waited addition decided but never told (review dur-4)', () => {
  it('the sweep’s net hands it back to the save job, which says the words once', async () => {
    const id = await request();
    const noteId = randomUUID();
    await db.insert(calcAmendments).values({
      id: randomUUID(),
      requestId: id,
      noteId,
      staffId: sellerId,
      chatId: -9_700_999n,
      outcome: 'to_ved',
      rev: null,
      submission: submission({ material: ['1: 50 dona'] }),
      change: {},
      createdAt: new Date(Date.now() - 10 * 60_000),
    });
    expect(await requeueWaitingAmendments(id)).toBe(1);
    const job = vi.mocked(enqueue).mock.calls.find((c) => c[0] === 'calc.amend-save')?.[1] as { noteId: string } | undefined;
    expect(job?.noteId).toBe(noteId);
  });

  it('one just decided (its own job still telling it) and one already told are left alone', async () => {
    const id = await request();
    for (const [createdAt, outcomeSentAt] of [
      [new Date(), null],
      [new Date(Date.now() - 10 * 60_000), new Date()],
    ] as const) {
      await db.insert(calcAmendments).values({
        id: randomUUID(),
        requestId: id,
        noteId: randomUUID(),
        staffId: sellerId,
        chatId: -9_700_998n,
        outcome: 'noted',
        rev: null,
        submission: submission({}),
        change: {},
        createdAt,
        outcomeSentAt,
      });
    }
    expect(await requeueWaitingAmendments(id)).toBe(0);
  });
});

describe('the untold net leaves a row its collection still holds to the sweep’s settle (fix review fdur-5, fdur-6)', () => {
  const decided = async (id: string, noteId: string) =>
    db.insert(calcAmendments).values({
      id: randomUUID(),
      requestId: id,
      noteId,
      staffId: sellerId,
      chatId: -9_700_997n,
      outcome: 'noted',
      rev: null,
      submission: submission({ material: ['1: 50 dona'] }),
      change: {},
      createdAt: new Date(Date.now() - 10 * 60_000),
    });

  it('a FRESH save whose words failed (its collection frozen) is not handed back as a waited run', async () => {
    const id = await request();
    const noteId = randomUUID();
    await decided(id, noteId);
    // The frozen collection's durable row, as the store writes it.
    const chat = -9_700_996n;
    await db.execute(sql`
      INSERT INTO telegram_calc_intakes (chat_id, staff_id, note_id, state, opened_at, touched_at, expires_at)
      VALUES (${String(chat)}::bigint, ${sellerId}::uuid, ${noteId}::uuid, '{"stage":"review"}'::jsonb, now(), now(), now() + interval '1 day')`);
    try {
      expect(await requeueWaitingAmendments(id)).toBe(0);
    } finally {
      await db.execute(sql`DELETE FROM telegram_calc_intakes WHERE chat_id = ${String(chat)}::bigint`);
    }
    // Its collection gone, the net is its only teller again.
    expect(await requeueWaitingAmendments(id)).toBe(1);
  });

  it('a row past the day is named in the log ONCE, by what is owed (fix review FR-7)', async () => {
    const { logger } = await import('@/modules/platform/logger');
    const id = await request();
    await db.insert(calcAmendments).values({
      id: randomUUID(),
      requestId: id,
      noteId: randomUUID(),
      staffId: sellerId,
      chatId: -9_700_995n,
      outcome: 'to_ved',
      rev: null,
      submission: submission({}),
      change: {},
      createdAt: new Date(Date.now() - 30 * 3_600_000),
    });
    const warn = vi.spyOn(logger, 'warn');
    try {
      expect(await requeueWaitingAmendments(id)).toBe(0);
      expect(await requeueWaitingAmendments(id)).toBe(0);
      const named = warn.mock.calls.filter((c) => String(c[1] ?? '').includes('older than a day') || String(c[1] ?? '').includes('over a day ago'));
      expect(named).toHaveLength(1);
      expect(String(named[0]![1])).toContain('words never reached the seller');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a PARKED table’s own answer is the pause line, never the paid assistant (review PF-10)', () => {
  const chat = BigInt(-9_700_500);
  const parked = () => {
    startIntake(chat, 'rastamojka', { staffId: sellerId });
    return updateIntake(
      chat,
      { stage: 'review', facts: { goods: [{ name: 'Shapka qishki', quantity: null }, { name: 'Kurtka', quantity: 5, weightKg: 10 }] } },
      { quiet: true },
    )!;
  };

  it('«Shapka 30 dona» to a parked table that has a Shapka row', async () => {
    const said = await orphanAnswerSentence('Shapka 30 dona', parked());
    expect(said?.text).toBe(PAUSE_LINE);
    endIntake(chat);
  });

  it('a question with no row it answers still goes on; with no collection the guard is §2.8’s, unchanged', async () => {
    expect(await orphanAnswerSentence('Shapka narxi qancha bo‘ladi?', parked())).toBeNull();
    expect(await orphanAnswerSentence('Kurtka 300 dona boj qancha?', parked())).toBeNull();
    endIntake(chat);
    expect(await orphanAnswerSentence('Shapka 30 dona', null)).toBeNull();
  });
});


describe('a line added beyond a returned request’s rows leaves its brutto behind (review COMP-4)', () => {
  const chat = BigInt(-9_700_600);
  it('the seeded table asks «yangilansinmi?» — and not before a line was added', async () => {
    const { tableContext } = await import('@/modules/platform/telegram/calc-dialog');
    const seed = [{ name: 'Sumka', quantity: 10 }, { name: 'Krossovka', quantity: 20 }];
    startIntake(chat, 'podklyuch', { staffId: sellerId });
    const state = updateIntake(
      chat,
      { stage: 'review', seed, facts: { weightKg: 500, volumeM3: 2, fromCity: 'Yiwu', toCity: 'Toshkent', goods: seed } },
      { quiet: true },
    )!;
    expect((await tableContext(state)).stale).toEqual([]);
    const added = updateIntake(chat, { facts: { ...state.facts, goods: [...seed, { name: 'Shim', quantity: 5 }] } }, { quiet: true })!;
    expect((await tableContext(added)).stale).toEqual(['weightKg']);
    // The TABLE the seller reads asks it (fix review FR-4): the stale list
    // was computed and rode only inside `amend`, null on a seeded collection,
    // so the drawn table read «✅ Og‘irlik (brutto): 500 kg … Ma’lumot to‘liq».
    const drawn = await drawnTable(added);
    expect(drawn.text).toContain('⚠️ umumiy brutto og‘irligi (kg) — yangi tovar qo‘shildi, yangilansinmi? «jami … kg»');
    expect(drawn.text).not.toContain('✅ Og‘irlik (brutto): 500 kg');
    expect(drawn.text).not.toContain('Ma’lumot to‘liq');
    expect(drawn.open).toContainEqual({ totals: 'weightKg' });
    // …and once he answers the brutto, it stands.
    const answered = updateIntake(chat, { totalsAnswer: { ...added.totalsAnswer, weightKg: 620 } }, { quiet: true })!;
    expect((await tableContext(answered)).stale).toEqual([]);
    expect((await drawnTable(answered)).text).not.toContain('yangilansinmi');
    endIntake(chat);
  });

  it('an add table whose answered weight is a row the landing copied from the brutto asks it too (review lmp-2)', async () => {
    const { tableContext } = await import('@/modules/platform/telegram/calc-dialog');
    const { storedRequestFacts } = await import('@/modules/wms/calc/service');
    const facts = { fromCity: null, toCity: null, weightKg: 500, volumeM3: 2, goods: [{ name: `Palto ${SUFFIX}`, quantity: 30 }] };
    const id = await request({ items: landingItems(facts as never), weightKg: 500, volumeM3: 2 });
    const stored = (await storedRequestFacts(id))!;
    startIntake(chat, 'rastamojka', { staffId: sellerId, amend: stored.base });
    const goods = (stored.facts.goods ?? []).map((g) => ({ ...g, weightKg: 800 }));
    const state = updateIntake(chat, { stage: 'review', facts: { ...stored.facts, goods } }, { quiet: true })!;
    expect((await tableContext(state)).stale).toContain('weightKg');
    // No line was ADDED (fix review W-2): the brutto is asked, and the table
    // does not say a new item came.
    const drawn = await drawnTable(state);
    expect(drawn.text).toContain('⚠️ umumiy brutto og‘irligi (kg) — yangilansinmi? «jami … kg»');
    expect(drawn.text).not.toContain('yangi tovar qo‘shildi');
    endIntake(chat);
  });
});

/** The table the seller is SENT over a state — the reading's own renderer, its laws and stale totals. */
async function drawnTable(state: Parameters<typeof import('@/modules/platform/telegram/calc-dialog').tableContext>[0]) {
  const { tableContext, intakeNextStep } = await import('@/modules/platform/telegram/calc-dialog');
  const tc = await tableContext(state);
  const step = intakeNextStep(state, tc.laws, tc.intake, { stale: tc.stale, nameWord: tc.nameWord });
  // The parser's targets as a SEEDED table has them (no `amend`).
  return { text: step.text, open: tc.intake.tableOpenOf({ section: state.section, facts: state.facts, laws: tc.laws, amend: null, totalsStale: tc.stale }) };
}

describe('the redo’s «was the re-pass answered» probe is the seller’s own row (review lmp-3)', () => {
  it('a CalcPrefilled for somebody else naming the same pass does not stand for his answer', async () => {
    const { queueCalcPrefill } = await import('@/modules/wms/calc/prefill-queue');
    const { amendmentById, redoAmendment } = await import('@/modules/wms/calc/amend');
    const id = await request();
    const row = await itemOf(id);
    const out = await add(id, submission({ rowAnswers: [{ itemId: row.id, patch: { quantity: 60 } }], material: ['1: 60 dona'] }));
    expect(out.kind).toBe('applied');
    const amendmentId = out.kind === 'applied' ? out.amendmentId : '';
    // The re-pass never reached the queue: the redo owes it.
    await db.update(calcAmendments).set({ change: sql`${calcAmendments.change} - 'repassQueued'` }).where(eq(calcAmendments.id, amendmentId));
    await db.insert(notifications).values({
      userId: vedId,
      channel: 'telegram',
      type: 'CalcPrefilled',
      status: 'sent',
      payload: { requestId: id, pass: `amend:${amendmentId}` },
    });
    vi.mocked(queueCalcPrefill).mockClear();
    await redoAmendment((await amendmentById(amendmentId))!, sellerId);
    expect(vi.mocked(queueCalcPrefill)).toHaveBeenCalledTimes(1);
  });
});
