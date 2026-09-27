import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../platform/db/client';
import {
  attachments,
  batches,
  boxes,
  boxMovements,
  clients,
  clientTelegramLinks,
  clientTransactions,
  handovers,
  receiptLots,
  receipts,
  tgAccounts,
  users,
  warehouses,
} from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { reachableAt } from '../crm/site-assign-rules';
import { roundKg, roundM3, shareOf } from '../../platform/telegram/format';
import { telegramPhoneUrl } from '../../platform/telegram/map-link';
import { chatLocaleFor } from '../../platform/telegram/cabinet-locale';
import { ARRIVED_ON_A_TRUCK } from '../documents/arrivals';
import { arrivalCleared } from '../notices/arrival-text';
import { clientBalanceUsd, clientLedger } from '../finance/service';
import { etaWindow, scheduleEstimate } from '../tracking/eta';
import { journeyFromEvents, type JourneyStep } from './journey';
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
 *
 * Prefiltered in SQL (round 108): this used to fetch and hydrate the WHOLE
 * client book per call, and the chat surfaces call it per phone per refresh
 * tick — at ~1,700 clients that was thousands of rows of pure Node work a
 * second on the one process that serves everything. The SQL half compares
 * the last SEVEN digits, a strict superset of `phonesMatch`'s last-nine
 * rule (equal last-n, n ≥ 7, implies equal last-7 — never a false miss),
 * and the JS filter stays as the exact arbiter over the handful that
 * survive. Under seven digits the JS rule matches nothing, so answer that
 * without a query.
 */
export async function activeClientsByPhone(phone: string) {
  const digits = phoneDigits(phone);
  if (digits.length < 7) return [];
  const last7 = digits.slice(-7);
  const rows = await db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.active, true),
        sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${clients}."phones") AS ph(p)
          WHERE right(regexp_replace(ph.p, '[^0-9]', '', 'g'), 7) = ${last7}
        )`,
      ),
    );
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

/**
 * Every code of the SAME person joins a chat that already holds one of them
 * (the owner, 2026-09-26: «meni nomerimda 4 5 ta kod bolsa hammasini emas
 * faqat 1 tasini korsatyabti»).
 *
 * `linkAllClientsForPhone` does this at the contact step and
 * `autoLinkClientToVerifiedChats` when a code is saved — but a chat linked by
 * a staff CODE (`/start <code>`) links exactly one client, and a code whose
 * phone was typed after the chat was verified was never saved again. Both
 * left the person's other codes outside their own cabinet for ever. This is
 * the same sibling rule (a shared phone = the same person, round 32), asked
 * when the cabinet is opened, so it heals whatever door linked the chat.
 *
 * A code that has ANY row for this chat — revoked included — is left alone:
 * a person took it away on purpose and a sweep must not hand it back.
 */
export async function linkPhoneSiblings(chatId: bigint): Promise<number> {
  const linked = await clientsForChat(chatId);
  if (linked.length === 0) return 0;
  const touched = new Set(
    (
      await db
        .select({ clientId: clientTelegramLinks.clientId })
        .from(clientTelegramLinks)
        .where(eq(clientTelegramLinks.telegramChatId, chatId))
    ).map((r) => r.clientId),
  );
  const phones = new Set<string>();
  for (const c of linked) {
    if (Array.isArray(c.phones)) {
      for (const p of c.phones) if (typeof p === 'string' && p.trim()) phones.add(p.trim());
    }
  }
  let added = 0;
  // The language the PERSON chose, read once and only when a code actually
  // joins: a sibling with no language of its own would otherwise answer in the
  // Russian fallback to somebody who picked Uzbek (round C, judge CX-7).
  let chatLocale: string | null | undefined;
  // Bounded: a broker chat holds many people's codes, and each phone is one
  // query. Ten covers every person the owner has described.
  for (const phone of [...phones].slice(0, 10)) {
    for (const sibling of await activeClientsByPhone(phone)) {
      if (touched.has(sibling.id)) continue;
      touched.add(sibling.id);
      await db.insert(clientTelegramLinks).values({
        clientId: sibling.id,
        telegramChatId: chatId,
        status: 'linked',
        linkedAt: new Date(),
        createdBy: null,
      });
      added += 1;
      if (sibling.locale === null) {
        if (chatLocale === undefined) chatLocale = await chatLocaleFor(chatId);
        // Only onto a NULL: a code whose own language somebody set keeps it.
        if (chatLocale) {
          await db
            .update(clients)
            .set({ locale: chatLocale })
            .where(and(eq(clients.id, sibling.id), isNull(clients.locale)));
        }
      }
    }
  }
  return added;
}

export interface CargoTransit {
  /** The road's two ends by NAME — «Yiwu → Kashgar», never a truck's code. */
  fromPlace: string;
  toPlace: string;
  /**
   * How much of the road the schedule says is behind — 0..1, the map
   * engine's own figure. The owner's ask verbatim: «yolni qanchasini bosib
   * otganini korsatadgan … bolishi kerak».
   */
  progress: number;
  /** Null once the schedule is spent — no honest date left to print. */
  etaFromIso: string | null;
  etaToIso: string | null;
}

export interface CargoGroup {
  stage: CargoStage;
  n: number;
  /**
   * Only ever on a moving stage, and only when a route exists.
   *
   * A road bar beside «skladda» would be a promise about a truck that has
   * not left; one on a truck whose route we do not know would be invented.
   */
  transit: CargoTransit | null;
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
  /**
   * What happened and WHEN, oldest first (`journey.ts`) — derived from the
   * lot's own `box_movements`, which have carried these timestamps since M2;
   * only the screen was missing them.
   */
  journey: JourneyStep[];
  total: number;
  /**
   * Of this lot's READY boxes, how many are cleared by the push's own rule —
   * the ready card's ✅ / ⏳ split. The rest wait on a declaration.
   */
  readyCleared: number;
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
  transit: CargoTransit | null;
  /** When the truck was first known to be in Uzbekistan (pin or arrival). */
  inUzAt: Date | null;
  customsClearedAt: Date | null;
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
      customsClearedAt: batches.customsClearedAt,
      arrivedAt: batches.arrivedAt,
      originCode: origin.code,
      originCountry: origin.country,
      originName: origin.name,
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
    const cp = r.checkpoint as { key?: string; at?: string } | null;
    const schedule = scheduleEstimate(r.originCode, r.destCode, r.departedAt, r.checkpoint, now);
    const window = schedule ? etaWindow(schedule.est, now) : null;
    out.set(r.id, {
      stage: {
        originCountry: r.originCountry,
        destCountry: r.destCountry,
        status: r.status,
        checkpointKey: cp?.key ?? null,
        customsCleared: r.customsClearedAt !== null,
      },
      transit: schedule
        ? {
            fromPlace: r.originName,
            toPlace: r.destName,
            progress: Math.min(1, schedule.est.progress),
            etaFromIso: window?.fromIso ?? null,
            etaToIso: window?.toIso ?? null,
          }
        : null,
      // A truck that ends in China (Yiwu → Kashgar) never enters Uzbekistan,
      // whatever its `arrived_at` says — the rule `truckStage` states. Without
      // it a lot waiting at the hub after an internal leg read «O'zbekistonga
      // kirdi», dated the day it reached Kashgar (round C review, second pass).
      inUzAt:
        r.destCountry === 'CN'
          ? null
          : cp?.key === 'in_uz' && cp.at
            ? new Date(cp.at)
            : (r.arrivedAt ?? null),
      customsClearedAt: r.customsClearedAt,
    });
  }
  return out;
}

/**
 * The dated history of each lot, in ONE query for the whole cabinet (#432).
 *
 * The rows have existed since M2 — every scan, every departure, every landing
 * is a `box_movements` row with a timestamp — so «qachon nima bo'lgan» is a
 * read, not a schema change. Causes are filtered in SQL: a box accumulates
 * plenty of movements (plans, crates, inventory) that say nothing a customer
 * asked about.
 */
async function lotJourneys(
  lotIds: string[],
  lotTruck: Map<string, CabinetTruck | null>,
): Promise<Map<string, JourneyStep[]>> {
  const out = new Map<string, JourneyStep[]>();
  if (lotIds.length === 0) return out;
  const to = alias(warehouses, 'jrn_to');
  const rows = await db
    .select({
      lotId: boxes.lotId,
      cause: boxMovements.cause,
      at: boxMovements.createdAt,
      // The prixod's REAL day (0112, Q9 b): the receipt movement is stamped
      // when the office TYPED it, which for a back-dated prixod is days late.
      // A typed column, not a raw CASE — raw timestamps come back as text (#923).
      receivedAt: receipts.receivedAt,
      toStatus: boxMovements.toStatus,
      toCountry: to.country,
      toType: to.type,
    })
    .from(boxMovements)
    .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(to, eq(boxMovements.toWarehouseId, to.id))
    .where(
      and(
        inArray(boxes.lotId, lotIds),
        inArray(boxMovements.cause, [
          'receipt',
          'batch_departed',
          'unload_scan',
          'undocumented_transfer',
          'found_here',
          'receipt_moved',
        ]),
      ),
    );

  const byLot = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byLot.has(r.lotId)) byLot.set(r.lotId, []);
    byLot.get(r.lotId)!.push(r);
  }
  for (const lotId of lotIds) {
    const truck = lotTruck.get(lotId) ?? null;
    out.set(
      lotId,
      journeyFromEvents(
        (byLot.get(lotId) ?? []).map((r) => ({
          cause: r.cause,
          at: r.cause === 'receipt' ? r.receivedAt : r.at,
          toStatus: r.toStatus,
          toCountry: r.toCountry,
          toType: r.toType,
        })),
        truck ? { inUzAt: truck.inUzAt, customsClearedAt: truck.customsClearedAt } : null,
      ),
    );
  }
  return out;
}

/**
 * The truck each LANDED box of a client came off, counted per lot (round C
 * review, MA-1). The live pointer is NULL once a box lands, so the customs
 * stamp and the «in Uzbekistan» date vanished from the history the moment the
 * cargo arrived — and the ready card read that absence as «still in
 * paperwork» on every ready carton there is. The newest arrival movement is
 * the durable record (`documents/arrivals.ts`, whose cause list this reads),
 * asked per box through the movements' (box, time) index. `batchId` null =
 * no truck brought it (received where it stands).
 */
async function landedTrucks(
  clientId: string,
): Promise<{ lotId: string; batchId: string | null; ready: boolean; n: number; landedAt: string | null }[]> {
  const rows = (await db.execute(sql`
    SELECT b.lot_id AS "lotId", lm.ref_id AS "batchId",
           (b.status = 'ready_for_pickup') AS ready, count(*)::int AS n,
           max(lm.created_at)::text AS "landedAt"
    FROM boxes b
    JOIN receipt_lots rl ON rl.id = b.lot_id
    JOIN receipts r ON r.id = rl.receipt_id
    LEFT JOIN LATERAL (
      SELECT m.ref_id, m.created_at FROM box_movements m
      WHERE m.box_id = b.id
        AND m.cause IN (${sql.join(ARRIVED_ON_A_TRUCK.map((c) => sql`${c}`), sql`, `)})
        AND m.ref_type = 'batch'
      ORDER BY m.created_at DESC
      LIMIT 1
    ) lm ON true
    WHERE r.client_id = ${clientId}
      AND b.current_batch_id IS NULL
      AND b.status IN (${sql.join(ACTIVE_STATUSES.map((s) => sql`${s}`), sql`, `)})
    GROUP BY b.lot_id, lm.ref_id, (b.status = 'ready_for_pickup')
  `)) as unknown as { lotId: string; batchId: string | null; ready: boolean; n: number; landedAt: string | null }[];
  return rows.map((r) => ({ ...r, n: Number(r.n) }));
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
      /*
       * The truck a LANDED box came off (round C review, MA-1): the live
       * pointer is NULL once it lands, so the customs stamp and the «in
       * Uzbekistan» date vanished from the history the moment the cargo
       * arrived — and the ready card read that absence as «still in
       * paperwork» on every ready carton there is. The arrival movement is
       * the durable record, the rule `documents/arrivals.ts` states.
       */
      n: sql<number>`count(*)`,
      // A box has no weight of its own — the lot's total divided by its box
      // count is what every other screen means by "per box" (#152 area,
      // finance/client-cargo.ts). Guarded against a zero count.
      perBoxKg: sql<string>`${receiptLots.totalWeightKg} / nullif(${receiptLots.boxCount}, 0)`,
      perBoxM3: sql<string>`${receiptLots.totalVolumeM3} / nullif(${receiptLots.boxCount}, 0)`,
      // The lot's own figures: its share on the card is `shareOf` over these,
      // the one formula the pushes use (round C review, second pass).
      lotKg: receiptLots.totalWeightKg,
      lotM3: receiptLots.totalVolumeM3,
      lotBoxes: receiptLots.boxCount,
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
  const landed = await landedTrucks(clientId);
  const trucks = await trucksFor([
    ...new Set([...rows.map((r) => r.batchId), ...landed.map((l) => l.batchId)].filter((id): id is string => !!id)),
  ]);

  const byLot = new Map<string, CabinetLot>();
  const lotOf = new Map<string, { kg: number; m3: number; boxes: number }>();
  const stageCounts = new Map<string, Map<CargoStage, { n: number; transit: CargoTransit | null }>>();
  for (const r of rows) {
    let lot = byLot.get(r.lotId);
    if (!lot) {
      lot = {
        lotId: r.lotId,
        letter: r.letter,
        productNameZh: r.productNameZh,
        productNameRu: r.productNameRu,
        groups: [],
        journey: [],
        total: 0,
        warehousePlaces: [],
        hasPhotos: false,
        weightKg: 0,
        volumeM3: 0,
        perBoxKg: Number(r.perBoxKg ?? 0),
        perBoxM3: Number(r.perBoxM3 ?? 0),
        photoCount: 0,
        readyCleared: 0,
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
    // Two trucks on the same rung keep the LATER-arriving one's road: the
    // group is not complete until the last of it lands.
    const transit = isMovingStage(stage) ? (truck?.transit ?? null) : null;
    const keep =
      !prev?.transit ||
      (transit &&
        (transit.etaToIso ?? '9999') > (prev.transit.etaToIso ?? '9999'))
        ? (transit ?? prev?.transit ?? null)
        : prev.transit;
    counts.set(stage, { n: (prev?.n ?? 0) + Number(r.n), transit: keep });
    lot.total += Number(r.n);
    // The share of the WHOLE active count, once, below — not a sum of
    // per-status shares, which can round the other way from the push.
    lotOf.set(r.lotId, { kg: Number(r.lotKg ?? 0), m3: Number(r.lotM3 ?? 0), boxes: Number(r.lotBoxes) });
    if (r.warehousePlace && !lot.warehousePlaces.includes(r.warehousePlace)) {
      lot.warehousePlaces.push(r.warehousePlace);
    }
  }
  for (const lot of byLot.values()) {
    const m = lotOf.get(lot.lotId);
    if (!m) continue;
    lot.weightKg = shareOf(m.kg, lot.total, m.boxes);
    lot.volumeM3 = shareOf(m.m3, lot.total, m.boxes);
  }
  const lots = [...byLot.values()];
  // Which truck answers for a lot's truck-level history (the pin, the customs
  // stamp): the one its bulk is riding — for landed cargo, the one it rode.
  const lotTruck = new Map<string, CabinetTruck | null>();
  for (const r of rows) {
    if (r.batchId && !lotTruck.get(r.lotId)) lotTruck.set(r.lotId, trucks.get(r.batchId) ?? null);
  }
  // Newest landing first, so a lot split across two landings is answered by
  // the same truck on every open — the rows come back in no order of their own.
  const landedNewestFirst = [...landed].sort((a, b) => (b.landedAt ?? '').localeCompare(a.landedAt ?? ''));
  for (const l of landedNewestFirst) {
    const lot = byLot.get(l.lotId);
    if (!lot) continue;
    const truck = l.batchId ? (trucks.get(l.batchId) ?? null) : null;
    // Only a truck that brought the cargo INTO Uzbekistan answers for its
    // history: one that ended at a Chinese hub has no customs stamp and no
    // «in Uzbekistan» day to lend a lot waiting there for its export truck.
    if (truck && truck.stage.destCountry !== 'CN' && !lotTruck.get(l.lotId)) lotTruck.set(l.lotId, truck);
    // The push's own rule (`arrivalCleared`), so the card under the push says
    // what the push said. Cargo no truck brought (received at an Uzbek
    // warehouse) has no declaration of ours to wait for.
    if (l.ready && (!truck || arrivalCleared(truck.customsClearedAt, truck.stage.originCountry))) {
      lot.readyCleared += l.n;
    }
  }
  const journeys = await lotJourneys(
    lots.map((l) => l.lotId),
    lotTruck,
  );
  for (const lot of lots) {
    // Biggest group first: the ladder is drawn for the bulk of the cargo and
    // the rest is named under it, so the order IS the screen.
    lot.groups = [...(stageCounts.get(lot.lotId) ?? new Map())]
      .map(([stage, v]) => ({ stage, n: v.n, transit: v.transit }))
      .sort((a, b) => b.n - a.n || stageIndex(a.stage) - stageIndex(b.stage));
    lot.journey = journeys.get(lot.lotId) ?? [];
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
      lot.weightKg = roundKg(lot.weightKg);
      lot.volumeM3 = roundM3(lot.volumeM3);
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
      // The bot's 📷 sends an original only when Telegram will take it (≤ 10 MB).
      sizeBytes: attachments.sizeBytes,
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
    // A kurs farqi row (0103) is the company's bookkeeping: the balance above
    // already reads it, and a «0 UZS» line is noise to a customer.
    recent: ledger.filter(({ tx }) => tx.type !== 'fx_diff').slice(0, 5).map(({ tx }) => ({
      type: tx.type,
      amount: Number(tx.amount),
      currency: tx.currency,
      amountUsd: Number(tx.amountUsd),
      txDate: tx.txDate,
      voided: tx.voidedAt !== null,
    })),
  };
}

/** How far back the history reaches — the owner's «3 oy». */
export const HISTORY_DAYS = 90;
/** A bound, said on nothing because nobody hands over 60 times a quarter. */
const HISTORY_CAP = 60;

export interface IssuedLeg {
  /** The truck's code — the owner's explicit ask («qaysi partiyada kelgan»). */
  batchCode: string;
  fromPlace: string;
  toPlace: string;
  /** Both ends in one country: Yiwu → Kashgar, Andijan → Tashkent. */
  domestic: boolean;
  departedAt: string | null;
  arrivedAt: string | null;
  /** Boxes of THIS handover that rode it. */
  n: number;
}

export interface IssuedLotView {
  lotId: string;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  receivedAt: string;
  n: number;
  weightKg: number;
  volumeM3: number;
  photoCount: number;
}

export interface IssuedHandover {
  id: string;
  issuedAt: string;
  place: string;
  receiver: string;
  issuedBy: string;
  lots: IssuedLotView[];
  legs: IssuedLeg[];
}

/**
 * The cargo handed over in the last three months, ONE entry per handover —
 * the owner's «alohida topshirilgan yuklar ko'rinib tursin … qaysi partiyada
 * kelgan, ichki tashqi sanalari, rasmlari, kim bergan».
 *
 * Grouped by HANDOVER and not by lot, which is what the old list did: a lot
 * collected in two visits is two facts with two dates and two receivers, and
 * `max(boxes.updated_at)` stood in for «when» while any later edit of a box
 * moved it. The handover row IS the moment, and `box_movements` (cause
 * `issued`, ref = the handover) is the one link from it to its boxes.
 *
 * The legs are read from THOSE boxes' `batch_departed` and landing movements,
 * never from the lot: half of a lot can still be on the road while the other
 * half is handed over, and a lot-scoped read would print the travelling half's
 * truck under a handover it had no part in. `current_batch_id` is useless
 * here — landing nulls it (#440).
 *
 * What is deliberately NOT here: the handover's note, `debt_ok`, the truck's
 * plate or driver, and anything priced. The receiver's PHONE is left out too:
 * the customer knows who they sent, and the number belongs to a person who may
 * not be them. Four queries for the whole history, never one per row (#432).
 */
export async function issuedHandovers(
  clientId: string,
  days = HISTORY_DAYS,
): Promise<IssuedHandover[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const head = await db
    .select({
      id: handovers.id,
      createdAt: handovers.createdAt,
      receiver: handovers.personName,
      issuedBy: users.fullName,
      place: warehouses.name,
    })
    .from(handovers)
    .innerJoin(users, eq(handovers.createdBy, users.id))
    .innerJoin(warehouses, eq(handovers.warehouseId, warehouses.id))
    .where(
      and(
        eq(handovers.clientId, clientId),
        eq(handovers.kind, 'issued_to_client'),
        gte(handovers.createdAt, since),
      ),
    )
    .orderBy(desc(handovers.createdAt))
    .limit(HISTORY_CAP);
  if (head.length === 0) return [];
  const ids = head.map((h) => h.id);

  const [lotRows, legRows] = await Promise.all([
    db
      .select({
        handoverId: boxMovements.refId,
        lotId: receiptLots.id,
        letter: receiptLots.letter,
        productNameZh: receiptLots.productNameZh,
        productNameRu: receiptLots.productNameRu,
        boxCount: receiptLots.boxCount,
        lotKg: receiptLots.totalWeightKg,
        lotM3: receiptLots.totalVolumeM3,
        receivedAt: receipts.receivedAt,
        n: sql<number>`count(DISTINCT ${boxMovements.boxId})`,
      })
      .from(boxMovements)
      .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(
        and(
          eq(boxMovements.refType, 'handover'),
          eq(boxMovements.cause, 'issued'),
          inArray(boxMovements.refId, ids),
        ),
      )
      .groupBy(boxMovements.refId, receiptLots.id, receipts.receivedAt),
    // The issued boxes' own trucks. Raw SQL for the CTE; its timestamps come
    // back as TEXT (a raw `execute` is not typed by the schema), so they are
    // converted below before anybody formats them.
    db.execute<{
      handover_id: string;
      batch_code: string;
      from_place: string;
      from_country: string;
      to_place: string;
      to_country: string;
      departed_at: string | null;
      arrived_at: string | null;
      n: number | string;
    }>(sql`
      WITH issued AS (
        SELECT ref_id AS handover_id, box_id
        FROM box_movements
        WHERE ref_type = 'handover' AND cause = 'issued'
          AND ref_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      )
      SELECT i.handover_id,
             b.code AS batch_code,
             o.name AS from_place, o.country AS from_country,
             d.name AS to_place, d.country AS to_country,
             min(m.created_at) FILTER (WHERE m.cause = 'batch_departed') AS departed_at,
             min(m.created_at) FILTER (
               WHERE m.cause IN (${sql.join(ARRIVED_ON_A_TRUCK.map((c) => sql`${c}`), sql`, `)})
             ) AS arrived_at,
             count(DISTINCT m.box_id) FILTER (WHERE m.cause = 'batch_departed') AS n
      FROM issued i
      JOIN box_movements m ON m.box_id = i.box_id AND m.ref_type = 'batch'
        AND m.cause IN ('batch_departed', ${sql.join(ARRIVED_ON_A_TRUCK.map((c) => sql`${c}`), sql`, `)})
      JOIN batches b ON b.id = m.ref_id
      JOIN warehouses o ON o.id = b.origin_warehouse_id
      JOIN warehouses d ON d.id = b.dest_warehouse_id
      GROUP BY i.handover_id, b.id, b.code, o.name, o.country, d.name, d.country
    `),
  ]);

  const lotIds = [...new Set(lotRows.map((r) => r.lotId))];
  const photoRows = lotIds.length
    ? await db
        .select({ entityId: attachments.entityId, n: sql<number>`count(*)` })
        .from(attachments)
        .where(
          and(
            eq(attachments.entityType, 'receipt_lot'),
            inArray(attachments.entityId, lotIds),
            eq(attachments.kind, 'photo'),
          ),
        )
        .groupBy(attachments.entityId)
    : [];
  const photos = new Map(photoRows.map((r) => [r.entityId, Number(r.n)]));

  const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
  return head.map((h) => {
    const lots = lotRows
      .filter((r) => r.handoverId === h.id)
      .map((r) => {
        const n = Number(r.n);
        // A box's weight is its lot's share, as on every other screen: the
        // lot is weighed once, never box by box (`shareOf`, the one formula).
        return {
          lotId: r.lotId,
          letter: r.letter,
          productNameZh: r.productNameZh,
          productNameRu: r.productNameRu,
          receivedAt: new Date(r.receivedAt).toISOString(),
          n,
          weightKg: roundKg(shareOf(Number(r.lotKg ?? 0), n, r.boxCount)),
          volumeM3: roundM3(shareOf(Number(r.lotM3 ?? 0), n, r.boxCount)),
          photoCount: photos.get(r.lotId) ?? 0,
        };
      })
      .sort((a, b) => (a.letter ?? '').localeCompare(b.letter ?? ''));
    const legs = [...legRows]
      .filter((r) => r.handover_id === h.id)
      .map((r) => ({
        batchCode: r.batch_code,
        fromPlace: r.from_place,
        toPlace: r.to_place,
        domestic: r.from_country === r.to_country,
        departedAt: iso(r.departed_at),
        arrivedAt: iso(r.arrived_at),
        n: Number(r.n),
      }))
      // The road in the order it was driven; a leg with no departure (a box
      // found at the destination, never scanned onto the truck) goes last.
      .sort((a, b) => (a.departedAt ?? '9').localeCompare(b.departedAt ?? '9'));
    return {
      id: h.id,
      issuedAt: new Date(h.createdAt).toISOString(),
      place: h.place,
      receiver: h.receiver,
      issuedBy: h.issuedBy,
      lots,
      legs,
    };
  });
}

/**
 * What the client PAID in the same three months — and nothing else.
 *
 * The owner's words: «klientga tan narx ko'rinmasin, faqat pul to'langandan
 * keyin bergan puli ko'rinsin». So payments only: not a charge, not a cost,
 * not a note (a note is written for colleagues). Dated by the Tashkent day,
 * because `tx_date` is a calendar day in Tashkent.
 */
export async function paidHistory(clientId: string, days = HISTORY_DAYS) {
  const rows = await db
    .select({
      txDate: clientTransactions.txDate,
      amount: clientTransactions.amount,
      currency: clientTransactions.currency,
    })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.clientId, clientId),
        eq(clientTransactions.type, 'payment'),
        isNull(clientTransactions.voidedAt),
        sql`${clientTransactions.txDate} >= (now() AT TIME ZONE 'Asia/Tashkent')::date - ${days}::int`,
      ),
    )
    .orderBy(desc(clientTransactions.txDate), desc(clientTransactions.createdAt))
    .limit(HISTORY_CAP);
  return rows.map((r) => ({ txDate: r.txDate, amount: Number(r.amount), currency: r.currency }));
}

/**
 * The person a customer should write to (round C) — their code's sales
 * manager — for the bot's «💬 Menejer», the Mini App card and the push's
 * manager door. ONE read for all three, so the three never name different
 * people.
 *
 * What is shown is what the offer PDF has always printed to the same
 * customer — the seller's name and phone (`users.phone`, the PDF's own
 * number; the owner chose «standart»: the PDF's rule) — plus the one thing a
 * Telegram customer actually taps, a chat link.
 *
 * The link follows round 113's trust rule, imported and not restated
 * (`reachableAt`, #513): the handle the listener READ from the manager's own
 * account only while it is fresh, because a released handle can be
 * registered by a stranger and a customer who owes money must never be sent
 * to one (judge PRIV-1); else the handle somebody typed; else Telegram's own
 * `t.me/+<number>` link, which opens a chat by phone when the manager's
 * privacy allows it.
 *
 * A deactivated manager is no manager: a customer must not be sent to a
 * person who has left. One grouped query, never one per code (#432).
 */
export interface ManagerContact {
  name: string;
  phone: string | null;
  telegramUrl: string | null;
}

export async function managersFor(
  clientIds: string[],
  now: Date = new Date(),
): Promise<Map<string, ManagerContact>> {
  const out = new Map<string, ManagerContact>();
  if (clientIds.length === 0) return out;
  const rows = await db
    .select({
      clientId: clients.id,
      name: users.fullName,
      phone: users.phone,
      typed: users.telegramUsername,
      accountStatus: tgAccounts.status,
      lastSeenAt: tgAccounts.lastSeenAt,
      verified: tgAccounts.tgUsername,
      checkedAt: tgAccounts.tgUsernameCheckedAt,
    })
    .from(clients)
    .innerJoin(users, and(eq(users.id, clients.salesManagerId), eq(users.active, true)))
    // `manager_user_id` is UNIQUE, so this joins at most one account.
    .leftJoin(tgAccounts, eq(tgAccounts.managerUserId, users.id))
    .where(inArray(clients.id, clientIds));
  for (const r of rows) {
    const phone = r.phone?.trim() || null;
    const reach = reachableAt(
      {
        typedUsername: r.typed?.trim() || null,
        account: r.accountStatus
          ? { status: r.accountStatus, lastSeenAt: r.lastSeenAt, username: r.verified, checkedAt: r.checkedAt }
          : null,
      },
      now,
    );
    out.set(r.clientId, {
      name: r.name,
      phone,
      telegramUrl: reach.ok ? `https://t.me/${reach.username}` : phone ? telegramPhoneUrl(phone) : null,
    });
  }
  return out;
}

/**
 * The office, for a customer whose code has no manager — the settings the
 * offer PDF prints. The seeded placeholder «—» means nobody filled it in, and
 * is never shown as a phone number.
 *
 * On the POOL: never call this inside a transaction (#714).
 */
export async function officeContact(): Promise<{ name: string; phone: string | null }> {
  const [name, phone] = await Promise.all([getSetting('company_name'), getSetting('company_phone')]);
  const clean = (v: unknown) => {
    const text = typeof v === 'string' ? v.trim() : '';
    return text === '' || text === '—' || text === '-' ? null : text;
  };
  return { name: clean(name) ?? 'GSR LOGISTICS', phone: clean(phone) };
}
