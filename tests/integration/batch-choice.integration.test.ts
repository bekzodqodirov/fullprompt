import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** The routes' door, swapped for a switch (import-stats.integration's idiom). */
const gate = vi.hoisted(() => ({ actorId: '' }));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    authorize: async () =>
      ({ id: gate.actorId, permissions: new Set(['ved.docs']), roles: [], warehouseIds: [] }) as unknown as Awaited<
        ReturnType<typeof real.authorize>
      >,
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  customsImportBatches,
  deals,
  dealStages,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { batchesForCodes, newestReadyBatchId } from '@/modules/wms/customs/import-service';
import { normalizeName } from '@/modules/wms/customs/import-parse';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { saveTable } from '@/modules/wms/calc/workspace';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { GET as listRoute } from '@/app/api/calc/import-baza/route';
import { GET as statsRoute } from '@/app/api/calc/import-baza/stats/route';

/**
 * WHICH quarter answers a code (docs/SAKKIZ-R2.md §7.3).
 *
 * «The newest ready file» answered every code until round 2 — so a code the
 * newest file was silent or nearly silent about found nothing, or a sample of
 * two, while last quarter's full file sat beside it with fifty. The chooser
 * is per CODE: enough rows first, then the newer quarter, then more rows,
 * then the one order of «newest». Every ordering below is a pair of batches
 * that disagree under every rule but the one the test names.
 *
 * Dates are LAST year's quarters, so no batch here is clamped to its upload
 * day and no run lands on a quarter boundary. Codes are `95` + the run's
 * digits — unique to this file.
 *
 * CONFIGURATION WARNING (#183): a READY batch answers every save of its codes
 * while it lives; each test drops its own, `afterAll` the rest.
 */
const SUFFIX = String(Date.now()).slice(-6);
const code = (n: number) => `95${SUFFIX}${String(n).padStart(2, '0')}`;
const lastYear = Number(tashkentDay().slice(0, 4)) - 1;
const Q2 = { from: `${lastYear}-04-01`, to: `${lastYear}-06-30` };
const Q3 = { from: `${lastYear}-07-01`, to: `${lastYear}-09-30` };
const JUNE = { from: `${lastYear}-06-01`, to: `${lastYear}-06-30` };

let actorId = '';
let clientId = '';
let dealId = '';
const madeBatches: string[] = [];
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

async function mintBatch(period: { from: string; to: string }, agoSec: number, label: string): Promise<string> {
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to, uploaded_at)
    VALUES (${`${label}-${SUFFIX}.xlsx`}, ${actorId}::uuid, 'ready', ${period.from}::date, ${period.to}::date,
            now() - make_interval(secs => ${agoSec}))
    RETURNING id::text AS id`);
  madeBatches.push(row!.id);
  return row!.id;
}

/** `n` China declarations of `tnved` per kg, named alike. */
async function addRows(batchId: string, tnved: string, n: number) {
  const name = `Plastmassa o‘yinchoq BC${SUFFIX}`;
  await db.execute(sql`
    INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
    SELECT ${batchId}::uuid, ${tnved}, ${name}, ${normalizeName(name)}, 'kg', (1 + g)::numeric, '156-КИТАЙ'
      FROM generate_series(1, ${n}) g`);
}

async function drop(ids: string[]) {
  if (ids.length > 0) await db.delete(customsImportBatches).where(inArray(customsImportBatches.id, ids));
}

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99896${String(Date.now()).slice(-7)}`, fullName: `Chooser fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  gate.actorId = actorId;
  const [client] = await db.insert(clients).values({ clientCode: `BC${SUFFIX}`, name: `Chooser fixture ${SUFFIX}` }).returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `BC-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Chooser fixture', createdBy: actorId })
    .returning();
  dealId = deal!.id;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
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
  await drop(madeBatches);
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

/** One request with one row coded `tnved` — the routes read a saved row. */
async function rowCoded(tnved: string): Promise<string> {
  const result = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items: [{ name: `Plastmassa o‘yinchoq BC${SUFFIX}`, tnvedCode: tnved, weightKg: 50 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(result.id);
  await saveTable(result.id, { items: [], adds: [] }, ctx());
  const [item] = await db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, result.id));
  return item!.id;
}

const chosen = async (tnved: string) => (await batchesForCodes([tnved])).get(tnved);

describe('the chooser answers per code', () => {
  it('(a) the newest batch lacks the code → an older batch that holds it answers', async () => {
    const c = code(1);
    const older = await mintBatch(Q2, 120, 'BC-a-older');
    const newer = await mintBatch(Q3, 60, 'BC-a-newer');
    await addRows(older, c, 6);
    await addRows(newer, code(2), 6);
    expect((await chosen(c))?.batchId).toBe(older);
    expect((await chosen(c))?.rows).toBe(6);
    expect((await chosen(c))?.endDate).toBe(Q2.to);
    await drop([older, newer]);
  });

  it('(a2) a HEADING is chosen for by its subheadings’ rows — the range, not the heading’s own digits', async () => {
    // Review P2-10's rewrite binds each code's two bounds (`codeBounds`) into
    // one VALUES list; a heading's upper bound is what reaches its
    // subheadings. No declaration carries the eight digits themselves.
    const heading = `95${SUFFIX}`;
    const older = await mintBatch(Q2, 120, 'BC-a2-older');
    const newer = await mintBatch(Q3, 60, 'BC-a2-newer');
    await addRows(older, code(10), 6);
    expect((await chosen(heading))?.batchId).toBe(older);
    expect((await chosen(heading))?.rows).toBe(6);
    await drop([older, newer]);
  });

  it('(b) a full Q2 uploaded BEFORE a June sample of the same end → the full quarter', async () => {
    const c = code(3);
    const full = await mintBatch(Q2, 120, 'BC-b-full');
    const sample = await mintBatch(JUNE, 60, 'BC-b-sample');
    await addRows(full, c, 6);
    await addRows(sample, c, 2);
    expect((await chosen(c))?.batchId).toBe(full);
    await drop([full, sample]);
  });

  it('(c) a newer quarter with 5 rows beats an older one with 50 — his 2b, where it speaks', async () => {
    const c = code(4);
    const older = await mintBatch(Q2, 120, 'BC-c-older');
    const newer = await mintBatch(Q3, 60, 'BC-c-newer');
    await addRows(older, c, 50);
    await addRows(newer, c, 5);
    expect((await chosen(c))?.batchId).toBe(newer);
    await drop([older, newer]);
  });

  it('(d) a newer quarter with 3 rows loses to an older one with 50 — too few to answer', async () => {
    const c = code(5);
    const older = await mintBatch(Q2, 120, 'BC-d-older');
    const newer = await mintBatch(Q3, 60, 'BC-d-newer');
    await addRows(older, c, 50);
    await addRows(newer, c, 3);
    expect((await chosen(c))?.batchId).toBe(older);
    await drop([older, newer]);
  });

  it('(d2) two files of the SAME quarter, both with enough → the one with MORE rows, though uploaded first', async () => {
    // Rule 3 alone (review P2-4): both hold ≥ FEW (rule 1 ties), both end on
    // the same day (rule 2 ties), and the newer upload — which rule 4 would
    // choose — is the thinner one.
    const c = code(9);
    const thick = await mintBatch(Q2, 120, 'BC-d2-thick');
    const thin = await mintBatch(Q2, 60, 'BC-d2-thin');
    await addRows(thick, c, 50);
    await addRows(thin, c, 6);
    expect((await chosen(c))?.batchId).toBe(thick);
    expect((await chosen(c))?.rows).toBe(50);
    await drop([thick, thin]);
  });

  it('(e) the list route and the stats route answer from the chooser’s batch', async () => {
    const c = code(6);
    const older = await mintBatch(Q2, 120, 'BC-e-older');
    const newer = await mintBatch(Q3, 60, 'BC-e-newer');
    await addRows(older, c, 50);
    await addRows(newer, c, 3);
    const itemId = await rowCoded(c);
    const list = (await (await listRoute(new Request(`http://t/api/calc/import-baza?item=${itemId}`))).json()) as {
      state: string;
      batchId: string;
    };
    const stats = (await (await statsRoute(new Request(`http://t/api/calc/import-baza/stats?item=${itemId}`))).json()) as {
      state: string;
      batchId: string;
    };
    expect(list.state).toBe('ok');
    expect(stats.state).toBe('ok');
    expect(list.batchId).toBe(older);
    expect(stats.batchId).toBe(older);
    await drop([older, newer]);
  });

  it('(f) TOTAL: a code no file holds maps to the newest ready batch — «none», never «not uploaded»', async () => {
    const c = code(7);
    const someBatch = await mintBatch(Q3, 60, 'BC-f');
    await addRows(someBatch, code(8), 6);
    const answer = await chosen(c);
    expect(answer, 'a code no batch holds must still get an entry').toBeDefined();
    expect(answer!.batchId).toBe(await newestReadyBatchId());
    expect(answer!.rows).toBe(0);
    const itemId = await rowCoded(c);
    const list = (await (await listRoute(new Request(`http://t/api/calc/import-baza?item=${itemId}`))).json()) as {
      state: string;
      candidates: unknown[];
    };
    // The dialog prints «importda mos qator yo'q» for exactly this answer.
    expect(list.state).toBe('ok');
    expect(list.candidates).toEqual([]);
    await drop([someBatch]);

    // …and only when NO batch is ready is the map empty («yuklanmagan»). Any
    // foreign ready batch a crashed run left behind is held out of the way
    // for the assertion and put back whatever happens.
    const foreign = await db.execute<{ id: string }>(sql`
      UPDATE customs_import_batches SET status = 'processing' WHERE status = 'ready' RETURNING id::text AS id`);
    try {
      expect((await batchesForCodes([c])).size).toBe(0);
      const none = (await (await listRoute(new Request(`http://t/api/calc/import-baza?item=${itemId}`))).json()) as {
        state: string;
      };
      expect(none.state).toBe('no_batch');
    } finally {
      if (foreign.length > 0) {
        await db
          .update(customsImportBatches)
          .set({ status: 'ready' })
          .where(inArray(customsImportBatches.id, foreign.map((f) => f.id)));
      }
    }
  });
});
