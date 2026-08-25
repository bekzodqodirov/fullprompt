import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  clientTransactions,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { sellerPerformanceAll, sellerPerformanceOwn } from '@/modules/wms/crm/seller-report';

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

async function received(clientId: string, confirmedAt: string, kg: string, m3: string, voided = false) {
  const [r] = await db
    .insert(receipts)
    .values({
      warehouseId: whId,
      clientId,
      status: voided ? 'voided' : 'confirmed',
      confirmedAt: new Date(confirmedAt),
      createdBy: sellerA,
    })
    .returning();
  madeReceipts.push(r!.id);
  await db.insert(receiptLots).values({
    receiptId: r!.id,
    seq: 1,
    productNameZh: '测试',
    boxCount: 1,
    totalWeightKg: kg,
    totalVolumeM3: m3,
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
  // (voidReceipt keeps confirmed_at — the status is the liveness).
  await received(clientA, '2019-02-05T10:00:00Z', '120', '1.5');
  await received(clientA, '2019-02-06T10:00:00Z', '500', '9', true);
  await received(clientNobody, '2019-02-07T10:00:00Z', '30', '0.4');
});

afterAll(async () => {
  await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
  if (madeReceipts.length > 0) {
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

    // Cargo: the voided prixod kept its confirmed_at and must not count.
    expect(a.weightKg).toBe(120);
    expect(a.volumeM3).toBe(1.5);
    expect(a.receipts).toBe(1);

    // The totals reconcile: the sum of the rows IS the totals row.
    const sum = rows.reduce((s, r) => s + r.revenueUsd, 0);
    expect(Math.round(sum * 100) / 100).toBe(totals.revenueUsd);
    expect(a.managerName).toContain('Seller A');
  });
});

describe('the seller’s own card (scope own)', () => {
  it('agrees with the full table’s row for the same person', async () => {
    // #513's shape: the seller's own number and the owner's number for that
    // seller must be one fact. The two queries live in two code paths ON
    // PURPOSE (the own path may not hold the cost query even discarded), so
    // their agreement is pinned here instead of by construction.
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
