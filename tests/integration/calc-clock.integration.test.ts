import 'dotenv/config';
import postgres from 'postgres';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  deals,
  dealStages,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { confirmAllGroups, confirmGroup, saveTable, sealCalc } from '@/modules/wms/calc/workspace';

/**
 * The revision clock, end to end (VED 2.0 phase 3 — the shipped-audit's
 * finding closed and proven).
 *
 * The seal computes on pool reads and then CASes on `calc_requests.rev`
 * under FOR UPDATE. The audit's claim: a save committing between the compute
 * and the seal's transaction used to seal the PRE-save snapshot — the CAS on
 * `completed_at` alone still passed. The proof here is DETERMINISTIC, round
 * 103's shape: a second connection holds the request row FOR UPDATE *before*
 * the seal is called, the seal's tx is observed WAITING via pg_locks (never
 * a sleep-and-hope), and the concurrent change lands as raw SQL inside the
 * holder's own transaction — a real saveTable cannot be the writer, because
 * its own lock would queue BEHIND the blocked seal.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `VEDC-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

const holder = postgres(process.env.DATABASE_URL!, { max: 1 });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99895${String(Date.now()).slice(-7)}`,
      fullName: `VED clock fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `VC${SUFFIX}`, name: `VED clock fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `VC-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'VED clock fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;
});

afterAll(async () => {
  await holder.end();
  if (madeRequests.length > 0) {
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
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

/** A request one press from sealing: coded, priced, confirmed. Rastamojka
 * section, so no freight fixture is needed; the fee reads the demo book's
 * UZS rate and the seeded BHM setting. */
async function sealableRequest(): Promise<string> {
  const opened = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items: [{ name: `monitor ${tag()}`, quantity: 100 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(opened.id);
  const items = await db
    .select()
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, opened.id));
  await saveTable(
    opened.id,
    {
      items: [
        {
          id: items[0]!.id,
          seq: items[0]!.seq,
          tnvedCode: '8528520000',
          bazaUsd: 20,
          bazaBasis: 'unit',
        },
      ],
      adds: [],
    },
    ctx(),
  );
  await confirmAllGroups(opened.id, ctx());
  return opened.id;
}

const SEAL_INPUT = {
  discountUsd: 0,
  discountReason: null,
  bandOverrideMin: null,
  bandOverrideReason: null,
};

/** Observe (never assume) that a backend is queued on the request row. */
async function waitForBlockedOnRequests(early?: Promise<unknown>): Promise<void> {
  let settled: unknown = null;
  void early?.then(
    (v) => (settled = { early: v }),
    (e) => (settled = { earlyError: String(e) }),
  );
  for (let i = 0; i < 400; i++) {
    if (settled) throw new Error('settled EARLY: ' + JSON.stringify(settled));
    // A blocked row-lock waiter holds its TUPLE lock granted and waits on
    // the holder's TRANSACTIONID lock (relation NULL in pg_locks) — so the
    // observable fact is the backend's wait state. Polled through the POOL,
    // never the holder: pg_stat_activity's snapshot FREEZES inside an open
    // transaction, so the holder would re-read its pre-block snapshot for
    // ever (measured — the first version of this test did exactly that).
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND query ILIKE '%calc_requests%for update%'
    `);
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the seal never queued on the request row — the lock is gone');
}

describe('the seal-clock CAS', () => {
  it('a change committing between the compute and the seal tx is REFUSED, and the retry seals the truth', async () => {
    const id = await sealableRequest();

    // The holder takes the row BEFORE the seal is called…
    await holder`BEGIN`;
    await holder`SELECT id FROM calc_requests WHERE id = ${id}::uuid FOR UPDATE`;

    // …so the seal computes on the pool, then its tx queues on the lock.
    const sealing = sealCalc(id, SEAL_INPUT, ctx()).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    await waitForBlockedOnRequests(sealing);

    // The concurrent change lands INSIDE the holder's tx: a rate moved and
    // the clock with it (what every mutator does under its own lock).
    await holder`
      UPDATE calc_groups SET duty_pct = '11.000'
       WHERE request_id = ${id}::uuid
    `;
    await holder`UPDATE calc_requests SET rev = rev + 1 WHERE id = ${id}::uuid`;
    await holder`COMMIT`;

    const outcome = await sealing;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.e).toMatchObject({ code: 'conflict' });
    // Nothing sealed, nothing closed — the request is still open.
    const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(request!.completedAt).toBeNull();
    expect(await db.select().from(calcVersions).where(eq(calcVersions.requestId, id))).toHaveLength(0);

    // The re-press computes over the NEW numbers and seals them: 100 × $20 =
    // $2,000 value; 11 % duty $220; VAT 12 % of $2,220 = $266.40 → customs
    // $486.40 + 1 BHM fee at the demo book's rate — the version's own figure
    // proves which snapshot was sealed.
    const sealed = await sealCalc(id, SEAL_INPUT, ctx());
    expect(sealed.versionNo).toBe(1);
    const [version] = await db.select().from(calcVersions).where(eq(calcVersions.requestId, id));
    expect(Number(version!.customsUsd)).toBeGreaterThan(486);
  });

  it('a confirm whose warnings predate a save is REFUSED the same way', async () => {
    const id = await sealableRequest();
    const [group] = await db.select().from(calcGroups).where(eq(calcGroups.requestId, id));
    // Un-confirm so the door has something to do.
    await db
      .update(calcGroups)
      .set({ confirmedBy: null, confirmedAt: null, confirmVia: null, confirmedWarnings: null })
      .where(eq(calcGroups.id, group!.id));

    await holder`BEGIN`;
    await holder`SELECT id FROM calc_requests WHERE id = ${id}::uuid FOR UPDATE`;
    const confirming = confirmGroup(group!.id, ctx()).then(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, e }),
    );
    await waitForBlockedOnRequests(confirming);
    await holder`UPDATE calc_requests SET rev = rev + 1 WHERE id = ${id}::uuid`;
    await holder`COMMIT`;

    const outcome = await confirming;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.e).toMatchObject({ code: 'conflict' });
    // The record E1 reads was never stamped over dead numbers.
    const [after] = await db.select().from(calcGroups).where(eq(calcGroups.id, group!.id));
    expect(after!.confirmedAt).toBeNull();
  });
});
