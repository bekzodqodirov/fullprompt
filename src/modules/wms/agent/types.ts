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
}

export interface DraftPolicyJson {
  blocks: PolicyResult['blocks'];
  warnings: PolicyResult['warnings'];
  ledger: PolicyResult['ledger'];
  memory: PolicyMemory;
  card: CardMemory;
  notes: string[];
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
}

export type ForcedQuestion = 'rail' | 'avia';

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
   * When the QUESTION was drafted (`agent_drafts.created_at`, ISO; null = a mark written before fix pass 3 — any edit
   * reads as later): a line of the question's burst edited or deleted after it is a line he never answered.
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

