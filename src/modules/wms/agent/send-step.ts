import { AGENT_LIMITS, typingMs } from './limits';
import type { TgErrorKind } from '../crm/telegram-guard';

/**
 * How an approved AI reply leaves his account (spec §17.8, review build-3).
 *
 * The listener is the only process holding the session, and everything it
 * does after a claim used to live inside one closure no test could import. So
 * the decisions live HERE, pure: whether this row may go (`agentSendVerdict`),
 * what the live head of the chat says (`liveHeadVerdict`), how long to type
 * (`choreographyPlan`), and where the row goes after each step
 * (`afterStep`). `runAgentStep` drives one step through two injected
 * adapters — the gramjs one in the listener, a fake in the tests.
 *
 * Steps run on the ROW's own clock (`next_step_at`), never on how often the
 * pump is woken (regression-9): verify → read → typing (≤ 3 calls) → send.
 */

export type AgentStep = 'verify' | 'read' | 'typing' | 'send';

export interface AgentOutboxRow {
  id: string;
  draftId: string;
  managerUserId: string;
  peerId: bigint;
  clientId: string | null;
  leadId: string | null;
  body: string;
  randomId: bigint;
  replyToTgMessageId: bigint | null;
  answersTgMessageId: bigint;
  status: 'agent' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'unknown' | 'expired';
  step: AgentStep;
  nextStepAt: Date;
  typingCount: number;
  readDone: boolean;
  queuedAt: Date;
  /**
   * When the night rule held this approval to the morning (0138), or null. The approval's age counts from
   * here (review S2): a reply approved at 23:00 and promised for 08:30 is not «six hours old» at 08:30.
   */
  releaseAt: Date | null;
  /**
   * When the row last took a step — the column `step_claimed_at`, stamped by every advance and by the send's
   * claim; null before the first. What tells «the read was seconds ago» from «the read was before a wait of
   * hours» (the night rule after the read, review S3's follow-up).
   */
  lastStepAt: Date | null;
}

/** Facts the store reads for a verdict — every one from the database, at this tick. */
export interface SendFacts {
  now: Date;
  /** agent_config: shadow + the same owner as the row. */
  agentOn: boolean;
  ownerUserId: string | null;
  sendingEnabled: boolean;
  accountPaused: boolean;
  floodUntil: Date | null;
  /** This process finished its start-up catch-up (ban-3). */
  caughtUp: boolean;
  /** The anchor's sent_at; null when the stored row is gone (deleted, purged). */
  anchorSentAt: Date | null;
  anchorDeleted: boolean;
  anchorEditedSinceDraft: boolean;
  /** An out row in this chat after the anchor that is not this outbox row (his phone, a CRM reply). */
  humanReplied: boolean;
  /**
   * The chat's 🙋 «24 soat menda» (`agent_conversations.human_until`), or null — when he took the chat
   * over himself. Read at THIS tick like every other fact (final review K2): a reply approved before the
   * press and still waiting (night-held to 08:30, a flood, a cap) was otherwise sent into the chat he had
   * just said is his.
   */
  humanUntil: Date | null;
  /**
   * When he pressed that 🙋 — the newest draft of this chat a PERSON decided `taken_over` (`decideDraft`'s
   * own `decided_at`; the machine's «he answered himself» writes no decider) — or null when no press is on
   * record. The takeover covers what he approved BEFORE it; a reply he approves after it is his own new
   * word (a price typed through «💵 Narx yozaman»), never one the press withdrew (final review K2's
   * follow-up).
   */
  humanPressedAt: Date | null;
  /** An inbound in this chat after the anchor that is not a nudge (`draftWorthy` says it wants its own answer). */
  newerSubstantiveInbound: boolean;
  /** This peer has written to this account (G7 per PEER, ban-8). */
  peerHasWritten: boolean;
  /** The chat's newest inbound — how long the customer has been waiting, which is what the night asks (S3). */
  lastInboundAt: Date | null;
  /**
   * Which quiet hours the chat obeys (`sendWindowFor`): the night, or — for a lead the client-finding agent
   * brought — that agent's playbook window. Read at THIS tick, like every other fact.
   */
  sendWindow: SendWindow;
  conversationMuted: boolean;
  ruleExcluded: boolean;
  /** Today's identity decision for the chat differs from the draft's (leak-4). */
  identityChanged: boolean;
  /** A price draft's offer: null when the draft carries none. */
  offerStands: boolean | null;
  /**
   * Caps, counted over agent_outbox rows handed to Telegram — 'sent' AND 'unknown' (S5). The hour and the
   * account's last send count the account's sent CRM replies as well (K5); the day and the chat's two are
   * the machine's own voice (`limits.ts`).
   */
  sentToChatToday: number;
  sentLastHour: number;
  sentToday: number;
  dailyCeiling: number;
  lastChatSendAt: Date | null;
  lastAccountSendAt: Date | null;
  /** The jitter drawn for the account gap this tick. */
  accountGapMs: number;
}

export type FinalRefusal =
  | 'agent_off'
  | 'owner_changed'
  | 'sending_disabled'
  | 'account_paused'
  | 'anchor_gone'
  | 'anchor_edited'
  | 'anchor_superseded'
  | 'human_replied'
  | 'anchor_too_old'
  | 'approval_too_old'
  | 'never_wrote'
  | 'muted'
  | 'excluded'
  | 'identity_changed'
  | 'offer_gone';

export type WaitReason =
  | 'flood_wait'
  | 'night'
  /** An agent-sourced lead's chat outside Monday-Saturday 10:00-17:00 (`AGENT_LIMITS.agentLeadWindow`). */
  | 'agent_window'
  | 'not_caught_up'
  | 'chat_gap'
  | 'account_gap'
  | 'hour_cap'
  | 'day_cap'
  | 'chat_day_cap'
  /** The account's send slot held the turn (`slotHold`): a send queued ahead of this one changed what it knows. */
  | 'slot_held';

export type SendVerdict =
  | { ok: true }
  | { ok: false; final: true; reason: FinalRefusal }
  | { ok: false; final: false; reason: WaitReason; until: Date };

/**
 * May this row take its next step now? A FINAL refusal cancels the row (and
 * the card says why); a WAIT re-schedules it. Order matters: what makes the
 * reply WRONG is decided before what only makes it LATE.
 */
export function agentSendVerdict(
  row: Pick<AgentOutboxRow, 'managerUserId' | 'queuedAt' | 'releaseAt' | 'readDone' | 'lastStepAt'>,
  f: SendFacts,
): SendVerdict {
  const fin = (reason: FinalRefusal): SendVerdict => ({ ok: false, final: true, reason });
  const wait = (reason: WaitReason, until: Date): SendVerdict => ({ ok: false, final: false, reason, until });
  const now = f.now.getTime();

  if (!f.agentOn) return fin('agent_off');
  if (f.ownerUserId !== row.managerUserId) return fin('owner_changed');
  if (!f.sendingEnabled) return fin('sending_disabled');
  if (f.accountPaused) return fin('account_paused');
  if (f.anchorSentAt === null || f.anchorDeleted) return fin('anchor_gone');
  if (f.anchorEditedSinceDraft) return fin('anchor_edited');
  if (f.humanReplied) return fin('human_replied');
  // 🙋 is the same promise as a reply of his own, made a moment before he types it — so the same refusal
  // and the card's same words («o'zingiz javob berdingiz», the draft's own `taken_over` line). FINAL, not a
  // wait: the chat is his for a day, and a reply carried past that would answer a conversation he ran.
  // Only for what he approved at or BEFORE the press: a ✅ he gives after it is the man who took the chat
  // choosing to send this — his typed price — and refusing it would cancel his own word and tell him he
  // had answered himself. A takeover with no press on record withdraws everything, as it always did.
  if (f.humanUntil && f.humanUntil.getTime() > now && approvedBeforePress(row, f.humanPressedAt)) {
    return fin('human_replied');
  }
  if (f.newerSubstantiveInbound) return fin('anchor_superseded');
  if (now - f.anchorSentAt.getTime() > AGENT_LIMITS.anchorMaxAgeMs) return fin('anchor_too_old');
  // From the later of the press and the morning it was held to (S2) — or every night-held ✅ is cancelled
  // at the 08:30 it was promised for.
  const approvedAt = Math.max(row.queuedAt.getTime(), row.releaseAt?.getTime() ?? 0);
  if (now - approvedAt > AGENT_LIMITS.approvalMaxAgeMs) return fin('approval_too_old');
  if (!f.peerHasWritten) return fin('never_wrote');
  if (f.conversationMuted) return fin('muted');
  if (f.ruleExcluded) return fin('excluded');
  if (f.identityChanged) return fin('identity_changed');
  if (f.offerStands === false) return fin('offer_gone');

  if (f.floodUntil && f.floodUntil.getTime() > now) return wait('flood_wait', f.floodUntil);
  // The night rule at the SEND, not only at the ✅ (his Q14 ⭐, review S3): a row a flood wait, the hour cap
  // or the one-in-flight queue carried past 22:00 is held to 08:30 unless the customer wrote within two
  // hours — the same `releaseAt` the ✅ asks, so the two cannot disagree. One exception: a reply in the
  // middle of its choreography — read on his phone, «typing…» SECONDS ago — finishes, because stopping it
  // there is the stranger of the two. Seconds, not «after the read»: a wait of hours after the read (a
  // SendMessage flood, a restart's catch-up) leaves no «typing…» on anybody's screen, and the reply that
  // comes out of it at 00:30 is a new message at night like any other.
  // An agent-sourced lead's chat asks its playbook window the same way, at the same place (the merge review):
  // a reply carried past 17:00 by a gap or a flood waits for the next working morning.
  if (!finishingChoreography(row, now)) {
    const release = releaseAt(f.now, f.lastInboundAt, f.sendWindow);
    if (release.getTime() > now) return wait(f.sendWindow === 'agent_lead' ? 'agent_window' : 'night', release);
  }
  if (!f.caughtUp) return wait('not_caught_up', new Date(now + 10_000));
  if (f.lastChatSendAt && now - f.lastChatSendAt.getTime() < AGENT_LIMITS.perChatGapMs) {
    return wait('chat_gap', new Date(f.lastChatSendAt.getTime() + AGENT_LIMITS.perChatGapMs));
  }
  if (f.lastAccountSendAt && now - f.lastAccountSendAt.getTime() < f.accountGapMs) {
    return wait('account_gap', new Date(f.lastAccountSendAt.getTime() + f.accountGapMs));
  }
  if (f.sentToChatToday >= AGENT_LIMITS.perChatPerDay) return wait('chat_day_cap', nextTashkentMorning(f.now));
  if (f.sentLastHour >= AGENT_LIMITS.perHour) return wait('hour_cap', new Date(now + 5 * 60_000));
  if (f.sentToday >= Math.min(f.dailyCeiling, AGENT_LIMITS.perDay)) return wait('day_cap', nextTashkentMorning(f.now));
  return { ok: true };
}

/**
 * Was this reply approved at or before his 🙋? The approval is the ✅'s own
 * instant (`queued_at`), never the morning a night-held row was promised for:
 * a reply approved at 23:00 and held to 08:30 was approved BEFORE a 07:30
 * press, and that is exactly the reply the press withdraws (K2).
 */
function approvedBeforePress(row: Pick<AgentOutboxRow, 'queuedAt'>, pressedAt: Date | null): boolean {
  return pressedAt === null || pressedAt.getTime() >= row.queuedAt.getTime();
}

/**
 * Is this row in the middle of its choreography — past its read, and its last
 * step (`lastStepAt`) no longer ago than the ordinary steps take
 * (`AGENT_LIMITS.nightFinishMs`)? Then the night lets it finish.
 */
function finishingChoreography(row: Pick<AgentOutboxRow, 'readDone' | 'lastStepAt'>, now: number): boolean {
  return row.readDone && row.lastStepAt !== null && now - row.lastStepAt.getTime() <= AGENT_LIMITS.nightFinishMs;
}

/**
 * What the account's send slot knows the moment a send's turn comes — in the
 * listener's memory, written INSIDE the slot by the sends before it, before
 * the slot lets the next one go (review S12's follow-up).
 */
export interface SlotState {
  now: Date;
  /** A send-method wait a send through the slot met — the in-memory copy; the guard row's lands a moment later. */
  floodUntil: Date | null;
  /** A restriction (PEER_FLOOD, FROZEN_*) a send through the slot met that the guard row has not been seen to hold yet. */
  restrictedAt: Date | null;
  /** When a send to THIS chat last left the slot; null for none, or for a send that names no chat. */
  peerSentAt: Date | null;
}

/**
 * May a send take its turn of the slot now?
 *
 * The agent's tick runs beside the human pump (review S12), so a send can
 * queue for the slot behind another and wait there: everything it checked
 * before — the flood clock, the pause, the live head — can change while it
 * waits, and Telegram's answer to the send ahead of it is exactly what
 * changes it. So the slot asks again, from what the sends ahead of it wrote
 * down, and refuses to make the call:
 *
 *   - a send-method wait one of them met — sending into it is the knocking
 *     that loses the account (ban-2), and a second send flood in 24 h
 *     switches the agent off;
 *   - a restriction one of them met, until the guard row is seen to hold it
 *     (bounded by `slotRestrictedHoldMs`, should the pause never be written);
 *   - for the agent, a send to the SAME chat that left after its live head was
 *     read (`headAt`): a person's CRM reply that went first. The head is read
 *     again on the next step, and it says `human_replied`.
 *
 * A WAIT for the agent's row; for a person's reply the claim is given back,
 * its attempt with it (`giveClaimBack`, final review K4), and the human pump
 * asks this same question BEFORE its next claim, so a held turn is not
 * claimed again and again while it lasts (K22). Pure: the listener holds the
 * memory.
 */
export function slotHold(s: SlotState, headAt: Date | null): { reason: WaitReason; until: Date } | null {
  const now = s.now.getTime();
  if (s.floodUntil && s.floodUntil.getTime() > now) return { reason: 'flood_wait', until: s.floodUntil };
  if (s.restrictedAt && now - s.restrictedAt.getTime() < AGENT_LIMITS.slotRestrictedHoldMs) {
    return { reason: 'slot_held', until: new Date(now + AGENT_LIMITS.slotRetryMs) };
  }
  if (headAt && s.peerSentAt && s.peerSentAt.getTime() >= headAt.getTime()) {
    return { reason: 'slot_held', until: new Date(now + AGENT_LIMITS.slotRetryMs) };
  }
  return null;
}

/** One message of the chat's live head, as Telegram returns it (`messages.GetHistory`, newest first). */
export interface HeadMessage {
  id: bigint;
  out: boolean;
  text: string;
  /** It carries a photo, a voice note, a file, a video, a place — anything but a sticker or a link preview (S4). */
  media: boolean;
}

/**
 * Does this line of the customer's ask for its OWN answer? A photo, a voice
 * note, a file or a video always does — the invoice with «mana», a question
 * spoken instead of typed — so an approved reply would answer a question that
 * is no longer the last one (review S4: a media line has text '' and read as
 * a nudge). A text asks only when it is not a nudge (`isNudge`). One rule for
 * the live head, the stored check and the ✅'s own re-check.
 */
export function asksAnew(m: { text: string; media: boolean }, isNudge: (text: string) => boolean): boolean {
  return m.media || !isNudge(m.text);
}

export type HeadVerdict = { ok: true } | { ok: false; reason: 'human_replied' | 'anchor_superseded' | 'anchor_gone' };

/**
 * The LIVE head of the chat, not the stored one (ban-3): gramjs never
 * recovers an update gap, so tg_messages can miss what the customer — or he,
 * on his phone — wrote while the connection blinked. Every message newer than
 * the anchor decides: one of OURS (not this row's own echo) means a person
 * already answered; one of THEIRS that asks anew (`asksAnew`) means the reply
 * answers a question that is no longer the last one.
 *
 * And the anchor itself (S6): a customer who deleted the question leaves no
 * line newer than it, so the loop above found nothing. When the head reaches
 * back to the anchor's place — it holds an older line, or it is shorter than
 * asked, i.e. the chat's whole history fit — the anchor's own id must be in
 * it. A full head of newer lines cannot see that far, and has decided above.
 */
export function liveHeadVerdict(
  head: readonly HeadMessage[],
  anchorId: bigint,
  isNudge: (text: string) => boolean,
  limit: number = AGENT_LIMITS.headMessages,
): HeadVerdict {
  for (const m of head) {
    if (m.id <= anchorId) continue;
    if (m.out) return { ok: false, reason: 'human_replied' };
    if (asksAnew(m, isNudge)) return { ok: false, reason: 'anchor_superseded' };
  }
  const reachesBack = head.length < limit || head.some((m) => m.id < anchorId);
  if (reachesBack && !head.some((m) => m.id === anchorId)) return { ok: false, reason: 'anchor_gone' };
  return { ok: true };
}

export interface Choreography {
  typingMs: number;
  typingCalls: number;
  /** Between one SetTyping and the next (Telegram shows each for about six seconds). */
  typingGapMs: number;
  /** After the read, before typing starts — the time it takes to read. */
  readPauseMs: number;
}

/** How this reply is typed (ban-7): clamp(2 s + chars/30, 3 s, 12 s), at most three calls. */
export function choreographyPlan(body: string, random: () => number = Math.random): Choreography {
  const ms = typingMs([...body].length);
  const calls = Math.min(AGENT_LIMITS.typingCallsMax, Math.max(1, Math.ceil(ms / 5_000)));
  return {
    typingMs: ms,
    typingCalls: calls,
    typingGapMs: Math.ceil(ms / calls),
    readPauseMs: Math.round(1_000 + 2_000 * Math.min(1, Math.max(0, random()))),
  };
}

/** What happened to the row after one step — the store applies it. */
export type StepOutcome =
  | { kind: 'advance'; step: AgentStep; nextStepAt: Date; readDone?: boolean; typingCount?: number }
  | { kind: 'wait'; nextStepAt: Date; reason: WaitReason }
  | { kind: 'cancel'; reason: FinalRefusal | 'human_replied' | 'anchor_superseded' | 'claim_lost'; markUnread: boolean }
  | { kind: 'sent'; tgMessageId: bigint | null }
  | { kind: 'failed'; reason: string; error: TgErrorKind; markUnread: boolean }
  /** The send was handed to Telegram and its answer was lost: never re-sent (ban-5). */
  | { kind: 'unknown'; reason: string }
  /** Telegram ordered a wait before taking the send — the row goes back to 'agent'. */
  | { kind: 'flooded'; seconds: number; method: string };

/**
 * A verdict as the outcome the store writes: a final refusal cancels (and
 * gives the badge back when the chat was already read), a wait re-schedules,
 * and null lets the row take its step. The listener also asks this alone —
 * with no step after it — while the account is paused or sending is off
 * (review S8): what can no longer be sent is cancelled, and Telegram is not
 * called at all.
 */
export function verdictOutcome(row: Pick<AgentOutboxRow, 'readDone'>, verdict: SendVerdict): StepOutcome | null {
  if (verdict.ok) return null;
  return verdict.final
    ? { kind: 'cancel', reason: verdict.reason, markUnread: row.readDone }
    : { kind: 'wait', nextStepAt: verdict.until, reason: verdict.reason };
}

/** The listener's Telegram, as the steps need it. */
export interface AgentTelegram {
  history(peerId: bigint, limit: number): Promise<HeadMessage[]>;
  readHistory(peerId: bigint, maxId: bigint): Promise<void>;
  setTyping(peerId: bigint): Promise<void>;
  markUnread(peerId: bigint): Promise<void>;
  send(input: { peerId: bigint; body: string; randomId: bigint; replyTo: bigint | null }): Promise<{ tgMessageId: bigint | null }>;
}

/**
 * One turn of the account's send slot, as the send step takes it: the claim
 * and the SendMessage run inside `send`, and nothing else on this account
 * sends while they do (review S12's follow-up). The listener's turn asks
 * `slotHold` first and answers its refusal as a wait — `headAt` is when this
 * step's live head was read, so a send to the same chat that left after it
 * holds the turn. Without a slot (the tests), the send simply runs.
 */
export type SendTurn = (turn: { peerId: bigint; headAt: Date }, send: () => Promise<StepOutcome>) => Promise<StepOutcome>;

const noSlot: SendTurn = (_turn, send) => send();

/** The database half: the facts for a verdict, and the one CAS before the send. */
export interface AgentStepStore {
  facts(row: AgentOutboxRow, now: Date): Promise<SendFacts>;
  /** 'agent' → 'sending' for this row; false when somebody else moved it (cancel, off). */
  claimSend(rowId: string): Promise<boolean>;
}

/**
 * One step of one row. Never throws for a Telegram answer — every one is
 * classified into an outcome; a throw from here is the store's (the database),
 * and the pump treats it as a blip.
 */
export async function runAgentStep(
  row: AgentOutboxRow,
  deps: {
    tg: AgentTelegram;
    store: AgentStepStore;
    classify: (err: unknown) => TgErrorKind;
    isNudge: (text: string) => boolean;
    /** The account's send slot (the listener's); the claim and the send happen inside one turn of it. */
    sendTurn?: SendTurn;
    now?: () => Date;
    random?: () => number;
  },
): Promise<StepOutcome> {
  const now = deps.now ?? (() => new Date());
  const t = now();
  const plan = choreographyPlan(row.body, deps.random);
  const refused = verdictOutcome(row, agentSendVerdict(row, await deps.store.facts(row, t)));
  if (refused) return refused;

  const cosmetic = async (method: string, call: () => Promise<void>): Promise<StepOutcome | null> => {
    try {
      await call();
      return null;
    } catch (err) {
      const kind = deps.classify(err);
      // A read or typing error blocks the send only when it says the account is in trouble (ban-7).
      if (kind.kind === 'flood') return { kind: 'flooded', seconds: kind.seconds, method };
      if (kind.kind === 'restricted' || kind.kind === 'session') {
        return { kind: 'failed', reason: kind.code, error: kind, markUnread: row.readDone };
      }
      return null;
    }
  };

  const checkHead = async (): Promise<StepOutcome | null> => {
    let head: HeadMessage[];
    try {
      head = await deps.tg.history(row.peerId, AGENT_LIMITS.headMessages);
    } catch (err) {
      const kind = deps.classify(err);
      if (kind.kind === 'flood') return { kind: 'flooded', seconds: kind.seconds, method: 'messages.GetHistory' };
      if (kind.kind === 'restricted' || kind.kind === 'session' || kind.kind === 'recipient_final') {
        return { kind: 'failed', reason: kind.code, error: kind, markUnread: row.readDone };
      }
      // Unknown live head: try again shortly rather than send blind.
      return { kind: 'wait', nextStepAt: new Date(t.getTime() + 15_000), reason: 'not_caught_up' };
    }
    const v = liveHeadVerdict(head, row.answersTgMessageId, deps.isNudge, AGENT_LIMITS.headMessages);
    return v.ok ? null : { kind: 'cancel', reason: v.reason, markUnread: row.readDone };
  };

  switch (row.step) {
    case 'verify': {
      const head = await checkHead();
      if (head) return head;
      return { kind: 'advance', step: 'read', nextStepAt: t };
    }
    case 'read': {
      const failed = await cosmetic('messages.ReadHistory', () => deps.tg.readHistory(row.peerId, row.answersTgMessageId));
      if (failed) return failed;
      return { kind: 'advance', step: 'typing', nextStepAt: new Date(t.getTime() + plan.readPauseMs), readDone: true };
    }
    case 'typing': {
      const failed = await cosmetic('messages.SetTyping', () => deps.tg.setTyping(row.peerId));
      if (failed) return failed;
      const count = row.typingCount + 1;
      const nextStepAt = new Date(t.getTime() + plan.typingGapMs);
      return count >= plan.typingCalls
        ? { kind: 'advance', step: 'send', nextStepAt, typingCount: count }
        : { kind: 'advance', step: 'typing', nextStepAt, typingCount: count };
    }
    case 'send': {
      // The head is read OUTSIDE the slot: a gramjs flood sleep inside this GetHistory must not hold a
      // person's reply (S12). Its instant is taken before the call, so a send that left while the call was
      // on its way is one the slot counts against it.
      const headAt = now();
      const head = await checkHead();
      if (head) return head;
      // The claim and the send are one turn of the slot: a CRM reply to this chat, a wait or a
      // restriction met by the send queued ahead of this one is seen before the call (`slotHold`).
      return (deps.sendTurn ?? noSlot)({ peerId: row.peerId, headAt }, async () => {
        // A lost claim means somebody else moved the row first (off, withdrawn, superseded) — its own
        // write already said why; this cancel matches no row and records nothing of its own.
        if (!(await deps.store.claimSend(row.id))) return { kind: 'cancel', reason: 'claim_lost', markUnread: row.readDone };
        try {
          const sent = await deps.tg.send({
            peerId: row.peerId,
            body: row.body,
            randomId: row.randomId,
            replyTo: row.replyToTgMessageId,
          });
          return { kind: 'sent', tgMessageId: sent.tgMessageId };
        } catch (err) {
          const kind = deps.classify(err);
          switch (kind.kind) {
            case 'duplicate':
              return { kind: 'sent', tgMessageId: null };
            case 'flood':
              return { kind: 'flooded', seconds: kind.seconds, method: 'messages.SendMessage' };
            case 'restricted':
            case 'session':
            case 'recipient_final':
            case 'message_final':
              return { kind: 'failed', reason: kind.code, error: kind, markUnread: true };
            case 'db':
            case 'transient':
              return { kind: 'unknown', reason: kind.code };
          }
        }
      });
    }
  }
}

/** 08:30 Tashkent of the next morning (UTC+5, no daylight saving). */
export function nextTashkentMorning(now: Date): Date {
  const local = new Date(now.getTime() + 5 * 3_600_000);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let release = day + (8 * 60 + 30) * 60_000 - 5 * 3_600_000;
  if (release <= now.getTime()) release += 86_400_000;
  return new Date(release);
}

/** Is it night in Tashkent (22:00-08:00)? */
export function isTashkentNight(now: Date): boolean {
  const h = new Date(now.getTime() + 5 * 3_600_000).getUTCHours();
  return h >= AGENT_LIMITS.nightFromHour || h < AGENT_LIMITS.nightToHour;
}

/**
 * Which quiet hours a chat obeys. 'agent_lead' = a chat bound to a LEAD whose
 * source is the client-finding agent (docs/AGENT-FEED.md §2): somebody the
 * agent FOUND, whom the agent's playbook allows a message only Monday-Saturday
 * 10:00-17:00. Every other chat — a client, a lead from any other door — is
 * 'default', the night rule, exactly as before.
 */
export type SendWindow = 'default' | 'agent_lead';

/** Tashkent wall clock (UTC+5, no daylight saving): weekday 0 = Sunday, and the minute of the day. */
function tashkentClock(now: Date): { day: number; minute: number; dayStartMs: number } {
  const local = new Date(now.getTime() + 5 * 3_600_000);
  const dayStartMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 5 * 3_600_000;
  return { day: local.getUTCDay(), minute: local.getUTCHours() * 60 + local.getUTCMinutes(), dayStartMs };
}

/**
 * The agent lead window's open stretches of one Tashkent weekday, in minutes
 * of the day: none on Sunday, 10:00-17:00 on a working day, and on Friday the
 * 12:00-14:00 the playbook says to avoid taken out.
 */
function agentLeadStretches(day: number): Array<[number, number]> {
  const w = AGENT_LIMITS.agentLeadWindow;
  if (!(w.days as readonly number[]).includes(day)) return [];
  const from = w.fromHour * 60;
  const to = w.toHour * 60;
  if (day !== 5) return [[from, to]];
  return [
    [from, w.fridayBreak[0] * 60],
    [w.fridayBreak[1] * 60, to],
  ];
}

/** Is a message to an agent-sourced lead allowed at this moment? */
export function inAgentLeadWindow(now: Date): boolean {
  const { day, minute } = tashkentClock(now);
  return agentLeadStretches(day).some(([a, b]) => minute >= a && minute < b);
}

/** The first moment at or after `now` that the agent lead window is open. */
export function nextAgentLeadWindow(now: Date): Date {
  if (inAgentLeadWindow(now)) return now;
  const { day, minute, dayStartMs } = tashkentClock(now);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const stretches = agentLeadStretches((day + ahead) % 7);
    for (const [from] of stretches) {
      if (ahead > 0 || from > minute) return new Date(dayStartMs + ahead * 86_400_000 + from * 60_000);
    }
  }
  // Unreachable while any weekday has a stretch; a window configured empty holds the reply a week.
  return new Date(dayStartMs + 7 * 86_400_000);
}

/**
 * When a ✅ may start sending (his Q14 ⭐): immediately by day; at night
 * immediately only when the customer wrote within the last two hours (he is
 * awake and waiting), else at 08:30 — in shadow every send is his own act,
 * and the hold exists so a 3 a.m. reply does not wake a customer who wrote
 * yesterday afternoon. Asked at the press AND by the send verdict (S3), so a
 * reply approved by day and carried into the night by a wait obeys it too.
 *
 * An agent-sourced lead's chat ('agent_lead') is held instead to the agent's
 * playbook window — Monday-Saturday 10:00-17:00, no Sunday, Friday 12:00-14:00
 * avoided — with NO «wrote within two hours» exception (the merge review:
 * approved at 19:56, it went at 19:56). `window` is REQUIRED: a default would
 * fail open on the one chat the rule exists for.
 */
export function releaseAt(now: Date, lastInboundAt: Date | null, window: SendWindow): Date {
  if (window === 'agent_lead') return nextAgentLeadWindow(now);
  if (!isTashkentNight(now)) return now;
  if (lastInboundAt && now.getTime() - lastInboundAt.getTime() <= AGENT_LIMITS.nightFreshMs) return now;
  return nextTashkentMorning(now);
}
