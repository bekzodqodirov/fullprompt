import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../../platform/db/client';
import { agentDrafts, agentOutbox, calcOffers, calcRequests, notifications } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { kickTelegramDrain, notifyStaffTelegram, queueStaffTelegram } from '../../platform/notifications/staff';
import { offerStandsSql, releasedOfferWhere } from '../calc/workspace';
import { cardExtra } from './card';
import { renderDraftCard, type DraftRow } from './card-io';
import { bindMoved, chatIdentity, type AgentContext } from './context';
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

/**
 * A message the agent refuses to draft for honesty's sake (Q3, Q4 ⭐) — he is
 * told, once per anchor. The card quotes the customer's lines, so it names
 * its chat (`peerId`, the key the purge's `chatCardsWhere` matches a notice
 * by): without it a purged chat left its own words standing on this card.
 */
export async function writeNotice(ctx: AgentContext, reason: string): Promise<void> {
  const head = NOTICE_WORDS[reason] ?? `AI javob yozmadi: ${reason}`;
  const lines = ctx.burst.slice(-3).map((m) => `│ ${m.body || (m.media ? `[${m.media}]` : '—')}`);
  await notifyStaffTelegram({
    userIds: [ctx.managerUserId],
    type: 'AgentNotice',
    text: [`${head}`, customerLabel(ctx), ...lines].join('\n'),
    extra: { peerId: String(ctx.peerId) },
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
 * A VED correction replaced this request — some request names it as
 * `supersedes_request_id` (`notSupersededSql`'s rule, the money side's: a
 * correction exists, so the promise no longer stands, sealed or not). The ONE
 * question both ends of a 💵 ask: the door before a figure is drafted on it
 * (calc-loop `priceDraftFromText`) and the send step before an approved one
 * goes (`draftOfferStands`) — asked at one end only, the door drafted a reply
 * the step was certain to cancel.
 */
export async function requestRecalculated(requestId: string): Promise<boolean> {
  const [newer] = await db
    .select({ id: calcRequests.id })
    .from(calcRequests)
    .where(eq(calcRequests.supersedesRequestId, requestId))
    .limit(1);
  return newer !== undefined;
}

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
    if (await requestRecalculated(priced)) return false;
    if (!draft!.offerId) return true;
  }
  if (!draft?.offerId) return null;
  const [row] = await db
    .select({ id: calcOffers.id })
    .from(calcOffers)
    .where(and(eq(calcOffers.id, draft.offerId), releasedOfferWhere(), offerStandsSql()));
  return row !== undefined;
}

/**
 * The replies a chat's OLD owner was written for, taken back with the bind
 * (final review K7; review I1's rule): every draft still waiting for his ✅
 * under that client — or that lead — expires, because approving it later
 * would land its calculation on that card and send that customer's name and
 * codes into a chat that is no longer theirs; and an approved reply still
 * WAITING to go (the night hold, the human delay) is cancelled by
 * `agent_off`'s compare-and-set on 'agent' — the send step claims a row by
 * that same status, so a row already claimed is the one in flight and is let
 * finish (its next step asks the chat again). The cards say so. The bot's ↩
 * names the bind it takes back; the tray's doors ask the chat's identity
 * instead (`withdrawMovedReplies`).
 *
 * The DRAFTS first, then the waiting rows (ident fix F3): a ✅ committing
 * between the two writes is then caught by the second — its draft was still
 * 'pending' when the expire looked, so it either lost the expire's
 * compare-and-set or its row is already there for the cancel to find. The
 * other order let an approval slip between them: the cancel found no row yet,
 * the expire found the draft already 'approved'.
 */
export async function withdrawRepliesFor(input: {
  managerUserId: string;
  peerId: bigint;
  /** The bind being taken back: its client, or — with no client — its lead. */
  clientId: string | null;
  leadId: string | null;
  /** The outbox row's `last_error`: `identity_changed: …` (card-io's CANCEL_WORDS key). */
  why: string;
  /** The line every withdrawn card gains. */
  note: string;
}): Promise<{ expired: string[]; cancelled: string[] }> {
  if (!input.clientId && !input.leadId) return { expired: [], cancelled: [] };
  const ownedOutbox = input.clientId
    ? eq(agentOutbox.clientId, input.clientId)
    : and(isNull(agentOutbox.clientId), eq(agentOutbox.leadId, input.leadId!));
  const ownedDraft = input.clientId
    ? eq(agentDrafts.clientId, input.clientId)
    : and(isNull(agentDrafts.clientId), eq(agentDrafts.leadId, input.leadId!));
  const expired = await db
    .update(agentDrafts)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(agentDrafts.managerUserId, input.managerUserId),
        eq(agentDrafts.peerId, input.peerId),
        ownedDraft,
        inArray(agentDrafts.status, ['pending', 'editing']),
      ),
    )
    .returning({ id: agentDrafts.id });
  const cancelled = await db
    .update(agentOutbox)
    .set({ status: 'cancelled', lastError: input.why })
    .where(and(eq(agentOutbox.managerUserId, input.managerUserId), eq(agentOutbox.peerId, input.peerId), ownedOutbox, eq(agentOutbox.status, 'agent')))
    .returning({ draftId: agentOutbox.draftId });
  return withdrawn(expired.map((d) => d.id), cancelled.map((o) => o.draftId), input.note);
}

/** The withdrawn replies' cards say so — every one, whichever door took them back. */
async function withdrawn(expired: string[], cancelled: string[], note: string): Promise<{ expired: string[]; cancelled: string[] }> {
  const ids = [...expired, ...cancelled];
  if (ids.length > 0) {
    const { refreshAgentCard } = await import('./card-io');
    for (const id of ids) {
      await refreshAgentCard(id, [note]).catch((err: unknown) =>
        logger.warn({ err, draftId: id }, '[agent] withdrawn draft card not refreshed'),
      );
    }
  }
  return { expired, cancelled };
}

/**
 * The replies a chat's decision made somebody else's, taken back — asked of
 * the chat's identity AFTER the rule was written (ident fix F1/F11), by the
 * one rule the ✅ asks (`bindMoved`). Whatever the tray's door — «↩»,
 * another code, «Yangi lid», a card's «Chatni qo'shish» — a reply still
 * written for the person the chat now is stays (a phone sibling of the same
 * customer, fit-12; the client a won lead became, K25), and every other one
 * goes. A door that compared the old rule's client with the new one's took
 * back replies the ✅ would have let through, and missed the doors that
 * never asked at all.
 *
 * Drafts first, then the waiting rows — `withdrawRepliesFor`'s order (F3).
 * A chat the agent holds nothing for asks no identity at all.
 */
export async function withdrawMovedReplies(input: {
  managerUserId: string;
  peerId: bigint;
  /** The outbox row's `last_error`: `identity_changed: …` (card-io's CANCEL_WORDS key). */
  why: string;
  /** The line every withdrawn card gains. */
  note: string;
}): Promise<{ expired: string[]; cancelled: string[] }> {
  const live = await db
    .select({ id: agentDrafts.id, clientId: agentDrafts.clientId, leadId: agentDrafts.leadId })
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.managerUserId, input.managerUserId),
        eq(agentDrafts.peerId, input.peerId),
        inArray(agentDrafts.status, ['pending', 'editing']),
      ),
    );
  const waitingNow = () =>
    db
      .select({ id: agentOutbox.id, clientId: agentOutbox.clientId, leadId: agentOutbox.leadId })
      .from(agentOutbox)
      .where(and(eq(agentOutbox.managerUserId, input.managerUserId), eq(agentOutbox.peerId, input.peerId), eq(agentOutbox.status, 'agent')));
  if (live.length === 0 && (await waitingNow()).length === 0) return { expired: [], cancelled: [] };
  const now = await chatIdentity(input.managerUserId, input.peerId);
  const goneDrafts = live.filter((d) => bindMoved(d, now)).map((d) => d.id);
  const expired = goneDrafts.length
    ? await db
        .update(agentDrafts)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(and(inArray(agentDrafts.id, goneDrafts), inArray(agentDrafts.status, ['pending', 'editing'])))
        .returning({ id: agentDrafts.id })
    : [];
  // Read AFTER the expire: an approval that committed meanwhile has its row here (F3).
  const goneRows = (await waitingNow()).filter((o) => bindMoved(o, now)).map((o) => o.id);
  const cancelled = goneRows.length
    ? await db
        .update(agentOutbox)
        .set({ status: 'cancelled', lastError: input.why })
        .where(and(inArray(agentOutbox.id, goneRows), eq(agentOutbox.status, 'agent')))
        .returning({ draftId: agentOutbox.draftId })
    : [];
  return withdrawn(expired.map((d) => d.id), cancelled.map((o) => o.draftId), input.note);
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
