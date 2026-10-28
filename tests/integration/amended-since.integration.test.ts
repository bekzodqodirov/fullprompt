import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcAmendments,
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  deals,
  dealStages,
  events,
  notifications,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { finishCalcRequest, openCalcRequest } from '@/modules/wms/calc/service';
import {
  confirmAllGroups,
  confirmGroup,
  loadWorkspace,
  saveTable,
  sealCalc,
  setFreightZone,
} from '@/modules/wms/calc/workspace';

/**
 * P6 «Ko‘rdim» (docs/SAKKIZ-R3.md §10A, law-money-3): the VED's four official
 * doors refuse a press made over a screen a seller's addition has since
 * changed.
 *
 * The add door (his 1.9 a) writes into a request while no PERSON has saved on
 * it, so a seller's «2: 40 juft» can land between the VED's page load and the
 * press — and each door compared only what it computed AT the press, which
 * already holds the seller's figures. «Готово» would answer for goods the VED
 * never saw (the upsale floor, the card's lock, the channel's post, the
 * CalcDone push), and a ✅ would record them as «what stood on the screen».
 *
 * «A load at rev N» is `loadWorkspace(id).rev` — exactly the number the page
 * hands every door as `sawRev`. The addition is written here by
 * `sellerAddition`, the add door's APPLIED write as §9.5 states it (the row
 * lock, the clock and the hands-off stamp moved, the amendment row carrying
 * the revision it left, one transaction). P4's `amendRequest` is that writer
 * in the merged tree; this file stands in for it so the refusal can be proven
 * on its own, and the predicate reads nothing else.
 */
const SUFFIX = `${Date.now().toString(36)}${process.pid % 1000}`;
let seq = 0;
const tag = () => `KRD-${SUFFIX}-${(seq += 1)}`;

let vedId = '';
let sellerId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const ved = () => ({ actorId: vedId });
const seller = () => ({ actorId: sellerId });

const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

beforeAll(async () => {
  const stamp = String(Date.now()).slice(-7);
  const [a] = await db
    .insert(users)
    .values({ phone: `+99891${stamp}`, fullName: `Ko‘rdim VED ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  vedId = a!.id;
  const [s] = await db
    .insert(users)
    .values({ phone: `+99892${stamp}`, fullName: `Ko‘rdim seller ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  sellerId = s!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `KR${SUFFIX.slice(-6).toUpperCase()}`, name: `Ko‘rdim client ${SUFFIX}`, phones: [] })
    .returning();
  clientId = c!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [d] = await db
    .insert(deals)
    .values({ code: `KR-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Ko‘rdim fixture', createdBy: sellerId })
    .returning();
  dealId = d!.id;
});

afterAll(async () => {
  // A holder left inside a transaction by a failed test would keep the row
  // locked for the cleanup below.
  await holder`ROLLBACK`.catch(() => undefined);
  await holder.end();
  if (madeRequests.length > 0) {
    await db.delete(calcAmendments).where(inArray(calcAmendments.requestId, madeRequests));
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  await db.delete(notifications).where(inArray(notifications.userId, [vedId, sellerId]));
  await db.delete(events).where(eq(events.entityId, dealId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.delete(clients).where(eq(clients.id, clientId));
  // DEACTIVATED, not deleted: audit_log points at them (round 107's rule).
  await db.update(users).set({ active: false }).where(inArray(users.id, [vedId, sellerId]));
  await pgClient.end();
});

/** A rastamojka job with no code: nothing can price it, so «Готово» is its
 * only close — exactly the job 2.8 b asks a count for. */
async function answerableRequest(): Promise<string> {
  const opened = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items: [{ name: `sumka ${tag()}`, quantity: 100 }],
      source: 'card',
    },
    seller(),
  );
  madeRequests.push(opened.id);
  return opened.id;
}

/** A coded, priced job with ONE group, unconfirmed (the ✅ doors), or
 * confirmed (one press from the seal). */
async function groupedRequest(confirm: boolean): Promise<{ id: string; groupId: string }> {
  const id = await answerableRequest();
  const [item] = await db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, id));
  await saveTable(
    id,
    { items: [{ id: item!.id, seq: item!.seq, tnvedCode: '8528520000', bazaUsd: 20, bazaBasis: 'unit' }], adds: [] },
    ved(),
  );
  const [group] = await db.select().from(calcGroups).where(eq(calcGroups.requestId, id));
  if (confirm) {
    const screen = await loadWorkspace(id);
    await confirmAllGroups(id, ved(), screen!.rev);
  }
  return { id, groupId: group!.id };
}

/**
 * The add door's write as §9.5 states it, in one transaction under the row
 * lock: an APPLIED addition moves the clock and the hands-off stamp, changes
 * the row («2: 40 dona» — quantity +40) and records the revision it left; a
 * `to_ved` one writes no row and no revision. Returns the clock after it.
 */
async function sellerAddition(id: string, outcome: 'applied' | 'to_ved' = 'applied'): Promise<number> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.execute<{ rev: number }>(
      sql`SELECT rev FROM calc_requests WHERE id = ${id}::uuid FOR UPDATE`,
    );
    let rev: number | null = null;
    if (outcome === 'applied') {
      rev = locked!.rev + 1;
      await tx.execute(sql`UPDATE calc_request_items SET quantity = quantity + 40 WHERE request_id = ${id}::uuid`);
      await tx.execute(
        sql`UPDATE calc_requests SET rev = ${rev}::int, handsoff_rev = ${rev}::int WHERE id = ${id}::uuid`,
      );
    }
    await tx.insert(calcAmendments).values({
      id: randomUUID(),
      requestId: id,
      noteId: randomUUID(),
      staffId: sellerId,
      chatId: 1n,
      outcome,
      rev,
      submission: {},
      change: {},
    });
    return rev ?? locked!.rev;
  });
}

const ANSWER = { amountText: '480', currency: 'USD', note: 'mijozga', internalNote: 'ichki: qo‘lda' };
const SEAL = { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null };

async function calcDoneCount(): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, sellerId), eq(notifications.type, 'CalcDone')));
  return rows.length;
}

/** Observe (never assume) that the door's statement is queued on the request
 * row — the clock suite's probe, through the POOL (a holder's own snapshot
 * freezes inside its transaction). THIS database only, never this session
 * (review adv-3): `pg_stat_activity` is cluster-wide, and a neighbour's test in
 * another database waiting on its own `calc_requests` would end the wait
 * before the close has queued — the race case would then run AFTER the commit
 * and stay green with the lock-first fix removed. Not narrowed to `FOR
 * UPDATE`: the red proof that drops the lock must still be OBSERVED waiting
 * (its bare UPDATE is the statement that queues). */
async function waitForBlockedOnRequests(early: Promise<unknown>): Promise<void> {
  let settled: unknown = null;
  void early.then(
    (v) => (settled = { early: v }),
    (e) => (settled = { earlyError: String(e) }),
  );
  for (let i = 0; i < 400; i++) {
    if (settled) throw new Error('settled EARLY: ' + JSON.stringify(settled));
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND datname = current_database()
         AND pid <> pg_backend_pid()
         AND query ILIKE '%calc_requests%'
    `);
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the door never queued on the request row');
}

describe('«Готово» over a screen a seller’s addition changed', () => {
  it('is refused: nothing ended, no price, no CalcDone', async () => {
    const id = await answerableRequest();
    const screen = await loadWorkspace(id);
    const n = screen!.rev;
    expect(await sellerAddition(id)).toBe(n + 1);

    await expect(finishCalcRequest(id, ANSWER, ved(), n)).rejects.toMatchObject({ code: 'amended_since' });
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.completedAt, 'the job stays open').toBeNull();
    expect(row!.answerAmount).toBeNull();
    expect(await calcDoneCount(), 'the seller is told nothing').toBe(0);
  });

  it('passes from a screen drawn after the addition — and the push is real', async () => {
    const id = await answerableRequest();
    await sellerAddition(id);
    const screen = await loadWorkspace(id);
    const told = await calcDoneCount();
    await finishCalcRequest(id, ANSWER, ved(), screen!.rev);
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.completedAt).not.toBeNull();
    expect(Number(row!.answerAmount)).toBe(480);
    // The probe above is not vacuous: a close that happens is told.
    expect(await calcDoneCount()).toBe(told + 1);
  });

  it('a VED save after the load moves the clock and trips nothing', async () => {
    const id = await answerableRequest();
    const n = (await loadWorkspace(id))!.rev;
    // The VED's own write (the zone door — a person's save, no amendment).
    await setFreightZone(id, 'cn', ved());
    expect((await loadWorkspace(id))!.rev).toBe(n + 1);
    await finishCalcRequest(id, ANSWER, ved(), n);
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.completedAt).not.toBeNull();
  });

  it('a to_ved addition after the load changed no row and trips nothing', async () => {
    const id = await answerableRequest();
    const n = (await loadWorkspace(id))!.rev;
    expect(await sellerAddition(id, 'to_ved')).toBe(n);
    await finishCalcRequest(id, ANSWER, ved(), n);
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.completedAt).not.toBeNull();
  });

  it('an addition committed WHILE the close waits for the row is refused by the close itself', async () => {
    // The race §10A.2.1 names: the pooled reads have run, the close is on
    // its way, and the add door's write holds the request row. The holder
    // stands in for that write; the close is OBSERVED waiting, then the
    // addition commits.
    const id = await answerableRequest();
    const n = (await loadWorkspace(id))!.rev;
    const told = await calcDoneCount();
    await holder`BEGIN`;
    await holder`SELECT id FROM calc_requests WHERE id = ${id}::uuid FOR UPDATE`;
    const closing = finishCalcRequest(id, ANSWER, ved(), n).then(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, e }),
    );
    await waitForBlockedOnRequests(closing);
    await holder`UPDATE calc_request_items SET quantity = quantity + 40 WHERE request_id = ${id}::uuid`;
    await holder`UPDATE calc_requests SET rev = rev + 1, handsoff_rev = rev + 1 WHERE id = ${id}::uuid`;
    await holder`
      INSERT INTO calc_amendments (id, request_id, note_id, staff_id, chat_id, outcome, rev, submission, change)
      VALUES (${randomUUID()}::uuid, ${id}::uuid, ${randomUUID()}::uuid, ${sellerId}::uuid, 1, 'applied',
              ${n + 1}::int, '{}'::jsonb, '{}'::jsonb)`;
    await holder`COMMIT`;

    const outcome = await closing;
    expect(outcome.ok, 'the close must not answer for the added goods').toBe(false);
    if (!outcome.ok) expect(outcome.e).toMatchObject({ code: 'amended_since' });
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.completedAt).toBeNull();
    expect(await calcDoneCount(), 'the seller is told nothing').toBe(told);
  });

  it('closed meanwhile → already_closed, never «amended»', async () => {
    const id = await answerableRequest();
    const n = (await loadWorkspace(id))!.rev;
    await holder`BEGIN`;
    await holder`SELECT id FROM calc_requests WHERE id = ${id}::uuid FOR UPDATE`;
    const closing = finishCalcRequest(id, ANSWER, ved(), n).then(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, e }),
    );
    await waitForBlockedOnRequests(closing);
    await holder`
      UPDATE calc_requests SET completed_at = now(), completed_by = ${vedId}::uuid, completed_via = 'returned',
             return_reason = 'boshqa VED qaytardi'
       WHERE id = ${id}::uuid`;
    await holder`COMMIT`;
    const outcome = await closing;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.e).toMatchObject({ code: 'already_closed' });
  });

  it('a revision that is not a whole number is refused, never read as «nothing newer»', async () => {
    const id = await answerableRequest();
    await sellerAddition(id);
    for (const bad of [Number.NaN, 0.5, -1, Number.POSITIVE_INFINITY]) {
      await expect(finishCalcRequest(id, ANSWER, ved(), bad)).rejects.toMatchObject({ code: 'validation' });
    }
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.completedAt).toBeNull();
  });
});

describe('a group’s ✅ over a screen a seller’s addition changed', () => {
  it('is refused, and nothing is stamped', async () => {
    const { id, groupId } = await groupedRequest(false);
    const n = (await loadWorkspace(id))!.rev;
    await sellerAddition(id);
    await expect(confirmGroup(groupId, ved(), 'single', n)).rejects.toMatchObject({ code: 'amended_since' });
    const [group] = await db.select().from(calcGroups).where(eq(calcGroups.id, groupId));
    expect(group!.confirmedAt).toBeNull();
    expect(group!.confirmedWarnings).toBeNull();
  });

  it('the phone’s ✅ is the same door', async () => {
    const { id, groupId } = await groupedRequest(false);
    const n = (await loadWorkspace(id))!.rev;
    await sellerAddition(id);
    await expect(confirmGroup(groupId, ved(), 'phone', n)).rejects.toMatchObject({ code: 'amended_since' });
  });

  it('passes over the current screen, and after the VED’s own save', async () => {
    const { id, groupId } = await groupedRequest(false);
    await sellerAddition(id);
    const fresh = (await loadWorkspace(id))!.rev;
    // The VED's own save after this screen moves the clock, not the answer.
    await setFreightZone(id, 'cn', ved());
    await confirmGroup(groupId, ved(), 'single', fresh);
    const [group] = await db.select().from(calcGroups).where(eq(calcGroups.id, groupId));
    expect(group!.confirmedAt).not.toBeNull();
    expect(group!.confirmVia).toBe('single');
  });

  it('a to_ved addition trips nothing', async () => {
    const { id, groupId } = await groupedRequest(false);
    const n = (await loadWorkspace(id))!.rev;
    await sellerAddition(id, 'to_ved');
    await confirmGroup(groupId, ved(), 'single', n);
    const [group] = await db.select().from(calcGroups).where(eq(calcGroups.id, groupId));
    expect(group!.confirmedAt).not.toBeNull();
  });
});

describe('«✅ Hammasini» over a screen a seller’s addition changed', () => {
  it('is refused, and no group is stamped', async () => {
    const { id, groupId } = await groupedRequest(false);
    const n = (await loadWorkspace(id))!.rev;
    await sellerAddition(id);
    await expect(confirmAllGroups(id, ved(), n)).rejects.toMatchObject({ code: 'amended_since' });
    const [group] = await db.select().from(calcGroups).where(eq(calcGroups.id, groupId));
    expect(group!.confirmedAt).toBeNull();
  });

  it('passes over the current screen; a to_ved addition trips nothing', async () => {
    const a = await groupedRequest(false);
    await sellerAddition(a.id);
    expect(await confirmAllGroups(a.id, ved(), (await loadWorkspace(a.id))!.rev)).toBe(1);
    const b = await groupedRequest(false);
    const n = (await loadWorkspace(b.id))!.rev;
    await sellerAddition(b.id, 'to_ved');
    expect(await confirmAllGroups(b.id, ved(), n)).toBe(1);
  });

  it('a VED save after the load trips nothing (review spec-4)', async () => {
    const { id } = await groupedRequest(false);
    const n = (await loadWorkspace(id))!.rev;
    await setFreightZone(id, 'cn', ved());
    expect((await loadWorkspace(id))!.rev).toBe(n + 1);
    expect(await confirmAllGroups(id, ved(), n)).toBe(1);
  });
});

describe('the seal over a screen a seller’s addition changed', () => {
  // Reachable only from a screen drawn before the addition whose ✅s were
  // pressed elsewhere (a ✅ ends «hands-off», so no addition is APPLIED after
  // one); the seal asks anyway — a rule on three of four doors is #531. The
  // fixture writes the addition after the ✅ for that reason.
  it('is refused: no version, the request open', async () => {
    const { id } = await groupedRequest(true);
    const n = (await loadWorkspace(id))!.rev;
    await sellerAddition(id);
    await expect(sealCalc(id, { ...SEAL, sawRev: n }, ved())).rejects.toMatchObject({ code: 'amended_since' });
    expect(await db.select().from(calcVersions).where(eq(calcVersions.requestId, id))).toHaveLength(0);
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.completedAt).toBeNull();
  });

  it('passes over the current screen, sealing the added goods', async () => {
    const { id } = await groupedRequest(true);
    await sellerAddition(id);
    const screen = await loadWorkspace(id);
    const sealed = await sealCalc(id, { ...SEAL, sawRev: screen!.rev }, ved());
    expect(sealed.versionNo).toBe(1);
    const [version] = await db.select().from(calcVersions).where(eq(calcVersions.requestId, id));
    // 140 × $20 is what was on the screen — the addition is in the price.
    const groups = (version!.breakdown as { groups: { items: { quantity: number | null }[] }[] }).groups;
    expect(groups[0]!.items[0]!.quantity).toBe(140);
  });

  it('a VED save after the load trips nothing', async () => {
    const { id } = await groupedRequest(true);
    const n = (await loadWorkspace(id))!.rev;
    await setFreightZone(id, 'cn', ved());
    const sealed = await sealCalc(id, { ...SEAL, sawRev: n }, ved());
    expect(sealed.versionNo).toBe(1);
  });

  it('a to_ved addition after the load trips nothing (review spec-4)', async () => {
    const { id } = await groupedRequest(true);
    const n = (await loadWorkspace(id))!.rev;
    expect(await sellerAddition(id, 'to_ved')).toBe(n);
    const sealed = await sealCalc(id, { ...SEAL, sawRev: n }, ved());
    expect(sealed.versionNo).toBe(1);
  });
});
