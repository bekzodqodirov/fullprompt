import { asc, eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, boxes, clients, partners, receiptLots, receipts } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { batchMemberFilter } from '../scanning/unload';
import { PartnerError } from './service';

/**
 * Who clears which cargo (the owner's third follow-up).
 *
 * The truck-level answer stays, because it is right nearly every time: one
 * batch, one customs firm. What it could not say is his real case — inside
 * one truck, a couple of clients clear their own goods through their own firm
 * and we clear everything else. So a PRIXOD may state its own answer, and
 * when it does that answer wins.
 *
 * Three states per receipt, and they are genuinely different facts:
 *   null           — nothing said; the batch's answer applies
 *   a partner      — that firm cleared this prixod, and its bill is our cost
 *   byClient=true  — the client cleared it; no cost of ours exists at all
 */

export type CustomsChoice = { partnerId: string | null; byClient: boolean };

/** The choice that actually applies to a receipt: its own, else its truck's. */
export function effectiveCustoms(
  receipt: { customsPartnerId: string | null; customsByClient: boolean | null },
  batch: { customsPartnerId: string | null; customsByClient: boolean } | null,
): CustomsChoice & { fromBatch: boolean } {
  // Only an explicit answer overrides — `false` on the receipt is an answer
  // ("we clear this one"), `null` is silence, and the two must not be mixed.
  if (receipt.customsByClient !== null || receipt.customsPartnerId !== null) {
    return {
      partnerId: receipt.customsPartnerId,
      byClient: receipt.customsByClient === true,
      fromBatch: false,
    };
  }
  return {
    partnerId: batch?.customsPartnerId ?? null,
    byClient: batch?.customsByClient ?? false,
    fromBatch: true,
  };
}

/**
 * Set (or clear) a receipt's own answer. `''` means "follow the truck" —
 * the state a person needs to get back to after correcting a mistake.
 */
export async function setReceiptCustoms(
  receiptId: string,
  value: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt) throw new PartnerError('not_found');

  const next: { customsPartnerId: string | null; customsByClient: boolean | null } =
    value === ''
      ? { customsPartnerId: null, customsByClient: null }
      : value === 'client'
        ? { customsPartnerId: null, customsByClient: true }
        : { customsPartnerId: value, customsByClient: false };

  await db.update(receipts).set(next).where(eq(receipts.id, receiptId));
  await writeAudit(db, { ...ctx, warehouseId: receipt.warehouseId }, {
    entityType: 'receipt',
    entityId: receiptId,
    action: 'update',
    before: {
      customsPartnerId: receipt.customsPartnerId,
      customsByClient: receipt.customsByClient,
    },
    after: next,
  });
}

export interface CustomsRow {
  receiptId: string;
  number: string | null;
  clientCode: string | null;
  clientName: string | null;
  partnerId: string | null;
  partnerName: string | null;
  byClient: boolean;
  /** True when this row is only showing what the truck says. */
  fromBatch: boolean;
}

/**
 * Every prixod on a truck with the customs answer that applies to it.
 *
 * Membership is a JOIN through `box_movements` (#152), never a subquery in a
 * join predicate — the same rule the cost grid follows, and for the same
 * reason: it is the difference between 0.36 s and half a minute.
 */
export async function batchCustomsRows(batchId: string): Promise<CustomsRow[]> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return [];

  const rows = await db
    .select({
      receiptId: receipts.id,
      number: receipts.number,
      clientCode: clients.clientCode,
      clientName: clients.name,
      customsPartnerId: receipts.customsPartnerId,
      customsByClient: receipts.customsByClient,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(batchMemberFilter(batchId))
    .groupBy(
      receipts.id,
      receipts.number,
      clients.clientCode,
      clients.name,
      receipts.customsPartnerId,
      receipts.customsByClient,
    )
    .orderBy(asc(clients.clientCode), asc(receipts.number));

  const names = new Map(
    (await db.select({ id: partners.id, name: partners.name }).from(partners)).map((p) => [
      p.id,
      p.name,
    ]),
  );

  return rows.map((row) => {
    const applied = effectiveCustoms(row, batch);
    return {
      receiptId: row.receiptId,
      number: row.number,
      clientCode: row.clientCode,
      clientName: row.clientName,
      partnerId: applied.partnerId,
      partnerName: applied.partnerId ? (names.get(applied.partnerId) ?? null) : null,
      byClient: applied.byClient,
      fromBatch: applied.fromBatch,
    };
  });
}
