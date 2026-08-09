import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  attachments,
  clients,
  leads,
  tgChatRules,
  tgMessages,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { getStorage } from '../../platform/files/storage';
import { leadForChat } from './chat-lead';
import type { ChatRule } from './telegram-import';

/**
 * The chats a person has said yes or no to.
 *
 * Owner: "shunda feature qo'sh — qaysi chatlarni qo'shish kerak va qaysini
 * qo'shmaslik." The automatic phone match stays; this is what sits on top of
 * it, in both directions.
 *
 * Everything here is per MANAGER. The same Telegram user is a client in one
 * person's phone and a friend in another's, and a decision in one account must
 * never silently apply to somebody else's.
 */

export class ChatRuleError extends Error {}

/** The rules the import and the listener consult, keyed by peer. */
export async function rulesFor(managerUserId: string): Promise<Map<bigint, ChatRule>> {
  const rows = await db
    .select({
      peerId: tgChatRules.peerId,
      decision: tgChatRules.decision,
      clientId: tgChatRules.clientId,
      clientCode: clients.clientCode,
      leadId: tgChatRules.leadId,
    })
    .from(tgChatRules)
    .leftJoin(clients, eq(tgChatRules.clientId, clients.id))
    .where(eq(tgChatRules.managerUserId, managerUserId));

  return new Map(
    rows.map((r) => [
      r.peerId,
      {
        peerId: r.peerId,
        decision: r.decision as ChatRule['decision'],
        clientId: r.clientId,
        clientCode: r.clientCode,
        leadId: r.leadId,
      },
    ]),
  );
}

export interface CandidateInput {
  peerId: bigint;
  title: string;
  phone: string | null;
}

/**
 * Record what a scan found, without answering anything.
 *
 * Called only by `pnpm tg-scan`, which a manager runs against their own
 * account. It refreshes the label on rows that already exist — a person may
 * have changed their Telegram name since the last scan, and deciding from a
 * stale name is deciding about the wrong person — but it never touches
 * `decision`: an answer already given is not a question to ask again.
 */
export async function recordCandidates(
  managerUserId: string,
  found: CandidateInput[],
): Promise<{ added: number; refreshed: number }> {
  if (found.length === 0) return { added: 0, refreshed: 0 };
  const existing = await db
    .select({ peerId: tgChatRules.peerId })
    .from(tgChatRules)
    .where(
      and(
        eq(tgChatRules.managerUserId, managerUserId),
        inArray(
          tgChatRules.peerId,
          found.map((f) => f.peerId),
        ),
      ),
    );
  const known = new Set(existing.map((e) => e.peerId));

  for (const item of found) {
    if (known.has(item.peerId)) {
      await db
        .update(tgChatRules)
        .set({ peerTitle: item.title, peerPhone: item.phone })
        .where(
          and(
            eq(tgChatRules.managerUserId, managerUserId),
            eq(tgChatRules.peerId, item.peerId),
          ),
        );
      continue;
    }
    await db.insert(tgChatRules).values({
      managerUserId,
      peerId: item.peerId,
      decision: 'pending',
      peerTitle: item.title,
      peerPhone: item.phone,
    });
  }
  return { added: found.length - known.size, refreshed: known.size };
}

export interface CandidateRow {
  id: string;
  peerId: string;
  managerUserId: string;
  managerName: string;
  decision: string;
  title: string | null;
  phone: string | null;
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  leadId: string | null;
  leadName: string | null;
}

/**
 * The chats waiting for an answer, or already answered.
 *
 * `managerUserId` narrows it to one person's account, and the screen passes
 * the VIEWER's own id unless they are allowed to see everybody's. That is the
 * whole privacy design of this feature: a scan puts the NAMES of a manager's
 * unmatched chats — their family, their friends — in a table, and the only
 * people who should read that list are the manager themselves and the owner.
 */
export async function listCandidates(filter: {
  managerUserId?: string;
  decision?: 'pending' | 'include' | 'exclude';
}): Promise<CandidateRow[]> {
  const where = [
    filter.managerUserId ? eq(tgChatRules.managerUserId, filter.managerUserId) : undefined,
    filter.decision ? eq(tgChatRules.decision, filter.decision) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      id: tgChatRules.id,
      peerId: tgChatRules.peerId,
      managerUserId: tgChatRules.managerUserId,
      managerName: users.fullName,
      decision: tgChatRules.decision,
      title: tgChatRules.peerTitle,
      phone: tgChatRules.peerPhone,
      clientId: tgChatRules.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      leadId: tgChatRules.leadId,
      leadName: leads.name,
    })
    .from(tgChatRules)
    .innerJoin(users, eq(tgChatRules.managerUserId, users.id))
    .leftJoin(clients, eq(tgChatRules.clientId, clients.id))
    .leftJoin(leads, eq(tgChatRules.leadId, leads.id))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(asc(tgChatRules.peerTitle));

  // `peerId` is a bigint and this crosses to a client component; it goes as a
  // string, because JSON has no bigint and a silent precision loss on a
  // Telegram id would point a decision at the wrong person.
  return rows.map((r) => ({ ...r, peerId: r.peerId.toString() }));
}

/**
 * Answer one chat.
 *
 * `include` demands a client, and so does the table — the check is in the
 * schema as well as here, because `tg_messages.client_id` is NOT NULL and a
 * rule without a client would promise a message a home it does not have.
 *
 * Audited like every other decision that changes what the company keeps: who
 * said this chat was a client's, and when.
 */
export async function decideChat(
  input: {
    id: string;
    decision: 'include' | 'exclude' | 'pending';
    clientId?: string | null;
  },
  ctx: AuditContext,
): Promise<void> {
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, input.id));
  if (!rule) throw new ChatRuleError('chat_rule_not_found');

  const clientId = input.decision === 'include' ? (input.clientId ?? null) : null;
  if (input.decision === 'include' && !clientId) throw new ChatRuleError('client_required');
  if (clientId) {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    if (!client) throw new ChatRuleError('client_not_found');
  }

  await db
    .update(tgChatRules)
    .set({
      decision: input.decision,
      clientId,
      // This is the CLIENT door. Answering here always retires a lead pointer
      // set by the other one — a chat that belongs to GS777 does not also
      // belong to the lead it was opened as, and «hech qachon» belongs to
      // nobody. Leaving it would make the listener store onto a lead the
      // screen no longer shows.
      leadId: null,
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
    })
    .where(eq(tgChatRules.id, input.id));

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: input.id,
    action: 'update',
    before: { decision: rule.decision, clientId: rule.clientId, leadId: rule.leadId },
    after: { decision: input.decision, clientId, leadId: null },
  });
}

/**
 * The third answer the tray could not give: «this is business, but they are
 * nobody yet».
 *
 * 0064 taught the listener to open a lead by itself on a WORK number; on a
 * personal one it asks instead, and the only answers on offer were a client
 * from the book and «never». A person writing in for the first time is
 * neither — which is the exact case the owner reported as invisible.
 *
 * It goes through `leadForChat`, so the rule that matters most is inherited
 * rather than restated: an OPEN lead already carrying this number wins, and
 * pressing twice does not mint twice. The lead is owned by the manager whose
 * account the chat is in, not by whoever pressed — the owner reading his
 * staff's tray must not collect their leads.
 *
 * Future only, exactly like «Qo'shish» for a client: this attaches the chat,
 * it does not import what was said before the press. Round 79's promise was
 * that nothing is stored until somebody answers, and reaching backwards
 * through Telegram for the history is a separate decision.
 */
export async function openLeadForChat(
  ruleId: string,
  ctx: AuditContext,
): Promise<{ leadId: string }> {
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
  if (!rule) throw new ChatRuleError('chat_rule_not_found');
  const phone = (rule.peerPhone ?? '').trim();
  // The same refusal `unknownChatAction` makes about `no_phone`: a lead
  // nobody can ring is a row with a name in it.
  if (!phone) throw new ChatRuleError('chat_no_phone');

  const leadId = await leadForChat(
    rule.managerUserId,
    { phone, title: rule.peerTitle },
    ctx,
  );

  await db
    .update(tgChatRules)
    .set({
      decision: 'include',
      leadId,
      clientId: null,
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
    })
    .where(eq(tgChatRules.id, ruleId));

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: ruleId,
    action: 'update',
    before: { decision: rule.decision, clientId: rule.clientId, leadId: rule.leadId },
    after: { decision: 'include', clientId: null, leadId },
  });
  return { leadId };
}

/**
 * «Chatni qo'shish» from a card, the other end of the owner's loop.
 *
 * The tray asks about a chat and hands it a card; this asks about a CARD and
 * hands it a chat — `managersWhoTalkedTo` found the number on somebody's
 * account, and this is the press that starts keeping that conversation.
 *
 * `managerUserId` is the VIEWER's own id and is never taken from the form: a
 * match names a colleague so the person creating the card knows who to ask,
 * and round 20's fence says knowing a conversation exists is not permission
 * to open it. Attaching somebody else's chat would do exactly that, on their
 * behalf, without them ever pressing anything.
 *
 * Future only, like every other include: this decides what is kept from now
 * on. What was said before the press is `pnpm tg-import`'s business.
 */
export async function attachPeerToCard(
  input: {
    peerId: bigint;
    managerUserId: string;
    clientId?: string | null;
    leadId?: string | null;
  },
  ctx: AuditContext,
): Promise<void> {
  const clientId = input.clientId ?? null;
  const leadId = input.leadId ?? null;
  // The CHECK says the same thing in the database; saying it here too is what
  // turns a constraint violation into a sentence somebody can act on.
  if (!clientId && !leadId) throw new ChatRuleError('owner_required');

  const [row] = await db
    .insert(tgChatRules)
    .values({
      managerUserId: input.managerUserId,
      peerId: input.peerId,
      decision: 'include',
      clientId,
      leadId,
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [tgChatRules.managerUserId, tgChatRules.peerId],
      set: {
        decision: 'include',
        clientId,
        leadId,
        decidedBy: ctx.actorId,
        decidedAt: new Date(),
      },
    })
    .returning({ id: tgChatRules.id });

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: row!.id,
    action: 'update',
    after: { decision: 'include', clientId, leadId, reason: 'attached_from_card' },
  });
}

/**
 * Stop taking a conversation that the phone rule DOES match.
 *
 * The other half of the owner's ask, and it was unreachable: `scanVerdict`
 * returns `'auto'` for anything the automatic rule already keeps, the scan
 * only records `'ask'` verdicts, and `recordCandidates` is the sole writer of
 * `tg_chat_rules` — so there was no route by which a matched chat could ever
 * be given an `exclude`. «Qo'shish» worked; «qo'shmaslik» did not.
 *
 * It is reachable from the conversation itself rather than from the list, and
 * that is the better place anyway: you are looking at the chat you are
 * deciding about, instead of judging a name on a page.
 *
 * Future only. It stops new messages being stored; what is already in
 * `tg_messages` stays, because deleting a client's conversation is a separate
 * decision with its own consequences — and this button must not quietly be
 * the one that takes it.
 */
export async function excludeChatForClient(
  input: { clientId: string; managerUserId: string; peerId: bigint },
  ctx: AuditContext,
): Promise<void> {
  const [row] = await db
    .insert(tgChatRules)
    .values({
      managerUserId: input.managerUserId,
      peerId: input.peerId,
      decision: 'exclude',
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
    })
    // A chat can already have a rule — most usefully a `pending` one from a
    // scan, or an `include` somebody is changing their mind about.
    .onConflictDoUpdate({
      target: [tgChatRules.managerUserId, tgChatRules.peerId],
      set: {
        decision: 'exclude',
        clientId: null,
        // …and the lead pointer with it (0065): «qo'shma» must leave the rule
        // owning nobody, or the listener would go on storing onto the lead.
        leadId: null,
        decidedBy: ctx.actorId,
        decidedAt: new Date(),
      },
    })
    .returning({ id: tgChatRules.id });

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: row!.id,
    action: 'update',
    after: { decision: 'exclude', clientId: input.clientId, reason: 'excluded_from_conversation' },
  });
}

/** How many chats are still waiting — for the badge on the screen. */
export async function pendingCount(managerUserId?: string): Promise<number> {
  const rows = await listCandidates({ managerUserId, decision: 'pending' });
  return rows.length;
}

/**
 * Stored rows still standing behind each EXCLUDED chat — so the screen can
 * offer the purge only where there is something to purge, with the number
 * on the button. One grouped query for the whole list.
 */
export async function excludedLeftovers(
  rules: { id: string; managerUserId: string; peerId: bigint }[],
): Promise<Map<string, number>> {
  if (rules.length === 0) return new Map();
  const out = new Map<string, number>();
  for (const rule of rules) {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(tgMessages)
      .where(
        and(eq(tgMessages.managerUserId, rule.managerUserId), eq(tgMessages.peerId, rule.peerId)),
      );
    const n = Number(row?.n ?? 0);
    if (n > 0) out.set(rule.id, n);
  }
  return out;
}

/**
 * «Qo'shma» from the conversation itself, as the OWNER expects it to work
 * (his report, 2026-07-29: «qo'shma desa hali ham sistemada turibti»):
 * exclude the chat AND delete what was already stored, in one press. The
 * confirm on the button states both consequences before the press — the
 * two-step design (#388) survives on the «Qaysi chatlar» screen for rules
 * that were excluded without this button.
 */
export async function excludeAndPurgeChat(
  input: { clientId: string; managerUserId: string; peerId: bigint },
  ctx: AuditContext,
): Promise<{ messages: number; photos: number }> {
  await excludeChatForClient(input, ctx);
  const [rule] = await db
    .select({ id: tgChatRules.id })
    .from(tgChatRules)
    .where(
      and(
        eq(tgChatRules.managerUserId, input.managerUserId),
        eq(tgChatRules.peerId, input.peerId),
      ),
    );
  return purgeExcludedChat(rule!.id, ctx);
}

/**
 * The SEPARATE decision `excludeChatForClient` refused to take quietly:
 * delete what was already stored for an excluded chat — the messages and
 * the photographs that came with them.
 *
 * Explicit, per chat, and only AFTER the exclude: the rule row is the
 * proof somebody decided this conversation is not the company's to keep,
 * and this second press is them saying the past of it is not either.
 * Audited with the counts, because "who deleted a conversation and when"
 * is exactly the question the audit log exists for. Deliberately NOT
 * touched: `tg_outbox` — those are replies the COMPANY sent through its
 * own screens, a record of our side's actions, not of the excluded chat.
 */
export async function purgeExcludedChat(
  ruleId: string,
  ctx: AuditContext,
): Promise<{ messages: number; photos: number }> {
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
  if (!rule) throw new ChatRuleError('chat_rule_not_found');
  // Only an excluded chat: purging an INCLUDED client's conversation is a
  // different (and refused) act — exclude it first, on the same screen.
  if (rule.decision !== 'exclude') throw new ChatRuleError('not_excluded');

  const rows = await db
    .select({ id: tgMessages.id })
    .from(tgMessages)
    .where(
      and(eq(tgMessages.managerUserId, rule.managerUserId), eq(tgMessages.peerId, rule.peerId)),
    );
  if (rows.length === 0) return { messages: 0, photos: 0 };
  const messageIds = rows.map((r) => r.id);

  // The photographs first: rows, then bytes. Storage deletion is
  // best-effort AFTER the rows are gone — an orphaned object in MinIO is
  // waste; a database row pointing at deleted bytes is a broken screen.
  const photoRows = await db
    .select({
      id: attachments.id,
      storageKey: attachments.storageKey,
      thumb200Key: attachments.thumb200Key,
      thumb800Key: attachments.thumb800Key,
    })
    .from(attachments)
    .where(
      and(eq(attachments.entityType, 'tg_message'), inArray(attachments.entityId, messageIds)),
    );
  if (photoRows.length > 0) {
    await db.delete(attachments).where(
      inArray(
        attachments.id,
        photoRows.map((p) => p.id),
      ),
    );
  }
  await db.delete(tgMessages).where(inArray(tgMessages.id, messageIds));

  const storage = getStorage();
  for (const photo of photoRows) {
    for (const key of [photo.storageKey, photo.thumb200Key, photo.thumb800Key]) {
      if (!key) continue;
      await storage.delete(key).catch(() => {});
    }
  }

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: ruleId,
    action: 'update',
    after: {
      purged: true,
      messages: messageIds.length,
      photos: photoRows.length,
    },
  });
  return { messages: messageIds.length, photos: photoRows.length };
}
