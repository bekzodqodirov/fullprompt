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
