import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clientTransactions,
  clients,
  costEntries,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { isInternalLeg } from '../batches/internal';
import { rideMovementSql } from '../batches/riders';

/**
 * Where a client's cargo is, what it weighs, and which money belongs to it.
 *
 * The owner asked the same question from three screens — "mijozning yuki
 * qayerda, necha m³, necha kg, qancha pul" on the client card, "bu qarz qaysi
 * yukdan kelgan" in finance, "mening mijozlarim" for a sales manager — so it
 * is answered once here and rendered three ways.
 */

/** Cargo still ours: on a shelf, on a truck, or waiting to be handed over. */
export interface CargoLocation {
  warehouseId: string | null;
  warehouseCode: string | null;
  /** stock = on the shelf here, transit = on a truck, ready = waiting for pickup. */
  state: 'stock' | 'transit' | 'ready';
  boxCount: number;
  kg: number;
  m3: number;
}

/** One trip this client's cargo travelled on, with its money. */
export interface CargoTrip {
  batchId: string;
  batchCode: string;
  originCode: string | null;
  destCode: string | null;
  status: string;
  departedAt: Date | null;
  boxCount: number;
  kg: number;
  m3: number;
  /** Charged for this trip (active rows only). */
  chargedUsd: number;
  /** Of that, still unpaid after settling payments oldest-first. */
  owedUsd: number;
  /**
   * A truck that crossed no border (`isInternalLeg`). It is never priced —
   * the owner's C1a — so «narx qo'yilmagan» is not true of it and is not
   * printed; what CAN be missing on it is its own cost.
   */
  internal: boolean;
  /** Internal and departed with no live cost entry on it: the warning it gets. */
  costMissing: boolean;
}

export interface ClientCargo {
  locations: CargoLocation[];
  trips: CargoTrip[];
  totals: { boxCount: number; kg: number; m3: number };
  chargedUsd: number;
  paidUsd: number;
  balanceUsd: number;
  /** Debt that belongs to no trip (a manual charge). */
  unassignedOwedUsd: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * A box's weight and volume are the lot's, divided by the lot's box count —
 * boxes are not weighed one by one anywhere in this business, so every kg
 * figure in the app is this same average.
 */
const boxKg = sql<string>`coalesce(sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount}), 0)`;
const boxM3 = sql<string>`coalesce(sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount}), 0)`;

/** Which state bucket a box status belongs to, or null if it is no longer ours. */
const STATE_SQL = sql<'stock' | 'transit' | 'ready'>`CASE
  WHEN ${boxes.status} = 'in_transit' THEN 'transit'
  WHEN ${boxes.status} = 'ready_for_pickup' THEN 'ready'
  ELSE 'stock' END`;

export async function clientCargo(clientId: string): Promise<ClientCargo> {
  const dest = aliasedTable(warehouses, 'dest');

  const [locationRows, tripRows, ledger] = await Promise.all([
    // Still ours: everything that has not been issued, lost or voided.
    db
      .select({
        warehouseId: boxes.currentWarehouseId,
        warehouseCode: warehouses.code,
        state: STATE_SQL,
        boxCount: sql<number>`count(*)`,
        kg: boxKg,
        m3: boxM3,
      })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .leftJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
      .where(
        and(
          eq(receipts.clientId, clientId),
          inArray(boxes.status, [
            'in_stock',
            'planned',
            'loading',
            'in_transit',
            'ready_for_pickup',
          ]),
        ),
      )
      .groupBy(boxes.currentWarehouseId, warehouses.code, STATE_SQL),

    // Trips: what RODE is the ground truth (DECISIONS #121) — accepting a
    // box clears its batch pointer, so a live-pointer query would lose the
    // client's whole history the moment the cargo arrived. The money rule
    // (`rideMovementSql`): a carton scanned onto a truck and found back at
    // its origin did not travel on it (U17), one scanned off without a load
    // scan did, and the card must then say «narx qo'yilmagan» for it (U25).
    db
      .select({
        batchId: batches.id,
        batchCode: batches.code,
        originCode: warehouses.code,
        destCode: dest.code,
        originCountry: warehouses.country,
        destCountry: dest.country,
        status: batches.status,
        departedAt: batches.departedAt,
        boxCount: sql<number>`count(distinct ${boxes.id})`,
        kg: boxKg,
        m3: boxM3,
      })
      .from(boxMovements)
      .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .innerJoin(batches, eq(boxMovements.refId, batches.id))
      .leftJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
      .leftJoin(dest, eq(batches.destWarehouseId, dest.id))
      .where(
        and(
          eq(receipts.clientId, clientId),
          eq(boxMovements.refType, 'batch'),
          sql`${boxMovements.cause} IN ('batch_departed', 'undocumented_transfer')`,
          rideMovementSql('box_movements'),
          // An annulled box leaves the trip history's figures too.
          ne(boxes.status, 'void'),
        ),
      )
      .groupBy(
        batches.id,
        batches.code,
        warehouses.code,
        dest.code,
        warehouses.country,
        dest.country,
        batches.status,
        batches.departedAt,
      )
      .orderBy(desc(batches.departedAt)),

    db
      .select({
        id: clientTransactions.id,
        type: clientTransactions.type,
        amountUsd: clientTransactions.amountUsd,
        batchId: clientTransactions.batchId,
        txDate: clientTransactions.txDate,
        createdAt: clientTransactions.createdAt,
      })
      .from(clientTransactions)
      .where(and(eq(clientTransactions.clientId, clientId), isNull(clientTransactions.voidedAt)))
      .orderBy(asc(clientTransactions.txDate), asc(clientTransactions.createdAt)),
  ]);

  // Settle payments against the OLDEST charge first — the same rule the
  // receivables ageing report uses, so the two screens can never disagree
  // about which invoice is still open.
  const charges = ledger
    .filter((row) => row.type === 'charge')
    .map((row) => ({ batchId: row.batchId, owed: Number(row.amountUsd) }));
  const chargedUsd = charges.reduce((a, c) => a + c.owed, 0);
  // Net of what was handed back (R6a): a refund puts money the client paid
  // back into their hands, so it no longer settles anything.
  const paidUsd = ledger.reduce(
    (a, row) =>
      a + (row.type === 'payment' ? Number(row.amountUsd) : row.type === 'refund' ? -Number(row.amountUsd) : 0),
    0,
  );

  let unapplied = paidUsd;
  for (const charge of charges) {
    if (unapplied <= 0) break;
    const applied = Math.min(unapplied, charge.owed);
    charge.owed -= applied;
    unapplied -= applied;
  }

  const chargedByBatch = new Map<string, number>();
  const owedByBatch = new Map<string, number>();
  let unassignedOwedUsd = 0;
  for (const charge of charges) {
    if (!charge.batchId) {
      unassignedOwedUsd += charge.owed;
      continue;
    }
    owedByBatch.set(charge.batchId, (owedByBatch.get(charge.batchId) ?? 0) + charge.owed);
  }
  for (const row of ledger) {
    if (row.type !== 'charge' || !row.batchId) continue;
    chargedByBatch.set(row.batchId, (chargedByBatch.get(row.batchId) ?? 0) + Number(row.amountUsd));
  }

  const locations = locationRows
    .map((row) => ({
      warehouseId: row.warehouseId,
      warehouseCode: row.warehouseCode,
      state: row.state,
      boxCount: Number(row.boxCount),
      kg: round1(Number(row.kg)),
      m3: round3(Number(row.m3)),
    }))
    .sort((a, b) => (a.warehouseCode ?? '').localeCompare(b.warehouseCode ?? ''));

  // Which internal trips carry no cost at all — ONE grouped read over the
  // client's trips, never a query per trip (#432).
  const internalIds = tripRows
    .filter((row) => isInternalLeg(row.originCountry, row.destCountry))
    .map((row) => row.batchId);
  const costed = new Set(
    internalIds.length
      ? (
          await db
            .selectDistinct({ batchId: costEntries.batchId })
            .from(costEntries)
            .where(and(inArray(costEntries.batchId, internalIds), isNull(costEntries.voidedAt)))
        ).map((row) => row.batchId)
      : [],
  );

  const trips = tripRows.map((row) => ({
    batchId: row.batchId,
    batchCode: row.batchCode,
    originCode: row.originCode,
    destCode: row.destCode,
    status: row.status,
    departedAt: row.departedAt,
    boxCount: Number(row.boxCount),
    kg: round1(Number(row.kg)),
    m3: round3(Number(row.m3)),
    chargedUsd: cents(chargedByBatch.get(row.batchId) ?? 0),
    owedUsd: cents(owedByBatch.get(row.batchId) ?? 0),
    internal: isInternalLeg(row.originCountry, row.destCountry),
    costMissing:
      isInternalLeg(row.originCountry, row.destCountry) &&
      row.departedAt !== null &&
      !costed.has(row.batchId),
  }));

  return {
    locations,
    trips,
    totals: {
      boxCount: locations.reduce((a, r) => a + r.boxCount, 0),
      kg: round1(locations.reduce((a, r) => a + r.kg, 0)),
      m3: round3(locations.reduce((a, r) => a + r.m3, 0)),
    },
    chargedUsd: cents(chargedUsd),
    paidUsd: cents(paidUsd),
    balanceUsd: cents(chargedUsd - paidUsd),
    unassignedOwedUsd: cents(unassignedOwedUsd),
  };
}

export interface ManagedClient {
  clientId: string;
  clientCode: string;
  name: string;
  boxCount: number;
  kg: number;
  m3: number;
  balanceUsd: number;
  nextActionAt: string | null;
  lastReceiptAt: string | null;
}

/**
 * The "my clients" list (owner: "mening mijozlarim — yuki qayerda, m³, kg,
 * pul"). One row per client with everything a sales manager checks before
 * picking up the phone; `managerId` undefined means every client, which is
 * what the owner and the logist see.
 */
export async function managedClients(managerId?: string): Promise<ManagedClient[]> {
  const rows = await db
    .select({
      clientId: clients.id,
      clientCode: clients.clientCode,
      name: clients.name,
      nextActionAt: clients.nextActionAt,
      boxCount: sql<number>`(
        SELECT count(*) FROM boxes b
        JOIN receipt_lots rl ON rl.id = b.lot_id
        JOIN receipts r ON r.id = rl.receipt_id
        WHERE r.client_id = ${clients}.id
          AND b.status IN ('in_stock','planned','loading','in_transit','ready_for_pickup')
      )`,
      kg: sql<string>`coalesce((
        SELECT sum(rl.total_weight_kg / rl.box_count) FROM boxes b
        JOIN receipt_lots rl ON rl.id = b.lot_id
        JOIN receipts r ON r.id = rl.receipt_id
        WHERE r.client_id = ${clients}.id
          AND b.status IN ('in_stock','planned','loading','in_transit','ready_for_pickup')
      ), 0)`,
      m3: sql<string>`coalesce((
        SELECT sum(rl.total_volume_m3 / rl.box_count) FROM boxes b
        JOIN receipt_lots rl ON rl.id = b.lot_id
        JOIN receipts r ON r.id = rl.receipt_id
        WHERE r.client_id = ${clients}.id
          AND b.status IN ('in_stock','planned','loading','in_transit','ready_for_pickup')
      ), 0)`,
      balanceUsd: sql<string>`coalesce((
        SELECT sum(CASE WHEN ct.type = 'payment' THEN -ct.amount_usd ELSE ct.amount_usd END)
        FROM client_transactions ct
        WHERE ct.client_id = ${clients}.id AND ct.voided_at IS NULL
      ), 0)`,
      lastReceiptAt: sql<string | null>`(
        SELECT max(r.received_at) FROM receipts r WHERE r.client_id = ${clients}.id
      )`,
    })
    .from(clients)
    .where(
      managerId
        ? and(eq(clients.active, true), eq(clients.salesManagerId, managerId))
        : eq(clients.active, true),
    )
    .orderBy(asc(clients.clientCode));

  return rows.map((row) => ({
    clientId: row.clientId,
    clientCode: row.clientCode,
    name: row.name,
    boxCount: Number(row.boxCount),
    kg: round1(Number(row.kg)),
    m3: round3(Number(row.m3)),
    balanceUsd: cents(Number(row.balanceUsd)),
    nextActionAt: row.nextActionAt,
    lastReceiptAt: row.lastReceiptAt,
  }));
}
