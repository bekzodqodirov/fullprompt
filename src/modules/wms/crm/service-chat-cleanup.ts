import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { attachments, tgChatRules, tgMessages, users } from '../../platform/db/schema';
import type { AuditContext } from '../../platform/audit/service';
import { decideChat, purgeExcludedChat, recordCandidates } from './chat-rules';
import { TELEGRAM_SERVICE_PEER } from './telegram-import';

/**
 * What Telegram's own service chat (777000) left in the CRM before the
 * classifiers learned to refuse it — and the one-off that clears it.
 *
 * The doors stopped KEEPING it; nothing went back for what was kept. A scan
 * may have put it on the tray as `pending`, somebody may have answered it, and
 * on a work account the listener stored its messages onto a lead it opened by
 * itself. Those messages are login codes, so they are counted here and never
 * read: the inventory carries numbers and ids, no body.
 *
 * Lives in the module rather than in the script so a test can call the same
 * function the server runs (`scripts/tg-service-chat-cleanup.ts`).
 */

export interface ServiceChatAccount {
  managerUserId: string;
  managerName: string;
  /** The tray rule, when one was ever written — null when only messages stand. */
  ruleId: string | null;
  decision: 'pending' | 'include' | 'exclude' | null;
  messages: number;
  attachments: number;
  /**
   * Leads the chat was put on — by a work account's listener or by a person.
   * Named so the owner can mark them lost; never deleted here, because a lead
   * is only ever closed with a person's reason.
   */
  leadIds: string[];
}

/** Per manager account, everything that still stands for 777000. One query per table. */
export async function serviceChatInventory(
  only: { managerUserId?: string } = {},
): Promise<ServiceChatAccount[]> {
  const rules = await db
    .select({
      id: tgChatRules.id,
      managerUserId: tgChatRules.managerUserId,
      decision: tgChatRules.decision,
      leadId: tgChatRules.leadId,
    })
    .from(tgChatRules)
    .where(
      and(
        eq(tgChatRules.peerId, TELEGRAM_SERVICE_PEER),
        only.managerUserId ? eq(tgChatRules.managerUserId, only.managerUserId) : undefined,
      ),
    );

  const messages = await db
    .select({
      managerUserId: tgMessages.managerUserId,
      n: sql<number>`count(*)::int`,
      // As text: postgres.js hands a text[] back as an array, which is all this needs.
      leadIds: sql<string[]>`coalesce(array_agg(DISTINCT ${tgMessages.leadId}::text) FILTER (WHERE ${tgMessages.leadId} IS NOT NULL), '{}')`,
    })
    .from(tgMessages)
    .where(
      and(
        eq(tgMessages.peerId, TELEGRAM_SERVICE_PEER),
        only.managerUserId ? eq(tgMessages.managerUserId, only.managerUserId) : undefined,
      ),
    )
    .groupBy(tgMessages.managerUserId);

  const files = await db
    .select({ managerUserId: tgMessages.managerUserId, n: sql<number>`count(*)::int` })
    .from(attachments)
    .innerJoin(
      tgMessages,
      and(eq(attachments.entityType, 'tg_message'), eq(attachments.entityId, tgMessages.id)),
    )
    .where(
      and(
        eq(tgMessages.peerId, TELEGRAM_SERVICE_PEER),
        only.managerUserId ? eq(tgMessages.managerUserId, only.managerUserId) : undefined,
      ),
    )
    .groupBy(tgMessages.managerUserId);

  const managerIds = [
    ...new Set([...rules.map((r) => r.managerUserId), ...messages.map((m) => m.managerUserId)]),
  ];
  if (managerIds.length === 0) return [];
  const names = new Map(
    (
      await db
        .select({ id: users.id, fullName: users.fullName })
        .from(users)
        .where(inArray(users.id, managerIds))
    ).map((u) => [u.id, u.fullName]),
  );

  return managerIds
    .map((managerUserId) => {
      const rule = rules.find((r) => r.managerUserId === managerUserId);
      const stored = messages.find((m) => m.managerUserId === managerUserId);
      const leadIds = new Set(stored?.leadIds ?? []);
      if (rule?.leadId) leadIds.add(rule.leadId);
      return {
        managerUserId,
        managerName: names.get(managerUserId) ?? managerUserId,
        ruleId: rule?.id ?? null,
        decision: (rule?.decision ?? null) as ServiceChatAccount['decision'],
        messages: Number(stored?.n ?? 0),
        attachments: Number(files.find((f) => f.managerUserId === managerUserId)?.n ?? 0),
        leadIds: [...leadIds].sort(),
      };
    })
    .sort((a, b) => a.managerName.localeCompare(b.managerName));
}

export interface ServiceChatCleaned {
  managerUserId: string;
  managerName: string;
  /** What the rule said before — null when there was none and one was written. */
  before: ServiceChatAccount['decision'];
  messages: number;
  photos: number;
  leadIds: string[];
}

/**
 * «Hech qachon» on every account's 777000, and its stored past deleted —
 * through the tray's own doors, so the audit, the agent's copies of the chat
 * and the files all go the way a person's press would take them.
 *
 * A chat stored with no rule at all (a phone match before the fix) is given
 * the `pending` row a scan would have written, because `purgeExcludedChat`
 * deletes only behind an exclude — the proof somebody decided — and that
 * proof is what this writes. Re-runnable: a second run finds an exclude and
 * nothing behind it.
 */
export async function cleanUpServiceChat(
  ctx: AuditContext,
  only: { managerUserId?: string } = {},
): Promise<ServiceChatCleaned[]> {
  const out: ServiceChatCleaned[] = [];
  for (const account of await serviceChatInventory(only)) {
    let ruleId = account.ruleId;
    if (!ruleId) {
      await recordCandidates(account.managerUserId, [
        { peerId: TELEGRAM_SERVICE_PEER, title: 'Telegram', phone: null },
      ]);
      const [written] = await db
        .select({ id: tgChatRules.id })
        .from(tgChatRules)
        .where(
          and(
            eq(tgChatRules.managerUserId, account.managerUserId),
            eq(tgChatRules.peerId, TELEGRAM_SERVICE_PEER),
          ),
        );
      ruleId = written!.id;
    }
    // Already «never» needs no second audit row saying the same.
    if (account.decision !== 'exclude') await decideChat({ id: ruleId, decision: 'exclude' }, ctx);
    const purged = await purgeExcludedChat(ruleId, ctx);
    out.push({
      managerUserId: account.managerUserId,
      managerName: account.managerName,
      before: account.decision,
      messages: purged.messages,
      photos: purged.photos,
      leadIds: account.leadIds,
    });
  }
  return out;
}
