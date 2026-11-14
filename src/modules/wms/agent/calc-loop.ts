import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  agentDrafts,
  agentOutbox,
  calcRequests,
  notifications,
  tgMessageFlags,
  tgMessages,
} from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { parseTypedMoney } from '../calc/money-input';
import { agentRunning, readAgentConfig } from './config';
import { chatIdentity } from './context';
import { createDraft, requestRecalculated, type DraftPolicyJson } from './drafts';
import { AGENT_LOCALES, detectLocale, type AgentLocale } from './locale';
import { WAREHOUSE_SENTENCES } from './policy';
import { ownerPolicyFor } from './policy-input';
import { priceReplyText } from './price-reply';
import { editAgentCopies } from './purge';
import { JOB_AGENT_CALC_ANSWER, JOB_AGENT_HAND_BACK, type AgentCalcAnswerJob, type AgentHandBackJob } from './queues';
import { calcFromOurWarehouse } from './types';
import { anchorAgeWords, anchorMaxAgeMsForTrigger } from './anchor-clock';
import { isTashkentNight, nextTashkentMorning } from './send-step';
import { AGENT_LIMITS } from './limits';
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

/**
 * How the reply that SUBMITTED this request's chain reached the customer (SPEC-P2-v2 §1.2) — calc-price
 * `submitReplyOf`, the ONE rule the tool and every re-price ask too. Read through the link's draft and its outbox row:
 * the link is written by the landing, before the approval, so a press that lost after landing leaves a link whose
 * reply never went; and his ✏️ text in its place promised whatever he wrote, never the machine's price.
 */
async function linkReplyOf(requestId: string) {
  const link = await linkFor(requestId);
  const { submitReplyOf } = await import('./calc-price');
  return submitReplyOf(link?.draftId ?? null);
}

/**
 * Did the reply that SUBMITTED this request's chain reach the customer in the machine's own words? A VED answer is
 * priced to the customer (§2.3) only on such a chain: «javob kelishi bilan aytaman» was said there and nowhere else.
 */
export async function calcLinkReplySent(requestId: string): Promise<boolean> {
  return (await linkReplyOf(requestId)) === 'sent';
}

function labelOf(identity: Awaited<ReturnType<typeof chatIdentity>>): string {
  if (identity.clientId) {
    const codes = identity.codes.map((c) => c.clientCode).join(', ');
    return identity.customerName ? `${codes} · ${identity.customerName}` : codes;
  }
  return `Lid: ${identity.customerName ?? '—'}`;
}

export interface AnnounceDeps {
  /** Tests: the hand-back's and the VED answer's job sender (pg-boss's `enqueue` otherwise). */
  enqueue?: (name: string, data: AgentHandBackJob | AgentCalcAnswerJob, options: { retryLimit: number; startAfter?: number }) => Promise<void>;
  /** Tests: the moment the VED answered — the night rule's clock (SPEC-P2-v2 §2.3). */
  now?: Date;
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
  // The VED's answer priced for the customer by the machine (SPEC-P2-v2 §2.3) — on «Готово» and a seal only, never the
  // AI-VED estimate («rasmiy emas»), a recalculation or a hand-back. The line says what the AI will say, or why not;
  // the job is QUEUED, never run inside the VED's request.
  // A failure here must not cost him the announcement itself: he still gets the figure and the 💵 door.
  const price =
    event === 'done' || event === 'sealed'
      ? await queueCalcAnswer(link, requestId, config, deps).catch((err: unknown) => {
          logger.error({ err, requestId }, '[agent] calc answer not priced');
          return null;
        })
      : null;
  const priceLine = price ?? "Narx bersangiz bo'ladi.";
  const lines: Record<CalcEvent, string> = {
    done: `💵 Hisob javobi keldi — ${who}\n${section}: ${detail.amountText ?? '—'}\n${priceLine}`,
    sealed: `💵 Hisob muhrlandi — ${who}\n${section}: ${detail.amountText ?? '—'}\n${priceLine}`,
    estimate: `🤖 AI-VED taxmini (rasmiy emas) — ${who}\n${section}: ${detail.amountText ?? '—'}\nVED javobini kuting yoki shu bilan narx bering.`,
    returned: `🔁 VED hisobni qaytardi — ${who}\n${detail.reason ?? ''}`,
    recalc:
      `🔄 Qayta hisoblanmoqda — ${who}\n${section}: eski narx endi amal qilmaydi.` +
      held
        .map((h) =>
          h.ai
            ? `\n⚠️ AI aytgan narx hali ketmagan edi — endi yuborilmaydi: «${h.body}». Yangi javob kelganda narx yana yoziladi.`
            : `\n⚠️ Siz bergan narx hali ketmagan edi — endi yuborilmaydi: «${h.body}». Yangi javob kelganda narx bering.`,
        )
        .join(''),
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

/** What a replaced answer's card says once its «💵 Narx yozaman» is gone (`retirePricesOf`). */
export const REPLACED_ANSWER_LINE = '🔄 VED qayta hisoblayapti — bu javobga endi narx yozilmaydi. Yangi javob kelganda narx bering.';

/**
 * A recalculation started on the chain a 💵 price was typed on (review A1).
 * Every PENDING price draft of this chat priced on a request the correction
 * replaces is retired — `superseded`, its card saying why — so a ✅ on the old
 * card is refused as «not live», never sent. And a price he already APPROVED
 * that is still waiting to go (the night hold, the gaps) does not go either
 * (answers review): the figure answers a request that no longer stands, the
 * send step refuses it as `offer_gone` (drafts `draftOfferStands`), and it is
 * cancelled HERE already — the compare-and-set on 'agent' that every withdraw
 * uses (config's `agent_off`), so a row the listener has claimed is the one
 * in flight and is let finish — so its card says so now rather than reading
 * «08:30 da ketadi» until the morning it would have been refused. Returns
 * those, as the ping names them.
 *
 * And the answer cards of the requests it replaces lose their «💵 Narx
 * yozaman» (`priceable` — what `agentButtons` draws the door from, and what a
 * swipe-reply to the card is resolved by, bot-door `agentCardFor`): the door
 * refuses a figure typed on a replaced answer (`recalculated`), and a button
 * that can only be refused is a button that lies. The card says why, on the
 * row a copy not yet sent goes out with (it is not sent — the recalculation's
 * own ping says it all) and on the copies already sent.
 */
async function retirePricesOf(
  link: { managerUserId: string; peerId: bigint },
  requestId: string,
): Promise<{ body: string; ai: boolean }[]> {
  const replaced = await chainAncestors(requestId);
  if (replaced.length === 0) return [];
  const ids = sql.join(replaced.map((id) => sql`${id}`), sql`, `);
  // His 💵 (`priceRequestId`) and the machine's VED price (`memory.calcPrices`, SPEC-P2-v2 §2.5) — whatever the
  // draft's kind: a reply that quoted a request the correction replaces is retired as his figure is.
  const priced = sql`(${agentDrafts.policy}->>'priceRequestId' IN (${ids})
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${agentDrafts.policy}->'memory'->'calcPrices') = 'array'
                                                       THEN ${agentDrafts.policy}->'memory'->'calcPrices' ELSE '[]'::jsonb END) e
                WHERE e->>'requestId' IN (${ids})))`;
  const mine = and(eq(agentDrafts.managerUserId, link.managerUserId), eq(agentDrafts.peerId, link.peerId), priced);
  const retired = await db
    .update(agentDrafts)
    .set({ status: 'superseded', policy: sql`${agentDrafts.policy} || ${JSON.stringify({ stale: 'recalc' })}::jsonb`, updatedAt: new Date() })
    .where(and(mine, eq(agentDrafts.status, 'pending')))
    .returning({ id: agentDrafts.id });
  const withdrawn = await db
    .update(agentOutbox)
    .set({ status: 'cancelled', lastError: 'offer_gone: the priced request was recalculated' })
    .where(
      and(
        eq(agentOutbox.status, 'agent'),
        inArray(
          agentOutbox.draftId,
          db.select({ id: agentDrafts.id }).from(agentDrafts).where(and(mine, eq(agentDrafts.status, 'approved'))),
        ),
      ),
    )
    .returning({ draftId: agentOutbox.draftId, body: agentOutbox.body });
  const kinds = withdrawn.length
    ? await db.select({ id: agentDrafts.id, kind: agentDrafts.kind }).from(agentDrafts).where(inArray(agentDrafts.id, withdrawn.map((w) => w.draftId)))
    : [];
  const { refreshAgentCard } = await import('./card-io');
  for (const id of [...retired.map((r) => r.id), ...withdrawn.map((w) => w.draftId)]) {
    await refreshAgentCard(id).catch((err: unknown) => logger.warn({ err, draftId: id }, '[agent] card not refreshed'));
  }
  // Only a card still offering the door: one closed by an earlier correction
  // of the same chain says so once.
  const closed = await db
    .update(notifications)
    .set({
      payload: sql`${notifications.payload} || jsonb_build_object('priceable', false, 'text', coalesce(${notifications.payload}->>'text', '') || ${`\n\n${REPLACED_ANSWER_LINE}`}::text)`,
      status: sql`CASE WHEN ${notifications.status} = 'pending' THEN 'muted' ELSE ${notifications.status} END`,
      error: sql`CASE WHEN ${notifications.status} = 'pending' THEN 'recalculated before it was sent' ELSE ${notifications.error} END`,
    })
    .where(
      and(
        eq(notifications.userId, link.managerUserId),
        eq(notifications.type, 'AgentCalcAnswered'),
        sql`${notifications.payload}->>'requestId' IN (${sql.join(replaced.map((id) => sql`${id}`), sql`, `)})`,
        sql`(${notifications.payload}->>'priceable') = 'true'`,
      ),
    )
    // The payload as written — a `tg` the drain merged after any read of ours is in it (bot-door `closeRuleCards`).
    .returning({ id: notifications.id, type: notifications.type, payload: notifications.payload, userId: notifications.userId });
  await editAgentCopies(closed.map((c) => ({ ...c, payload: c.payload as Record<string, unknown> }))).catch((err: unknown) =>
    logger.warn({ err, requestId }, '[agent] replaced answer cards not edited'),
  );
  return withdrawn.map((w) => ({ body: w.body, ai: kinds.find((k) => k.id === w.draftId)?.kind !== 'price' }));
}

/** The hand-back run's instruction — the VED's reason is for the model, never for the customer word for word. */
export function handBackInstruction(reason: string): string {
  return `VED hisobni qaytardi, sababi (ichki, mijozga so'zma-so'z aytma): «${reason}». Mijozdan yetishmayotganini qisqa so'ra.`;
}

/** How long the one retry of a hand-back waits — a tg-listen rebuild is minutes. */
export const HAND_BACK_RETRY_S = 300;

/** Why the AI wrote no question — the 🔁 follow-up's words, one per refusal (exhaustive); his ✍️ answer's too (owner-answer-job). */
export const NO_DRAFT_WORDS: Record<Ineligible, string> = {
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
  // The ordinary run's clock; a run on another clock says ITS age (`noQuestionWhy`'s `maxAgeMs`, SPEC-P2-v2 K2).
  too_old: tooOldWords(AGENT_LIMITS.anchorMaxAgeMs),
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
  const why = noQuestionWhy(out, anchorMaxAgeMsForTrigger('hand_back'));
  if (why) await tellNoQuestion(job, why);
  return out;
}

/** «mijozning oxirgi xabari 24 soatdan eski» — in the age the run's own clock used (SPEC-P2-v2 K2). */
export function tooOldWords(maxAgeMs: number): string {
  return `mijozning oxirgi xabari ${anchorAgeWords(maxAgeMs)} eski`;
}

/**
 * Why a hand-back run left no question for the customer, in his words — or
 * null when there is nothing to tell: a draft, a duplicate delivery, the agent
 * switched off or not configured (no 🔁 reaches him then either). `maxAgeMs`:
 * the clock the run kept (`anchorMaxAgeMsForTrigger`) — «too old» says its age.
 */
export function noQuestionWhy(out: RunResult, maxAgeMs: number = AGENT_LIMITS.anchorMaxAgeMs): string | null {
  switch (out.outcome) {
    case 'refused':
      return out.reason === 'too_old' ? tooOldWords(maxAgeMs) : NO_DRAFT_WORDS[out.reason];
    case 'capped':
      return 'bugungi AI byudjeti tugadi';
    case 'error':
      return 'AI xato qildi';
    case 'no_reply':
      return 'AI savol kerak emas deb topdi';
    case 'skipped':
      return out.reason === 'no_fresh_inbound' ? tooOldWords(maxAgeMs) : null;
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

/**
 * The VED answered a job the AI submitted (SPEC-P2-v2 §2.3): queue the customer's price — the VED figure plus his
 * markup, computed by code (calc-price) and said by the model through `calc_price` — and return the line his
 * announcement carries. Null: the announcement keeps today's «Narx bersangiz bo'ladi».
 *
 * Only when the markup can be read (an EMPTY one is «no markup», his §00 A1; garbage in the row is said and nothing is
 * queued), the agent runs from this account, and the chain's SUBMITTING reply went (`calcLinkReplySent`, §1.2): «javob
 * kelishi bilan aytaman» was said there and nowhere else. The «💵 Narx yozaman» door stays on the card whatever this
 * says (judge regress 4). An answer in the night is queued for the next 08:30 Tashkent (judge regress 15): the run
 * and its scheduling happen in the day.
 */
async function queueCalcAnswer(
  link: { managerUserId: string; peerId: bigint },
  requestId: string,
  config: Awaited<ReturnType<typeof readAgentConfig>>,
  deps: AnnounceDeps,
): Promise<string | null> {
  const { CALC_PRICE_REFUSAL_WORDS, calcPriceFor, readMarkupRule } = await import('./calc-price');
  if ((await readMarkupRule()) === null) return `⚠️ AI narx aytmaydi: ${CALC_PRICE_REFUSAL_WORDS.markup_unreadable}. Narx bersangiz bo'ladi.`;
  if (!agentRunning(config) || config.ownerUserId !== link.managerUserId) return null;
  // The submitting reply never went: the customer was promised nothing — the announcement alone. His ✏️ words went in
  // its place: the price below refuses `owner_words`, said in words with the 💵 door.
  if ((await linkReplyOf(requestId)) === 'unsent') return null;
  const now = deps.now ?? new Date();
  const priced = await calcPriceFor({ managerUserId: link.managerUserId, peerId: link.peerId, requestId, now });
  if (!priced.ok) return `🤖 AI narx aytmaydi: ${CALC_PRICE_REFUSAL_WORDS[priced.reason]}. Narx bersangiz bo'ladi.`;
  const mark = priced.prices.find((p) => p.requestId === requestId) ?? priced.prices[0]!;
  const job: AgentCalcAnswerJob = {
    managerUserId: link.managerUserId,
    peerId: String(link.peerId),
    requestId: mark.requestId,
    sourceKey: calcAnswerSourceKey(mark),
  };
  const startAfter = isTashkentNight(now) ? Math.max(1, Math.round((nextTashkentMorning(now).getTime() - now.getTime()) / 1000)) : undefined;
  const send = deps.enqueue ?? (async (name, data, options) => (await import('../../platform/jobs/boss')).enqueue(name, data, options));
  try {
    await send(JOB_AGENT_CALC_ANSWER, job, { retryLimit: 0, ...(startAfter !== undefined ? { startAfter } : {}) });
  } catch (err) {
    logger.error({ err, requestId }, '[agent] calc answer not queued');
    return "Narx bersangiz bo'ladi.";
  }
  const when = startAfter !== undefined ? ' (ertalab 08:30 dan keyin)' : '';
  return `🤖 AI mijozga ustama bilan narx aytadi${when}:\n${priced.cardLine}\nO‘zingiz bermoqchi bo‘lsangiz — 💵.`;
}

/** The run's key for one standing anchor of a chain (§2.3): a later seal is its own key, a redelivery is the same. */
export function calcAnswerSourceKey(mark: { requestId: string; anchor: 'seal' | 'answer'; anchorId: string }): string {
  return `calc:${mark.requestId}:${mark.anchor === 'seal' ? mark.anchorId : 'answer'}`;
}

/** The VED answer run's instruction (§2.3) — the price is the tool's; the model adds no figure of its own. */
export function calcAnswerInstruction(section: string | null): string {
  return `VED javob berdi (${SECTION_WORDS[section ?? ''] ?? section ?? 'hisob'}). calc_price vositasini chaqir va mijozga shu narxni ayt; boshqa raqam qo'shma.`;
}

/**
 * His own figure outranks the machine's (judge money 11, hands 5): the chat holds a 💵 draft for this chain — live,
 * approved, or sent — or his «💵 Narx yozaman» is armed for one of its requests. The VED answer's run then stands down.
 * ONE predicate (calc-price `ownerPricedChain`): the `calc_price` tool, the press and every send step ask the same.
 */
export async function ownerPriceOnChain(managerUserId: string, peerId: bigint, memberIds: readonly string[]): Promise<boolean> {
  const { ownerPricedChain } = await import('./calc-price');
  return ownerPricedChain(managerUserId, peerId, memberIds);
}

export interface CalcAnswerDeps extends RunDeps {
  /** Tests: the retry's sender (pg-boss's `enqueue` otherwise). */
  requeue?: (job: AgentCalcAnswerJob, startAfterS: number) => Promise<void>;
}

/**
 * The worker's side of `JOB_AGENT_CALC_ANSWER` (§2.3): the owner-triggered run, keyed by the standing anchor, marked
 * `policy.calcAnswer` (K2's week, K1's forgiven head) and carrying an «o'zi yuborish» plan. His own 💵 on the chain
 * stands it down; a refusal that passes by itself is tried once more; every outcome that leaves no draft is said to
 * him beside the announcement, with the 💵 door.
 */
export async function handleCalcAnswer(job: AgentCalcAnswerJob, deps: CalcAnswerDeps = {}): Promise<RunResult> {
  const peerId = BigInt(job.peerId);
  const { chatCalcChains } = await import('./context');
  const chain = (await chatCalcChains(job.managerUserId, peerId)).find((c) => c.memberIds.includes(job.requestId)) ?? null;
  if (await ownerPriceOnChain(job.managerUserId, peerId, chain?.memberIds ?? [job.requestId])) {
    await tellCalcAnswer(job, 'narxni o‘zingiz yozgansiz (💵) — sizning narxingiz ustun');
    return { outcome: 'stood_down', reason: 'owner_price' };
  }
  const { passesByItself, runOwnerTriggered } = await import('./run');
  const out = await runOwnerTriggered(
    {
      trigger: 'calc_answer',
      managerUserId: job.managerUserId,
      peerId,
      sourceKey: job.sourceKey,
      instruction: calcAnswerInstruction(chain?.section ?? null),
      calcAnswer: { requestId: job.requestId },
    },
    deps,
  );
  if (out.outcome === 'refused' && passesByItself(out.reason) && (job.attempt ?? 0) < 1) {
    const next: AgentCalcAnswerJob = { ...job, attempt: (job.attempt ?? 0) + 1 };
    const send =
      deps.requeue ??
      (async (data: AgentCalcAnswerJob, startAfterS: number) =>
        (await import('../../platform/jobs/boss')).enqueue(JOB_AGENT_CALC_ANSWER, data, { startAfter: startAfterS, retryLimit: 0 }));
    await send(next, HAND_BACK_RETRY_S);
    return out;
  }
  const why = calcAnswerWhy(out);
  if (why) await tellCalcAnswer(job, why);
  return out;
}

/**
 * Why the VED answer's run left no price for the customer, in his words — or null when there is nothing to tell: a
 * draft (its card says the rest), a duplicate delivery, the agent switched off. The «too old» age is the run's own
 * clock (K2: a week).
 */
export function calcAnswerWhy(out: RunResult): string | null {
  if (out.outcome === 'stood_down') {
    if (out.reason === 'editing') return 'siz bu chatga javob yozayapsiz (✏️)';
    return null;
  }
  if (out.outcome === 'no_reply') return 'AI javob kerak emas deb topdi';
  return noQuestionWhy(out, anchorMaxAgeMsForTrigger('calc_answer'));
}

/** The VED answer's follow-up: no price was drafted for the customer, and why — with the 💵 door (`priceable`). */
async function tellCalcAnswer(job: AgentCalcAnswerJob, why: string): Promise<void> {
  const identity = await chatIdentity(job.managerUserId, BigInt(job.peerId));
  await notifyStaffTelegram({
    userIds: [job.managerUserId],
    type: 'AgentCalcAnswered',
    text: `🤖 AI mijozga VED narxini yozmadi — ${labelOf(identity)}\nSabab: ${why}.\nNarxni o‘zingiz bering: 💵.`,
    extra: { requestId: job.requestId, priceable: true, event: 'done' },
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
 *   no_anchor         — the chat holds no customer message to answer;
 *   recalculated      — a VED correction replaced the request (drafts
 *                       `requestRecalculated`): the card he pressed 💵 on
 *                       answers a figure that no longer stands, and a draft
 *                       on it would be cancelled at its first send step.
 */
export type PriceRefusal =
  | 'not_linked'
  | 'not_account_holder'
  | 'bad_number'
  | 'ambiguous_number'
  | 'editing_open'
  | 'no_anchor'
  | 'recalculated'
  /**
   * The AI already SENT the customer its price for this chain (SPEC-P2-v2 §2.3): asked first — «Mijozga AI narxi
   * (1 359 $) ketgan; sizning narxingiz yuborilsinmi?» — and his figure drafts only on the next 💵 (`total` = the AI's).
   */
  | 'ai_price_sent';

/** The two ways an ambiguous figure reads — `decimal` null when that reading is more than cents (no price). */
export interface PriceReadings {
  thousands: number;
  /** «1,25» as he would retype it; null when the decimal reading is no price at all. */
  decimal: string | null;
}

export type PriceDraftResult =
  | { ok: true; draftId: string }
  | { ok: false; code: Exclude<PriceRefusal, 'ambiguous_number' | 'ai_price_sent'> }
  | { ok: false; code: 'ambiguous_number'; readings: PriceReadings }
  | { ok: false; code: 'ai_price_sent'; total: number; by: 'ai' | 'owner' };

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

/** How long his first 💵 after the AI's sent price counts as asked (§2.3): the next one within it drafts. */
export const OWNER_PRICE_ASK_MS = 30 * 60_000;

function askedRecently(at: string | null): boolean {
  if (!at) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && Date.now() - t <= OWNER_PRICE_ASK_MS;
}

/**
 * The prices already approved for this chain (§2.3) — the machine's VED-price replies and his own 💵 — with where
 * their outbox row stands, the Telegram id it went out under, and the client total each quoted (the AI's figure or
 * his, never the floor). Newest send first.
 */
async function aiPricesOnChain(
  managerUserId: string,
  peerId: bigint,
  requestId: string,
): Promise<{ draftId: string; outbox: string | null; tgId: bigint | null; total: number; asked: string | null; by: 'ai' | 'owner' }[]> {
  const { chatCalcChains } = await import('./context');
  const members = (await chatCalcChains(managerUserId, peerId)).find((c) => c.memberIds.includes(requestId))?.memberIds ?? [requestId];
  const ids = sql.join(members.map((id) => sql`${id}`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT d.id::text AS draft_id, o.status AS outbox, o.tg_message_id::text AS tg_id, d.policy->>'ownerPriceAsked' AS asked, d.kind,
           CASE WHEN d.kind = 'price' THEN (d.policy->'memory'->'sources'->0->>'value')::numeric
                ELSE (SELECT (e->>'total')::numeric FROM jsonb_array_elements(d.policy->'memory'->'calcPrices') e
                       WHERE e->>'requestId' IN (${ids}) LIMIT 1) END AS total
      FROM agent_drafts d
      LEFT JOIN agent_outbox o ON o.draft_id = d.id
     WHERE d.manager_user_id = ${managerUserId}::uuid AND d.peer_id = ${String(peerId)}::bigint
       AND d.status = 'approved'
       AND (
         (d.kind = 'price' AND d.policy->>'priceRequestId' IN (${ids}))
         OR (d.final_body IS NULL AND jsonb_typeof(d.policy->'memory'->'calcPrices') = 'array'
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.policy->'memory'->'calcPrices') e WHERE e->>'requestId' IN (${ids})))
       )
     ORDER BY o.sent_at DESC NULLS LAST
  `)) as unknown as { draft_id: string; outbox: string | null; tg_id: string | null; asked: string | null; total: string | null; kind: string }[];
  return [...rows].map((r) => ({
    draftId: r.draft_id,
    outbox: r.outbox,
    tgId: r.tg_id === null ? null : BigInt(r.tg_id),
    total: Number(r.total ?? 0),
    asked: r.asked,
    by: r.kind === 'price' ? ('owner' as const) : ('ai' as const),
  }));
}

/** The customer wrote in this chat after our message `tgId` went (a line he did not delete) — a new turn to answer. */
async function customerWroteAfter(managerUserId: string, peerId: bigint, tgId: bigint | null): Promise<boolean> {
  if (tgId === null) return false;
  const [row] = await db
    .select({ id: tgMessages.id })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(
      and(
        eq(tgMessages.managerUserId, managerUserId),
        eq(tgMessages.peerId, peerId),
        eq(tgMessages.direction, 'in'),
        isNull(tgMessageFlags.deletedAt),
        sql`${tgMessages.tgMessageId} > ${String(tgId)}::bigint`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** An AI offer stands on the card for this job (`agent_offers`, 0149 — written by the after-sent step). Never throws. */
async function aiOfferOnRequest(requestId: string): Promise<boolean> {
  try {
    const rows = (await db.execute(sql`SELECT EXISTS (SELECT 1 FROM agent_offers WHERE request_id = ${requestId}::uuid) AS ok`)) as unknown as { ok: boolean }[];
    return [...rows][0]?.ok === true;
  } catch {
    // One migration behind there is no table — and no AI offer.
    return false;
  }
}

/**
 * «💵 Narx yozaman»: his typed dollars → a price draft whose body is ONE
 * deterministic sentence in the customer's language carrying exactly his
 * figure (`priceReplyText`). Nothing else is written — no offer row, no deal
 * card, no floor approval (his 6 b) — so it works the same on an AI-VED
 * «taxmin» card, which has no seal and no Готово to anchor an offer on.
 *
 * Every refusal is decided BEFORE anything is written: not linked, not the
 * account holder, a request a correction replaced, a number that is not a
 * price or reads two ways, no customer message to answer, his own reply to
 * this chat being typed.
 */
export async function priceDraftFromText(staffId: string, requestId: string, text: string): Promise<PriceDraftResult> {
  const link = await linkFor(requestId);
  if (!link) return { ok: false, code: 'not_linked' };
  if (link.managerUserId !== staffId) return { ok: false, code: 'not_account_holder' };
  const [req] = await db
    .select({ section: calcRequests.section })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  // The link outlived its request (a request is never deleted in use): there is nothing to price.
  if (!req) return { ok: false, code: 'not_linked' };
  // The question the send step asks of an approved 💵 (`draftOfferStands`),
  // asked first: a figure typed on a replaced answer — an older card's 💵, a
  // wait armed before the recalculation — would be drafted, approved, and
  // then cancelled as offer_gone, after the bot had told him it was ready.
  // Before the figure, too: whatever he typed, this answer takes none.
  if (await requestRecalculated(requestId)) return { ok: false, code: 'recalculated' };
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
  // The prices already given for this chain (SPEC-P2-v2 §2.3) — the AI's, and his own earlier 💵. His new figure
  // outranks them: a live one is superseded by the draft below (one live draft per chat), an approved one still
  // waiting is taken back; one already on its way or SENT is asked about first, and his figure drafts on the next press.
  const ai = await aiPricesOnChain(link.managerUserId, link.peerId, requestId);
  // The newest price the customer has, or is being sent this moment (the pump claimed it — it cannot be taken back):
  //  - the AI's, always asked about (§2.3: «Mijozga AI narxi ketgan; sizning narxingiz yuborilsinmi?»);
  //  - his own, asked about only while it is the chat's last word — no line of the customer's came after it (fix pass
  //    1, finding 11): a second 💵 then follows on the same line, and the live head forgives our own sends for an
  //    owner-started reply (K1), so both would go. Once the customer answered it — «qimmat ekan» — his next figure is
  //    the ordinary bargaining reply, drafted on the first press.
  const went = ai.find((x) => x.outbox === 'sending') ?? ai.find((x) => x.outbox === 'sent');
  const askFirst =
    went !== undefined &&
    !askedRecently(went.asked) &&
    (went.by === 'ai' || went.outbox === 'sending' || !(await customerWroteAfter(link.managerUserId, link.peerId, went.tgId)));
  if (askFirst) {
    await db
      .update(agentDrafts)
      .set({ policy: sql`${agentDrafts.policy} || ${JSON.stringify({ ownerPriceAsked: new Date().toISOString() })}::jsonb` })
      .where(eq(agentDrafts.id, went.draftId));
    return { ok: false, code: 'ai_price_sent', total: went.total, by: went.by };
  }
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
  // A price approved and still WAITING to go — the AI's, or his own earlier 💵 (fix pass 1, finding 4: K1 forgives our
  // own sends for an owner-started reply, so his first 💵 no longer cancels his second at the live head) — is taken back
  // by the compare-and-set every withdraw uses: a row the listener already claimed is the one in flight, asked above.
  // Only once every refusal is behind (his reply being typed, no line to answer): a 💵 that drafts nothing takes back
  // nothing.
  for (const w of ai.filter((x) => x.outbox === 'agent')) {
    const [gone] = await db
      .update(agentOutbox)
      .set({ status: 'cancelled', lastError: w.by === 'ai' ? 'owner_price: his 💵 on the request the AI priced' : 'owner_price_again: his newer 💵 on the same request' })
      .where(and(eq(agentOutbox.draftId, w.draftId), eq(agentOutbox.status, 'agent')))
      .returning({ id: agentOutbox.id });
    if (gone) {
      const { refreshAgentCard } = await import('./card-io');
      await refreshAgentCard(w.draftId).catch((err: unknown) => logger.warn({ err, draftId: w.draftId }, '[agent] card not refreshed'));
    }
  }
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
  // A job priced from our Chinese warehouses (his third set, «3») carries
  // both of its sentences to the customer with his figure too — the job's
  // own landing said so (calc_submit.fromOurWarehouse on the draft that sent
  // it); the sentences carry no digit, so the one-figure rule holds.
  const [sent] = link.draftId
    ? await db.select({ actions: agentDrafts.actions }).from(agentDrafts).where(eq(agentDrafts.id, link.draftId))
    : [];
  const fromOurs = calcFromOurWarehouse(sent?.actions);
  const body = fromOurs
    ? `${priceReplyText(locale, req.section, amount)} ${WAREHOUSE_SENTENCES[locale].condition} ${WAREHOUSE_SENTENCES[locale].factory}`
    : priceReplyText(locale, req.section, amount);
  // The 💵 sentence is one template for every customer: the same-text count
  // (G10, review K3) rides on the card as a warning — a block at three peers
  // would stop ordinary daily quoting.
  const codes = identity.codes.map((c) => c.clientCode);
  const policy = await ownerPolicyFor(body, codes, {
    managerUserId: link.managerUserId,
    peerId: link.peerId,
    strip: [...codes, ...(identity.customerName ? identity.customerName.split(/\s+/u) : [])],
  });
  // The request his figure answers rides on the draft (review A1): a
  // recalculation of its chain retires the draft (`retirePricesOf`), and the
  // send step asks the same of it before an approved one goes
  // (`draftOfferStands`).
  const stored: DraftPolicyJson & { priceRequestId: string } = {
    blocks: policy.blocks,
    warnings: policy.warnings,
    ledger: [],
    memory: {
      language: locale,
      customerScript: null,
      sources: [{ value: amount, kind: 'money', label: 'sizning narxingiz', origin: 'tool' }],
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
    // An AI offer already on the card for this job (SPEC-P2-v2 §2.4) stays there — said, so «nothing is written» is
    // never read as «the card is empty».
    notes: [(await aiOfferOnRequest(requestId)) ? 'Narx faqat mijozga ketadi — bitim kartasiga hech narsa yozilmaydi; AI yozgan narx kartada qoladi.' : 'Narx faqat mijozga ketadi — bitim kartasiga hech narsa yozilmaydi.'],
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
