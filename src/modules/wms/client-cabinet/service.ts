import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../platform/db/client';
import {
  attachments,
  batches,
  boxes,
  clients,
  clientTelegramLinks,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { clientBalanceUsd, clientLedger } from '../finance/service';
import { etaWindow, scheduleEstimate } from '../tracking/eta';
import {
  cargoStage,
  isMovingStage,
  stageIndex,
  type CargoStage,
  type StageBatch,
} from './stages';

/**
 * Telegram client cabinet (Phase 2.2, owner's spec): the client sees cargo
 * status, photos and debt — read-only views over existing data, keyed by the
 * chat's linked client(s). All queries verify ownership by clientId.
 */

/**
 * Phone identity check (owner's incident: a cabinet link minted for client A
 * was sent to person B, who got linked to A's data). Numbers are compared as
 * digit strings by their last 9 digits, so +998 90 175-78-00, 998901757800
 * and 901757800 all match each other, and country-code formatting never
 * causes a false mismatch.
 */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function phonesMatch(a: string, b: string): boolean {
  const da = phoneDigits(a);
  const db2 = phoneDigits(b);
  if (da.length < 7 || db2.length < 7) return false;
  const n = Math.min(9, da.length, db2.length);
  return da.slice(-n) === db2.slice(-n);
}

/** Does the shared phone belong to this client (any of its registered numbers)? */
export function phoneBelongsToClient(shared: string, clientPhones: unknown): boolean {
  if (!Array.isArray(clientPhones)) return false;
  return clientPhones.some((p) => typeof p === 'string' && phonesMatch(shared, p));
}

/** Do two clients share at least one phone number (same real person)? */
export function phonesOverlap(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a)) return false;
  return a.some((p) => typeof p === 'string' && phoneBelongsToClient(p, b));
}

/**
 * All active clients registered under this phone — the owner's reality:
 * one person often holds 2–4 marking codes (777, 555, 444…).
 */
export async function activeClientsByPhone(phone: string) {
  const rows = await db.select().from(clients).where(eq(clients.active, true));
  return rows.filter((c) => phoneBelongsToClient(phone, c.phones));
}

/** Clients represented by a Telegram chat (a broker chat may hold several). */
export async function clientsForChat(chatId: bigint) {
  return db
    .select({ client: clients })
    .from(clientTelegramLinks)
    .innerJoin(clients, eq(clientTelegramLinks.clientId, clients.id))
    .where(
      and(
        eq(clientTelegramLinks.telegramChatId, chatId),
        eq(clientTelegramLinks.status, 'linked'),
      ),
    )
    // Ordered because the answer is used first-match, not as a set: `chatLocale`
    // takes the first client with a language on file and renders the whole
    // reply in it. A broker chat holding two clients who chose differently
    // would otherwise be answered in whichever language Postgres happened to
    // return first — the same reply switching languages between two presses,
    // with nothing to explain it. The OLDEST link wins: the client the chat
    // was opened for.
    .orderBy(asc(clientTelegramLinks.linkedAt), asc(clients.clientCode))
    .then((rows) => rows.map((r) => r.client));
}

export interface CargoEta {
  fromIso: string;
  toIso: string;
  /** The place that date is about — «Qashqarga 14-16 avg.» cannot be misread. */
  toPlace: string;
}

export interface CargoGroup {
  stage: CargoStage;
  n: number;
  /**
   * Only ever on a moving stage, and only when the schedule can answer.
   *
   * A date beside «skladda» would be a promise about a truck that has not
   * left; a date on a truck whose route we do not know would be invented.
   */
  eta: CargoEta | null;
}

export interface CabinetLot {
  lotId: string;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  /**
   * Where this lot's boxes are on the customer's ladder, biggest group first.
   *
   * It replaced a `statuses` map — the raw box status, which is warehouse
   * vocabulary («planned», «in_stock») and answers a question the customer did
   * not ask. The owner's ladder («htoyda qabul → … → olib ketdingiz») is one
   * derivation away from the same rows, and now both the Mini App and the bot
   * message read the SAME one, so a customer cannot be told two different
   * things about the same carton on two screens.
   */
  groups: CargoGroup[];
  total: number;
  /**
   * Where the boxes physically are, by NAME — «Kashgar», not «KA».
   *
   * It used to print the warehouse CODE, which is staff jargon on the one
   * screen in this system a customer opens, and the owner asked for this app
   * to be «juda tushunarli». The name still earns its line once the cargo is
   * ready: which of Tashkent 1, Tashkent 2 or Andijan they drive to is the
   * only thing the rung's wording cannot say.
   */
  warehousePlaces: string[];
  hasPhotos: boolean;
  /**
   * The client's own cargo in the units they think in (owner: "kubi kilosi
   * soni rasimi hammasini to'liq ko'rsa").
   *
   * Per BOX figures are the lot average — `total / box_count` — because
   * nothing in this business weighs a box on its own; the house rule, and the
   * same expression six other screens already use. These are the client's
   * REMAINING boxes, so a lot half-loaded onto a truck reports the half that
   * is still theirs to wait for, not the original consignment.
   */
  weightKg: number;
  volumeM3: number;
  perBoxKg: number;
  perBoxM3: number;
  photoCount: number;
}

const ACTIVE_STATUSES = ['in_stock', 'planned', 'loading', 'in_transit', 'ready_for_pickup'];

interface CabinetTruck {
  stage: StageBatch;
  eta: CargoEta | null;
}

/**
 * The trucks a client's cargo is riding: what rung they put it on, and when
 * the schedule says it lands.
 *
 * What this deliberately does NOT read is the batch CODE, the plate or the
 * driver. A truck's identity is the company's business and twenty other
 * customers' delivery dates; the customer is told a stage and a date.
 */
async function trucksFor(batchIds: string[]): Promise<Map<string, CabinetTruck>> {
  const out = new Map<string, CabinetTruck>();
  if (batchIds.length === 0) return out;
  const origin = alias(warehouses, 'eta_origin');
  const dest = alias(warehouses, 'eta_dest');
  const rows = await db
    .select({
      id: batches.id,
      status: batches.status,
      departedAt: batches.departedAt,
      checkpoint: batches.trackingCheckpoint,
      originCode: origin.code,
      originCountry: origin.country,
      destCode: dest.code,
      destCountry: dest.country,
      destName: dest.name,
    })
    .from(batches)
    .innerJoin(origin, eq(batches.originWarehouseId, origin.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(inArray(batches.id, batchIds));

  const now = new Date();
  for (const r of rows) {
    const schedule = scheduleEstimate(r.originCode, r.destCode, r.departedAt, r.checkpoint, now);
    const window = schedule ? etaWindow(schedule.est, now) : null;
    out.set(r.id, {
      stage: {
        originCountry: r.originCountry,
        destCountry: r.destCountry,
        status: r.status,
        checkpointKey: (r.checkpoint as { key?: string } | null)?.key ?? null,
      },
      eta: window ? { ...window, toPlace: r.destName } : null,
    });
  }
  return out;
}

/** The client's active (not yet issued) cargo, one entry per lot. */
export async function cargoOverview(clientId: string): Promise<CabinetLot[]> {
  const rows = await db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      status: boxes.status,
      warehousePlace: warehouses.name,
      // The ladder is derived from WHERE the box stands, never from a list of
      // warehouse codes written into the code: «qirgiz chegara sklat» is a
      // `hub` row today and stays one when he opens a second.
      warehouseCountry: warehouses.country,
      warehouseType: warehouses.type,
      /*
       * The live pointer, and the ONE place it is the right question.
       *
       * `current_batch_id` is NULLed at landing (#440), which is exactly why
       * every historical read goes through `box_movements` — but this column
       * is asked only about boxes that are STILL `in_transit`, and for those
       * it is the truck they are on right now.
       */
      batchId: boxes.currentBatchId,
      n: sql<number>`count(*)`,
      // A box has no weight of its own — the lot's total divided by its box
      // count is what every other screen means by "per box" (#152 area,
      // finance/client-cargo.ts). Guarded against a zero count.
      perBoxKg: sql<string>`${receiptLots.totalWeightKg} / nullif(${receiptLots.boxCount}, 0)`,
      perBoxM3: sql<string>`${receiptLots.totalVolumeM3} / nullif(${receiptLots.boxCount}, 0)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .where(and(eq(receipts.clientId, clientId), inArray(boxes.status, ACTIVE_STATUSES)))
    .groupBy(
      receiptLots.id,
      receiptLots.letter,
      receiptLots.productNameZh,
      receiptLots.productNameRu,
      receiptLots.totalWeightKg,
      receiptLots.boxCount,
      receiptLots.totalVolumeM3,
      boxes.status,
      warehouses.name,
      warehouses.country,
      warehouses.type,
      boxes.currentBatchId,
    )
    .orderBy(asc(receiptLots.letter));

  // ONE query for every truck this client's cargo is riding, not one per row
  // (#432): a client with cargo on three lorries pays for three joins, not for
  // three hundred.
  const trucks = await trucksFor([
    ...new Set(rows.map((r) => r.batchId).filter((id): id is string => !!id)),
  ]);

  const byLot = new Map<string, CabinetLot>();
  const stageCounts = new Map<string, Map<CargoStage, { n: number; eta: CargoEta | null }>>();
  for (const r of rows) {
    let lot = byLot.get(r.lotId);
    if (!lot) {
      lot = {
        lotId: r.lotId,
        letter: r.letter,
        productNameZh: r.productNameZh,
        productNameRu: r.productNameRu,
        groups: [],
        total: 0,
        warehousePlaces: [],
        hasPhotos: false,
        weightKg: 0,
        volumeM3: 0,
        perBoxKg: Number(r.perBoxKg ?? 0),
        perBoxM3: Number(r.perBoxM3 ?? 0),
        photoCount: 0,
      };
      byLot.set(r.lotId, lot);
      stageCounts.set(r.lotId, new Map());
    }
    const truck = r.batchId ? (trucks.get(r.batchId) ?? null) : null;
    const stage = cargoStage(
      r.status,
      { country: r.warehouseCountry, type: r.warehouseType },
      truck?.stage ?? null,
    );
    const counts = stageCounts.get(r.lotId)!;
    const prev = counts.get(stage);
    // Two trucks landing on the same rung keep the LATER date: the group is
    // not complete until the last of it arrives.
    const eta = isMovingStage(stage) ? (truck?.eta ?? null) : null;
    const keep =
      !prev?.eta || (eta && eta.toIso > prev.eta.toIso) ? (eta ?? prev?.eta ?? null) : prev.eta;
    counts.set(stage, { n: (prev?.n ?? 0) + Number(r.n), eta: keep });
    lot.total += Number(r.n);
    lot.weightKg += Number(r.n) * Number(r.perBoxKg ?? 0);
    lot.volumeM3 += Number(r.n) * Number(r.perBoxM3 ?? 0);
    if (r.warehousePlace && !lot.warehousePlaces.includes(r.warehousePlace)) {
      lot.warehousePlaces.push(r.warehousePlace);
    }
  }
  const lots = [...byLot.values()];
  for (const lot of lots) {
    // Biggest group first: the ladder is drawn for the bulk of the cargo and
    // the rest is named under it, so the order IS the screen.
    lot.groups = [...(stageCounts.get(lot.lotId) ?? new Map())]
      .map(([stage, v]) => ({ stage, n: v.n, eta: v.eta }))
      .sort((a, b) => b.n - a.n || stageIndex(a.stage) - stageIndex(b.stage));
  }
  if (lots.length) {
    const withPhotos = await db
      .select({ entityId: attachments.entityId, n: sql<number>`count(*)` })
      .from(attachments)
      .where(
        and(
          eq(attachments.entityType, 'receipt_lot'),
          inArray(attachments.entityId, lots.map((l) => l.lotId)),
          eq(attachments.kind, 'photo'),
        ),
      )
      .groupBy(attachments.entityId);
    const counts = new Map(withPhotos.map((r) => [r.entityId, Number(r.n)]));
    for (const lot of lots) {
      lot.photoCount = counts.get(lot.lotId) ?? 0;
      lot.hasPhotos = lot.photoCount > 0;
    }
    // Rounded once, here, so every reader shows the same number.
    for (const lot of lots) {
      lot.weightKg = Math.round(lot.weightKg * 100) / 100;
      lot.volumeM3 = Math.round(lot.volumeM3 * 1000) / 1000;
    }
  }
  return lots;
}

/**
 * Photo storage keys of one lot — ONLY if the lot belongs to the client
 * (the callback data is attacker-controllable, so ownership is re-checked).
 */
export async function lotPhotoKeys(lotId: string, clientIds: string[], limit = 10) {
  if (clientIds.length === 0) return [];
  const owner = await db
    .select({ clientId: receipts.clientId })
    .from(receiptLots)
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(eq(receiptLots.id, lotId));
  if (!owner[0]?.clientId || !clientIds.includes(owner[0].clientId)) return [];
  return db
    .select({
      storageKey: attachments.storageKey,
      thumb800Key: attachments.thumb800Key,
      contentType: attachments.contentType,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'receipt_lot'),
        eq(attachments.entityId, lotId),
        eq(attachments.kind, 'photo'),
      ),
    )
    .orderBy(asc(attachments.createdAt))
    .limit(limit);
}

export interface DebtSummary {
  balanceUsd: number;
  recent: {
    type: string;
    amount: number;
    currency: string;
    amountUsd: number;
    txDate: string;
    voided: boolean;
  }[];
}

/** Debt + a few recent ledger rows for the cabinet's balance view. */
export async function debtSummary(clientId: string): Promise<DebtSummary> {
  const [balanceUsd, ledger] = await Promise.all([
    clientBalanceUsd(clientId),
    clientLedger(clientId),
  ]);
  return {
    balanceUsd,
    recent: ledger.slice(0, 5).map(({ tx }) => ({
      type: tx.type,
      amount: Number(tx.amount),
      currency: tx.currency,
      amountUsd: Number(tx.amountUsd),
      txDate: tx.txDate,
      voided: tx.voidedAt !== null,
    })),
  };
}

/** Recently issued cargo (history view). */
export async function issuedHistory(clientId: string, limit = 10) {
  return db
    .select({
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      n: sql<number>`count(*)`,
      lastAt: sql<string>`max(${boxes.updatedAt})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(and(eq(receipts.clientId, clientId), eq(boxes.status, 'issued')))
    .groupBy(receiptLots.id, receiptLots.letter, receiptLots.productNameZh, receiptLots.productNameRu)
    .orderBy(desc(sql`max(${boxes.updatedAt})`))
    .limit(limit);
}
