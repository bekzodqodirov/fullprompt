import 'dotenv/config';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxMovements,
  boxes,
  clientNotices,
  clients,
  costAllocations,
  driverDevices,
  factories,
  loadPlanLines,
  loadPlans,
  loadPlanVersions,
  pickups,
  receiptLots,
  receipts,
  scanEvents,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { editLot } from '@/modules/wms/receipts/edit';
import { MoveError, moveReceipt } from '@/modules/wms/receipts/move';
import { createPickup, resolveLineOwners, saveFactory } from '@/modules/wms/pickups/service';
import {
  arrivalLabelsForPairs,
  arrivalRowsForLots,
  arrivalsForLots,
} from '@/modules/wms/documents/arrivals';
import { buildAgentXlsx } from '@/modules/wms/documents/agent-xlsx';
import { buildPackingPhotosXlsx } from '@/modules/wms/documents/packing-photos-xlsx';
import { DOC } from '@/modules/wms/documents/labels';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { ingestLoadScans } from '@/modules/wms/scanning/service';
import { clientFeed } from '@/modules/wms/crm/feed';
import { loadYuklarView } from '@/modules/wms/client-card/yuklar-view';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * «Shu zavoddan, shu mashinada» (docs/ZAVOD-YOPISH.md §5, the owner's item
 * 6): cargo received off a factory trip used to read «Принято на складе /
 * Received here» on the agent sheet he downloads, and nothing at all on the
 * truck's photo packing list. The arrival rule now names the TRIP — its code,
 * the factory of the prixod's stop, the plate — and every surface prints it.
 *
 * One trip, two stops (two factories), heading to this file's own CN
 * warehouse; a walk-in beside it; and a prixod at ANOTHER warehouse whose
 * stop points at that trip anyway — what the destination guard is for.
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
let whId: string;
let otherWhId: string;
let clientA: string;
let clientB: string;
let factory1: string;
let factory2: string;
let tripId: string;
let tripCode: string;
const PLATE = `01A${S}`;
const F1 = `Jinhua ${S}`;
const F2 = `Yiwu toys ${S}`;
const madeReceipts: string[] = [];
const madeFactories: string[] = [];
const madePlans: string[] = [];
const madeBatches: string[] = [];
const ctx = () => ({ actorId });

/** The lots, by role. */
const lot = { A: '', B: '', C: '', D: '' };
const receipt = { A: '', B: '', C: '', D: '' };
const NAME = { A: `货A${S}`, B: `货B${S}`, C: `货C${S}`, D: `货D${S}` };

async function mintWarehouse(code: string) {
  return (
    await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: `Zavod ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' })
      .returning({ id: warehouses.id })
  )[0]!.id;
}

/** A prixod through the real door, photo pre-bound as the wizard does it. */
async function receive(key: keyof typeof lot, opts: { clientId: string; stopId?: string | null; warehouseId?: string }) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `zavod-arrivals/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  madeReceipts.push(receiptId);
  await confirmReceipt(
    {
      receiptId,
      warehouseId: opts.warehouseId ?? whId,
      clientId: opts.clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: NAME[key],
          productNameRu: '',
          boxCount: 2,
          dimsMode: 'mixed',
          totalWeightKg: 100,
          totalVolumeM3: 1,
          note: '',
        },
      ],
      extraCosts: [],
      pickupStopId: opts.stopId ?? null,
    },
    ctx(),
  );
  lot[key] = lotId;
  receipt[key] = receiptId;
}

const label = (factory: string) => `${tripCode} · ${factory} · ${PLATE}`;

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  whId = await mintWarehouse(`ZY${S}`);
  otherWhId = await mintWarehouse(`ZX${S}`);
  clientA = (await db.insert(clients).values({ clientCode: `ZQ${S}`, name: `Zavod Q ${S}` }).returning({ id: clients.id }))[0]!.id;
  clientB = (await db.insert(clients).values({ clientCode: `ZW${S}`, name: `Zavod W ${S}` }).returning({ id: clients.id }))[0]!.id;
  factory1 = (await saveFactory({ name: F1 }, ctx())).id;
  factory2 = (await saveFactory({ name: F2 }, ctx())).id;
  madeFactories.push(factory1, factory2);

  // Stop 1 at Jinhua for client A, stop 2 at Yiwu toys for client B.
  const created = await createPickup(
    {
      destWarehouseId: whId,
      vehiclePlate: PLATE,
      stops: [
        { factoryId: factory1, lines: await resolveLineOwners([{ owner: `ZQ${S}`, goods: 'Oyinchoq', factoryBoxes: 2 }]) },
        { factoryId: factory2, lines: await resolveLineOwners([{ owner: `ZW${S}`, goods: 'Kiyim', factoryBoxes: 2 }]) },
      ],
    },
    ctx(),
  );
  tripId = created.id;
  tripCode = created.code;
  const stops = await db.execute<{ id: string; seq: number }>(
    sql`SELECT id, seq FROM pickup_stops WHERE pickup_id = ${tripId}::uuid ORDER BY seq`,
  );
  const [stop1, stop2] = [stops[0]!.id, stops[1]!.id];

  await receive('A', { clientId: clientA, stopId: stop1 });
  await receive('B', { clientId: clientB, stopId: stop2 });
  // A walk-in beside them: same client, no truck.
  await receive('C', { clientId: clientA });
  // Received at ANOTHER warehouse, then pointed at stop 1 by hand — the shape
  // a link to a trip heading elsewhere leaves behind. The trip was going to
  // `whId`; at `otherWhId` it is not this cargo's truck.
  await receive('D', { clientId: clientA, warehouseId: otherWhId });
  await db.update(receipts).set({ pickupStopId: stop1 }).where(eq(receipts.id, receipt.D));

  // Lot A grows by one carton at the trip's destination (`editLot` →
  // `lot_edit_add`, ref the same receipt): it came off the same factory.
  const manager = { id: actorId, permissions: new Set(['receipts.void']) } as unknown as Actor;
  await editLot(
    { lotId: lot.A, productNameZh: NAME.A, boxCount: 3, totalWeightKg: 150, totalVolumeM3: 1.5 },
    manager,
    ctx(),
  );
});

afterAll(async () => {
  const lotIds = Object.values(lot).filter(Boolean);
  const boxIds = lotIds.length
    ? (await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))).map((b) => b.id)
    : [];
  if (madeBatches.length) {
    await db.delete(scanEvents).where(inArray(scanEvents.batchId, madeBatches));
  }
  if (boxIds.length) {
    await db.delete(scanEvents).where(inArray(scanEvents.boxId, boxIds));
    await db.delete(costAllocations).where(inArray(costAllocations.boxId, boxIds));
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
    await db.delete(boxes).where(inArray(boxes.id, boxIds));
  }
  if (madePlans.length) {
    const versions = (
      await db.select({ id: loadPlanVersions.id }).from(loadPlanVersions).where(inArray(loadPlanVersions.planId, madePlans))
    ).map((v) => v.id);
    if (versions.length) await db.delete(loadPlanLines).where(inArray(loadPlanLines.versionId, versions));
    await db.delete(loadPlanVersions).where(inArray(loadPlanVersions.planId, madePlans));
    await db.delete(loadPlans).where(inArray(loadPlans.id, madePlans));
  }
  if (madeBatches.length) {
    await db.delete(driverDevices).where(inArray(driverDevices.batchId, madeBatches));
    await db.delete(batches).where(inArray(batches.id, madeBatches));
  }
  if (lotIds.length) {
    await db.delete(attachments).where(inArray(attachments.entityId, lotIds));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  if (madeReceipts.length) await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  if (tripId) await db.delete(pickups).where(eq(pickups.id, tripId));
  await db.delete(clientNotices).where(inArray(clientNotices.clientId, [clientA, clientB]));
  if (madeFactories.length) await db.delete(factories).where(inArray(factories.id, madeFactories));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB]));
  // Audited actions touched them: the audit log's FK allows deactivation only.
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whId, otherWhId]));
});

describe('the arrival rule names the factory trip', () => {
  it('a prixod off the trip names it — code, its OWN stop’s factory, plate; the walk-in names nothing', async () => {
    const arrivals = await arrivalsForLots([lot.A, lot.B, lot.C], whId);
    expect(arrivals.get(lot.A)).toMatchObject({ codes: [tripCode], labels: [label(F1)] });
    expect(arrivals.get(lot.A)!.sources[0]).toMatchObject({ kind: 'pickup', id: tripId, factory: F1, plate: PLATE });
    expect(arrivals.get(lot.B)).toMatchObject({ codes: [tripCode], labels: [label(F2)] });
    expect(arrivals.get(lot.C)).toMatchObject({ codes: [], labels: [] });
  });

  it('a carton grown at the destination belongs to the trip too — one named row, not a named and an unnamed one', async () => {
    const rows = await arrivalRowsForLots([lot.A], whId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ boxes: 3, pickup: { id: tripId, code: tripCode } });
  });

  it('a trip heading to ANOTHER warehouse is not this cargo’s truck here (the destination guard)', async () => {
    const arrivals = await arrivalsForLots([lot.D], otherWhId);
    expect(arrivals.get(lot.D)).toMatchObject({ codes: [], labels: [] });
  });

  it('the stock screen’s pair read prints the label', async () => {
    const map = await arrivalLabelsForPairs([
      { lotId: lot.A, warehouseId: whId },
      { lotId: lot.D, warehouseId: otherWhId },
    ]);
    expect(map.get(`${lot.A}|${whId}`)).toEqual([label(F1)]);
    expect(map.get(`${lot.D}|${otherWhId}`) ?? []).toEqual([]);
  });

  it('is ONE statement, and touches no column 0133 added', async () => {
    // The readers that do not catch (the plan editor, the sheets) must survive
    // a deploy morning one migration behind.
    const src = (await import('node:fs')).readFileSync('src/modules/wms/documents/arrivals.ts', 'utf8');
    const fn = src.slice(src.indexOf('export async function arrivalRowsForLots('));
    expect(fn.match(/await db/g)).toHaveLength(1);
    expect(fn).not.toMatch(/closed_at|close_kind|no_cost|pickup_line_receipts/);
  });
});

describe('the client card «Yuklar» names the trip, and opens it only through its own door', () => {
  const MATRIX: Record<string, readonly string[]> = ROLE_MATRIX;
  const reader = (role: string, warehouseIds: string[] | null) => ({
    id: role,
    permissions: new Set(MATRIX[role]),
    warehouseScoped: warehouseIds !== null,
    warehouseIds: warehouseIds ?? [],
  });
  const arrivedOnA = async (actor: ReturnType<typeof reader>) => {
    const view = await loadYuklarView(actor, clientA, { days: 90, today: tashkentDay() });
    const row = view.now.sections.china.rows.find((r) => r.lotId === lot.A)!;
    return { arrivedOn: row.arrivedOn, open: view.pickupsOpen.has(tripId) };
  };

  it('prints «ZR-… · factory · plate» as a trip, never as a batch', async () => {
    const { arrivedOn } = await arrivedOnA(reader('logist', null));
    expect(arrivedOn).toEqual([{ kind: 'pickup', id: tripId, code: tripCode, label: label(F1) }]);
  });

  it('links /zavod/<trip> for the list door and for a receiver at its destination — and for nobody else', async () => {
    expect((await arrivedOnA(reader('logist', null))).open).toBe(true);
    expect((await arrivedOnA(reader('warehouse_operator', [whId]))).open).toBe(true);
    // The same role at another warehouse, and a seller: words, no link.
    expect((await arrivedOnA(reader('warehouse_operator', [otherWhId]))).open).toBe(false);
    expect((await arrivedOnA(reader('sales_manager', null))).open).toBe(false);
  });
});

describe('the papers say «shu zavoddan, shu mashinada»', () => {
  let planId = '';
  let versionNo = 0;
  let versionId = '';

  it('the agent sheet: one trip block naming both factories in stop order; each row its own; the walk-in stays «Received here»', async () => {
    const sub = await submitPlan(
      {
        originWarehouseId: whId,
        destWarehouseId: otherWhId,
        lines: [
          { lotId: lot.A, boxCount: 3 },
          { lotId: lot.B, boxCount: 2 },
          { lotId: lot.C, boxCount: 2 },
        ],
      },
      ctx(),
    );
    planId = sub.plan.id;
    versionNo = sub.version.versionNo;
    versionId = sub.version.id;
    madePlans.push(planId);

    const buffer = await buildAgentXlsx(planId, versionNo);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer! as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0]!;
    const headers = (sheet.getRow(2).values as unknown[]).map((v) => String(v ?? ''));
    const arrivalCol = headers.indexOf(DOC.arrivalBatch);
    expect(arrivalCol).toBeGreaterThan(0);

    const cells: { first: string; product: string; arrival: string }[] = [];
    sheet.eachRow((row, n) => {
      if (n <= 2) return;
      cells.push({
        first: String(row.getCell(1).value ?? ''),
        product: String(row.getCell(2).value ?? ''),
        arrival: String(row.getCell(arrivalCol).value ?? ''),
      });
    });
    const headings = cells.filter((c) => c.product === '').map((c) => c.first);
    const tripHeading = headings.find((h) => h.startsWith(`${DOC.factoryPickup}: `));
    expect(tripHeading, headings.join(' | ')).toBeTruthy();
    expect(tripHeading!.startsWith(`${DOC.factoryPickup}: ${tripCode} · ${F1}, ${F2} · ${PLATE} · `)).toBe(true);
    expect(tripHeading).toMatch(/· \d{2}\.\d{2}\.\d{4} ·/);
    // The walk-in keeps its own words, and comes last.
    expect(headings.at(-1)!.startsWith(DOC.receivedHere)).toBe(true);
    expect(headings.filter((h) => h.startsWith(DOC.receivedHere))).toHaveLength(1);
    expect(cells.find((c) => c.product.startsWith(NAME.A))!.arrival).toBe(label(F1));
    expect(cells.find((c) => c.product.startsWith(NAME.B))!.arrival).toBe(label(F2));
    expect(cells.find((c) => c.product.startsWith(NAME.C))!.arrival).toBe('—');
  });

  it('the truck’s photo packing list prints the label right before the date, the date right before the photos', async () => {
    const { batch } = await recordVerdict({ versionId, verdict: 'approved' }, ctx());
    madeBatches.push(batch!.id);
    const aboard = await db
      .select({ code: boxes.shortCode })
      .from(boxes)
      .where(inArray(boxes.lotId, [lot.A, lot.C]))
      .orderBy(asc(boxes.seqInLot));
    for (const { code } of aboard) {
      await ingestLoadScans(
        [
          {
            clientEventUuid: uuidv4(),
            batchId: batch!.id,
            code,
            method: 'qr' as const,
            addedOnSpot: false,
            scannedAt: new Date().toISOString(),
          },
        ],
        ctx(),
      );
    }

    const buffer = await buildPackingPhotosXlsx(batch!.id);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer! as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('PACKING LIST')!;
    const headers = (sheet.getRow(2).values as unknown[]).map((v) => String(v ?? ''));
    const arrivalAt = headers.indexOf(DOC.arrivalBatch);
    expect(arrivalAt).toBeGreaterThan(0);
    expect(headers[arrivalAt + 1]).toBe(DOC.date);
    expect(headers[arrivalAt + 2]).toBe(DOC.photo);
    const byProduct = new Map<string, string>();
    sheet.eachRow((row, n) => {
      if (n <= 2) return;
      byProduct.set(String(row.getCell(2).value ?? '').slice(0, NAME.A.length), String(row.getCell(arrivalAt).value ?? ''));
    });
    expect(byProduct.get(NAME.A)).toBe(label(F1));
    expect(byProduct.get(NAME.C)).toBe('—');
  });
});

describe('the lenta says which truck brought the prixod', () => {
  it('a prixod off the trip carries the trip, factory and plate; the walk-in and the guarded one carry none', async () => {
    const feed = await clientFeed(clientA, { money: false, limit: 200 });
    const cargo = new Map(feed.filter((i) => i.kind === 'cargo').map((i) => [i.id, i.meta]));
    expect(cargo.get(`rc-${receipt.A}`)).toMatchObject({ pickupCode: tripCode, factory: F1, plate: PLATE });
    expect(cargo.get(`rc-${receipt.C}`)).toMatchObject({ pickupCode: null, factory: null, plate: null });
    expect(cargo.get(`rc-${receipt.D}`)).toMatchObject({ pickupCode: null, factory: null, plate: null });
  });
});

describe('a prixod on a factory trip is not moved to another warehouse', () => {
  it('moveReceipt refuses `pickup_linked` and moves nothing', async () => {
    await expect(moveReceipt(receipt.B, otherWhId, ctx())).rejects.toThrow(MoveError);
    await expect(moveReceipt(receipt.B, otherWhId, ctx())).rejects.toThrow('pickup_linked');
    const [row] = await db.select({ wh: receipts.warehouseId }).from(receipts).where(eq(receipts.id, receipt.B));
    expect(row!.wh).toBe(whId);
  });
});
