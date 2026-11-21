import type { CalcFacts, CalcSection } from '../calc/intake';
import type { LessonSetMark } from './lesson-rules';
import type { PolicyMemory } from './policy-input';
import type { PolicyResult } from './policy';

/** The shapes a draft row stores — shared by the writer, the card and the decision. */

export type ComposedAction =
  | {
      type: 'calc_submit';
      section: CalcSection;
      facts: CalcFacts;
      // No certificate: his 9 (2026-10-24) — the company obtains it itself, every agent job lands with it.
      /**
       * The cargo starts at none of our China warehouses (his third set «3»):
       * the landing takes the China column and its note says the factory leg
       * is extra. Decided by the run that wrote the reply which said so; an
       * action stored before it has none, which reads as false.
       */
      fromOurWarehouse: boolean;
      /**
       * The customer named no destination and the truck job took Tashkent (his «T a», 2026-11-21): the landing's note
       * says «Manzil aytilmagan — Toshkent deb olindi» to the VED. Absent — an action stored before it, or a job whose
       * destination was said — reads as said.
       */
      toCityAssumed?: boolean;
      /** tg_messages ids the model cited — the only messages that reach the lenta (leak-12). */
      citedMessageIds: string[];
    }
  | { type: 'set_followup'; date: string; note: string }
  | { type: 'mute'; reason: string };

/**
 * Whether the calculation a draft landed was priced FROM our China warehouses
 * (his third set «3») — read off the draft's stored actions, the one record
 * of what the customer was told. Every reader asks this: the landing's zone
 * and note, and the price the VED's answer becomes («💵 Narx yozaman»), which
 * must say the same condition and that the factory leg is extra. `=== true`:
 * an action stored before the flag existed carries none, and none is no.
 */
export function calcFromOurWarehouse(actions: unknown): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some(
    (a: unknown) =>
      typeof a === 'object' &&
      a !== null &&
      (a as { type?: unknown }).type === 'calc_submit' &&
      (a as { fromOurWarehouse?: unknown }).fromOurWarehouse === true,
  );
}

/** What the card shows of the chat — kept on the draft, so a refresh needs no re-read. */
export interface CardMemory {
  customerLabel: string;
  lastOut: string | null;
  customerLines: string[];
  /**
   * A VED answer's price on the HOLDER's card (SPEC-P2-v2 §2.2, judge hands 11): «🧮 rastamojka: VED 1 234,56 $ ·
   * ustama 10 % → mijozga 1 359 $» — the one place the floor and the rule are printed (law 4: never the ledger, the
   * chat block or any prompt part). Absent = the reply quotes no VED price.
   */
  calcLine?: string;
}

export interface DraftPolicyJson {
  blocks: PolicyResult['blocks'];
  warnings: PolicyResult['warnings'];
  ledger: PolicyResult['ledger'];
  memory: PolicyMemory;
  card: CardMemory;
  /**
   * The newest edit of a burst line the run READ (drafts `burstSeenAt`, ISO; null = none edited then; absent = a draft
   * written before fix pass 5): what `answer_stale` measures the question's burst with when his ✍️ answer comes.
   */
  burstSeenAt?: string | null;
  notes: string[];
  /**
   * What each note IS, parallel to `notes` (stage 1a, K5): the auto layer reads a note by its code, never by its words
   * (auto-send `noteCodesOf`). Absent = a draft written before 1a — read as «notes nobody coded», a machine stop when
   * there are any.
   */
  noteCodes?: NoteCode[];
  /**
   * The reply is a tayyor matn the CODE wrote for a burst the model cannot answer (stage 1a P3, `system-reply.ts`): a
   * voice note, a photo or file, a Pashto message. Absent = the model's own reply.
   */
  system?: SystemReplyReason;
  /**
   * The code put the honest line in front of the model's reply, or wrote it alone (stage 1a P3, run `withBotAnswer` —
   * the customer asked whether we are a bot). A tayyor matn like `system`: the gate holds a Persian or Chinese one for
   * his ✅ (`ready_text_unapproved`, J27). Absent = no honest line.
   */
  honestLine?: true;
  /**
   * A forcing rule put this question to him — rail's price, or the flight's address (spec SPEC-P1-v2 §2.2, run
   * `withRailRule` / `withAviaQuestion`): his answer goes verbatim through ✏️, so the card draws no «✍️ Savolga javob».
   * Absent = the model asked it itself (or no question at all).
   */
  forcedQuestion?: ForcedQuestion;
  /**
   * «✍️ Savolga javob» pressed: the draft is `editing`, waiting for his answer from `since` until `until` (ISO) —
   * §2.2. An `ownerAnswer` older than `since` belongs to an earlier press.
   */
  answering?: { since: string; until: string };
  /**
   * His answer to the question as he typed it into the bot (§2.2) — a key no sender reads (decideDraft sends
   * `finalBody ?? proposedBody`): the redraft's instruction and the «📌/👤» offer under the acknowledgement.
   */
  ownerAnswer?: OwnerAnswer;
  /**
   * This draft is the AI's redraft of his ✍️ answer to `questionDraftId` (§2.2): what the auto layer asks of it —
   * the personal bits his answer named (`owner_personal`) and the line the question answered (`answer_stale`).
   */
  fromAnswer?: AnswerMark;
  /**
   * A confirmed lesson is rewriting this reply («📝 Tuzatish» on a card still waiting for his ✅, spec SPEC-P1-v2
   * §3.4): the mark the rewrite must find to supersede it, and the moment it was queued (ISO) — the sweep hands a
   * rewrite that never came back in words. A newer lesson on the same card writes its own over it.
   */
  lessonRedraft?: { lessonId: string; at: string };
  /** This draft is the AI's rewrite of `draftId` after his lesson (§3.4) — its card says so while the words are the machine's. */
  fromLesson?: { lessonId: string; draftId: string };
  /**
   * The lessons the run that wrote this draft read (§3.7): a digest of the set and its newest lesson, so the rate
   * before and after a lesson can be read off the drafts. Absent = the run read none.
   */
  lessons?: LessonSetMark;
  /**
   * The reply a `calc_answer` run wrote on the VED's answer (SPEC-P2-v2 §2.3) — K2's week-long anchor clock and K1's
   * forgiven head read it (anchor-clock, outbox-store `chatFacts`). Absent = an ordinary reply.
   */
  calcAnswer?: { requestId: string };
  /**
   * What the reply settled on the card once it was SENT (SPEC-P2-v2 §2.4, §3.2; after-sent.ts) — written once, by the
   * after-sent job's last step: its absence on a sent row is what the sweep's net re-queues. `offer` = the holder's
   * card lines («💳 Kartaga yozildi: 1 359 $» or why not), `stage` = the stage step's outcome code (for the record).
   */
  afterSent?: AfterSentMark;
}

/** The after-sent job's record on its draft (§2.4, §3.2). */
export interface AfterSentMark {
  /** ISO — when the job finished. */
  at: string;
  offer: string[];
  stage: string;
}

export type ForcedQuestion = 'rail' | 'avia';

/**
 * Every note a reply's card may carry, by what it says (stage 1a, K5) — one code per writer, so the gate can free the
 * one note that only informs him (`late`, auto-gate `EYE_ONLY_NOTES`) while every note that names something he must
 * decide keeps the reply his. A writer with no code here cannot write a note: `tests/unit/agent-note-codes.test.ts`
 * reads every writer under `agent/`.
 */
export const NOTE_CODES = [
  /** card `lateNote` — the customer waited past `LATE_CARD_MS` before the card was written. */
  'late',
  /** run `validateActions` — a job below the truck's minimum is never landed. */
  'calc_below_minimum',
  /** …a job whose checklist was not complete. */
  'calc_incomplete',
  /** …a second job beside one still open in this chat. */
  'calc_open',
  /** …a follow-up date that is not a real day within 60 days. */
  'followup_bad',
  /** run `railNote` — rail was asked in the chat; the price is his. */
  'rail',
  /** the website table and /admin/tarif disagree — the truck price was not said. */
  'tariff_mismatch',
  /** run `CALC_PRICE_UNSAID` — the VED answered and the reply states no price the tool made. */
  'calc_price_unsaid',
  /** run `CALC_PRICE_MANY` — several jobs' VED prices were offered to one reply. */
  'calc_price_many',
  /** run `ANSWER_STILL_HIS` — a forcing rule turned his answer's redraft back into a question. */
  'answer_still_his',
  /** calc-submit — a calculation of this cargo within 14 days: his ✅ opens a new request. */
  'calc_recent',
  /** calc-submit — a file in the job's window was not kept: the VED will not get it. */
  'calc_file',
  /** calc-loop — his 💵 price draft: the price goes to the customer only, nothing to the deal card. */
  'price_only_customer',
] as const;

export type NoteCode = (typeof NOTE_CODES)[number];

/** The bursts a tayyor matn answers (stage 1a P3): a voice note, a kept photo or file, Pashto. */
export const SYSTEM_REPLY_REASONS = ['voice', 'media', 'pashto'] as const;

export type SystemReplyReason = (typeof SYSTEM_REPLY_REASONS)[number];

export interface OwnerAnswer {
  text: string;
  /** ISO — when the bot took it. */
  at: string;
  /** His message in the bot chat — the run's source key (`answer:<draft>:<message>`). */
  messageId: number;
}

export interface AnswerMark {
  questionDraftId: string;
  /** The customer line the question answered (`agent_drafts.anchor_tg_message_id`), a bigint as text. */
  questionAnchor: string;
  /**
   * The edit of that line the QUESTION was drafted over (`agent_drafts.anchor_edited_at`, ISO; null = none): an
   * edit later than it — made while he was answering — is a line he never answered (`answer_stale`).
   */
  questionAnchorEditedAt: string | null;
  /**
   * How far the QUESTION's run had seen its burst (owner-answer-job `questionSeenAt`: the newest edit of a burst line
   * it read, ISO — its `created_at` for a question written before fix pass 5; null = no line edited when read, or a
   * mark written before fix pass 3 — any edit reads as later): a line of the question's burst edited or deleted after
   * it is a line he never answered.
   */
  questionDraftedAt: string | null;
  /** What `ownerPersonalOf` found in his answer — another customer, or this chat's code to a chat not proven. */
  personal: string[];
  /**
   * His answer held a figure — a digit, a number in words, a Chinese numeral (`answerHoldsFigure`): the reply made of
   * it always comes back to him as a card (`owner_figure`, his Q2 a ⭐), whoever vouched for the figure it states.
   */
  figures: boolean;
}

