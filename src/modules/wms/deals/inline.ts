import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { deals } from '@/modules/platform/db/schema';
import { diffFields, writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { DealError } from './service';

/**
 * One field of a deal, patched in place from the card.
 *
 * The list is SHORT on purpose, and shorter than the lead's. A deal's other
 * columns are not text a person corrects while on the phone:
 *
 * - the QUOTE (amount, volume, weight, currency) is the number the client was
 *   told, and it carries an author and a date. `updateDeal` stamps those when
 *   the amount really moves; a one-field patch would either skip the stamp or
 *   forge it, and the whole point of the card is that the price has a name
 *   behind it.
 * - a stage is a move — audited, announced, watched by the automation rules
 *   and by the cargo triggers, and refused into `lost` without a reason.
 * - an owner is a handover, and the client is whose job this even is.
 *
 * What is left is the two things that are only ever description.
 */
export const INLINE_DEAL_FIELDS = ['title', 'note'] as const;
export type InlineDealField = (typeof INLINE_DEAL_FIELDS)[number];

/** The same limits the deal form validates against (`dealSchema`). */
const LIMITS: Record<InlineDealField, number> = { title: 200, note: 2000 };

export async function patchDeal(
  id: string,
  field: string,
  raw: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new DealError('unauthenticated');
  if (!(INLINE_DEAL_FIELDS as readonly string[]).includes(field)) {
    throw new DealError('field_not_editable');
  }
  const key = field as InlineDealField;
  const value = raw.trim();
  if (value.length > LIMITS[key]) throw new DealError('validation');

  const before = await db.query.deals.findFirst({ where: eq(deals.id, id) });
  if (!before) throw new DealError('not_found');

  // Both are optional on a deal — one opened as "price this for me" has
  // neither — so an empty box means "no answer" rather than a refusal.
  const next = value === '' ? null : value;
  const diff = diffFields({ [key]: before[key] ?? null }, { [key]: next });
  if (!diff) return;

  await db
    .update(deals)
    .set({ [key]: next, updatedAt: new Date() })
    .where(eq(deals.id, id));
  await writeAudit(db, ctx, {
    entityType: 'deal',
    entityId: id,
    action: 'update',
    before: diff.before,
    after: diff.after,
  });
}
