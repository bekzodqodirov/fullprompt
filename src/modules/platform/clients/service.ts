import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { clients } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';
import { getSetting } from '../settings/service';
import { nextClientCode } from './code';
import { autoLinkClientToVerifiedChats } from '../telegram/client-cabinet';

/**
 * Creating a client card, in one place.
 *
 * It used to live entirely inside the admin server action, which was fine
 * until CRM needed to turn a lead into a client and would otherwise have
 * duplicated the code generator, the uniqueness race handling and the cabinet
 * auto-link — three things that must not drift apart.
 */

export class ClientError extends Error {
  constructor(public readonly code: 'validation' | 'code_exists' | 'code_format') {
    super(code);
  }
}

export const newClientSchema = z.object({
  /** Empty ⇒ the system assigns the next sequential code (DECISIONS #115). */
  clientCode: z.string().trim().max(20).default(''),
  name: z.string().trim().min(1).max(200),
  phones: z.array(z.string().trim()).default([]),
  salesManagerId: z.string().uuid().optional(),
  messengerNote: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
  active: z.boolean().default(true),
});
export type NewClientInput = z.input<typeof newClientSchema>;

/**
 * Real-world markings are arbitrary short codes (444, GS277, A55 — the
 * owner's Kashgar stock file), so a manual code accepts any 2–10
 * alphanumerics; generated codes use the configured prefix.
 */
export function isValidClientCode(code: string): boolean {
  return /^[A-Z0-9]{2,10}$/.test(code);
}

/** Postgres unique_violation (23505) — the client_code unique index. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

export async function createClient(rawInput: NewClientInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new ClientError('validation');
  const parsed = newClientSchema.safeParse(rawInput);
  if (!parsed.success) throw new ClientError('validation');
  const input = parsed.data;
  const code = input.clientCode.toUpperCase();

  const manual = code.length > 0;
  if (manual) {
    if (!isValidClientCode(code)) throw new ClientError('code_format');
    const existing = await db.query.clients.findFirst({
      where: sql`upper(${clients.clientCode}) = ${code}`,
    });
    if (existing) throw new ClientError('code_exists');
  }

  const values = {
    clientCode: code,
    name: input.name,
    phones: input.phones.filter(Boolean),
    salesManagerId: input.salesManagerId || null,
    messengerNote: input.messengerNote || null,
    notes: input.notes || null,
    active: input.active,
  };

  let row;
  try {
    row = await db.transaction(async (tx) => {
      if (!manual) {
        const prefix = await getSetting('client_code_prefix');
        values.clientCode = await nextClientCode(tx, prefix);
      }
      const [inserted] = await tx.insert(clients).values(values).returning();
      return inserted;
    });
  } catch (err) {
    // Two people typing the same manual code at once both pass the check
    // above; the loser must see "code taken", not a crash page.
    if (isUniqueViolation(err)) throw new ClientError('code_exists');
    throw err;
  }
  if (!row) throw new ClientError('validation');

  await writeAudit(db, ctx, {
    entityType: 'client',
    entityId: row.id,
    action: 'create',
    after: values as unknown as Record<string, unknown>,
  });

  // A person often holds several codes on one phone — if that phone already
  // passed cabinet verification, the new code joins their chat automatically.
  await autoLinkClientToVerifiedChats(row.id, ctx.actorId).catch(() => {});

  return row;
}
