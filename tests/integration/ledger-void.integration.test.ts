import 'dotenv/config';
import { asc, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  clientTransactions,
  clients,
  costEntries,
  costTypes,
  partnerTypes,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { saveAccount } from '@/modules/wms/accounting/service';
import { addCostEntry, voidCostEntry } from '@/modules/wms/costing/service';
import { addTransaction, partnerIsStaffSql, voidTransaction } from '@/modules/wms/finance/service';
import { mayVoidLedgerRow } from '@/modules/wms/finance/void-rule';
import { savePartner, setPartnerActive } from '@/modules/wms/partners/service';
import { recordSettlement } from '@/modules/wms/partners/settlement';

/**
 * Q19 (owner, 2026-09-25): the kassa is its holders'. A client-ledger row that
 * put money into a drawer — a PLACED payment, a refund — is voided by the
 * accountant and the admin; everybody else (the VED) voids a price, a
 * settlement half and his own payment until somebody placed it.
 *
 * Two proofs. (a) The void's SQL claim and the page's `mayVoidLedgerRow` agree
 * row kind by row kind — the ✖ is drawn exactly where the door opens (#513).
 * (b-d) The refusal is decided INSIDE the UPDATE, not by the pre-read: a
 * second connection holds the row mid-placement (or mid-void), the void waits
 * on its lock, and when the holder commits the claim finds nothing. Observed
 * through the POOL's pg_stat_activity, because a snapshot taken inside an open
 * transaction freezes (#873's method).
 *
 * Money is parked in 1619, a year no other file writes (#713). What is left
 * live is voided in afterAll; the till and the firm are retired (#183).
 */
const DAY = '1619-04-12';
const SUFFIX = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
let me: string;
let other: string;
let tillId: string;
let tillName: string;
let partnerId: string;
let staffPartnerId: string;
let batchId: string;
let costTypeId: string;
const liveTx: string[] = [];
const liveCosts: string[] = [];

const ctx = (actorId: string) => ({ actorId });
const nonHolder = (actorId: string) => ({ mayMoveTill: false as const, actorId });

let minted = 0;
/** One client per case: a refund is capped by the advance, so rows must not meet. */
async function freshClient(tag: string): Promise<string> {
  minted += 1;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `LV${minted}${SUFFIX.slice(-6)}`.toUpperCase().slice(0, 10), name: `Ledger void ${tag}` })
    .returning({ id: clients.id });
  return row!.id;
}

async function rowOf(id: string) {
  const [row] = await db
    .select({ voidedAt: clientTransactions.voidedAt, accountId: clientTransactions.accountId })
    .from(clientTransactions)
    .where(eq(clientTransactions.id, id));
  return row!;
}

/** The facts the page draws the ✖ from, read back from the row itself. */
async function factsOf(id: string) {
  const [row] = await db
    .select({
      type: clientTransactions.type,
      accountId: clientTransactions.accountId,
      partnerId: clientTransactions.partnerId,
      partnerStaff: sql<boolean>`${partnerIsStaffSql()}`,
      createdBy: clientTransactions.createdBy,
    })
    .from(clientTransactions)
    .where(eq(clientTransactions.id, id));
  return row!;
}

/**
 * Run `statement` on a second connection inside an open transaction, start
 * `act` against the same row, wait until postgres says `act` is waiting on a
 * lock, then commit — and hand back how `act` settled.
 */
async function raceAgainst(statement: string, params: string[], act: () => Promise<unknown>, table: string) {
  const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
    max: 1,
    onnotice: () => {},
  });
  const held = await helper.reserve();
  try {
    await held`BEGIN`;
    await held.unsafe(statement, params);
    const outcome = act().then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, code: (err as { code?: string }).code }),
    );
    let waiting = false;
    for (let i = 0; i < 250 && !waiting; i += 1) {
      const rows = await db.execute<{ pid: number }>(sql`
        SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query ILIKE ${`%update%${table}%`} AND pid <> pg_backend_pid()
      `);
      waiting = rows.length > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 20));
    }
    expect(waiting, 'the void never reached the row lock').toBe(true);
    await held`COMMIT`;
    return await outcome;
  } finally {
    held.release();
    await helper.end();
  }
}

beforeAll(async () => {
  const people = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(asc(users.id))
    .limit(2);
  me = people[0]!.id;
  other = people[1]!.id;
  tillName = `LV till ${SUFFIX}`;
  tillId = (
    await saveAccount(
      { name: tillName, currency: 'USD', kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 900, active: true },
      ctx(me),
    )
  ).id;
  const [type] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'transport')).limit(1);
  partnerId = await savePartner(null, { name: `LV firma ${SUFFIX}`, typeId: type!.id }, ctx(me));
  const [staffType] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'staff')).limit(1);
  staffPartnerId = await savePartner(null, { name: `LV hodim ${SUFFIX}`, typeId: staffType!.id }, ctx(me));
  const [origin, dest] = await db.select({ id: warehouses.id }).from(warehouses).orderBy(asc(warehouses.code)).limit(2);
  const [batch] = await db
    .insert(batches)
    .values({
      code: `LV-${SUFFIX}`.slice(0, 20),
      originWarehouseId: origin!.id,
      destWarehouseId: dest!.id,
      status: 'forming',
      createdBy: me,
    })
    .returning();
  batchId = batch!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).where(eq(costTypes.active, true)).limit(1))[0]!.id;
});

afterAll(async () => {
  try {
    for (const id of liveTx) {
      await voidTransaction(id, 'ledger-void tozalash', ctx(me), { mayMoveTill: true }).catch(() => undefined);
    }
    for (const id of liveCosts) {
      await voidCostEntry(id, 'ledger-void tozalash', ctx(me), { mayMoveTill: true }).catch(() => undefined);
    }
    await db.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, batchId));
    await saveAccount(
      { name: tillName, currency: 'USD', kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 900, active: false, id: tillId },
      ctx(me),
    ).catch(() => undefined);
    await setPartnerActive(partnerId, false, ctx(me)).catch(() => undefined);
    await setPartnerActive(staffPartnerId, false, ctx(me)).catch(() => undefined);
  } finally {
    await pgClient.end();
  }
});

describe('(a) the ✖ and the void agree, row kind by row kind', () => {
  const kinds: { name: string; mint: (clientId: string) => Promise<string> }[] = [
    {
      name: 'a price (charge)',
      mint: async (clientId) =>
        (await addTransaction({ clientId, type: 'charge', amount: 30, currency: 'USD', txDate: DAY }, ctx(me))).id,
    },
    {
      name: "a colleague's price",
      mint: async (clientId) =>
        (await addTransaction({ clientId, type: 'charge', amount: 31, currency: 'USD', txDate: DAY }, ctx(other))).id,
    },
    {
      name: 'a PLACED payment',
      mint: async (clientId) =>
        (
          await addTransaction(
            { clientId, type: 'payment', amount: 32, currency: 'USD', txDate: DAY, accountId: tillId, method: 'cash' },
            ctx(me),
          )
        ).id,
    },
    {
      name: 'his own unplaced payment',
      mint: async (clientId) =>
        (await addTransaction({ clientId, type: 'payment', amount: 33, currency: 'USD', txDate: DAY, method: 'cash' }, ctx(me))).id,
    },
    {
      name: "a colleague's unplaced payment",
      mint: async (clientId) =>
        (
          await addTransaction({ clientId, type: 'payment', amount: 34, currency: 'USD', txDate: DAY, method: 'cash' }, ctx(other))
        ).id,
    },
    {
      name: 'a settlement half',
      mint: async (clientId) =>
        (
          await recordSettlement(
            {
              txId: uuidv4(),
              clientId,
              partnerId,
              clientAmount: 35,
              clientCurrency: 'USD',
              partnerAmount: 35,
              partnerCurrency: 'USD',
              txDate: DAY,
              note: 'mijoz firmaga to‘ladi',
            },
            ctx(other),
          )
        ).clientTxId,
    },
    {
      // Staff money is the kassa holders' (M3a), however it was routed.
      name: 'a settlement half through a staff account',
      mint: async (clientId) =>
        (
          await recordSettlement(
            {
              txId: uuidv4(),
              clientId,
              partnerId: staffPartnerId,
              clientAmount: 37,
              clientCurrency: 'USD',
              partnerAmount: 37,
              partnerCurrency: 'USD',
              txDate: DAY,
              note: 'mijoz hodimga berdi',
            },
            ctx(me),
          )
        ).clientTxId,
    },
    {
      name: 'a refund',
      mint: async (clientId) => {
        // Its own advance to hand back (a refund is capped by it, U04).
        const advance = await addTransaction(
          { clientId, type: 'payment', amount: 36, currency: 'USD', txDate: DAY, accountId: tillId, method: 'cash' },
          ctx(me),
        );
        liveTx.push(advance.id);
        return (
          await addTransaction(
            { clientId, type: 'refund', amount: 36, currency: 'USD', txDate: DAY, accountId: tillId, method: 'cash' },
            ctx(me),
          )
        ).id;
      },
    },
  ];

  for (const kind of kinds) {
    it(`${kind.name}: a non-holder's void succeeds exactly where the ✖ is drawn`, async () => {
      const clientId = await freshClient(kind.name);
      const id = await kind.mint(clientId);
      liveTx.push(id);
      const drawn = mayVoidLedgerRow(await factsOf(id), nonHolder(me));
      const tried = await voidTransaction(id, 'VED bekor qildi', ctx(me), nonHolder(me)).then(
        () => 'voided',
        (err: { code?: string }) => err.code,
      );
      expect(tried, kind.name).toBe(drawn ? 'voided' : 'forbidden');
      expect((await rowOf(id)).voidedAt === null, `${kind.name} read back`).toBe(!drawn);
      // …and the kassa holder voids every one of them.
      if (!drawn) {
        await voidTransaction(id, 'buxgalter bekor qildi', ctx(me), { mayMoveTill: true });
        expect((await rowOf(id)).voidedAt).not.toBeNull();
      }
    });
  }
});

describe('(b-d) the refusal is decided in the UPDATE, not by the pre-read', () => {
  it('(b) a payment placed while the non-holder voids it: refused, placed, not voided', async () => {
    const clientId = await freshClient('RB');
    const payment = await addTransaction(
      { clientId, type: 'payment', amount: 40, currency: 'USD', txDate: DAY, method: 'cash' },
      ctx(me),
    );
    liveTx.push(payment.id);
    const outcome = await raceAgainst(
      'UPDATE client_transactions SET account_id = $1 WHERE id = $2',
      [tillId, payment.id],
      () => voidTransaction(payment.id, 'VED bekor qildi', ctx(me), nonHolder(me)),
      'client_transactions',
    );
    expect(outcome).toEqual({ ok: false, code: 'forbidden' });
    const row = await rowOf(payment.id);
    expect(row.accountId).toBe(tillId);
    expect(row.voidedAt).toBeNull();
  });

  it('(c) a cost placed into a till while a non-holder voids it: refused as a kassa cost', async () => {
    const entry = await addCostEntry(
      {
        scope: 'batch',
        batchId,
        costTypeId,
        amount: 50,
        currency: 'USD',
        costDate: DAY,
        allocationBasis: 'weight',
      },
      ctx(me),
    );
    liveCosts.push(entry.id);
    const outcome = await raceAgainst(
      'UPDATE cost_entries SET account_id = $1, account_amount = amount WHERE id = $2',
      [tillId, entry.id],
      () => voidCostEntry(entry.id, 'xato', ctx(me), { mayMoveTill: false }),
      'cost_entries',
    );
    expect(outcome).toEqual({ ok: false, code: 'kassa_cost_needs_finance' });
    const [row] = await db
      .select({ voidedAt: costEntries.voidedAt, accountId: costEntries.accountId })
      .from(costEntries)
      .where(eq(costEntries.id, entry.id));
    expect(row!.accountId).toBe(tillId);
    expect(row!.voidedAt).toBeNull();
  });

  it('(d) two voids of one row: the second answers already_voided and does not rewrite the first', async () => {
    const clientId = await freshClient('RD');
    const charge = await addTransaction({ clientId, type: 'charge', amount: 41, currency: 'USD', txDate: DAY }, ctx(me));
    liveTx.push(charge.id);
    const outcome = await raceAgainst(
      "UPDATE client_transactions SET voided_at = now(), voided_by = $1, void_reason = 'birinchi' WHERE id = $2",
      [me, charge.id],
      () => voidTransaction(charge.id, 'ikkinchi', ctx(me), { mayMoveTill: true }),
      'client_transactions',
    );
    expect(outcome).toEqual({ ok: false, code: 'already_voided' });
    const [row] = await db
      .select({ voidReason: clientTransactions.voidReason })
      .from(clientTransactions)
      .where(eq(clientTransactions.id, charge.id));
    expect(row!.voidReason).toBe('birinchi');
  });
});
