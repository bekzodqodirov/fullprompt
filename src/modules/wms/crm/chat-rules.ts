import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, tgChatRules, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
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
    })
    .from(tgChatRules)
    .innerJoin(users, eq(tgChatRules.managerUserId, users.id))
    .leftJoin(clients, eq(tgChatRules.clientId, clients.id))
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
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
    })
    .where(eq(tgChatRules.id, input.id));

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: input.id,
    action: 'update',
    before: { decision: rule.decision, clientId: rule.clientId },
    after: { decision: input.decision, clientId },
  });
}

/** How many chats are still waiting — for the badge on the screen. */
export async function pendingCount(managerUserId?: string): Promise<number> {
  const rows = await listCandidates({ managerUserId, decision: 'pending' });
  return rows.length;
}
