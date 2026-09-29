import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { attachments } from '../../platform/db/schema';

/**
 * The one photograph a row about a lot shows: the lot's own first goods
 * photo, else the prixod's first general photo — the pair /stock draws (its
 * query asks it per row with two correlated subqueries, which a stock table
 * of one warehouse can afford).
 *
 * This is the same pair asked ONCE for a list of lots, for the client card's
 * «Yuklar» tab. It is deliberately NOT folded into the tab's rows read: that
 * read is also the staff bot's client answer, which runs on grammy's
 * SEQUENTIAL poller (round 101), and two subqueries per group there would be
 * paid for by every customer waiting on the bot for a photo the bot never
 * sends (the tab's judge, finding 9).
 *
 * Keyed by lot id; a lot with neither photo is absent.
 */
export async function firstLotPhotos(
  lots: readonly { lotId: string; receiptId: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (lots.length === 0) return out;
  const lotIds = [...new Set(lots.map((l) => l.lotId))];
  const receiptIds = [...new Set(lots.map((l) => l.receiptId))];
  // DISTINCT ON the owner, oldest first — the /stock subqueries' ORDER BY
  // created_at LIMIT 1, for every owner in one statement over the
  // (entity_type, entity_id) index.
  const rows = await db
    .selectDistinctOn([attachments.entityType, attachments.entityId], {
      id: attachments.id,
      entityType: attachments.entityType,
      entityId: attachments.entityId,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.kind, 'photo'),
        or(
          and(eq(attachments.entityType, 'receipt_lot'), inArray(attachments.entityId, lotIds)),
          and(eq(attachments.entityType, 'receipt'), inArray(attachments.entityId, receiptIds)),
        ),
      ),
    )
    .orderBy(attachments.entityType, attachments.entityId, asc(attachments.createdAt));
  const lotPhoto = new Map<string, string>();
  const receiptPhoto = new Map<string, string>();
  for (const r of rows) (r.entityType === 'receipt_lot' ? lotPhoto : receiptPhoto).set(r.entityId, r.id);
  for (const { lotId, receiptId } of lots) {
    const id = lotPhoto.get(lotId) ?? receiptPhoto.get(receiptId);
    if (id) out.set(lotId, id);
  }
  return out;
}
