import { randomBytes } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentConversations, agentDrafts, clients, leads, notifications, tgChatRules, tgPeerPulls } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { actorGrants } from '../../platform/rbac/authorize';
import { phoneSiblingClients } from '../client-cabinet/service';
import { digestBody, hitWords } from './card';
import { actionLines } from './card-io';
import { agentRunning, readAgentConfig, setAgentMode, AgentConfigError } from './config';
import { chatProof } from './context';
import { decideDraft, submitOwnText, type DecideRefusal, type SupersededDetail } from './decide';
import { KbError, carriesMoney, moneyIn, personalBitsWithBook, writeKbFact, type KbRefusal } from './kb';
import { HUMAN_TAKEOVER_HOURS } from './limits';
import { extractNumbers } from './numbers';
import { knownNamesForMask } from './style';
import { priceDraftFromText, type PriceDraftResult } from './calc-loop';
import { withdrawRepliesFor } from './drafts';
import { editAgentCopies, type AgentCopy } from './purge';
import type { PolicyHit } from './policy';
import type { ComposedAction, DraftPolicyJson } from './types';

/**
 * The bot's side of the agent, as plain functions the grammY shell calls
 * (platform reaches wms by dynamic import — the startBoss crossing). Every
 * answer is WORDS: a refusal the person cannot read is a button that «does
 * nothing».
 */

export type AgentOp = 's' | 'e' | 'r' | 'h' | 'p' | 'n' | 'k' | 'x' | 'c' | 'b' | 'g' | 'u' | 'z';
export type AgentWaitKind = 'agent_edit' | 'agent_price' | 'agent_code';

export interface PressAnswer {
  toast: string;
  reply?: string;
  /** Inline buttons under `reply` — the question's own answer (the 📌 confirm, I3). */
  buttons?: { text: string; callback_data: string }[][];
  /**
   * A second message right after `reply`, on its own (C4): the draft's text
   * as it stands, so he can long-press it, copy it and change it — the bot
   * cannot put text into his typing box. A swipe-reply to it answers the
   * wait like one to the prompt.
   */
  followUp?: string;
  /** A one-text wait the shell arms (and drops the other agent waits). */
  arm?: { kind: AgentWaitKind; payload: Record<string, string> };
  /** Drop this wait (the press answered it). */
  drop?: AgentWaitKind;
  /** Drop the ✏️ wait only if it names THIS draft — a ✅ ended the edit it was armed for (C7). */
  dropEditOf?: string;
  /**
   * Said when that wait WAS armed and this press dropped it — a ✅ refused
   * because the draft is gone: his next text would otherwise go down the
   * ladder (a code lookup, the AI assistant) while he meant it for the card.
   */
  editClosed?: string;
  /**
   * The draft whose WORDS a message of this answer carries — ✏️'s copy to
   * change, a refusal handing the text over to send by hand. The shell
   * records each such message on the draft's card row (`recordCardCopies`),
   * where the chat's purge blanks it like the card (review leak-9).
   */
  quotes?: { draftId: string; parts: ('reply' | 'followUp')[] };
}

/** What his typed text is answered with — words, and a button under them when the words lead to one. */
export interface AgentTextAnswer {
  text: string;
  buttons?: { text: string; callback_data: string }[][];
}

const DECIDE_WORDS: Record<DecideRefusal, string> = {
  not_found: 'Qoralama topilmadi.',
  not_account_holder: "Bu qoralama sizning akkauntingizdan emas — faqat akkaunt egasi tasdiqlaydi.",
  agent_off: "AI sotuvchi o'chirilgan.",
  not_live: 'Bu qoralama endi faol emas.',
  editing: "Avval o'z matningizni yozing.",
  stale_card: "Karta o'zgargan — yangi kartadagi ✅ ni bosing.",
  policy_block: 'Bu matn shunday yuborilmaydi — «✏️ O‘zgartirish»ni bosing va to‘g‘ri matnni shu botga yozing.',
  listener_behind: "Telegram ko'prigi (tinglovchi) yangilanmagan — xabar ketmaydi. Serverda tg-listen'ni qayta quring.",
  sending_disabled: "CRM'dan Telegramga yuborish o'chirilgan (Sozlamalar) — javob ketmaydi. Matnni nusxalab o'zingiz yuboring.",
  // A newer card is coming (decide `redraftNewest`); the other answers are `SUPERSEDED_WORDS`.
  superseded: 'Mijoz yana yozdi — yangi qoralama tayyorlanadi.',
  taken_over: "Siz allaqachon o'zingiz javob bergansiz.",
  budget_spent: "Bugungi AI yuborish chegarasi tugadi — matnni nusxalab o'zingiz yuboring.",
  calc_not_queued: 'Hisoblatish navbatga tushmadi — javob yuborilmadi (sababi kartada).',
  calc_in_flight: '⏳ Hisoblatish hozir navbatga qo‘yilmoqda — bir daqiqadan keyin kartani qarang.',
  identity_changed: "Chat endi boshqa mijozga bog'langan (yoki hech kimga) — bu javob ketmaydi.",
  window_closed:
    "Bu lidni mijoz topuvchi agent topgan: unga faqat dushanba–shanba 10:00–17:00 da yoziladi, o'sha paytgacha mijozning xabari 24 soatdan eskiradi — javob navbatga qo'yilmadi. Ish vaqtida o'zingiz yozing.",
  empty: "Javob bo'sh.",
};

/** ✅ refused because the customer wrote again and no run will draft the newer message — he answers it. */
export const SUPERSEDED_NO_DRAFT = 'Mijoz yana yozdi — bu javob ketmaydi. Yangi xabariga o‘zingiz javob bering.';

/**
 * A ✅ refused as `superseded`, in the words of what the press found (decide
 * `SUPERSEDED_AS`): a customer who EDITED his line did not write again, and a
 * line whose reply he already approved is not his to answer a second time
 * (review). The page says the same through its own labels (web-actions).
 */
export const SUPERSEDED_WORDS: Record<SupersededDetail, string> = {
  redrafting: DECIDE_WORDS.superseded,
  no_draft: SUPERSEDED_NO_DRAFT,
  edited_redrafting: 'Mijoz xabarini tahrirladi — yangi qoralama tayyorlanadi.',
  edited_no_draft: 'Mijoz xabarini tahrirladi — bu javob ketmaydi. Unga o‘zingiz javob bering.',
  answered: 'Mijozning so‘nggi xabariga javob allaqachon tasdiqlangan — bu javob ketmaydi.',
};

/** A ✅ refusal that RETIRED the draft (or found it gone): the edit armed for it is over. */
const RETIRING: ReadonlySet<DecideRefusal> = new Set(['superseded', 'taken_over', 'not_live', 'identity_changed']);

/**
 * How a figure is typed AGAIN after a refusal. The text that was refused
 * consumed the price wait (the shell drops it before the effect — the
 * redelivery rule, agent-bot `agentTextSlot`), so a plain retype reaches
 * nobody; a swipe-reply to the answer card names its own target
 * (`agentCardFor`), and a second 💵 arms the wait afresh. A refusal that
 * asks him to type again says one of the two, or it promises what the bot
 * does not do.
 */
export const PRICE_RETYPE = "Qaytadan: «💵 Narx yozaman» turgan kartaga javob (reply) qilib yozing yoki tugmani qayta bosing.";

/**
 * «💵 Narx yozaman»'s refusals, in his words (his 6 b: nothing is recorded,
 * so none of them speaks of an offer, a floor or a deal card). The ambiguous
 * figure's sentence is built from its two readings (`priceRefusalText`).
 */
const PRICE_WORDS: Record<Exclude<Exclude<PriceDraftResult, { ok: true }>['code'], 'ambiguous_number'>, string> = {
  not_linked: "Bu hisob AI sotuvchi orqali yuborilmagan — narx javobi yozilmadi.",
  not_account_holder: 'Bu suhbat sizning akkauntingizda emas.',
  bad_number: `Narxni dollarda son bilan yozing, masalan: 1250. ${PRICE_RETYPE}`,
  editing_open: `Bu suhbatda siz yozayotgan javob bor — avval uni tugating yoki ❌ bilan yoping. Narx javobi yozilmadi. ${PRICE_RETYPE}`,
  no_anchor: "Bu chatda mijozning javob beriladigan xabari yo'q — narx javobi yozilmadi.",
  recalculated: "🔄 VED bu hisobni qayta hisoblayapti — eski javobga narx yozilmaydi. Yangi javob kelganda uning kartasidagi «💵 Narx yozaman» bilan narx bering.",
};

/** What a refused «💵» says — an ambiguous figure asks back with both readings (his B4 a), never guesses. */
export function priceRefusalText(r: Exclude<PriceDraftResult, { ok: true }>, typed: string): string {
  if (r.code !== 'ambiguous_number') return PRICE_WORDS[r.code];
  const { thousands, decimal } = r.readings;
  const shown = typed.trim();
  return decimal !== null
    ? `«${shown}» — ${thousands} dollarmi yoki ${decimal} dollarmi? Aniq yozing: ${thousands} yoki ${decimal}. ${PRICE_RETYPE}`
    : `«${shown}» — ${thousands} dollarmi? Unda shunday yozing: ${thousands}. ${PRICE_RETYPE}`;
}

/**
 * «💵 Narx yozaman»'s question and its answer (his 6 b, 2026-10-24): his
 * figure becomes ONE sentence in the customer's language and nothing else is
 * written anywhere — so neither sentence says «taklif» (an offer is a row on
 * the deal card, and there is none).
 */
export const PRICE_PROMPT =
  '💵 Mijozga beriladigan narxni dollarda yozing (masalan 1250). Men uni mijoz tilida bitta jumla qilib qoralama tayyorlayman — bitim kartasiga hech narsa yozilmaydi, siz ✅ bosasiz.';
export const PRICE_DRAFTED = '💵 Narx javobi tayyor — kartani tekshirib ✅ bosing.';

function hhmm(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3_600_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

async function deciderFor(userId: string) {
  const grants = await actorGrants(userId);
  return { id: userId, roles: grants.roles, permissions: grants.permissions };
}

/**
 * What 🙋 says when it took approved replies back with it (ident fix F10):
 * «the chat is mine» cancels every reply still waiting in that chat — his
 * own ✏️ words and 💵 price among them, which the send step cannot tell from
 * the machine's — and the only other trace was an edit to an older card
 * further up the chat. Said on the press, in a message that stays.
 */
export function humanTakeoverWords(withdrawn: { total: number; own: number } | undefined): { toast: string; reply?: string } {
  const toast = `🙋 Suhbat ${HUMAN_TAKEOVER_HOURS} soat sizniki`;
  if (!withdrawn || withdrawn.total === 0) return { toast };
  const own = withdrawn.own > 0 ? ` (${withdrawn.own} tasi — o‘zingiz yozgan matn)` : '';
  return {
    toast: `${toast} — ${withdrawn.total} ta javob bekor qilindi`,
    reply: `${toast}. Tasdiqlangan, hali ketmagan ${withdrawn.total} ta javob bekor qilindi${own} — kerak bo‘lsa mijozga Telegramda o‘zingiz yozing.`,
  };
}

/** One press of an agent button. `staffId` is the chat's linked person — never an id from the button. */
export async function agentPress(staffId: string, op: AgentOp, id: string, digest: string | undefined): Promise<PressAnswer> {
  const actor = await deciderFor(staffId);
  const ctx = { actorId: staffId };
  switch (op) {
    case 's': {
      const r = await decideDraft(actor, id, 'send', { digest: digest ?? null }, ctx);
      if (!r.ok) {
        // Both refusals leave him to send it himself — so the text comes with the words.
        if (r.code === 'budget_spent' || r.code === 'sending_disabled') {
          const [d] = await db.select({ body: agentDrafts.finalBody, proposed: agentDrafts.proposedBody }).from(agentDrafts).where(eq(agentDrafts.id, id));
          const toast = r.code === 'budget_spent' ? '⛔ Chegara tugadi' : '⛔ Yuborish o‘chirilgan';
          return { toast, reply: `${DECIDE_WORDS[r.code]}\n\n${d?.body ?? d?.proposed ?? ''}`, quotes: { draftId: id, parts: ['reply'] } };
        }
        const words =
          r.code === 'superseded' ? (SUPERSEDED_WORDS[r.detail as SupersededDetail] ?? DECIDE_WORDS.superseded) : DECIDE_WORDS[r.code];
        return {
          toast: words.slice(0, 190),
          reply: r.code === 'listener_behind' ? DECIDE_WORDS.listener_behind : undefined,
          ...(RETIRING.has(r.code) ? { dropEditOf: id, editClosed: `✏️ ${words} Endi shu botga yozganingiz bu kartaga qo‘yilmaydi.` } : {}),
        };
      }
      const soon = !r.sendAt || r.sendAt.getTime() <= Date.now() + 60_000;
      // An edit he armed for this draft and did not use is over: the ✅ sent the card's words.
      return { toast: soon ? '✅ Yuborilmoqda' : `✅ ${hhmm(r.sendAt!)} da ketadi`, dropEditOf: id };
    }
    case 'e': {
      const r = await decideDraft(actor, id, 'edit', {}, ctx);
      if (!r.ok) return { toast: DECIDE_WORDS[r.code].slice(0, 190) };
      const [d] = await db.select({ finalBody: agentDrafts.finalBody, proposedBody: agentDrafts.proposedBody }).from(agentDrafts).where(eq(agentDrafts.id, id));
      const current = d ? digestBody(d) : '';
      return {
        toast: '✏️',
        reply: EDIT_PROMPT,
        // Telegram's own cap is 4 096; a text that long is a blocked one to shorten anyway.
        ...(current
          ? { followUp: current.length > 4000 ? `${current.slice(0, 4000)}…` : current, quotes: { draftId: id, parts: ['followUp'] } }
          : {}),
        arm: { kind: 'agent_edit', payload: { draftId: id } },
      };
    }
    case 'r':
    case 'h': {
      const r = await decideDraft(actor, id, op === 'r' ? 'reject' : 'human', {}, ctx);
      if (!r.ok) return { toast: DECIDE_WORDS[r.code].slice(0, 190) };
      if (op === 'r') return { toast: '❌ Rad etildi', drop: 'agent_edit' };
      const taken = humanTakeoverWords(r.withdrawn);
      return { toast: taken.toast, ...(taken.reply ? { reply: taken.reply } : {}), drop: 'agent_edit' };
    }
    case 'p': {
      return {
        toast: '💵',
        // His 6 b: the figure goes to the customer only — the prompt promises nothing it does not do.
        reply: PRICE_PROMPT,
        arm: { kind: 'agent_price', payload: { requestId: id } },
      };
    }
    case 'g':
    case 'u':
    case 'z':
      return kbPress(staffId, op, id, digest);
    case 'n':
    case 'k':
    case 'x':
    case 'c':
    case 'b':
      return strangerPress(staffId, op, id, digest);
  }
}

/**
 * ✏️'s question (2026-10-29): «O‘zim yozaman» and «oddiy xabar bilan» read as
 * «I will answer the customer myself», and he did — in the customer's chat,
 * which threw the draft away. So the words say WHERE: into this bot, not the
 * customer's chat, as a reply to the card or a plain message while the wait
 * lasts (agent-bot `AGENT_WAIT_TTL_MS`, 30 minutes), and that nothing reaches
 * the customer before his ✅. Starts with «✏️»: the ladder's tests find it so.
 */
export const EDIT_PROMPT =
  '✏️ Mijozga ketadigan to‘g‘ri matnni SHU BOTGA yozing — mijozning chatiga emas (shu kartaga javob qilib yoki 30 daqiqa ichida oddiy xabar bilan). Men uni kartaga qo‘yaman; mijozga faqat siz ✅ bosganda ketadi.';

/** His words are on the card and may go — the button under this sentence is the card's own ✅. */
export const OWN_TEXT_PLACED = '✏️ Matningiz kartaga qo‘yildi. Mijozga yuborish uchun ✅ Yuborish ni bosing.';

/**
 * The confirmation, with what its ✅ ALSO does (review): the button approves
 * the card, and the card carries the draft's actions — a mute, a
 * calculation, a follow-up — so a sentence naming only his words approved
 * side effects it did not show. The lines are the card's own (`actionLines`).
 */
export function ownTextPlaced(actions: readonly ComposedAction[]): string {
  const lines = actionLines([...actions]);
  return lines.length === 0 ? OWN_TEXT_PLACED : `${OWN_TEXT_PLACED}\n\n✅ bilan birga:\n${lines.map((l) => `➕ ${l}`).join('\n')}`;
}

/**
 * A text typed at a draft that is no longer live — answered, rejected,
 * expired, or retired by his own message in the customer's chat. Says that the
 * text went nowhere: «faol emas» alone left him wondering whether it was kept.
 */
export const OWN_TEXT_NOT_LIVE = 'Bu qoralama endi faol emas — matningiz hech qayerga yozilmadi.';

/**
 * His typed text, for the agent: a reply (swipe) to an agent card names its
 * own target; otherwise the one live agent wait does. Null = not the agent's.
 */
export async function agentText(
  staffId: string,
  target: { kind: AgentWaitKind; payload: Record<string, string> } | null,
  text: string,
): Promise<AgentTextAnswer | null> {
  if (!target) return null;
  const actor = await deciderFor(staffId);
  const ctx = { actorId: staffId };
  if (target.kind === 'agent_edit') {
    const draftId = target.payload.draftId!;
    const r = await submitOwnText(actor, draftId, text, ctx);
    if (!r.ok) return { text: r.code === 'not_live' ? OWN_TEXT_NOT_LIVE : DECIDE_WORDS[r.code] };
    // A ✅ only where the card draws one (C9): «tekshirib ✅ bosing» promised it over a text
    // the owner subset had blocked, and the card's ✅ was an edited message somewhere above.
    if (r.blocked || !r.digest) return { text: ownTextBlocked(r.blocks ?? []) };
    return { text: ownTextPlaced(r.actions ?? []), buttons: [[{ text: '✅ Yuborish', callback_data: `ag:s:${draftId}:${r.digest}` }]] };
  }
  if (target.kind === 'agent_price') {
    const r = await priceDraftFromText(staffId, target.payload.requestId!, text);
    return { text: r.ok ? PRICE_DRAFTED : priceRefusalText(r, text) };
  }
  return { text: await codeEcho(staffId, target.payload.ruleId!, text) };
}

/**
 * His words are on the card and may NOT go, said with the reason and the way
 * to type them again — the wait was consumed by this text (the redelivery
 * rule), so «qayta yozing» names the two doors that still lead to the draft.
 */
export function ownTextBlocked(blocks: readonly PolicyHit[]): string {
  const why = blocks.length > 0 ? blocks.map((b) => hitWords(b)).join('; ') : 'matn kartaga sig‘maydi (juda uzun)';
  return `⛔ Matningiz kartaga qo‘yildi, lekin shunday yuborilmaydi: ${why}. Qisqartirib, kartaga javob (reply) qilib qayta yozing yoki «✏️ O‘zgartirish»ni qayta bosing.`;
}

/**
 * Is the draft a ✏️ wait names still one his text would land on — his own,
 * pending or editing (`submitOwnText`'s own test)? Asked by the text slot
 * before it consumes a plain text (C8): a wait outlives its draft (nothing
 * that retires a draft can reach the bot's waits), and a dead one must not
 * swallow the next thing he types.
 */
export async function editStillLive(staffId: string, draftId: string | undefined): Promise<boolean> {
  if (!draftId) return false;
  const [d] = await db
    .select({ status: agentDrafts.status })
    .from(agentDrafts)
    .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.managerUserId, staffId)));
  return d?.status === 'pending' || d?.status === 'editing';
}

/**
 * The bot's messages that carry a draft's WORDS (`PressAnswer.quotes`),
 * recorded on HIS card row of that draft as `payload.copies` — where the
 * chat's purge finds them and blanks them like the card (purge
 * `blankQuotedCopies`, review leak-9). Sent by `ctx.reply`, each was a copy of
 * the customer-facing text that no row named, and «🚫 Shaxsiy» left it
 * standing in his chat with the bot for ever. Every card row re-render merges
 * over the payload (`||`), so the list survives them.
 */
export async function recordCardCopies(staffId: string, draftId: string, copies: readonly { chatId: number; messageId: number }[]): Promise<void> {
  if (copies.length === 0) return;
  await db
    .update(notifications)
    .set({
      payload: sql`${notifications.payload} || jsonb_build_object('copies', coalesce(${notifications.payload}->'copies', '[]'::jsonb) || ${JSON.stringify(copies)}::jsonb)`,
    })
    .where(and(eq(notifications.userId, staffId), eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
}

/** Which agent card a swipe-reply answers — resolved from HIS OWN notification row by `payload.tg` (reply-door's rule). */
export async function agentCardFor(
  staffId: string,
  chatId: bigint,
  messageId: number,
): Promise<{ kind: AgentWaitKind; payload: Record<string, string> } | null> {
  const [row] = await db
    .select({ type: notifications.type, payload: notifications.payload })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, staffId),
        sql`${notifications.type} IN ('AgentDraft', 'AgentCalcAnswered', 'AgentStranger', 'AgentCodeEcho')`,
        sql`(${notifications.payload}->'tg'->>'chatId') = ${String(chatId)}`,
        sql`(${notifications.payload}->'tg'->>'messageId') = ${String(messageId)}`,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  if (!row) return null;
  const p = row.payload as Record<string, unknown>;
  // A swipe-reply IS an edit: `submitOwnText` takes a pending draft as well as an editing one.
  if (row.type === 'AgentDraft' && typeof p.draftId === 'string') return { kind: 'agent_edit', payload: { draftId: p.draftId } };
  // A purged answer card (`live: false`) is no door: its link is gone with the chat.
  if (row.type === 'AgentCalcAnswered' && typeof p.requestId === 'string' && p.priceable === true && p.live !== false) {
    return { kind: 'agent_price', payload: { requestId: p.requestId } };
  }
  // A code typed as a reply to the stranger card (or to an echo card) after
  // «👤 Mijoz — kod»: the shell takes it only while that rule's code wait is
  // armed — a reply alone opens no echo.
  if ((row.type === 'AgentStranger' || row.type === 'AgentCodeEcho') && typeof p.ruleId === 'string') {
    return { kind: 'agent_code', payload: { ruleId: p.ruleId } };
  }
  return null;
}

/**
 * Every name this draft's chat is known by — the client and its phone
 * siblings, the lead, the peer's own Telegram title (review I3). A lead chat
 * has no client, and the old lookup by `clientId` alone gave a lead's general
 * fact no names to refuse at all.
 */
async function knownNamesFor(d: typeof agentDrafts.$inferSelect): Promise<string[]> {
  const names: string[] = [];
  if (d.clientId) {
    const ids = (await phoneSiblingClients(d.clientId)).map((c) => c.id);
    if (ids.length > 0) {
      for (const c of await db.select({ name: clients.name }).from(clients).where(inArray(clients.id, ids))) names.push(c.name);
    }
  }
  if (d.leadId) {
    const [l] = await db.select({ name: leads.name }).from(leads).where(eq(leads.id, d.leadId));
    // A «📵» lead with no title is named by a placeholder, not by a person.
    const { PHONELESS_LEAD_NAME } = await import('../crm/chat-rules');
    if (l && l.name !== PHONELESS_LEAD_NAME) names.push(l.name);
  }
  const [rule] = await db
    .select({ title: tgChatRules.peerTitle })
    .from(tgChatRules)
    .where(and(eq(tgChatRules.managerUserId, d.managerUserId), eq(tgChatRules.peerId, d.peerId)));
  if (rule?.title) names.push(rule.title);
  return names;
}

async function kbPress(staffId: string, op: 'g' | 'u' | 'z', draftId: string, digest: string | undefined): Promise<PressAnswer> {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d || d.managerUserId !== staffId) return { toast: 'Topilmadi' };
  // The card offers this only under an APPROVED answer of his own to a question
  // the machine asked (card-io `kbAsk`); a forged press on anything else is refused.
  if (d.status !== 'approved' || !d.needsOwner || !d.finalBody) return { toast: 'Topilmadi' };
  const p = (d.policy ?? {}) as Partial<DraftPolicyJson> & { kb?: string; kbToken?: string };
  if (p.kb === 'saved' || p.kb === 'skipped') return { toast: 'Allaqachon hal qilingan' };
  const setKb = async (kb: string, extra: Record<string, string> = {}) => {
    await db.update(agentDrafts).set({ policy: { ...p, kb, ...extra } }).where(eq(agentDrafts.id, draftId));
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(draftId);
  };
  if (op === 'z') {
    await setKb('skipped');
    return { toast: '✖ Saqlanmadi' };
  }
  if (op === 'g') {
    // A general fact is read in EVERY chat: the card's 📌 only ASKS (leak-2), and
    // the yes is a button on the question itself, carrying the arm's token (I3).
    // Two presses on the CARD — one press redelivered, or two taps into a bot
    // that was down — both only ask: neither can be the yes, because the
    // question they would be answering was not on the screen yet.
    const armed = p.kb === 'general_armed' && typeof p.kbToken === 'string' && /^[0-9a-f]{8}$/.test(p.kbToken) ? p.kbToken : null;
    if (!armed || digest !== armed) {
      const token = armed ?? randomBytes(4).toString('hex');
      if (!armed) await setKb('general_armed', { kbToken: token });
      return {
        toast: '📌 Tasdiqlang',
        reply: "📌 Bu javob BARCHA mijozlarga qo'llanadi. Rozi bo'lsangiz, pastdagi «📌 Ha, hammaga» tugmasini bosing.",
        buttons: [[{ text: '📌 Ha, hammaga', callback_data: `ag:g:${draftId}:${token}` }]],
      };
    }
  }
  let dropped = false;
  try {
    const answer = d.finalBody ?? '';
    const chatNames = await knownNamesFor(d);
    // A GENERAL fact is checked against EVERY name the client book and the
    // staff hold, as the page's own add form checks (`addGeneralFact`): his
    // answer to one customer can name another — and so can the model's question.
    const lowered = `${d.ownerQuestion ?? ''}\n${answer}`.toLowerCase();
    const bookNames =
      op === 'g' ? (await knownNamesForMask(false)).filter((n) => lowered.includes(n.toLowerCase())) : [];
    const question = await keptQuestion(op, d.ownerQuestion, answer, [...chatNames, ...bookNames]);
    dropped = Boolean(d.ownerQuestion?.trim()) && question === null;
    await writeKbFact(
      {
        scope: op === 'g' ? 'general' : d.clientId ? 'client' : 'lead',
        clientId: op === 'g' ? null : d.clientId,
        leadId: op === 'g' ? null : d.clientId ? null : d.leadId,
        question,
        answer,
        locale: d.language,
        sourceRef: { draftId },
        knownNames: [...chatNames, ...bookNames],
      },
      { actorId: staffId },
    );
  } catch (err) {
    if (err instanceof KbError) {
      const figure = err.detail ? `«${err.detail}» — ` : '';
      const words: Record<KbRefusal, string> = {
        money: `${figure}narx. Narx bilimga yozilmaydi — narx «💵 Narx yozaman» orqali beriladi.`,
        // `keptQuestion` drops a question that would do this before it is written; said all the same.
        money_context: `${figure}savoldagi narx so‘zi bilan birga narx deb o‘qiladi — savolni «Bilimlar» sahifasida narx so‘zisiz yozing.`,
        personal: "Matnda mijoz ma'lumoti bor — «👤 Faqat shu mijoz» ni tanlang.",
        empty: "Matn bo'sh.",
        too_long: 'Matn juda uzun.',
        scope: "Bu chat mijoz yoki lidga bog'lanmagan.",
      };
      return { toast: '⚠️', reply: words[err.code] };
    }
    throw err;
  }
  await setKb('saved');
  const toast = op === 'g' ? '📌 Umumiy qoida saqlandi' : '👤 Shu mijoz uchun saqlandi';
  // Said where it stays (a toast vanishes): the fact went in WITHOUT the question he saw on the card.
  return dropped ? { toast, reply: `${toast} — ${QUESTION_DROPPED}` } : { toast };
}

/**
 * Why a remembered fact carries his answer alone — told when the card's
 * question was not kept (`keptQuestion`), with the way to give it one.
 */
export const QUESTION_DROPPED =
  'faqat javobingiz yozildi: savolda raqam, narx so‘zi yoki mijoz ma’lumoti bor edi. Savolni «Bilimlar» sahifasida ✎ bilan qo‘shishingiz mumkin.';

/**
 * The question a fact remembered from a card keeps. It is the MODEL's
 * account of ONE customer, never his words, so it stays only where it can
 * neither cost him the fact nor carry that customer into the knowledge
 * (ident fix F7/F8):
 *  - never one that states money, or that makes HIS answer's bare figure read
 *    as money beside it (P1: «Mijoz narx so‘rayapti» + «Ertaga 10 da VED
 *    hisoblab beradi» — the 10 is a price joined, `moneyIn` 'context'): the
 *    answer is saved alone rather than refused for words he did not write;
 *  - for a GENERAL fact (read in every chat, K6), never one that carries a
 *    figure («12 kub mebel» would vouch for somebody else's reply), a code, a
 *    phone or a name. A clean question stays: «Ha, bo‘ladi» with no subject,
 *    served to every chat, is the other way to be wrong.
 */
async function keptQuestion(
  op: 'g' | 'u',
  raw: string | null,
  answer: string,
  names: readonly string[],
): Promise<string | null> {
  const question = raw?.trim() || null;
  if (!question) return null;
  if (carriesMoney(question) || (moneyIn(question, answer) !== null && !carriesMoney(answer))) return null;
  if (op === 'g') {
    if (extractNumbers(question).length > 0) return null;
    if ((await personalBitsWithBook(question, names)).length > 0) return null;
  }
  return question;
}

/** A rule as the stranger and echo cards judge it — with the 0139 mark of the listener's own binding. */
type RuleRow = typeof tgChatRules.$inferSelect & { boundVia: string | null };
type ConvIdentity = { clientId: string | null; strength: string | null; updatedAt: Date } | undefined;

const tailOf = (id: string | null | undefined) => (id ?? '').slice(-8).toLowerCase();

/**
 * The rule a stranger or echo card names, read with its 0139 mark (chat-lead
 * `boundViaSql` — NULL, never 42703, one migration behind): a press must tell
 * the listener's own binding (nobody's answer) from a decision.
 */
async function ruleFor(ruleId: string): Promise<RuleRow | undefined> {
  const { boundViaSql } = await import('../crm/chat-lead');
  const [rule] = await db
    .select({ ...getTableColumns(tgChatRules), boundVia: boundViaSql })
    .from(tgChatRules)
    .where(eq(tgChatRules.id, ruleId));
  return rule;
}

async function convIdentity(staffId: string, peerId: bigint): Promise<ConvIdentity> {
  const [conv] = await db
    .select({ clientId: agentConversations.identityClientId, strength: agentConversations.identityStrength, updatedAt: agentConversations.updatedAt })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, staffId), eq(agentConversations.peerId, peerId)));
  return conv;
}

/**
 * Is the chat's include the echo flow's OWN — the one its ✅ wrote, and that
 * nobody has decided over since (review I1)? The ✅ stamps the `decided_at`
 * it wrote onto the echo card it confirmed (`boundAt`); any later decision —
 * the web tray's «Bu mijoz» naming the very same client included — moves
 * `decided_at`, and the include is then somebody's deliberate answer that ↩
 * must not undo. The conversation's own `updated_at` cannot tell: every agent
 * write to the conversation moves that clock.
 */
async function typedBindStands(staffId: string, rule: RuleRow, conv: ConvIdentity): Promise<boolean> {
  if (conv?.strength !== 'typed_code' || !conv.clientId) return false;
  if (rule.decision !== 'include' || rule.clientId !== conv.clientId || !rule.decidedAt) return false;
  const [echo] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, staffId),
        eq(notifications.type, 'AgentCodeEcho'),
        sql`${notifications.payload}->>'ruleId' = ${rule.id}`,
        sql`${notifications.payload}->>'boundAt' = ${rule.decidedAt.toISOString()}`,
      ),
    )
    .limit(1);
  return echo !== undefined;
}

/**
 * What the echo flow bound, taken back — and nothing it did not bind (review
 * I1): the rule goes back to pending; every draft still waiting for his ✅
 * that was written under that client expires, because approving one later
 * would land its calculation on that client's deal and book the follow-up on
 * that client's card — the client he has just said this chat is NOT; and an
 * approved reply still WAITING to go (the night hold, the human delay) is
 * cancelled, `agent_off`'s compare-and-set on 'agent' (config.ts): the send
 * step claims a row by that same status, so a row already claimed is the
 * one in flight and is let finish. One home for both doors since the final
 * review's K7 (`withdrawRepliesFor`): the web tray's own undo (`decideChat`)
 * takes back the same — and a ✅ pressed between the two writes here is
 * cancelled by that hook once the rule is written.
 */
async function withdrawTypedBind(staffId: string, rule: RuleRow, conv: ConvIdentity): Promise<boolean> {
  if (!(await typedBindStands(staffId, rule, conv))) return false;
  await withdrawRepliesFor({
    managerUserId: staffId,
    peerId: rule.peerId,
    clientId: conv!.clientId!,
    leadId: null,
    why: 'identity_changed: the typed code was taken back',
    note: "↩ Chat bu mijozga bog'lanmadi — javob ketmaydi.",
  });
  const { decideChat } = await import('../crm/chat-rules');
  await decideChat({ id: rule.id, decision: 'pending' }, { actorId: staffId });
  return true;
}

/**
 * Close the stranger or echo cards of one rule: the verdict line is appended
 * and the buttons go (`live: false` — `agentButtons` draws none), on the row a
 * copy not yet sent goes out with, and on the copies already sent (review I1:
 * a ✅ / ↩ that stays pressable after the decision is a second decision).
 * A copy the drain has not sent yet is never sent — a closed card arriving
 * after its own answer is noise (the approval copies' rule). A copy the drain
 * has CLAIMED (`sending`) carries no `tg` yet, so its edit is skipped here —
 * and the drain corrects it itself once sent (`correctAgentCopyInFlight`,
 * notifications/service.ts: the row is read again after its `tg` is written
 * and the copy edited to it). A press in the moment between is judged like
 * any late press, by the chat as it stands: a ✅ already true
 * writes nothing, a stranger button on a decided chat writes nothing, and a ↩
 * takes back only the flow's own bind — and hands the chat its stranger card
 * back. `lineFor` may return null to leave a card; `extraFor` adds to the
 * closed card's payload.
 */
async function closeRuleCards(
  staffId: string,
  type: 'AgentStranger' | 'AgentCodeEcho',
  ruleId: string,
  lineFor: (clientId: string | undefined) => string | null,
  extraFor: (clientId: string | undefined) => Record<string, string> = () => ({}),
): Promise<void> {
  const rows = await db
    .select({ id: notifications.id, payload: notifications.payload, userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, staffId),
        eq(notifications.type, type),
        sql`${notifications.payload}->>'ruleId' = ${ruleId}`,
        sql`(${notifications.payload}->>'live') IS DISTINCT FROM 'false'`,
      ),
    );
  const closed: AgentCopy[] = [];
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const cid = typeof payload.clientId === 'string' ? payload.clientId : undefined;
    const line = lineFor(cid);
    if (line === null) continue;
    const patch = { ...extraFor(cid), live: false, text: `${typeof payload.text === 'string' ? payload.text : ''}\n\n${line}` };
    const [written] = await db
      .update(notifications)
      .set({
        payload: sql`${notifications.payload} || ${JSON.stringify(patch)}::jsonb`,
        status: sql`CASE WHEN ${notifications.status} = 'pending' THEN 'muted' ELSE ${notifications.status} END`,
        error: sql`CASE WHEN ${notifications.status} = 'pending' THEN 'answered before it was sent' ELSE ${notifications.error} END`,
      })
      // Still live: a card another decision closed since the read carries that decision's verdict.
      .where(and(eq(notifications.id, row.id), sql`(${notifications.payload}->>'live') IS DISTINCT FROM 'false'`))
      .returning({ payload: notifications.payload });
    if (!written) continue;
    // The payload as WRITTEN, never the one read above: the drain may merge
    // the copy's `tg` between the two — after its own re-read found the card
    // still open — and an edit built from the read would skip that copy, so
    // neither side would correct it (cards review). The UPDATE's own row is
    // the one both writes have landed on.
    closed.push({ id: row.id, type, payload: written.payload as Record<string, unknown>, userId: row.userId });
  }
  await editAgentCopies(closed).catch((err: unknown) => logger.warn({ err, ruleId }, '[agent] card copies not closed'));
}

/**
 * The stranger cards still asking about one chat, closed with `line` — for a
 * door outside the bot whose own act answered their question: chat-lead's
 * work-number binding (`phonelessLeadForChat`, the 2026-10-29 review — a card
 * a personal number posted stayed live after the switch to «Ish raqami», and
 * offered «🆕 Yangi lid» about a chat that already was one).
 */
export async function closeStrangerCards(staffId: string, ruleId: string, line: string): Promise<void> {
  await closeRuleCards(staffId, 'AgentStranger', ruleId, () => line);
}

/** A Telegram account of Telegram's own (`officialChat`) — no answer but «Shaxsiy». */
const OFFICIAL_CHAT_WORDS =
  "Bu Telegram'ning o'z xizmat akkaunti (kodlar, bildirishnomalar) — mijoz ham, lid ham emas. Faqat «🚫 Shaxsiy» bosish mumkin.";

/**
 * A chat ↩ leaves in question again gets a stranger card back when it has no
 * live one (review I1): the ✅ closed the first, the one-card-per-peer claim
 * is spent, and the listener stores nothing for a pending chat — without a
 * fresh card nothing in the bot could decide this chat again.
 */
async function reopenStrangerCard(staffId: string, ruleId: string): Promise<void> {
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
  if (!rule || rule.decision !== 'pending') return;
  // One of Telegram's own accounts is no stranger to ask about (the sweep's
  // `officialPeerSql`): an old echo card's ↩ takes its bind back and posts nothing.
  const { officialChat } = await import('../crm/chat-rules');
  if (officialChat(rule.peerId)) return;
  const [live] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, staffId),
        eq(notifications.type, 'AgentStranger'),
        sql`${notifications.payload}->>'ruleId' = ${ruleId}`,
        sql`(${notifications.payload}->>'live') IS DISTINCT FROM 'false'`,
      ),
    )
    .limit(1);
  if (live) return;
  const { strangerCardText } = await import('./jobs');
  await notifyStaffTelegram({
    userIds: [staffId],
    type: 'AgentStranger',
    text: `${strangerCardText(rule.peerTitle, rule.peerPhone)}\n\n↩ Oldingi bog'lash bekor qilindi — qaytadan tanlang.`,
    extra: { ruleId },
  });
}

/** What a press on a stranger card hears once the chat is no longer pending — whoever decided it. */
function decidedWords(rule: RuleRow): string {
  if (rule.decision === 'exclude') return "Bu chat allaqachon shaxsiy deb belgilangan — karta eskirgan.";
  if (rule.clientId) return "Bu chat allaqachon mijozga bog'langan — karta eskirgan.";
  return "Bu chat allaqachon lid sifatida ochilgan — karta eskirgan.";
}

/**
 * The stranger card's buttons (§17.11): a lead, a client by its code (echoed
 * first), or personal. The card is an answer to a chat still IN QUESTION,
 * and only to one: once the chat is decided — here, or on the web tray, whose
 * door closes no card of the bot's — a press on it is late (a live copy
 * nobody closed, a backlog press), and a late press is never a second
 * decision (review I1).
 *
 * In question = `pending`, or the listener's OWN binding (chat-lead
 * `isMachineBinding` — a work number's hidden-number lead, his «1 a»): that
 * binding is nobody's answer, so a press on its chat is the FIRST decision
 * and wins (the 2026-10-29 review — it was refused «allaqachon hal
 * qilingan», and the AI went on drafting for a chat he called private).
 * «🆕 Yangi lid» makes the binding his, «👤 Mijoz — kod» moves the chat onto
 * the client. «🚫 Shaxsiy» on ANY chat no person answered — the binding, or
 * a question beside which a work number kept the lines by the number — also
 * deletes what was stored of it on the listener's say-so, a lead's lines and
 * never a client's (`storedOnLeadsOnly`; `purgeExcludedChat`,
 * `excludeAndPurgeChat`'s rule). Telegram's own accounts (`officialChat`)
 * take no answer but «Shaxsiy», in words.
 */
async function strangerPress(
  staffId: string,
  op: 'n' | 'k' | 'x' | 'c' | 'b',
  ruleId: string,
  echoedTail: string | undefined,
): Promise<PressAnswer> {
  const rule = await ruleFor(ruleId);
  if (!rule || rule.managerUserId !== staffId) return { toast: 'Topilmadi' };
  const ctx = { actorId: staffId };
  const { decideChat, officialChat, openLeadForChat, purgeExcludedChat } = await import('../crm/chat-rules');
  const { isMachineBinding, nobodyDecided, storedOnLeadsOnly } = await import('../crm/chat-lead');
  if (officialChat(rule.peerId) && (op === 'n' || op === 'k' || op === 'c')) {
    await closeRuleCards(staffId, 'AgentStranger', ruleId, () => '↪️ Telegram xizmati — mijoz emas.');
    await closeRuleCards(staffId, 'AgentCodeEcho', ruleId, () => '↪️ Telegram xizmati — mijoz emas.');
    return { toast: '⚠️ Telegram xizmati', reply: OFFICIAL_CHAT_WORDS };
  }
  const machine = isMachineBinding(rule);
  if (op === 'n' || op === 'k' || op === 'x') {
    if (rule.decision !== 'pending' && !machine) {
      await closeRuleCards(staffId, 'AgentStranger', ruleId, () => '↪️ Bu chat boshqa joyda hal qilingan.');
      // The same answer again (a redelivered press) is not a refusal — it is done.
      if (op === 'n' && rule.decision === 'include' && rule.leadId && !rule.clientId) return { toast: '🆕 Lid allaqachon ochilgan' };
      if (op === 'x' && rule.decision === 'exclude') return { toast: '🚫 Allaqachon shaxsiy' };
      return { toast: '⚠️ Allaqachon hal qilingan', reply: decidedWords(rule) };
    }
  }
  if (op === 'x') {
    // What is stored of a chat no person had answered was kept on the
    // listener's say-so — its own binding, or a work number's lead by the
    // number while this card's question still stood (the second 2026-10-29
    // review: «saqlanmaydi» answered and the lines stayed) — and «Shaxsiy»
    // takes that past too, as the conversation's own «qo'shma» does. Never
    // a client's line (`storedOnLeadsOnly`), and never past a person's answer
    // (a ↩ is one). Asked BEFORE the press writes its own.
    const purgeable = nobodyDecided(rule) && (await storedOnLeadsOnly(staffId, rule.peerId));
    await decideChat({ id: ruleId, decision: 'exclude' }, ctx);
    const purged = purgeable ? await purgeExcludedChat(ruleId, ctx) : null;
    await db
      .update(agentConversations)
      .set({ identityClientId: null, identityStrength: null, updatedAt: new Date() })
      .where(and(eq(agentConversations.managerUserId, staffId), eq(agentConversations.peerId, rule.peerId)));
    await closeRuleCards(staffId, 'AgentStranger', ruleId, () => '🚫 Shaxsiy deb belgilandi.');
    await closeRuleCards(staffId, 'AgentCodeEcho', ruleId, () => '🚫 Chat shaxsiy deb belgilandi.');
    return {
      toast: '🚫 Shaxsiy — saqlanmaydi',
      ...(purged && purged.messages > 0 ? { reply: `🗑 Lidga saqlangan ${purged.messages} ta xabar o‘chirildi.` } : {}),
    };
  }
  if (op === 'n') {
    try {
      // The «📵» card's lead goes by name (his Q18 ⭐) — the one door that may.
      await openLeadForChat(ruleId, ctx, { phoneless: 'agent_stranger' });
    } catch (err) {
      return { toast: '⚠️', reply: `Lid ochilmadi: ${(err as { code?: string }).code ?? (err instanceof Error ? err.message : '')}` };
    }
    await queuePull(staffId, rule.peerId);
    await closeRuleCards(staffId, 'AgentStranger', ruleId, () => '🆕 Lid ochildi.');
    await closeRuleCards(staffId, 'AgentCodeEcho', ruleId, () => '🆕 Chat lid sifatida ochildi.');
    return { toast: '🆕 Lid ochildi' };
  }
  if (op === 'k') {
    return { toast: '👤', reply: 'Mijoz kodini yozing (masalan GS777).', arm: { kind: 'agent_code', payload: { ruleId } } };
  }
  const conv = await convIdentity(staffId, rule.peerId);
  if (op === 'b') {
    // An OLDER card's ↩ speaks for the code IT showed: the newer echo stands.
    if (echoedTail && conv?.clientId && tailOf(conv.clientId) !== echoedTail) {
      await closeRuleCards(staffId, 'AgentCodeEcho', ruleId, (cid) => (tailOf(cid) === echoedTail ? '↪️ Eskirgan — keyin boshqa kod yozilgan.' : null));
      return { toast: 'Bu karta eskirgan' };
    }
    // ↩ takes back what the echo flow wrote — the rule as well as the
    // conversation (I1 A): clearing the conversation alone left the rule
    // naming the client the owner had just said this chat is NOT…
    const withdrawn = await withdrawTypedBind(staffId, rule, conv);
    // …and nothing it did not write: a chat decided since (here, on the web
    // tray, even «Bu mijoz» for this very client) is that decision's. The
    // listener's own binding decided nothing.
    if (!withdrawn && rule.decision !== 'pending' && !machine) {
      await closeRuleCards(staffId, 'AgentCodeEcho', ruleId, () => '↪️ Eskirgan — chat boshqa joyda hal qilingan.');
      return { toast: 'Chat boshqa joyda hal qilingan', reply: decidedWords(rule) };
    }
    await db
      .update(agentConversations)
      .set({ identityClientId: null, identityStrength: null, updatedAt: new Date() })
      .where(and(eq(agentConversations.managerUserId, staffId), eq(agentConversations.peerId, rule.peerId)));
    await closeRuleCards(staffId, 'AgentCodeEcho', ruleId, () => "↩ Bekor qilindi — chat bu mijozga bog'lanmadi.");
    await reopenStrangerCard(staffId, ruleId);
    return { toast: '↩ Bekor qilindi' };
  }
  // 'c' — the echo was right: the chat is this client's, by a code HE typed.
  if (!conv?.clientId) return { toast: 'Kod topilmadi — qaytadan yozing' };
  // The card confirms the code IT showed (leak-4): a newer typed code needs its own card.
  if (!echoedTail || tailOf(conv.clientId) !== echoedTail) return { toast: 'Kod o‘zgargan — oxirgi kartani tasdiqlang' };
  const confirmed = conv.clientId;
  if (rule.decision === 'include' && rule.clientId === confirmed) {
    // Already this client's (a redelivered ✅, or the web tray said the same):
    // nothing is written twice, and the bind stays whoever made it.
    await closeRuleCards(staffId, 'AgentCodeEcho', ruleId, (cid) => (cid === confirmed ? '✅ Chat shu mijozga bog‘langan.' : '↪️ Eskirgan — boshqa kod tasdiqlandi.'));
    await closeRuleCards(staffId, 'AgentStranger', ruleId, () => '👤 Mijozga bog‘langan.');
    return { toast: '✅ Allaqachon bog‘langan' };
  }
  // …and only a chat still in question: a decision made since the echo — on
  // the web tray, before or after the code was typed — is newer than this
  // card (a backlog ✅ never undoes it). The pending rule's own clock is
  // asked too: the web tray may have put the chat back in question after the
  // echo, and its last word is «ask again», not «this client». The
  // listener's own binding is no decision: its clock is the machine's, and
  // the code he typed wins over it.
  if (
    (rule.decision !== 'pending' && !machine) ||
    (rule.decision === 'pending' && rule.decidedAt && rule.decidedAt.getTime() > conv.updatedAt.getTime())
  ) {
    await closeRuleCards(staffId, 'AgentCodeEcho', ruleId, () => '↪️ Eskirgan — chat boshqa joyda hal qilingan.');
    return { toast: 'Chat boshqa joyda hal qilingan', reply: "Bu chat kod yozilgandan keyin boshqa joyda (Qaysi chatlar) hal qilingan — karta eskirgan." };
  }
  await decideChat({ id: ruleId, decision: 'include', clientId: confirmed }, ctx);
  // The decision as it was WRITTEN — stamped on the card it confirms, so a ↩
  // later can tell this bind from one somebody made over it (typedBindStands).
  const [bound] = await db.select({ decidedAt: tgChatRules.decidedAt }).from(tgChatRules).where(eq(tgChatRules.id, ruleId));
  await db
    .update(agentConversations)
    .set({ identityStrength: 'typed_code', updatedAt: new Date() })
    .where(and(eq(agentConversations.managerUserId, staffId), eq(agentConversations.peerId, rule.peerId)));
  await queuePull(staffId, rule.peerId);
  await closeRuleCards(
    staffId,
    'AgentCodeEcho',
    ruleId,
    (cid) => (cid === confirmed ? '✅ Tasdiqlandi — chat shu mijozga bog‘landi.' : '↪️ Eskirgan — boshqa kod tasdiqlandi.'),
    (cid): Record<string, string> => (cid === confirmed && bound?.decidedAt ? { boundAt: bound.decidedAt.toISOString() } : {}),
  );
  await closeRuleCards(staffId, 'AgentStranger', ruleId, () => '👤 Mijozga bog‘landi.');
  return { toast: '✅ Bog‘landi' };
}

/** What the echo card says about cargo and money in this chat — the same proof the agent's tools will ask. */
function proofLine(proof: Awaited<ReturnType<typeof chatProof>>, chatPhone: string | null): string {
  if (proof === 'phone') return '✔ Chat raqami kartada — AI bu chatda yuk va qarzni ayta oladi.';
  if (proof === 'cabinet') return "✔ Mijoz botdagi kabinetini o'z raqami bilan ulagan — AI yuk va qarzni ayta oladi.";
  // A hidden number can never be on a card: closed by construction (his Q19 ⭐).
  if (!chatPhone) return "📵 Chat raqami yashirin — AI bu chatda yuk va qarzni AYTMAYDI (mijoz botdagi kabinetini o'z raqami bilan ulamaguncha).";
  return "⚠️ Chat raqami kartada yo'q — AI bu chatda yuk va qarzni AYTMAYDI (raqam kartaga qo'shilmaguncha).";
}

/** The typed code, echoed before anything is written (leak-4, winLead's idiom). */
async function codeEcho(staffId: string, ruleId: string, text: string): Promise<string> {
  const code = text.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/u.test(code)) return 'Kod bitta so‘z bo‘lishi kerak, masalan GS777.';
  const rule = await ruleFor(ruleId);
  if (!rule || rule.managerUserId !== staffId) return 'Topilmadi.';
  const conv = await convIdentity(staffId, rule.peerId);
  // A code is asked about a chat still in question — the listener's own
  // binding included (`strangerPress`) — or one the flow itself bound (a
  // second code typed after a ✅, I1 B). A chat the web tray decided while
  // the wait was armed is that decision's (review I1): no echo, no card whose
  // ✅ could undo it.
  const ownBind = await typedBindStands(staffId, rule, conv);
  const { isMachineBinding } = await import('../crm/chat-lead');
  if (rule.decision !== 'pending' && !ownBind && !isMachineBinding(rule)) return decidedWords(rule);
  const [client] = await db
    .select({ id: clients.id, code: clients.clientCode, name: clients.name, phones: clients.phones })
    .from(clients)
    .where(eq(clients.clientCode, code));
  if (!client) return `${code} — bunday kod yo'q.`;
  // A second code withdraws what the first one bound (I1 B) — the chat is in
  // question again until THIS echo is confirmed — and every older echo card
  // loses its buttons.
  if (ownBind) await withdrawTypedBind(staffId, rule, conv);
  await closeRuleCards(staffId, 'AgentCodeEcho', ruleId, () => '↪️ Eskirgan — yangi kod yozildi.');
  await db
    .insert(agentConversations)
    .values({ managerUserId: staffId, peerId: rule.peerId, identityClientId: client.id })
    .onConflictDoUpdate({
      target: [agentConversations.managerUserId, agentConversations.peerId],
      set: { identityClientId: client.id, identityStrength: null, updatedAt: new Date() },
    });
  const siblings = await phoneSiblingClients(client.id);
  const proof = await chatProof(staffId, rule.peerId, siblings.map((s) => s.id), rule.peerPhone);
  const phones = Array.isArray(client.phones) ? (client.phones as string[]).join(', ') : '';
  await notifyStaffTelegram({
    userIds: [staffId],
    type: 'AgentCodeEcho',
    text: `👤 Shu mijozmi?\n${client.code} · ${client.name}\nKartadagi raqamlar: ${phones || '—'}\nChat raqami: ${rule.peerPhone ?? 'yashirin'}\n\n${proofLine(proof, rule.peerPhone)}`,
    extra: { ruleId, clientId: client.id },
  });
  return '👆 Tekshiring va tasdiqlang.';
}

/**
 * One stranger's chat pulled into the CRM by the listener (tg_peer_pulls, one
 * open per chat — a second ask while one is open is the same ask). The web
 * tray's answer asks through here too (chat-rules `pullForAgent`).
 */
export async function queuePull(managerUserId: string, peerId: bigint, requestedBy: string = managerUserId): Promise<void> {
  await db
    .insert(tgPeerPulls)
    .values({ managerUserId, peerId, requestedBy })
    .onConflictDoNothing()
    .catch((err: unknown) => logger.warn({ err }, '[agent] pull not queued'));
}

/** «/agent», «/agent on», «/agent off» — the bot's kill switch (spec §1, his 16 ⭐). */
export async function agentCommand(staffId: string, arg: string): Promise<string> {
  const actor = await deciderFor(staffId);
  const config = await readAgentConfig();
  if (!config) return "AI sotuvchi hali o'rnatilmagan (baza yangilanmagan).";
  const want = arg.trim().toLowerCase();
  if (want === 'off' || want === 'on') {
    try {
      const r = await setAgentMode(actor, want === 'on' ? 'shadow' : 'off', { actorId: staffId });
      if (want === 'off' && r.expiredDraftIds.length > 0) {
        const { refreshAgentCard } = await import('./card-io');
        for (const id of r.expiredDraftIds) await refreshAgentCard(id).catch(() => {});
      }
      return want === 'on'
        ? '🤖 AI sotuvchi yoqildi — har bir javobni o‘zingiz tasdiqlaysiz.'
        : `⏹ AI sotuvchi o'chirildi. Navbatdan olindi: ${r.cancelledOutboxIds.length}, qoralamalar: ${r.expiredDraftIds.length}.`;
    } catch (err) {
      if (err instanceof AgentConfigError) {
        const words: Record<string, string> = {
          forbidden: "Bu buyruq faqat AI egasi yoki super admin uchun.",
          not_account_holder: "Yoqishni faqat Telegram akkaunti AI'ga ulangan odam qiladi.",
          no_owner: "Avval «Suhbatlar → AI sotuvchi» sahifasida akkaunt tanlang.",
          session_not_confirmed: "Avval sahifada «Eski serverda Telegram sessiyasi yo'q qilindi» ni tasdiqlang.",
          owner_not_connected: "AI egasining Telegram akkaunti ulanmagan.",
          not_ready: 'Baza yangilanmagan.',
        };
        return words[err.code] ?? err.code;
      }
      throw err;
    }
  }
  const running = agentRunning(config);
  return running ? '🤖 AI sotuvchi ishlayapti (soya rejimi). O‘chirish: /agent off' : "⏹ AI sotuvchi o'chiq. Yoqish: /agent on";
}

/** A second ✏️ elsewhere: the first draft is no longer being edited — never silently re-targeted (leak-6). */
export async function releaseEdit(staffId: string, draftId: string): Promise<void> {
  const rows = await db
    .update(agentDrafts)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.status, 'editing'), eq(agentDrafts.managerUserId, staffId)))
    .returning({ id: agentDrafts.id });
  if (rows.length === 0) return;
  const { refreshAgentCard } = await import('./card-io');
  await refreshAgentCard(draftId, ["✏️ Tahrir bekor — boshqa qoralamani tahrirlayapsiz."]);
}
