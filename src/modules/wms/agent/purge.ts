import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  kbFacts,
  notifications,
  tgChatRules,
  tgPeerPulls,
  users,
} from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { composeStaffMessage } from '../../platform/notifications/service';
import { keyboardOf } from '../../platform/notifications/staff-html';
import { editText } from '../../platform/telegram/send';
import { buttonsFor } from '../../platform/telegram/staff-bot';
import { agentTablesReady } from './config';

/**
 * Every agent row of one chat, removed (review leak-9) — called by
 * `purgeExcludedChat` before it deletes the messages themselves. Every table
 * carrying (manager_user_id, peer_id) is named here, and a derived fence
 * (`tests/unit/agent-purge.test.ts`) reads the schema to say so. The cards'
 * quoted customer text is blanked; `tg_message_flags` follows its message by
 * its own ON DELETE CASCADE.
 */
export const PURGED_TABLES = [
  'agent_conversations',
  'agent_runs',
  'agent_drafts',
  'agent_outbox',
  'agent_calc_links',
  'tg_peer_pulls',
] as const;

/** What a purged chat's card says instead of what it quoted. */
export const PURGED_CARD_TEXT = '🗑 Suhbat shaxsiy deb o‘chirildi.';

export interface AgentCopy {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  userId: string;
}

/**
 * Put the CURRENT payload of these notification rows on the Telegram copies
 * already sent (`payload.tg`, the drain writes it), with the buttons the bot's
 * own `buttonsFor` draws for it now — none, for a card that is closed or
 * blanked. Best-effort by nature (Telegram refuses edits past 48 hours) and
 * always AFTER the caller's writes committed: an edit is a network call and
 * the locale read is a pooled one (#714), never inside a transaction.
 */
export async function editAgentCopies(rows: readonly AgentCopy[]): Promise<number> {
  if (!process.env.TELEGRAM_BOT_TOKEN || rows.length === 0) return 0;
  const people = [...new Set(rows.map((r) => r.userId))];
  const locales = new Map(
    (await db.select({ id: users.id, locale: users.locale }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.locale]),
  );
  let edited = 0;
  for (const row of rows) {
    const tg = row.payload.tg as { chatId?: unknown; messageId?: unknown } | undefined;
    const chatId = Number(tg?.chatId);
    const messageId = Number(tg?.messageId);
    if (!Number.isFinite(chatId) || !Number.isInteger(messageId)) continue;
    try {
      const message = composeStaffMessage(row.type, row.payload, locales.get(row.userId) ?? null);
      const res = await editText({ chatId, messageId, html: message.html, replyMarkup: keyboardOf(buttonsFor(row.type, row.payload)) });
      if (res.ok) edited += 1;
      else logger.warn({ notificationId: row.id, description: res.description }, '[agent] card copy not edited');
    } catch (err) {
      logger.warn({ err, notificationId: row.id }, '[agent] card copy not edited');
    }
  }
  return edited;
}

/**
 * Every agent card of one chat (review I5), found by what each type names:
 * a draft card by its draft, the stranger and echo cards by the chat's rule,
 * a calculation answer by any request of a chain this chat started (a
 * correction is a new request, and its answer is still this chat's), a notice
 * by the chat itself. The SQL is the one list — the fence reads it.
 */
function chatCardsWhere(input: {
  managerUserId: string;
  peerId: bigint;
  draftIds: readonly string[];
  ruleIds: readonly string[];
  requestIds: readonly string[];
}) {
  const list = (ids: readonly string[]) => (ids.length > 0 ? sql.join(ids.map((id) => sql`${id}`), sql`, `) : null);
  const drafts = list(input.draftIds);
  const rules = list(input.ruleIds);
  const requests = list(input.requestIds);
  return sql`(
       (${notifications.type} = 'AgentDraft' AND ${drafts ? sql`${notifications.payload}->>'draftId' IN (${drafts})` : sql`false`})
    OR (${notifications.type} IN ('AgentStranger', 'AgentCodeEcho') AND ${rules ? sql`${notifications.payload}->>'ruleId' IN (${rules})` : sql`false`})
    OR (${notifications.type} = 'AgentCalcAnswered' AND ${requests ? sql`${notifications.payload}->>'requestId' IN (${requests})` : sql`false`})
    OR (${notifications.type} = 'AgentNotice' AND ${notifications.userId} = ${input.managerUserId}
        AND ${notifications.payload}->>'peerId' = ${String(input.peerId)})
  )`;
}

export async function purgeAgentChat(managerUserId: string, peerId: bigint): Promise<{ drafts: number; cards: number }> {
  if (!(await agentTablesReady())) return { drafts: 0, cards: 0 };
  const out = await db.transaction(async (tx) => {
    const drafts = await tx
      .select({ id: agentDrafts.id })
      .from(agentDrafts)
      .where(and(eq(agentDrafts.managerUserId, managerUserId), eq(agentDrafts.peerId, peerId)));
    const ids = drafts.map((d) => d.id);
    const rules = await tx
      .select({ id: tgChatRules.id })
      .from(tgChatRules)
      .where(and(eq(tgChatRules.managerUserId, managerUserId), eq(tgChatRules.peerId, peerId)));
    // The chains this chat's calculations started, read BEFORE the links go.
    const requests = await tx.execute<{ id: string }>(sql`
      WITH RECURSIVE chain(id) AS (
        SELECT request_id FROM agent_calc_links WHERE manager_user_id = ${managerUserId}::uuid AND peer_id = ${String(peerId)}::bigint
        UNION
        SELECT root_request_id FROM agent_calc_links WHERE manager_user_id = ${managerUserId}::uuid AND peer_id = ${String(peerId)}::bigint
        UNION
        SELECT r.id FROM calc_requests r JOIN chain c ON r.supersedes_request_id = c.id
      )
      SELECT id::text AS id FROM chain`);
    if (ids.length > 0) {
      // Facts learned in this chat (scope client/lead, born from its drafts).
      await tx.delete(kbFacts).where(sql`${kbFacts.scope} <> 'general' AND ${kbFacts.sourceRef}->>'draftId' IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    }
    // Every card of the chat says nothing of it any more; a copy not yet sent
    // is never sent (a blank card is noise, not news) — a claimed one is the
    // drain's to finish, and the edit below reaches it once it is sent.
    const blanked = await tx
      .update(notifications)
      .set({
        payload: sql`${notifications.payload} || ${JSON.stringify({ text: PURGED_CARD_TEXT, live: false, kbAsk: false })}::jsonb`,
        status: sql`CASE WHEN ${notifications.status} = 'pending' THEN 'muted' ELSE ${notifications.status} END`,
        error: sql`CASE WHEN ${notifications.status} = 'pending' THEN 'chat purged' ELSE ${notifications.error} END`,
      })
      .where(
        and(
          sql`${notifications.type} LIKE 'Agent%'`,
          chatCardsWhere({ managerUserId, peerId, draftIds: ids, ruleIds: rules.map((r) => r.id), requestIds: requests.map((r) => r.id) }),
        ),
      )
      .returning({ id: notifications.id, type: notifications.type, payload: notifications.payload, userId: notifications.userId });
    await tx.delete(agentOutbox).where(and(eq(agentOutbox.managerUserId, managerUserId), eq(agentOutbox.peerId, peerId)));
    await tx.delete(agentCalcLinks).where(and(eq(agentCalcLinks.managerUserId, managerUserId), eq(agentCalcLinks.peerId, peerId)));
    if (ids.length > 0) await tx.delete(agentDrafts).where(inArray(agentDrafts.id, ids));
    await tx.delete(agentRuns).where(and(eq(agentRuns.managerUserId, managerUserId), eq(agentRuns.peerId, peerId)));
    await tx.delete(agentConversations).where(and(eq(agentConversations.managerUserId, managerUserId), eq(agentConversations.peerId, peerId)));
    await tx.delete(tgPeerPulls).where(and(eq(tgPeerPulls.managerUserId, managerUserId), eq(tgPeerPulls.peerId, peerId)));
    return { drafts: ids.length, blanked: blanked.map((b) => ({ ...b, payload: b.payload as Record<string, unknown> })) };
  });
  // The Telegram copies already sent, after the commit (#714): best-effort.
  await editAgentCopies(out.blanked).catch((err: unknown) => logger.warn({ err }, '[agent] purged copies not edited'));
  return { drafts: out.drafts, cards: out.blanked.length };
}
