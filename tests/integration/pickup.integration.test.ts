import 'dotenv/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  boxMovements,
  boxes,
  clientNotices,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  factories,
  pickups,
  pickupStops,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt, ReceiptError, voidReceipt } from '@/modules/wms/receipts/service';
import { addCostEntry, voidCostEntry } from '@/modules/wms/costing/service';
import {
  cancelPickup,
  collectStop,
  createPickup,
  incomingForWarehouses,
  linkReceiptToStop,
  loadPickup,
  NOTICE_PICKED_UP,
  pickupCandidates,
  PickupError,
  receivePrefillFor,
  refreshLegs,
  removeStop,
  resolveLineOwners,
  saveFactory,
  saveStopLines,
  setFactoryPoint,
} from '@/modules/wms/pickups/service';
import { pickedUpMessageFor, pickedUpText } from '@/modules/wms/pickups/notice';

/**
 * «Zavod reysi» (owner, 2026-09-24, B1-B6): a truck WE hire collects from
 * two factories and brings the cargo to our warehouse, where it is received,
 * recounted and labelled like any prixod — and the truck's cost is split by
 * m³ over what it brought. Everything here is this file's own: a CN
 * warehouse, two factories, two clients.
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
let whId: string;
let otherWhId: string;
let clientA: string;
let clientB: string;
let codeA: string;
let factory1: string;
let factory2: string;
let costTypeId: string;
const madePickups: string[] = [];
const madeReceipts: string[] = [];
const madeFactories: string[] = [];
const ctx = () => ({ actorId });

async function mintWarehouse(code: string) {
  return (
    await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: `Zavod ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' })
      .returning({ id: warehouses.id })
  )[0]!.id;
}

/** A prixod through the real door, photo pre-bound as the wizard does it. */
async function receive(opts: { clientId: string | null; m3: number; stopId?: string | null; warehouseId?: string; marking?: string }) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `pickup-test/${lotId}`,
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
      unclaimedMarking: opts.marking ?? '',
      lots: [
        {
          id: lotId,
          productNameZh: `货${S}`,
          productNameRu: '',
          boxCount: 2,
          dimsMode: 'mixed',
          totalWeightKg: 100,
          totalVolumeM3: opts.m3,
          note: '',
        },
      ],
      extraCosts: [],
      pickupStopId: opts.stopId ?? null,
    },
    ctx(),
  );
  return receiptId;
}

async function tripWithTwoFactories() {
  const lines = await resolveLineOwners([
    { owner: codeA, goods: `Oyinchoq ${S}`, factoryBoxes: 50, volumeM3: 1, weightKg: 200 },
    { owner: `MARK${S}`, goods: `Nomalum ${S}`, factoryBoxes: 3 },
  ]);
  const second = await resolveLineOwners([{ owner: `GS-NONE-${S}`, goods: 'x', factoryBoxes: 1 }]);
  const created = await createPickup(
    {
      destWarehouseId: whId,
      vehiclePlate: `A${S}`,
      stops: [
        { factoryId: factory1, lines },
        { factoryId: factory2, lines: second },
      ],
    },
    ctx(),
  );
  madePickups.push(created.id);
  return created;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  whId = await mintWarehouse(`ZR${S}`);
  otherWhId = await mintWarehouse(`ZO${S}`);
  codeA = `ZA${S}`;
  clientA = (await db.insert(clients).values({ clientCode: codeA, name: `Zavod A ${S}` }).returning({ id: clients.id }))[0]!.id;
  clientB = (await db.insert(clients).values({ clientCode: `ZB${S}`, name: `Zavod B ${S}` }).returning({ id: clients.id }))[0]!.id;
  factory1 = (await saveFactory({ name: `Yiwu toys ${S}`, address: '义乌市某路1号', phone: '+86 1' }, ctx())).id;
  factory2 = (await saveFactory({ name: `Jinhua ${S}` }, ctx())).id;
  madeFactories.push(factory1, factory2);
});

afterAll(async () => {
  const receiptIds = madeReceipts;
  if (receiptIds.length) {
    const lots = await db.select({ id: receiptLots.id }).from(receiptLots).where(inArray(receiptLots.receiptId, receiptIds));
    const lotIds = lots.map((l) => l.id);
    const boxIds = lotIds.length
      ? (await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))).map((b) => b.id)
      : [];
    if (boxIds.length) {
      await db.delete(costAllocations).where(inArray(costAllocations.boxId, boxIds));
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
      await db.delete(boxes).where(inArray(boxes.id, boxIds));
    }
    if (lotIds.length) {
      await db.delete(attachments).where(inArray(attachments.entityId, lotIds));
      await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    }
    await db.delete(receipts).where(inArray(receipts.id, receiptIds));
  }
  if (madePickups.length) {
    const entries = await db.select({ id: costEntries.id }).from(costEntries).where(inArray(costEntries.pickupId, madePickups));
    if (entries.length) {
      await db.delete(costAllocations).where(inArray(costAllocations.costEntryId, entries.map((e) => e.id)));
      await db.delete(costEntries).where(inArray(costEntries.id, entries.map((e) => e.id)));
    }
    await db.delete(pickups).where(inArray(pickups.id, madePickups));
  }
  await db.delete(clientNotices).where(inArray(clientNotices.clientId, [clientA, clientB]));
  if (madeFactories.length) await db.delete(factories).where(inArray(factories.id, madeFactories));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB]));
  // Audited actions touched them: the audit log's FK allows deactivation only.
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whId, otherWhId]));
});

describe('zavod reysi', () => {
  it('a client code becomes the client, anything else stays a marking', async () => {
    const [known, unknown] = await resolveLineOwners([
      { owner: codeA.toLowerCase(), goods: 'g', factoryBoxes: 1 },
      { owner: `MARK${S}`, goods: 'g', factoryBoxes: 1 },
    ]);
    expect(known).toMatchObject({ clientId: clientA, marking: '' });
    expect(unknown).toMatchObject({ clientId: null, marking: `MARK${S}` });
  });

  it('mints ZR- codes, and «olindi» is ONE press that puts the truck on the road and tells the client', async () => {
    const { id, code } = await tripWithTwoFactories();
    expect(code).toMatch(/^ZR-\d{5,}$/);
    const trip = (await loadPickup(id))!;
    expect(trip.pickup.status).toBe('planned');
    const stop1 = trip.stops[0]!;
    const aLine = stop1.lines.find((l) => l.clientId === clientA)!;

    await collectStop(stop1.id, { driverBoxes: { [aLine.id]: 48 } }, ctx());
    await expect(collectStop(stop1.id, {}, ctx())).rejects.toMatchObject({ code: 'already_collected' });

    const after = (await loadPickup(id))!;
    expect(after.pickup.status).toBe('on_road');
    expect(after.stops[0]!.lines.find((l) => l.id === aLine.id)!.driverBoxes).toBe(48);
    // One row, for the CLIENT line; a marking is not a person.
    const notices = await db
      .select()
      .from(clientNotices)
      .where(and(eq(clientNotices.kind, NOTICE_PICKED_UP), eq(clientNotices.refId, stop1.id)));
    expect(notices.map((n) => n.clientId)).toEqual([clientA]);

    const message = await pickedUpMessageFor(clientA, stop1.id);
    expect(message).toMatchObject({ lines: [{ goods: `Oyinchoq ${S}`, boxes: 48 }], warehouseCode: `ZR${S}` });
    const text = pickedUpText((message as { lines: { goods: string; boxes: number }[] }).lines, codeA, `ZR${S}`, 'uz');
    expect(text).toContain('zavoddan olindi');
    expect(text).toContain('48');
    // No date, no truck — the trip's code is the company's, not the customer's.
    expect(text).not.toContain('ZR-');
  });

  it('receives through the truck: the prixod names its stop, the list empties, and the wrong warehouse is refused', async () => {
    const { id } = await tripWithTwoFactories();
    const stop1 = (await loadPickup(id))!.stops[0]!;
    const incomingBefore = (await incomingForWarehouses([whId])).find((t) => t.pickupId === id)!;
    expect(incomingBefore.stops[0]!.owners.map((o) => o.ownerKey)).toContain(clientA);

    // The prefill carries the factory's lines for that owner, count EMPTY.
    const prefill = (await receivePrefillFor(stop1.id, clientA))!;
    expect(prefill.lines.map((l) => l.goods)).toEqual([`Oyinchoq ${S}`]);

    await expect(receive({ clientId: clientA, m3: 1, stopId: stop1.id, warehouseId: otherWhId })).rejects.toBeInstanceOf(
      ReceiptError,
    );
    const receiptId = await receive({ clientId: clientA, m3: 1, stopId: stop1.id });
    const row = (await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) }))!;
    expect(row.pickupStopId).toBe(stop1.id);
    expect((await loadPickup(id))!.pickup.status).toBe('arrived');

    const incomingAfter = (await incomingForWarehouses([whId])).find((t) => t.pickupId === id);
    const owners = incomingAfter?.stops[0]?.owners.map((o) => o.ownerKey) ?? [];
    expect(owners).not.toContain(clientA);
    // What was promised cannot be rewritten under a received prixod.
    await expect(saveStopLines(stop1.id, [], ctx())).rejects.toMatchObject({ code: 'stop_linked' });
    await expect(removeStop(stop1.id, ctx())).rejects.toBeInstanceOf(PickupError);
  });

  it('splits the truck by m³ over what it brought, and re-splits when a prixod is voided', async () => {
    const { id } = await tripWithTwoFactories();
    const [stop1, stop2] = (await loadPickup(id))!.stops;
    const small = await receive({ clientId: clientA, m3: 1, stopId: stop1!.id });
    const big = await receive({ clientId: clientB, m3: 3, stopId: stop2!.id });
    const entry = await addCostEntry(
      {
        scope: 'pickup',
        pickupId: id,
        costTypeId,
        amount: 100,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'volume',
      },
      ctx(),
    );
    const shareOf = async (receiptId: string) => {
      const rows = await db
        .select({ amount: costAllocations.amountUsd })
        .from(costAllocations)
        .innerJoin(boxes, eq(costAllocations.boxId, boxes.id))
        .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
        .where(and(eq(costAllocations.costEntryId, entry.id), eq(receiptLots.receiptId, receiptId)));
      return Math.round(rows.reduce((a, r) => a + Number(r.amount), 0) * 100) / 100;
    };
    expect(await shareOf(small)).toBe(25);
    expect(await shareOf(big)).toBe(75);

    // A money-bearing truck cannot be cancelled away.
    await expect(cancelPickup(id, 'test', ctx())).rejects.toMatchObject({ code: 'pickup_has_costs' });

    await voidReceipt(big, 'test', ctx());
    expect(await shareOf(small)).toBe(100);
    expect(await shareOf(big)).toBe(0);

    await voidCostEntry(entry.id, 'test', ctx());
    await expect(cancelPickup(id, 'test', ctx())).rejects.toMatchObject({ code: 'pickup_has_receipts' });
  });

  it('a prixod received the ordinary way is a CANDIDATE, never linked by itself; attaching re-splits', async () => {
    const { id } = await tripWithTwoFactories();
    const stop1 = (await loadPickup(id))!.stops[0]!;
    await collectStop(stop1.id, {}, ctx());
    const loose = await receive({ clientId: clientA, m3: 2 });
    const unrelated = await receive({ clientId: clientB, m3: 2 });

    const candidates = await pickupCandidates(id);
    expect(candidates.map((c) => c.id)).toContain(loose);
    // ClientB is on stop 2's lines? No — stop 2 carries only a marking.
    expect(candidates.map((c) => c.id)).not.toContain(unrelated);
    expect(candidates.find((c) => c.id === loose)!.stops.map((s) => s.id)).toEqual([stop1.id]);
    expect((await db.query.receipts.findFirst({ where: eq(receipts.id, loose) }))!.pickupStopId).toBeNull();

    const entry = await addCostEntry(
      {
        scope: 'pickup',
        pickupId: id,
        costTypeId,
        amount: 40,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'volume',
      },
      ctx(),
    );
    const allocated = async () =>
      (
        await db
          .select({ n: costAllocations.id })
          .from(costAllocations)
          .where(eq(costAllocations.costEntryId, entry.id))
      ).length;
    // Nothing brought yet: the money waits, it is NOT voided (pul:3).
    expect(await allocated()).toBe(0);
    await linkReceiptToStop(loose, stop1.id, ctx());
    expect(await allocated()).toBe(2);
    expect(await pickupCandidates(id)).toEqual([]);

    await linkReceiptToStop(loose, null, ctx());
    expect(await allocated()).toBe(0);
    const still = await db
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(and(eq(costEntries.id, entry.id), isNull(costEntries.voidedAt)));
    expect(still).toHaveLength(1);
    await voidCostEntry(entry.id, 'test', ctx());
  });

  it('once received, the client is not told «olindi» after «keldi»', async () => {
    const { id } = await tripWithTwoFactories();
    const stop1 = (await loadPickup(id))!.stops[0]!;
    await receive({ clientId: clientA, m3: 1, stopId: stop1.id });
    expect(await pickedUpMessageFor(clientA, stop1.id)).toEqual({ skip: 'already_received' });
    // …and a late «olindi» claims no notice for them at all.
    await collectStop(stop1.id, {}, ctx());
    const rows = await db
      .select()
      .from(clientNotices)
      .where(and(eq(clientNotices.refId, stop1.id), eq(clientNotices.clientId, clientA)));
    expect(rows).toHaveLength(0);
  });

  it('a pasted Chinese-map point is converted, placing it confirms it, and the road is stored per leg', async () => {
    await setFactoryPoint(factory1, { text: '29.3060, 120.0750', datum: 'gcj02' }, ctx());
    const f = (await db.query.factories.findFirst({ where: eq(factories.id, factory1) }))!;
    expect(f.geoSource).toBe('manual');
    expect(f.geoConfirmedAt).not.toBeNull();
    // GCJ-02 → WGS-84 moves a Yiwu point by a few hundred metres, west/south.
    expect(Number(f.lon)).toBeLessThan(120.075);
    expect(Number(f.lon)).toBeGreaterThan(120.06);

    await setFactoryPoint(factory2, { text: '29.08, 119.65', datum: 'wgs84' }, ctx());
    const { id } = await tripWithTwoFactories();
    await refreshLegs(id);
    const stops = await db.select().from(pickupStops).where(eq(pickupStops.pickupId, id));
    const first = stops.find((s) => s.seq === 1)!;
    // GEO_NETWORK=off in the suite: a straight line, both ends exact.
    expect(first.legSource).toBe('line');
    expect(first.legPoints![0]).toEqual([Number(f.lon), Number(f.lat)]);
    expect(first.legPoints!.at(-1)).toEqual([119.65, 29.08]);
    expect(Number(first.legHours)).toBeGreaterThan(0);
  });
});
