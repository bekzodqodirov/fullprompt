import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  attachments,
  boxes,
  clients,
  clientTelegramLinks,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { clientBalanceUsd, clientLedger } from '../finance/service';

/**
 * Telegram client cabinet (Phase 2.2, owner's spec): the client sees cargo
 * status, photos and debt — read-only views over existing data, keyed by the
 * chat's linked client(s). All queries verify ownership by clientId.
 */

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
    .then((rows) => rows.map((r) => r.client));
}

export interface CabinetLot {
  lotId: string;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  /** status → box count (active statuses only). */
  statuses: Record<string, number>;
  total: number;
  warehouseCodes: string[];
  hasPhotos: boolean;
}

const ACTIVE_STATUSES = ['in_stock', 'planned', 'loading', 'in_transit', 'ready_for_pickup'];

/** The client's active (not yet issued) cargo, one entry per lot. */
export async function cargoOverview(clientId: string): Promise<CabinetLot[]> {
  const rows = await db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      status: boxes.status,
      warehouseCode: warehouses.code,
      n: sql<number>`count(*)`,
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
      boxes.status,
      warehouses.code,
    )
    .orderBy(asc(receiptLots.letter));

  const byLot = new Map<string, CabinetLot>();
  for (const r of rows) {
    let lot = byLot.get(r.lotId);
    if (!lot) {
      lot = {
        lotId: r.lotId,
        letter: r.letter,
        productNameZh: r.productNameZh,
        productNameRu: r.productNameRu,
        statuses: {},
        total: 0,
        warehouseCodes: [],
        hasPhotos: false,
      };
      byLot.set(r.lotId, lot);
    }
    lot.statuses[r.status] = (lot.statuses[r.status] ?? 0) + Number(r.n);
    lot.total += Number(r.n);
    if (r.warehouseCode && !lot.warehouseCodes.includes(r.warehouseCode)) {
      lot.warehouseCodes.push(r.warehouseCode);
    }
  }
  const lots = [...byLot.values()];
  if (lots.length) {
    const withPhotos = await db
      .selectDistinct({ entityId: attachments.entityId })
      .from(attachments)
      .where(
        and(
          eq(attachments.entityType, 'receipt_lot'),
          inArray(attachments.entityId, lots.map((l) => l.lotId)),
          eq(attachments.kind, 'photo'),
        ),
      );
    const photoSet = new Set(withPhotos.map((r) => r.entityId));
    for (const lot of lots) lot.hasPhotos = photoSet.has(lot.lotId);
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
