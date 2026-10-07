import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * «Narxlar statistikasi» and the C6 order, against a real Postgres.
 *
 * The routes' door is `authorize('ved.docs')` and a test has no session, so
 * the gate is swapped for a switch — everything behind it (the item read,
 * the batch choice, the ceiling transaction, the three statements) is the
 * code that runs in production.
 */
const gate = vi.hoisted(() => ({ allow: true, actorId: '' }));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    authorize: async () => {
      if (!gate.allow) throw new real.AuthError('Missing permission ved.docs', 'forbidden');
      return { id: gate.actorId, permissions: new Set(['ved.docs']), roles: [], warehouseIds: [] } as unknown as Awaited<
        ReturnType<typeof real.authorize>
      >;
    },
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  customsImportBatches,
  deals,
  dealStages,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import {
  batchRecencySql,
  newestReadyBatchId,
  previousReadyBatchId,
} from '@/modules/wms/customs/import-service';
import { importRowForCode, suggestImportBaza } from '@/modules/wms/customs/import-baza';
import { normalizeName, type ImportUnit } from '@/modules/wms/customs/import-parse';
import { readImportStats, type ImportStatsAnswer } from '@/modules/wms/customs/import-stats';
import { readPickerItem } from '@/modules/wms/customs/picker-item';
import { FEW } from '@/modules/wms/customs/import-stats-math';
import { underCeiling } from '@/modules/wms/finance/price-history';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { saveTable } from '@/modules/wms/calc/workspace';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { GET as listRoute } from '@/app/api/calc/import-baza/route';
import { GET as statsRoute } from '@/app/api/calc/import-baza/stats/route';

/**
 * CONFIGURATION WARNING (#183): a READY batch dated today is, while it
 * lives, the batch every save in the suite fills its bazas from. Each
 * ordering test deletes its own batches when it is done, `afterAll` sweeps
 * the rest, and `fileParallelism: false` means no other file runs meanwhile.
 * Codes are `94xx` + the run's digits — unique to this file.
 */
const SUFFIX = String(Date.now()).slice(-6);
const code = (n: number) => `94${String(n).padStart(2, '0')}${SUFFIX}`;
let actorId = '';
let clientId = '';
let dealId = '';
const madeBatches: string[] = [];
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

/** A Tashkent calendar day relative to today, `YYYY-MM-DD`. */
function day(offset: number): string {
  const d = new Date(`${tashkentDay()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const lastYear = Number(tashkentDay().slice(0, 4)) - 1;

async function mintBatch(opts: {
  name: string;
  from?: string | null;
  to?: string | null;
  /** Seconds before now; 0 = this moment. */
  agoSec?: number;
}): Promise<string> {
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to, uploaded_at)
    VALUES (${`${opts.name}-${SUFFIX}.xlsx`}, ${actorId}::uuid, 'ready', ${opts.from ?? null}::date, ${opts.to ?? null}::date,
            now() - make_interval(secs => ${opts.agoSec ?? 0}))
    RETURNING id::text AS id`);
  madeBatches.push(row!.id);
  return row!.id;
}

interface RowSpec {
  name?: string;
  unit?: ImportUnit;
  price: number;
  w?: number | null;
  origin?: string | null;
  netto?: number | null;
  declaredAt?: string | null;
}

async function addRows(batchId: string, tnved: string, rows: RowSpec[]) {
  for (const r of rows) {
    const name = r.name ?? `Прочие изделия BS${SUFFIX}`;
    await db.execute(sql`
      INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd,
                                       weight_per_unit_kg, netto_kg, origin_country, declared_at)
      VALUES (${batchId}::uuid, ${tnved}, ${name}, ${normalizeName(name)}, ${r.unit ?? 'kg'}, ${String(r.price)}::numeric,
              ${r.w === undefined || r.w === null ? null : String(r.w)}::numeric,
              ${r.netto === undefined || r.netto === null ? null : String(r.netto)}::numeric,
              ${r.origin === undefined ? '156-КИТАЙ' : r.origin}, ${r.declaredAt ?? day(-5)}::date)`);
  }
}

/** Remove batches a test is done with — they are CONFIGURATION (#183). */
async function drop(ids: string[]) {
  if (ids.length > 0) await db.delete(customsImportBatches).where(inArray(customsImportBatches.id, ids));
}

const stats = (input: {
  batchId: string;
  prevBatchId?: string | null;
  tnvedCode: string;
  units: ImportUnit[];
  perPieceKg?: number | null;
  dutyUnit?: string | null;
}) =>
  underCeiling((tx) =>
    readImportStats(tx, {
      batchId: input.batchId,
      prevBatchId: input.prevBatchId ?? null,
      tnvedCode: input.tnvedCode,
      units: input.units,
      dutyUnit: input.dutyUnit ?? null,
      perPieceKg: input.perPieceKg ?? null,
    }),
  );
const unitOf = (answer: { units: { unit: ImportUnit }[] }, u: ImportUnit) =>
  answer.units.find((x) => x.unit === u) as Awaited<ReturnType<typeof stats>>['units'][number] | undefined;

/** The order of the minted set alone — foreign READY batches on a
 * long-lived database cannot reorder it (#653). */
async function orderOf(ids: string[]): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT b.id::text AS id FROM customs_import_batches b
     WHERE b.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )}) AND b.status = 'ready'
     ORDER BY ${batchRecencySql(sql`b`)}`);
  return rows.map((r) => r.id);
}

async function open(items: { name: string; tnvedCode?: string | null; quantity?: number | null; weightKg?: number | null }[]) {
  const result = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items,
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(result.id);
  return result.id;
}
const itemsOf = (requestId: string) =>
  db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId)).orderBy(calcRequestItems.seq);

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99893${String(Date.now()).slice(-7)}`, fullName: `Stats fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  gate.actorId = actorId;
  const [client] = await db.insert(clients).values({ clientCode: `BS${SUFFIX}`, name: `Stats fixture ${SUFFIX}` }).returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `BS-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Stats fixture', createdBy: actorId })
    .returning();
  dealId = deal!.id;
});

afterAll(async () => {
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
  // Raw, because the service refuses to delete a READY batch on purpose.
  await drop(madeBatches);
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('the statistics', () => {
  it('1. never pool units — each has its own n, median and origin counts', async () => {
    const b = await mintBatch({ name: 'BS-units', from: day(-30), to: day(-1) });
    const c = code(1);
    await addRows(b, c, [1, 2, 3, 4, 5, 6, 7].map((p) => ({ price: p })));
    await addRows(b, c, [10, 11, 12, 13, 14, 15].map((p) => ({ unit: 'dona' as const, price: p })));
    const a = await stats({ batchId: b, tnvedCode: c, units: ['kg', 'dona'] });
    expect(a.units.map((u) => u.unit)).toEqual(['kg', 'dona']);
    const kg = unitOf(a, 'kg')!;
    const dona = unitOf(a, 'dona')!;
    expect(kg.all.n).toBe(7);
    expect(kg.all.p50).toBe(4);
    expect(kg.origin).toEqual({ china: 7, other: 0, unknown: 0 });
    expect(dona.all.n).toBe(6);
    expect(dona.all.p50).toBe(12);
    expect(dona.origin).toEqual({ china: 6, other: 0, unknown: 0 });
  });

  it('2. a quartile is a STORED price, its declaration round-trips, and «Tanlash» lands it', async () => {
    const b = await mintBatch({ name: 'BS-disc', from: day(-30), to: day(-1) });
    const c = code(2);
    await addRows(b, c, [1, 2, 3, 4, 5, 6].map((p) => ({ price: p, name: `Изделия BS${SUFFIX} ${p}` })));
    const kg = unitOf(await stats({ batchId: b, tnvedCode: c, units: ['kg'] }), 'kg')!;
    // percentile_disc: a price some declaration carries — never 3.5.
    expect(kg.all.p50).toBe(3);
    const ex = kg.all.exemplars.p50!;
    expect(ex.pricePerUnitUsd).toBe(3);
    const row = await importRowForCode(ex.id, c);
    expect(row?.pricePerUnitUsd).toBe(3);

    const requestId = await open([{ name: 'Statistika tanlovi', tnvedCode: c, weightKg: 100 }]);
    const [item] = await itemsOf(requestId);
    await saveTable(
      requestId,
      { items: [{ id: item!.id, seq: item!.seq, bazaUsd: 3, bazaBasis: 'kg', importRowId: ex.id }], adds: [] },
      ctx(),
    );
    const [after] = await itemsOf(requestId);
    expect(after!.bazaSource).toBe('import');
    expect(Number(after!.bazaUsd)).toBe(3);
    expect(String(after!.importRowId)).toBe(ex.id);
  });

  it('3. one vote per declaration — a 20-tonne line does not move the median (C4)', async () => {
    const b = await mintBatch({ name: 'BS-vote', from: day(-30), to: day(-1) });
    const c = code(3);
    await addRows(b, c, [
      ...[1, 2, 3, 4, 5].map((p) => ({ price: p, netto: 1 })),
      { price: 10, netto: 20000 },
    ]);
    const kg = unitOf(await stats({ batchId: b, tnvedCode: c, units: ['kg'] }), 'kg')!;
    expect(kg.all.n).toBe(6);
    expect(kg.all.p50).toBe(3);
  });

  it('4. China only, PER UNIT, by the numeric code first (C2)', async () => {
    const b = await mintBatch({ name: 'BS-china', from: day(-30), to: day(-1) });
    const c = code(4);
    await addRows(b, c, [
      { price: 1, origin: '156-КИТАЙ' },
      { price: 2, origin: 'КИТАЙ' },
      { price: 3, origin: 'Китай' },
      { price: 4, origin: '156' },
      { price: 5, origin: 'CN' },
      { price: 6, origin: 'КНР' },
      { price: 50, origin: '792-ТУРЦИЯ' },
      { price: 60, origin: '158-ТАЙВАНЬ (КИТАЙ)' },
      { price: 70, origin: 'ГОНКОНГ (КИТАЙ)' },
      { price: 80, origin: '158-КИТАЙСКАЯ РЕСПУБЛИКА' },
      { price: 90, origin: null },
      { price: 0.5, unit: 'dona', origin: '156-КИТАЙ' },
    ]);
    const a = await stats({ batchId: b, tnvedCode: c, units: ['kg'] });
    expect(a.filtered).toBe(true);
    const kg = unitOf(a, 'kg')!;
    expect(kg.origin).toEqual({ china: 6, other: 4, unknown: 1 });
    expect(kg.all.prices).toEqual([1, 2, 3, 4, 5, 6]);
    expect(kg.all.p50).toBe(3);
    // A code-wide count would read china 7 here.
    expect(unitOf(a, 'dona')!.origin).toEqual({ china: 1, other: 0, unknown: 0 });
  });

  it('5. a file that names no country counts every declaration, and says so', async () => {
    const b = await mintBatch({ name: 'BS-noorigin', from: day(-30), to: day(-1) });
    const c = code(5);
    await addRows(b, c, [1, 2, 3, 4].map((p) => ({ price: p, origin: null })));
    const a = await stats({ batchId: b, tnvedCode: c, units: ['kg'] });
    expect(a.filtered).toBe(false);
    const kg = unitOf(a, 'kg')!;
    expect(kg.all.n).toBe(4);
    expect(kg.origin).toEqual({ china: 4, other: 0, unknown: 0 });
  });

  it('6. his ±25 % weight line, inclusive, from the SAVED row — whatever units say (D5)', async () => {
    const b = await mintBatch({ name: 'BS-band', from: day(-30), to: day(-1) });
    const c = code(6);
    await addRows(
      b,
      c,
      [0.5, 0.9, 1.0, 1.1, 1.25, 1.3, 2.0].map((w, i) => ({ unit: 'dona' as const, price: i + 1, w })),
    );
    // A row of 10 pieces weighing 10 kg — a kg-first advalor row still gets
    // its dona tab and its weight per piece.
    const requestId = await open([
      { name: 'Og‘irlik qatori', tnvedCode: c, quantity: 10, weightKg: 10 },
      { name: 'Sonsiz qator', tnvedCode: c, weightKg: 10 },
    ]);
    const [withQty, noQty] = await itemsOf(requestId);
    const item = (await readPickerItem(withQty!.id, null))!;
    expect(item.perPieceKg).toBe(1);
    const dona = unitOf(
      await stats({ batchId: b, tnvedCode: c, units: item.units, perPieceKg: item.perPieceKg }),
      'dona',
    )!;
    const weight = dona.weight;
    expect(weight).not.toBeNull();
    expect(weight).not.toBe('no_row_weight');
    expect((weight as { n: number }).n).toBe(4);

    const bare = (await readPickerItem(noQty!.id, null))!;
    expect(bare.perPieceKg).toBeNull();
    const none = unitOf(await stats({ batchId: b, tnvedCode: c, units: bare.units, perPieceKg: null }), 'dona')!;
    expect(none.weight).toBe('no_row_weight');
  });
});

describe('«newest» by the dates inside (C6)', () => {
  it('7. a later end beats a later upload, the auto-fill follows, and an undated upload is dated today', async () => {
    const c = code(7);
    const name = `Пластиковые вазы BS${SUFFIX}`;
    const older = await mintBatch({ name: 'BS-A', from: day(-200), to: day(-91), agoSec: 0 });
    const current = await mintBatch({ name: 'BS-B', from: day(-90), to: day(0), agoSec: 60 });
    await addRows(older, c, [{ price: 7.77, name }]);
    await addRows(current, c, [{ price: 5.55, name }]);
    expect(await newestReadyBatchId()).toBe(current);

    const requestId = await open([{ name, tnvedCode: c, weightKg: 100 }]);
    await saveTable(requestId, { items: [], adds: [] }, ctx());
    const [filled] = await itemsOf(requestId);
    expect(Number(filled!.bazaUsd)).toBe(5.55);
    expect(filled!.bazaSource).toBe('import');

    const undated = await mintBatch({ name: 'BS-C', agoSec: 0 });
    expect(await newestReadyBatchId()).toBe(undated);
    await drop([older, current, undated]);
  });

  it('8. a future date is clamped to the upload day', async () => {
    const x = await mintBatch({ name: 'BS-X', from: day(-60), to: '2099-01-01', agoSec: 24 * 3600 });
    const y = await mintBatch({ name: 'BS-Y', from: day(-60), to: day(-1), agoSec: 0 });
    // X «ends» on its upload day (yesterday) — a tie, and the later upload wins.
    expect(await orderOf([x, y])).toEqual([y, x]);
    await drop([x, y]);
  });

  it('9. a June sample does not bury the full April-June quarter uploaded after it', async () => {
    const sample = await mintBatch({ name: 'BS-S', from: `${lastYear}-06-01`, to: `${lastYear}-06-30`, agoSec: 120 });
    const full = await mintBatch({ name: 'BS-F', from: `${lastYear}-04-01`, to: `${lastYear}-06-30`, agoSec: 60 });
    expect(await orderOf([sample, full])).toEqual([full, sample]);
    await drop([sample, full]);
  });

  it('10. «oldingi chorak» ends before the current starts, and compares like with like (D7)', async () => {
    const c = code(10);
    const prev = await mintBatch({ name: 'BS-prev', from: day(-200), to: day(-91), agoSec: 120 });
    const cur = await mintBatch({ name: 'BS-cur', from: day(-90), to: day(0), agoSec: 60 });
    expect(await previousReadyBatchId(cur)).toBe(prev);
    await addRows(cur, c, [1, 2, 3, 4, 5].map((p) => ({ price: p })));
    await addRows(prev, c, [2, 3, 4].map((p) => ({ price: p, origin: null })));
    // The current file names countries and the previous one does not: the
    // medians are not set side by side as one population.
    const unlike = unitOf(await stats({ batchId: cur, prevBatchId: prev, tnvedCode: c, units: ['kg'] }), 'kg')!;
    expect(unlike.prev).toEqual({ n: 3, p50: 3, filtered: false });
    await db.execute(sql`UPDATE customs_import_rows SET origin_country = '156-КИТАЙ' WHERE batch_id = ${prev}::uuid`);
    const like = await stats({ batchId: cur, prevBatchId: prev, tnvedCode: c, units: ['kg'] });
    expect(like.filtered).toBe(true);
    expect(unitOf(like, 'kg')!.prev).toEqual({ n: 3, p50: 3, filtered: true });

    // The same quarter uploaded again is the CURRENT one, never its own previous.
    const dup = await mintBatch({ name: 'BS-dup', from: day(-90), to: day(0), agoSec: 0 });
    expect(await newestReadyBatchId()).toBe(dup);
    expect(await previousReadyBatchId(dup)).toBe(prev);
    await drop([prev, cur, dup]);
  });
});

describe('the named series and the two routes', () => {
  it('11. «Nomi o‘xshash» counts the name-matched China declarations only (C1)', async () => {
    const b = await mintBatch({ name: 'BS-named', from: day(-30), to: day(-1) });
    const c = code(11);
    const flowers = `Искусственные цветы из полиэстера BS${SUFFIX}`;
    await addRows(b, c, [
      ...[1, 2, 3, 4, 5, 6].map((p) => ({ price: p, name: flowers })),
      ...[7, 8, 9].map((p) => ({ price: p, name: `Ткани хлопчатобумажные BS${SUFFIX}` })),
      ...[20, 21].map((p) => ({ price: p, name: flowers, origin: '792-ТУРЦИЯ' })),
    ]);
    const sug = await suggestImportBaza(
      { tnvedCode: c, name: 'Искусственные цветы', units: ['kg'], weightPerUnitKg: null },
      { picker: true, named: true, batchId: b },
    );
    expect(sug.namedState).toBe('ok');
    const named = sug.named!.kg!;
    expect(named.n).toBe(6);
    expect(named.p50).toBe(3);
    expect(named.exemplars.p50?.name).toBe(flowers);

    const short = await suggestImportBaza(
      { tnvedCode: c, name: 'Лак', units: ['kg'], weightPerUnitKg: null },
      { picker: true, named: true, batchId: b },
    );
    expect(short.namedState).toBe('short_name');
    expect(short.named).toBeUndefined();

    // The auto-fill's own call never builds the series.
    const auto = await suggestImportBaza(
      { tnvedCode: c, name: 'Искусственные цветы', units: ['kg'], weightPerUnitKg: null },
      { batchId: b },
    );
    expect(auto.named).toBeUndefined();
    expect(auto.namedState).toBeUndefined();
  });

  it('12. the list route and the stats route answer from the SAME batch', async () => {
    const b = await mintBatch({ name: 'BS-routes', from: day(-30), to: day(0), agoSec: 0 });
    const c = code(12);
    await addRows(b, c, [1, 2, 3, 4, 5, 6].map((p) => ({ price: p, name: `Изделия BS${SUFFIX}` })));
    const requestId = await open([{ name: `Изделия BS${SUFFIX}`, tnvedCode: c, weightKg: 100 }]);
    const [item] = await itemsOf(requestId);

    const list = (await (await listRoute(new Request(`http://t/api/calc/import-baza?item=${item!.id}`))).json()) as {
      batchId: string;
      state: string;
    };
    const statsRes = await statsRoute(new Request(`http://t/api/calc/import-baza/stats?item=${item!.id}`));
    expect(statsRes.headers.get('cache-control')).toBe('private, no-store');
    const answer = (await statsRes.json()) as ImportStatsAnswer;
    expect(list.state).toBe('ok');
    expect(answer.state).toBe('ok');
    expect(answer.batchId).toBe(list.batchId);
    expect(answer.batchId).toBe(b);
    expect(answer.units[0]!.all.p50).toBe(3);

    // The door is the workspace's own grant.
    gate.allow = false;
    try {
      const refused = await statsRoute(new Request(`http://t/api/calc/import-baza/stats?item=${item!.id}`));
      expect(refused.status).toBe(403);
    } finally {
      gate.allow = true;
    }
    await drop([b]);
  });

  it('13. every quartile of every series names a real declaration (D1), on the 99-step ladder too', async () => {
    const b = await mintBatch({ name: 'BS-ladder', from: day(-30), to: day(-1) });
    const c = code(13);
    // 70 kg declarations (above RAW_MAX: the ladder path), with repeats.
    await addRows(
      b,
      c,
      Array.from({ length: 70 }, (_, i) => ({ price: 1 + (i % 23) * 0.25 })),
    );
    await addRows(
      b,
      c,
      [0.95, 1.0, 1.05, 1.1, 0.9, 1.2, 0.8, 3.0].map((w, i) => ({ unit: 'dona' as const, price: 2 + i, w })),
    );
    const a = await stats({ batchId: b, tnvedCode: c, units: ['kg', 'dona'], perPieceKg: 1 });
    const kg = unitOf(a, 'kg')!;
    expect(kg.all.n).toBe(70);
    expect(kg.all.ladder).toHaveLength(99);
    expect(kg.all.prices).toBeNull();
    const dona = unitOf(a, 'dona')!;
    const weight = dona.weight as Exclude<typeof dona.weight, 'no_row_weight' | null>;
    expect(weight.n).toBe(7);
    for (const s of [kg.all, dona.all, weight]) {
      expect(s.n).toBeGreaterThanOrEqual(FEW);
      for (const key of ['p25', 'p50', 'p75'] as const) {
        const ex = s.exemplars[key];
        expect(ex, key).not.toBeNull();
        expect(ex!.pricePerUnitUsd).toBe(s[key]);
      }
    }
    for (const key of ['p25', 'p50', 'p75'] as const) {
      const w = weight.exemplars[key]!.weightPerUnitKg!;
      expect(w).toBeGreaterThanOrEqual(0.75);
      expect(w).toBeLessThanOrEqual(1.25);
    }
  });
});
