import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  agentDrafts,
  agentOutbox,
  calcRequests,
  tgMessageFlags,
  tgMessages,
} from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { tashkentMinute } from '../../platform/time/tashkent';
import { parseTypedMoney } from '../calc/money-input';
import { agentRunning, readAgentConfig } from './config';
import { chatIdentity } from './context';
import { createDraft, type DraftPolicyJson } from './drafts';
import { AGENT_LOCALES, detectLocale, type AgentLocale } from './locale';
import { ownerPolicyFor } from './policy-input';
import { priceReplyText } from './price-reply';
import { JOB_AGENT_HAND_BACK, type AgentHandBackJob } from './queues';
import type { Ineligible } from './eligibility';
import type { RunDeps, RunResult } from './run';

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

/** The requests a correction replaces, nearest first: walk `supersedes_request_id` up (#923). */
export async function chainAncestors(requestId: string): Promise<string[]> {
  const up: string[] = [];
  let id = requestId;
  for (let i = 0; i < 20; i++) {
    const [row] = await db
      .select({ parent: calcRequests.supersedesRequestId })
      .from(calcRequests)
      .where(eq(calcRequests.id, id));
    if (!row?.parent) break;
    id = row.parent;
    up.push(id);
  }
  return up;
}

/** The chain's root (a correction is a new request, #923). */
export async function chainRoot(requestId: string): Promise<string> {
  return (await chainAncestors(requestId)).at(-1) ?? requestId;
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
  // A retirement that fails must not cost him the message itself — which
  // already says the old price no longer stands.
  const held =
    event === 'recalc'
      ? await retirePricesOf(link, requestId).catch((err: unknown) => {
          logger.error({ err, requestId }, '[agent] price drafts not retired on recalc');
          return [];
        })
      : [];
  const lines: Record<CalcEvent, string> = {
    done: `💵 Hisob javobi keldi — ${who}\n${section}: ${detail.amountText ?? '—'}\nNarx bersangiz bo'ladi.`,
    sealed: `💵 Hisob muhrlandi — ${who}\n${section}: ${detail.amountText ?? '—'}\nNarx bersangiz bo'ladi.`,
    estimate: `🤖 AI-VED taxmini (rasmiy emas) — ${who}\n${section}: ${detail.amountText ?? '—'}\nVED javobini kuting yoki shu bilan narx bering.`,
    returned: `🔁 VED hisobni qaytardi — ${who}\n${detail.reason ?? ''}`,
    recalc:
      `🔄 Qayta hisoblanmoqda — ${who}\n${section}: eski narx endi amal qilmaydi.` +
      held.map((h) => `\n⚠️ Siz bergan narx hali ketmagan — ${h.at} da ketadi: «${h.body}». Kerak bo'lmasa suhbatda «Bekor qilish»ni bosing.`).join(''),
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

/**
 * A recalculation started on the chain a 💵 price was typed on (review A1:
 * with no offer row behind it, the send step's `offer_gone` can never fire
 * for one). Every PENDING price draft of this chat priced on a request the
 * correction replaces is retired — `superseded`, its card saying why — so a
 * ✅ on the old card is refused as «not live», never sent. A price he already
 * APPROVED is his decision and stays in the outbox; the recalc message names
 * each one still waiting, with the time it leaves, so he can take it back on
 * the chat. Returns those, as the ping prints them.
 */
async function retirePricesOf(
  link: { managerUserId: string; peerId: bigint },
  requestId: string,
): Promise<{ body: string; at: string }[]> {
  const replaced = await chainAncestors(requestId);
  if (replaced.length === 0) return [];
  const priced = sql`${agentDrafts.policy}->>'priceRequestId' IN (${sql.join(replaced.map((id) => sql`${id}`), sql`, `)})`;
  const mine = and(eq(agentDrafts.managerUserId, link.managerUserId), eq(agentDrafts.peerId, link.peerId), eq(agentDrafts.kind, 'price'), priced);
  const retired = await db
    .update(agentDrafts)
    .set({ status: 'superseded', policy: sql`${agentDrafts.policy} || ${JSON.stringify({ stale: 'recalc' })}::jsonb`, updatedAt: new Date() })
    .where(and(mine, eq(agentDrafts.status, 'pending')))
    .returning({ id: agentDrafts.id });
  for (const r of retired) {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(r.id).catch((err: unknown) => logger.warn({ err, draftId: r.id }, '[agent] card not refreshed'));
  }
  const waiting = await db
    .select({ body: agentOutbox.body, at: agentOutbox.nextStepAt })
    .from(agentOutbox)
    .innerJoin(agentDrafts, eq(agentDrafts.id, agentOutbox.draftId))
    .where(and(mine, eq(agentDrafts.status, 'approved'), eq(agentOutbox.status, 'agent'), eq(agentOutbox.readDone, false)));
  return waiting.map((w) => ({ body: w.body, at: tashkentMinute(w.at) }));
}

/** The hand-back run's instruction — the VED's reason is for the model, never for the customer word for word. */
export function handBackInstruction(reason: string): string {
  return `VED hisobni qaytardi, sababi (ichki, mijozga so'zma-so'z aytma): «${reason}». Mijozdan yetishmayotganini qisqa so'ra.`;
}

/** How long the one retry of a hand-back waits — a tg-listen rebuild is minutes. */
export const HAND_BACK_RETRY_S = 300;

/** Why the AI wrote no question — the 🔁 follow-up's words, one per refusal (exhaustive). */
const NO_DRAFT_WORDS: Record<Ineligible, string> = {
  agent_off: "AI o'chirilgan",
  session_not_confirmed: 'eski serverdagi sessiya tasdiqlanmagan',
  listener_behind: "Telegram tinglovchisi (tg-listen) yangilanmagan",
  account_paused: "Telegram akkauntingiz to'xtatilgan (cheklov)",
  not_private_user: 'bu shaxsiy chat emas',
  no_owner: "chat mijoz yoki lidga bog'lanmagan",
  excluded: 'chat shaxsiy deb belgilangan',
  staff_peer: 'bu raqam hodimniki',
  muted: "bu chatda AI o'chirilgan",
  human_active: "bu chatda o'zingiz yozayapsiz",
  not_newest: 'mijoz yangi xabar yozdi',
  too_old: 'mijozning oxirgi xabari 24 soatdan eski',
  auto_sent: 'mijozning avto-javobi',
  echo: 'aks-sado',
  repeat: 'takror xabar',
};

export interface HandBackDeps extends RunDeps {
  /** Tests: the retry's sender (pg-boss's `enqueue` otherwise). */
  requeue?: (job: AgentHandBackJob, startAfterS: number) => Promise<void>;
}

/**
 * The worker's side of `JOB_AGENT_HAND_BACK`: the owner-triggered run, keyed
 * by the request. A refusal is never silent (review A9): one that passes by
 * itself — the listener rebuilding — is tried once more a few minutes later,
 * and every run that ends without a question tells him so in words, beside
 * the 🔁 he already has, so the customer's missing answer does not wait on a
 * draft that is never coming.
 */
export async function handleHandBack(job: AgentHandBackJob, deps: HandBackDeps = {}) {
  const { passesByItself, runOwnerTriggered } = await import('./run');
  const out = await runOwnerTriggered(
    {
      trigger: 'hand_back',
      managerUserId: job.managerUserId,
      peerId: BigInt(job.peerId),
      sourceKey: `${job.requestId}:returned`,
      instruction: handBackInstruction(job.reason),
    },
    deps,
  );
  if (out.outcome === 'refused' && passesByItself(out.reason) && (job.attempt ?? 0) < 1) {
    const next: AgentHandBackJob = { ...job, attempt: (job.attempt ?? 0) + 1 };
    const send =
      deps.requeue ??
      (async (data: AgentHandBackJob, startAfterS: number) =>
        (await import('../../platform/jobs/boss')).enqueue(JOB_AGENT_HAND_BACK, data, { startAfter: startAfterS, retryLimit: 0 }));
    await send(next, HAND_BACK_RETRY_S);
    return out;
  }
  const why = noQuestionWhy(out);
  if (why) await tellNoQuestion(job, why);
  return out;
}

/**
 * Why a hand-back run left no question for the customer, in his words — or
 * null when there is nothing to tell: a draft, a duplicate delivery, the agent
 * switched off or not configured (no 🔁 reaches him then either).
 */
export function noQuestionWhy(out: RunResult): string | null {
  switch (out.outcome) {
    case 'refused':
      return NO_DRAFT_WORDS[out.reason];
    case 'capped':
      return 'bugungi AI byudjeti tugadi';
    case 'error':
      return 'AI xato qildi';
    case 'no_reply':
      return 'AI savol kerak emas deb topdi';
    case 'skipped':
      return out.reason === 'no_fresh_inbound' ? 'mijozning oxirgi xabari 24 soatdan eski' : null;
    case 'draft':
    case 'stood_down':
    case 'rescheduled':
    case 'notice':
      return null;
  }
}

/** The 🔁's follow-up: no question was drafted, and why. */
async function tellNoQuestion(job: AgentHandBackJob, why: string): Promise<void> {
  const identity = await chatIdentity(job.managerUserId, BigInt(job.peerId));
  await notifyStaffTelegram({
    userIds: [job.managerUserId],
    type: 'AgentCalcAnswered',
    text: `🔁 AI mijozga savol yozmadi — ${labelOf(identity)}\nSabab: ${why}.\nVED sababi: ${job.reason}\nMijozdan o'zingiz so'rang.`,
    extra: { requestId: job.requestId, priceable: false, event: 'returned' },
  });
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
 * Why «💵 Narx yozaman» wrote nothing — each its own code, so the bot and the
 * page each say it in their own words (bot-door `PRICE_WORDS`, the page's
 * `ERROR_KEYS`) and neither prints a reason the machine composed. There is no
 * floor approval to wait for now that nothing reaches the deal card (his 6 b):
 *
 *   not_linked        — the request is not one the agent sent, or is gone;
 *   bad_number        — not a price at all;
 *   ambiguous_number  — «1.250»: a thousand times apart by who typed it (the
 *                       two readings ride beside the code, `readings`);
 *   editing_open      — his own reply to this chat is being typed (an
 *                       'editing' draft is never superseded, drafts.ts);
 *   no_anchor         — the chat holds no customer message to answer.
 */
export type PriceRefusal = 'not_linked' | 'not_account_holder' | 'bad_number' | 'ambiguous_number' | 'editing_open' | 'no_anchor';

/** The two ways an ambiguous figure reads — `decimal` null when that reading is more than cents (no price). */
export interface PriceReadings {
  thousands: number;
  /** «1,25» as he would retype it; null when the decimal reading is no price at all. */
  decimal: string | null;
}

export type PriceDraftResult =
  | { ok: true; draftId: string }
  | { ok: false; code: Exclude<PriceRefusal, 'ambiguous_number'> }
  | { ok: false; code: 'ambiguous_number'; readings: PriceReadings };

/** Above this a typed «price» is a slip, not a quote — and past it the grouping would print an exponent. */
const PRICE_MAX_USD = 1_000_000_000;

const PRICE_NOISE = /\$|usd|dollar/giu;

/**
 * «1.250» and «1,250» — one separator before exactly three digits — are a
 * thousand times apart depending on who typed them: a dot groups thousands
 * where many in Uzbekistan write prices, `parseTypedMoney` reads it as a
 * decimal, and a comma it reads the other way. His B4 a (number-cell.ts): such
 * a number is ASKED about, never guessed. Both readings, or null.
 */
export function ambiguousPrice(text: string): { thousands: number; decimal: number } | null {
  const t = text.replace(PRICE_NOISE, '').replace(/[\s\u00a0\u202f']/gu, '');
  const m = /^([1-9]\d{0,2})[.,](\d{3})$/u.exec(t);
  return m ? { thousands: Number(`${m[1]}${m[2]}`), decimal: Number(`${m[1]}.${m[2]}`) } : null;
}

/**
 * His typed dollars, or null: positive, at most cents, below the cap, and not
 * `ambiguousPrice`. Never rounded — a figure he did not type is not his.
 */
export function typedPriceUsd(text: string): number | null {
  if (ambiguousPrice(text)) return null;
  const amount = parseTypedMoney(text.replace(PRICE_NOISE, ''));
  if (amount === null || !(amount > 0) || amount >= PRICE_MAX_USD) return null;
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) return null;
  return amount;
}

/**
 * «💵 Narx yozaman»: his typed dollars → a price draft whose body is ONE
 * deterministic sentence in the customer's language carrying exactly his
 * figure (`priceReplyText`). Nothing else is written — no offer row, no deal
 * card, no floor approval (his 6 b) — so it works the same on an AI-VED
 * «taxmin» card, which has no seal and no Готово to anchor an offer on.
 *
 * Every refusal is decided BEFORE anything is written: not linked, not the
 * account holder, a number that is not a price or reads two ways, no
 * customer message to answer, his own reply to this chat being typed.
 */
export async function priceDraftFromText(staffId: string, requestId: string, text: string): Promise<PriceDraftResult> {
  const link = await linkFor(requestId);
  if (!link) return { ok: false, code: 'not_linked' };
  if (link.managerUserId !== staffId) return { ok: false, code: 'not_account_holder' };
  const both = ambiguousPrice(text);
  if (both) {
    // Each way to retype it is one this reader takes without asking again:
    // the whole dollars bare, the cents with two digits («1,25»). A decimal
    // reading with more than cents is no price at all, so it is not offered.
    const cents = Math.abs(Math.round(both.decimal * 100) - both.decimal * 100) < 1e-6;
    return {
      ok: false,
      code: 'ambiguous_number',
      readings: { thousands: both.thousands, decimal: cents ? String(both.decimal).replace('.', ',') : null },
    };
  }
  const amount = typedPriceUsd(text);
  if (amount === null) return { ok: false, code: 'bad_number' };
  const [req] = await db
    .select({ section: calcRequests.section })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  // The link outlived its request (a request is never deleted in use): there is nothing to price.
  if (!req) return { ok: false, code: 'not_linked' };
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
  if (editing) return { ok: false, code: 'editing_open' };

  // The draft answers the chat's newest live inbound.
  const [anchor] = await db
    .select({ tgMessageId: tgMessages.tgMessageId, editedAt: tgMessages.editedAt, body: tgMessages.body })
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
  // The language of the message it answers — the rule a run uses (run.ts):
  // the stored one is the LAST run's, and a customer who switched language in
  // messages no run read (a cap, an «ok») reads his price in the old one.
  const [conv] = await db
    .select({ locale: agentConversations.locale })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, link.managerUserId), eq(agentConversations.peerId, link.peerId)));
  const said = AGENT_LOCALES.find((l) => l === conv?.locale) ?? null;
  const locale: AgentLocale = detectLocale(anchor.body ?? '', said).locale ?? said ?? 'uz';
  const identity = await chatIdentity(link.managerUserId, link.peerId);
  const body = priceReplyText(locale, req.section, amount);
  const policy = await ownerPolicyFor(body, identity.codes.map((c) => c.clientCode));
  // The request his figure answers rides on the draft (review A1): a
  // recalculation of its chain retires the draft (`retirePricesOf`), and the
  // send step can ask the same once it learns to.
  const stored: DraftPolicyJson & { priceRequestId: string } = {
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
    priceRequestId: requestId,
  };
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
    policy: stored,
    blocked: !policy.ok,
    needsOwner: false,
    ownerQuestion: null,
    actions: [],
    citedMessageIds: [],
    offerId: null,
  });
  // The check above ran before the write; a ✏️ pressed in between still lands
  // here, and createDraft wrote nothing for it.
  if (written.kind === 'editing') return { ok: false, code: 'editing_open' };
  return { ok: true, draftId: written.draftId };
}
