import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  agentDrafts,
  calcRequests,
  tgMessageFlags,
  tgMessages,
} from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { parseTypedMoney } from '../calc/money-input';
import { agentRunning, readAgentConfig } from './config';
import { chatIdentity } from './context';
import { createDraft } from './drafts';
import { AGENT_LOCALES, type AgentLocale } from './locale';
import { ownerPolicyFor } from './policy-input';
import { priceReplyText } from './price-reply';
import { JOB_AGENT_HAND_BACK, type AgentHandBackJob } from './queues';
import type { RunDeps } from './run';

/**
 * The calculation loop (his 8, regression-5, money-4, money-7).
 *
 * The agent sends a job to the VED queue through the bot's own door; when the
 * VED answers — «Готово», a seal, a hand-back, a recalculation, and the AI-VED
 * pre-pass's estimate labelled «rasmiy emas» (his Q5 ⭐ c) — the AGENT OWNER
 * hears it as `AgentCalcAnswered`: its own type, so a «vazifalar» mute never
 * swallows the one message decision 8 exists for, and with NO exceptUserId, so
 * pressing Готово himself still gives him the door (his Q15 ⭐). Resolved through
 * the CHAIN ROOT: a correction is a new request, and its answer still belongs
 * to the chat that asked.
 *
 * The answer's figure is HIS to read (he is the owner) and is never a source
 * the machine may quote (leak-10): «💵 Narx yozaman» turns the dollars HE
 * types into one deterministic sentence for the customer (`priceReplyText`)
 * — no model call between his number and the customer, and, by his 6 b
 * (2026-10-24), nothing written on the deal card: no offer row, no floor
 * approval, no upsale. The price goes to the customer only.
 */

export type CalcEvent = 'done' | 'sealed' | 'returned' | 'recalc' | 'estimate';

const SECTION_WORDS: Record<string, string> = { yolkira: "yo'lkira", rastamojka: 'rastamojka', podklyuch: 'podklyuch' };

/** The chain's root: walk `supersedes_request_id` up (a correction is a new request, #923). */
export async function chainRoot(requestId: string): Promise<string> {
  let id = requestId;
  for (let i = 0; i < 20; i++) {
    const [row] = await db
      .select({ parent: calcRequests.supersedesRequestId })
      .from(calcRequests)
      .where(eq(calcRequests.id, id));
    if (!row?.parent) return id;
    id = row.parent;
  }
  return id;
}

async function linkFor(requestId: string) {
  const root = await chainRoot(requestId);
  const [link] = await db
    .select()
    .from(agentCalcLinks)
    .where(or(eq(agentCalcLinks.requestId, root), eq(agentCalcLinks.rootRequestId, root), eq(agentCalcLinks.requestId, requestId)))
    .orderBy(desc(agentCalcLinks.createdAt))
    .limit(1);
  return link ?? null;
}

function labelOf(identity: Awaited<ReturnType<typeof chatIdentity>>): string {
  if (identity.clientId) {
    const codes = identity.codes.map((c) => c.clientCode).join(', ');
    return identity.customerName ? `${codes} · ${identity.customerName}` : codes;
  }
  return `Lid: ${identity.customerName ?? '—'}`;
}

export interface AnnounceDeps {
  /** Tests: the hand-back job's sender (pg-boss's `enqueue` otherwise). */
  enqueue?: (name: string, data: AgentHandBackJob, options: { retryLimit: number }) => Promise<void>;
}

/**
 * Tell the agent owner a linked calculation moved. Best-effort: every caller
 * wraps this in its own catch, after its own push — the existing messages
 * must not wait on, or fail with, this one.
 */
export async function announceAgentCalc(
  requestId: string,
  event: CalcEvent,
  detail: { amountText?: string | null; reason?: string | null } = {},
  deps: AnnounceDeps = {},
): Promise<boolean> {
  const config = await readAgentConfig();
  if (!config) return false;
  const link = await linkFor(requestId);
  if (!link) return false;
  if (config.ownerUserId !== link.managerUserId) return false;
  const identity = await chatIdentity(link.managerUserId, link.peerId);
  const [req] = await db.select({ section: calcRequests.section }).from(calcRequests).where(eq(calcRequests.id, requestId));
  const section = SECTION_WORDS[req?.section ?? ''] ?? req?.section ?? '';
  const who = labelOf(identity);
  const lines: Record<CalcEvent, string> = {
    done: `💵 Hisob javobi keldi — ${who}\n${section}: ${detail.amountText ?? '—'}\nNarx bersangiz bo'ladi.`,
    sealed: `💵 Hisob muhrlandi — ${who}\n${section}: ${detail.amountText ?? '—'}\nNarx bersangiz bo'ladi.`,
    estimate: `🤖 AI-VED taxmini (rasmiy emas) — ${who}\n${section}: ${detail.amountText ?? '—'}\nVED javobini kuting yoki shu bilan narx bering.`,
    returned: `🔁 VED hisobni qaytardi — ${who}\n${detail.reason ?? ''}`,
    recalc: `🔄 Qayta hisoblanmoqda — ${who}\n${section}: eski narx endi amal qilmaydi.`,
  };
  await notifyStaffTelegram({
    userIds: [link.managerUserId],
    type: 'AgentCalcAnswered',
    text: lines[event],
    extra: { requestId, priceable: event === 'done' || event === 'sealed' || event === 'estimate', event },
  });
  await db
    .update(agentCalcLinks)
    .set({ lastNotifiedKind: event, lastNotifiedAt: new Date() })
    .where(eq(agentCalcLinks.requestId, link.requestId));
  if (event === 'returned' && agentRunning(config)) {
    // The hand-back's question goes to the CUSTOMER as a draft he approves —
    // the seller-facing reason is the model's instruction, never the reply.
    // QUEUED, never run here (review regression-3): this is called from the
    // VED's «Qaytarish», and a model run inline made the VED's button — and
    // the seller's «↩️ Ma'lumot to'ldiring» task behind it — wait on the
    // model for as long as the model took. The worker runs it; retryLimit 0
    // because a re-delivered model call is a second bill, and the run's own
    // source_key UNIQUE keeps one hand-back one draft.
    const job: AgentHandBackJob = {
      managerUserId: link.managerUserId,
      peerId: String(link.peerId),
      requestId,
      reason: (detail.reason ?? '').slice(0, 500),
    };
    const send = deps.enqueue ?? (async (name, data, options) => (await import('../../platform/jobs/boss')).enqueue(name, data, options));
    await send(JOB_AGENT_HAND_BACK, job, { retryLimit: 0 }).catch((err: unknown) =>
      logger.error({ err, requestId }, '[agent] hand-back not queued'),
    );
  }
  return true;
}

/** The hand-back run's instruction — the VED's reason is for the model, never for the customer word for word. */
export function handBackInstruction(reason: string): string {
  return `VED hisobni qaytardi, sababi (ichki, mijozga so'zma-so'z aytma): «${reason}». Mijozdan yetishmayotganini qisqa so'ra.`;
}

/** The worker's side of `JOB_AGENT_HAND_BACK`: the owner-triggered run, keyed by the request. */
export async function handleHandBack(job: AgentHandBackJob, deps: RunDeps = {}) {
  const { runOwnerTriggered } = await import('./run');
  return runOwnerTriggered(
    {
      trigger: 'hand_back',
      managerUserId: job.managerUserId,
      peerId: BigInt(job.peerId),
      sourceKey: `${job.requestId}:returned`,
      instruction: handBackInstruction(job.reason),
    },
    deps,
  );
}

/** `announceAgentCalc`, never throwing — the shape every calc hook calls. */
export async function announceAgentCalcSafe(
  requestId: string,
  event: CalcEvent,
  detail: { amountText?: string | null; reason?: string | null } = {},
): Promise<void> {
  try {
    await announceAgentCalc(requestId, event, detail);
  } catch (err) {
    logger.error({ err, requestId, event }, '[agent] calc announce failed');
  }
}

/**
 * Why «💵 Narx yozaman» wrote nothing. `pending` is no longer returned — there
 * is no floor approval now that nothing reaches the deal card (his 6 b) — and
 * stays in the union only while the bot's `PRICE_WORDS` (bot-door.ts) still
 * names it; `refused` carries its reason as WORDS in `detail`.
 */
export type PriceRefusal = 'not_linked' | 'not_account_holder' | 'bad_number' | 'pending' | 'no_anchor' | 'refused';

/** Above this a typed «price» is a slip, not a quote — and past it the grouping would print an exponent. */
const PRICE_MAX_USD = 1_000_000_000;

/** His typed dollars, or null: positive, at most cents, below the cap. Never rounded — a figure he did not type is not his. */
export function typedPriceUsd(text: string): number | null {
  const amount = parseTypedMoney(text.replace(/\$|usd|dollar/giu, ''));
  if (amount === null || !(amount > 0) || amount >= PRICE_MAX_USD) return null;
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) return null;
  return amount;
}

const EDITING_WORDS = "bu suhbatda siz yozayotgan javob bor — avval uni tugating yoki ❌ bilan yoping";

/**
 * «💵 Narx yozaman»: his typed dollars → a price draft whose body is ONE
 * deterministic sentence in the customer's language carrying exactly his
 * figure (`priceReplyText`). Nothing else is written — no offer row, no deal
 * card, no floor approval (his 6 b) — so it works the same on an AI-VED
 * «taxmin» card, which has no seal and no Готово to anchor an offer on.
 *
 * Every refusal is decided BEFORE anything is written: not linked, not the
 * account holder, a number that is not a price, no customer message to
 * answer, his own reply to this chat being typed (an 'editing' draft is
 * never superseded, drafts.ts).
 */
export async function priceDraftFromText(
  staffId: string,
  requestId: string,
  text: string,
): Promise<{ ok: true; draftId: string } | { ok: false; code: PriceRefusal; detail?: string }> {
  const link = await linkFor(requestId);
  if (!link) return { ok: false, code: 'not_linked' };
  if (link.managerUserId !== staffId) return { ok: false, code: 'not_account_holder' };
  const amount = typedPriceUsd(text);
  if (amount === null) return { ok: false, code: 'bad_number' };
  const [req] = await db
    .select({ section: calcRequests.section })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  if (!req) return { ok: false, code: 'no_anchor' };
  const [editing] = await db
    .select({ id: agentDrafts.id })
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.managerUserId, link.managerUserId),
        eq(agentDrafts.peerId, link.peerId),
        eq(agentDrafts.status, 'editing'),
      ),
    );
  if (editing) return { ok: false, code: 'refused', detail: EDITING_WORDS };
  const [conv] = await db
    .select({ locale: agentConversations.locale })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, link.managerUserId), eq(agentConversations.peerId, link.peerId)));
  const locale: AgentLocale = AGENT_LOCALES.find((l) => l === conv?.locale) ?? 'uz';
  const identity = await chatIdentity(link.managerUserId, link.peerId);
  const body = priceReplyText(locale, req.section, amount);

  // The draft answers the chat's newest live inbound.
  const [anchor] = await db
    .select({ tgMessageId: tgMessages.tgMessageId, editedAt: tgMessages.editedAt })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(
      and(
        eq(tgMessages.managerUserId, link.managerUserId),
        eq(tgMessages.peerId, link.peerId),
        eq(tgMessages.direction, 'in'),
        isNull(tgMessageFlags.deletedAt),
      ),
    )
    .orderBy(desc(tgMessages.sentAt))
    .limit(1);
  if (!anchor) return { ok: false, code: 'no_anchor' };
  const policy = await ownerPolicyFor(body, identity.codes.map((c) => c.clientCode));
  const written = await createDraft({
    runId: null,
    managerUserId: link.managerUserId,
    peerId: link.peerId,
    clientId: identity.clientId,
    leadId: identity.leadId,
    identityStrength: identity.strength,
    anchorTgMessageId: anchor.tgMessageId,
    anchorEditedAt: anchor.editedAt,
    kind: 'price',
    body,
    glossUz: null,
    language: locale,
    category: 'price',
    confidence: null,
    nextStep: 'quote',
    policy: {
      blocks: policy.blocks,
      warnings: policy.warnings,
      ledger: [],
      memory: {
        language: locale,
        customerScript: null,
        sources: [{ value: amount, kind: 'money', label: 'sizning narxingiz' }],
        allowedPhones: [],
        allowedUrls: [],
        mapUrls: [],
        askedLocation: false,
        hasEstimate: false,
        ownCodes: identity.codes.map((c) => c.clientCode),
        managerName: identity.managerName,
        canary: '',
      },
      card: { customerLabel: labelOf(identity), lastOut: null, customerLines: [] },
      notes: ['Narx faqat mijozga ketadi — bitim kartasiga hech narsa yozilmaydi.'],
    },
    blocked: !policy.ok,
    needsOwner: false,
    ownerQuestion: null,
    actions: [],
    citedMessageIds: [],
    offerId: null,
  });
  // The check above ran before the write; a ✏️ pressed in between still lands
  // here, and createDraft wrote nothing for it.
  if (written.kind === 'editing') return { ok: false, code: 'refused', detail: EDITING_WORDS };
  return { ok: true, draftId: written.draftId };
}
