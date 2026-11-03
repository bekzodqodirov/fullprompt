import { DEFAULT_LIMITS } from '../crm/telegram-send';

/**
 * Every number the AI sotuvchi obeys, in one place (review ban-11).
 *
 * FUSES, NOT TELEGRAM THRESHOLDS. Telegram publishes no per-user message rate;
 * what it documents is that FLOOD_WAIT is mandatory, PEER_FLOOD and FROZEN_*
 * mean the account is already limited, and spam REPORTS drive limits. So each
 * number below is where a person answering customers cannot reach but a bug —
 * a loop, a re-queue, an auto-replier talking to our AI — would, and its whole
 * purpose is to make such a fault cost his account nothing.
 *
 * Every send cap is at or below the human queue's own (`DEFAULT_LIMITS`), and
 * `tests/unit/agent-limits.test.ts` says so: the agent may never be the reason
 * the account hits a ceiling the human bridge already respects.
 *
 * Whose sends each queue counts (final review K5). The AGENT's two
 * account-wide fuses on Telegram's clock — `perHour` and the jittered gap
 * between two sends (`sendJitterMs`) — count its own rows AND the account's
 * sent CRM replies (`outbox-store.ts` chatFacts), so the machine yields to
 * the people: never a reply a second after a colleague's, never an hour the
 * people already filled. Its DAY — `perDay` and the ramp's ceiling — counts
 * its own sends only: that is his Q11 («the AI sends no more than I do»,
 * measured on his own sends, CRM ones included), and it is the very number
 * the ✅ door refuses on and the page prints (`today.ts` sendsToday). Counted
 * with the people, the door would accept a reply the step then held to the
 * morning, where the six-hour approval age cancels it. Its per-chat
 * numbers (`perChatGapMs`, `perChatPerDay`) count its own voice only — a
 * person's reply after the anchor cancels the row outright. The HUMAN queue's
 * `DEFAULT_LIMITS` count tg_outbox rows only, exactly as they always have: a
 * person's reply is never held back because the machine spoke, and the
 * human path is not changed by the agent's existence.
 */
export const AGENT_LIMITS = {
  /**
   * The truck's minimum shipment (his §17.14: «eng kamida 1 kub yuk yokida 100kg dan boshlab»): cargo below
   * BOTH is not accepted, so no figure is quoted for it — the reply says the minimum instead. Avia has its own.
   */
  minShipment: { m3: 1, kg: 100 } as const,
  /** Avia has its own minimum and time (his 2026-10-24 «avia uchun 1kg minimum», «2-5 kun … reysimiz bolsa 2 kun»). */
  avia: { minKg: 1, daysMin: 2, daysMax: 5 } as const,
  /** ≥ this long between two AI messages to one chat. */
  perChatGapMs: 20_000,
  /** A random gap between any two AI sends on the account, drawn from this range. */
  sendJitterMs: [10_000, 25_000] as const,
  perHour: 20,
  perDay: 80,
  /** AI sends to one chat per Tashkent day (map P6). */
  perChatPerDay: 12,
  /** Inbound runs per chat per Tashkent day — one chatty customer cannot spend the day's budget (money-11). */
  runsPerChatPerDay: 12,
  /** The first days after the agent is first switched on: at most his own average daily sends (his Q11 ⭐). */
  rampDays: 14,
  /** The customer's newest message must be at most this old for a run AND for the send (§17.4, ban-3). */
  anchorMaxAgeMs: 24 * 60 * 60_000,
  /** An approval older than this is not sent — the conversation has moved on (ban-3). */
  approvalMaxAgeMs: 6 * 60 * 60_000,
  /** Quiet after the newest inbound before a run (regression-13: no singletonKey; this + the stand-down). */
  debounceMs: 12_000,
  /** While the peer types, the run waits this much more, up to `typingWaitCapMs` (fit-9). */
  typingExtendMs: 8_000,
  typingWaitCapMs: 90_000,
  /** A greeting-only burst waits for the real question (fit-9). */
  greetingWaitMs: 60_000,
  /** An inbound this soon after our out row is a robot answering a robot (ban-4). */
  echoWindowMs: 5_000,
  /** Typing time = clamp(base + chars/charsPerSec, min, max) (ban-7 — folklore numbers, stated). */
  typingBaseMs: 2_000,
  typingCharsPerSec: 30,
  typingMinMs: 3_000,
  typingMaxMs: 12_000,
  /** SetTyping calls per message (each lasts ~6 s on Telegram's side). */
  typingCallsMax: 3,
  /**
   * How much of the chat's live head the verify and send steps read (ban-3). Enough to see the anchor itself
   * behind a couple of newer lines — which is how a deleted anchor is noticed (review S6) — and no more:
   * every GetHistory is a call on his account.
   */
  headMessages: 3,
  /** G4. */
  maxReplyChars: 700,
  /** G10: the same text fingerprint to more peers than this in 24 h blocks ✅ (ban-6). */
  fingerprintPeers: 3,
  /** G10: a link in at most one AI message per chat per 7 days, and this many per day overall. */
  urlPerChatDays: 7,
  urlPerDay: 10,
  /** Context (money-11). */
  contextMessages: 30,
  contextMessageChars: 1_000,
  contextTotalChars: 8_000,
  /** Model loop. */
  maxToolRounds: 6,
  /** Two send-path floods in this window switch the agent off (ban-2). */
  floodRepeatWindowMs: 24 * 60 * 60_000,
  /** Two blocks within this many days of an AI message switch the agent off (map P13). */
  blockWindowDays: 7,
  /** A pending draft lives as long as its anchor's reply window (fit-3). */
  draftTtlMs: 24 * 60 * 60_000,
  /** The listener's agent pump must have stamped within this, or ✅ is refused (regression-3). */
  pumpFreshMs: 2 * 60_000,
  /** The night: a ✅ is held to `nightReleaseAt` unless the customer wrote within `nightFreshMs` (his Q14 ⭐). */
  nightFromHour: 22,
  nightToHour: 8,
  nightReleaseAt: '08:30',
  nightFreshMs: 2 * 60 * 60_000,
  /**
   * A chat whose LEAD came from the client-finding agent (source `agent`, docs/AGENT-FEED.md §2) obeys that
   * agent's outreach playbook instead of the night: Telegram Monday-Saturday 10:00-17:00 Tashkent, never on
   * Sunday, Friday 12:00-14:00 avoided (clientScrapper docs/sotuv-playbook.md §2.2-§2.3; its §5.2 counts every
   * message outside 10:00-17:00 as a warning). No «wrote within two hours» exception: the prospect is somebody
   * the agent FOUND, and a reply he approves at 19:56 is a message at 19:56 (the merge review's probe).
   */
  agentLeadWindow: { days: [1, 2, 3, 4, 5, 6], fromHour: 10, toHour: 17, fridayBreak: [12, 14] } as const,
  /**
   * A reply past its read may finish into the night only this soon after its last step: the read pause and
   * the typing take seconds, so a longer gap means a wait (a flood, a restart) stood between them, and the
   * send is a new message at night (review S3's follow-up).
   */
  nightFinishMs: 2 * 60_000,
  /**
   * The send slot's memory of a restriction a send met, until the guard row is seen to hold the pause — and
   * no longer, should the pause never be written (a database that is not there).
   */
  slotRestrictedHoldMs: 2 * 60_000,
  /** How soon an agent row the send slot held is stepped again (its head is read anew). */
  slotRetryMs: 5_000,
} as const;

/** Compile-time anchor for the fence: the human queue's own numbers. */
export const HUMAN_LIMITS = DEFAULT_LIMITS;

/** Typing time for a reply of this many characters (ban-7). */
export function typingMs(chars: number): number {
  const raw = AGENT_LIMITS.typingBaseMs + (Math.max(0, chars) / AGENT_LIMITS.typingCharsPerSec) * 1000;
  return Math.round(Math.min(AGENT_LIMITS.typingMaxMs, Math.max(AGENT_LIMITS.typingMinMs, raw)));
}

/**
 * The day's AI send ceiling. For the first `rampDays` after the agent was
 * first switched on it is his own average daily sends from this account (the
 * human out rows of the 30 days before), never more than `perDay` and never
 * less than one; after the ramp, `perDay`. Computed, not typed (ban-11).
 */
export function dailySendCeiling(input: { startedAt: Date | null; ownAverage: number; now: Date }): number {
  const { startedAt, ownAverage, now } = input;
  if (!startedAt) return 0;
  const days = (now.getTime() - startedAt.getTime()) / 86_400_000;
  if (days >= AGENT_LIMITS.rampDays) return AGENT_LIMITS.perDay;
  const own = Number.isFinite(ownAverage) ? Math.floor(ownAverage) : 0;
  return Math.max(1, Math.min(AGENT_LIMITS.perDay, own));
}

/** A jitter draw, injectable for tests. */
export function sendJitterMs(random: () => number = Math.random): number {
  const [lo, hi] = AGENT_LIMITS.sendJitterMs;
  return Math.round(lo + (hi - lo) * Math.min(1, Math.max(0, random())));
}
