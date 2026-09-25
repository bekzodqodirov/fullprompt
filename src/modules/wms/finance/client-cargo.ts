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
import { settlesUsd } from './ledger-kinds';
import { rideMovementSql } from '../batches/riders';
import { offTruckPrices } from './off-truck';
import { uncoveredTripsOn } from './unpriced';

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
  /**
   * Some carton of this client that rode this trip has no price, by the ONE
   * rule (`uncoveredTripsOn`, 0104). Replaces the chip's old «nothing charged
   * on this truck» test (U36 S3): a prixod split over two trucks and priced
   * once is priced on both, and a found-back carton riding B leaves B
   * unpriced even when A carries a price.
   */
  unpriced: boolean;
  /** Cartons that left this truck after its price (Q21 / Q2), or null. */
  dropped: { boxes: number; to: string[]; cause: 'short_loaded' | 'found_back' | 'mixed' | null } | null;
  /**
   * The truck crosses a border (or one end's country is unknown — an unknown
   * border is treated as crossed, `batches/internal.ts`). The card form lists
   * these first and warns when a local leg is picked for China cargo (Q1).
   */
  crossesBorder: boolean;
}

/**
 * A charge on a truck the client's cargo did not ride (0104): still loading
 * there (`loading` — the live pointer, the price may be right), or nothing of
 * the client on it at all (`no_cargo`, Q21). Each charge lands in exactly one
 * of trips / offTrip / unassigned, so Σ trips.owed + Σ offTrip.owed +
 * unassignedOwed is the owed part of the balance.
 */
export interface CargoOffTrip {
  batchId: string;
  batchCode: string;
  status: string;
  chargedUsd: number;
  owedUsd: number;
  reason: 'loading' | 'no_cargo';
  /** Codes of the trucks the client's dropped cartons ride now. */
  droppedTo: string[];
  crossesBorder: boolean;
}

export interface ClientCargo {
  locations: CargoLocation[];
  trips: CargoTrip[];
  offTrip: CargoOffTrip[];
  totals: { boxCount: number; kg: number; m3: number };
  chargedUsd: number;
  paidUsd: number;
  balanceUsd: number;
  /** Debt that belongs to no trip (a manual charge). */
  unassignedOwedUsd: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** `sameCountryLegSql`'s rule for two countries in hand: an empty one is a crossing. */
const crosses = (origin: string | null | undefined, dest: string | null | undefined) => {
  const a = (origin ?? '').trim().toUpperCase();
  const b = (dest ?? '').trim().toUpperCase();
  return a === '' || a !== b;
};
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
  // back into their hands, so it no longer settles anything. A kurs farqi row
  // (0103) settles by its own dollars, or the trips keep showing the residue
  // after the account closed.
  const paidUsd = ledger.reduce((a, row) => a + settlesUsd({ type: row.type, amountUsd: Number(row.amountUsd) }), 0);

  let unapplied = paidUsd;
  for (const charge of charges) {
    if (unapplied <= 0) break;
    const applied = Math.min(unapplied, charge.owed);
    charge.owed -= applied;
    unapplied -= applied;
  }

  // A charge's truck is a trip (the cargo rode it), an off-trip truck (0104:
  // still loading, or the cargo never rode it), or none at all — exactly one,
  // so the three owed parts add up to the balance's owed part.
  const tripIds = new Set(tripRows.map((row) => row.batchId));
  const chargedByBatch = new Map<string, number>();
  const owedByBatch = new Map<string, number>();
  const owedOffTrip = new Map<string, number>();
  let unassignedOwedUsd = 0;
  for (const charge of charges) {
    if (!charge.batchId) {
      unassignedOwedUsd += charge.owed;
      continue;
    }
    const into = tripIds.has(charge.batchId) ? owedByBatch : owedOffTrip;
    into.set(charge.batchId, (into.get(charge.batchId) ?? 0) + charge.owed);
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
  const offIds = [...owedOffTrip.keys()];
  const [costedRows, unpricedTrips, offTruck, offRows] = await Promise.all([
    internalIds.length
      ? db
          .selectDistinct({ batchId: costEntries.batchId })
          .from(costEntries)
          .where(and(inArray(costEntries.batchId, internalIds), isNull(costEntries.voidedAt)))
      : Promise.resolve([] as { batchId: string | null }[]),
    // The trip chip and the off-truck warnings: the ONE rule each (0104),
    // one read each for the whole card (#432).
    uncoveredTripsOn(db, { kind: 'client', clientId }),
    offTruckPrices(db, { clientIds: [clientId] }),
    offIds.length
      ? db
          .select({
            batchId: batches.id,
            batchCode: batches.code,
            status: batches.status,
            originCountry: sql<string | null>`(SELECT w.country FROM warehouses w WHERE w.id = ${batches}.origin_warehouse_id)`,
            destCountry: sql<string | null>`(SELECT w.country FROM warehouses w WHERE w.id = ${batches}.dest_warehouse_id)`,
            // The live pointer: this client's cargo is planned or loading
            // there, so the price may be right and the truck has not left.
            loading: sql<boolean>`EXISTS (
              SELECT 1 FROM boxes pb
                JOIN receipt_lots pl ON pl.id = pb.lot_id
                JOIN receipts pr ON pr.id = pl.receipt_id
               WHERE pb.current_batch_id = ${batches}.id AND pb.status IN ('planned', 'loading')
                 AND pr.client_id = ${clientId}::uuid)`,
          })
          .from(batches)
          .where(inArray(batches.id, offIds))
      : Promise.resolve(
          [] as {
            batchId: string;
            batchCode: string;
            status: string;
            originCountry: string | null;
            destCountry: string | null;
            loading: boolean;
          }[],
        ),
  ]);
  const costed = new Set(costedRows.map((row) => row.batchId));
  const offTruckByBatch = new Map(offTruck.map((row) => [row.batchId, row]));

  const offTrip: CargoOffTrip[] = offRows
    .map((row) => ({
      batchId: row.batchId,
      batchCode: row.batchCode,
      status: row.status,
      chargedUsd: cents(chargedByBatch.get(row.batchId) ?? 0),
      owedUsd: cents(owedOffTrip.get(row.batchId) ?? 0),
      reason: row.loading ? ('loading' as const) : ('no_cargo' as const),
      droppedTo: (offTruckByBatch.get(row.batchId)?.droppedTo ?? []).map((d) => d.code),
      crossesBorder: crosses(row.originCountry, row.destCountry),
    }))
    .sort((a, b) => a.batchCode.localeCompare(b.batchCode));

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
    unpriced: unpricedTrips.has(row.batchId),
    crossesBorder: crosses(row.originCountry, row.destCountry),
    dropped: (() => {
      const off = offTruckByBatch.get(row.batchId);
      if (!off || off.kind !== 'partial') return null;
      return { boxes: off.droppedBoxIds.length, to: off.droppedTo.map((d) => d.code), cause: off.dropCause };
    })(),
  }));

  return {
    locations,
    trips,
    offTrip,
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
