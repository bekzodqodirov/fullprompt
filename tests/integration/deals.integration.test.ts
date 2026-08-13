import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxMovements,
  clientTransactions,
  boxes,
  clients,
  deals,
  events,
  receiptLots,
  receipts,
  roles,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import {
  addTransaction,
  clientBalanceUsd,
  deferredBalanceUsd,
} from '@/modules/wms/finance/service';
import { worthAlerting } from '@/modules/wms/deals/deviation';
import {
  activeDeferrals,
  createDeal,
  dealById,
  dealDeviation,
  dealReality,
  deferPayment,
  linkReceipt,
  listStages,
  moveDeal,
  resolveExpiredDeferrals,
  unlinkedReceipts,
  updateDeal,
} from '@/modules/wms/deals/service';

/**
 * Bitim — the quote and the reality, and the alert that fires between them.
 *
 * The cases here are the owner's own, in the order he described them: cargo
 * that arrives with no quote at all, cargo that comes out bigger than the
 * quote, a shipment split over two days, and "I'll pay when it is all here".
 *
 * Everything this file creates is deleted afterwards, definitions included:
 * CI runs vitest and Playwright against ONE database, and a stage or a deal
 * left behind changes what every screen renders (DECISIONS #183).
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId: string;
let warehouseId: string;
let clientId: string;
let otherClientId: string;
const ctx = () => ({ actorId });

const madeDeals: string[] = [];
const madeReceipts: string[] = [];
const madeClients: string[] = [];
const madeTransactions: string[] = [];

/** A confirmed receipt of one lot with the given size, on this client. */
async function receiveCargo(
  volumeM3: number,
  weightKg: number,
  boxCount: number,
  dealId?: string | null,
  forClient?: string,
): Promise<string> {
  const receiptId = crypto.randomUUID();
  const lotId = crypto.randomUUID();
  // Min-1-photo per lot is enforced in the confirm path, so the fixture has to
  // satisfy it exactly as the receiving screen does.
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `dealtest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  const result = await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId: forClient ?? clientId,
      sourceNote: '',
      unclaimedMarking: '',
      dealId: dealId ?? null,
      lots: [
        {
          id: lotId,
          productNameZh: `货 ${SUFFIX}`,
          productNameRu: '',
          boxCount,
          dimsMode: 'mixed',
          totalWeightKg: weightKg,
          totalVolumeM3: volumeM3,
          note: '',
        },
      ],
      extraCosts: [],
    } as Parameters<typeof confirmReceipt>[0],
    ctx(),
  );
  madeReceipts.push(result.receiptId);
  return result.receiptId;
}

/** Is this receipt among the ones the deal card's picker would offer? */
async function unlinkedFor(client: string, receiptId: string): Promise<boolean> {
  return (await unlinkedReceipts(client)).some((r) => r.id === receiptId);
}

async function newDeal(over: Record<string, unknown> = {}): Promise<string> {
  const id = await createDeal(
    {
      clientId: (over.clientId as string) ?? clientId,
      title: `Bitim ${SUFFIX}`,
      quotedVolumeM3: 1,
      quotedWeightKg: 100,
      quotedAmount: 200,
      quotedCurrency: 'USD',
      ...over,
    } as Parameters<typeof createDeal>[0],
    ctx(),
  );
  madeDeals.push(id);
  return id;
}

/**
 * A client nobody else in this file touches.
 *
 * The money tests below assert on a BALANCE, which is the sum of everything
 * that ever happened to that client — so they cannot share the client the rest
 * of the file is deferring and charging against, or each new test silently
 * changes the answer of every earlier one.
 */
let counter = 0;
async function freshClient(): Promise<string> {
  counter += 1;
  const row = await createClient(
    { clientCode: `BQ${SUFFIX}${counter}`, name: `Pul mijoz ${SUFFIX}-${counter}`, phones: [] },
    ctx(),
  );
  madeClients.push(row.id);
  return row.id;
}

/** The events the confirm path emitted for a receipt, newest first. */
async function eventsFor(receiptId: string, type: string) {
  return db
    .select()
    .from(events)
    .where(eq(events.entityId, receiptId))
    .then((rows) => rows.filter((row) => row.type === type));
}

beforeAll(async () => {
  const staff = await db
    .select({ id: users.id, code: roles.code })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(users.active, true));
  actorId = staff.find((row) => row.code === 'super_admin')!.id;
  warehouseId = (await db.select({ id: warehouses.id }).from(warehouses).limit(1))[0]!.id;

  clientId = (
    await createClient({ clientCode: `BT${SUFFIX}`, name: `Bitim mijoz ${SUFFIX}`, phones: [] }, ctx())
  ).id;
  otherClientId = (
    await createClient({ clientCode: `BX${SUFFIX}`, name: `Boshqa mijoz ${SUFFIX}`, phones: [] }, ctx())
  ).id;
  madeClients.push(clientId, otherClientId);
});

afterAll(async () => {
  for (const id of madeReceipts) {
    const lots = await db.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.receiptId, id));
    if (lots.length) {
      // Movements first: every box carries a receipt movement, and the FK
      // refuses the delete otherwise.
      const rows = await db
        .select({ id: boxes.id })
        .from(boxes)
        .where(inArray(boxes.lotId, lots.map((l) => l.id)));
      if (rows.length) {
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, rows.map((b) => b.id)));
      }
      await db.delete(boxes).where(inArray(boxes.lotId, lots.map((l) => l.id)));
      await db.delete(attachments).where(
        inArray(attachments.entityId, lots.map((l) => l.id)),
      );
      await db.delete(receiptLots).where(eq(receiptLots.receiptId, id));
    }
    await db.delete(events).where(eq(events.entityId, id));
    await db.delete(receipts).where(eq(receipts.id, id));
  }
  // Charges point at their deal now, so the money goes before the job does.
  for (const id of madeTransactions) {
    await db.delete(clientTransactions).where(eq(clientTransactions.id, id));
  }
  for (const id of madeDeals) {
    await db.delete(events).where(eq(events.entityId, id));
    await db.delete(deals).where(eq(deals.id, id));
  }
  for (const id of madeClients) await db.delete(clients).where(eq(clients.id, id));
  await pgClient.end();
});

describe('a deal is a client’s job, and it starts on the board', () => {
  it('lands in the first open column with a readable code', async () => {
    const id = await newDeal();
    const row = await db.query.deals.findFirst({ where: eq(deals.id, id) });
    const stages = await listStages();
    expect(row!.code).toMatch(/^B-\d{6}$/);
    expect(row!.stageId).toBe(stages.find((s) => s.kind === 'open')!.id);
    // Priced at creation, so the "who quoted this and when" question has an
    // answer from the first save.
    expect(row!.quotedAt).not.toBeNull();
    expect(row!.quotedBy).toBe(actorId);
  });

  it('leaves the quote clock alone for a deal opened WITHOUT a price', async () => {
    // "Price this for me" is where most jobs start; stamping quotedAt here
    // would report that we answered instantly every single time.
    const id = await newDeal({ quotedAmount: null, quotedCurrency: null });
    const row = await db.query.deals.findFirst({ where: eq(deals.id, id) });
    expect(row!.quotedAt).toBeNull();
  });

  it('stamps the re-price, because that is the number the client was told', async () => {
    const id = await newDeal({ quotedAmount: null, quotedCurrency: null });
    await updateDeal(
      id,
      { clientId, quotedVolumeM3: 1, quotedWeightKg: 100, quotedAmount: 240, quotedCurrency: 'USD' },
      ctx(),
    );
    const row = await db.query.deals.findFirst({ where: eq(deals.id, id) });
    expect(row!.quotedAt).not.toBeNull();
    expect(row!.quotedAmount).toBe('240.00');
  });

  it('refuses to lose a deal without saying why', async () => {
    const id = await newDeal();
    const lost = (await listStages()).find((s) => s.kind === 'lost')!;
    await expect(moveDeal(id, lost.id, ctx(), '')).rejects.toThrow('lost_reason_required');
    await moveDeal(id, lost.id, ctx(), 'mijoz boshqa firma tanladi');
    const row = await db.query.deals.findFirst({ where: eq(deals.id, id) });
    expect(row!.lostReason).toBe('mijoz boshqa firma tanladi');
  });
});

describe('the reality side is summed from the receipts, never typed in', () => {
  it('adds up every receipt of the job and counts the boxes', async () => {
    const id = await newDeal();
    await receiveCargo(0.6, 60, 6, id);
    await receiveCargo(0.8, 40, 4, id);
    const reality = await dealReality(id);
    expect(reality.receiptCount).toBe(2);
    expect(reality.volumeM3).toBeCloseTo(1.4, 3);
    expect(reality.weightKg).toBeCloseTo(100, 3);
    expect(reality.boxCount).toBe(10);
    // Nothing has left China, so nothing has "arrived".
    expect(reality.pendingBoxes).toBe(10);
    expect(reality.arrivedBoxes).toBe(0);
  });

  it('drops a voided receipt out of the sum', async () => {
    const id = await newDeal();
    const receiptId = await receiveCargo(1.4, 100, 10, id);
    expect((await dealReality(id)).volumeM3).toBeCloseTo(1.4, 3);
    await db.update(receipts).set({ voidedAt: new Date(), voidReason: 'xato' }).where(eq(receipts.id, receiptId));
    // A cancelled receipt never happened; counting it would report the job
    // 40 % over when it is not.
    expect((await dealReality(id)).volumeM3).toBe(0);
  });

  it('lets cargo filed under the wrong job be moved to the right one, and detached', async () => {
    // The receipt card's picker (round 38) is the only way back from the
    // commonest mistake there is: the deal card offers only UNLINKED receipts,
    // so once a receipt is on the wrong job it vanishes from every picker.
    const wrong = await newDeal();
    const right = await newDeal();
    const receiptId = await receiveCargo(0.9, 90, 9, wrong);
    expect((await dealReality(wrong)).receiptCount).toBe(1);

    // Straight across, with no detach step in between — what the picker does.
    await linkReceipt(receiptId, right, ctx());
    expect((await dealReality(wrong)).receiptCount).toBe(0);
    expect((await dealReality(right)).boxCount).toBe(9);
    expect(await unlinkedFor(clientId, receiptId)).toBe(false);

    // And the empty option puts it back among the client's free receipts,
    // where the deal card's own picker can find it again.
    await linkReceipt(receiptId, null, ctx());
    expect((await dealReality(right)).receiptCount).toBe(0);
    expect(await unlinkedFor(clientId, receiptId)).toBe(true);
  });

  it('a linked prixod keeps its goods, kg and m³ on the card (round 100, item 2)', async () => {
    // The owner: after linking, «yana faqat id korinib qolyabti» — the picker
    // said «货 · 1.2 m³ · 80 kg» and the linked row above it said only the
    // number. Both must read from the same grouped query.
    const id = await newDeal();
    await receiveCargo(1.2, 80, 8, id);
    const card = (await dealById(id))!;
    expect(card.receipts).toHaveLength(1);
    expect(card.receipts[0]!.goods).toContain('货');
    expect(card.receipts[0]!.volumeM3).toBeCloseTo(1.2, 3);
    expect(card.receipts[0]!.weightKg).toBeCloseTo(80, 3);
  });

  it('refuses to file one client’s cargo under another client’s job', async () => {
    const id = await newDeal();
    const receiptId = await receiveCargo(0.5, 50, 5, null);
    await db.update(receipts).set({ clientId: otherClientId }).where(eq(receipts.id, receiptId));
    await expect(linkReceipt(receiptId, id, ctx())).rejects.toThrow('client_mismatch');
    await db.update(receipts).set({ clientId }).where(eq(receipts.id, receiptId));
  });
});

describe('price control fires while the cargo is still in China', () => {
  it('shouts when cargo arrives under no job at all', async () => {
    const receiptId = await receiveCargo(1.4, 180, 10, null);
    const alerts = await eventsFor(receiptId, 'UnquotedCargo');
    expect(alerts).toHaveLength(1);
    const payload = alerts[0]!.payload as Record<string, unknown>;
    expect(payload.volumeM3).toBeCloseTo(1.4, 3);
    expect(payload.boxCount).toBe(10);
  });

  it('shouts when the cargo is more than the threshold away from the quote', async () => {
    const id = await newDeal();
    const receiptId = await receiveCargo(1.4, 100, 10, id);
    const alerts = await eventsFor(id, 'DealDeviation');
    expect(alerts).toHaveLength(1);
    const payload = alerts[0]!.payload as Record<string, unknown>;
    expect(payload.worstPct).toBeCloseTo(40, 3);
    expect(payload.suggestedAmount).toBe(280);
    // And it does NOT also claim the cargo was unquoted.
    expect(await eventsFor(receiptId, 'UnquotedCargo')).toHaveLength(0);
  });

  it('stays quiet when the cargo matches the quote', async () => {
    const id = await newDeal();
    await receiveCargo(1.02, 100, 10, id);
    expect(await eventsFor(id, 'DealDeviation')).toHaveLength(0);
  });

  it('says nothing about a split shipment that is merely half-arrived', async () => {
    // Half today, half tomorrow — a normal week here. The first half reads as
    // 50 % UNDER the quote, and this test is the reason `worthAlerting` exists
    // at all: without it the company got a false alarm on every split job, and
    // a channel that cries wolf weekly stops being read.
    const id = await newDeal();
    await receiveCargo(0.5, 50, 5, id);
    expect(await eventsFor(id, 'DealDeviation')).toHaveLength(0);
    await receiveCargo(0.5, 50, 5, id);
    expect(await eventsFor(id, 'DealDeviation')).toHaveLength(0);
  });

  it('still shouts the moment a PART shipment is already over the quote', async () => {
    // The other half of the same rule: half the cargo that is already 1.5 m³
    // against a 1 m³ quote is a problem now, not when the rest lands.
    const id = await newDeal();
    await receiveCargo(1.5, 60, 5, id);
    expect(await eventsFor(id, 'DealDeviation')).toHaveLength(1);
  });

  it('leaves the under-delivery visible on the card even though it sent nothing', async () => {
    // Not pushed, but not hidden: `compareQuote` still reports the gap, so the
    // deal card and the board show "smaller than quoted" to somebody who is
    // already looking at the job.
    const id = await newDeal();
    await receiveCargo(0.4, 40, 4, id);
    const { deviation } = await dealDeviation(id);
    expect(deviation.exceeds).toBe(true);
    expect(deviation.worstPct).toBeLessThan(0);
    expect(worthAlerting(deviation)).toBe(false);
  });

  it('never blocks the receipt, whatever it finds', async () => {
    // The owner's answer 1: "notify above 10 %, never block loading". The
    // boxes are physically in the building; the record of that must survive.
    const id = await newDeal();
    const receiptId = await receiveCargo(9, 900, 40, id);
    const row = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(row!.status).toBe('confirmed');
    expect(row!.dealId).toBe(id);
  });
});

describe('"I will pay when it is all here"', () => {
  it('refuses a deferral with no reason and no end', async () => {
    const id = await newDeal();
    await expect(
      deferPayment(id, { reason: '', untilAllArrived: true }, ctx()),
    ).rejects.toThrow('reason_required');
    await expect(
      deferPayment(id, { reason: '1 karobka yo‘lda', untilAllArrived: false, untilDate: null }, ctx()),
    ).rejects.toThrow('end_required');
  });

  it('holds while a box is outstanding and lifts itself when the last one lands', async () => {
    const who = await freshClient();
    const id = await newDeal({ clientId: who });
    await receiveCargo(1, 100, 10, id, who);
    await deferPayment(id, { reason: '1 karobka yo‘lda', untilAllArrived: true }, ctx());

    // The gate must honour it now…
    expect(await activeDeferrals(who)).toHaveLength(1);
    expect((await activeDeferrals(who))[0]!.pendingBoxes).toBe(10);
    // The sweep is global, so assert on THIS deal rather than on a count that
    // any other deferral in the database would change.
    await resolveExpiredDeferrals();
    expect((await db.query.deals.findFirst({ where: eq(deals.id, id) }))!.deferralEndedAt).toBeNull();

    // …and let go by itself once every box is in the client's reach. Nobody
    // has to remember to lift it, which is the whole point.
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(eq(receipts.dealId, id));
    await db
      .update(boxes)
      .set({ status: 'issued' })
      .where(inArray(boxes.lotId, lots.map((l) => l.id)));

    expect(await activeDeferrals(who)).toHaveLength(0);
    await resolveExpiredDeferrals();
    const row = await db.query.deals.findFirst({ where: eq(deals.id, id) });
    expect(row!.deferralEndedAt).not.toBeNull();
  });

  it('does not wait for ever on a box that is never coming', async () => {
    // A LOST box would otherwise hold the deferral open permanently, which is
    // exactly how a debt gate quietly stops working.
    const who = await freshClient();
    const id = await newDeal({ clientId: who });
    await receiveCargo(1, 100, 4, id, who);
    await deferPayment(id, { reason: 'yo‘qolgan karobka', untilAllArrived: true }, ctx());
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(eq(receipts.dealId, id));
    const rows = await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lots.map((l) => l.id)));
    await db.update(boxes).set({ status: 'issued' }).where(inArray(boxes.id, rows.slice(1).map((b) => b.id)));
    await db.update(boxes).set({ status: 'lost' }).where(eq(boxes.id, rows[0]!.id));

    expect(await activeDeferrals(who)).toHaveLength(0);
    await resolveExpiredDeferrals();
    expect((await db.query.deals.findFirst({ where: eq(deals.id, id) }))!.deferralEndedAt).not.toBeNull();
  });

  it('actually opens the handover gate — the half that made the deferral real', async () => {
    // Without this the whole feature was a note: the decision was recorded and
    // the warehouse went on refusing the client's cargo, so the operator
    // pressed the override and the reason went back to being a Telegram
    // message. The gate has to read it.
    const who = await freshClient();
    const id = await newDeal({ clientId: who });
    await receiveCargo(1, 100, 10, id, who);
    const charge = await addTransaction(
      {
        clientId: who,
        dealId: id,
        type: 'charge',
        amount: 200,
        currency: 'USD',
        txDate: new Date().toISOString().slice(0, 10),
      },
      ctx(),
    );
    madeTransactions.push(charge.id);

    // Owed, and blocking, before anybody agreed to wait.
    expect(await clientBalanceUsd(who)).toBeCloseTo(200, 2);
    expect(await deferredBalanceUsd(who)).toBe(0);

    await deferPayment(id, { reason: '1 karobka yo‘lda', untilAllArrived: true }, ctx());
    // The client still OWES it — the balance is not rewritten, only the figure
    // the gate decides on.
    expect(await clientBalanceUsd(who)).toBeCloseTo(200, 2);
    expect(await deferredBalanceUsd(who)).toBeCloseTo(200, 2);
  });

  it('does not let a deferral on one job excuse an unrelated old debt', async () => {
    // The reason the deferral lives on the deal and not on the client.
    const who = await freshClient();
    const deferredDeal = await newDeal({ clientId: who });
    await receiveCargo(1, 100, 4, deferredDeal, who);
    const today = new Date().toISOString().slice(0, 10);
    const onDeal = await addTransaction(
      { clientId: who, dealId: deferredDeal, type: 'charge', amount: 200, currency: 'USD', txDate: today },
      ctx(),
    );
    // An older charge from batch pricing, tied to no job at all.
    const old = await addTransaction(
      { clientId: who, type: 'charge', amount: 90, currency: 'USD', txDate: today },
      ctx(),
    );
    madeTransactions.push(onDeal.id, old.id);
    await deferPayment(deferredDeal, { reason: 'yuk to‘liq emas', untilAllArrived: true }, ctx());

    expect(await clientBalanceUsd(who)).toBeCloseTo(290, 2);
    // Only the job's own 200 is excused; the old 90 still blocks.
    expect(await deferredBalanceUsd(who)).toBeCloseTo(200, 2);
  });

  it('a payment naming another client\'s deal is refused, not misfiled', async () => {
    // The dealId column steers the deferral netting above, and the form's
    // select is a POST like any other: a stale tab or a forged value must not
    // park this client's money on somebody else's job — it would quietly
    // re-open THAT client's handover gate.
    const who = await freshClient();
    const other = await freshClient();
    const foreignDeal = await newDeal({ clientId: other });
    const today = new Date().toISOString().slice(0, 10);
    await expect(
      addTransaction(
        { clientId: who, dealId: foreignDeal, type: 'payment', amount: 100, currency: 'USD', txDate: today },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'deal_mismatch' });
  });

  it('a deferral that was already PAID stops excusing anything', async () => {
    /**
     * The hole the audit found, and it is the expensive direction.
     *
     * `deferredBalanceUsd` summed the CHARGES on deferred deals and ignored
     * payments, while `clientBalanceUsd` nets both. So a client who deferred a
     * job, then paid it, kept the full deferred figure — and the gate
     * subtracts one from the other. A large paid-off deferral could cover an
     * unrelated debt that is genuinely outstanding, and the warehouse would
     * hand over cargo to a debtor with no override pressed and nothing in the
     * audit trail saying anyone decided to.
     */
    const who = await freshClient();
    const dealId = await newDeal({ clientId: who });
    await receiveCargo(1, 100, 4, dealId, who);
    const today = new Date().toISOString().slice(0, 10);

    const charge = await addTransaction(
      { clientId: who, dealId, type: 'charge', amount: 1000, currency: 'USD', txDate: today },
      ctx(),
    );
    // An unrelated older debt, from batch pricing, tied to no job.
    const oldDebt = await addTransaction(
      { clientId: who, type: 'charge', amount: 500, currency: 'USD', txDate: today },
      ctx(),
    );
    await deferPayment(dealId, { reason: 'yuk to‘liq emas', untilAllArrived: true }, ctx());

    // …and then the client pays the deferred job in full.
    const paid = await addTransaction(
      { clientId: who, dealId, type: 'payment', amount: 1000, currency: 'USD', txDate: today },
      ctx(),
    );
    madeTransactions.push(charge.id, oldDebt.id, paid.id);

    // 500 is genuinely still owed…
    expect(await clientBalanceUsd(who)).toBeCloseTo(500, 2);
    // …and nothing at all is deferred any more: the job it was granted for is
    // settled. Before the fix this answered 1000, and 500 - 1000 < 0 opened
    // the gate.
    expect(await deferredBalanceUsd(who)).toBeCloseTo(0, 2);
  });

  it('never lets an OVERpayment on one job excuse another', async () => {
    // Guard on the fix itself: netting per deal must clamp at zero, or paying
    // 1200 against a 1000 job would hand out 200 of forgiveness elsewhere.
    const who = await freshClient();
    const dealId = await newDeal({ clientId: who });
    await receiveCargo(1, 100, 4, dealId, who);
    const today = new Date().toISOString().slice(0, 10);
    const charge = await addTransaction(
      { clientId: who, dealId, type: 'charge', amount: 1000, currency: 'USD', txDate: today },
      ctx(),
    );
    await deferPayment(dealId, { reason: 'kutamiz', untilAllArrived: true }, ctx());
    const over = await addTransaction(
      { clientId: who, dealId, type: 'payment', amount: 1200, currency: 'USD', txDate: today },
      ctx(),
    );
    madeTransactions.push(charge.id, over.id);

    expect(await deferredBalanceUsd(who)).toBeCloseTo(0, 2);
  });

  it('expires a dated deferral the day after its date', async () => {
    const who = await freshClient();
    const id = await newDeal({ clientId: who });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await deferPayment(
      id,
      { reason: 'kelasi haftagacha', untilAllArrived: false, untilDate: yesterday },
      ctx(),
    );
    // The gate stops honouring it immediately, before the sweep has run —
    // otherwise a debtor is invisible until the next job tick.
    expect(await activeDeferrals(who)).toHaveLength(0);
    await resolveExpiredDeferrals();
    expect((await db.query.deals.findFirst({ where: eq(deals.id, id) }))!.deferralEndedAt).not.toBeNull();
  });
});
