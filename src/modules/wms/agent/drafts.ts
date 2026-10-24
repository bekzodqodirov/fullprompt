import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../../platform/db/client';
import { agentDrafts, agentOutbox, calcOffers, calcRequests, notifications } from '../../platform/db/schema';
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

/** Everything a new draft row carries — the machine's reply, a price, a hand-back question. */
export interface NewDraft {
  runId: string | null;
  managerUserId: string;
  peerId: bigint;
  clientId: string | null;
  leadId: string | null;
  identityStrength: string | null;
  anchorTgMessageId: bigint;
  anchorEditedAt: Date | null;
  kind: 'reply' | 'price' | 'hand_back';
  body: string;
  glossUz: string | null;
  language: string | null;
  category: string | null;
  confidence: number | null;
  nextStep: string | null;
  policy: DraftPolicyJson;
  blocked: boolean;
  needsOwner: boolean;
  ownerQuestion: string | null;
  actions: ComposedAction[];
  citedMessageIds: string[];
  offerId: string | null;
}

const CATEGORIES = ['greeting', 'status', 'faq', 'qualification', 'price', 'complaint', 'other'];

/**
 * Write a draft and its card in ONE short transaction: the chat's live
 * draft is superseded (unless he is editing it), the new row inserted, and
 * the card either re-points the old card's row or is queued fresh. The drain
 * is kicked — and a sent copy edited — only after the commit.
 */
export async function createDraft(n: NewDraft): Promise<WriteDraftResult> {
  const out = await db.transaction(async (tx): Promise<WriteDraftResult> => {
    const [live] = await tx
      .select({ id: agentDrafts.id, status: agentDrafts.status })
      .from(agentDrafts)
      .where(
        and(
          eq(agentDrafts.managerUserId, n.managerUserId),
          eq(agentDrafts.peerId, n.peerId),
          inArray(agentDrafts.status, ['pending', 'editing']),
        ),
      )
      .for('update');
    if (live?.status === 'editing') return { kind: 'editing', draftId: live.id };
    if (live) {
      await tx.update(agentDrafts).set({ status: 'superseded', updatedAt: new Date() }).where(eq(agentDrafts.id, live.id));
    }
    const [draft] = await tx
      .insert(agentDrafts)
      .values({
        runId: n.runId,
        managerUserId: n.managerUserId,
        peerId: n.peerId,
        clientId: n.clientId,
        leadId: n.clientId ? null : n.leadId,
        identityStrength: n.identityStrength,
        anchorTgMessageId: n.anchorTgMessageId,
        anchorEditedAt: n.anchorEditedAt,
        kind: n.kind,
        proposedBody: n.body,
        glossUz: n.glossUz,
        language: n.language,
        category: n.category && CATEGORIES.includes(n.category) ? n.category : 'other',
        confidence: n.confidence === null ? null : n.confidence.toFixed(2),
        nextStep: n.nextStep,
        policy: n.policy,
        blocked: n.blocked,
        needsOwner: n.needsOwner,
        ownerQuestion: n.ownerQuestion,
        actions: n.actions,
        citedMessageIds: n.citedMessageIds,
        offerId: n.offerId,
      })
      .returning();
    const row = draft as DraftRow;
    const text = renderDraftCard(row, null);
    const extra = cardExtra({ id: row.id, body: row.proposedBody ?? '', actions: n.actions, blocked: row.blocked, live: true, kind: row.kind });
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
    await queueStaffTelegram(tx, { userIds: [n.managerUserId], type: 'AgentDraft', text, extra });
    return { kind: 'written', draftId: row.id, retargeted: false };
  });
  if (out.kind === 'written') {
    await kickTelegramDrain();
    if (out.retargeted) {
      const { refreshAgentCard } = await import('./card-io');
      await refreshAgentCard(out.draftId).catch((err: unknown) => logger.warn({ err }, '[agent] card not edited'));
    }
  }
  return out;
}

/** The machine's reply to the chat, from a run. */
export async function writeDraft(input: {
  runId: string;
  ctx: AgentContext;
  compose: ComposeReply;
  policy: PolicyResult;
  memory: PolicyMemory;
  actions: ComposedAction[];
  notes: string[];
  kind?: 'reply' | 'hand_back';
}): Promise<WriteDraftResult> {
  const { ctx, compose, policy } = input;
  return createDraft({
    runId: input.runId,
    managerUserId: ctx.managerUserId,
    peerId: ctx.peerId,
    clientId: ctx.identity.clientId,
    leadId: ctx.identity.leadId,
    identityStrength: ctx.identity.strength,
    anchorTgMessageId: ctx.anchor!.tgMessageId,
    anchorEditedAt: ctx.anchor!.editedAt,
    kind: input.kind ?? 'reply',
    body: compose.replyText,
    glossUz: compose.glossUz || null,
    language: compose.language,
    category: compose.category,
    confidence: compose.confidence,
    nextStep: compose.nextStep,
    policy: {
      blocks: policy.blocks,
      warnings: policy.warnings,
      ledger: policy.ledger,
      memory: input.memory,
      card: cardMemory(ctx),
      notes: input.notes,
    },
    blocked: !policy.ok,
    needsOwner: compose.needsOwner,
    ownerQuestion: compose.ownerQuestion || null,
    actions: input.actions,
    citedMessageIds: compose.citedMessageRefs
      .map((r) => ctx.messages.find((m) => m.ref === r)?.id)
      .filter((x): x is string => typeof x === 'string'),
    offerId: null,
  });
}

export { cardMemory };

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * A price reply's figure still stands; null when the draft carries none.
 *
 * Two anchors. Since his 6 b a 💵 writes no offer row — the figure answers
 * the REQUEST it was typed on (`policy.priceRequestId`), and it stops
 * standing the moment a VED recalculation supersedes that request
 * (`notSupersededSql`'s rule, the money side's: a correction exists, so the
 * promise no longer stands — sealed or not). Without this an approval he made
 * before the recalc, waiting in agent_outbox (the night hold, the gaps), went
 * out with the old figure: there was no offer to be gone (answers review). A
 * draft from before 6 b still carries an offer row, asked as before.
 */
export async function draftOfferStands(draftId: string): Promise<boolean | null> {
  const [draft] = await db
    .select({ offerId: agentDrafts.offerId, kind: agentDrafts.kind, policy: agentDrafts.policy })
    .from(agentDrafts)
    .where(eq(agentDrafts.id, draftId));
  const priced = draft?.kind === 'price' ? ((draft.policy ?? {}) as { priceRequestId?: unknown }).priceRequestId : undefined;
  if (typeof priced === 'string' && UUID.test(priced)) {
    const [newer] = await db
      .select({ id: calcRequests.id })
      .from(calcRequests)
      .where(eq(calcRequests.supersedesRequestId, priced))
      .limit(1);
    if (newer) return false;
    if (!draft!.offerId) return true;
  }
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
