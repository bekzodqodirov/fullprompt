import 'dotenv/config';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  boxMovements,
  boxes,
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clientTransactions,
  clients,
  dealStages,
  deals,
  events,
  receiptLots,
  receipts,
  tasks,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  addTransaction,
  addTruckPrices,
  batchCharges,
  moveCharge,
  pricesSeenOf,
  type TruckPricesInput,
} from '@/modules/wms/finance/service';
import { lostCargoChargesOn } from '@/modules/wms/finance/compensation';
import { batchLots, cargoAboard } from '@/modules/wms/batches/lots';
import { pricedHereReading, unpricedDealsOf } from '@/modules/wms/finance/truck-deal';
import { exactSharesOf, expectedPartFor, prefillFor } from '@/modules/wms/finance/deal-price-hint';
import { bothFiguresForDeals, upsaleStateOf } from '@/modules/wms/calc/upsale-service';
import { payableOffersSql } from '@/modules/wms/calc/upsale';
import { finishCalcRequest, openCalcRequest, takeCalcRequest } from '@/modules/wms/calc/service';
import { recordOffer } from '@/modules/wms/calc/workspace';
import { sawRev } from '../fixtures/calc-saw-rev';

/**
 * The «Narx» tab's price table (the owner, 2026-11-08, his 1a-3a: «1 mashinada
 * 1 clientda 10 15 ta prixoda va har birida bitim bolsa narx berishda faqat 1
 * dona bitim tanlaydigan bolib qolgan») — docs/NARX-VA-RAQAM.md §1 + §3.1.
 * One press writes one charge per filled row, all or nothing, through the ONE
 * body both truck doors share; every refusal writes nothing; the races the
 * body's locks close are run as races (a holder transaction, the price
 * waiting on it). And the pre-fill is checked against the money it feeds: a
 * pre-filled deal must pass its own upsale's invoice check.
 *
 * Each case rides its own truck, so no case's cargo is another's input.
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
let cn: string;
let cn2: string;
let uz: string;
let clientId: string;
let otherClientId: string;
let stageId: string;
const madeBatches: string[] = [];
const madeDeals: string[] = [];
const madeReceipts: string[] = [];
const madeLots: string[] = [];
const madeBoxes: string[] = [];
const madeRequests: string[] = [];
const ctx = () => ({ actorId });
let seq = 0;

async function mintWarehouse(code: string, country: string) {
  return (
    await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: `Narx-jadval ${code}`, country, type: 'origin', timezone: 'Asia/Shanghai' })
      .returning({ id: warehouses.id })
  )[0]!.id;
}

async function mintDeal(owner: string, extra: Partial<typeof deals.$inferInsert> = {}) {
  seq += 1;
  const id = (
    await db
      .insert(deals)
      .values({ code: `TT${S}-${String(seq).padStart(3, '0')}`, clientId: owner, stageId, title: `Jadval ${seq}`, createdBy: actorId, ...extra })
      .returning({ id: deals.id })
  )[0]!.id;
  madeDeals.push(id);
  return id;
}

async function mintTruck() {
  seq += 1;
  const id = uuidv4();
  await db.insert(batches).values({
    id,
    code: `TT${S}-B${seq}`,
    originWarehouseId: cn,
    destWarehouseId: uz,
    status: 'in_transit',
    departedAt: new Date(),
    createdBy: actorId,
  });
  madeBatches.push(id);
  return id;
}

/** One confirmed prixod of one lot of one carton, departed on `batchId` — its receipt id. */
async function cargo(batchId: string, owner: string, dealId: string | null, m3 = '0.1', kg = '10'): Promise<string> {
  seq += 1;
  const receiptId = (
    await db
      .insert(receipts)
      .values({ warehouseId: cn, clientId: owner, dealId, status: 'confirmed', createdBy: actorId, confirmedAt: new Date(), confirmedBy: actorId })
      .returning({ id: receipts.id })
  )[0]!.id;
  madeReceipts.push(receiptId);
  const lotId = (
    await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        letter: 'A',
        productNameZh: `货${S}-${seq}`,
        boxCount: 1,
        dimsMode: 'mixed',
        totalWeightKg: kg,
        totalVolumeM3: m3,
      })
      .returning({ id: receiptLots.id })
  )[0]!.id;
  madeLots.push(lotId);
  const boxId = (
    await db
      .insert(boxes)
      .values({ lotId, shortCode: `TT${S}X${seq}`, seqInLot: 1, currentWarehouseId: null, status: 'in_transit' })
      .returning({ id: boxes.id })
  )[0]!.id;
  madeBoxes.push(boxId);
  await db.insert(boxMovements).values({
    boxId,
    fromWarehouseId: cn,
    toWarehouseId: uz,
    fromStatus: 'loading',
    toStatus: 'in_transit',
    cause: 'batch_departed',
    refType: 'batch',
    refId: batchId,
    actorId,
  });
  return receiptId;
}

const livePrices = (batchId: string) =>
  db
    .select({ id: clientTransactions.id, dealId: clientTransactions.dealId, amountUsd: clientTransactions.amountUsd })
    .from(clientTransactions)
    .where(
      and(eq(clientTransactions.batchId, batchId), eq(clientTransactions.type, 'charge'), isNull(clientTransactions.voidedAt)),
    );

/** What the «Narx» tab draws for this client on that truck: the key and the prices. */
async function drawn(batchId: string) {
  const aboard = await cargoAboard(batchId, clientId);
  const live = await livePrices(batchId);
  return { dealsSeen: aboard.candidates.key, pricesSeen: pricesSeenOf(live.map((row) => row.id)) };
}

type Part = TruckPricesInput['parts'][number];
const press = async (batchId: string, parts: Part[], seen?: { dealsSeen: string; pricesSeen: string }) =>
  addTruckPrices(
    { clientId, batchId, currency: 'USD', txDate: '2026-07-10', ...(seen ?? (await drawn(batchId))), parts },
    ctx(),
  );

async function createAudit(txId: string) {
  const [row] = await db
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'client_transaction'), eq(auditLog.entityId, txId), eq(auditLog.action, 'create')));
  return row?.after as { dealVia?: string; parts?: number; dealId?: string } | undefined;
}

/** Somebody else's transaction, held open on its own connection. */
async function withHolder(run: (held: postgres.ReservedSql) => Promise<void>) {
  const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
    max: 1,
    onnotice: () => {},
  });
  const held = await helper.reserve();
  try {
    await run(held);
  } finally {
    held.release();
    await helper.end();
  }
}

/** Is anybody waiting on a lock? Asked through the POOL (#873). */
async function someoneWaits(): Promise<boolean> {
  for (let i = 0; i < 250; i += 1) {
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/** A press made while the holder keeps the client's money lock, and what it answered. */
async function pressWhileHeld(
  held: postgres.ReservedSql,
  write: () => Promise<unknown>,
  meanwhile: () => Promise<void>,
): Promise<unknown> {
  await held`BEGIN`;
  await held`SELECT pg_advisory_xact_lock(hashtext('client-money'), hashtext(${clientId}::text))`;
  const pressed = write().then(
    () => null,
    (err: unknown) => err,
  );
  expect(await someoneWaits(), 'the press never had to wait for the lock').toBe(true);
  await meanwhile();
  await held`COMMIT`;
  return pressed;
}

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99894${String(Date.now()).slice(-7)}`, fullName: `Narx jadvali ${S}`, passwordHash: 'x' })
    .returning({ id: users.id });
  actorId = actor!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  cn = await mintWarehouse(`TJ${S}`, 'CN');
  cn2 = await mintWarehouse(`TK${S}`, 'CN');
  uz = await mintWarehouse(`TV${S}`, 'UZ');
  clientId = (
    await db.insert(clients).values({ clientCode: `TT${S}`, name: `Jadval mijoz ${S}` }).returning({ id: clients.id })
  )[0]!.id;
  otherClientId = (
    await db.insert(clients).values({ clientCode: `TW${S}`, name: `Boshqa mijoz ${S}` }).returning({ id: clients.id })
  )[0]!.id;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcOffers).where(inArray(calcOffers.requestId, madeRequests));
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, [clientId, otherClientId]));
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, madeBoxes));
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  await db.delete(receiptLots).where(inArray(receiptLots.id, madeLots));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  await db.delete(deals).where(inArray(deals.id, madeDeals));
  await db.delete(batches).where(inArray(batches.id, madeBatches));
  // An audited fixture is deactivated, never deleted (audit_log FK).
  await db.update(clients).set({ active: false }).where(inArray(clients.id, [clientId, otherClientId]));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [cn, cn2, uz]));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('one press, one charge per filled row', () => {
  it('three deals and deal-less cargo: a press of two deals and «bitimsiz» writes three charges, one press of three', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const c = await mintDeal(clientId);
    const truck = await mintTruck();
    for (const deal of [a, b, c, null]) await cargo(truck, clientId, deal);

    const written = await press(truck, [
      { dealId: b, amount: 200 },
      { dealId: a, amount: 100 },
      { dealId: 'none', amount: 30 },
    ]);
    expect(written.map((row) => [row.dealId, Number(row.amountUsd)])).toEqual([
      [b, 200],
      [a, 100],
      [null, 30],
    ]);
    // One moment for the press: the parts share their transaction's clock.
    expect(new Set(written.map((row) => row.createdAt.toISOString())).size).toBe(1);
    // The history says how each deal got there, and that it was one press of 3.
    expect(await Promise.all(written.map(async (row) => (await createAudit(row.id))?.dealVia))).toEqual([
      'chosen',
      'chosen',
      'none',
    ]);
    for (const row of written) expect((await createAudit(row.id))?.parts).toBe(3);

    // His 3a: C was left blank and stays loud «narx yo'q»; the «bitimsiz»
    // part is read as a CHOSEN part (its audit) — not as a whole-cargo price
    // that would hide C.
    const charges = (await batchCharges(truck)).filter((row) => row.tx.clientId === clientId);
    const prices = charges.map((row) => ({
      id: row.tx.id,
      dealId: row.tx.dealId,
      usd: Number(row.tx.amountUsd),
      chosenNone: Boolean(row.chosenNone),
    }));
    const candidates = (await cargoAboard(truck, clientId)).candidates;
    expect(pricedHereReading(candidates, prices).whole).toEqual([]);
    expect(unpricedDealsOf(candidates, prices, () => false)).toEqual([{ dealId: c, why: 'missing', loud: true }]);

    // …and the next press prices the blank deal alone (a partial save, then
    // the rest): nothing asks a second time about the rows already written.
    const later = await press(truck, [{ dealId: c, amount: 300 }]);
    expect(later.map((row) => row.dealId)).toEqual([c]);
    expect(await livePrices(truck)).toHaveLength(4);
  });
});

describe('every refusal writes nothing', () => {
  it('a deal posted twice, a deal not aboard, «bitimsiz» on a deals-only truck, an empty press', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const elsewhere = await mintDeal(clientId);
    const foreign = await mintDeal(otherClientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);

    await expect(press(truck, [{ dealId: a, amount: 1 }, { dealId: a, amount: 2 }])).rejects.toMatchObject({
      code: 'deal_part_duplicate',
      detail: a,
    });
    await expect(press(truck, [{ dealId: a, amount: 1 }, { dealId: elsewhere, amount: 2 }])).rejects.toMatchObject({
      code: 'deal_not_aboard',
      detail: elsewhere,
    });
    // Another client's deal is no candidate of this client's at all.
    await expect(press(truck, [{ dealId: foreign, amount: 2 }])).rejects.toMatchObject({ code: 'deal_not_aboard' });
    await expect(press(truck, [{ dealId: a, amount: 1 }, { dealId: 'none', amount: 2 }])).rejects.toMatchObject({
      code: 'deal_choice_invalid',
      detail: 'none',
    });
    await expect(press(truck, [])).rejects.toMatchObject({ code: 'deal_parts_empty' });
    expect(await livePrices(truck)).toHaveLength(0);
  });

  it('a table posted for a client nobody has to ask is refused — the table is drawn only for two deals', async () => {
    const a = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, null);
    await expect(press(truck, [{ dealId: a, amount: 5 }])).rejects.toMatchObject({ code: 'deal_choice_invalid' });
    expect(await livePrices(truck)).toHaveLength(0);
  });

  it('a page drawn before a prixod was re-filed is refused and writes nothing — the old question is never answered', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const c = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);
    const receiptC = await cargo(truck, clientId, c);
    const seen = await drawn(truck);
    await db.update(receipts).set({ dealId: a }).where(eq(receipts.id, receiptC));
    await expect(press(truck, [{ dealId: a, amount: 1 }, { dealId: b, amount: 2 }], seen)).rejects.toMatchObject({
      code: 'deals_changed',
    });
    expect(await livePrices(truck)).toHaveLength(0);
  });

  it('a cancelled truck takes no price', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);
    await db.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, truck));
    await expect(press(truck, [{ dealId: a, amount: 1 }])).rejects.toMatchObject({ code: 'batch_cancelled' });
    expect(await livePrices(truck)).toHaveLength(0);
  });
});

describe('the prices the page was drawn with (§3.1.1)', () => {
  it('a price committed between the drawing and the press is `prices_changed` — never a second bill nobody was asked about', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);
    // Two tabs (or the accountant and the admin) draw the same page…
    const seen = await drawn(truck);
    // …the first presses…
    await press(truck, [{ dealId: a, amount: 100 }], seen);
    // …and the second, pre-filled with the same row, is refused.
    await expect(press(truck, [{ dealId: a, amount: 100 }, { dealId: b, amount: 50 }], seen)).rejects.toMatchObject({
      code: 'prices_changed',
    });
    expect((await livePrices(truck)).map((row) => row.dealId)).toEqual([a]);
    // Redrawn, the person decides — and the press goes through.
    await press(truck, [{ dealId: b, amount: 50 }]);
    expect(await livePrices(truck)).toHaveLength(2);
  });

  it('the single «Narx» form is held to the same: one door, one body', async () => {
    const a = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    const seen = await drawn(truck);
    expect(seen.pricesSeen).toBe('');
    // The ledger posts no `pricesSeen` and is not asked.
    await addTransaction({ clientId, type: 'charge', amount: 10, currency: 'USD', txDate: '2026-07-10', batchId: truck }, ctx());
    await expect(
      addTransaction(
        { clientId, type: 'charge', amount: 10, currency: 'USD', txDate: '2026-07-10', batchId: truck, ...seen },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'prices_changed' });
    expect(await livePrices(truck)).toHaveLength(1);
  });
});

describe('the body decides again under its locks — races, run as races', () => {
  it('a re-file between the pool read and the transaction: `deals_changed`, NOTHING written (all or nothing)', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const c = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);
    const receiptC = await cargo(truck, clientId, c);
    const seen = await drawn(truck);
    let err: unknown;
    await withHolder(async (held) => {
      err = await pressWhileHeld(
        held,
        () => press(truck, [{ dealId: a, amount: 1 }, { dealId: b, amount: 2 }, { dealId: c, amount: 3 }], seen),
        async () => {
          await held`UPDATE receipts SET deal_id = ${a}::uuid WHERE id = ${receiptC}::uuid`;
        },
      );
    });
    expect(err).toMatchObject({ code: 'deals_changed' });
    expect(await livePrices(truck)).toHaveLength(0);
  });

  it('a destination turned Chinese between the pool read and the transaction: `internal_batch`, nothing written', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);
    let err: unknown;
    await withHolder(async (held) => {
      err = await pressWhileHeld(
        held,
        () => press(truck, [{ dealId: a, amount: 1 }]),
        async () => {
          await held`UPDATE batches SET dest_warehouse_id = ${cn2}::uuid WHERE id = ${truck}::uuid`;
        },
      );
    });
    expect(err).toMatchObject({ code: 'internal_batch' });
    expect(await livePrices(truck)).toHaveLength(0);
  });

  it('a cancel between the pool read and the transaction: `batch_cancelled`, nothing written', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);
    let err: unknown;
    await withHolder(async (held) => {
      err = await pressWhileHeld(
        held,
        () => press(truck, [{ dealId: a, amount: 1 }]),
        async () => {
          await held`UPDATE batches SET status = 'cancelled' WHERE id = ${truck}::uuid`;
        },
      );
    });
    expect(err).toMatchObject({ code: 'batch_cancelled' });
    expect(await livePrices(truck)).toHaveLength(0);
  });

  it('«🚚 Ko‘chirish» onto a truck cancelled while it waited is refused — it took no truck lock before (judge F6)', async () => {
    const a = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    // A deal price from the ledger, with no truck: the move's commonest input.
    const card = await addTransaction(
      { clientId, type: 'charge', amount: 70, currency: 'USD', txDate: '2026-07-10', dealId: a },
      ctx(),
    );
    let err: unknown;
    await withHolder(async (held) => {
      err = await pressWhileHeld(
        held,
        () => moveCharge({ txId: card.id, parts: [{ batchId: truck, amount: 70 }] }, ctx()),
        async () => {
          await held`UPDATE batches SET status = 'cancelled' WHERE id = ${truck}::uuid`;
        },
      );
    });
    expect(err).toMatchObject({ code: 'batch_cancelled' });
    expect(await livePrices(truck)).toHaveLength(0);
    const [still] = await db.select({ voidedAt: clientTransactions.voidedAt }).from(clientTransactions).where(eq(clientTransactions.id, card.id));
    expect(still!.voidedAt).toBeNull();
  });
});

describe('the lost-cargo door finds the prixod’s own part among many (§3.1.12)', () => {
  it('a truck priced in one press for 21 deals: the lost prixod’s own deal’s part is first, never cut off by the 20', async () => {
    const dealIds: string[] = [];
    const truck = await mintTruck();
    const receiptOf = new Map<string, string>();
    for (let i = 0; i < 21; i += 1) {
      const deal = await mintDeal(clientId);
      dealIds.push(deal);
      receiptOf.set(deal, await cargo(truck, clientId, deal));
    }
    // The target's part posted LAST: one transaction, one clock, the highest id.
    const target = dealIds[0]!;
    await press(truck, [...dealIds.slice(1), target].map((dealId, i) => ({ dealId, amount: 10 + i })));
    const lines = await lostCargoChargesOn(db, clientId, [receiptOf.get(target)!]);
    expect(lines).toHaveLength(20);
    const [targetCode] = await db.select({ code: deals.code }).from(deals).where(eq(deals.id, target));
    expect(lines[0]!.dealCode).toBe(targetCode!.code);
  });
});

describe('a pre-filled part passes its own deal’s invoice check (§3.1.4, judge P1-prefill-basis)', () => {
  it('a sealed-price deal on one truck: the pre-fill is ≥ the upsale’s due price, so the job never reads «no_invoice»', async () => {
    // His card quoted 30 m³; 1.2344 m³ of it is aboard (the stored four places).
    const sold = await mintDeal(clientId, { quotedVolumeM3: '30', quotedCurrency: 'USD' });
    const other = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, sold, '1.2344', '10');
    await cargo(truck, clientId, other);

    // The VED's «Готово» at a $1000 floor, the seller's offer at $5000 —
    // released, so the card now carries the client price.
    const opened = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: sold,
        section: 'rastamojka',
        volumeM3: 30,
        weightKg: 600,
        items: [{ name: `Jadval tovar ${S}`, quantity: 10 }],
        source: 'card',
      },
      ctx(),
    );
    madeRequests.push(opened.id);
    await takeCalcRequest(opened.id, ctx());
    await finishCalcRequest(
      opened.id,
      { amountText: '1000', currency: 'USD', note: 'gotovo', internalNote: 'ichki: gotovo' },
      ctx(),
      await sawRev(opened.id),
    );
    const offer = await recordOffer(
      { requestId: opened.id },
      { clientPriceUsd: 5000, locale: 'uz', expect: { entityType: 'deal', entityId: sold } },
      ctx(),
    );
    expect(offer.pending).toBe(false);

    // The page's own arithmetic, on the page's own reads.
    const [card] = await db.select().from(deals).where(eq(deals.id, sold));
    const quote = {
      amount: Number(card!.quotedAmount),
      currency: card!.quotedCurrency,
      m3: Number(card!.quotedVolumeM3),
      kg: card!.quotedWeightKg === null ? null : Number(card!.quotedWeightKg),
    };
    const exact = exactSharesOf(await batchLots(truck), clientId).get(sold)!;
    const part = expectedPartFor(quote, exact, (await bothFiguresForDeals([sold])).get(sold)?.perKg ?? false);
    // 5000 × 1.2344 / 30 = 205.7333… → up, never the 205.67 a 1.234 m³ share gives.
    expect(part?.usd).toBe(205.74);
    const prefill = prefillFor(
      {
        sight: true,
        partUsd: part!.usd,
        quoted: true,
        discounted: false,
        pricedHere: false,
        pricedCard: false,
        pricedOn: [],
        follows: false,
        continuation: false,
        offElsewhere: false,
        whole: false,
      },
      'USD',
    );
    expect(prefill).toEqual({ usd: 205.74 });

    await press(truck, [{ dealId: sold, amount: 205.74 }]);
    const [row] = await db.execute<{ due_price_usd: string; cargo_receipts: string; payout_at: Date | null; entity_type: string }>(
      sql`SELECT due_price_usd, cargo_receipts, payout_at, entity_type FROM (${payableOffersSql()}) p WHERE p.entity_id = ${sold}::uuid`,
    );
    expect(Number(row!.due_price_usd)).toBe(205.73);
    const charged = (await db
      .select({ usd: clientTransactions.amountUsd })
      .from(clientTransactions)
      .where(and(eq(clientTransactions.dealId, sold), eq(clientTransactions.type, 'charge'), isNull(clientTransactions.voidedAt))))
      .reduce((sum, r) => sum + Number(r.usd), 0);
    const state = upsaleStateOf(
      { ...row!, charged_usd: String(charged), compensated_usd: '0' },
      null,
    );
    // Past the invoice check — the walk decides the rest.
    expect(state).not.toBe('no_invoice');
    expect(state).toBe('not_computed');
  });
});
