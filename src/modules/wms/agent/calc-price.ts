import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentCalcLinks, agentDrafts } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { fixedDollars, getSetting, percentHundredths } from '../../platform/settings/service';
import { upsaleEligible } from '../calc/upsale';
import { answerFloorStandsSql } from '../calc/version-set';
import { cardLineOf, centsOf, markupPrice, ruleString, ruleWords, workedExample, type MarkupRule } from './calc-markup';
import { chatCalcChains, chatIdentity, type CalcChain } from './context';
import { machineMayTouch } from './machine-owner';
import { extractNumbers } from './numbers';
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
 * And only a job whose price the machine may still state at all (fix pass 1): the chain's SUBMITTING reply reached the
 * customer in the machine's own words (`submitReplyOf` — «javob kelishi bilan aytaman» was said there and nowhere
 * else; his ✏️ words promised whatever he wrote, an ❌ promised nothing), and he has not priced it himself
 * (`ownerPricedChain` — his 💵 for any member of the chain, given, approved or on its way: his figure always outranks
 * the machine's, at every door that prices it, never only at the VED answer's job). Nor where a PERSON already gave the
 * price on the card (`personOfferOn`, review crm 1): the newest released offer on the very anchor it would price is a
 * person's — a seller's or his own, written through the card's offer form — so the machine never states, and never writes
 * back over it, an older figure of its own.
 *
 * Reached by dynamic import from the send step (drafts `draftOfferStands`) — it imports nothing the listener cannot
 * load (the calc modules it reads are the pure version-set and upsale predicates), and never throws there: the caller
 * answers `calc_price_moved` on a throw.
 */

/** Why the AI did not price a VED answer — each with its words (`CALC_PRICE_REFUSAL_WORDS`). */
export const CALC_PRICE_REFUSALS = [
  'markup_unreadable',
  'not_linked',
  'owner_words',
  'owner_priced',
  'person_offer',
  'card_moved',
  'not_standing',
  'expired',
  'not_usd',
  'discounted',
  'answer_noted',
] as const;
export type CalcPriceRefusal = (typeof CALC_PRICE_REFUSALS)[number];

/** In his words — never a code, never a digit (a refusal is no money, pinned). */
export const CALC_PRICE_REFUSAL_WORDS: Record<CalcPriceRefusal, string> = {
  markup_unreadable: 'ustama sozlamasi buzilgan — «Suhbatlar → AI sotuvchi» sahifasida qayta yozing',
  not_linked: 'bu hisob AI orqali yuborilmagan yoki VED hali javob bermagan',
  owner_words: 'hisoblatishga yuborilgani haqidagi javob ✏️ bilan qo‘lda yozilgan — narx ham qo‘lda beriladi',
  owner_priced: 'bu hisobga narx 💵 bilan qo‘lda berilgan — o‘sha narx ustun',
  person_offer: 'kartada sotuvchining yangiroq narxi turibdi — o‘sha narx ustun',
  card_moved: 'hisob turgan karta endi bu chatniki emas',
  not_standing: 'VED javobi endi amal qilmaydi (kartada yangiroq javob yoki muhr bor, yoki qayta hisoblanmoqda)',
  expired: 'VED javobining muddati o‘tgan',
  not_usd: 'VED javobi dollarda emas',
  discounted: 'VED chegirma bergan — bu narxga ustama qo‘shilmaydi',
  answer_noted: 'VED javobida sotuvchiga izoh bor — narx shartli bo‘lishi mumkin, uni o‘zingiz bering',
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
      /**
       * Each price's job named by its goods (the request's first lines, beside `prices`, '' when none were listed) — so
       * the model and his card can tell which cargo a figure is for when a chat holds two jobs. Never an amount.
       */
      goods: string[];
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

/**
 * How the reply that SUBMITTED a job reached the customer (SPEC-P2-v2 §1.2): through its draft's outbox row — `sent` in
 * the machine's own words (`final_body` NULL), `own_words` when his ✏️ text went instead, `unsent` for a draft that never
 * went (a press that lost after the landing, his ❌, a row cancelled) or no draft at all. ONE rule for the VED answer's
 * job (calc-loop `calcLinkReplySent`), the `calc_price` tool and every re-price.
 */
export type SubmitReply = 'sent' | 'own_words' | 'unsent';

export async function submitReplyOf(draftId: string | null): Promise<SubmitReply> {
  if (draftId === null) return 'unsent';
  const rows = (await db.execute(sql`
    SELECT o.status, (d.final_body IS NOT NULL) AS own
      FROM agent_drafts d
      LEFT JOIN agent_outbox o ON o.draft_id = d.id
     WHERE d.id = ${draftId}::uuid
  `)) as unknown as { status: string | null; own: boolean }[];
  const row = [...rows][0];
  if (!row || row.status !== 'sent') return 'unsent';
  return row.own ? 'own_words' : 'sent';
}

/** The chain's newest link's submitting draft — the reply that last told the customer this job was sent. */
async function chainSubmitDraft(chat: { managerUserId: string; peerId: bigint }, root: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT draft_id::text AS draft_id FROM agent_calc_links
     WHERE manager_user_id = ${chat.managerUserId}::uuid AND peer_id = ${String(chat.peerId)}::bigint AND root_request_id = ${root}::uuid
     ORDER BY created_at DESC
     LIMIT 1
  `)) as unknown as { draft_id: string | null }[];
  return [...rows][0]?.draft_id ?? null;
}

/**
 * His own figure is on this chain (judge money 11, hands 5; fix passes 1 and 3): a 💵 draft of his naming any member —
 * live, approved, sent, approved and then cancelled before it went (a night hold the customer's morning line
 * overtook), or still waiting for his ✅ when the customer's next line superseded it (status `superseded` with nobody's
 * decision — the newer line took his card, not his figure; fix pass 3) — or his «💵 Narx yozaman» armed for one of
 * them. The machine then prices the chain nowhere: not the VED answer's job, not the inbound tool, not at the press or
 * the send step. Only his ❌ or 🙋 on that 💵 itself, or its expiry, takes it back off the chain.
 *
 * The wait is read where it lives in BOTH processes (fix pass 3, waits `waitLiveFor`): the bot's memory (the bot and
 * the app's worker are one process — memory stays the reader there), and the waits' own table (0130), because the send
 * step runs in the LISTENER, which holds no wait in memory — read from memory alone, a machine price pressed before he
 * pressed «💵 Narx yozaman» went to the customer while he was typing his own.
 */
export async function ownerPricedChain(managerUserId: string, peerId: bigint, memberIds: readonly string[]): Promise<boolean> {
  if (memberIds.length === 0) return false;
  const members = sql.join(memberIds.map((id) => sql`${id}`), sql`, `);
  const [drafted] = await db
    .select({ id: agentDrafts.id })
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.managerUserId, managerUserId),
        eq(agentDrafts.peerId, peerId),
        eq(agentDrafts.kind, 'price'),
        or(
          inArray(agentDrafts.status, ['pending', 'editing', 'approved']),
          // Superseded by the customer's next line — never by a VED recalculation (`retirePricesOf`'s `stale: 'recalc'`):
          // that one retired his figure as no longer standing, and the corrected answer is the machine's to price.
          and(
            eq(agentDrafts.status, 'superseded'),
            isNull(agentDrafts.decidedBy),
            sql`coalesce(${agentDrafts.policy}->>'stale', '') <> 'recalc'`,
          ),
        ),
        sql`${agentDrafts.policy}->>'priceRequestId' IN (${members})`,
      ),
    )
    .limit(1);
  if (drafted) return true;
  const { waitLiveFor } = await import('../../platform/telegram/waits');
  return waitLiveFor('agent_price', 'requestId', memberIds);
}

/** The job's goods as the customer named them — its first lines, newest member first; never an amount. */
async function chainGoods(memberIds: readonly string[]): Promise<string> {
  if (memberIds.length === 0) return '';
  const rows = (await db.execute(sql`
    SELECT i.name FROM calc_request_items i JOIN calc_requests r ON r.id = i.request_id
     WHERE i.request_id IN (${sql.join(memberIds.map((id) => sql`${id}::uuid`), sql`, `)})
     ORDER BY r.requested_at DESC, i.seq
     LIMIT 6
  `)) as unknown as { name: string | null }[];
  const names: string[] = [];
  for (const r of rows) {
    const name = (r.name ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40);
    if (name !== '' && !names.includes(name)) names.push(name);
    if (names.length === 3) break;
  }
  return names.join(', ');
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
  /** The VED wrote a note for the seller beside its «Готово» figure (`answer_note`, not blank) — never its text. */
  answer_noted: boolean;
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
           coalesce(btrim(r.answer_note), '') <> '' AS answer_noted,
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
  chat: { managerUserId: string; peerId: bigint },
  chain: CalcChain,
  rule: MarkupRule,
  identity: { clientId: string | null; leadId: string | null; codes: { id: string }[] },
  now: Date,
  validDays: number,
): Promise<{ ok: true; mark: CalcPriceMark; baseCents: bigint } | { ok: false; reason: CalcPriceRefusal }> {
  // A recalculation in progress, or a hand-back: the chain's word on price is not in.
  if (chain.status !== 'answered') return { ok: false, reason: 'not_standing' };
  // The machine states a VED price only where it said «javob kelishi bilan aytaman» itself (§1.2): the submitting reply
  // went, in its own words. A press that lost after the landing, his ❌, his ✏️ text — the price is his to give.
  const submit = await submitReplyOf(await chainSubmitDraft(chat, chain.root));
  if (submit === 'unsent') return { ok: false, reason: 'not_linked' };
  if (submit === 'own_words') return { ok: false, reason: 'owner_words' };
  // His figure outranks the machine's on the whole chain (judge money 11): his 💵 given, waiting, or being typed.
  if (await ownerPricedChain(chat.managerUserId, chat.peerId, chain.memberIds)) return { ok: false, reason: 'owner_priced' };
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
    if (await personOfferOn({ versionId: row.version_id })) return { ok: false, reason: 'person_offer' };
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
  // The VED's note to the seller («1 kub uchun narx», «QQS alohida», «sertifikatsiz +15 %») qualifies the figure, and
  // «Готово» is used exactly on the jobs the workspace cannot seal (fix pass 4, check send-1): the machine states no
  // price beside a condition it cannot read. The note is his — on the announcement — and never the model's.
  if (row.answer_noted) return { ok: false, reason: 'answer_noted' };
  const base = centsOf(row.answer_amount);
  if (base === null || base <= 0n) return { ok: false, reason: 'not_standing' };
  if (await personOfferOn({ requestId: row.id })) return { ok: false, reason: 'person_offer' };
  const { clientDollars } = markupPrice({ baseCents: base, rule });
  return {
    ok: true,
    baseCents: base,
    mark: { requestId: row.id, section, anchor: 'answer', anchorId: row.id, rule: ruleText, total: Number(clientDollars) },
  };
}

/** What the card shows of an anchor's offers — the newest one that reached it, and whose it is. */
export interface CardOffer {
  /** Its client price in dollars (the card's `quoted_amount` — never the floor). */
  price: number;
  /** The machine's own (an `agent_offers` mark), else a person's. */
  ai: boolean;
}

/**
 * The newest RELEASED offer on an anchor — the one the card shows (review crm 1; fix pass 3): in the order it reached
 * the card (`lastReleasedOfferFor`'s order: the approval for a below-floor promise, else the offer), and whose it is.
 * ONE reading for both questions asked of it: «a person's price stands here» (`personOfferOn`, every door that prices)
 * and «the machine's own figure already stands here» (after-sent `sameOfferStands`, the offer step) — asked two ways,
 * a pending below-floor promise read as the newest word made the AI write its own restatement twice, and a seller's
 * promise approved after the AI's figure left the offer step saying «yozildi» over a card holding his. A below-floor
 * promise still waiting for approval reached nobody and is no price yet; an offer on an anchor the machine is not
 * pricing (an answer a later seal outranked) is not this anchor's word. One migration behind 0149 there is no
 * `agent_offers` and no machine offer — every offer on the card is a person's, read without the table (never a 42P01 on
 * the tool, the VED answer's job or a send step).
 */
export async function newestReleasedOfferOn(anchor: { versionId: string } | { requestId: string }): Promise<CardOffer | null> {
  const on = 'versionId' in anchor ? sql`o.version_id = ${anchor.versionId}::uuid` : sql`o.request_id = ${anchor.requestId}::uuid AND o.version_id IS NULL`;
  const { agentFullP2Ready } = await import('./config');
  const ai = (await agentFullP2Ready()) ? sql`EXISTS (SELECT 1 FROM agent_offers a WHERE a.offer_id = o.id)` : sql`false`;
  const rows = (await db.execute(sql`
    SELECT o.client_price_usd::text AS price, ${ai} AS ai
      FROM calc_offers o
     WHERE ${on}
       AND (NOT o.below_floor OR o.approved_at IS NOT NULL)
     ORDER BY coalesce(o.approved_at, o.offered_at) DESC, o.id DESC
     LIMIT 1
  `)) as unknown as { price: string; ai: boolean }[];
  const row = [...rows][0];
  return row ? { price: Number(row.price), ai: row.ai === true } : null;
}

/**
 * A PERSON's price is the newest word on this anchor (review crm 1): the card's offer (`newestReleasedOfferOn`) carries
 * no AI mark. A seller's or the holder's own hand offer outranks the machine's VED price exactly as his 💵 does: the
 * tool, the VED answer's job, the press, his ✅, every send step and the offer step refuse it. Reads no amount of the
 * calculation (law 4 stays this file's).
 */
async function personOfferOn(anchor: { versionId: string } | { requestId: string }): Promise<boolean> {
  return (await newestReleasedOfferOn(anchor))?.ai === false;
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
  const goods: string[] = [];
  let firstRefusal: CalcPriceRefusal | null = null;
  let ours = false;
  for (const chain of asked) {
    const priced = await priceChain(input, chain, rule, identity, now, validDays);
    if (!priced.ok) {
      firstRefusal ??= priced.reason;
      continue;
    }
    prices.push(priced.mark);
    lines.push(cardLineOf(priced.baseCents, rule, SECTION_WORDS[priced.mark.section] ?? priced.mark.section));
    goods.push(await chainGoods(chain.memberIds));
    if (await chainFromOurWarehouse(chain)) ours = true;
  }
  if (prices.length === 0) return { ok: false, reason: firstRefusal ?? 'not_standing' };
  return { ok: true, prices, cardLine: lines.join('\n'), fromOurWarehouse: ours, goods };
}

/**
 * The VED prices a reply STATES (fix pass 1) — a mark whose client total stands in the words as a figure: dollars, or a
 * bare number (the way the policy reads a `calc_price` line, money in dollars first). What the draft keeps
 * (`memory.calcPrices`), what the card writes as an offer and what moves a lead to «AI narx aytdi»: a price the tool
 * merely OFFERED — a second job's, or one the reply chose not to say — reached nobody and settles nothing. Pure.
 */
export function statedCalcMarks(body: string, marks: readonly CalcPriceMark[]): CalcPriceMark[] {
  const said = extractNumbers(body)
    .filter((f) => (f.kind === 'money' && f.currency === 'USD') || (f.kind === 'plain' && f.fixed !== true && f.perUnit !== true))
    .map((f) => f.value);
  return marks.filter((m) => said.some((v) => Math.abs(v - m.total) < 0.005));
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
 * Does every price a draft quoted still stand — priced again NOW for each stored request, the same anchor, the same rule
 * and the same total (≥ 0.005 apart = moved)? `owner_priced` when his own 💵 now stands on a quoted job, `person_offer`
 * when a person's offer is the card's newest word on it (the gate says each in its own words — fix pass 3: a person's
 * price read at the press as «VED javobi yoki ustama o‘zgardi», which neither had); any other refusal, a difference, a
 * mark that cannot be read, or a throw: `moved`.
 */
export async function calcPricesStanding(
  raw: unknown,
  chat: { managerUserId: string; peerId: bigint },
  now: Date,
): Promise<'stands' | 'owner_priced' | 'person_offer' | 'moved'> {
  try {
    const marks = storedMarksOf(raw);
    if (marks === null) return 'moved';
    for (const m of marks) {
      const again = await calcPriceFor({ managerUserId: chat.managerUserId, peerId: chat.peerId, requestId: m.requestId, now });
      if (!again.ok) return again.reason === 'owner_priced' || again.reason === 'person_offer' ? again.reason : 'moved';
      const same = again.prices.find((p) => p.anchorId === m.anchorId && p.rule === m.rule && Math.abs(p.total - m.total) < 0.005);
      if (!same) return 'moved';
    }
    return 'stands';
  } catch (err) {
    logger.warn({ err, peer: String(chat.peerId) }, '[agent] calc price not re-priced');
    return 'moved';
  }
}

/**
 * Every price a draft quoted still stands (`calcPricesStanding`). False on anything else (§2.5 — the send step, his ✅
 * and the machine's press each answer `calc_price_moved`): his own 💵 on the job is a price that no longer stands for
 * the machine either.
 */
export async function calcPricesStand(raw: unknown, chat: { managerUserId: string; peerId: bigint }, now: Date = new Date()): Promise<boolean> {
  return (await calcPricesStanding(raw, chat, now)) === 'stands';
}

/** The gate's six facts of a draft quoting a VED price (§2.3) — each TRUE where it refuses. */
export interface CalcPriceGateFacts {
  /** `markup_unconfirmed`: the rule differs from the one he last vouched for (or none was ever stamped). */
  unconfirmed: boolean;
  /** `calc_price_moved`: a stored price does not stand today. */
  moved: boolean;
  /** `calc_owner_priced`: his own 💵 now stands on a quoted job — given, waiting or being typed (fix pass 1). */
  ownerPriced: boolean;
  /** `calc_person_offer`: a person's offer is the card's newest word on a quoted job (review crm 1; fix pass 3). */
  personOffer: boolean;
  /** `calc_foreign`: a priced request's card is a colleague's (K3). */
  foreign: boolean;
  /** `media`: the customer sent a file after the job landed (the request burst's own files went to the VED). */
  media: boolean;
}

/** Every fact refusing — what a calc-price draft whose facts could not be read is judged on (fails closed). */
export const CALC_PRICE_FACTS_UNREAD: CalcPriceGateFacts = {
  unconfirmed: true,
  moved: true,
  ownerPriced: true,
  personOffer: true,
  foreign: true,
  media: true,
};

/** The six facts, read now — at the scheduling and again at the press. Never throws (a read that fails refuses all). */
export async function calcPriceGateFacts(raw: unknown, chat: { managerUserId: string; peerId: bigint }, now: Date): Promise<CalcPriceGateFacts> {
  try {
    const marks = storedMarksOf(raw);
    if (marks === null) return CALC_PRICE_FACTS_UNREAD;
    const rule = await readMarkupRule();
    const confirmed = await markupConfirmed();
    const unconfirmed = rule === null || confirmed !== ruleString(rule);
    const standing = await calcPricesStanding(marks, chat, now);
    const moved = standing === 'moved';
    const ownerPriced = standing === 'owner_priced';
    const personOffer = standing === 'person_offer';
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
    return { unconfirmed, moved, ownerPriced, personOffer, foreign, media };
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
  /** The rule's canonical string as this page draws it (`ruleString`) — what «✅ Ustama to'g'ri» vouches for; null unreadable. */
  rule: string | null;
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
    rule: rule === null ? null : ruleString(rule),
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
