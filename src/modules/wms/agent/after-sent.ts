import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentDrafts, agentOutbox } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { seatAndHolder } from '../../platform/settings/agent-seat';
import { moveLeadByMachine, type MachineMoveResult } from '../crm/service';
import { CalcError } from '../calc/service';
import { recordOffer } from '../calc/workspace';
import { dollarsWords } from './calc-markup';
import { CALC_PRICE_REFUSAL_WORDS, calcPriceFor, statedCalcMarks, storedMarksOf, type CalcPriceMark } from './calc-price';
import { agentFullP2Ready, agentTablesReady } from './config';
import { chatCalcChains } from './context';
import { machineMayTouch } from './machine-owner';
import type { AgentAfterSentJob } from './queues';
import type { AfterSentMark, DraftPolicyJson } from './types';

/**
 * What a reply settles on the card once it REACHED the customer (SPEC-P2-v2 §2.4, §3.2) — the `agent.after_sent`
 * job, queued from the listener's `sent` branch alone (settle-hooks `onAgentReplySent`, the job's id = the outbox
 * row's id) and by the minute sweep's net (`queueMissedAfterSent`) for a sent row whose outcome was never recorded.
 *
 * Two steps, each idempotent, each run in the app's worker — never in the listener, never inside a transaction:
 *
 *  (a) THE OFFER (§2.4): a VED price the MACHINE quoted (`memory.calcPrices`, its own words — `final_body` NULL) is
 *      written as the card's offer through the one door that writes a client price onto a card (`recordOffer`):
 *      only while the account it spoke from IS the AI seat (K4), only on a card the machine may touch (K3), only
 *      while the price still stands as quoted (asked once more through `calcPriceFor`), with its `agent_offers` mark
 *      in the offer's own transaction (no commission is ever paid on it, §2.4a) and no second «offer» pushed to the
 *      holder's chat. Every «no» is said on the card in his words, never silent.
 *  (b) THE STAGE (§3.2): an allowed kind's reply on a LEAD chat moves the lead — «AI narx aytdi» when it quoted a
 *      price (`quotedBy`), else «AI birinchi javob berdi» — on the machine's own layer (`moveLeadByMachine`: forward
 *      only, open stages only, the holder's or nobody's lead, the row locked). The holder is the OUTBOX row's
 *      account (crm 1): `setAgentOwner` may have moved the config since the reply went.
 *
 * It does NOT ask `agentRunning`: it records a reply that already went, so a forced «off» has nothing to cancel
 * (crm 9). A refusal by either step's own rules completes the job and is never retried; only a database error
 * throws (the queue retries it, `AFTER_SENT_RETRY_LIMIT`). The last write is the draft's `policy.afterSent` — its
 * absence on a sent row is what the sweep's net re-queues.
 */

/** The kinds whose sent reply moves a lead (§3.2 crm 6) — an ALLOW-list: part 3's greeting moves nothing until named. */
export const AFTER_SENT_STAGE_KINDS = ['reply', 'price', 'hand_back'] as const;

/** Which stored fact made a sent reply a quote — the first that holds (§3.2's «quoted», one stored-facts predicate). */
export type QuotedBy = 'price' | 'offer' | 'calc' | 'estimate';

/**
 * «Quoted» — ONE predicate over what the draft STORED (the `draftOfferStands` shape): his 💵 (kind `price`), a reply
 * carrying a recorded offer, or the machine's own words quoting a VED price (`memory.calcPrices`) or a truck/avia
 * estimate (`memory.estimates`). His ✏️ text carries none of the machine's figures, so its stored memory is no quote.
 * A VED price ranks before an estimate: a reply holding both is a calc price (it moves even while a VED job is open).
 */
export function quotedBy(d: { kind: string; offerId: string | null; finalBody: string | null; policy: unknown }): QuotedBy | null {
  if (d.kind === 'price') return 'price';
  if (d.offerId !== null) return 'offer';
  if (d.finalBody !== null) return null;
  const memory = ((d.policy ?? {}) as Partial<DraftPolicyJson>).memory as { calcPrices?: unknown; estimates?: unknown } | undefined;
  if (Array.isArray(memory?.calcPrices) && memory.calcPrices.length > 0) return 'calc';
  if (Array.isArray(memory?.estimates) && memory.estimates.length > 0) return 'estimate';
  return null;
}

export type StageAsk =
  | { want: 'ai_quoted' | 'ai_contacted' }
  | {
      want: null;
      /** `kind` — not an allowed kind; `client_chat` — no lead on the row (a won lead's client chat moves nothing);
       *  `open_calc` — a truck estimate while a VED job is open sits on the job in progress (his §7 Q12 ⭐ a). */
      reason: 'kind' | 'client_chat' | 'open_calc';
    };

/** Which stage a sent reply asks for (§3.2) — pure; the mover then decides on the locked row. */
export function stageAskOf(f: { kind: string; leadId: string | null; quoted: QuotedBy | null; openCalc: boolean }): StageAsk {
  if (!(AFTER_SENT_STAGE_KINDS as readonly string[]).includes(f.kind)) return { want: null, reason: 'kind' };
  if (f.leadId === null) return { want: null, reason: 'client_chat' };
  if (f.quoted === 'estimate' && f.openCalc) return { want: null, reason: 'open_calc' };
  return { want: f.quoted === null ? 'ai_contacted' : 'ai_quoted' };
}

/** recordOffer's own refusals, in his words — each a reason the price stayed off the card. */
export const OFFER_REFUSAL_WORDS: Record<string, string> = {
  quote_expired: 'VED muhrining muddati o‘tgan',
  answer_expired: 'VED javobining muddati o‘tgan',
  superseded: 'VED javobi endi amal qilmaydi (kartada yangiroq javob yoki muhr bor)',
  discounted_no_upsale: 'VED chegirma bergan — ustamali narx kartaga yozilmaydi',
  below_floor_reason_required: 'narx VED narxidan past chiqdi',
  answer_not_usd: 'VED javobi dollarda emas',
  answer_missing: 'VED javobi topilmadi',
  not_found: 'hisob kartada topilmadi',
  price_positive: 'narx noto‘g‘ri',
};

/** The card's «💳» words (§2.4). Pure — the integration test reads them back off the card. */
export const OFFER_WORDS = {
  written: (total: number) => `💳 Kartaga yozildi: ${dollars(total)} $`,
  notWritten: (why: string) => `💳 Kartaga yozilmadi: ${why}`,
  ownText: 'narxni o‘zingiz yozdingiz — kartaga qo‘lda kiriting',
  noSeat: 'AI o‘rni belgilanmagan',
  seatMoved: 'AI o‘rni boshqa foydalanuvchida',
  behind: 'server hali yangilanmagan',
  foreign: 'bu boshqa sotuvchining kartasi',
  moved: 'VED javobi yoki ustama o‘zgardi — mijozga aytilgan narx endi turmaydi',
  failed: 'kartaga yozib bo‘lmadi',
} as const;

/** «1 359» — whole dollars, the card line's own spelling (calc-markup `dollarsWords`). */
const dollars = (n: number) => dollarsWords(BigInt(Math.round(n)));

/** recordOffer's three stored locales — the agent's own six folded (§2.4: the stored offer text only). */
export function offerLocaleOf(language: string | null): 'uz' | 'ru' | 'en' {
  if (language === 'ru') return 'ru';
  if (language === 'en' || language === 'fa' || language === 'zh') return 'en';
  return 'uz';
}

type OutboxRow = typeof agentOutbox.$inferSelect;
type DraftRow = typeof agentDrafts.$inferSelect;

/** The request's card and its owners — what K3 asks of it (no amount is read here: law 4, calc-price alone). */
async function requestCard(
  requestId: string,
): Promise<{ entityType: 'deal' | 'lead'; entityId: string; leadOwner: string | null; dealOwner: string | null; seller: string | null } | null> {
  const rows = (await db.execute(sql`
    SELECT r.entity_type, r.entity_id::text AS entity_id, l.owner_id::text AS lead_owner, d.owner_id::text AS deal_owner,
           c.sales_manager_id::text AS seller
      FROM calc_requests r
      LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
      LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
      LEFT JOIN clients c ON c.id = d.client_id
     WHERE r.id = ${requestId}::uuid
  `)) as unknown as { entity_type: string; entity_id: string; lead_owner: string | null; deal_owner: string | null; seller: string | null }[];
  const row = [...rows][0];
  if (!row || (row.entity_type !== 'lead' && row.entity_type !== 'deal')) return null;
  return { entityType: row.entity_type, entityId: row.entity_id, leadOwner: row.lead_owner, dealOwner: row.deal_owner, seller: row.seller };
}

/** This reply's mark already written for this request — a retry of the job, never a second offer. Its client price. */
async function markedBefore(draftId: string, requestId: string): Promise<number | null> {
  const rows = (await db.execute(sql`
    SELECT o.client_price_usd::text AS price
      FROM agent_offers a
      JOIN calc_offers o ON o.id = a.offer_id
     WHERE a.draft_id = ${draftId}::uuid AND a.request_id = ${requestId}::uuid
     LIMIT 1
  `)) as unknown as { price: string }[];
  const row = [...rows][0];
  return row ? Number(row.price) : null;
}

/**
 * The card already carries this very promise (fix pass 1, finding 3): the newest offer on the mark's anchor is the
 * AI's own, at this price — a later reply that says the same figure again is no new promise, and a second row would
 * only list it twice (or put back a price a person corrected on the card since; then the newest is theirs and the
 * restatement is written). Never throws a refusal: a read is a read.
 */
async function sameOfferStands(m: CalcPriceMark): Promise<boolean> {
  const anchor = m.anchor === 'seal' ? sql`o.version_id = ${m.anchorId}::uuid` : sql`o.request_id = ${m.requestId}::uuid AND o.version_id IS NULL`;
  const rows = (await db.execute(sql`
    SELECT o.client_price_usd::text AS price, (a.offer_id IS NOT NULL) AS ai
      FROM calc_offers o
      LEFT JOIN agent_offers a ON a.offer_id = o.id
     WHERE ${anchor}
     ORDER BY o.offered_at DESC, o.id DESC
     LIMIT 1
  `)) as unknown as { price: string; ai: boolean }[];
  const row = [...rows][0];
  return row !== undefined && row.ai && Math.abs(Number(row.price) - m.total) < 0.005;
}

/** One mark written as the card's offer — or the words why not. Throws only what is no refusal (a database error). */
async function offerOne(o: OutboxRow, d: DraftRow, m: CalcPriceMark): Promise<string> {
  const before = await markedBefore(d.id, m.requestId);
  if (before !== null) return OFFER_WORDS.written(before);
  if (await sameOfferStands(m)) return OFFER_WORDS.written(m.total);
  const again = await calcPriceFor({ managerUserId: o.managerUserId, peerId: o.peerId, requestId: m.requestId });
  if (!again.ok) return OFFER_WORDS.notWritten(CALC_PRICE_REFUSAL_WORDS[again.reason]);
  const same = again.prices.find((p) => p.requestId === m.requestId && p.anchorId === m.anchorId && p.rule === m.rule && Math.abs(p.total - m.total) < 0.005);
  if (!same) return OFFER_WORDS.notWritten(OFFER_WORDS.moved);
  const card = await requestCard(m.requestId);
  if (!card) return OFFER_WORDS.notWritten(OFFER_REFUSAL_WORDS.not_found!);
  const mayTouch =
    card.entityType === 'lead'
      ? machineMayTouch({ kind: 'lead', ownerId: card.leadOwner }, o.managerUserId)
      : machineMayTouch({ kind: 'deal', ownerId: card.dealOwner, clientSellerId: card.seller }, o.managerUserId);
  if (!mayTouch) return OFFER_WORDS.notWritten(OFFER_WORDS.foreign);
  try {
    await recordOffer(
      m.anchor === 'seal' ? { versionId: m.anchorId } : { requestId: m.requestId },
      {
        clientPriceUsd: m.total,
        locale: offerLocaleOf(d.language),
        // A machine never allows a price below the floor (law 4) — such a price is refused, never queued for approval.
        mayApprove: false,
        expect: { entityType: card.entityType, entityId: card.entityId },
        push: false,
        machine: { draftId: d.id },
      },
      // `offered_by` is the seat the reply left from (K4 — checked by the caller).
      { actorId: o.managerUserId },
    );
  } catch (err) {
    if (err instanceof CalcError) return OFFER_WORDS.notWritten(OFFER_REFUSAL_WORDS[err.code] ?? OFFER_WORDS.failed);
    throw err;
  }
  return OFFER_WORDS.written(m.total);
}

/**
 * Step (a), the offer (§2.4). The lines its card shows — none when the reply quoted no VED price. A refusal that
 * holds for every price (his own text, the seat, the server one migration behind) is said once.
 */
export async function offerStep(o: OutboxRow, d: DraftRow): Promise<string[]> {
  const memory = ((d.policy ?? {}) as Partial<DraftPolicyJson>).memory as { calcPrices?: unknown } | undefined;
  const stored = storedMarksOf(memory?.calcPrices);
  if (stored === null) return [];
  // His ✏️ words went: the figure on the card would not be the one the customer read (money 6).
  if (d.finalBody !== null) return [OFFER_WORDS.notWritten(OFFER_WORDS.ownText)];
  // Only a price the words that WENT state (fix pass 1, finding 3) — the card's offer is the figure the customer read,
  // never one the run was merely offered. The run keeps only those already (`settleCalcPrices`); asked again here of the
  // outbox body itself, the one text that reached the customer.
  const marks = statedCalcMarks(o.body, stored);
  if (marks.length === 0) return [];
  if (!(await agentFullP2Ready())) return [OFFER_WORDS.notWritten(OFFER_WORDS.behind)];
  // Only while the account the reply left from IS the AI seat AND still the holder (K4, hands 2): «never an offer a
  // person would be paid for», and never one written in the name of an account the AI no longer speaks from.
  const { seat, holder } = await seatAndHolder();
  if (seat === null) return [OFFER_WORDS.notWritten(OFFER_WORDS.noSeat)];
  if (seat !== holder || holder !== o.managerUserId.toLowerCase()) return [OFFER_WORDS.notWritten(OFFER_WORDS.seatMoved)];
  const lines: string[] = [];
  for (const m of marks) lines.push(await offerOne(o, d, m));
  return lines;
}

/** Step (b), the stage (§3.2). The outcome's code — for the record and the log, never printed to the customer. */
export async function stageStep(o: OutboxRow, d: DraftRow): Promise<string> {
  const quoted = quotedBy(d);
  // The chain's own status (§1.7): any member open = a VED job in progress. Read only where it can matter.
  const openCalc =
    quoted === 'estimate' && o.leadId !== null ? (await chatCalcChains(o.managerUserId, o.peerId)).some((c) => c.status === 'open') : false;
  const ask = stageAskOf({ kind: d.kind, leadId: o.leadId, quoted, openCalc });
  if (ask.want === null) return ask.reason;
  let moved: MachineMoveResult = await moveLeadByMachine(o.leadId!, ask.want, { holderId: o.managerUserId });
  // A quote is also a reply: with «AI narx aytdi» left empty, the lead still takes «AI birinchi javob berdi».
  if (!moved.moved && moved.reason === 'not_configured' && ask.want === 'ai_quoted') {
    moved = await moveLeadByMachine(o.leadId!, 'ai_contacted', { holderId: o.managerUserId });
    return moved.moved ? 'moved:ai_contacted' : moved.reason;
  }
  return moved.moved ? `moved:${ask.want}` : moved.reason;
}

export type AfterSentOutcome =
  | { outcome: 'not_ready' | 'gone' | 'recorded_before' }
  | { outcome: 'not_sent'; status: string }
  | { outcome: 'done'; offer: string[]; stage: string };

/** The job (§2.4, §3.2). Re-reads the row: only a reply that is `sent` acts. */
export async function handleAfterSent(job: AgentAfterSentJob, now: () => Date = () => new Date()): Promise<AfterSentOutcome> {
  if (!(await agentTablesReady())) return { outcome: 'not_ready' };
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.id, job.outboxId));
  if (!o) return { outcome: 'gone' };
  if (o.status !== 'sent') return { outcome: 'not_sent', status: o.status };
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, o.draftId));
  if (!d) return { outcome: 'gone' };
  if (((d.policy ?? {}) as Partial<DraftPolicyJson>).afterSent) return { outcome: 'recorded_before' };
  const offer = await offerStep(o, d);
  const stage = await stageStep(o, d);
  const mark: AfterSentMark = { at: now().toISOString(), offer, stage };
  // The last write: its absence is what the sweep's net asks again. A merge, never a rewrite of the policy.
  await db
    .update(agentDrafts)
    .set({ policy: sql`${agentDrafts.policy} || ${JSON.stringify({ afterSent: mark })}::jsonb` })
    .where(and(eq(agentDrafts.id, d.id), sql`NOT (${agentDrafts.policy} ? 'afterSent')`));
  if (offer.length > 0) {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(d.id).catch((err: unknown) => logger.warn({ err, draftId: d.id }, '[agent] after-sent card not refreshed'));
  }
  return { outcome: 'done', offer, stage };
}

/** How far back the sweep's net looks, and how long it leaves the listener's own enqueue to land first. */
export const AFTER_SENT_NET = { horizonMs: 24 * 3_600_000, graceMs: 2 * 60_000, perSweep: 50 } as const;

/**
 * The sweep's NET (§2.4, the `queueMissedPrices` shape): a reply sent in the last day with no recorded outcome —
 * the listener's enqueue lost (a blip, a listener built before this round) — is queued again under the SAME job id,
 * so a job that exists (waiting, running, failed) is not doubled. Returns how many it queued.
 */
export async function queueMissedAfterSent(
  now: Date,
  enqueue: (id: string) => Promise<string | null>,
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT o.id::text AS id
      FROM agent_outbox o
      JOIN agent_drafts d ON d.id = o.draft_id
     WHERE o.status = 'sent'
       AND o.sent_at > ${new Date(now.getTime() - AFTER_SENT_NET.horizonMs).toISOString()}::timestamptz
       AND o.sent_at <= ${new Date(now.getTime() - AFTER_SENT_NET.graceMs).toISOString()}::timestamptz
       AND NOT (d.policy ? 'afterSent')
     ORDER BY o.sent_at
     LIMIT ${AFTER_SENT_NET.perSweep}
  `)) as unknown as { id: string }[];
  let queued = 0;
  for (const r of rows) if ((await enqueue(r.id)) !== null) queued += 1;
  return queued;
}
