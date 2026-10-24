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
  offer_gone: 'narx amal qilmaydi',
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

function statusLine(d: DraftRow, o: OutboxRow | null): string | null {
  switch (d.status) {
    case 'pending':
      return null;
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
      if (!o) return d.actionStatus === 'failed' ? `⚠️ Bajarilmadi: ${d.actionError ?? ''}` : '✅ Tasdiqlandi.';
      switch (o.status) {
        case 'agent':
        case 'sending':
          return o.nextStepAt.getTime() > Date.now() + 60_000
            ? `✅ Tasdiqlandi · ${hhmm(o.nextStepAt)} da ketadi.`
            : '✅ Tasdiqlandi · yuborilmoqda…';
        case 'sent':
          return `✅ Yuborildi ${o.sentAt ? hhmm(o.sentAt) : ''}.`;
        case 'failed':
          return `⚠️ Yuborilmadi: ${o.lastError ?? ''}`;
        case 'cancelled':
        case 'expired': {
          const why = (o.lastError ?? '').split(':')[0]!.trim();
          return `✖ Yuborilmadi — ${CANCEL_WORDS[why] ?? o.lastError ?? ''}.`;
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
      return `🧮 Hisoblatishga: ${SECTION_WORDS[a.section] ?? a.section} · lentaga ${a.citedMessageIds.length} ta xabar · kelib chiqish sertifikati: kompaniya o‘zi oladi`;
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
    .select({ id: notifications.id, payload: notifications.payload, locale: users.locale, status: notifications.status })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`))
    .orderBy(desc(notifications.createdAt));
  for (const row of rows) {
    const payload: Record<string, unknown> = { ...(row.payload as Record<string, unknown>), ...extra, text };
    await db
      .update(notifications)
      .set({ payload: sql`${notifications.payload} || ${JSON.stringify({ ...extra, text })}::jsonb` })
      .where(eq(notifications.id, row.id));
    const tg = payload.tg as { chatId?: unknown; messageId?: unknown } | undefined;
    const chatId = Number(tg?.chatId);
    const messageId = Number(tg?.messageId);
    if (!process.env.TELEGRAM_BOT_TOKEN || !Number.isFinite(chatId) || !Number.isInteger(messageId)) continue;
    const message = composeStaffMessage('AgentDraft', payload, row.locale);
    const res = await editText({ chatId, messageId, html: message.html, replyMarkup: keyboardOf(buttonsFor('AgentDraft', payload)) });
    if (!res.ok) logger.warn({ draftId, description: res.description }, '[agent] card copy not edited');
  }
}
