import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  clientTransactions,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { sellerPerformanceAll, sellerPerformanceOwn } from '@/modules/wms/crm/seller-report';
import { revenueByStamp } from '@/modules/wms/staff/stamp-revenue';

/**
 * The seller report against a real database (owner, 2026-08-25: «ha qur …
 * tannarx korinmasin sotuvchiga»).
 *
 * The fixtures sit in FEBRUARY 2019 — a period no other test file touches —
 * because the report sums the WHOLE database for its period and a live
 * fixture from a neighbouring file would land in these assertions (#380,
 * the analytics files' parked-in-2020 rule).
 */
const SUFFIX = String(Date.now()).slice(-6);
let sellerA = '';
let sellerB = '';
let clientA = '';
let clientB = '';
let clientNobody = '';
let whId = '';
const madeClients: string[] = [];
const madeReceipts: string[] = [];

const PERIOD = {
  from: new Date('2019-02-01T00:00:00Z'),
  to: new Date('2019-03-01T00:00:00Z'),
  dan: '2019-02-01',
  gacha: '2019-02-28',
};

async function charge(clientId: string, amount: string, txDate: string, voided = false) {
  await db.insert(clientTransactions).values({
    clientId,
    type: 'charge',
    amount,
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: amount,
    txDate,
    createdBy: sellerA,
    voidedAt: voided ? new Date() : null,
  });
}

/**
 * A received prixod as 0117 writes one: the seller STAMPED on it (the client's
 * seller that day) and a carton under the lot — the report's cargo half is the
 * KPI's reader now (staff/cargo.ts), carton-grain on `received_at`. Rewritten
 * with the reason recorded: the old fixture had no box and dated the cargo by
 * `confirmed_at`, and both stopped being what «received cargo» means.
 */
async function received(
  clientId: string,
  receivedAt: string,
  kg: string,
  m3: string,
  opts: { voided?: boolean; stamp: string | null },
) {
  const [r] = await db
    .insert(receipts)
    .values({
      warehouseId: whId,
      clientId,
      salesManagerId: opts.stamp,
      status: opts.voided ? 'voided' : 'confirmed',
      ...(opts.voided ? { voidedAt: new Date(), voidReason: 'test' } : {}),
      receivedAt: new Date(receivedAt),
      confirmedAt: new Date(receivedAt),
      createdBy: sellerA,
    })
    .returning();
  madeReceipts.push(r!.id);
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: r!.id,
      seq: 1,
      productNameZh: '测试',
      boxCount: 1,
      totalWeightKg: kg,
      totalVolumeM3: m3,
    })
    .returning();
  await db.insert(boxes).values({
    lotId: lot!.id,
    shortCode: `SR${SUFFIX}-${madeReceipts.length}`,
    seqInLot: 1,
    status: opts.voided ? 'void' : 'in_stock',
    currentWarehouseId: whId,
  });
}

beforeAll(async () => {
  const mint = async (name: string) => {
    const [u] = await db
      .insert(users)
      .values({
        phone: `+99897${SUFFIX}${name.length}`,
        fullName: `Seller ${name} ${SUFFIX}`,
        passwordHash: 'x',
        active: true,
      })
      .returning();
    return u!.id;
  };
  sellerA = await mint('A');
  sellerB = await mint('Bx');
  const wh = await db.query.warehouses.findFirst({ where: eq(warehouses.active, true) });
  whId = wh!.id;

  const client = async (code: string, managerId: string | null) => {
    const [c] = await db
      .insert(clients)
      .values({ clientCode: code, name: `SR ${code}`, salesManagerId: managerId })
      .returning();
    madeClients.push(c!.id);
    return c!.id;
  };
  clientA = await client(`SRA${SUFFIX}`.slice(0, 10), sellerA);
  clientB = await client(`SRB${SUFFIX}`.slice(0, 10), sellerB);
  clientNobody = await client(`SRN${SUFFIX}`.slice(0, 10), null);

  // Revenue: A charged twice (one on the period's LAST day — the inclusive
  // boundary), B once, the unassigned client once, and one VOIDED charge
  // plus one the day AFTER the period that must not count.
  await charge(clientA, '100', '2019-02-10');
  await charge(clientA, '50', '2019-02-28');
  await charge(clientA, '999', '2019-03-01');
  await charge(clientA, '777', '2019-02-11', true);
  await charge(clientB, '200', '2019-02-15');
  await charge(clientNobody, '40', '2019-02-20');

  // Cargo: A received one confirmed prixod inside the period, one VOIDED one
  // (voidReceipt keeps received_at — the status is the liveness), and the
  // managerless client's cargo carries no stamp.
  await received(clientA, '2019-02-05T10:00:00Z', '120', '1.5', { stamp: sellerA });
  await received(clientA, '2019-02-06T10:00:00Z', '500', '9', { voided: true, stamp: sellerA });
  await received(clientNobody, '2019-02-07T10:00:00Z', '30', '0.4', { stamp: null });
});

afterAll(async () => {
  await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
  if (madeReceipts.length > 0) {
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(inArray(receiptLots.receiptId, madeReceipts));
    if (lots.length > 0) await db.delete(boxes).where(inArray(boxes.lotId, lots.map((l) => l.id)));
    await db.delete(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts));
    await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  }
  await db.delete(clients).where(inArray(clients.id, madeClients));
  await db.update(users).set({ active: false }).where(inArray(users.id, [sellerA, sellerB]));
  await pgClient.end();
});

describe('the full table (scope all)', () => {
  it('splits by manager, keeps the «—» cohort, and the boundary day is inclusive', async () => {
    const { rows, totals, unassignedClients } = await sellerPerformanceAll(PERIOD);
    const a = rows.find((r) => r.managerId === sellerA)!;
    const b = rows.find((r) => r.managerId === sellerB)!;
    const nobody = rows.find((r) => r.managerId === null)!;

    // 100 + the boundary-day 50; never the voided 777 or March's 999.
    expect(a.revenueUsd).toBe(150);
    expect(b.revenueUsd).toBe(200);
    // The unassigned majority is a ROW, not a silent drop — on deploy day
    // 1,402 of 1,692 clients carry no manager.
    expect(nobody.revenueUsd).toBeGreaterThanOrEqual(40);
    expect(unassignedClients).toBeGreaterThanOrEqual(1);

    // Cargo: the voided prixod kept its received_at and must not count.
    expect(a.weightKg).toBe(120);
    expect(a.volumeM3).toBe(1.5);
    expect(a.receipts).toBe(1);
    // The unstamped cargo is the «—» cohort's, beside the managerless book.
    expect(nobody.volumeM3).toBeGreaterThanOrEqual(0.4);

    // The totals reconcile: the sum of the rows IS the totals row.
    const sum = rows.reduce((s, r) => s + r.revenueUsd, 0);
    expect(Math.round(sum * 100) / 100).toBe(totals.revenueUsd);
    expect(a.managerName).toContain('Seller A');
  });
});

describe('the seller’s own card (scope own)', () => {
  it('agrees with the full table’s row for the same person', async () => {
    // #513's shape: the seller's own number and the owner's number for that
    // seller must be one fact. Since 4a the two cards call ONE revenue
    // function (`revenueByStamp`, the own scope filtering before it folds),
    // so they agree by construction — and this pins it anyway.
    const own = await sellerPerformanceOwn(sellerA, PERIOD);
    const { rows } = await sellerPerformanceAll(PERIOD);
    const a = rows.find((r) => r.managerId === sellerA)!;
    expect(own.revenueUsd).toBe(a.revenueUsd);
    expect(own.weightKg).toBe(a.weightKg);
    expect(own.volumeM3).toBe(a.volumeM3);
    expect(own.receipts).toBe(a.receipts);
    expect(own.clients).toBe(a.clients);
  });

  it('the own shape has no cost-derived key at runtime either', async () => {
    const own = await sellerPerformanceOwn(sellerA, PERIOD);
    // The structural fence's runtime half: the object itself carries none.
    expect(Object.keys(own).sort()).toEqual(
      ['clients', 'receipts', 'revenueUsd', 'volumeM3', 'weightKg'].sort(),
    );
  });
});

describe('the money follows the stamp (4a)', () => {
  it('a card price follows the client’s latest prixod, and only a client with none follows the book', async () => {
    // Every charge here names no truck and no job, so each is the fallback:
    // clientA's 100 + 50 → the newest CONFIRMED prixod by that day (02-05,
    // stamped A — the voided 02-06 one is not confirmed); clientB has no
    // prixod → its book, B; clientNobody → its 02-07 prixod stamped nobody.
    const mine = new Set(madeClients);
    const rows = (await revenueByStamp(db, PERIOD, { kind: 'all' })).rows.filter((r) => mine.has(r.clientId));
    const find = (clientId: string, sellerId: string | null) =>
      rows.find((r) => r.clientId === clientId && r.sellerId === sellerId);
    expect(find(clientA, sellerA)).toMatchObject({ cents: 15000, unlinkedCents: 15000, splitCents: 0 });
    expect(find(clientB, sellerB)).toMatchObject({ cents: 20000, unlinkedCents: 20000, splitCents: 0 });
    expect(find(clientNobody, null)).toMatchObject({ cents: 4000, unlinkedCents: 4000, splitCents: 0 });
    expect(rows).toHaveLength(3);

    // Moving clientA to B moves none of A's money: every one of its prices had
    // a prixod by its day, and that prixod carries A's stamp (his «a»).
    await db.update(clients).set({ salesManagerId: sellerB }).where(eq(clients.id, clientA));
    try {
      const { rows: after } = await sellerPerformanceAll(PERIOD);
      expect(after.find((r) => r.managerId === sellerA)!.revenueUsd).toBe(150);
      expect(after.find((r) => r.managerId === sellerB)!.revenueUsd).toBe(200);
    } finally {
      await db.update(clients).set({ salesManagerId: sellerA }).where(eq(clients.id, clientA));
    }
  });
});
