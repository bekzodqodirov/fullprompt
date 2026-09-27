import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, pgClient } from '@/modules/platform/db/client';
import { boxes, leadStages, leads, receiptLots, receipts, users, warehouses } from '@/modules/platform/db/schema';
import { intakeByDay, intakeByMonth } from '@/modules/wms/reports/business';
import { receiptsJournal, receiptsJournalTotals } from '@/modules/wms/reports/queries';
import { reportScope, warehouseOptions, type ScopeActor } from '@/modules/wms/reports/report-scope';
import { leadArrivals, leadDecisions, readPeriod, salesAnalytics } from '@/modules/wms/crm/analytics';

/**
 * Round B's cargo package: the dashboard's 30 intake columns, the journal its
 * chart links to, and the funnel line — each a figure the page it opens
 * prints too (#513).
 *
 *  - `intakeByDay`'s days sum to `intakeByMonth`'s month and to the journal's
 *    header over the same range, because all three read `intakeWhereSql`;
 *  - a receipt is filed on its TASHKENT day (R5): 23:30 there is still the
 *    same day, 00:30 is the next one, which is 19:30 UTC the day BEFORE;
 *  - a draft and a voided receipt were never taken in;
 *  - the journal narrowed to one warehouse by `?ombor=` equals that
 *    warehouse's day chart, through the same `reportScope` the page asks;
 *  - an EMPTY scope reads nothing on every door;
 *  - `leadArrivals`/`leadDecisions` ARE the tahlil scoreboard's cells.
 *
 * Everything parks in 1658 (this package's private year). Pre-1924 Postgres
 * answers `Asia/Tashkent` with LMT +04:37, so no fixture sits in 19:00-19:23
 * UTC, where the window's fixed +05:00 and the day key would disagree.
 * Warehouses are DEACTIVATED at the end, never deleted (the brief's audit_log
 * rule), and the cleanup is the last TEST, not an afterAll that can silently
 * do nothing (#183).
 */

let seq = 0;
const STAMP = `${++seq}${String(Date.now()).slice(-6)}`;

let actorId = '';
let whA = '';
let whB = '';
/** Deactivated, but a carton still stands in it — the picker keeps it. */
let whHeld = '';
/** Deactivated and empty — the picker drops it. */
let whGone = '';
const madeReceipts: string[] = [];
const madeBoxes: string[] = [];
const madeLeads: string[] = [];

async function warehouse(tag: string, country: 'UZ' | 'CN', active = true) {
  const [row] = await db
    .insert(warehouses)
    .values({
      name: `Dash cargo ${tag} ${STAMP}`,
      code: `D${tag}${STAMP}`,
      batchPrefix: `D${tag}${STAMP}`,
      country,
      type: country === 'UZ' ? 'distribution' : 'origin',
      timezone: country === 'UZ' ? 'Asia/Tashkent' : 'Asia/Shanghai',
      active,
    })
    .returning({ id: warehouses.id });
  return row!.id;
}

async function receipt(
  warehouseId: string,
  at: string,
  lots: { boxes: number; m3: number; kg: number }[],
  status: 'confirmed' | 'draft' | 'voided' = 'confirmed',
) {
  const [row] = await db
    .insert(receipts)
    .values({ warehouseId, status, createdBy: actorId, receivedAt: new Date(at) })
    .returning({ id: receipts.id });
  madeReceipts.push(row!.id);
  const lotIds: string[] = [];
  for (const [i, lot] of lots.entries()) {
    const [made] = await db
      .insert(receiptLots)
      .values({
        receiptId: row!.id,
        seq: i + 1,
        productNameZh: `货${STAMP}`,
        boxCount: lot.boxes,
        dimsMode: 'mixed',
        totalWeightKg: String(lot.kg),
        totalVolumeM3: String(lot.m3),
      })
      .returning({ id: receiptLots.id });
    lotIds.push(made!.id);
  }
  return { id: row!.id, lotIds };
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  whA = await warehouse('A', 'UZ');
  whB = await warehouse('B', 'CN');
  whHeld = await warehouse('H', 'UZ', false);
  whGone = await warehouse('G', 'UZ', false);

  // 23:30 Tashkent on 31 May (18:30 UTC; LMT 23:07) — still 31 May.
  await receipt(whA, '1658-05-31T18:30:00Z', [{ boxes: 3, m3: 0.3, kg: 30 }]);
  // 00:30 Tashkent on 1 June is 19:30 UTC on 31 MAY (LMT 00:07) — June's.
  await receipt(whA, '1658-05-31T19:30:00Z', [{ boxes: 5, m3: 0.5, kg: 50 }]);
  // Two lots on one receipt: one receipt, not two.
  await receipt(whB, '1658-05-10T08:00:00Z', [
    { boxes: 1, m3: 0.1, kg: 10 },
    { boxes: 1, m3: 0.25, kg: 25 },
  ]);
  // Never taken in: a draft being typed and a voided receipt, both on 31 May.
  await receipt(whA, '1658-05-31T10:00:00Z', [{ boxes: 7, m3: 0.7, kg: 70 }], 'draft');
  await receipt(whA, '1658-05-31T11:00:00Z', [{ boxes: 11, m3: 1.1, kg: 110 }], 'voided');

  // A carton still standing in the deactivated warehouse.
  const held = await receipt(whHeld, '1658-04-02T08:00:00Z', [{ boxes: 1, m3: 0.2, kg: 20 }]);
  const [box] = await db
    .insert(boxes)
    .values({
      lotId: held.lotIds[0]!,
      shortCode: `DKH${STAMP}`,
      seqInLot: 1,
      status: 'in_stock',
      currentWarehouseId: whHeld,
    })
    .returning({ id: boxes.id });
  madeBoxes.push(box!.id);
});

afterAll(async () => {
  await pgClient.end();
});

const SCOPE = () => [whA, whB];

describe('intakeByDay is the intake rule, one day at a time', () => {
  it('files a receipt on its Tashkent day and zero-fills the quiet ones', async () => {
    const { days, total } = await intakeByDay('1658-05-30', '1658-06-01', SCOPE());
    expect(days.map((d) => d.day)).toEqual(['1658-05-30', '1658-05-31', '1658-06-01']);
    expect(days[0]).toEqual({ day: '1658-05-30', receipts: 0, boxes: 0, m3: 0, kg: 0 });
    // Only the 23:30 receipt: the 00:30 one belongs to June, and the draft
    // and the voided receipt on the same day were never taken in.
    expect(days[1]).toEqual({ day: '1658-05-31', receipts: 1, boxes: 3, m3: 0.3, kg: 30 });
    expect(days[2]).toEqual({ day: '1658-06-01', receipts: 1, boxes: 5, m3: 0.5, kg: 50 });
    expect(total).toEqual({ receipts: 2, boxes: 8, m3: 0.8, kg: 80 });
  });

  it('the days sum to intakeByMonth’s month and to the journal header over the same range', async () => {
    const range = { from: '1658-05-01', to: '1658-05-31' };
    for (const scope of [SCOPE(), undefined]) {
      const byDay = await intakeByDay(range.from, range.to, scope);
      const [month] = await intakeByMonth(range.from, range.to, scope);
      const journal = await receiptsJournalTotals(range, scope);
      const sum = (key: 'receipts' | 'boxes' | 'm3' | 'kg') =>
        Math.round(byDay.days.reduce((acc, d) => acc + d[key], 0) * 1000) / 1000;
      expect(month).toMatchObject({ month: '1658-05' });
      for (const key of ['receipts', 'boxes', 'm3', 'kg'] as const) {
        expect(sum(key)).toBe(month![key]);
        expect(byDay.total[key]).toBe(month![key]);
        expect(journal[key]).toBe(month![key]);
      }
      if (scope) expect(byDay.total).toEqual({ receipts: 2, boxes: 5, m3: 0.65, kg: 65 });
    }
  });

  it('splits the same rows by warehouse, the biggest first, and the split sums to the total', async () => {
    const { byWarehouse, total } = await intakeByDay('1658-05-01', '1658-06-30', SCOPE());
    expect(byWarehouse).toEqual([
      { code: `DA${STAMP}`, m3: 0.8 },
      { code: `DB${STAMP}`, m3: 0.35 },
    ]);
    expect(byWarehouse.reduce((acc, w) => acc + w.m3, 0)).toBeCloseTo(total.m3, 6);
  });

  it('an empty scope reads nothing on every door — never «no filter»', async () => {
    const range = { from: '1658-05-01', to: '1658-06-30' };
    expect((await intakeByDay(range.from, range.to, [])).total).toEqual({ receipts: 0, boxes: 0, m3: 0, kg: 0 });
    expect(await intakeByMonth(range.from, range.to, [])).toEqual([]);
    expect(await receiptsJournalTotals(range, [])).toEqual({ receipts: 0, boxes: 0, m3: 0, kg: 0 });
    expect(await receiptsJournal(range, [])).toEqual([]);
    // …and the same list with no scope does see the rows (the fixture is real).
    expect((await receiptsJournal(range, SCOPE())).length).toBeGreaterThanOrEqual(5);
  });
});

describe('the journal with ?ombor is that warehouse’s day chart', () => {
  const owner: ScopeActor = { permissions: new Set(['reports.all_warehouses']), warehouseScoped: false, warehouseIds: [] };

  it('the page’s own chain — options, reportScope, the journal — equals scoped intakeByDay', async () => {
    const range = { from: '1658-05-01', to: '1658-06-30' };
    const options = await warehouseOptions(undefined);
    const scope = reportScope(owner, whA, options);
    expect(scope.ids).toEqual([whA]);
    const journal = await receiptsJournalTotals(range, scope.ids);
    const byDay = await intakeByDay(range.from, range.to, [whA]);
    expect(journal).toEqual(byDay.total);
    expect(journal).toEqual({ receipts: 2, boxes: 8, m3: 0.8, kg: 80 });
    // The list agrees about which receipts those are — it lists drafts and
    // voids as well (a journal), so compare the confirmed ones.
    const listed = (await receiptsJournal(range, scope.ids)).filter((row) => row.status === 'confirmed');
    expect(listed.map((row) => row.boxCount).sort()).toEqual([3, 5]);
  });

  it('a warehouse outside the viewer’s list is dropped, and the viewer reads their own scope', async () => {
    const manager: ScopeActor = {
      permissions: new Set(['reports.own_warehouse']),
      warehouseScoped: true,
      warehouseIds: [whA],
    };
    const options = await warehouseOptions([whA]);
    expect(options.map((o) => o.id)).toEqual([whA]);
    const scope = reportScope(manager, whB, options);
    expect(scope).toMatchObject({ ombor: null, ids: [whA] });
  });
});

describe('warehouseOptions offers the stock picker’s own list', () => {
  it('keeps a deactivated warehouse while cargo stands in it, drops an empty one, and honours the scope', async () => {
    const all = await warehouseOptions(undefined);
    const ids = all.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining([whA, whB, whHeld]));
    expect(ids).not.toContain(whGone);
    expect(all.find((o) => o.id === whHeld)).toMatchObject({ active: false, code: `DH${STAMP}` });
    // Ordered by code, like every picker.
    expect(all.map((o) => o.code)).toEqual([...all.map((o) => o.code)].sort());

    const scoped = await warehouseOptions([whB, whGone, whHeld]);
    expect(scoped.map((o) => o.id).sort()).toEqual([whB, whHeld].sort());
    expect(await warehouseOptions([])).toEqual([]);
  });

  it('shares its rule with stockWarehouseOptions rather than restating it', () => {
    const scopeFile = readFileSync('src/modules/wms/reports/report-scope.ts', 'utf8');
    const inventory = readFileSync('src/modules/wms/inventory/service.ts', 'utf8');
    expect(scopeFile).toContain('listedWarehouseSql()');
    expect(scopeFile).not.toContain('SHELF_STATUSES');
    expect(inventory).toMatch(/\.where\(or\(listedWarehouseSql\(\)/);
  });
});

describe('the funnel line reads the tahlil scoreboard’s own cells', () => {
  const period = readPeriod({ dan: '1658-03-01', gacha: '1658-03-31' });

  it('arrivals run on the arrival clock, decisions on the decision clock', async () => {
    const stages = await db.select().from(leadStages);
    const open = stages.find((s) => s.kind === 'open')!.id;
    const won = stages.find((s) => s.kind === 'won')!.id;
    const lost = stages.find((s) => s.kind === 'lost')!.id;
    const mint = async (row: { stageId: string; createdAt: string; closedAt?: string; usd?: number }) => {
      const [made] = await db
        .insert(leads)
        .values({
          name: `Dash cargo lid ${STAMP}`,
          stageId: row.stageId,
          createdBy: actorId,
          createdAt: new Date(row.createdAt),
          closedAt: row.closedAt ? new Date(row.closedAt) : null,
          quotedAmount: row.usd === undefined ? null : String(row.usd),
          quotedCurrency: row.usd === undefined ? null : 'USD',
        })
        .returning({ id: leads.id });
      madeLeads.push(made!.id);
    };
    // Arrived in March, still open: an arrival, no decision.
    await mint({ stageId: open, createdAt: '1658-03-05T06:00:00Z' });
    // Arrived in FEBRUARY, won in March after 18 days: a decision, no arrival.
    await mint({ stageId: won, createdAt: '1658-02-20T06:00:00Z', closedAt: '1658-03-10T06:00:00Z', usd: 500 });
    // Arrived and lost in March: both — and a loss has no «cycle».
    await mint({ stageId: lost, createdAt: '1658-03-06T06:00:00Z', closedAt: '1658-03-08T06:00:00Z' });
    // Arrived in March, won in APRIL: an arrival, and April's decision — its
    // own price and cycle, so a swapped clock cannot hide behind equal counts.
    await mint({ stageId: won, createdAt: '1658-03-20T06:00:00Z', closedAt: '1658-04-05T06:00:00Z', usd: 700 });

    expect(await leadArrivals(period)).toBe(3);
    expect(await leadDecisions(period)).toEqual({ won: 1, lost: 1, wonUsd: 500, wonOther: 0, cycleDays: 18 });

    const tahlil = await salesAnalytics(period);
    expect(tahlil.totals).toMatchObject({
      fresh: 3,
      won: 1,
      lost: 1,
      wonUsd: 500,
      wonOtherCurrency: 0,
      cycleDays: 18,
    });
  });

  it('salesAnalytics calls the two functions instead of keeping its own copies', () => {
    const source = readFileSync('src/modules/wms/crm/analytics.ts', 'utf8');
    const body = source.slice(source.indexOf('export async function salesAnalytics'));
    expect(body).toContain('leadArrivals(period, f),');
    expect(body).toContain('leadDecisions(period, f),');
  });
});

describe('cleanup — the last test, so a failed cleanup is a red test and not silence', () => {
  it('removes the fixture rows and deactivates the warehouses', async () => {
    if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
    if (madeBoxes.length) await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
    if (madeReceipts.length) {
      await db.delete(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts));
      await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
    }
    const mine = [whA, whB, whHeld, whGone].filter(Boolean);
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, mine));

    const still = await db.select({ id: warehouses.id }).from(warehouses).where(inArray(warehouses.id, mine));
    expect(still).toHaveLength(4);
    const listed = (await warehouseOptions(undefined)).map((o) => o.id);
    for (const id of mine) expect(listed).not.toContain(id);
    expect(await db.select({ id: leads.id }).from(leads).where(inArray(leads.id, madeLeads))).toEqual([]);
  });
});
