import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../../platform/db/client';
import { agentDrafts, agentOutbox, calcOffers, notifications } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { kickTelegramDrain, notifyStaffTelegram, queueStaffTelegram } from '../../platform/notifications/staff';
import { offerStandsSql, releasedOfferWhere } from '../calc/workspace';
import { cardExtra } from './card';
import { renderDraftCard, type DraftRow } from './card-io';
import type { AgentContext } from './context';
import type { PolicyMemory } from './policy-input';
import type { PolicyResult } from './policy';
import type { CardMemory, ComposedAction, DraftPolicyJson } from './types';

export type { CardMemory, ComposedAction, DraftPolicyJson } from './types';
import type { ComposeReply } from './run';

/**
 * The drafts and their cards (spec §17.7).
 *
 * ONE live draft per chat (0136's partial UNIQUE): a newer customer message
 * SUPERSEDES the pending one and its card is re-pointed at the new draft and
 * edited in place, so his chat with the bot holds one card per customer, not
 * a scroll of stale ones (fit-9). An 'editing' draft is never superseded —
 * he is typing an answer to it.
 */

export function customerLabel(ctx: AgentContext): string {
  const id = ctx.identity;
  if (id.clientId) {
    const codes = id.codes.map((c) => c.clientCode).join(', ');
    return id.customerName ? `${codes} · ${id.customerName}` : codes;
  }
  return `Lid: ${id.customerName ?? '—'}`;
}

function cardMemory(ctx: AgentContext): CardMemory {
  const when = (d: Date) => {
    const t = new Date(d.getTime() + 5 * 3_600_000);
    return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  };
  return {
    customerLabel: customerLabel(ctx),
    lastOut: ctx.lastOut?.body ?? null,
    customerLines: ctx.burst.map((m) => `${when(m.sentAt)} ${m.body || (m.media ? `[${m.media}]` : '—')}`),
  };
}

async function cardRowFor(tx: Tx, draftId: string) {
  const [row] = await tx
    .select({ id: notifications.id, payload: notifications.payload, status: notifications.status })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`))
    .orderBy(sql`${notifications.createdAt} DESC`)
    .limit(1);
  return row ?? null;
}

export type WriteDraftResult = { kind: 'written'; draftId: string; retargeted: boolean } | { kind: 'editing'; draftId: string };

export async function writeDraft(input: {
  runId: string;
  ctx: AgentContext;
  compose: ComposeReply;
  policy: PolicyResult;
  memory: PolicyMemory;
  actions: ComposedAction[];
  notes: string[];
}): Promise<WriteDraftResult> {
  const { ctx, compose, policy } = input;
  const card = cardMemory(ctx);
  const policyJson: DraftPolicyJson = {
    blocks: policy.blocks,
    warnings: policy.warnings,
    ledger: policy.ledger,
    memory: input.memory,
    card,
    notes: input.notes,
  };
  const out = await db.transaction(async (tx): Promise<WriteDraftResult & { cardRowId?: string; text?: string; extra?: Record<string, unknown> }> => {
    const [live] = await tx
      .select({ id: agentDrafts.id, status: agentDrafts.status })
      .from(agentDrafts)
      .where(
        and(
          eq(agentDrafts.managerUserId, ctx.managerUserId),
          eq(agentDrafts.peerId, ctx.peerId),
          inArray(agentDrafts.status, ['pending', 'editing']),
        ),
      )
      .for('update');
    if (live?.status === 'editing') return { kind: 'editing', draftId: live.id };
    if (live) {
      await tx
        .update(agentDrafts)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(eq(agentDrafts.id, live.id));
    }
    const [draft] = await tx
      .insert(agentDrafts)
      .values({
        runId: input.runId,
        managerUserId: ctx.managerUserId,
        peerId: ctx.peerId,
        clientId: ctx.identity.clientId,
        leadId: ctx.identity.leadId,
        identityStrength: ctx.identity.strength,
        anchorTgMessageId: ctx.anchor!.tgMessageId,
        anchorEditedAt: ctx.anchor!.editedAt,
        kind: 'reply',
        proposedBody: compose.replyText,
        glossUz: compose.glossUz || null,
        language: compose.language,
        category: (['greeting', 'status', 'faq', 'qualification', 'price', 'complaint', 'other'] as const).includes(
          compose.category as 'other',
        )
          ? compose.category
          : 'other',
        confidence: compose.confidence.toFixed(2),
        nextStep: compose.nextStep,
        policy: policyJson,
        blocked: !policy.ok,
        needsOwner: compose.needsOwner,
        ownerQuestion: compose.ownerQuestion || null,
        actions: input.actions,
        citedMessageIds: compose.citedMessageRefs
          .map((r) => ctx.messages.find((m) => m.ref === r)?.id)
          .filter((x): x is string => typeof x === 'string'),
      })
      .returning();
    const row = draft as DraftRow;
    const text = renderDraftCard(row, null);
    const extra = cardExtra({
      id: row.id,
      body: row.proposedBody ?? '',
      actions: input.actions,
      blocked: row.blocked,
      live: true,
      kind: row.kind,
    });
    const old = live ? await cardRowFor(tx, live.id) : null;
    if (old) {
      // The old card becomes the new one: its row now names the new draft,
      // and a copy already in Telegram is edited after the commit.
      await tx
        .update(notifications)
        .set({ payload: sql`${notifications.payload} || ${JSON.stringify({ ...extra, text })}::jsonb` })
        .where(eq(notifications.id, old.id));
      return { kind: 'written', draftId: row.id, retargeted: true };
    }
    await queueStaffTelegram(tx, { userIds: [ctx.managerUserId], type: 'AgentDraft', text, extra });
    return { kind: 'written', draftId: row.id, retargeted: false };
  });
  if (out.kind === 'written') {
    await kickTelegramDrain();
    if (out.retargeted) {
      const { refreshAgentCard } = await import('./card-io');
      await refreshAgentCard(out.draftId).catch((err: unknown) => logger.warn({ err }, '[agent] card not edited'));
    }
  }
  return out.kind === 'written' ? { kind: 'written', draftId: out.draftId, retargeted: out.retargeted } : out;
}

const NOTICE_WORDS: Record<string, string> = {
  voice_only: "🎤 Mijoz ovozli xabar yubordi — AI eshitmaydi, o'zingiz javob bering.",
  pashto: "🌐 Mijoz pushtu tilida yozdi — AI javob yozmaydi, o'zingiz javob bering.",
  bot_question: "🤖 Mijoz «siz botmisiz?» deb so'radi — qoralama yozilmadi, o'zingiz javob bering.",
};

/** A message the agent refuses to draft for honesty's sake (Q3, Q4 ⭐) — he is told, once per anchor. */
export async function writeNotice(ctx: AgentContext, reason: string): Promise<void> {
  const head = NOTICE_WORDS[reason] ?? `AI javob yozmadi: ${reason}`;
  const lines = ctx.burst.slice(-3).map((m) => `│ ${m.body || (m.media ? `[${m.media}]` : '—')}`);
  await notifyStaffTelegram({
    userIds: [ctx.managerUserId],
    type: 'AgentNotice',
    text: [`${head}`, customerLabel(ctx), ...lines].join('\n'),
  });
}

/** The first refusal of the day for a cap — said once (fit-1). */
export async function notifyCapReached(ownerUserId: string, reason: string): Promise<void> {
  const words: Record<string, string> = {
    daily_draft_cap: 'bugungi qoralamalar soni',
    daily_token_cap: 'bugungi AI byudjeti',
    chat_runs: 'bitta mijoz uchun kunlik chegara',
  };
  await notifyStaffTelegram({
    userIds: [ownerUserId],
    type: 'AgentCapReached',
    text: `⛔ AI sotuvchi: ${words[reason] ?? reason} tugadi — qolgan xabarlarga bugun o'zingiz javob bering. Chegarani «Suhbatlar → AI sotuvchi» sahifasida o'zgartirish mumkin.`,
  });
}

/** A price reply's offer still stands — released and not superseded; null when the draft carries none. */
export async function draftOfferStands(draftId: string): Promise<boolean | null> {
  const [draft] = await db.select({ offerId: agentDrafts.offerId }).from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!draft?.offerId) return null;
  const [row] = await db
    .select({ id: calcOffers.id })
    .from(calcOffers)
    .where(and(eq(calcOffers.id, draft.offerId), releasedOfferWhere(), offerStandsSql()));
  return row !== undefined;
}

/** The card of the draft this outbox row carries is re-rendered with the outcome. */
export async function refreshCardForOutbox(outboxId: string): Promise<void> {
  const [row] = await db
    .select({ draftId: agentOutbox.draftId })
    .from(agentOutbox)
    .where(eq(agentOutbox.id, outboxId));
  if (!row) return;
  try {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(row.draftId);
  } catch (err) {
    logger.warn({ err, outboxId }, '[agent] card not refreshed');
  }
}
