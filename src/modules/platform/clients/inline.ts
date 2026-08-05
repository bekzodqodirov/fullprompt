import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { clients, users } from '../db/schema';
import { diffFields, writeAudit, type AuditContext } from '../audit/service';

/**
 * One field of a client card, patched in place.
 *
 * The three the owner named: the number you ring, the note you keep, and the
 * seller who answers for the account. Everything else stays in the form below
 * — the CODE above all, which is this client's identity on every label, every
 * act and every payment, and is not something to change with one tap.
 *
 * `phones` is stored as an ARRAY and typed as one line, which is how the form
 * has always taken it; the splitting is restated here rather than shared,
 * because the form parses a whole record and this parses one box.
 */
export const INLINE_CLIENT_FIELDS = ['phones', 'notes', 'salesManagerId'] as const;
export type InlineClientField = (typeof INLINE_CLIENT_FIELDS)[number];

export class ClientPatchError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export async function patchClient(
  id: string,
  field: string,
  raw: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new ClientPatchError('unauthenticated');
  if (!(INLINE_CLIENT_FIELDS as readonly string[]).includes(field)) {
    throw new ClientPatchError('field_not_editable');
  }
  const before = await db.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!before) throw new ClientPatchError('not_found');

  const value = raw.trim();
  let column: Record<string, unknown>;
  let audited: Record<string, unknown>;
  let previous: Record<string, unknown>;

  if (field === 'phones') {
    const phones = value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (phones.some((phone) => phone.length > 40)) throw new ClientPatchError('validation');
    column = { phones };
    audited = { phones };
    previous = { phones: before.phones };
  } else if (field === 'notes') {
    if (value.length > 2000) throw new ClientPatchError('validation');
    column = { notes: value === '' ? null : value };
    audited = column;
    previous = { notes: before.notes };
  } else {
    // A picker, so an unknown id is a bug or a forged post rather than a typo;
    // either way it must not point the account at somebody who is not staff.
    if (value !== '') {
      const manager = await db.query.users.findFirst({ where: eq(users.id, value) });
      if (!manager) throw new ClientPatchError('validation');
    }
    column = { salesManagerId: value === '' ? null : value };
    audited = column;
    previous = { salesManagerId: before.salesManagerId };
  }

  const diff = diffFields(previous, audited);
  // Nothing changed, so nothing happened — the same rule the lead's patch
  // keeps, and the reason an audit trail is worth reading at all.
  if (!diff) return;

  await db.update(clients).set(column).where(eq(clients.id, id));
  await writeAudit(db, ctx, {
    entityType: 'client',
    entityId: id,
    action: 'update',
    before: diff.before,
    after: diff.after,
  });
}
