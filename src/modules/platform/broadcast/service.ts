import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { attachments, broadcastRecipients, broadcasts } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';

/**
 * The office's message to its clients, sent through the bot (the owner's
 * item 6, 2026-09-26: «telegram botdan unga ulangan barcha mijozlarga habar
 * yoza olay … hammaga yozish yokida bazi klientlarni belgilab tanlab yozish
 * sistemada bolgani yaxshi»).
 *
 * Who may: the super admin, his answer 6a («faqat siz»). A ROLE and not a
 * permission, like the annul (`mayAnnul`): nobody should hold it by a
 * checkbox somebody ticked for another reason.
 *
 * To whom: every client chat linked to the bot, narrowed by the words the
 * office typed on the client cards — trade, cargo kinds, language, seller —
 * or by codes typed outright. Per CHAT: three codes on one phone are one
 * person and get the message once (#267).
 */
export function mayBroadcast(actor: { roles: string[] }): boolean {
  return actor.roles.includes('super_admin');
}

export const BROADCAST_ENTITY_TYPE = 'broadcast';
export const BROADCAST_MAX_FILES = 10;

export const audienceSchema = z.object({
  sectors: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  cargoKinds: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  locales: z.array(z.enum(['uz', 'ru', 'en'])).max(3).default([]),
  managerId: z.string().uuid().optional(),
  codes: z.array(z.string().trim().min(1).max(20)).max(500).default([]),
  /**
   * A free search (the owner, 2026-09-26: «search qilish imkoni olib keladgan
   * yuki yokida sohasini kirgizib shunday klientlarni topib habar yozish»):
   * the code, the name, the trade, a cargo kind — or the GOODS of any prixod
   * the client ever brought, which is where «who brings chairs» actually
   * lives. The cards' own tags are typed by hand and mostly empty today.
   */
  query: z.string().trim().max(100).optional(),
});
export type Audience = z.infer<typeof audienceSchema>;

export interface AudienceChat {
  chatId: bigint;
  clientId: string;
  clientCode: string;
  clientName: string;
}

/**
 * The chats an audience reaches — ONE query, the filters ANDed, each list an
 * OR inside itself, words compared case-blind (a person typed them). A
 * client with several linked chats reaches each; a chat with several clients
 * is kept once, under its oldest code (round 67b's tie-break).
 */
export async function audienceChats(audience: Audience): Promise<AudienceChat[]> {
  const lower = (list: string[]) => list.map((v) => v.toLocaleLowerCase('ru'));
  const where = [
    sql`ctl.status = 'linked'`,
    sql`ctl.telegram_chat_id IS NOT NULL`,
    sql`c.active`,
  ];
  if (audience.codes.length > 0) {
    where.push(sql`upper(c.client_code) IN (${sql.join(audience.codes.map((c) => sql`${c.toUpperCase()}`), sql`, `)})`);
  }
  if (audience.sectors.length > 0) {
    where.push(sql`lower(c.sector) IN (${sql.join(lower(audience.sectors).map((v) => sql`${v}`), sql`, `)})`);
  }
  if (audience.cargoKinds.length > 0) {
    where.push(sql`EXISTS (SELECT 1 FROM unnest(c.cargo_kinds) k
                           WHERE lower(k) IN (${sql.join(lower(audience.cargoKinds).map((v) => sql`${v}`), sql`, `)}))`);
  }
  if (audience.locales.length > 0) {
    // A client who never chose a language reads the bot in Uzbek, its default.
    where.push(sql`coalesce(c.locale, 'uz') IN (${sql.join(audience.locales.map((v) => sql`${v}`), sql`, `)})`);
  }
  if (audience.managerId) where.push(sql`c.sales_manager_id = ${audience.managerId}::uuid`);
  if (audience.query) {
    const like = `%${audience.query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(sql`(
      c.client_code ILIKE ${like} OR c.name ILIKE ${like} OR coalesce(c.sector, '') ILIKE ${like}
      OR EXISTS (SELECT 1 FROM unnest(c.cargo_kinds) k WHERE k ILIKE ${like})
      OR EXISTS (SELECT 1 FROM receipts r JOIN receipt_lots l ON l.receipt_id = r.id
                  WHERE r.client_id = c.id AND r.status <> 'voided'
                    AND (l.product_name_ru ILIKE ${like} OR l.product_name_zh ILIKE ${like}))
    )`);
  }
  const rows = await db.execute<{ chat_id: string; client_id: string; client_code: string; name: string }>(sql`
    SELECT DISTINCT ON (ctl.telegram_chat_id)
           ctl.telegram_chat_id::text AS chat_id, c.id AS client_id, c.client_code, c.name
      FROM client_telegram_links ctl
      JOIN clients c ON c.id = ctl.client_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY ctl.telegram_chat_id, c.created_at, c.client_code
  `);
  return rows.map((r) => ({
    chatId: BigInt(r.chat_id),
    clientId: r.client_id,
    clientCode: r.client_code,
    clientName: r.name,
  }));
}

export class BroadcastError extends Error {
  constructor(public readonly code: 'empty' | 'no_recipients' | 'too_long' | 'too_many_files' | 'exists') {
    super(code);
  }
}

/**
 * Freeze the audience into rows and hand the sending to the job. The words
 * and the files are fixed from here on: a sent message cannot be edited in
 * twenty chats, so the record is what went.
 */
export async function createBroadcast(
  input: { id: string; body: string; audience: Audience },
  ctx: AuditContext,
): Promise<{ id: string; total: number }> {
  if (!ctx.actorId) throw new BroadcastError('empty');
  const body = input.body.trim();
  if (body.length > 4096) throw new BroadcastError('too_long');
  const files = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.entityType, BROADCAST_ENTITY_TYPE), eq(attachments.entityId, input.id)));
  if (!body && files.length === 0) throw new BroadcastError('empty');
  if (files.length > BROADCAST_MAX_FILES) throw new BroadcastError('too_many_files');
  const chats = await audienceChats(input.audience);
  if (chats.length === 0) throw new BroadcastError('no_recipients');
  const existing = await db.query.broadcasts.findFirst({ where: eq(broadcasts.id, input.id) });
  if (existing) throw new BroadcastError('exists');

  await db.transaction(async (tx) => {
    await tx.insert(broadcasts).values({
      id: input.id,
      body,
      audience: input.audience,
      createdBy: ctx.actorId!,
      total: chats.length,
    });
    for (let i = 0; i < chats.length; i += 500) {
      await tx.insert(broadcastRecipients).values(
        chats.slice(i, i + 500).map((c) => ({ broadcastId: input.id, chatId: c.chatId, clientId: c.clientId })),
      );
    }
    await writeAudit(tx, ctx, {
      entityType: 'broadcast',
      entityId: input.id,
      action: 'create',
      after: { recipients: chats.length, files: files.length, audience: input.audience },
    });
  });
  return { id: input.id, total: chats.length };
}

/** The newest broadcasts with their running counts, for the screen. */
export async function recentBroadcasts(limit = 20) {
  return db
    .select()
    .from(broadcasts)
    .orderBy(sql`${broadcasts.createdAt} DESC`)
    .limit(limit);
}

/**
 * Claim the next few chats of a broadcast — the drain's own shape (0082): one
 * UPDATE over a FOR UPDATE SKIP LOCKED set, so two workers never send one
 * chat twice; a claim older than ten minutes is a dead worker's and is
 * taken back.
 */
export async function claimRecipients(broadcastId: string, limit: number): Promise<bigint[]> {
  const rows = await db.execute<{ chat_id: string }>(sql`
    UPDATE broadcast_recipients SET status = 'sending', claimed_at = now()
     WHERE broadcast_id = ${broadcastId}::uuid
       AND chat_id IN (
         SELECT chat_id FROM broadcast_recipients
          WHERE broadcast_id = ${broadcastId}::uuid
            AND (status = 'pending' OR (status = 'sending' AND claimed_at < now() - interval '10 minutes'))
          ORDER BY chat_id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
    RETURNING chat_id::text AS chat_id
  `);
  return rows.map((r) => BigInt(r.chat_id));
}

export async function settleRecipient(
  broadcastId: string,
  chatId: bigint,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(broadcastRecipients)
      .set(
        outcome.ok
          ? { status: 'sent', sentAt: new Date(), error: null }
          : { status: 'failed', error: outcome.error.slice(0, 500) },
      )
      .where(and(eq(broadcastRecipients.broadcastId, broadcastId), eq(broadcastRecipients.chatId, chatId)));
    await tx
      .update(broadcasts)
      .set(outcome.ok ? { sent: sql`${broadcasts.sent} + 1` } : { failed: sql`${broadcasts.failed} + 1` })
      .where(eq(broadcasts.id, broadcastId));
  });
}

export async function finishIfDone(broadcastId: string): Promise<boolean> {
  const [left] = await db
    .select({ n: sql<string>`count(*)` })
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        inArray(broadcastRecipients.status, ['pending', 'sending']),
      ),
    );
  if (Number(left?.n ?? 0) > 0) return false;
  await db
    .update(broadcasts)
    .set({ finishedAt: new Date() })
    .where(and(eq(broadcasts.id, broadcastId), sql`${broadcasts.finishedAt} IS NULL`));
  return true;
}
