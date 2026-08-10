import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clientTransactions,
  attachments,
  batches,
  boxes,
  clients,
  currencies,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import {
  FinanceError,
  addTransaction,
  batchCharges,
  clientBalanceUsd,
  clientBalances,
  clientLedger,
  voidTransaction,
} from '@/modules/wms/finance/service';
import { IssueError, issueBoxes } from '@/modules/wms/issue/service';

/**
 * Phase 2.1: client money ledger + debt gate. No tariffs — charges are the
 * negotiated prices, payments arrive in any currency, balance is USD, and a
 * debtor gets cargo only with debtOk (manager permission).
 */

const WH = 'F21WH';
const WH2 = 'F21W2';
let warehouseId: string;
let destWarehouseId: string;
let actorId: string;
let clientId: string;
const ctx = () => ({ actorId });

/** confirmReceipt requires at least one photo per lot. */
async function fakePhoto(lotId: string) {
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `f21test/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
}

beforeAll(async () => {
  const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, WH) });
  warehouseId = existing
    ? existing.id
    : (
        await db
          .insert(warehouses)
          .values({ code: WH, name: 'Finance WH', country: 'UZ', type: 'distribution', timezone: 'Asia/Tashkent', batchPrefix: WH })
          .returning()
      )[0]!.id;
  const existing2 = await db.query.warehouses.findFirst({ where: eq(warehouses.code, WH2) });
  destWarehouseId = existing2
    ? existing2.id
    : (
        await db
          .insert(warehouses)
          .values({ code: WH2, name: 'Finance WH 2', country: 'UZ', type: 'distribution', timezone: 'Asia/Tashkent', batchPrefix: WH2 })
          .returning()
      )[0]!.id;
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const suffix = String(Date.now()).slice(-6);
  const [c] = await db.insert(clients).values({ clientCode: `F2${suffix}`, name: 'Finance client' }).returning();
  clientId = c!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('a seller reads their own book and nobody else\'s', () => {
  /**
   * The owner, logged in as a seller: «menga boshqa clientlarning financi
   * ko'rinyabti». `sales_manager` holds `finance.view`, and `/finance` ran an
   * unscoped query — every client's charges, payments and balance, and the
   * company's total debt at the top.
   */
  let mineId: string;
  let theirsId: string;
  let sellerId: string;
  let otherSellerId: string;

  beforeAll(async () => {
    const people = await db.select().from(users).limit(2);
    sellerId = people[0]!.id;
    otherSellerId = people[1]?.id ?? people[0]!.id;
    const tag = String(Date.now()).slice(-6);
    const [mine] = await db
      .insert(clients)
      .values({ clientCode: `FM${tag}`, name: 'Mine', salesManagerId: sellerId })
      .returning();
    mineId = mine!.id;
    const [theirs] = await db
      .insert(clients)
      .values({ clientCode: `FT${tag}`, name: 'Theirs', salesManagerId: otherSellerId })
      .returning();
    theirsId = theirs!.id;
    await addTransaction(
      { clientId: mineId, type: 'charge', amount: 10, currency: 'USD', txDate: '2026-07-10' },
      ctx(),
    );
    await addTransaction(
      { clientId: theirsId, type: 'charge', amount: 20, currency: 'USD', txDate: '2026-07-10' },
      ctx(),
    );
  });

  afterAll(async () => {
    await db.delete(clientTransactions).where(eq(clientTransactions.clientId, mineId));
    await db.delete(clientTransactions).where(eq(clientTransactions.clientId, theirsId));
    await db.delete(clients).where(eq(clients.id, mineId));
    await db.delete(clients).where(eq(clients.id, theirsId));
  });

  it('the seller sees their own client', async () => {
    const rows = await clientBalances(sellerId);
    expect(rows.some((r) => r.clientId === mineId)).toBe(true);
  });

  it('and does NOT see a client that belongs to somebody else', async () => {
    if (otherSellerId === sellerId) return; // one-user database: nothing to prove
    const rows = await clientBalances(sellerId);
    expect(rows.some((r) => r.clientId === theirsId)).toBe(false);
  });

  it('an unscoped read still sees both — the accountant lost nothing', async () => {
    const rows = await clientBalances();
    expect(rows.some((r) => r.clientId === mineId)).toBe(true);
    expect(rows.some((r) => r.clientId === theirsId)).toBe(true);
  });
});

describe('client ledger', () => {
  it('charge and payment convert to USD at the dated rate; balance = charges − payments', async () => {
    // Seeded rates: UZS 0.00008 effective 2026-07-01.
    const charge = await addTransaction(
      { clientId, type: 'charge', amount: 100, currency: 'USD', txDate: '2026-07-10' },
      ctx(),
    );
    expect(Number(charge.amountUsd)).toBe(100);
    expect(charge.method).toBeNull();

    const payment = await addTransaction(
      { clientId, type: 'payment', amount: 500_000, currency: 'UZS', method: 'cash', txDate: '2026-07-11' },
      ctx(),
    );
    expect(Number(payment.amountUsd)).toBe(40); // 500 000 × 0.00008
    expect(Number(payment.rateToUsd)).toBe(0.00008);

    expect(await clientBalanceUsd(clientId)).toBe(60);

    const summary = (await clientBalances()).find((r) => r.clientId === clientId)!;
    expect(summary.chargesUsd).toBe(100);
    expect(summary.paymentsUsd).toBe(40);
    expect(summary.balanceUsd).toBe(60);

    const ledger = await clientLedger(clientId);
    expect(ledger).toHaveLength(2);
    expect(ledger[0]!.createdByName).toBeTruthy();
  });

  it('refuses a transaction in a currency that has no FX rate at all', async () => {
    await db.insert(currencies).values({ code: 'AED', name: 'Dirham' }).onConflictDoNothing();
    await expect(
      addTransaction(
        { clientId, type: 'payment', amount: 10, currency: 'AED', method: 'card', txDate: '2026-07-11' },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'fx_missing' } satisfies Partial<FinanceError>);
  });

  it('void removes the row from the balance (and cannot be voided twice)', async () => {
    const before = await clientBalanceUsd(clientId);
    const tx = await addTransaction(
      { clientId, type: 'charge', amount: 25, currency: 'USD', txDate: '2026-07-12' },
      ctx(),
    );
    expect(await clientBalanceUsd(clientId)).toBe(before + 25);
    await voidTransaction(tx.id, 'entered by mistake', ctx());
    expect(await clientBalanceUsd(clientId)).toBe(before);
    await expect(voidTransaction(tx.id, 'again', ctx())).rejects.toMatchObject({
      code: 'already_voided',
    });
  });

  it('links charges to a batch for the pricing screen', async () => {
    const [batch] = await db
      .insert(batches)
      .values({
        code: `F21-${String(Date.now()).slice(-6)}`,
        originWarehouseId: warehouseId,
        destWarehouseId,
        type: 'distribution',
        status: 'closed',
        createdBy: actorId,
      })
      .returning();
    await addTransaction(
      { clientId, type: 'charge', amount: 50, currency: 'USD', txDate: '2026-07-12', batchId: batch!.id },
      ctx(),
    );
    const list = await batchCharges(batch!.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.clientCode).toMatch(/^F2/);
    expect(Number(list[0]!.tx.amountUsd)).toBe(50);
    // Keep the ledger consistent for the debt-gate tests below.
    await voidTransaction(list[0]!.tx.id, 'test cleanup', ctx());
  });
});

describe('debt gate on issue (owner: debtor cargo only with manager permission)', () => {
  it('blocks issue for a debtor without debtOk and allows it with debtOk', async () => {
    // The ledger from the previous tests leaves this client owing $60.
    expect(await clientBalanceUsd(clientId)).toBeGreaterThan(0);

    const receiptId = uuidv4();
    const lotId = uuidv4();
    await fakePhoto(lotId);
    await confirmReceipt(
      {
        receiptId,
        warehouseId,
        clientId,
        unclaimedMarking: '',
        lots: [
          {
            id: lotId,
            productNameZh: '欠款货',
            boxCount: 1,
            dimsMode: 'uniform',
            boxLengthCm: 30,
            boxWidthCm: 30,
            boxHeightCm: 30,
            boxWeightKg: 5,
          },
        ],
        extraCosts: [],
      },
      ctx(),
    );
    const box = (await db.select().from(boxes).where(eq(boxes.lotId, lotId)))[0]!;

    const base = {
      clientId,
      warehouseId,
      boxIds: [box.id],
      personName: 'Qarzdor Vakili',
      personPhone: '+998900000000',
    };
    await expect(
      issueBoxes({ ...base, handoverId: uuidv4(), debtOk: false }, ctx()),
    ).rejects.toMatchObject({ code: 'debt_block' } satisfies Partial<IssueError>);

    const handover = await issueBoxes({ ...base, handoverId: uuidv4(), debtOk: true }, ctx());
    expect(handover.debtOk).toBe(true);
    const after = (await db.select().from(boxes).where(eq(boxes.id, box.id)))[0]!;
    expect(after.status).toBe('issued');
  });

  it('does not block a client with zero balance', async () => {
    const suffix = String(Date.now()).slice(-6);
    const [clean] = await db
      .insert(clients)
      .values({ clientCode: `F0${suffix}`, name: 'No-debt client' })
      .returning();
    const receiptId = uuidv4();
    const lotId = uuidv4();
    await fakePhoto(lotId);
    await confirmReceipt(
      {
        receiptId,
        warehouseId,
        clientId: clean!.id,
        unclaimedMarking: '',
        lots: [
          {
            id: lotId,
            productNameZh: '正常货',
            boxCount: 1,
            dimsMode: 'uniform',
            boxLengthCm: 30,
            boxWidthCm: 30,
            boxHeightCm: 30,
            boxWeightKg: 5,
          },
        ],
        extraCosts: [],
      },
      ctx(),
    );
    const box = (await db.select().from(boxes).where(eq(boxes.lotId, lotId)))[0]!;
    const handover = await issueBoxes(
      {
        handoverId: uuidv4(),
        clientId: clean!.id,
        warehouseId,
        boxIds: [box.id],
        personName: 'Toza Klient',
        personPhone: '+998911111111',
        debtOk: false,
      },
      ctx(),
    );
    expect(handover.kind).toBe('issued_to_client');
  });
});
