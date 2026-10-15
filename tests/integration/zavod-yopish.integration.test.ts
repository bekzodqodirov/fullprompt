import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  boxMovements,
  boxes,
  clientNotices,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  factories,
  pickupLineReceipts,
  pickups,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt, voidReceipt } from '@/modules/wms/receipts/service';
import { addCostEntry, voidCostEntry } from '@/modules/wms/costing/service';
import { markingOfCode, markingOfCodeSql } from '@/modules/wms/pickups/owner-match';
import {
  candidateReceiptSql,
  closePickup,
  collectStop,
  declinedAtDoorSql,
  createPickup,
  incomingForWarehouses,
  linkReceiptToStop,
  listPickups,
  loadPickup,
  NOTICE_PICKED_UP,
  openStopsForOwner,
  ownerLinesOf,
  ownerMatchSql,
  pickupAttentionCounts,
  pickupCandidates,
  receivePrefillFor,
  receivePrefillRefusal,
  removeStop,
  resolveLineOwners,
  saveFactory,
  saveStopLines,
  setPickupNoCost,
  stopReceivability,
} from '@/modules/wms/pickups/service';

/**
 * «Zavod reysi yopiladi» (docs/ZAVOD-YOPISH.md, his 1a 2a 3a 4a 5a, 2026-10-15):
 * a factory trip closes when every line is received, never reopens, and a
 * prixod REMEMBERS which lines it answered — so claiming a marking, voiding a
 * prixod or the same client's next cargo can no longer bring an old trip back,
 * and the same cargo cannot be received through the trip twice. Everything
 * here is this file's own: a CN warehouse, two factories, three clients.
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
let whId: string;
let clientA: string;
let clientB: string;
let clientC: string;
let codeA: string;
let codeB: string;
let factory1: string;
let factory2: string;
let costTypeId: string;
const madePickups: string[] = [];
const madeReceipts: string[] = [];
const madeFactories: string[] = [];
const ctx = () => ({ actorId });
let n = 0;

async function receive(opts: {
  clientId: string | null;
  stopId?: string | null;
  marking?: string;
  lineIds?: string[];
  extra?: boolean;
  declined?: string[];
}) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `zavod-yopish/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  madeReceipts.push(receiptId);
  await confirmReceipt(
    {
      receiptId,
      warehouseId: whId,
      clientId: opts.clientId,
      unclaimedMarking: opts.marking ?? '',
      lots: [
        {
          id: lotId,
          productNameZh: `货${S}-${++n}`,
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
      ...(opts.lineIds ? { pickupLineIds: opts.lineIds } : {}),
      ...(opts.extra ? { pickupExtra: true } : {}),
      ...(opts.declined ? { pickupDeclined: opts.declined } : {}),
    },
    ctx(),
  );
  return receiptId;
}

/** A trip with the given lines on ONE factory stop, collected. */
async function trip(lines: { owner: string; goods: string; factoryBoxes: number }[], opts: { collect?: boolean } = {}) {
  const created = await createPickup(
    { destWarehouseId: whId, vehiclePlate: `Z${S}`, stops: [{ factoryId: factory1, lines: await resolveLineOwners(lines) }] },
    ctx(),
  );
  madePickups.push(created.id);
  const loaded = (await loadPickup(created.id))!;
  if (opts.collect !== false) await collectStop(loaded.stops[0]!.id, {}, ctx());
  return (await loadPickup(created.id))!;
}

async function statusOf(pickupId: string) {
  return (await db.query.pickups.findFirst({ where: eq(pickups.id, pickupId) }))!;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  whId = (
    await db
      .insert(warehouses)
      .values({ code: `ZY${S}`, batchPrefix: `ZY${S}`, name: `Zavod yopish ${S}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' })
      .returning({ id: warehouses.id })
  )[0]!.id;
  codeA = `YA${S}`;
  codeB = `YB${S}`;
  clientA = (await db.insert(clients).values({ clientCode: codeA, name: `Yopish A ${S}` }).returning({ id: clients.id }))[0]!.id;
  clientB = (await db.insert(clients).values({ clientCode: codeB, name: `Yopish B ${S}` }).returning({ id: clients.id }))[0]!.id;
  clientC = (await db.insert(clients).values({ clientCode: `YC${S}`, name: `Yopish C ${S}` }).returning({ id: clients.id }))[0]!.id;
  factory1 = (await saveFactory({ name: `Yopish toys ${S}` }, ctx())).id;
  factory2 = (await saveFactory({ name: `Yopish bags ${S}` }, ctx())).id;
  madeFactories.push(factory1, factory2);
});

afterAll(async () => {
  if (madeReceipts.length) {
    const lots = await db.select({ id: receiptLots.id }).from(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts));
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
    await db.delete(pickupLineReceipts).where(inArray(pickupLineReceipts.receiptId, madeReceipts));
    await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  }
  if (madePickups.length) {
    const entries = await db.select({ id: costEntries.id }).from(costEntries).where(inArray(costEntries.pickupId, madePickups));
    if (entries.length) {
      await db.delete(costAllocations).where(inArray(costAllocations.costEntryId, entries.map((e) => e.id)));
      await db.delete(costEntries).where(inArray(costEntries.id, entries.map((e) => e.id)));
    }
    await db.delete(pickups).where(inArray(pickups.id, madePickups));
  }
  await db.delete(clientNotices).where(inArray(clientNotices.clientId, [clientA, clientB, clientC]));
  if (madeFactories.length) await db.delete(factories).where(inArray(factories.id, madeFactories));
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB, clientC]));
  // Audited actions touched it: the audit log's FK allows deactivation only.
  await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
});

describe('zavod reysi yopiladi', () => {
  it('a prixod answers the lines it names; the last answered line closes the trip by itself (1a)', async () => {
    const t = await trip([
      { owner: codeA, goods: `Oyinchoq ${S}`, factoryBoxes: 50 },
      { owner: codeA, goods: `Sumka ${S}`, factoryBoxes: 30 },
    ]);
    const stop = t.stops[0]!;
    const [toys, bags] = stop.lines;
    // A PARTIAL delivery: the operator deleted the bags lot, so only the toys
    // line is posted — the trip stays open and the bags stay on /receive.
    await receive({ clientId: clientA, stopId: stop.id, lineIds: [toys!.id] });
    expect((await statusOf(t.pickup.id)).status).toBe('arrived');
    const still = (await incomingForWarehouses([whId])).find((x) => x.pickupId === t.pickup.id)!;
    expect(still.stops[0]!.owners[0]!.lines.map((l) => l.id)).toEqual([bags!.id]);

    await receive({ clientId: clientA, stopId: stop.id, lineIds: [bags!.id] });
    const closed = await statusOf(t.pickup.id);
    expect(closed).toMatchObject({ status: 'closed', closeKind: 'auto', closeReason: null });
    expect(closed.closedAt).not.toBeNull();
    // Gone from every «still coming» surface.
    expect((await incomingForWarehouses([whId])).some((x) => x.pickupId === t.pickup.id)).toBe(false);
    expect(await receivePrefillFor(stop.id, clientA)).toBeNull();
    expect(await openStopsForOwner(whId, { clientId: clientA })).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ pickupId: t.pickup.id })]),
    );
    expect((await listPickups({ status: 'closed' })).some((r) => r.pickup.id === t.pickup.id)).toBe(true);
    expect((await listPickups({ status: 'arrived' })).some((r) => r.pickup.id === t.pickup.id)).toBe(false);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'pickup'), eq(auditLog.entityId, t.pickup.id), eq(auditLog.action, 'status_change')));
    expect(audit.some((a) => (a.after as { closeKind?: string })?.closeKind === 'auto')).toBe(true);
  });

  it('the same cargo cannot be received through the trip twice (probe S7: the double receive)', async () => {
    const t = await trip([{ owner: codeA, goods: `Kurtka ${S}`, factoryBoxes: 10 }, { owner: codeB, goods: `B ${S}`, factoryBoxes: 1 }]);
    const stop = t.stops[0]!;
    const line = stop.lines.find((l) => l.clientId === clientA)!;
    await receive({ clientId: clientA, stopId: stop.id, lineIds: [line.id] });
    // A second phone holding the same prefill.
    await expect(receive({ clientId: clientA, stopId: stop.id, lineIds: [line.id] })).rejects.toMatchObject({
      code: 'pickup_line_answered',
    });
    // An old bundle with the stop and NO ids derives — and is refused too.
    await expect(receive({ clientId: clientA, stopId: stop.id })).rejects.toMatchObject({ code: 'pickup_line_answered' });
    // The operator's own answer, «the rest of the same cargo»: it rides the
    // trip and answers nothing.
    const extra = await receive({ clientId: clientA, stopId: stop.id, extra: true });
    const rows = await db.select().from(pickupLineReceipts).where(eq(pickupLineReceipts.receiptId, extra));
    expect(rows).toEqual([]);
    expect((await db.query.receipts.findFirst({ where: eq(receipts.id, extra) }))!.pickupStopId).toBe(stop.id);
  });

  it('a claimed marking answers its MARKING line only — never the claimant’s own line (the ordered owner rule)', async () => {
    const t = await trip([
      { owner: codeA, goods: `A shoes ${S}`, factoryBoxes: 50 },
      { owner: `MK${S}`, goods: `Mark ${S}`, factoryBoxes: 3 },
    ]);
    const stop = t.stops[0]!;
    const [aLine, markLine] = [stop.lines.find((l) => l.clientId === clientA)!, stop.lines.find((l) => !l.clientId)!];
    // The pure rule: a prixod received as MK…, later claimed by A.
    const claimed = { clientId: clientA, unclaimedMarking: `mk${S} ` };
    expect(ownerLinesOf(stop.lines, claimed).map((l) => l.id)).toEqual([markLine.id]);
    expect(ownerLinesOf(stop.lines, { clientId: clientA, unclaimedMarking: null }).map((l) => l.id)).toEqual([aLine.id]);
    // … and the SQL restatement agrees, line by line (TS = SQL).
    const rid = await receive({ clientId: null, marking: `MK${S}` });
    await db.update(receipts).set({ clientId: clientA }).where(eq(receipts.id, rid));
    const sqlAnswer = await db.execute<{ id: string; m: boolean }>(sql`
      SELECT pl.id, ${ownerMatchSql('pl', 'r')} AS m
        FROM pickup_lines pl, receipts r
       WHERE pl.stop_id = ${stop.id} AND r.id = ${rid}`);
    expect(Object.fromEntries(sqlAnswer.map((row) => [row.id, row.m]))).toEqual({ [aLine.id]: false, [markLine.id]: true });

    // Linked from the card: the mark line is answered, A's 50 boxes still coming.
    await linkReceiptToStop(rid, stop.id, ctx());
    const after = (await loadPickup(t.pickup.id))!;
    expect(after.pickup.status).toBe('arrived');
    expect(after.stops[0]!.lines.find((l) => l.id === aLine.id)!.receipts).toEqual([]);
    expect(after.stops[0]!.lines.find((l) => l.id === markLine.id)!.receipts.map((r) => r.id)).toEqual([rid]);
  });

  it('a derived link with two open lines answers neither; the card’s line button names the one that came', async () => {
    const t = await trip([
      { owner: codeA, goods: `Toys ${S}`, factoryBoxes: 5 },
      { owner: codeA, goods: `Dolls ${S}`, factoryBoxes: 6 },
    ]);
    const stop = t.stops[0]!;
    const rid = await receive({ clientId: clientA });
    // The card's candidates name the LINES because two are open.
    const cand = (await pickupCandidates(t.pickup.id)).find((c) => c.id === rid)!;
    expect(cand.stops[0]!.lines.map((l) => l.goods).sort()).toEqual([`Dolls ${S}`, `Toys ${S}`]);
    // The receipt card's plain select: linked, answering nothing.
    await linkReceiptToStop(rid, stop.id, ctx());
    let view = (await loadPickup(t.pickup.id))!.stops[0]!;
    expect(view.lines.every((l) => l.receipts.length === 0)).toBe(true);
    expect(view.unmatched.map((u) => u.id)).toEqual([rid]);
    // The per-line button on the stop it is already on ADDS the answer.
    await linkReceiptToStop(rid, stop.id, ctx(), [stop.lines[0]!.id]);
    view = (await loadPickup(t.pickup.id))!.stops[0]!;
    expect(view.lines[0]!.receipts.map((r) => r.id)).toEqual([rid]);
    expect(view.unmatched).toEqual([]);
    // A double press is a no-op, not a refusal.
    await linkReceiptToStop(rid, stop.id, ctx());
  });

  it('a closed trip stays closed (2a), refuses the door, takes a correction from the card — and its bill never lands on nothing', async () => {
    const t = await trip([{ owner: codeB, goods: `Closed ${S}`, factoryBoxes: 4 }]);
    const stop = t.stops[0]!;
    const first = await receive({ clientId: clientB, stopId: stop.id, lineIds: [stop.lines[0]!.id] });
    expect((await statusOf(t.pickup.id)).status).toBe('closed');
    await addCostEntry(
      {
        scope: 'pickup',
        pickupId: t.pickup.id,
        costTypeId,
        amount: 300,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'volume',
      },
      ctx(),
    );
    // The judge's money-1: the first prixod is the closed truck's ONLY cargo.
    // Voiding it, or taking it off the trip, would leave $300 on no carton,
    // and nothing brings cargo to a closed trip by itself — both refuse,
    // naming the trip.
    await expect(voidReceipt(first, 'duplicate', ctx())).rejects.toMatchObject({
      code: 'shared_cost_orphaned',
      detail: t.pickup.code,
    });
    await expect(linkReceiptToStop(first, null, ctx())).rejects.toMatchObject({
      code: 'shared_cost_orphaned',
      detail: t.pickup.code,
    });
    expect((await statusOf(t.pickup.id)).status).toBe('closed');
    expect(await receivePrefillFor(stop.id, clientB)).toBeNull();
    // The door refuses the closed trip in its own words…
    await expect(receive({ clientId: clientB, stopId: stop.id })).rejects.toMatchObject({ code: 'pickup_closed' });
    // … the redo is received plain and joined from the CARD, which does not
    // reopen it — and THEN the wrong one may go: the bill has cargo again.
    // The line is still the wrong prixod's, so the redo names it — the card's
    // per-line button (`AnswerLineButtons`), a second prixod on one line.
    const redo = await receive({ clientId: clientB });
    await linkReceiptToStop(redo, stop.id, ctx(), [stop.lines[0]!.id]);
    expect((await statusOf(t.pickup.id)).status).toBe('closed');
    await voidReceipt(first, 'wrong count', ctx());
    expect((await statusOf(t.pickup.id)).status).toBe('closed');
    const view = (await loadPickup(t.pickup.id))!.stops[0]!;
    expect(view.lines[0]!.receipts.map((r) => r.id)).toEqual([redo]);
    expect(view.lines[0]!.receipts[0]!.boxes).toBe(2);
    expect(await stopReceivability(stop.id)).toMatchObject({ status: 'closed', answered: [stop.lines[0]!.id] });
  });

  it('an OPEN trip keeps #1004: its prixod may be voided off a bill — more cargo may still come', async () => {
    const t = await trip([
      { owner: codeA, goods: `Open1 ${S}`, factoryBoxes: 2 },
      { owner: codeA, goods: `Open2 ${S}`, factoryBoxes: 2 },
    ]);
    const stop = t.stops[0]!;
    const only = await receive({ clientId: clientA, stopId: stop.id, lineIds: [stop.lines[0]!.id] });
    expect((await statusOf(t.pickup.id)).status).toBe('arrived');
    await addCostEntry(
      {
        scope: 'pickup',
        pickupId: t.pickup.id,
        costTypeId,
        amount: 120,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'volume',
      },
      ctx(),
    );
    await voidReceipt(only, 'open trip', ctx());
    expect((await statusOf(t.pickup.id)).status).toBe('arrived');
  });

  it('a costed trip that brought nothing, closed by hand, is said on the logist home', async () => {
    const t = await trip([{ owner: codeB, goods: `Empty ${S}`, factoryBoxes: 3 }]);
    await addCostEntry(
      {
        scope: 'pickup',
        pickupId: t.pickup.id,
        costTypeId,
        amount: 80,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'volume',
      },
      ctx(),
    );
    await closePickup(t.pickup.id, { reason: 'zavod yukni bermadi' }, ctx(), { mayMarkNoCost: false });
    expect((await pickupAttentionCounts()).costNoCargo).toBeGreaterThanOrEqual(1);
    expect(await receivePrefillRefusal(t.stops[0]!.id, clientB)).toMatchObject({ why: 'closed' });
  });

  it('a manual close needs a sentence (1a); «xarajat yo’q» needs a reason and the cost door (5a)', async () => {
    const t = await trip([{ owner: codeA, goods: `Never ${S}`, factoryBoxes: 9 }]);
    await expect(closePickup(t.pickup.id, { reason: ' x ' }, ctx(), { mayMarkNoCost: true })).rejects.toMatchObject({
      code: 'close_reason_required',
    });
    await expect(
      closePickup(t.pickup.id, { reason: 'zavod bermadi', noCostReason: 'tekin' }, ctx(), { mayMarkNoCost: false }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await closePickup(t.pickup.id, { reason: 'zavod bermadi', noCostReason: 'zavod o‘zi yubordi' }, ctx(), {
      mayMarkNoCost: true,
    });
    const closed = await statusOf(t.pickup.id);
    expect(closed).toMatchObject({ status: 'closed', closeKind: 'manual', closeReason: 'zavod bermadi', noCostReason: 'zavod o‘zi yubordi' });
    await expect(closePickup(t.pickup.id, { reason: 'yana' }, ctx(), { mayMarkNoCost: true })).rejects.toMatchObject({
      code: 'already_closed',
    });
    // Out of «xarajatsiz»; taking the mark back puts it in.
    expect((await listPickups({ status: 'xarajatsiz' })).some((r) => r.pickup.id === t.pickup.id)).toBe(false);
    await setPickupNoCost(t.pickup.id, null, ctx());
    expect((await listPickups({ status: 'xarajatsiz' })).some((r) => r.pickup.id === t.pickup.id)).toBe(true);
    await expect(setPickupNoCost(t.pickup.id, 'ab', ctx())).rejects.toMatchObject({ code: 'no_cost_reason_required' });
    // SET only on a closed trip (his 5a «yopishda», the judge's intent-q3):
    // on an open one the bill may still come; the close form carries the tick.
    const open = await trip([{ owner: codeB, goods: `Still ${S}`, factoryBoxes: 1 }]);
    await expect(setPickupNoCost(open.pickup.id, 'boshqa joyda to‘landi', ctx())).rejects.toMatchObject({
      code: 'no_cost_closed_only',
    });
    // The mark STANDS until a bill is typed after it (money-5): voiding that
    // bill must not bring «somebody else paid» back and silence the alarm.
    await setPickupNoCost(t.pickup.id, 'zavod to‘ladi', ctx());
    expect((await loadPickup(t.pickup.id))!.noCostStands).toBe(true);
    const bill = await addCostEntry(
      {
        scope: 'pickup',
        pickupId: t.pickup.id,
        costTypeId,
        amount: 50,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'volume',
      },
      ctx(),
    );
    await voidCostEntry(bill.id, 'qayta kiritiladi', ctx(), { mayMoveTill: true });
    expect((await loadPickup(t.pickup.id))!.noCostStands).toBe(false);
    expect((await listPickups({ status: 'xarajatsiz' })).some((r) => r.pickup.id === t.pickup.id)).toBe(true);
    // A late «Olindi» on a closed trip is a RECORD: the stop is stamped, the
    // status does not move, and nobody is told anything.
    const t2 = await trip([{ owner: `YC${S}`, goods: `Late ${S}`, factoryBoxes: 2 }], { collect: false });
    const stop2 = t2.stops[0]!;
    await closePickup(t2.pickup.id, { reason: 'qo‘lda yopildi' }, ctx(), { mayMarkNoCost: false });
    await collectStop(stop2.id, {}, ctx());
    expect((await statusOf(t2.pickup.id)).status).toBe('closed');
    expect((await loadPickup(t2.pickup.id))!.stops[0]!.collectedAt).not.toBeNull();
    const notices = await db
      .select()
      .from(clientNotices)
      .where(and(eq(clientNotices.kind, NOTICE_PICKED_UP), eq(clientNotices.refId, stop2.id)));
    expect(notices).toEqual([]);
  });

  it('removing the never-given line closes what is left by itself; a stale line id falls back to the owner’s line', async () => {
    const created = await createPickup(
      {
        destWarehouseId: whId,
        stops: [
          { factoryId: factory1, lines: await resolveLineOwners([{ owner: codeA, goods: `Got ${S}`, factoryBoxes: 1 }]) },
          { factoryId: factory2, lines: await resolveLineOwners([{ owner: codeB, goods: `Lost ${S}`, factoryBoxes: 1 }]) },
        ],
      },
      ctx(),
    );
    madePickups.push(created.id);
    let t = (await loadPickup(created.id))!;
    await collectStop(t.stops[0]!.id, {}, ctx());
    // The logist fixed a typo on stop 1 while a draft held the OLD line id.
    const oldId = t.stops[0]!.lines[0]!.id;
    await saveStopLines(t.stops[0]!.id, await resolveLineOwners([{ owner: codeA, goods: `Got (fixed) ${S}`, factoryBoxes: 1 }]), ctx());
    await receive({ clientId: clientA, stopId: t.stops[0]!.id, lineIds: [oldId] });
    t = (await loadPickup(created.id))!;
    expect(t.stops[0]!.lines[0]!.receipts).toHaveLength(1);
    expect(t.pickup.status).toBe('arrived');
    // Stop 2 never collected and nothing received there: removing it leaves
    // every remaining line answered — the trip closes by itself.
    await removeStop(t.stops[1]!.id, ctx());
    expect((await statusOf(created.id)).status).toBe('closed');
  });

  it('the door asks only about COLLECTED stops, and a «Yo’q» is said on the card and left out of the home count', async () => {
    const planned = await trip([{ owner: codeA, goods: `Wednesday ${S}`, factoryBoxes: 50 }], { collect: false });
    expect((await openStopsForOwner(whId, { clientId: clientA })).some((s) => s.pickupId === planned.pickup.id)).toBe(false);
    await collectStop(planned.stops[0]!.id, {}, ctx());
    const offered = await openStopsForOwner(whId, { clientId: clientA });
    expect(offered.some((s) => s.pickupId === planned.pickup.id)).toBe(true);

    const rid = await receive({ clientId: clientA, declined: [planned.stops[0]!.id] });
    const cand = (await pickupCandidates(planned.pickup.id)).find((c) => c.id === rid)!;
    expect(cand.declined).toBe(true);
    // The home count's own clause, for THIS trip: listed on the card, not counted.
    const [row] = await db.execute<{ listed: boolean; counted: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM receipts r WHERE ${candidateReceiptSql()}) AS listed,
             EXISTS (SELECT 1 FROM receipts r WHERE ${candidateReceiptSql()} AND NOT ${declinedAtDoorSql()}) AS counted
        FROM pickups p WHERE p.id = ${planned.pickup.id}`);
    expect(row).toEqual({ listed: true, counted: false });
  });
});

describe('0133 backfill (the migration’s own statements, in a rolled-back transaction)', () => {
  const migration = readFileSync('src/modules/platform/db/migrations/0133_pickup_close.sql', 'utf8');
  const block = (name: string) => migration.slice(migration.indexOf(`-- ${name}-BEGIN`), migration.indexOf(`-- ${name}-END`));

  it('pairs the marking-vs-code leftover, leaves the claimed-marking union open, and audits every close', async () => {
    const s4 = await trip([{ owner: `S4M${S}`, goods: `S4 ${S}`, factoryBoxes: 3 }]);
    const union = await trip([
      { owner: codeA, goods: `U-A ${S}`, factoryBoxes: 50 },
      { owner: `UM${S}`, goods: `U-M ${S}`, factoryBoxes: 3 },
    ]);
    const r4 = await receive({ clientId: clientB });
    const ru = await receive({ clientId: null, marking: `UM${S}` });
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        // Put both trips back into the pre-0133 shape: linked, remembered by nothing.
        await tx.update(receipts).set({ pickupStopId: s4.stops[0]!.id }).where(eq(receipts.id, r4));
        await tx.update(receipts).set({ pickupStopId: union.stops[0]!.id, clientId: clientA }).where(eq(receipts.id, ru));
        await tx.delete(pickupLineReceipts).where(inArray(pickupLineReceipts.receiptId, [r4, ru]));
        await tx.execute(sql.raw(block('BACKFILL-MEMORY')));
        await tx.execute(sql.raw(block('BACKFILL-PAIR')));
        await tx.execute(sql.raw(block('BACKFILL-CLOSE')));
        const [a, b] = await Promise.all(
          [s4.pickup.id, union.pickup.id].map(async (id) => (await tx.select().from(pickups).where(eq(pickups.id, id)))[0]!),
        );
        expect(a).toMatchObject({ status: 'closed', closeKind: 'auto' });
        expect(b!.status).not.toBe('closed');
        const audits = await tx
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.entityType, 'pickup'), eq(auditLog.entityId, s4.pickup.id)));
        expect(audits.some((row) => (row.after as { backfill?: boolean })?.backfill === true)).toBe(true);
        throw rollback;
      })
      .catch((err: unknown) => {
        if (err !== rollback) throw err;
      });
  });
});

describe('the owner a person reads, and the cargo already here (the judges\' intent-5/7, money-3)', () => {
  it('the code-prefix convention: GS500MANIKEN is GS500\'s, GS5 is not GS500X\'s — the TS and the SQL agree', async () => {
    const cases: [string | null, string | null, boolean][] = [
      ['GS500MANIKEN-AL', 'GS500', true],
      [' gs500maniken ', 'gs500', true],
      ['GS500', 'GS500', true],
      ['GS500X', 'GS5', false],
      ['GS5001', 'GS500', false],
      ['GS50', 'GS500', false],
      ['', 'GS500', false],
      ['GS500', null, false],
    ];
    for (const [marking, code, want] of cases) {
      expect(markingOfCode(marking, code), `${marking} / ${code}`).toBe(want);
      const [row] = await db.execute<{ ok: boolean }>(
        sql`SELECT ${markingOfCodeSql(sql`${marking}::text`, sql`${code}::text`)} AS ok`,
      );
      expect(row!.ok, `SQL ${marking} / ${code}`).toBe(want);
    }
  });

  it('a client line takes only that client\'s cargo; a marking that is the client\'s by its code is asked and answers', async () => {
    const t = await trip([
      { owner: codeA, goods: `ForA ${S}`, factoryBoxes: 5 },
      { owner: `${codeB}MAN`, goods: `ForBmark ${S}`, factoryBoxes: 6 },
    ]);
    const stop = t.stops[0]!;
    const aLine = stop.lines.find((l) => l.clientId === clientA)!;
    const bMark = stop.lines.find((l) => !l.clientId)!;
    // B's prixod posting A's line (a ticked line kept across a client switch).
    await expect(receive({ clientId: clientB, stopId: stop.id, lineIds: [aLine.id] })).rejects.toMatchObject({
      code: 'pickup_line_owner_mismatch',
    });
    // The door asks B about the marking line its code begins…
    const askedB = (await openStopsForOwner(whId, { clientId: clientB })).find((s) => s.stopId === stop.id);
    expect(askedB?.lines.map((l) => l.id)).toEqual([bMark.id]);
    // … and asks a marking about the client line whose code begins it.
    const askedMark = (await openStopsForOwner(whId, { marking: `${codeA}KUK` })).find((s) => s.stopId === stop.id);
    expect(askedMark?.lines.map((l) => l.id)).toEqual([aLine.id]);
    await receive({ clientId: clientB, stopId: stop.id, lineIds: [bMark.id] });
    await receive({ clientId: null, marking: `${codeA}KUK`, stopId: stop.id, lineIds: [aLine.id] });
    expect((await statusOf(t.pickup.id)).status).toBe('closed');
  });

  it('cargo already received OFF the trip is named at the door, on /receive and in the prefill — never one a person declined', async () => {
    const t = await trip([{ owner: `YC${S}`, goods: `Twin ${S}`, factoryBoxes: 2 }]);
    const stop = t.stops[0]!;
    const plain = await receive({ clientId: clientC });
    const declined = await receive({ clientId: clientC, declined: [stop.id] });
    const door = (await openStopsForOwner(whId, { clientId: clientC })).find((s) => s.stopId === stop.id)!;
    expect(door.lookalikes.map((l) => l.id)).toEqual([plain]);
    expect(door.lookalikes[0]!.boxes).toBe(2);
    const row = (await incomingForWarehouses([whId]))
      .find((x) => x.pickupId === t.pickup.id)!
      .stops[0]!.owners.find((o) => o.clientId === clientC)!;
    expect(row.lookalikes.map((l) => l.id)).toEqual([plain]);
    expect((await receivePrefillFor(stop.id, clientC))!.lookalikes.map((l) => l.id)).toEqual([plain]);
    expect(door.lookalikes.some((l) => l.id === declined)).toBe(false);
  });

  it('a candidate matched by the code prefix is linked BY ITS LINE — the server\'s own derivation is exact', async () => {
    const t = await trip([{ owner: codeB, goods: `Prefix ${S}`, factoryBoxes: 2 }]);
    const line = t.stops[0]!.lines[0]!;
    const rid = await receive({ clientId: null, marking: `${codeB}ZZ` });
    const cand = (await pickupCandidates(t.pickup.id)).find((c) => c.id === rid)!;
    expect(cand.stops.map((st) => st.onlyLineId)).toEqual([line.id]);
    await linkReceiptToStop(rid, t.stops[0]!.id, ctx(), [cand.stops[0]!.onlyLineId!]);
    expect((await statusOf(t.pickup.id)).status).toBe('closed');
  });

  it('a trip nobody pressed «Olindi» on still lists the prixods received since it was made', async () => {
    const t = await trip([{ owner: codeA, goods: `NoOlindi ${S}`, factoryBoxes: 3 }], { collect: false });
    const rid = await receive({ clientId: clientA });
    expect((await pickupCandidates(t.pickup.id)).some((c) => c.id === rid)).toBe(true);
  });
});
