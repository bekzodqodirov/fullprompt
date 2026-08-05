import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { leads } from '../../platform/db/schema';
import { diffFields, writeAudit, type AuditContext } from '../../platform/audit/service';
import { CrmError } from './service';

/**
 * One field of a lead, patched in place from the card.
 *
 * An ALLOWLIST rather than a generic setter, because most of a lead's columns
 * are not plain text: a stage is a move (audited, announced, refused into
 * `lost` without a reason), an owner is a handover, and `next_action_at` is
 * written as a PAIR with its note by both existing writers — a one-field
 * patch there leaves a stale reminder attached to a new date. Those keep the
 * forms they already have.
 *
 * What is left is exactly the text a salesperson corrects while on the phone:
 * the name they misheard, the company, the number, the note.
 */
export const INLINE_LEAD_FIELDS = ['name', 'phone', 'company', 'note'] as const;
export type InlineLeadField = (typeof INLINE_LEAD_FIELDS)[number];

/** What each field will accept; a name is the only one that cannot be empty. */
const LIMITS: Record<InlineLeadField, { max: number; min: number }> = {
  name: { max: 200, min: 2 },
  phone: { max: 40, min: 0 },
  company: { max: 200, min: 0 },
  note: { max: 4000, min: 0 },
};

export async function patchLead(
  id: string,
  field: string,
  raw: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  if (!(INLINE_LEAD_FIELDS as readonly string[]).includes(field)) {
    throw new CrmError('field_not_editable');
  }
  const key = field as InlineLeadField;
  const value = raw.trim();
  const limit = LIMITS[key];
  if (value.length < limit.min || value.length > limit.max) throw new CrmError('validation');

  const before = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!before) throw new CrmError('not_found');

  // An empty box means "no answer" for everything but the name, which the
  // length check above has already refused.
  const next = value === '' ? null : value;
  const diff = diffFields({ [key]: before[key] ?? null }, { [key]: next });
  // NOTHING happens when nothing changed. `updated_at` is not decoration: the
  // funnel orders by it, so a save that rewrites an unchanged row reshuffles
  // the owner's board for no reason — and writes an audit line saying so.
  if (!diff) return;

  await db
    .update(leads)
    .set({ [key]: next, updatedAt: new Date() })
    .where(eq(leads.id, id));
  await writeAudit(db, ctx, {
    entityType: 'lead',
    entityId: id,
    action: 'update',
    before: diff.before,
    after: diff.after,
  });
}
