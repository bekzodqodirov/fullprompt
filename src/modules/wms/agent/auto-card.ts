import { AUTO_REFUSAL_WORDS, type AutoRefusal } from './auto-gate';
import type { AutoCardState } from './auto-send';
import { POLICY_WORDS, type CardAutoPayload } from './card';
import type { AutoDisarmReason } from './config';
import type { DecideRefusal } from './decide';
import type { PolicyCode } from './policy';

/**
 * «O'zi yuborish» on the card he reads (docs/AI-SOTUVCHI.md §18.3) — PURE: the
 * line the card's status carries for the draft's auto state, in his words.
 * The renderer (card-io `renderDraftCardFull`) is the one caller, so the bot's
 * card and the page's card say the same sentence; the keyboard reads the
 * payload `cardExtra` writes from the same state (card.ts).
 *
 * Only what HE must know is said. A row his own press stopped, or that the
 * draft's own fate retired («gone»), says nothing: the draft's status line
 * already tells what happened to it.
 */

/** The time of day in Tashkent, «14:32». */
function clock(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3_600_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Why the MACHINE's ✅ was refused, as a short phrase for «⏱ O‘zi ketmadi: …»
 * — a Record over `decideDraft`'s refusals, so a new one is a compile error
 * here until somebody words it. A person's toast words (bot-door
 * `DECIDE_WORDS`) are sentences telling him what to press; this is the reason
 * a machine stood down.
 */
export const AUTO_PRESS_WORDS: Record<DecideRefusal, string> = {
  not_found: 'qoralama topilmadi',
  not_account_holder: 'qoralama boshqa akkauntniki',
  agent_off: 'AI sotuvchi o‘chirilgan',
  not_live: 'qoralama endi faol emas',
  editing: 'qoralama tahrirlanmoqda',
  stale_card: 'karta o‘zgargan',
  policy_block: 'qoida buzilgan',
  listener_behind: 'Telegram ko‘prigi (tinglovchi) yangilanmagan',
  sending_disabled: 'CRM’dan Telegramga yuborish o‘chirilgan',
  superseded: 'mijoz yana yozdi',
  taken_over: 'suhbatni o‘zingiz oldingiz',
  budget_spent: 'bugungi AI yuborish chegarasi tugagan',
  calc_not_queued: 'hisoblatish navbatga tushmadi',
  calc_in_flight: 'hisoblatish navbatga qo‘yilmoqda',
  identity_changed: 'chat boshqa mijozga o‘tdi',
  window_closed: 'mijoz topuvchi agentning lidi — ish vaqti emas',
  auto_warning: 'kartada ogohlantirish bor',
  empty: 'javob bo‘sh',
};

const isAutoRefusal = (code: string): code is AutoRefusal => Object.hasOwn(AUTO_REFUSAL_WORDS, code);
const isDecideRefusal = (code: string): code is DecideRefusal => Object.hasOwn(AUTO_PRESS_WORDS, code);

/**
 * A refused press's reason, in words. The row says it two ways (auto-send
 * `pressOne`): a gate refusal is its codes (`reasons`, and joined by commas in
 * `outcome`); `decideDraft`'s refusal is `code` or `code:detail` — a warning's
 * detail is the policy's own codes, named in the policy's own words. A code
 * nothing here knows is said plainly, never printed.
 */
export function autoRefusalWords(state: Pick<AutoCardState, 'outcome' | 'reasons'>): string {
  const gate = state.reasons.filter(isAutoRefusal);
  if (gate.length > 0) return gate.map((r) => AUTO_REFUSAL_WORDS[r]).join('; ');
  const outcome = state.outcome ?? '';
  const at = outcome.indexOf(':');
  const code = at < 0 ? outcome : outcome.slice(0, at);
  const detail = at < 0 ? '' : outcome.slice(at + 1);
  if (code.split(',').every(isAutoRefusal) && code !== '') return code.split(',').map((r) => AUTO_REFUSAL_WORDS[r as AutoRefusal]).join('; ');
  if (!isDecideRefusal(code)) return 'sababi noma’lum';
  const words = AUTO_PRESS_WORDS[code];
  if (code === 'auto_warning' && detail) {
    const named = detail
      .split(',')
      .map((w) => (POLICY_WORDS as Record<string, string>)[w.trim() as PolicyCode])
      .filter((w): w is string => typeof w === 'string');
    return named.length > 0 ? `${words}: ${named.join('; ')}` : words;
  }
  return words;
}

/** The ⏸ line — said where his press stopped the machine's. */
export const AUTO_PAUSED_LINE = '⏸ To‘xtatildi — o‘zingiz qaror qilasiz.';
/** The layer was switched off while this reply waited: it is his card again. */
export const AUTO_DISARMED_LINE = '⏸ O‘zi yuborish o‘chirildi — bu javobni o‘zingiz qaror qilasiz.';
/** The prefix of an approved card the machine pressed. */
export const AUTO_SENT_PREFIX = '🤖 O‘zi yuborildi (AI).';
/** His 👎 on it — the chat leaves the layer for 30 days (auto-send `autoFeedback`). */
export const AUTO_BAD_LINE = '👎 Xato deb belgilandi — bu suhbatda AI 30 kun o‘zi yozmaydi.';

/** «⏱ 14:32 da o‘zi ketadi — to‘xtatish uchun ⏸ bosing». */
export function autoWaitingLine(dueAt: Date): string {
  return `⏱ ${clock(dueAt)} da o‘zi ketadi — to‘xtatish uchun ⏸ bosing.`;
}

/** «⏱ O‘zi ketmadi: <why> — o‘zingiz qaror qiling.» */
export function autoRefusedLine(state: Pick<AutoCardState, 'outcome' | 'reasons'>): string {
  return `⏱ O‘zi ketmadi: ${autoRefusalWords(state)} — o‘zingiz qaror qiling.`;
}

/**
 * Is the card counting down to the machine's press — the ONE rule for the
 * line, the payload's `autoAt` and the page's ⏸: the row waits, the draft is
 * still the machine's pending reply (never one he opened ✏️ on), and the card
 * draws ✅ — a card that cannot show its whole reply never promises to send it
 * (the press refuses it too, auto-send `pressOne`).
 */
export function autoCountingDown(
  auto: Pick<AutoCardState, 'state' | 'dueAt'> | null | undefined,
  d: { status: string; finalBody: string | null },
  sendable: boolean,
): boolean {
  return auto?.state === 'waiting' && auto.dueAt !== null && d.status === 'pending' && d.finalBody === null && sendable;
}

/**
 * The status line with the auto state folded in. `base` is the line the
 * draft's own status gives (card-io `statusLine`):
 *  - counting down → the timer, above whatever the pending line says;
 *  - a live draft the press refused, ⏸ stopped, or the layer's «off» stopped
 *    → that sentence, above it — the card is his again;
 *  - an approved reply the machine pressed → the prefix on the approved line,
 *    and his 👎 under it;
 *  - anything else → the base line alone.
 */
export function withAutoLine(
  base: string | null,
  auto: AutoCardState | null | undefined,
  d: { status: string; finalBody: string | null },
  sendable: boolean,
): string | null {
  if (!auto) return base;
  const join = (...lines: (string | null)[]) => lines.filter((l): l is string => !!l).join('\n') || null;
  const live = d.status === 'pending' || d.status === 'editing';
  if (autoCountingDown(auto, d, sendable)) return join(autoWaitingLine(auto.dueAt!), base);
  if (live && auto.state === 'refused') return join(autoRefusedLine(auto), base);
  if (live && auto.state === 'stopped' && auto.outcome === 'pause') return join(AUTO_PAUSED_LINE, base);
  if (live && auto.state === 'stopped' && auto.outcome === 'disarmed') return join(AUTO_DISARMED_LINE, base);
  if (d.status === 'approved' && auto.state === 'pressed') {
    return join(base ? `${AUTO_SENT_PREFIX} ${base}` : AUTO_SENT_PREFIX, auto.feedback === 'bad' ? AUTO_BAD_LINE : null);
  }
  return base;
}

/**
 * The payload's auto fields (card `cardExtra`) — by the rules the line above
 * follows, so the keyboard and the words cannot disagree: ⏸ exactly while the
 * card counts down, 👎 under a reply the machine sent until he gave it.
 */
export function autoPayload(
  auto: AutoCardState | null | undefined,
  d: { status: string; finalBody: string | null },
  sendable: boolean,
): CardAutoPayload {
  const sent = auto?.state === 'pressed' && d.status === 'approved';
  return {
    autoAt: auto && autoCountingDown(auto, d, sendable) ? auto.dueAt!.toISOString() : null,
    autoSent: sent,
    autoBad: sent && auto?.feedback === 'bad',
  };
}

/** A disarm reason with its free tail cut: `forced: <Telegram code>` is one reason. */
export type AutoDisarmKind = Exclude<AutoDisarmReason, `forced: ${string}`> | 'forced';

/**
 * Why the layer was switched off, in his words — the bot's status line, and
 * the step-down alarm's «Sabab» (auto-send `autoDisarmAlarmText`). The page
 * says the same in the reader's language (labels `AUTO_DISARM_KEYS`).
 */
export const AUTO_DISARM_WORDS: Record<AutoDisarmKind, string> = {
  manual: 'qo‘lda o‘chirildi',
  agent_off: 'AI sotuvchi o‘chirildi',
  owner_changed: 'AI akkaunti almashtirildi',
  feedback: '7 kun ichida o‘zi ketgan 2 ta javobga «👎 Xato edi» bosildi',
  blocked: 'o‘zi javob yuborilgan mijoz akkauntni bloklagan',
  bot_question: '7 kun ichida o‘zi javob olgan 2 ta mijoz «botmisiz?» deb so‘radi',
  forced: 'Telegram akkaunti cheklandi — AI sotuvchi o‘zi o‘chdi',
};

/** The stored reason as its kind — `forced: …` is 'forced'; anything unknown is null. */
export function autoDisarmKind(reason: string | null): AutoDisarmKind | null {
  if (!reason) return null;
  if (reason.startsWith('forced:')) return 'forced';
  return Object.hasOwn(AUTO_DISARM_WORDS, reason) ? (reason as AutoDisarmKind) : null;
}

/** A stored disarm reason in words — never the raw code. */
export function autoDisarmWords(reason: string | null): string {
  const kind = autoDisarmKind(reason);
  return kind ? AUTO_DISARM_WORDS[kind] : 'sababi noma’lum';
}
