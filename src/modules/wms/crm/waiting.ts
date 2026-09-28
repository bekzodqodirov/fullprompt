/**
 * «Javobsiz qoldi» — one answer, four screens (round 88).
 *
 * The owner: «habar javobsz qoldi deb warning berishni chatni ichiga
 * kirgandan keyin tohtatish — negaki klient chatga nuqta qoygandur, misol
 * uchun ok yokida agree yokida got it, shunda bunga sales manager javob
 * bermaydi lekin warning turibti».
 *
 * He is describing a mark that can only say two things. It was computed from
 * one rule — «the newest message came IN» — restated by hand in FOUR
 * independent places (`listConversations`, `chatBadges`, `salesFlowCounts`,
 * `unansweredChats`), which is #513's rule broken four ways: a predicate that
 * decides what a screen shows belongs in one place, or the screens disagree.
 *
 * THREE states now, and they are the ones Telegram itself shows:
 *
 *   new      — the client wrote and NOBODY has seen it. The alarm.
 *   seen     — read, no answer written. Quiet: «ok» needs nothing from us.
 *   answered — we replied, or a reply is on its way out.
 *
 * «seen» is Telegram's OWN read state first: opening the dialog on a phone
 * sends a read receipt and every other device is told, so the listener copies
 * a fact that exists whether we store it or not, rather than inventing a
 * second notion of «read» out of our screens. Our thread screen sets it too
 * (`markThreadRead`) — to the owner both screens are the chat — but always
 * under the same law: the mark belongs to the account that did the reading.
 * A supervisor (round 33 `seesAllTg`) glancing at a seller's conversation
 * therefore silences nothing, which is the failure a naive «somebody opened
 * it» flag would have shipped with.
 */

export type ChatState = 'new' | 'seen' | 'answered';

export interface ChatFacts {
  /** Direction of the newest stored message in this conversation. */
  lastDirection: string | null;
  /** Telegram's id for the newest INCOMING message, when there is one. */
  lastInboundTgId: bigint | null;
  /** How far this manager has read, from Telegram's own read state. */
  lastReadTgId: bigint | null;
  /**
   * Is there a reply queued, in flight or delivered SINCE that message?
   *
   * The old mark ignored `tg_outbox` entirely, so a reply typed in the CRM
   * left the alarm up until the listener delivered it — and for ever when
   * company-wide sending is off, which is how it ships (`tg_sending_enabled`
   * defaults to false). A typed answer is an answer; the queue is where it
   * lives until the socket agrees.
   */
  replyPending: boolean;
}

/**
 * The one rule. Pure, so the four screens can be shown to agree without a
 * database, and so the ordering below is stated once instead of four times.
 */
export function chatState(facts: ChatFacts): ChatState {
  // Nothing stored, or we spoke last: there is nothing to answer.
  if (facts.lastDirection !== 'in') return 'answered';
  // Something is on its way out — typed, queued, or already delivered.
  if (facts.replyPending) return 'answered';
  // Read up to this message on any of the manager's own devices.
  if (
    facts.lastReadTgId !== null &&
    facts.lastInboundTgId !== null &&
    facts.lastReadTgId >= facts.lastInboundTgId
  ) {
    return 'seen';
  }
  return 'new';
}

/**
 * Does this state deserve the alarm — the red mark and the Telegram nudge?
 *
 * ONLY `new`. That is the whole of the owner's complaint: a customer who
 * wrote «ok» is read and finished, and an alarm that cannot tell that from a
 * question nobody answered is an alarm people learn to ignore.
 *
 * The cost, stated so it is a decision and not a surprise: a manager who
 * reads a REAL question on their phone and then forgets it leaves no alarm
 * behind. That case wants a «remind me» button, which is deliberately not in
 * this round — one new idea at a time.
 */
export function chatNeedsAnswer(state: ChatState): boolean {
  return state === 'new';
}

/**
 * When a LEAD's conversation started ringing (the lead chats round, owner's
 * answer 4a — «lidlarning chatlari ham mijoz chatlari kabi, 30 daqiqa»).
 *
 * Lead-owned chat rows have been stored since 0064 and NOTHING has ever
 * stamped them: the 30-minute sweep read client chats only, so `reminded_at`
 * is NULL on every one, and the home count never looked. Switching the watch
 * on without a line would ring, on the first sweep after the deploy, for
 * every lead chat whose newest message is an unread incoming one — months-old
 * lost leads included — and lift the seller's «javob kutmoqda» by the same
 * number: the false alarm the owner called «juda yomon» (#649), manufactured
 * wholesale (the design judge's second finding).
 *
 * A fixed instant and not a migration's stamp, because this round adds no
 * migration: the day the round was built. What arrives after it rings like a
 * client's chat; what sat before it stays on the list, quietly. The same
 * burst, smaller, follows a connect-time backfill (history-backfill.ts): a
 * week pulled on connect rings once for whatever in it is unread and after
 * this line — exactly as a client chat's backfill always has.
 */
export const LEAD_CHAT_ALARMS_FROM = new Date('2026-09-28T00:00:00+05:00');

/**
 * Does a lead chat's alarm stand — the one extra door a CLIENT chat does not
 * have?
 *
 * Two lines, and a lead's newest incoming message must be past both:
 *  - the watch's own start (`LEAD_CHAT_ALARMS_FROM`, above);
 *  - the lead's CLOSING, when it is closed. Moving a lead to won or lost is a
 *    decision about the conversation — nobody owes an answer to something the
 *    funnel already settled — while a person writing AGAIN after that is a
 *    new enquiry (round 79's reasoning for lost leads), and rings.
 *
 * Pure, so the rule is stated once: `resolveChatStates` applies it to every
 * lead seed, and all four readers (the list, the card badges, the home count,
 * the nudge) go through that one resolver.
 */
export function leadAlarmStands(input: { sentAt: Date; closedAt: Date | null }): boolean {
  if (input.sentAt.getTime() < LEAD_CHAT_ALARMS_FROM.getTime()) return false;
  if (input.closedAt && input.sentAt.getTime() <= input.closedAt.getTime()) return false;
  return true;
}

/**
 * A lead chat's state, once `leadAlarmStands` has been asked.
 *
 * A `new` state whose alarm does not stand reads `answered` — the state that
 * already means «nothing is asked of anybody here» (see `chatState`'s first
 * line). NOT `seen`: that one prints «✓ o'qildi», and nobody read it.
 */
export function leadChatState(
  state: ChatState,
  facts: { sentAt: Date; closedAt: Date | null },
): ChatState {
  if (state === 'new' && !leadAlarmStands(facts)) return 'answered';
  return state;
}
