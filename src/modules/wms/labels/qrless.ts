import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, clients, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { inScope } from '../../platform/rbac/scope';
import { mayCountMove, type CountDoorActor } from '../scanning/count-door';
import { PRESENT_STATUSES } from '../inventory/present';
import { QRLESS_SHEET_CAP, qrlessBoxSql, qrlessJoinedSql } from './qrless-sql';
import { labelFor } from './sheet';
import type { LabelData } from './renderer';

/*
 * «Stiker keyin» — printing the stickers a QR-siz lot (0112, the owner's Q8)
 * never got, where the cartons STAND, and the one press that says they are on.
 *
 * Every read here is pooled and none may be called from inside a transaction
 * (#714); `confirmQrLabelled` opens its own and uses only its own handle.
 */

export class QrlessError extends Error {
  constructor(public readonly code: 'unauthenticated' | 'forbidden' | 'not_found' | 'too_many') {
    super(code);
  }
}

/** The statuses nobody needs the count door for: cargo on a shelf. */
const SHELF_PRINTABLE = PRESENT_STATUSES.filter((status) => status !== 'planned');

type PrintActor = Omit<CountDoorActor, 'id'>;

/** `inScope` over the door's read-only actor shape. */
function mayReadHere(actor: PrintActor, warehouseId: string): boolean {
  return inScope({ warehouseScoped: actor.warehouseScoped, warehouseIds: [...actor.warehouseIds] }, warehouseId);
}

/**
 * Which cartons this person may put a sticker on at this warehouse.
 *
 * Shelf cargo — anyone who may print a receipt's stickers there. A PLANNED
 * carton only for the count door (plans.manage in scope, decision 31): it is
 * already on a truck's list, and stamping it flips its lot on that truck from
 * «the office counts it» to «the phone scans it» under the office's feet — a
 * decision about a load, which is the logistics office's and not the shelf's.
 */
export function printableStatuses(
  actor: PrintActor,
  warehouseId: string,
): readonly string[] {
  return mayCountMove(actor, warehouseId) ? PRESENT_STATUSES : SHELF_PRINTABLE;
}

export interface QrlessCount {
  warehouseId: string;
  code: string;
  /** Cartons this person may print here. */
  n: number;
}

/**
 * How many QR-siz cartons stand at each warehouse that this person may
 * print — the /stock banner and the stocktake chooser's tile. `'all'` asks
 * every warehouse in the person's scope.
 */
export async function qrlessCountsAt(
  targets: readonly string[] | 'all',
  actor: PrintActor,
): Promise<QrlessCount[]> {
  if (targets !== 'all' && targets.length === 0) return [];
  const rows = await db
    .select({
      warehouseId: boxes.currentWarehouseId,
      code: warehouses.code,
      shelf: sql<number>`count(*) FILTER (WHERE ${boxes.status} <> 'planned')`,
      planned: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'planned')`,
    })
    .from(receiptLots)
    .innerJoin(boxes, eq(boxes.lotId, receiptLots.id))
    .innerJoin(warehouses, eq(warehouses.id, boxes.currentWarehouseId))
    .where(
      and(
        // The marked lots are few and indexed (0112's partial index): start
        // from them rather than from every carton on every shelf.
        isNotNull(receiptLots.qrSkippedAt),
        inArray(boxes.status, [...PRESENT_STATUSES]),
        qrlessJoinedSql(),
        targets === 'all' ? undefined : inArray(boxes.currentWarehouseId, [...targets]),
      ),
    )
    .groupBy(boxes.currentWarehouseId, warehouses.code)
    .orderBy(asc(warehouses.code));
  return rows
    .filter((row) => row.warehouseId && mayReadHere(actor, row.warehouseId))
    .map((row) => ({
      warehouseId: row.warehouseId!,
      code: row.code,
      n: Number(row.shelf) + (mayCountMove(actor, row.warehouseId!) ? Number(row.planned) : 0),
    }))
    .filter((row) => row.n > 0);
}

export interface QrlessLotRow {
  lotId: string;
  receiptId: string;
  receiptNumber: string | null;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  clientCode: string | null;
  marking: string | null;
  /** QR-siz cartons here this person may print. */
  n: number;
  /** QR-siz cartons here on a truck's plan, which only the office prints. */
  plannedLocked: number;
  /** Members of a crate: they travel on the crate's own label. */
  crated: number;
}

/** The print-later list for one warehouse, one row per lot, oldest first. */
export async function qrlessLotsAt(
  warehouseId: string,
  actor: PrintActor,
): Promise<QrlessLotRow[]> {
  const door = mayCountMove(actor, warehouseId);
  const rows = await db
    .select({
      lotId: receiptLots.id,
      receiptId: receipts.id,
      receiptNumber: receipts.number,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      receivedAt: receipts.receivedAt,
      shelf: sql<number>`count(*) FILTER (WHERE ${qrlessJoinedSql()} AND ${boxes.status} <> 'planned')`,
      planned: sql<number>`count(*) FILTER (WHERE ${qrlessJoinedSql()} AND ${boxes.status} = 'planned')`,
      crated: sql<number>`count(*) FILTER (WHERE ${boxes}.crate_id IS NOT NULL
        AND (${boxes}.label_printed_at IS NULL OR ${boxes}.label_printed_at < ${receiptLots}.qr_skipped_at))`,
    })
    .from(receiptLots)
    .innerJoin(boxes, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      and(
        isNotNull(receiptLots.qrSkippedAt),
        eq(boxes.currentWarehouseId, warehouseId),
        inArray(boxes.status, [...PRESENT_STATUSES]),
      ),
    )
    .groupBy(receiptLots.id, receipts.id, clients.clientCode)
    .orderBy(asc(receipts.receivedAt), asc(receiptLots.letter));
  return rows
    .map((row) => ({
      lotId: row.lotId,
      receiptId: row.receiptId,
      receiptNumber: row.receiptNumber,
      letter: row.letter,
      productNameZh: row.productNameZh,
      productNameRu: row.productNameRu,
      clientCode: row.clientCode,
      marking: row.marking,
      n: Number(row.shelf) + (door ? Number(row.planned) : 0),
      plannedLocked: door ? 0 : Number(row.planned),
      crated: Number(row.crated),
    }))
    .filter((row) => row.n > 0 || row.plannedLocked > 0 || row.crated > 0);
}

export interface QrlessSheet {
  hereCode: string;
  labels: LabelData[];
  boxIds: string[];
  /** Everything the filter matched; more than `labels` when the sheet cap bit. */
  total: number;
}

/**
 * The stickers of the QR-siz cartons standing HERE — never the receipt's
 * warehouse, which is where the goods were received and not where they are
 * (critique b8: a Tashkent operator must be able to label the Yiwu prixod's
 * sacks in front of them, and must never print a code for a carton the
 * system places on another shelf).
 *
 * Reading stamps nothing: opening the sheet, the PDF or the print dialog
 * changes no carton. Only `confirmQrLabelled` does.
 */
export async function qrlessLabelsAt(
  warehouseId: string,
  filter: { lotId?: string; boxId?: string },
  actor: PrintActor,
): Promise<QrlessSheet | null> {
  const here = await db.query.warehouses.findFirst({ where: eq(warehouses.id, warehouseId) });
  if (!here) return null;
  const where = and(
    eq(boxes.currentWarehouseId, warehouseId),
    inArray(boxes.status, [...printableStatuses(actor, warehouseId)]),
    qrlessJoinedSql(),
    filter.lotId ? eq(boxes.lotId, filter.lotId) : undefined,
    filter.boxId ? eq(boxes.id, filter.boxId) : undefined,
  );
  const rows = await db
    .select({
      box: { id: boxes.id, seqInLot: boxes.seqInLot, shortCode: boxes.shortCode },
      lot: receiptLots,
      receiptNumber: receipts.number,
      receivedAt: receipts.receivedAt,
      marking: receipts.unclaimedMarking,
      originCode: warehouses.code,
      originTimezone: warehouses.timezone,
      clientCode: clients.clientCode,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    // The RECEIPT's warehouse: the sticker says where the cargo was received.
    .innerJoin(warehouses, eq(warehouses.id, receipts.warehouseId))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(where)
    .orderBy(asc(receipts.receivedAt), asc(receiptLots.letter), asc(boxes.seqInLot))
    .limit(QRLESS_SHEET_CAP);
  const [count] = await db
    .select({ n: sql<number>`count(*)` })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(where);
  return {
    hereCode: here.code,
    labels: rows.map((row) =>
      labelFor(
        {
          warehouseCode: row.originCode,
          timezone: row.originTimezone,
          receiptNumber: row.receiptNumber,
          receivedAt: row.receivedAt,
          unclaimedMarking: row.marking,
          clientCode: row.clientCode,
        },
        row.lot,
        row.box,
      ),
    ),
    boxIds: rows.map((row) => row.box.id),
    total: Number(count?.n ?? 0),
  };
}

/**
 * «✅ Stikerlar yopishtirildi» — the ONE door that turns a QR-siz carton back
 * into a carton the phones scan (with `recordLabelPrint`, the only two writers
 * of `label_printed_at`; a fence counts them).
 *
 * It stamps exactly the ids the sheet RENDERED — never «whatever is QR-siz
 * here now», or a truck unloaded between the print and the press would have
 * its cartons stamped unseen — and re-asks every rule inside the UPDATE's own
 * WHERE: still standing HERE, still QR-siz, and a status this person may
 * stamp (a planned carton only for the count door). A posted id that fails is
 * skipped and counted, never an error: the answer says how many landed.
 *
 * The audit row is written at the PRINTING warehouse: the person pressing is
 * in Tashkent even when the prixod is Yiwu's.
 */
export async function confirmQrLabelled(
  warehouseId: string,
  boxIds: readonly string[],
  actor: CountDoorActor,
  ctx: AuditContext,
): Promise<{ labelled: number; skipped: number }> {
  if (!ctx.actorId) throw new QrlessError('unauthenticated');
  if (!actor.permissions.has('receipts.create') || !mayReadHere(actor, warehouseId)) {
    throw new QrlessError('forbidden');
  }
  const ids = [...new Set(boxIds)];
  if (ids.length === 0) return { labelled: 0, skipped: 0 };
  if (ids.length > QRLESS_SHEET_CAP) throw new QrlessError('too_many');
  const statuses = [...printableStatuses(actor, warehouseId)];

  return db.transaction(async (tx) => {
    const [here] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(eq(warehouses.id, warehouseId));
    if (!here) throw new QrlessError('not_found');
    const stamped = await tx
      .update(boxes)
      .set({ labelPrintedAt: sql`now()` })
      .where(
        and(
          inArray(boxes.id, ids),
          eq(boxes.currentWarehouseId, warehouseId),
          inArray(boxes.status, statuses),
          qrlessBoxSql(),
        ),
      )
      .returning({ id: boxes.id, shortCode: boxes.shortCode, lotId: boxes.lotId });
    if (stamped.length > 0) {
      const lotReceipts = await tx
        .select({ lotId: receiptLots.id, receiptId: receiptLots.receiptId })
        .from(receiptLots)
        .where(inArray(receiptLots.id, [...new Set(stamped.map((row) => row.lotId))]));
      const receiptOf = new Map(lotReceipts.map((row) => [row.lotId, row.receiptId]));
      const codesByReceipt = new Map<string, string[]>();
      for (const row of stamped) {
        const receiptId = receiptOf.get(row.lotId)!;
        codesByReceipt.set(receiptId, [...(codesByReceipt.get(receiptId) ?? []), row.shortCode]);
      }
      // One row per prixod, the shape `/reports/label-prints` already reads.
      for (const [receiptId, codes] of codesByReceipt) {
        await writeAudit(tx, { ...ctx, warehouseId }, {
          entityType: 'receipt',
          entityId: receiptId,
          action: 'label_print',
          after: { count: codes.length, boxes: codes, qrless: true, at: here.code },
        });
      }
    }
    return { labelled: stamped.length, skipped: ids.length - stamped.length };
  });
}

export interface LotQrState {
  /** QR-siz cartons of the lot that still exist. */
  qrlessLive: number;
  /** Cartons of a marked lot that got a sticker after the marking. */
  labelledLater: number;
  /** What the receipt's ordinary sheet would carry — `labelsForReceipt`'s rule. */
  printable: number;
  /** Live cartons that have left `in_stock` — the toggle's shelf gate. */
  notInStock: number;
  /** Where the QR-siz cartons stand, counted as THIS person may print them. */
  printableAt: { warehouseId: string; code: string; n: number }[];
}

/** The receipt card's per-lot sticker facts, in one grouped query. */
export async function lotQrState(
  lotIds: readonly string[],
  actor: PrintActor,
): Promise<Map<string, LotQrState>> {
  const out = new Map<string, LotQrState>();
  if (lotIds.length === 0) return out;
  const rows = await db
    .select({
      lotId: boxes.lotId,
      warehouseId: boxes.currentWarehouseId,
      code: warehouses.code,
      shelfHere: sql<number>`count(*) FILTER (WHERE ${qrlessJoinedSql()}
        AND ${inArray(boxes.status, [...SHELF_PRINTABLE])})`,
      plannedHere: sql<number>`count(*) FILTER (WHERE ${qrlessJoinedSql()} AND ${boxes.status} = 'planned')`,
      qrlessLive: sql<number>`count(*) FILTER (WHERE ${qrlessJoinedSql()} AND ${boxes.status} <> 'void')`,
      labelledLater: sql<number>`count(*) FILTER (WHERE ${receiptLots}.qr_skipped_at IS NOT NULL
        AND ${boxes}.label_printed_at >= ${receiptLots}.qr_skipped_at AND ${boxes.status} <> 'void')`,
      printable: sql<number>`count(*) FILTER (WHERE NOT ${qrlessJoinedSql()})`,
      notInStock: sql<number>`count(*) FILTER (WHERE ${boxes.status} NOT IN ('void', 'in_stock'))`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .leftJoin(warehouses, eq(warehouses.id, boxes.currentWarehouseId))
    .where(inArray(boxes.lotId, [...lotIds]))
    .groupBy(boxes.lotId, boxes.currentWarehouseId, warehouses.code);
  for (const row of rows) {
    const state = out.get(row.lotId) ?? {
      qrlessLive: 0,
      labelledLater: 0,
      printable: 0,
      notInStock: 0,
      printableAt: [],
    };
    state.qrlessLive += Number(row.qrlessLive);
    state.labelledLater += Number(row.labelledLater);
    state.printable += Number(row.printable);
    state.notInStock += Number(row.notInStock);
    if (row.warehouseId && row.code && mayReadHere(actor, row.warehouseId)) {
      const n =
        Number(row.shelfHere) + (mayCountMove(actor, row.warehouseId) ? Number(row.plannedHere) : 0);
      if (n > 0) state.printableAt.push({ warehouseId: row.warehouseId, code: row.code, n });
    }
    out.set(row.lotId, state);
  }
  return out;
}
