import 'dotenv/config';
import ExcelJS from 'exceljs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  boxMovements,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  deals,
  dealStages,
  events,
  notifications,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';

/**
 * The review of wave 1's rider rule (audit U17/U18/U19/U25/U35, 2026-09-25):
 * every step through the real doors, every figure from the real readers.
 *
 * The truck's re-split after an unscanned landing is QUEUED now, so the queue
 * is stood in for (this suite never works pg-boss jobs) and the test runs
 * what the job runs — `recomputeAll({ batchId })` — where a figure needs it.
 *
 * Money lives in 1673 (no other file's year); cargo in private warehouses.
 * Trucks depart TODAY (the doors stamp now()).
 */
const { enqueued } = vi.hoisted(() => ({ enqueued: [] as { name: string; data: Record<string, unknown> }[] }));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: Record<string, unknown>) => {
    enqueued.push({ name, data });
  }),
}));

const { JOB_RECOMPUTE_COSTS } = await import('@/modules/platform/jobs/boss');
const { tashkentDay } = await import('@/modules/platform/time/tashkent');
const { confirmReceipt, markBoxLost, voidReceipt } = await import('@/modules/wms/receipts/service');
const { annulReceipt } = await import('@/modules/wms/receipts/annul');
const { recordVerdict, submitPlan } = await import('@/modules/wms/planning/service');
const { departBatch, finishLoading, ingestLoadScans } = await import('@/modules/wms/scanning/service');
const { finishUnload, ingestUnloadScans, resolveMissing } = await import('@/modules/wms/scanning/unload');
const { reconcileInventory } = await import('@/modules/wms/inventory/service');
const {
  addCostEntry,
  addReceiptCostsBulk,
  batchCostSheet,
  batchLandedCostByLot,
  boxLandedCost,
  recomputeAll,
} = await import('@/modules/wms/costing/service');
const { applyRiderRepair, riderRepairPlan } = await import('@/modules/wms/costing/rider-repair');
const { batchLots } = await import('@/modules/wms/batches/lots');
const { clientCargo } = await import('@/modules/wms/finance/client-cargo');
const { profitByBatch } = await import('@/modules/wms/accounting/reports');
const { batchRegister, landedCostByClient, landedCostByLot } = await import('@/modules/wms/reports/queries');
const { cargoRiskList } = await import('@/modules/wms/reports/business');
const { buildLandedCostXlsx } = await import('@/modules/wms/reports/xlsx');
const { reportLabels } = await import('@/modules/wms/reports/labels');
const { ALL_COSTS } = await import('@/modules/wms/costing/cost-sight');
const { moveDeal } = await import('@/modules/wms/deals/service');

const S = String(Date.now()).slice(-6);
const YEAR = '1673';
let actorId = '';
let freightTypeId = '';
let customsTypeId = '';
const W: Record<'yw' | 'and' | 'tas', string> = { yw: '', and: '', tas: '' };
const madeTrucks: string[] = [];
const made = { clients: [] as string[], receipts: [] as string[], deals: [] as string[], stages: [] as string[] };
const today = tashkentDay();
const ctx = () => ({ actorId, ip: null, userAgent: null });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const queuedFor = (batchId: string) =>
  enqueued.filter((job) => job.name === JOB_RECOMPUTE_COSTS && job.data.batchId === batchId).length;

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Leg ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let clientSeq = 0;
async function mkClient(tag: string) {
  clientSeq += 1;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `L${clientSeq}${tag}${S}`.slice(0, 10).toUpperCase(), name: `Leg ${tag} ${S}` })
    .returning({ id: clients.id });
  made.clients.push(row!.id);
  return row!.id;
}

async function mkLot(clientId: string | null, boxCount: number, boxKg: number, warehouseId: string) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `leg/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId: clientId ?? undefined,
      unclaimedMarking: clientId ? '' : `LG${S}${boxCount}`,
      lots: [
        {
          id: lotId,
          productNameZh: '腿货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 50,
          boxWidthCm: 40,
          boxHeightCm: 30,
          boxWeightKg: boxKg,
        },
      ],
      extraCosts: [],
    } as never,
    ctx(),
  );
  made.receipts.push(receiptId);
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(boxes.seqInLot);
  return { receiptId, lotId, boxIds: rows.map((b) => b.id), codes: rows.map((b) => b.shortCode) };
}

const scan = (batchId: string, code: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

async function loadTruck(lines: { lotId: string; take: number }[], codes: string[], origin: string, dest: string) {
  const sub = await submitPlan(
    { originWarehouseId: origin, destWarehouseId: dest, lines: lines.map((l) => ({ lotId: l.lotId, boxCount: l.take })) } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  madeTrucks.push(batch!.id);
  for (const code of codes) {
    const [ack] = await ingestLoadScans([scan(batch!.id, code)], ctx());
    if (ack!.result !== 'ok') throw new Error(`load ${code}: ${ack!.result} ${ack!.detail ?? ''}`);
  }
  return batch!;
}

async function truck(lines: { lotId: string; take: number }[], codes: string[], origin: string, dest: string) {
  const batch = await loadTruck(lines, codes, origin, dest);
  await finishLoading(batch.id, ctx());
  await sleep(15);
  await departBatch(batch.id, ctx());
  return batch;
}

async function unload(batchId: string, codes: string[]) {
  const acks = [];
  for (const code of codes) acks.push(...(await ingestUnloadScans([scan(batchId, code)], ctx())));
  return acks;
}

async function cost(batchId: string, amount: number, day: string, typeId = freightTypeId) {
  return addCostEntry(
    {
      scope: 'batch',
      batchId,
      costTypeId: typeId,
      amount,
      currency: 'USD',
      costDate: day,
      allocationBasis: 'weight',
    },
    ctx(),
  );
}

async function allocated(entryId: string, boxId?: string) {
  const [row] = await db
    .select({ usd: sql<string>`coalesce(sum(${costAllocations.amountUsd}), 0)` })
    .from(costAllocations)
    .where(
      boxId
        ? and(eq(costAllocations.costEntryId, entryId), eq(costAllocations.boxId, boxId))
        : eq(costAllocations.costEntryId, entryId),
    );
  return Number(row!.usd);
}

async function truckRow(batchId: string) {
  return (await profitByBatch(today, today)).find((row) => row.batchId === batchId)!;
}

async function sheetRows(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: unknown[][] = [];
  workbook.worksheets[0]!.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
  return out;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  freightTypeId = (await db.select({ id: costTypes.id }).from(costTypes).where(eq(costTypes.code, 'freight')))[0]!.id;
  customsTypeId = (await db.select({ id: costTypes.id }).from(costTypes).where(eq(costTypes.code, 'customs')))[0]!.id;
  W.yw = await mintWarehouse(`LY${S}`, 'CN', 'origin');
  // A hub, so cargo lands `in_stock` and rides on to Tashkent.
  W.and = await mintWarehouse(`LA${S}`, 'UZ', 'hub');
  W.tas = await mintWarehouse(`LT${S}`, 'UZ', 'distribution');
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM cost_entries WHERE cost_date BETWEEN ${`${YEAR}-01-01`} AND ${`${YEAR}-12-31`}`);
  // The deals' own moves emitted DealStageChanged about them.
  if (made.deals.length) {
    const eventIds = (
      await db.select({ id: events.id }).from(events).where(inArray(events.entityId, made.deals))
    ).map((row) => row.id);
    if (eventIds.length) await db.delete(notifications).where(inArray(notifications.eventId, eventIds));
    await db.delete(events).where(inArray(events.entityId, made.deals));
    await db.update(receipts).set({ dealId: null }).where(inArray(receipts.dealId, made.deals));
    await db.delete(deals).where(inArray(deals.id, made.deals));
  }
  // CONFIGURATION last — the deals pointed at it (#183).
  if (made.stages.length) await db.delete(dealStages).where(inArray(dealStages.id, made.stages));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('U17 × U18 — a road cell of a prixod that never left does not ride on as «shu reysgacha»', () => {
  it('found back in full: the freight cell lands on no box and is named on its truck; the customs cell rides on', async () => {
    const x = await mkClient('X');
    const y = await mkClient('Y');
    const t = await mkClient('T');
    const p = await mkLot(x, 1, 50, W.yw);
    const q = await mkLot(y, 3, 100, W.yw);
    const tl = await mkLot(t, 1, 10, W.yw);
    const a = await truck(
      [
        { lotId: p.lotId, take: 1 },
        { lotId: q.lotId, take: 3 },
        { lotId: tl.lotId, take: 1 },
      ],
      [...p.codes, ...q.codes, ...tl.codes],
      W.yw,
      W.tas,
    );
    const freight = await cost(a.id, 900, `${YEAR}-03-02`);
    // P1 physically stayed in Yiwu.
    await unload(a.id, [...q.codes, ...tl.codes]);
    await finishUnload(a.id, ctx(), { mayCloseWithMissing: true });
    // The accountant types A's grid while P1 is still on the manifest.
    const grid = await addReceiptCostsBulk(
      {
        batchId: a.id,
        currency: 'USD',
        costDate: `${YEAR}-03-03`,
        cells: [
          { receiptId: p.receiptId, costTypeId: freightTypeId, amount: 60 },
          { receiptId: p.receiptId, costTypeId: customsTypeId, amount: 100 },
        ],
      },
      ctx(),
    );
    expect(grid.error).toBeNull();
    const cells = await db
      .select({ id: costEntries.id, typeId: costEntries.costTypeId })
      .from(costEntries)
      .where(and(eq(costEntries.batchId, a.id), eq(costEntries.receiptId, p.receiptId)));
    const roadCell = cells.find((cell) => cell.typeId === freightTypeId)!.id;
    const customsCell = cells.find((cell) => cell.typeId === customsTypeId)!.id;
    expect(await allocated(roadCell, p.boxIds[0])).toBeCloseTo(60, 2);

    await resolveMissing({ boxId: p.boxIds[0]!, resolution: 'found_at_origin' }, ctx());

    // The road cell left the carton that never boarded (owner's Q2) and sits
    // on no box — named on A as unallocated, where it can be voided.
    expect(await allocated(roadCell)).toBe(0);
    expect(await allocated(customsCell, p.boxIds[0])).toBeCloseTo(100, 2);
    expect(await allocated(freight.id, p.boxIds[0])).toBe(0);
    expect((await truckRow(a.id)).unallocatedUsd).toBe(60);
    // The repair plan agrees: no road money is left on the left-behind carton.
    const plan = await riderRepairPlan();
    expect(plan.leftBehind.find((row) => row.batchId === a.id)).toMatchObject({ boxes: 1, usd: 0 });

    // The truck register now divides by the same kilos as the batch card.
    const sheet = await batchCostSheet(a.id, ALL_COSTS);
    const reg = (await batchRegister()).find((row) => row.id === a.id)!;
    expect(sheet).toMatchObject({ boxCount: 4, kg: 310 });
    expect(reg).toMatchObject({ loaded: sheet.boxCount, kg: sheet.kg, usdPerKg: sheet.usdPerKg });

    // P1 really rides B.
    const z = await mkClient('Z');
    const zl = await mkLot(z, 5, 10, W.yw);
    const b = await truck(
      [
        { lotId: p.lotId, take: 1 },
        { lotId: zl.lotId, take: 5 },
      ],
      [...p.codes, ...zl.codes],
      W.yw,
      W.tas,
    );
    await cost(b.id, 1000, `${YEAR}-03-04`);
    // P1: B's freight 500 + A's customs 100 — and NOT A's road cell.
    expect((await boxLandedCost(p.boxIds[0]!)).totalUsd).toBe(600);
    expect((await batchLandedCostByLot(b.id)).get(p.lotId)).toMatchObject({ totalUsd: 600, batchUsd: 500 });

    // The repair converges: a re-split leaves the road cell where it is.
    await applyRiderRepair({ leftBehind: plan.leftBehind.filter((row) => row.batchId === a.id), rogue: [], stampedCells: [] });
    expect(await allocated(roadCell)).toBe(0);

    // A test prixod that rode A annulled: the sweep voids money with no cargo
    // left, never ANOTHER prixod's grid cell whose base is empty for its own
    // reason.
    await annulReceipt(tl.receiptId, 'test tozalash', { id: actorId, roles: ['super_admin'] }, ctx());
    const [stillLive] = await db
      .select({ voidedAt: costEntries.voidedAt })
      .from(costEntries)
      .where(eq(costEntries.id, roadCell));
    expect(stillLive!.voidedAt).toBeNull();

    // A split written before this rule left the road cell on the carton: the
    // dashboard's «phantom» sees it like the repair plan does, and the repair
    // moves it.
    await db.insert(costAllocations).values({ costEntryId: roadCell, boxId: p.boxIds[0]!, clientId: x, amountUsd: '60' });
    expect((await cargoRiskList('phantom', [W.yw])).map((row) => row.boxId)).toContain(p.boxIds[0]);
    expect((await riderRepairPlan()).leftBehind.find((row) => row.batchId === a.id)).toMatchObject({ usd: 60 });
    await applyRiderRepair({ leftBehind: [{ batchId: a.id, code: '', boxes: 1, usd: 60 }], rogue: [], stampedCells: [] });
    expect(await allocated(roadCell)).toBe(0);
    expect((await cargoRiskList('phantom', [W.yw])).map((row) => row.boxId)).not.toContain(p.boxIds[0]);
  });

  it('a road cell of a prixod short-loaded before the truck left lands on no box, and is named on that truck (review of wa2)', async () => {
    const c = await mkClient('B4');
    const lot = await mkLot(c, 2, 10, W.yw);
    const other = await mkLot(c, 1, 10, W.yw);
    // The prixod is planned but never scanned: short-loaded, it never left.
    const z = await loadTruck(
      [
        { lotId: lot.lotId, take: 2 },
        { lotId: other.lotId, take: 1 },
      ],
      other.codes,
      W.yw,
      W.tas,
    );
    await addReceiptCostsBulk(
      {
        batchId: z.id,
        currency: 'USD',
        costDate: `${YEAR}-04-02`,
        cells: [{ receiptId: lot.receiptId, costTypeId: freightTypeId, amount: 40 }],
      },
      ctx(),
    );
    await finishLoading(z.id, ctx());
    await departBatch(z.id, ctx());
    await recomputeAll({ batchId: z.id }); // what departBatchAction enqueues
    const [cell] = await db
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(and(eq(costEntries.batchId, z.id), eq(costEntries.receiptId, lot.receiptId)));
    // It pinned the whole-prixod fallback as intended: the cell stayed on the
    // two cartons that never left Yiwu and rode the NEXT truck as «shu
    // reysgacha» — Z's road billed twice (the owner's Q2 forbids it).
    expect(await allocated(cell!.id)).toBe(0);
    expect((await truckRow(z.id)).unallocatedUsd).toBe(40);
  });
});

describe('U25 — only a carton that came from somewhere else rode the truck', () => {
  it('a carton already standing on the destination floor, scanned by mistake, takes no share', async () => {
    const ac = await mkClient('DA');
    const lc = await mkClient('DL');
    const la = await mkLot(ac, 2, 10, W.yw);
    // A local prixod, received at the Tashkent floor itself.
    const local = await mkLot(lc, 1, 10, W.tas);
    const e = await truck([{ lotId: la.lotId, take: 2 }], la.codes, W.yw, W.tas);
    const freight = await cost(e.id, 300, `${YEAR}-05-02`);
    const acks = await unload(e.id, [...la.codes, local.codes[0]!]);
    expect(acks.map((ack) => ack.result)).toEqual(['ok', 'ok', 'auto_transfer']);
    await recomputeAll({ batchId: e.id }); // what the queued job runs

    expect(await allocated(freight.id, local.boxIds[0])).toBe(0);
    expect(await allocated(freight.id, la.boxIds[0])).toBeCloseTo(150, 2);
    expect(await batchCostSheet(e.id, ALL_COSTS)).toMatchObject({ boxCount: 2, kg: 20 });
    expect((await batchLots(e.id)).map((lot) => lot.lotId)).not.toContain(local.lotId);
    expect((await clientCargo(lc)).trips.map((trip) => trip.batchId)).not.toContain(e.id);
  });

  it('the re-split is QUEUED, re-armed by a replay, and the nightly net finds a split it missed', async () => {
    const u = await mkClient('QU');
    const v = await mkClient('QV');
    const lu = await mkLot(u, 2, 50, W.yw);
    const lv = await mkLot(v, 3, 100, W.yw);
    const e = await truck(
      [
        { lotId: lv.lotId, take: 3 },
        { lotId: lu.lotId, take: 1 },
      ],
      lv.codes,
      W.yw,
      W.tas,
    );
    const freight = await cost(e.id, 3000, `${YEAR}-06-02`);
    enqueued.length = 0;
    const rogue = scan(e.id, lu.codes[0]!);
    // Attempt 1: the rogue landing commits, then a later input throws — the
    // route answers 500 and the phone will re-send the batch.
    await expect(
      ingestUnloadScans([rogue, { ...scan(e.id, lv.codes[0]!), scannedAt: 'not-a-date' }], ctx()),
    ).rejects.toThrow();
    expect(queuedFor(e.id)).toBe(1);
    enqueued.length = 0;

    // Attempt 2: the same uuid comes back as a replay, and still re-arms.
    const acks = await ingestUnloadScans([rogue, ...lv.codes.map((code) => scan(e.id, code))], ctx());
    expect(acks[0]).toMatchObject({ result: 'ok', detail: 'replay' });
    expect(queuedFor(e.id)).toBe(1);
    // Nothing was re-split inside the scanner's request.
    expect(await allocated(freight.id, lu.boxIds[0])).toBe(0);

    // HISTORY is not a stale split (review of the riders unit): a split
    // written AFTER the carton was scanned off, under the old rule, moves
    // only with `pnpm repair-riders --apply` — never by itself overnight.
    const later = new Date(Date.now() + 60_000);
    await db.update(costAllocations).set({ computedAt: later }).where(eq(costAllocations.costEntryId, freight.id));
    await recomputeAll({ orphaned: true, batchId: e.id });
    expect(await allocated(freight.id, lu.boxIds[0])).toBe(0);
    await db
      .update(costAllocations)
      .set({ computedAt: new Date('2000-01-01T00:00:00Z') })
      .where(eq(costAllocations.costEntryId, freight.id));

    // The nightly repair is the net under a queue that never ran: a rider
    // holding no share of its truck is a split that must be redone. Scoped to
    // this truck, so the test says nothing about anybody else's costs (#713).
    await recomputeAll({ orphaned: true, batchId: e.id });
    expect(await allocated(freight.id, lu.boxIds[0])).toBeCloseTo(428.57, 2);
    expect(await allocated(freight.id, lv.boxIds[0])).toBeCloseTo(857.14, 2);

    // The register counts the rider the manifest does not.
    expect((await batchRegister()).find((row) => row.id === e.id)).toMatchObject({ loaded: 4, kg: 350 });
  });
});

describe('the re-split after a found-back carton has a durable retry', () => {
  let failing: { batchId: string; entryId: string; code: string } | null = null;

  it('resolveMissing queues the truck when its re-split fails', async () => {
    const c = await mkClient('FR');
    const lot = await mkLot(c, 2, 10, W.yw);
    const f = await truck([{ lotId: lot.lotId, take: 2 }], lot.codes, W.yw, W.tas);
    const entry = await cost(f.id, 100, `${YEAR}-07-02`);
    // A frozen figure too big for an allocation row: every re-split of this
    // truck throws (numeric overflow) — a failure on demand.
    await db.update(costEntries).set({ amountUsd: '50000000000' }).where(eq(costEntries.id, entry.id));
    await unload(f.id, [lot.codes[0]!]);
    await finishUnload(f.id, ctx(), { mayCloseWithMissing: true });
    enqueued.length = 0;
    await resolveMissing({ boxId: lot.boxIds[1]!, resolution: 'found_at_origin' }, ctx());
    expect(queuedFor(f.id)).toBe(1);
    const [row] = await db.select({ code: batches.code }).from(batches).where(eq(batches.id, f.id));
    failing = { batchId: f.id, entryId: entry.id, code: row!.code };
  });

  it('the one-off repair: one truck failing does not stop the next', async () => {
    const c = await mkClient('RP');
    const lot = await mkLot(c, 2, 10, W.yw);
    const g = await truck([{ lotId: lot.lotId, take: 2 }], lot.codes, W.yw, W.tas);
    const entry = await cost(g.id, 80, `${YEAR}-07-03`);
    await db.delete(costAllocations).where(eq(costAllocations.costEntryId, entry.id));
    const [row] = await db.select({ code: batches.code }).from(batches).where(eq(batches.id, g.id));
    const done = await applyRiderRepair({
      leftBehind: [],
      rogue: [
        { batchId: failing!.batchId, code: failing!.code, boxes: 1 },
        { batchId: g.id, code: row!.code, boxes: 1 },
      ],
      stampedCells: [],
    });
    expect(done.failed.map((failure) => failure.batchId)).toEqual([failing!.batchId]);
    expect(await allocated(entry.id)).toBeCloseTo(80, 2);
    // Put the figure back, or the next sweep in this database trips on it.
    await db.update(costEntries).set({ amountUsd: '100' }).where(eq(costEntries.id, failing!.entryId));
    await recomputeAll({ batchId: failing!.batchId });
  });
});

describe('U35 — a loss belongs to the leg it happened on', () => {
  it('a carton delivered by A and lost on B is lost on B only', async () => {
    const c = await mkClient('TL');
    const lot = await mkLot(c, 3, 50, W.yw);
    const a = await truck([{ lotId: lot.lotId, take: 3 }], lot.codes, W.yw, W.and);
    await unload(a.id, lot.codes);
    await finishUnload(a.id, ctx());
    const b = await truck([{ lotId: lot.lotId, take: 3 }], lot.codes, W.and, W.tas);
    await unload(b.id, lot.codes.slice(0, 2));
    await finishUnload(b.id, ctx(), { mayCloseWithMissing: true });
    await resolveMissing(
      { boxId: lot.boxIds[2]!, resolution: 'lost_in_transit', reason: 'yo‘lda yo‘qoldi' },
      ctx(),
    );
    const onA = (await batchLots(a.id)).find((row) => row.lotId === lot.lotId)!;
    const onB = (await batchLots(b.id)).find((row) => row.lotId === lot.lotId)!;
    // A delivered all 150 kg to Andijan; the price there is per kg of that.
    expect(onA).toMatchObject({ onBatch: 3, lostCount: 0, arrivedKg: 150 });
    expect(onB).toMatchObject({ onBatch: 3, lostCount: 1, arrivedKg: 100 });
  });
});

describe('U19 — the landed-cost report names unclaimed cargo', () => {
  it('an «Egasiz yuk» row, its drill-down and the file', async () => {
    const nullRow = async () => (await landedCostByClient()).find((row) => row.clientId === null)?.totalUsd ?? 0;
    const before = await nullRow();
    const c = await mkClient('UC');
    const claimed = await mkLot(c, 2, 10, W.yw);
    const unclaimed = await mkLot(null, 2, 10, W.yw);
    const h = await truck(
      [
        { lotId: claimed.lotId, take: 2 },
        { lotId: unclaimed.lotId, take: 2 },
      ],
      [...claimed.codes, ...unclaimed.codes],
      W.yw,
      W.tas,
    );
    await cost(h.id, 400, `${YEAR}-08-02`);
    const rows = await landedCostByClient();
    expect(Math.round(((await nullRow()) - before) * 100) / 100).toBe(200);
    // The report is every live allocation, unclaimed included.
    const [all] = await db
      .select({ usd: sql<string>`coalesce(sum(${costAllocations.amountUsd}), 0)` })
      .from(costAllocations)
      .innerJoin(costEntries, eq(costAllocations.costEntryId, costEntries.id))
      .where(sql`${costEntries.voidedAt} IS NULL`);
    // Each row is rounded to cents, so the sum may drift by half a cent a row.
    const drift = Math.abs(rows.reduce((sum, row) => sum + row.totalUsd, 0) - Number(all!.usd));
    expect(drift).toBeLessThanOrEqual(rows.length * 0.005 + 0.001);
    const lot = (await landedCostByLot(null)).find((row) => row.lotId === unclaimed.lotId)!;
    expect(lot).toMatchObject({ totalUsd: 200, boxCount: 2, marking: `LG${S}2` });

    const L = reportLabels('uz');
    const file = await sheetRows(await buildLandedCostXlsx(undefined, 'uz'));
    expect(file.some((row) => row[0] === L.unclaimedCargo)).toBe(true);
    const drill = await sheetRows(await buildLandedCostXlsx(null, 'uz'));
    expect(String(drill[0]![0])).toContain(L.unclaimedCargo);
    expect(drill.some((row) => String(row[0]).startsWith(`LG${S}2-`))).toBe(true);
  });
});

describe('a write-off can finish a deal — every door asks the funnel', () => {
  let stPartial = '';
  let stHanded = '';

  /** A deal whose first prixod is handed over and whose second is on the shelf. */
  async function dealWithOneLeft(tag: string) {
    const c = await mkClient(tag);
    const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
    const [deal] = await db
      .insert(deals)
      .values({ code: `LG-${tag}${S}`, clientId: c, stageId: stage!.id, createdBy: actorId })
      .returning({ id: deals.id });
    made.deals.push(deal!.id);
    const mint = async (status: string, warehouseId: string) => {
      const [receipt] = await db
        .insert(receipts)
        .values({ warehouseId: W.yw, clientId: c, status: 'confirmed', confirmedAt: new Date(), createdBy: actorId, dealId: deal!.id })
        .returning({ id: receipts.id });
      made.receipts.push(receipt!.id);
      const [lot] = await db
        .insert(receiptLots)
        .values({ receiptId: receipt!.id, seq: 1, letter: 'A', dimsMode: 'mixed', productNameZh: '测试', boxCount: 1, totalWeightKg: '10', totalVolumeM3: '0.1' })
        .returning({ id: receiptLots.id });
      const [box] = await db
        .insert(boxes)
        .values({ lotId: lot!.id, shortCode: `LG${S}${tag}${status.slice(0, 2)}`, seqInLot: 1, status, currentWarehouseId: warehouseId })
        .returning({ id: boxes.id });
      await db.insert(boxMovements).values({ boxId: box!.id, toWarehouseId: warehouseId, toStatus: status, cause: 'receipt', refType: 'receipt', refId: receipt!.id, actorId });
      return { receiptId: receipt!.id, boxId: box!.id };
    };
    await mint('issued', W.tas);
    const left = await mint('in_stock', W.yw);
    // Its first cargo's handover parked it at «qisman topshirildi».
    await moveDeal(deal!.id, stPartial, ctx());
    return { dealId: deal!.id, ...left };
  }

  const stageOf = async (dealId: string) =>
    (await db.query.deals.findFirst({ where: eq(deals.id, dealId) }))!.stageId;

  beforeAll(async () => {
    // Far right of every seeded stage, so each cargo move here is FORWARD.
    const mkStage = async (name: string, sortOrder: number, cargoTrigger: string) =>
      (
        await db
          .insert(dealStages)
          .values({ name: `${name} ${S}`, kind: 'open', color: 'blue', sortOrder, cargoTrigger })
          .returning({ id: dealStages.id })
      )[0]!.id;
    stPartial = await mkStage('LG-qisman', 9160, 'handed_partial');
    stHanded = await mkStage('LG-topshirildi', 9165, 'handed');
    made.stages.push(stPartial, stHanded);
  });

  it('written off on the shelf (markBoxLost): the deal is fully handed', async () => {
    const d = await dealWithOneLeft('ML');
    await markBoxLost({ boxId: d.boxId, reason: 'ezilgan', atWarehouseId: W.yw }, ctx());
    expect(await stageOf(d.dealId)).toBe(stHanded);
  });

  it('the stocktake ticks it lost: the deal is fully handed', async () => {
    const d = await dealWithOneLeft('ST');
    await reconcileInventory(
      { warehouseId: W.yw, foundHereCodes: [], lostBoxIds: [d.boxId], scannedCount: 0 },
      { canMarkLost: true },
      ctx(),
    );
    expect(await stageOf(d.dealId)).toBe(stHanded);
  });

  it('the duplicate prixod is voided: the deal is fully handed', async () => {
    const d = await dealWithOneLeft('VR');
    await voidReceipt(d.receiptId, 'dublikat', ctx());
    expect(await stageOf(d.dealId)).toBe(stHanded);
  });
});
