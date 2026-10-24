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
   * When the night rule held this approval to the morning (0136), or null. The approval's age counts from
   * here (review S2): a reply approved at 23:00 and promised for 08:30 is not «six hours old» at 08:30.
   */
  releaseAt: Date | null;
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
  /** An inbound in this chat after the anchor that is not a nudge (`draftWorthy` says it wants its own answer). */
  newerSubstantiveInbound: boolean;
  /** This peer has written to this account (G7 per PEER, ban-8). */
  peerHasWritten: boolean;
  /** The chat's newest inbound — how long the customer has been waiting, which is what the night asks (S3). */
  lastInboundAt: Date | null;
  conversationMuted: boolean;
  ruleExcluded: boolean;
  /** Today's identity decision for the chat differs from the draft's (leak-4). */
  identityChanged: boolean;
  /** A price draft's offer: null when the draft carries none. */
  offerStands: boolean | null;
  /** Caps, counted over agent_outbox rows handed to Telegram — 'sent' AND 'unknown' (S5). */
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
  | 'not_caught_up'
  | 'chat_gap'
  | 'account_gap'
  | 'hour_cap'
  | 'day_cap'
  | 'chat_day_cap';

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
  row: Pick<AgentOutboxRow, 'managerUserId' | 'queuedAt' | 'releaseAt' | 'readDone'>,
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
  // hours — the same `releaseAt` the ✅ asks, so the two cannot disagree. Only before the read: once his
  // phone has shown the chat read and «typing…», finishing the reply is the less strange of the two.
  if (!row.readDone) {
    const release = releaseAt(f.now, f.lastInboundAt);
    if (release.getTime() > now) return wait('night', release);
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
      const head = await checkHead();
      if (head) return head;
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
 * When a ✅ may start sending (his Q14 ⭐): immediately by day; at night
 * immediately only when the customer wrote within the last two hours (he is
 * awake and waiting), else at 08:30 — in shadow every send is his own act,
 * and the hold exists so a 3 a.m. reply does not wake a customer who wrote
 * yesterday afternoon. Asked at the press AND by the send verdict (S3), so a
 * reply approved by day and carried into the night by a wait obeys it too.
 */
export function releaseAt(now: Date, lastInboundAt: Date | null): Date {
  if (!isTashkentNight(now)) return now;
  if (lastInboundAt && now.getTime() - lastInboundAt.getTime() <= AGENT_LIMITS.nightFreshMs) return now;
  return nextTashkentMorning(now);
}
