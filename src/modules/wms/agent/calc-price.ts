import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentCalcLinks, agentDrafts } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { fixedDollars, getSetting, percentHundredths } from '../../platform/settings/service';
import { upsaleEligible } from '../calc/upsale';
import { answerFloorStandsSql } from '../calc/version-set';
import { cardLineOf, centsOf, markupPrice, ruleString, ruleWords, workedExample, type MarkupRule } from './calc-markup';
import { chatCalcChains, chatIdentity, type CalcChain } from './context';
import { machineMayTouch } from './machine-owner';
import { calcFromOurWarehouse } from './types';

/**
 * «VED javobi → ustama qo'shib narx aytadi» (SPEC-P2-v2 §2.2) — the ONE agent file that reads a calculation's
 * amounts (the law-4 fence, agent-fences.test.ts, names it alone). What leaves it is the CLIENT price and nothing
 * else: `CalcPriceMark.total` is the VED figure plus his markup, rounded UP to whole dollars by `calc-markup.ts`;
 * the floor and the rule appear only in `cardLine`, the holder's own card.
 *
 * It prices ONLY requests of this chat's linked chains (agent_calc_links by manager + peer) — never through
 * `standingAnchorsFor`, which is keyed by CARD and returns every job's anchors, expired ones included (judge money
 * 4). Per chain, the newest member's own anchor:
 *  - a seal — the request's current version, not superseded, its `valid_until` not passed, and no concession
 *    (`upsaleEligible`: a VED discount or a band override below the density is the customer's, §2.2a);
 *  - or its «Готово» answer — positive, in dollars, standing (`answerFloorStandsSql`: no newer USD answer and no later
 *    seal on the same card) and within `quote_valid_days` of its completion (recordOffer's own two clocks).
 * Each refusal is a reason with words and no digit; the 💵 card stays exactly as it was.
 *
 * Reached by dynamic import from the send step (drafts `draftOfferStands`) — it imports nothing the listener cannot
 * load (the calc modules it reads are the pure version-set and upsale predicates), and never throws there: the caller
 * answers `calc_price_moved` on a throw.
 */

/** Why the AI did not price a VED answer — each with its words (`CALC_PRICE_REFUSAL_WORDS`). */
export const CALC_PRICE_REFUSALS = ['markup_unreadable', 'not_linked', 'card_moved', 'not_standing', 'expired', 'not_usd', 'discounted'] as const;
export type CalcPriceRefusal = (typeof CALC_PRICE_REFUSALS)[number];

/** In his words — never a code, never a digit (a refusal is no money, pinned). */
export const CALC_PRICE_REFUSAL_WORDS: Record<CalcPriceRefusal, string> = {
  markup_unreadable: 'ustama sozlamasi buzilgan — «Suhbatlar → AI sotuvchi» sahifasida qayta yozing',
  not_linked: 'bu hisob AI orqali yuborilmagan yoki VED hali javob bermagan',
  card_moved: 'hisob turgan karta endi bu chatniki emas',
  not_standing: 'VED javobi endi amal qilmaydi (kartada yangiroq javob yoki muhr bor, yoki qayta hisoblanmoqda)',
  expired: 'VED javobining muddati o‘tgan',
  not_usd: 'VED javobi dollarda emas',
  discounted: 'VED chegirma bergan — bu narxga ustama qo‘shilmaydi',
};

/** One VED answer the AI priced — the CLIENT price and how it was reached, never the floor (law 4, a type-keys test). */
export interface CalcPriceMark {
  requestId: string;
  section: string;
  anchor: 'seal' | 'answer';
  /** The seal's version id, or the answered request's id. */
  anchorId: string;
  /** The rule's canonical string (`ruleString`): `none`, `percent:10`, `fixed:150`. */
  rule: string;
  /** The client price in whole dollars. */
  total: number;
}

export type CalcPriceResult =
  | {
      ok: true;
      prices: CalcPriceMark[];
      /** The holder's card line(s) — the one place the floor and the rule are printed. */
      cardLine: string;
      /** A priced job was submitted as priced from our China warehouses (his third set «3») — the reply says both sentences. */
      fromOurWarehouse: boolean;
    }
  | { ok: false; reason: CalcPriceRefusal };

/** The settings row his own ✅ on a calc-price card (or «✅ Ustama to'g'ri») stamps: the rule string he vouched for. Not a default key. */
export const MARKUP_CONFIRMED_KEY = 'agent_calc_markup_confirmed';

const SECTION_WORDS: Record<string, string> = { yolkira: "yo'lkira", rastamojka: 'rastamojka', podklyuch: 'podklyuch' };

/**
 * His markup as stored, or null when it cannot be read (garbage in the row — fails closed: no tool, no job, today's 💵
 * card). An EMPTY value is the rule `none` — «ustama qo'ymasdan» (his §00 A1), never «off».
 */
export function markupRuleOf(kind: unknown, raw: unknown): MarkupRule | null {
  if (kind !== 'percent' && kind !== 'fixed') return null;
  // A jsonb NUMBER is the same figure: the settings writer binds a typed «10» as text and postgres stores it as the
  // number 10 (measured) — its decimal string is read by the same rule, never the float itself.
  const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof value !== 'string') return null;
  if (value === '') return { kind: 'none' };
  if (kind === 'percent') {
    const h = percentHundredths(value);
    return h === null ? null : { kind: 'percent', hundredths: h };
  }
  const d = fixedDollars(value);
  return d === null ? null : { kind: 'fixed', dollars: d };
}

/** The stored rule (`markupRuleOf` over the two settings). */
export async function readMarkupRule(): Promise<MarkupRule | null> {
  return markupRuleOf(await getSetting('agent_calc_markup_kind'), await getSetting('agent_calc_markup_value'));
}

/**
 * Does this run quote VED answers (§2.3)? The markup can be read AND the chat holds a linked chain the VED answered
 * (`ctx.openCalcs`, the context's own chain read). Read once per run: it offers `calc_price` and the prompt's two lines.
 */
export async function calcPricingFor(ctx: { openCalcs: readonly { status: string }[] }): Promise<boolean> {
  if (!ctx.openCalcs.some((c) => c.status === 'answered')) return false;
  return (await readMarkupRule()) !== null;
}

/** The rule string he last vouched for, or null (none stamped — after the deploy the first machine price waits for him). */
export async function markupConfirmed(): Promise<string | null> {
  const rows = (await db.execute(sql`SELECT value #>> '{}' AS v FROM settings WHERE key = ${MARKUP_CONFIRMED_KEY}`)) as unknown as {
    v: string | null;
  }[];
  return [...rows][0]?.v ?? null;
}

interface AnchorRow {
  id: string;
  section: string | null;
  entity_type: string;
  entity_id: string;
  completed_at: string | Date | null;
  return_reason: string | null;
  answer_amount: string | null;
  answer_currency: string | null;
  answer_stands: boolean;
  not_superseded: boolean;
  version_id: string | null;
  total_usd: string | null;
  discount_usd: string | null;
  density: string | null;
  band_override_min: string | null;
  valid_until: string | Date | null;
}

/** The newest member's anchor facts — the seal (current version) and the answer, read once. */
async function anchorOf(requestId: string): Promise<AnchorRow | null> {
  const rows = (await db.execute(sql`
    SELECT r.id::text AS id, r.section, r.entity_type, r.entity_id::text AS entity_id, r.completed_at, r.return_reason,
           r.answer_amount::text AS answer_amount, r.answer_currency,
           coalesce((${answerFloorStandsSql()}), false) AS answer_stands,
           NOT EXISTS (SELECT 1 FROM calc_requests r2 WHERE r2.supersedes_request_id = r.id) AS not_superseded,
           v.id::text AS version_id, v.total_usd::text AS total_usd, v.discount_usd::text AS discount_usd,
           v.density::text AS density, v.band_override_min::text AS band_override_min, v.valid_until
      FROM calc_requests r
      LEFT JOIN LATERAL (
        SELECT * FROM calc_versions cv WHERE cv.request_id = r.id ORDER BY cv.version_no DESC LIMIT 1
      ) v ON true
     WHERE r.id = ${requestId}::uuid
  `)) as unknown as AnchorRow[];
  return [...rows][0] ?? null;
}

const toNum = (v: string | null) => (v === null ? null : Number(v));

/** The chat's card is the request's card: the chat's lead, or a deal of the chat's client (its phone siblings too). */
function cardIsTheChats(row: Pick<AnchorRow, 'entity_type' | 'entity_id'>, chain: CalcChain, identity: { clientId: string | null; leadId: string | null; codes: { id: string }[] }): boolean {
  if (row.entity_type === 'lead') return identity.leadId !== null && row.entity_id === identity.leadId;
  if (row.entity_type === 'deal') {
    const ids = new Set([...(identity.clientId ? [identity.clientId] : []), ...identity.codes.map((c) => c.id)]);
    // The chain's newest member is the anchor's request: its deal's client was read with the chain.
    return chain.dealClientId !== null && ids.has(chain.dealClientId);
  }
  return false;
}

/** One chain priced, or its refusal. */
async function priceChain(
  chain: CalcChain,
  rule: MarkupRule,
  identity: { clientId: string | null; leadId: string | null; codes: { id: string }[] },
  now: Date,
  validDays: number,
): Promise<{ ok: true; mark: CalcPriceMark; baseCents: bigint } | { ok: false; reason: CalcPriceRefusal }> {
  // A recalculation in progress, or a hand-back: the chain's word on price is not in.
  if (chain.status !== 'answered') return { ok: false, reason: 'not_standing' };
  const row = await anchorOf(chain.newestId);
  if (!row || row.completed_at === null || row.return_reason) return { ok: false, reason: 'not_standing' };
  if (!cardIsTheChats(row, chain, identity)) return { ok: false, reason: 'card_moved' };
  if (!row.not_superseded) return { ok: false, reason: 'not_standing' };
  const section = row.section ?? chain.section ?? '';
  const ruleText = ruleString(rule);
  if (row.version_id !== null) {
    const validUntil = row.valid_until === null ? null : new Date(row.valid_until);
    if (validUntil === null || validUntil.getTime() < now.getTime()) return { ok: false, reason: 'expired' };
    const eligible = upsaleEligible({
      discountUsd: Number(row.discount_usd ?? '0'),
      density: toNum(row.density),
      bandOverrideMin: toNum(row.band_override_min),
    });
    if (!eligible) return { ok: false, reason: 'discounted' };
    const base = centsOf(row.total_usd ?? '');
    if (base === null || base <= 0n) return { ok: false, reason: 'not_standing' };
    const { clientDollars } = markupPrice({ baseCents: base, rule });
    return {
      ok: true,
      baseCents: base,
      mark: { requestId: row.id, section, anchor: 'seal', anchorId: row.version_id, rule: ruleText, total: Number(clientDollars) },
    };
  }
  if (row.answer_amount === null) return { ok: false, reason: 'not_standing' };
  if (row.answer_currency !== 'USD') return { ok: false, reason: 'not_usd' };
  if (!row.answer_stands) return { ok: false, reason: 'not_standing' };
  const completed = new Date(row.completed_at);
  if (completed.getTime() + validDays * 86_400_000 < now.getTime()) return { ok: false, reason: 'expired' };
  const base = centsOf(row.answer_amount);
  if (base === null || base <= 0n) return { ok: false, reason: 'not_standing' };
  const { clientDollars } = markupPrice({ baseCents: base, rule });
  return {
    ok: true,
    baseCents: base,
    mark: { requestId: row.id, section, anchor: 'answer', anchorId: row.id, rule: ruleText, total: Number(clientDollars) },
  };
}

/** Did the chain's submitting reply say the job was priced from our China warehouses (the link draft's own action)? */
async function chainFromOurWarehouse(chain: CalcChain): Promise<boolean> {
  if (chain.memberIds.length === 0) return false;
  const rows = await db
    .select({ actions: agentDrafts.actions })
    .from(agentCalcLinks)
    .innerJoin(agentDrafts, eq(agentDrafts.id, agentCalcLinks.draftId))
    .where(inArray(agentCalcLinks.requestId, chain.memberIds));
  return rows.some((r) => calcFromOurWarehouse(r.actions));
}

/**
 * The client price(s) for this chat's answered VED jobs (§2.2). `requestId`: the one chain holding that request (the
 * announcement, the re-price at every send step); absent: every answered chain of the chat (the `calc_price` tool).
 */
export async function calcPriceFor(input: { managerUserId: string; peerId: bigint; requestId?: string; now?: Date }): Promise<CalcPriceResult> {
  const now = input.now ?? new Date();
  const rule = await readMarkupRule();
  if (rule === null) return { ok: false, reason: 'markup_unreadable' };
  const chains = await chatCalcChains(input.managerUserId, input.peerId);
  const asked = input.requestId === undefined ? chains.filter((c) => c.status === 'answered') : chains.filter((c) => c.memberIds.includes(input.requestId!));
  if (asked.length === 0) return { ok: false, reason: 'not_linked' };
  const identity = await chatIdentity(input.managerUserId, input.peerId);
  const validDays = Number((await getSetting('quote_valid_days')) ?? 30) || 30;
  const prices: CalcPriceMark[] = [];
  const lines: string[] = [];
  let firstRefusal: CalcPriceRefusal | null = null;
  let ours = false;
  for (const chain of asked) {
    const priced = await priceChain(chain, rule, identity, now, validDays);
    if (!priced.ok) {
      firstRefusal ??= priced.reason;
      continue;
    }
    prices.push(priced.mark);
    lines.push(cardLineOf(priced.baseCents, rule, SECTION_WORDS[priced.mark.section] ?? priced.mark.section));
    if (await chainFromOurWarehouse(chain)) ours = true;
  }
  if (prices.length === 0) return { ok: false, reason: firstRefusal ?? 'not_standing' };
  return { ok: true, prices, cardLine: lines.join('\n'), fromOurWarehouse: ours };
}

/** A stored mark as read back off a draft — anything else is no mark (the caller fails closed). */
export function storedMarksOf(raw: unknown): CalcPriceMark[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const marks: CalcPriceMark[] = [];
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) return null;
    const x = m as Record<string, unknown>;
    if (
      typeof x.requestId !== 'string' ||
      typeof x.anchorId !== 'string' ||
      typeof x.rule !== 'string' ||
      typeof x.total !== 'number' ||
      !Number.isFinite(x.total) ||
      (x.anchor !== 'seal' && x.anchor !== 'answer')
    ) {
      return null;
    }
    marks.push({ requestId: x.requestId, section: typeof x.section === 'string' ? x.section : '', anchor: x.anchor, anchorId: x.anchorId, rule: x.rule, total: x.total });
  }
  return marks;
}

/**
 * Every price a draft quoted still stands — priced again NOW for each stored request, the same anchor, the same rule
 * and the same total (≥ 0.005 apart = moved). A refusal, a difference, a mark that cannot be read, or a throw: false
 * (§2.5 — the send step, his ✅ and the machine's press each answer `calc_price_moved`).
 */
export async function calcPricesStand(raw: unknown, chat: { managerUserId: string; peerId: bigint }, now: Date = new Date()): Promise<boolean> {
  try {
    const marks = storedMarksOf(raw);
    if (marks === null) return false;
    for (const m of marks) {
      const again = await calcPriceFor({ managerUserId: chat.managerUserId, peerId: chat.peerId, requestId: m.requestId, now });
      if (!again.ok) return false;
      const same = again.prices.find((p) => p.anchorId === m.anchorId && p.rule === m.rule && Math.abs(p.total - m.total) < 0.005);
      if (!same) return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, peer: String(chat.peerId) }, '[agent] calc price not re-priced');
    return false;
  }
}

/** The gate's four facts of a draft quoting a VED price (§2.3) — each TRUE where it refuses. */
export interface CalcPriceGateFacts {
  /** `markup_unconfirmed`: the rule differs from the one he last vouched for (or none was ever stamped). */
  unconfirmed: boolean;
  /** `calc_price_moved`: a stored price does not stand today. */
  moved: boolean;
  /** `calc_foreign`: a priced request's card is a colleague's (K3). */
  foreign: boolean;
  /** `media`: the customer sent a file after the job landed (the request burst's own files went to the VED). */
  media: boolean;
}

/** Every fact refusing — what a calc-price draft whose facts could not be read is judged on (fails closed). */
export const CALC_PRICE_FACTS_UNREAD: CalcPriceGateFacts = { unconfirmed: true, moved: true, foreign: true, media: true };

/** The four facts, read now — at the scheduling and again at the press. Never throws (a read that fails refuses all). */
export async function calcPriceGateFacts(raw: unknown, chat: { managerUserId: string; peerId: bigint }, now: Date): Promise<CalcPriceGateFacts> {
  try {
    const marks = storedMarksOf(raw);
    if (marks === null) return CALC_PRICE_FACTS_UNREAD;
    const rule = await readMarkupRule();
    const confirmed = await markupConfirmed();
    const unconfirmed = rule === null || confirmed !== ruleString(rule);
    const moved = !(await calcPricesStand(marks, chat, now));
    const ids = [...new Set(marks.map((m) => m.requestId))];
    const cards = (await db.execute(sql`
      SELECT r.id::text AS id, r.entity_type, l.owner_id::text AS lead_owner, d.owner_id::text AS deal_owner, c.sales_manager_id::text AS seller
        FROM calc_requests r
        LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
        LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
        LEFT JOIN clients c ON c.id = d.client_id
       WHERE r.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    `)) as unknown as { id: string; entity_type: string; lead_owner: string | null; deal_owner: string | null; seller: string | null }[];
    const rows = [...cards];
    const foreign =
      rows.length !== ids.length ||
      rows.some((r) =>
        r.entity_type === 'lead'
          ? !machineMayTouch({ kind: 'lead', ownerId: r.lead_owner }, chat.managerUserId)
          : !machineMayTouch({ kind: 'deal', ownerId: r.deal_owner, clientSellerId: r.seller }, chat.managerUserId),
      );
    // The job's landing: each priced chain's newest link (a hand-back loop's resubmission is a landing too) — a file
    // the customer sent after it never reached the VED. The earliest of them, so every such line counts (fails closed).
    const chains = (await chatCalcChains(chat.managerUserId, chat.peerId)).filter((c) => c.memberIds.some((id) => ids.includes(id)));
    const since = chains.length === 0 ? null : new Date(Math.min(...chains.map((c) => c.linkedAt.getTime())));
    const media = since === null ? true : await mediaSince(chat, since);
    return { unconfirmed, moved, foreign, media };
  } catch (err) {
    logger.warn({ err, peer: String(chat.peerId) }, '[agent] auto: the calc price’s facts not read');
    return CALC_PRICE_FACTS_UNREAD;
  }
}

async function mediaSince(chat: { managerUserId: string; peerId: bigint }, since: Date): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM tg_messages m
        LEFT JOIN tg_message_flags f ON f.message_id = m.id
       WHERE m.manager_user_id = ${chat.managerUserId}::uuid AND m.peer_id = ${String(chat.peerId)}::bigint
         AND m.direction = 'in' AND m.has_media AND f.deleted_at IS NULL
         AND m.sent_at > ${since.toISOString()}::timestamptz
    ) AS media
  `)) as unknown as { media: boolean }[];
  return [...rows][0]?.media === true;
}

/** What /suhbatlar/ai's markup card shows (§2.1, §2.7) — the rule, whether he vouched for it, the example, today's cost. */
export interface CalcMarkupView {
  kind: string;
  value: string;
  /** The stored rule can be read; false = garbage in the row (the AI states no VED price until it is rewritten). */
  readable: boolean;
  ruleWords: string | null;
  /** He vouched for this very rule (his ✅ on a VED-price card, or «✅ Ustama to'g'ri»). */
  confirmed: boolean;
  example: string | null;
  /** The empty case, always shown (§00 Words): what «no markup» means. */
  emptyExample: string;
  /** Today (Tashkent): VED prices written onto a card by the AI (`agent_offers`), jobs the AI submitted, and the AI's AI-VED calls. */
  offersToday: number;
  submittedToday: number;
  aiVedToday: number;
  aiVedLimit: number | null;
}

const TODAY = sql`date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'`;

async function countOr0(q: ReturnType<typeof sql>): Promise<number> {
  try {
    const rows = (await db.execute(q)) as unknown as { n: string | number }[];
    return Number([...rows][0]?.n ?? 0);
  } catch {
    // One migration behind (no agent_offers) — nothing of it today.
    return 0;
  }
}

export async function calcMarkupView(): Promise<CalcMarkupView> {
  const kind = await getSetting('agent_calc_markup_kind');
  const value = await getSetting('agent_calc_markup_value');
  const rule = markupRuleOf(kind, value);
  const confirmed = rule !== null && (await markupConfirmed()) === ruleString(rule);
  const limit = Number(await getSetting('ai_calc_daily_limit'));
  return {
    kind: typeof kind === 'string' ? kind : String(kind),
    value: typeof value === 'string' ? value : String(value),
    readable: rule !== null,
    ruleWords: rule === null ? null : ruleWords(rule),
    confirmed,
    example: rule === null ? null : workedExample(rule),
    emptyExample: workedExample({ kind: 'none' }),
    offersToday: await countOr0(sql`SELECT count(*) AS n FROM agent_offers WHERE created_at >= ${TODAY}`),
    submittedToday: await countOr0(sql`SELECT count(*) AS n FROM agent_calc_links WHERE draft_id IS NOT NULL AND created_at >= ${TODAY}`),
    // The AI's own share of the shared AI-VED budget (his §7 Q10 ⭐ a): passes on requests the AI linked.
    aiVedToday: await countOr0(sql`
      SELECT count(*) AS n FROM ai_calc_passes p
       WHERE p.created_at >= ${TODAY} AND p.kind IN ('intake', 'grouping', 'pick', 'invoice')
         AND p.request_id IN (SELECT request_id FROM agent_calc_links)`),
    aiVedLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
  };
}
