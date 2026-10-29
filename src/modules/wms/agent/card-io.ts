import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentDrafts, agentOutbox, notifications, tgMessageFlags, tgMessages, users } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { composeStaffMessage } from '../../platform/notifications/service';
import { keyboardOf, STAFF_TEXT_CAP } from '../../platform/notifications/staff-html';
import { editText } from '../../platform/telegram/send';
import { buttonsFor } from '../../platform/telegram/staff-bot';
import { agentCardText, BLOCK_REMEDY, cardDrawsSend, cardExtra, CardTooLong, digestBody, type CardInput } from './card';
import { readAgentConfig } from './config';
import { HUMAN_TAKEOVER_HOURS } from './limits';
import type { ComposedAction, DraftPolicyJson } from './types';
import { CANCELLED_BY_HOLDER } from './web-thread';
import { MAX_OPEN_PER_REQUESTER } from '../calc/service';

/**
 * The card's IO: render a draft's card from its STORED row and put it where
 * he reads it — the notification row (a copy not yet sent goes out with the
 * new words) and the Telegram copy already sent (edited in place, buttons
 * redrawn by the bot's own `buttonsFor`). Best-effort by nature: Telegram
 * refuses edits to a message older than 48 hours.
 */

export type DraftRow = typeof agentDrafts.$inferSelect;
type OutboxRow = typeof agentOutbox.$inferSelect;

const SECTION_WORDS: Record<string, string> = {
  yolkira: "yo'lkira",
  rastamojka: 'rastamojka',
  podklyuch: 'podklyuch',
};

function hhmm(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3_600_000);
  return `${String(t.getUTCDate()).padStart(2, '0')}.${String(t.getUTCMonth() + 1).padStart(2, '0')} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** The time of day in Tashkent, «17:47» — what the line about his own reply names. */
function clock(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3_600_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Where a card is read and what the renderer knows besides the row. The
 * bot's ✏️ arms a wait in the bot; the page's opens a box on the page — the
 * words name the door the reader has. `humanPauseMin` is the config's
 * `human_pause_min` (run `eligibilityFacts`: his own LAST message keeps the AI
 * out of the chat that long); absent, the line about his reply says nothing
 * of it. `humanWroteAt` is when his own reply that retired the draft was SENT
 * (`humanReplyAt`); absent, the row's own time stands in for it.
 */
export interface CardRenderOptions {
  surface?: 'bot' | 'web';
  humanPauseMin?: number | null;
  humanWroteAt?: Date | null;
}

/** «2 soat» for whole hours, «90 daqiqa» otherwise — the config is minutes, he reads time. */
function pauseWords(min: number): string {
  return min >= 60 && min % 60 === 0 ? `${min / 60} soat` : `${min} daqiqa`;
}

const CANCEL_WORDS: Record<string, string> = {
  agent_off: "AI o'chirildi",
  owner_changed: "akkaunt o'zgardi",
  sending_disabled: "yuborish o'chirilgan",
  account_paused: "akkaunt to'xtatilgan",
  anchor_gone: "mijoz xabari o'chirildi",
  anchor_edited: 'mijoz xabarini o‘zgartirdi',
  anchor_superseded: 'mijoz yangi savol yozdi',
  human_replied: "o'zingiz javob berdingiz",
  anchor_too_old: "xabar 24 soatdan eski",
  approval_too_old: 'tasdiq 6 soatdan eski',
  never_wrote: 'mijoz bu akkauntga yozmagan',
  muted: "chatda AI o'chirilgan",
  excluded: 'chat shaxsiy deb belgilangan',
  identity_changed: "chat boshqa mijozga o'tdi",
  // His 🙋 on another card of the same chat, pressed while this one waited (final review K2, decide.ts).
  taken_over: "suhbatni o'zingizga oldingiz (🙋)",
  // Since his 6 b the one way a figure stops standing is a VED recalculation of its request (drafts `draftOfferStands`).
  offer_gone: 'VED qayta hisobladi — bu narx endi amal qilmaydi',
  // The web cancel's own lastError (web-thread.ts) — keyed by the constant, so
  // a reworded value still has its word and never prints raw.
  [CANCELLED_BY_HOLDER]: 'o‘zingiz qaytarib oldingiz',
};

/**
 * A draft retired because the figure on it stopped standing, not because the
 * customer wrote again (`policy.stale`): a recalculation of the chain a 💵 was
 * typed on (calc-loop `retirePricesOf`), a new avia rate (config
 * `setAviaRate`). Said as itself — «Mijoz yana yozdi» would send him looking
 * for a message that is not there.
 */
const STALE_WORDS: Record<string, string> = {
  recalc: '🔄 VED qayta hisoblayapti — bu narx endi amal qilmaydi. Yangi javob kelganda narx bering.',
  avia_rate: '💱 Avia tarifi o‘zgardi — bu narx eskirdi. Mijozga o‘zingiz javob bering.',
  // ✅ found the customer's newer message and no run will draft it (decide `redraftNewest`):
  // «— yangi qoralama» would promise a card that never comes.
  no_redraft: '↪️ Mijoz yana yozdi — bu javob ketmaydi. Yangi xabariga o‘zingiz javob bering.',
};

/**
 * The marker a ✅ writes on `action_error` while it lands the draft's
 * calculation (decide `claimLanding`, ident fix F12) — here, beside its
 * words, so the card and the claim share one constant.
 */
export const LANDING_CLAIM = 'landing';

/**
 * Why the VED queue did not take a calculation, in words (final review K26)
 * — the staff bot's own sentences for the same refusals (staff-handlers
 * `QUEUE_REFUSAL`), told as what HE can do about them: a job is never «sent
 * by hand from the card», there is no such door. And never «✏️ bilan
 * javob bering» about a refusal the next ✅ meets again (ident fix F12): ✏️
 * changes the words and keeps the calculation, so the landing is asked again
 * and refused the same way — what ends it is 🙋, the chat taken over and
 * answered from his own Telegram.
 */
const CALC_QUEUE_WORDS: Record<string, string> = {
  too_many_open: `sizda ${MAX_OPEN_PER_REQUESTER} ta ochiq so‘rov bor — VED birortasiga javob bergach ✅ ni qayta bosing`,
  too_many_items: 'tovarlar juda ko‘p (1000 dan ortiq) — 🙋 bosing va mijozga Telegramda o‘zingiz javob bering',
  not_found: 'karta topilmadi — 🙋 bosing va mijozga Telegramda o‘zingiz javob bering',
  // The chat's lead was won or lost after it was bound (calc `leadTakesJobs`).
  lead_closed: 'bu chatning lidi yopilgan (yutilgan yoki yo‘qotilgan) — 🙋 bosing va mijozga Telegramda o‘zingiz javob bering',
  // Another press is landing this very job (decide `claimLanding`).
  [LANDING_CLAIM]: 'hozir navbatga qo‘yilmoqda — bir daqiqadan keyin kartani qarang',
  note_taken: 'bu material allaqachon boshqa so‘rovda',
  note_foreign: 'material boshqa kartaga tegishli',
  unauthenticated: 'siz tizimda emassiz',
  server_behind: 'server yangilanmoqda — biroz keyin ✅ ni qayta bosing',
};

/** A queue refusal code in words; an unknown one says so plainly, never as a code. */
export function calcQueueWords(code: string | null | undefined): string {
  return (code && CALC_QUEUE_WORDS[code]) ?? 'sababi noma’lum — biroz keyin ✅ ni qayta bosing';
}

/**
 * Telegram's refusal of a send, in words (K34). The row keeps Telegram's own
 * code (`last_error`) for the log; the card he reads never prints it.
 */
const SEND_FAIL_WORDS: readonly [RegExp, string][] = [
  [/PEER_FLOOD/u, 'Telegram akkauntni vaqtincha cheklagan (spam deb)'],
  [/USER_RESTRICTED/u, 'Telegram akkauntni cheklagan'],
  [/FROZEN_/u, 'Telegram akkauntni muzlatgan'],
  [/SESSION_REVOKED|AUTH_KEY_|SESSION_EXPIRED|USER_DEACTIVATED_BAN/u, 'Telegram sessiyasi tugagan — akkauntni qayta ulang'],
  [/USER_IS_BLOCKED/u, 'mijoz akkauntni bloklagan'],
  [/YOU_BLOCKED_USER/u, 'siz mijozni bloklagansiz'],
  [/USER_PRIVACY_RESTRICTED/u, 'mijozning maxfiylik sozlamasi yozishga ruxsat bermaydi'],
  [/INPUT_USER_DEACTIVATED|USER_DEACTIVATED/u, 'mijozning Telegram akkaunti o‘chirilgan'],
  [/CHAT_WRITE_FORBIDDEN/u, 'bu chatga yozib bo‘lmaydi'],
  [/PEER_ID_INVALID/u, 'chat topilmadi'],
  [/MESSAGE_EMPTY|MESSAGE_TOO_LONG|ENTITY_BOUNDS_INVALID|ENTITIES_TOO_LONG/u, 'Telegram matnni qabul qilmadi'],
];

/** A failed send's `last_error` in words; an unknown one says so plainly. */
export function sendFailWords(lastError: string | null | undefined): string {
  const text = (lastError ?? '').toUpperCase();
  for (const [re, words] of SEND_FAIL_WORDS) if (re.test(text)) return words;
  return 'Telegram rad etdi — chatni tekshiring';
}

/** Why an approved draft's actions did not all run, in words (K34): the calc queue's codes, else plainly. */
function actionFailWords(code: string | null | undefined): string {
  if (code && CALC_QUEUE_WORDS[code]) return `hisoblatish navbatga tushmadi — ${CALC_QUEUE_WORDS[code]}`;
  return 'amal bajarilmadi — kartani tekshiring';
}

/**
 * The line about where the draft stands. `sendable` is whether the card's
 * keyboard draws ✅ (`cardDrawsSend` over the policy AND the card's fit): the
 * editing line offers the AI's ✅ only where there is one (review: a card cut
 * for length told him to press a button it did not draw).
 */
function statusLine(d: DraftRow, o: OutboxRow | null, opts: CardRenderOptions, sendable: boolean): string | null {
  switch (d.status) {
    case 'pending':
      // A ✅ whose calculation the queue refused (K26): the draft waits, and says why, for as long as it stands.
      // A press landing it right now (decide `claimLanding`) says so, never «did not reach the queue».
      if (d.actionError === LANDING_CLAIM) return `⏳ Hisoblatish ${CALC_QUEUE_WORDS[LANDING_CLAIM]}.`;
      return d.actionStatus === 'failed' ? `⚠️ Hisoblatish navbatga tushmadi: ${calcQueueWords(d.actionError)}. Javob yuborilmadi.` : null;
    case 'editing':
      // He pressed ✏️ in the BOT (the page's ✏️ is a box and writes no status) — the
      // words say where the text goes, never «the customer's chat». A draft whose
      // machine text could still go says so: its ✅ sends it (decide `decideDraft`).
      if (opts.surface === 'web') return '✏️ Botda tahrir boshlangan — to‘g‘ri matnni botga yoki shu yerda «✏️ O‘zgartirish» bilan yozing.';
      return sendable
        ? '✏️ Matnni shu botga yozing (mijozning chatiga emas) — yoki AI matnini ✅ bilan yuboring.'
        : '✏️ Matnni shu botga yozing (mijozning chatiga emas) — keyin ✅ chiqadi.';
    case 'rejected':
      return '❌ Rad etildi.';
    case 'superseded':
      return STALE_WORDS[((d.policy ?? {}) as { stale?: string }).stale ?? ''] ?? '↪️ Mijoz yana yozdi — yangi qoralama.';
    case 'expired':
      return '⌛ Muddati o‘tdi.';
    case 'taken_over': {
      // A PERSON decided it: his 🙋 stamps `decided_by` (decide `decideDraft`). No
      // decider: he wrote to the customer himself and that retired the draft
      // (jobs `retireOnHumanReply`, the sweep's step 2, decide `chatMoved`) —
      // the convention outbox-store's `human_pressed_ms` already reads. The
      // time is when he WROTE (review: the retire's own time is the ✅ press
      // on the `chatMoved` path, and the sweep's minute on its step 2); the
      // pause runs from his last message, as the run counts it.
      if (d.decidedBy) return `🙋 Suhbatni o‘zingizga oldingiz — AI bu chatga ${HUMAN_TAKEOVER_HOURS} soat yozmaydi.`;
      const pause = opts.humanPauseMin ? ` Oxirgi xabaringizdan keyin AI bu chatga ${pauseWords(opts.humanPauseMin)} yozmaydi.` : '';
      return `✋ Siz mijozga Telegramda o‘zingiz yozdingiz (${clock(opts.humanWroteAt ?? d.updatedAt)}) — AI javobi bekor qilindi.${pause}`;
    }
    case 'approved': {
      if (!o) return d.actionStatus === 'failed' ? `⚠️ Bajarilmadi: ${actionFailWords(d.actionError)}.` : '✅ Tasdiqlandi.';
      switch (o.status) {
        case 'agent':
        case 'sending':
          return o.nextStepAt.getTime() > Date.now() + 60_000
            ? `✅ Tasdiqlandi · ${hhmm(o.nextStepAt)} da ketadi.`
            : '✅ Tasdiqlandi · yuborilmoqda…';
        case 'sent':
          return `✅ Yuborildi ${o.sentAt ? hhmm(o.sentAt) : ''}.`;
        case 'failed':
          return `⚠️ Yuborilmadi: ${sendFailWords(o.lastError)}.`;
        case 'cancelled':
        case 'expired': {
          const why = (o.lastError ?? '').split(':')[0]!.trim();
          return `✖ Yuborilmadi — ${CANCEL_WORDS[why] ?? 'bekor qilindi'}.`;
        }
        case 'unknown':
          return '❓ Yuborildimi — noma’lum. Telegramda tekshiring, qayta yuborilmaydi.';
      }
    }
  }
  return null;
}

/** What ✅ also does, one line per action — the card's, and the confirmation's after his own text (C9). */
export function actionLines(actions: ComposedAction[]): string[] {
  return actions.map((a) => {
    if (a.type === 'calc_submit') {
      // His third set «3»: a job priced from our Chinese warehouses says so on the card he approves.
      const ours = a.fromOurWarehouse === true ? ' · narx Xitoydagi omborimizdan, zavoddan omborgacha alohida' : '';
      return `🧮 Hisoblatishga: ${SECTION_WORDS[a.section] ?? a.section} · lentaga ${a.citedMessageIds.length} ta xabar · kelib chiqish sertifikati: kompaniya o‘zi oladi${ours}`;
    }
    if (a.type === 'set_followup') return `📅 Qayta aloqa: ${a.date}${a.note ? ` — ${a.note}` : ''}`;
    return '🔕 Bu chatda AI o‘chiriladi';
  });
}

const TITLES: Record<string, string> = {
  reply: '🤖 Javob qoralamasi',
  price: '💵 Narx javobi',
  hand_back: '🔁 VED qaytardi — mijozga savol',
};

/** How much of our last message a crowded card keeps — it is the context of the decision, not the decision. */
const LAST_OUT_SHOWN = 300;

/** What a crowded card says about the part it could not show — each names the part, never only «too long». */
const CUT_WORDS = {
  lastOut: 'Oxirgi javobimiz kartaga sig‘madi — boshi ko‘rsatildi (to‘liqi Telegram chatida).',
  ledgerLive: 'Kartada joy yo‘q — raqamlarning manbasi ko‘rsatilmadi, shuning uchun ✅ yo‘q. Qisqaroq matnni «✏️ O‘zgartirish» bilan yozing.',
  ledger: 'Kartada joy yo‘q — raqamlarning manbasi ko‘rsatilmadi.',
  replyLive: 'Javob juda uzun — kartaga sig‘maydi, ✅ yo‘q. Qisqaroq matnni «✏️ O‘zgartirish» bilan yozing.',
  reply: 'Javob juda uzun — kartaga sig‘madi.',
} as const;

function clipped(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max)).trimEnd()}…` : t;
}

function tryCard(c: CardInput): string | null {
  try {
    return agentCardText(c);
  } catch (err) {
    if (err instanceof CardTooLong) return null;
    throw err;
  }
}

/**
 * The card at its fullest that fits, and whether it still carries everything
 * ✅ approves. The card never cuts what he decides on (card.ts: the reply and
 * its gloss, every figure beside its source), so the parts go in order of
 * what they are:
 *  1. everything;
 *  2. our LAST message cut to its start — context, not the decision: a long
 *     one (an address list, a price table) used to take the ✅ off an ordinary
 *     reply and blame the reply's length (review);
 *  3. the figures' sources left out — the reply is whole, what each figure
 *     stands on is not, so no ✅;
 *  4. the reply itself cut — no ✅;
 *  5. never a throw: `createDraft` renders inside its transaction and
 *     `submitOwnText` after its write, and a card is not a reason for either
 *     to fail — the title, the status and the note, with what of the reply fits.
 */
function fitCard(input: CardInput, live: boolean): { text: string; tooLong: boolean } {
  const whole = tryCard(input);
  if (whole !== null) return { text: whole, tooLong: false };
  const lastOutCut = input.lastOut !== null && input.lastOut.trim().length > LAST_OUT_SHOWN;
  const crowded: CardInput = lastOutCut
    ? { ...input, lastOut: clipped(input.lastOut!, LAST_OUT_SHOWN), notes: [...input.notes, CUT_WORDS.lastOut] }
    : input;
  if (lastOutCut) {
    const text = tryCard(crowded);
    if (text !== null) return { text, tooLong: false };
  }
  if (input.ledger.length > 0) {
    const text = tryCard({ ...crowded, ledger: [], customerLines: [], notes: [...crowded.notes, live ? CUT_WORDS.ledgerLive : CUT_WORDS.ledger] });
    if (text !== null) return { text, tooLong: true };
  }
  // The reply is ≤ 700 by G4 and his own ≤ 4 000; a card this long carries a reply nobody may send from it.
  const note = live ? CUT_WORDS.replyLive : CUT_WORDS.reply;
  const cut = tryCard({
    ...input,
    reply: clipped(input.reply, 1500),
    gloss: input.gloss ? clipped(input.gloss, 800) : null,
    ledger: [],
    lastOut: null,
    customerLines: [],
    notes: [...input.notes, note],
  });
  if (cut !== null) return { text: cut, tooLong: true };
  const head = [`${input.title} — ${input.customerLabel}`, ...(input.statusLine ? [input.statusLine] : []), `ℹ️ ${note}`, '', '✉️ Javob:'].join('\n');
  return { text: `${head}\n${clipped(input.reply, STAFF_TEXT_CAP - 200 - head.length)}`.slice(0, STAFF_TEXT_CAP - 200), tooLong: true };
}

/**
 * The card's text from the stored draft (and its outbox row, once approved),
 * and whether it had to leave out a part ✅ approves: such a card is not one
 * to approve from (card.ts), so `tooLong` is a block every writer of the
 * card's buttons carries (`cardDrawsSend`) — the text says «✅ yo'q», the
 * keyboard agrees, and so does the editing line above them.
 */
export function renderDraftCardFull(
  d: DraftRow,
  o: OutboxRow | null,
  extraNotes: string[] = [],
  opts: CardRenderOptions = {},
): { text: string; tooLong: boolean } {
  const p = (d.policy ?? {}) as Partial<DraftPolicyJson>;
  const card = p.card ?? { customerLabel: '—', lastOut: null, customerLines: [] };
  const live = d.status === 'pending' || d.status === 'editing';
  const input = (sendable: boolean): CardInput => ({
    customerLabel: card.customerLabel,
    title: TITLES[d.kind] ?? TITLES.reply!,
    statusLine: statusLine(d, o, opts, sendable),
    blocks: live ? (p.blocks ?? []) : [],
    warnings: p.warnings ?? [],
    notes: [...(p.notes ?? []), ...extraNotes],
    reply: d.finalBody ?? d.proposedBody ?? '',
    gloss: d.finalBody ? null : d.glossUz,
    ledger: d.finalBody ? [] : (p.ledger ?? []),
    actions: actionLines((d.actions ?? []) as ComposedAction[]),
    ownerQuestion: d.needsOwner ? d.ownerQuestion : null,
    lastOut: card.lastOut,
    customerLines: card.customerLines,
    // An editing draft's status line already says where to write.
    remedy: d.status === 'editing' ? null : BLOCK_REMEDY[opts.surface ?? 'bot'],
  });
  const drawn = (tooLong: boolean) => cardDrawsSend({ blocked: d.blocked || tooLong, status: d.status, ownText: d.finalBody !== null });
  const first = fitCard(input(drawn(false)), live);
  // The fit took the ✅ away: the editing line above it must not still offer one.
  return first.tooLong && drawn(false) && d.status === 'editing' ? fitCard(input(false), live) : first;
}

/** The card's text alone — `renderDraftCardFull` for a reader that draws no buttons. */
export function renderDraftCard(d: DraftRow, o: OutboxRow | null, extraNotes: string[] = [], opts: CardRenderOptions = {}): string {
  return renderDraftCardFull(d, o, extraNotes, opts).text;
}

/**
 * When his own reply that retired the draft was sent — the first message he
 * wrote after its anchor that is not the agent's own send and not deleted:
 * `chatMoved`'s predicate, and the sweep's step 2's.
 */
async function humanReplyAt(d: DraftRow): Promise<Date | null> {
  const [first] = await db
    .select({ sentAt: tgMessages.sentAt })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(
      and(
        eq(tgMessages.managerUserId, d.managerUserId),
        eq(tgMessages.peerId, d.peerId),
        eq(tgMessages.direction, 'out'),
        gt(tgMessages.tgMessageId, d.anchorTgMessageId),
        isNull(tgMessageFlags.deletedAt),
        // `${table}.column` inside the subquery, never `${tgMessages.tgMessageId}` (#128).
        sql`NOT EXISTS (SELECT 1 FROM agent_outbox o WHERE o.manager_user_id = ${tgMessages}.manager_user_id AND o.tg_message_id = ${tgMessages}.tg_message_id)`,
      ),
    )
    .orderBy(tgMessages.tgMessageId)
    .limit(1);
  return first?.sentAt ?? null;
}

/**
 * Re-render the draft's card and put it everywhere it is: the notification
 * row's payload (so an unsent copy goes out current) and the sent Telegram
 * message (edited, with the buttons `buttonsFor` draws for its new state).
 */
export async function refreshAgentCard(draftId: string, extraNotes: string[] = []): Promise<void> {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d) return;
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId));
  // His own reply's time and the pause it starts — read only for the one line that names them.
  const ownReply = d.status === 'taken_over' && !d.decidedBy;
  const humanPauseMin = ownReply ? ((await readAgentConfig())?.humanPauseMin ?? null) : null;
  const humanWroteAt = ownReply ? await humanReplyAt(d) : null;
  const { text, tooLong } = renderDraftCardFull(d, o ?? null, extraNotes, { surface: 'bot', humanPauseMin, humanWroteAt });
  const live = d.status === 'pending' || d.status === 'editing';
  const body = digestBody(d);
  const kb = ((d.policy ?? {}) as { kb?: string }).kb;
  const sendable = cardDrawsSend({ blocked: d.blocked || tooLong, status: d.status, ownText: d.finalBody !== null });
  const extra = {
    ...cardExtra({ id: d.id, body, actions: (d.actions ?? []) as unknown[], blocked: !sendable, live, kind: d.kind }),
    // After he answered the agent's question himself and it went out, the
    // card offers to REMEMBER the answer (spec §7.1.4) — once.
    kbAsk: d.status === 'approved' && d.needsOwner && d.finalBody !== null && kb !== 'saved' && kb !== 'skipped',
  };
  const rows = await db
    .select({ id: notifications.id, locale: users.locale })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`))
    .orderBy(desc(notifications.createdAt));
  for (const row of rows) {
    const [written] = await db
      .update(notifications)
      .set({ payload: sql`${notifications.payload} || ${JSON.stringify({ ...extra, text })}::jsonb` })
      .where(eq(notifications.id, row.id))
      .returning({ payload: notifications.payload });
    if (!written) continue;
    // The payload as WRITTEN, never one read before it: a `tg` the drain
    // merged after the rows were listed — once its own after-send re-read had
    // found the card unchanged — is the copy this edit must reach, or neither
    // side corrects it (cards review; notifications/service
    // `correctAgentCopyInFlight`).
    const payload = written.payload as Record<string, unknown>;
    const tg = payload.tg as { chatId?: unknown; messageId?: unknown } | undefined;
    const chatId = Number(tg?.chatId);
    const messageId = Number(tg?.messageId);
    if (!process.env.TELEGRAM_BOT_TOKEN || !Number.isFinite(chatId) || !Number.isInteger(messageId)) continue;
    const message = composeStaffMessage('AgentDraft', payload, row.locale);
    const res = await editText({ chatId, messageId, html: message.html, replyMarkup: keyboardOf(buttonsFor('AgentDraft', payload)) });
    if (!res.ok) logger.warn({ draftId, description: res.description }, '[agent] card copy not edited');
  }
}
