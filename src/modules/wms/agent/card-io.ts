import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentDrafts, agentOutbox, notifications, users } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { composeStaffMessage } from '../../platform/notifications/service';
import { keyboardOf } from '../../platform/notifications/staff-html';
import { editText } from '../../platform/telegram/send';
import { buttonsFor } from '../../platform/telegram/staff-bot';
import { agentCardText, cardExtra, CardTooLong, digestBody } from './card';
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

function statusLine(d: DraftRow, o: OutboxRow | null): string | null {
  switch (d.status) {
    case 'pending':
      // A ✅ whose calculation the queue refused (K26): the draft waits, and says why, for as long as it stands.
      // A press landing it right now (decide `claimLanding`) says so, never «did not reach the queue».
      if (d.actionError === LANDING_CLAIM) return `⏳ Hisoblatish ${CALC_QUEUE_WORDS[LANDING_CLAIM]}.`;
      return d.actionStatus === 'failed' ? `⚠️ Hisoblatish navbatga tushmadi: ${calcQueueWords(d.actionError)}. Javob yuborilmadi.` : null;
    case 'editing':
      return "✏️ O'z matningizni yozing (shu kartaga javob qilib yoki oddiy xabar bilan).";
    case 'rejected':
      return '❌ Rad etildi.';
    case 'superseded':
      return STALE_WORDS[((d.policy ?? {}) as { stale?: string }).stale ?? ''] ?? '↪️ Mijoz yana yozdi — yangi qoralama.';
    case 'expired':
      return '⌛ Muddati o‘tdi.';
    case 'taken_over':
      return "✋ O'zingiz javob berdingiz.";
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

function actionLines(actions: ComposedAction[]): string[] {
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

/** The card's text from the stored draft (and its outbox row, once approved). */
export function renderDraftCard(d: DraftRow, o: OutboxRow | null, extraNotes: string[] = []): string {
  const p = (d.policy ?? {}) as Partial<DraftPolicyJson>;
  const card = p.card ?? { customerLabel: '—', lastOut: null, customerLines: [] };
  const input = {
    customerLabel: card.customerLabel,
    title: TITLES[d.kind] ?? TITLES.reply!,
    statusLine: statusLine(d, o),
    blocks: d.status === 'pending' || d.status === 'editing' ? (p.blocks ?? []) : [],
    warnings: p.warnings ?? [],
    notes: [...(p.notes ?? []), ...extraNotes],
    reply: d.finalBody ?? d.proposedBody ?? '',
    gloss: d.finalBody ? null : d.glossUz,
    ledger: d.finalBody ? [] : (p.ledger ?? []),
    actions: actionLines((d.actions ?? []) as ComposedAction[]),
    ownerQuestion: d.needsOwner ? d.ownerQuestion : null,
    lastOut: card.lastOut,
    customerLines: card.customerLines,
  };
  try {
    return agentCardText(input);
  } catch (err) {
    if (!(err instanceof CardTooLong)) throw err;
    // The reply is ≤ 700 by G4 and his own ≤ 4 000; a card this long carries
    // a blocked machine reply nobody may send — said, never cut.
    return agentCardText({ ...input, reply: `${input.reply.slice(0, 1500)}…`, ledger: [], customerLines: [], notes: [...input.notes, 'Javob juda uzun — ✅ yo‘q.'] });
  }
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
  const text = renderDraftCard(d, o ?? null, extraNotes);
  const live = d.status === 'pending' || d.status === 'editing';
  const body = digestBody(d);
  const kb = ((d.policy ?? {}) as { kb?: string }).kb;
  const extra = {
    ...cardExtra({ id: d.id, body, actions: (d.actions ?? []) as unknown[], blocked: d.blocked, live, kind: d.kind }),
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
