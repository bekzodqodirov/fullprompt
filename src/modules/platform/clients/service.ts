import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { isUniqueViolation } from '../db/errors';
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

/**
 * Who may open a client code.
 *
 * Round 111, the owner: «hamma account uchun navbarda + iconkada lid ochish
 * bor, shu yerga klient code ochishni ham qoshishimiz kerak boladi». Until now
 * this was `clients.manage`, which the sales_manager role does not carry — so
 * the seller who signs the customer could raise a lead but not the code that
 * goes on their cartons, and had to ask an admin for it.
 *
 * Stated as ONE exported predicate rather than the pair written out at each
 * door, because there are two doors (the app bar decides whether to draw the
 * button, the action decides whether to obey it) and a screen that offers what
 * the action refuses is worse than neither.
 *
 * It deliberately does NOT answer «may this person read the client book» —
 * that is still `clients.manage`, and a seller who mints a code sees it
 * through their own screens, by the money scope, because they are stamped as
 * its manager (#637-640).
 */
export const CLIENT_MINT_PERMISSIONS = ['clients.manage', 'crm.leads'] as const;

export function canMintClient(permissions: { has(code: string): boolean }): boolean {
  return CLIENT_MINT_PERMISSIONS.some((code) => permissions.has(code));
}

/**
 * The insert, retried when the code it minted turned out to be taken.
 *
 * The generator serialises against ITSELF with an advisory lock, so two
 * automatic creates can never pick the same number (measured: ten at once,
 * ten different codes; without the lock only two of the ten survived). What
 * the lock cannot cover is a MANUAL code typed at the same instant — that
 * path takes no lock, because a typed code is a fact rather than a draw from
 * a sequence. Losing that race used to tell somebody who typed nothing at
 * all that «this code is taken»; the honest answer is to take the next one.
 *
 * A typed code that is taken is still refused, first time and every time —
 * there the message is the truth and retrying would silently hand the person
 * a different code from the one they wrote on the carton.
 */
const CODE_ATTEMPTS = 3;

async function insertWithFreeCode(
  values: typeof clients.$inferInsert,
  manual: boolean,
  prefix: string,
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        if (!manual) values.clientCode = await nextClientCode(tx, prefix);
        const [inserted] = await tx.insert(clients).values(values).returning();
        return inserted;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Two people typing the same manual code at once both pass the
      // pre-check above; the loser must see "code taken", not a crash page.
      if (manual || attempt >= CODE_ATTEMPTS) throw new ClientError('code_exists');
    }
  }
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

  // Read BEFORE the transaction opens, and that is the whole point of the
  // line: getSetting() runs on the POOL, so asking for it while already
  // holding a transaction's connection needs a SECOND one. The pool is
  // max: 10 and it belongs to the whole application — so ten people creating
  // a client in the same moment left all ten connections `idle in
  // transaction` waiting for an eleventh that can never come, and every
  // other screen for every other person stopped with them, permanently.
  // MEASURED against this code: nine at once finished in 121 ms, twelve
  // never returned and pg_stat_activity showed exactly ten backends parked
  // on `begin`. Nothing else in src/ asks for a second connection inside a
  // transaction — tests/unit/tx-pool.test.ts keeps it that way.
  const prefix = manual ? '' : await getSetting('client_code_prefix');

  const values = {
    clientCode: code,
    name: input.name,
    phones: input.phones.filter(Boolean),
    salesManagerId: input.salesManagerId || null,
    messengerNote: input.messengerNote || null,
    notes: input.notes || null,
    active: input.active,
  };

  const row = await insertWithFreeCode(values, manual, prefix);
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
