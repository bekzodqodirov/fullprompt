import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { aiConfigured } from '../../platform/ai/model';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db, type Tx } from '../../platform/db/client';
import {
  agentAutoVerdicts,
  agentCalcLinks,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  calcRequests,
  crmActivities,
  leads,
  tgAccounts,
  tgMessageFlags,
  tgMessages,
  users,
} from '../../platform/db/schema';
import { enqueue } from '../../platform/jobs/boss';
import { logger } from '../../platform/logger';
import { getSetting } from '../../platform/settings/service';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { listenerIsCurrent, readGuard } from '../crm/account-guard';
import { afterPressOf, autoChatTakenInTx, autoPressStandsInTx, machinePressedReply, settleAutoPressInTx, stopAutoForPerson, type AutoPressLoss } from './auto-send';
import { cardAsks, cardDigest, digestBody } from './card';
import { LANDING_CLAIM, renderDraftCardFull, type SupersededStale } from './card-io';
import { agentAutoReady, agentFullP1Ready, agentRunning, readAgentConfig } from './config';
import { bindMoved, chatIdentity } from './context';
import { approvedLocale } from './locale';
import { zoneForOrigin } from './origin';
import { ownerPolicyFor, policyFor } from './policy-input';
import { AFTER_AUTO, keptFileSql } from './outbox-store';
import { CANCELLED_BY_HOLDER } from './web-thread';
import { AGENT_LIMITS } from './limits';
import { estimatesStand } from './estimate-check';
import { asksAnew, releaseAt } from './send-step';
import { sendWindowFor } from './send-window';
import { readSendCaps } from './send-caps';
import { confirmTariffInTx } from './tariff-watch';
import { capReached, dayRunCounts, OUTBOX_GOING, sendsToday } from './today';
import { HUMAN_TAKEOVER_HOURS } from './limits';
import { isFirstAsk, JOB_AGENT_INBOUND, JOB_AGENT_OWNER_ANSWER, nextRedraftAttempt, type AgentInboundJob, type AgentOwnerAnswerJob } from './queues';
import { ANSWER_WAIT_MS, answerTextRefusal, type AnswerContact } from './owner-answer';
import { isNudge } from './worthy';
import type { PolicyHit } from './policy';
import type { ComposedAction, DraftPolicyJson } from './types';

/**
 * His decision on a draft (spec §17.7) — ONE function for the bot's buttons
 * and the web page, so the two doors cannot disagree.
 *
 * Only the ACCOUNT HOLDER decides (leak-5): a message leaves a personal
 * account only by its holder, and a super_admin who may run the page may not
 * put words into another person's mouth. The ✅ carries a digest of what the
 * card showed (leak-3): a press on a card that has since changed is refused,
 * never applied to the new words. The policy is re-run on the STORED body
 * with the world read now; the chat is re-validated (a newer question, his own
 * reply, an edited message); and the outbox row is written in the same
 * transaction that marks the draft approved — so «approved» and «queued» are
 * one fact (regression-8).
 *
 * A calculation is landed BEFORE the reply is queued (regression-4, money-5):
 * «hisoblatishga yubordim» goes out only when the VED queue took the job.
 */

export type DraftDecision = 'send' | 'reject' | 'human' | 'edit';

export type DecideRefusal =
  | 'not_found'
  | 'not_account_holder'
  | 'agent_off'
  | 'not_live'
  | 'editing'
  | 'stale_card'
  | 'policy_block'
  | 'listener_behind'
  | 'sending_disabled'
  | 'superseded'
  | 'taken_over'
  | 'budget_spent'
  | 'calc_not_queued'
  | 'calc_in_flight'
  | 'identity_changed'
  /**
   * An agent-sourced lead's chat (`sendWindowFor`): the playbook's next open
   * window is more than a day after the customer's message, so the send step
   * would only cancel the reply as `anchor_too_old` — said at the press, and
   * nothing is queued (a ✅ on Saturday evening; Sunday is no window).
   */
  | 'window_closed'
  /**
   * «O'zi yuborish»'s press (§18.3) found a WARNING on the fresh policy re-run:
   * a person may press past a warning he has read, the machine may not. Nothing
   * is written — the card stays an ordinary card he can press.
   */
  | 'auto_warning'
  /**
   * The machine's press lost INSIDE its own approval (fix pass A, C2/C5): a stop
   * moved its verdict first (⏸, a person's own decision, a disarm) —
   * `auto_stopped` — or the layer was no longer armed, or the account no longer a
   * work number — `auto_disarmed` — or the chat was his (🙋) — `taken_over`, the
   * same word a person's press meets on a chat he took (the final check). Nothing
   * is written: the approval rolls back.
   */
  | AutoPressLoss
  /**
   * A PERSON's press on a reply the MACHINE already approved (fix pass A, C3):
   * ✅ and ✏️ (and ❌, once it cannot be taken back) are «kech» — the reply can
   * still be taken back with ❌ «Bekor qilish» (`auto_pressed`), is being sent
   * (`auto_sending`), or went (`auto_sent`). A person's own ✅ before is not
   * this: his ❌ and 🙋 after it answer `not_live` as they always did.
   */
  | 'auto_pressed'
  | 'auto_sending'
  | 'auto_sent'
  /**
   * The machine's estimate priced again at this press gives another figure, or could not be priced (spec
   * SPEC-P1-v2 §1.3): a tariff edit or a new avia rate since the draft. Nothing is queued — the send step would
   * only cancel it. His own words (✏️) carry his own figure and are never asked.
   */
  | 'estimate_moved'
  | 'empty';

export type DecideResult =
  | {
      ok: true;
      status: string;
      sendAt?: Date;
      requestId?: string | null;
      /**
       * `submitOwnText`'s answer (C9): whether his words passed the owner
       * subset, what blocked them if not, and the digest of the card they now
       * stand on — the confirmation's own ✅ carries it, so the press is the
       * card's press and `decideDraft` compares it like any other.
       */
      blocked?: boolean;
      blocks?: PolicyHit[];
      digest?: string;
      /** What that ✅ also does — the draft's actions ride with his words (C9: the confirmation names them). */
      actions?: ComposedAction[];
      /**
       * 🙋's withdrawals, said on the press (ident fix F10): the approved
       * replies still waiting that it cancelled, and how many of them were HIS
       * OWN words (a ✏️ text, a 💵 price) — the one kind he would not expect a
       * «the chat is mine» to take back.
       */
      withdrawn?: { total: number; own: number };
      /**
       * 🙋 on a reply the MACHINE approved that could no longer be taken back
       * (fix pass A, C3): the chat is his all the same, and the press says
       * the machine's reply is being sent, or went.
       */
      autoReply?: 'sending' | 'sent';
    }
  | { ok: false; code: DecideRefusal; detail?: string };

export interface DeciderActor {
  id: string;
  roles: readonly string[];
  permissions: ReadonlySet<string>;
}

const NOTE_NS = '4f1c2b1e-0138-4a51-9c1e-5a6d7e8f9a0b';
/** The intake note's id for a draft — the landing is re-runnable without a second note (build-6). */
export const noteIdFor = (draftId: string) => uuidv5(draftId, NOTE_NS);

/** A positive 63-bit random id — Telegram's dedup key, minted ONCE per approved reply (ban-5). */
export function mintRandomId(): bigint {
  const b = randomBytes(8);
  b[0] = b[0]! & 0x7f;
  const v = b.readBigInt64BE(0);
  return v === 0n ? 1n : v;
}

/**
 * Was the customer's line edited after the draft read it? `anchorEditedAt` is
 * the edit the draft was written over (null: none). One test for the ✅
 * (`chatMoved`) and the ❌ (`decideDraft`): a ❌ on a ✏️-opened draft whose line
 * the customer EDITED asks the edited line again, as the ✅ does (review: the
 * edit's own run stood down for his ✏️, the ❌ looked only for a NEWER line,
 * and the customer's changed question was drafted by nobody).
 */
function editedSince(d: typeof agentDrafts.$inferSelect, editedAt: Date | null): boolean {
  return editedAt !== null && (!d.anchorEditedAt || editedAt.getTime() > d.anchorEditedAt.getTime());
}

/** The anchor's own edit stamp read now — `editedSince`'s input for a press that does not run `chatMoved`. */
async function anchorEditedNow(d: typeof agentDrafts.$inferSelect): Promise<boolean> {
  const [anchor] = await db
    .select({ editedAt: tgMessages.editedAt })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, d.managerUserId), eq(tgMessages.peerId, d.peerId), eq(tgMessages.tgMessageId, d.anchorTgMessageId)));
  return anchor !== undefined && editedSince(d, anchor.editedAt);
}

/**
 * Has the chat moved past the draft since it was written? Re-asked at the ✅
 * from the stored rows; the pump asks the live head again before every step.
 * A newer inbound counts by `asksAnew` — the head's own rule — so a photo, a
 * voice note or a file the customer sent after the question supersedes the
 * reply exactly as a typed question does (review S4); in the stored record a
 * medium is a file this system KEPT (`keptFileSql`), which is also what tells
 * a photo from a sticker here.
 */
async function chatMoved(d: typeof agentDrafts.$inferSelect): Promise<'superseded' | 'taken_over' | 'anchor_edited' | null> {
  const [anchor] = await db
    .select({ sentAt: tgMessages.sentAt, editedAt: tgMessages.editedAt })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, d.managerUserId), eq(tgMessages.peerId, d.peerId), eq(tgMessages.tgMessageId, d.anchorTgMessageId)));
  if (!anchor) return 'superseded';
  if (editedSince(d, anchor.editedAt)) return 'anchor_edited';
  const newer = await db
    .select({
      id: tgMessages.id,
      direction: tgMessages.direction,
      body: tgMessages.body,
      tgMessageId: tgMessages.tgMessageId,
      deletedAt: tgMessageFlags.deletedAt,
      // `${table}.id`, never `${tgMessages.id}`: inside the subquery an unqualified column binds to ITS table (#128).
      kept: keptFileSql(sql`${tgMessages}.id`).mapWith(Boolean),
    })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(and(eq(tgMessages.managerUserId, d.managerUserId), eq(tgMessages.peerId, d.peerId), gt(tgMessages.tgMessageId, d.anchorTgMessageId)));
  const live = newer.filter((m) => !m.deletedAt);
  const outIds = live.filter((m) => m.direction === 'out').map((m) => m.tgMessageId);
  const ours = outIds.length
    ? await db
        .select({ id: agentOutbox.tgMessageId })
        .from(agentOutbox)
        .where(and(eq(agentOutbox.managerUserId, d.managerUserId), inArray(agentOutbox.tgMessageId, outIds)))
    : [];
  const oursSet = new Set(ours.map((r) => String(r.id)));
  if (live.some((m) => m.direction === 'out' && !oursSet.has(String(m.tgMessageId)))) return 'taken_over';
  if (live.some((m) => m.direction === 'in' && asksAnew({ text: m.body ?? '', media: m.kept }, isNudge))) return 'superseded';
  return null;
}

/**
 * Is the chat no longer the customer this draft was written for? Asked of the
 * server's identity NOW, by the one rule the tray's withdrawal asks too
 * (context `bindMoved`).
 */
async function identityMoved(d: typeof agentDrafts.$inferSelect): Promise<boolean> {
  if (!d.clientId && !d.leadId) return false;
  return bindMoved(d, await chatIdentity(d.managerUserId, d.peerId));
}

/**
 * Today's AI sends against the ceiling — a ✅ beyond it is refused with the text to copy (fit-8). One home:
 * today.ts, over the effective day cap (send-caps.ts) the send step uses too.
 */
async function budgetLeft(managerUserId: string, startedAt: Date | null, now: Date): Promise<number> {
  const { used, ceiling } = await sendsToday(managerUserId, startedAt, now, (await readSendCaps()).dayCap);
  return ceiling - used;
}

/** When the customer's question this draft answers was sent — the clock `anchor_too_old` reads at the send. */
async function anchorSentAt(d: typeof agentDrafts.$inferSelect): Promise<Date | null> {
  const [row] = await db
    .select({ sentAt: tgMessages.sentAt })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, d.managerUserId), eq(tgMessages.peerId, d.peerId), eq(tgMessages.tgMessageId, d.anchorTgMessageId)));
  return row?.sentAt ?? null;
}

async function lastInboundAt(d: typeof agentDrafts.$inferSelect): Promise<Date | null> {
  const [row] = await db
    .select({ sentAt: tgMessages.sentAt })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, d.managerUserId), eq(tgMessages.peerId, d.peerId), eq(tgMessages.direction, 'in')))
    .orderBy(desc(tgMessages.sentAt))
    .limit(1);
  return row?.sentAt ?? null;
}

/**
 * What `redraftNewest` found, for the press's words AND the card's: which line
 * the chat moved to — the EDITED anchor itself, or a newer message (an edit
 * with a newer line past it is a newer message) — and what happens to it.
 * «Mijoz yana yozdi» about an edit sent him looking for a message that is not
 * there, and «o‘zingiz javob bering» about a line whose reply he had already
 * approved told him to answer twice (review).
 */
export interface RedraftAnswer {
  line: 'edited' | 'newer';
  /**
   * coming: a card for that line is on its way; none: nothing will draft it — he answers; answered: its
   * card is approved and its reply went or is going; capped: only a run that has not reserved yet could
   * draft it, and the chat is at a daily cap — that run would be refused, so nothing comes and he answers.
   */
  next: 'coming' | 'none' | 'answered' | 'capped';
}

/**
 * The customer's newest message asked again when the draft a run stood down
 * for is gone (review: ✅ on an editing draft after the customer wrote again).
 * A run that meets a draft he is EDITING stands down after its model call
 * (`createDraft` → 'editing', the run's row `stood_down`/'editing') — he is
 * typing an answer — and nothing asked again: the sweep's gap pass reads «a
 * run exists» and goes on. So when that draft leaves the chat by a newer
 * message or an edit (`chatMoved` on ✅) or his ❌, the newest live inbound —
 * the anchor itself while the EDITED line is still the newest — is queued
 * once more as HIS press (origin `redraft`, never the sweep's: the late note
 * and the `[agent] inbound` line name who asked), at attempt 0 when nothing
 * ever asked the line (the live hook's job, if it is starting right now,
 * meets this one at the inbound UNIQUE and one of them stands down as a
 * duplicate) and otherwise at the press's own attempt band (queues
 * `nextRedraftAttempt`) — never attempt 1, the sweep's one retry of a first
 * look, or a redraft that errored would never be tried again.
 *
 * `coming` is what the press may promise; `none` is said to him as
 * «o‘zingiz javob bering», so it must be as true (review):
 *  - a run of the line still in flight, or a card of it still up, is the card;
 *  - a job for the line still WAITING its turn, or just picked up and not yet
 *    reserved, is the card (jobs `inboundJobsComing`): the listener's edit job
 *    sits 12 s out, longer behind a busy worker, and the live hook's on its
 *    debounce. The jobs are read BEFORE the runs, so a job moving from the
 *    queue into its run between the two reads is seen by one of them;
 *  - an errored ask the sweep will retry is the card (`isFirstAsk`, its window);
 *  - otherwise the line is judged by its NEWEST ask, never by every run of it
 *    (review: a first look that errored and the sweep's retry that then stood
 *    down for his ✏️ — the old error kept the line from ever being asked
 *    again): asked again when that ask stood down for his edit, or drafted a
 *    card this very draft superseded (the hand-back that landed after it);
 *    `answered` when its card is approved AND that reply went or is still
 *    going (`OUTBOX_GOING`); `none` for a refusal, a cap, a «no reply
 *    needed», a notice, a card he rejected or let expire, an approved reply
 *    he cancelled or that failed or expired (it reached nobody — like a card
 *    he rejected, it is that ask's answer), an error past its retry — that
 *    ask's own answer, nothing comes;
 *  - a card only a run that has not RESERVED yet can write — a waiting job,
 *    the sweep's retry, the press's own queueing — is promised only while the
 *    chat is under the reservation's caps, read as the reservation reads them
 *    (today `capReached`): over one, that run is refused `capped`, and the
 *    day's one cap notice has usually been spent already (review). `capped`,
 *    and nothing is queued.
 * Which runs answer the line: for an edited anchor only those since the draft
 * (the draft's own run answered the text before the edit); for a newer
 * message EVERY run of it, whenever it began — a hand-back draft is written
 * on its own worker and can land while the newer message's run is still in
 * its model call, and asking that line again paid the model twice (review).
 */
async function redraftNewest(d: typeof agentDrafts.$inferSelect, how: 'newer' | 'edited'): Promise<RedraftAnswer> {
  // The sweep's own gate: with no model a queued run writes nothing, and the press must not promise a card.
  const config = await readAgentConfig();
  if (!agentRunning(config) || config.ownerUserId !== d.managerUserId || !aiConfigured()) return { line: how, next: 'none' };
  const [newest] = await db
    .select({ tgMessageId: tgMessages.tgMessageId })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(
      and(
        eq(tgMessages.managerUserId, d.managerUserId),
        eq(tgMessages.peerId, d.peerId),
        eq(tgMessages.direction, 'in'),
        how === 'edited' ? gte(tgMessages.tgMessageId, d.anchorTgMessageId) : gt(tgMessages.tgMessageId, d.anchorTgMessageId),
        isNull(tgMessageFlags.deletedAt),
      ),
    )
    .orderBy(desc(tgMessages.tgMessageId))
    .limit(1);
  if (!newest) return { line: how, next: 'none' };
  // Past the edited line a newer message is the one to answer — asked about as a newer message.
  const edited = how === 'edited' && newest.tgMessageId === d.anchorTgMessageId;
  const line: RedraftAnswer['line'] = edited ? 'edited' : 'newer';
  // The queue first, then the ledger: a job that leaves the one for the other between the reads is in one of them.
  const { ERRORED_RETRY_WINDOW_MS, inboundJobsComing } = await import('./jobs');
  const jobs = await inboundJobsComing(d.managerUserId, edited ? d.createdAt : new Date(0));
  const runs = await db
    .select({ id: agentRuns.id, attempt: agentRuns.attempt, outcome: agentRuns.outcome, error: agentRuns.error, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.managerUserId, d.managerUserId),
        eq(agentRuns.peerId, d.peerId),
        eq(agentRuns.trigger, 'inbound'),
        eq(agentRuns.anchorTgMessageId, newest.tgMessageId),
      ),
    );
  const answering = edited ? runs.filter((r) => r.createdAt.getTime() >= d.createdAt.getTime()) : runs;
  if (answering.some((r) => r.outcome === 'reserved')) return { line, next: 'coming' };
  const drafted = answering.filter((r) => r.outcome === 'draft').map((r) => r.id);
  const cards = drafted.length
    ? await db
        .select({ runId: agentDrafts.runId, status: agentDrafts.status, sendStatus: agentOutbox.status })
        .from(agentDrafts)
        .leftJoin(agentOutbox, eq(agentOutbox.draftId, agentDrafts.id))
        .where(inArray(agentDrafts.runId, drafted))
    : [];
  if (cards.some((c) => c.status === 'pending' || c.status === 'editing')) return { line, next: 'coming' };
  // Every card below is a run that has not reserved yet: promised only under the caps that run meets.
  const day = await dayRunCounts(tashkentDayStart(tashkentDay(new Date())).toISOString(), { managerUserId: d.managerUserId, peerId: d.peerId });
  const coming: RedraftAnswer['next'] = capReached(day, config) ? 'capped' : 'coming';
  if (jobs.has(`${d.peerId}:${newest.tgMessageId}`)) return { line, next: coming };
  // The sweep retries an errored ask that nothing asked after (jobs `agentSweep` step 4).
  const top = Math.max(-1, ...runs.map((r) => r.attempt));
  const retrying = (r: (typeof runs)[number]) =>
    r.outcome === 'error' && isFirstAsk(r.attempt) && r.attempt === top && Date.now() - r.createdAt.getTime() < ERRORED_RETRY_WINDOW_MS;
  if (answering.some(retrying)) return { line, next: coming };
  // The line's newest ask — by when it was asked; an edit's 100 + n can be older than a press's 50.
  const last = [...answering].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.attempt - y.attempt).at(-1);
  if (last) {
    const card = last.outcome === 'draft' ? cards.find((c) => c.runId === last.id) : undefined;
    if (card?.status === 'approved' && (OUTBOX_GOING as readonly (string | null)[]).includes(card.sendStatus)) return { line, next: 'answered' };
    const askAgain = (last.outcome === 'stood_down' && last.error === 'editing') || card?.status === 'superseded';
    if (!askAgain) return { line, next: 'none' };
  } else if (edited) {
    return { line, next: 'none' };
  }
  const attempt = runs.length === 0 ? 0 : nextRedraftAttempt(runs.map((r) => r.attempt));
  if (attempt === null) return { line, next: 'none' };
  if (coming === 'capped') return { line, next: 'capped' };
  const job: AgentInboundJob = {
    managerUserId: d.managerUserId,
    peerId: String(d.peerId),
    anchorTgMessageId: String(newest.tgMessageId),
    attempt,
    origin: 'redraft',
  };
  await enqueue(JOB_AGENT_INBOUND, job, { retryLimit: 0, startAfter: 1 });
  return { line, next: 'coming' };
}

/**
 * A ✅'s `superseded` refusal, from what `redraftNewest` found: the press's
 * `detail` (the bot's toast, the page's label — bot-door `SUPERSEDED_WORDS`,
 * web-actions) and the card's `policy.stale` (card-io STALE_WORDS) — one
 * table, so the three say one thing. A newer message with a card coming
 * keeps the card's ordinary «↪️ Mijoz yana yozdi — yangi qoralama».
 */
export type SupersededDetail = 'redrafting' | 'no_draft' | 'capped' | 'edited_redrafting' | 'edited_no_draft' | 'edited_capped' | 'answered';
const SUPERSEDED_AS: Record<RedraftAnswer['line'], Record<RedraftAnswer['next'], { detail: SupersededDetail; stale: SupersededStale | null }>> = {
  newer: {
    coming: { detail: 'redrafting', stale: null },
    none: { detail: 'no_draft', stale: 'no_redraft' },
    capped: { detail: 'capped', stale: 'capped' },
    answered: { detail: 'answered', stale: 'answered' },
  },
  edited: {
    coming: { detail: 'edited_redrafting', stale: 'edited' },
    none: { detail: 'edited_no_draft', stale: 'edited_no_redraft' },
    capped: { detail: 'edited_capped', stale: 'edited_capped' },
    answered: { detail: 'answered', stale: 'answered' },
  },
};

/** `redraftNewest`, never a reason for the press itself to fail. */
async function redraftQuietly(d: typeof agentDrafts.$inferSelect, how: 'newer' | 'edited'): Promise<RedraftAnswer> {
  try {
    return await redraftNewest(d, how);
  } catch (err) {
    logger.warn({ err, draftId: d.id }, '[agent] newer message not asked again');
    return { line: how, next: 'none' };
  }
}

/** A claim older than this is a press that died mid-landing (a deploy, a kill), and the next ✅ takes it over. */
export const LANDING_STALE_MS = 2 * 60_000;

/**
 * The landing's claim (ident fix F12): `action_error` holds `LANDING_CLAIM`
 * while one press lands the job. Two ✅ a second apart — the bot and the
 * page, or a press redelivered — used to land it TWICE once K26 made a
 * standing note re-askable: the second press found the first one's note with
 * no request yet and opened a request of its own on it. A unique index on
 * the request's note cannot say this — a recalculation copies its note on
 * purpose (workspace `recalcFromSealed`) — so the claim is the draft's own
 * row, a compare-and-set like every other claim here.
 */
async function claimLanding(draftId: string): Promise<boolean> {
  const [row] = await db
    .update(agentDrafts)
    .set({ actionError: LANDING_CLAIM, updatedAt: new Date() })
    .where(
      and(
        eq(agentDrafts.id, draftId),
        or(sql`${agentDrafts.actionError} IS DISTINCT FROM ${LANDING_CLAIM}`, lt(agentDrafts.updatedAt, new Date(Date.now() - LANDING_STALE_MS))),
      ),
    )
    .returning({ id: agentDrafts.id });
  return row !== undefined;
}

/**
 * The calculation, landed (or found already landed) — through the bot's own
 * door, `landIntake`, so the job reaches the same queue, the same AI VED
 * pre-pass and the same stage move as one a seller collected. A landing is
 * claimed first (`claimLanding`); a press that finds another one landing is
 * told `in_flight` and writes nothing — the claim is released by whatever
 * that press writes next (the approval, or the refusal).
 */
async function landCalc(
  d: typeof agentDrafts.$inferSelect,
  action: Extract<ComposedAction, { type: 'calc_submit' }>,
  actor: DeciderActor,
): Promise<{ queued: boolean; requestId: string | null; queueError: string | null }> {
  const noteId = noteIdFor(d.id);
  const { intakeNoteExists } = await import('./calc-note');
  if (await intakeNoteExists(noteId)) {
    const [req] = await db.select({ id: calcRequests.id }).from(calcRequests).where(eq(calcRequests.noteId, noteId));
    if (req) return { queued: true, requestId: req.id, queueError: null };
    // The note landed and the QUEUE refused (final review K26): a server
    // mid-deploy. `landIntake` writes the note and moves the stage before it
    // asks the queue, so this ✅ is the job asked again — never «already
    // landed» for ever over a job no VED will ever see.
    if (!(await claimLanding(d.id))) return { queued: false, requestId: null, queueError: 'in_flight' };
    return requeueLanded(noteId, action, actor);
  }
  if (!(await claimLanding(d.id))) return { queued: false, requestId: null, queueError: 'in_flight' };
  const identity = await chatIdentity(d.managerUserId, d.peerId);
  const cited = action.citedMessageIds.length
    ? await db
        .select({ body: tgMessages.body, sentAt: tgMessages.sentAt, hasMedia: tgMessages.hasMedia })
        .from(tgMessages)
        .where(
          and(
            eq(tgMessages.managerUserId, d.managerUserId),
            eq(tgMessages.peerId, d.peerId),
            eq(tgMessages.direction, 'in'),
            inArray(tgMessages.id, action.citedMessageIds),
          ),
        )
        .orderBy(tgMessages.sentAt)
    : [];
  const files = cited.filter((m) => m.hasMedia).length;
  // Each cited line carries its Tashkent date (#1627): the model reads a hundred messages and may cite one from an
  // earlier shipment beside today's — the VED must see which is which, the job's own figures being the checklist's.
  const dated = (m: { body: string | null; sentAt: Date }) => {
    const [y, mo, d] = tashkentDay(m.sentAt).split('-');
    return `${d}.${mo}.${y}: ${m.body ?? ''}`;
  };
  const material = [
    ...cited.filter((m) => (m.body ?? '').trim() !== '').map(dated),
    ...(files > 0 ? [`(Chatda ${files} ta fayl/rasm bor — Telegram suhbatida.)`] : []),
  ];
  const [me] = await db.select({ name: users.fullName }).from(users).where(eq(users.id, actor.id));
  const client = identity.clientId
    ? { id: identity.clientId, clientCode: identity.codes[0]?.clientCode ?? '', name: identity.customerName ?? '' }
    : null;
  let lead: { id: string; name: string; ownerId: string | null } | null = null;
  if (!client && identity.leadId) {
    const [l] = await db.select({ id: leads.id, name: leads.name, ownerId: leads.ownerId }).from(leads).where(eq(leads.id, identity.leadId));
    lead = l ?? null;
  }
  const { landIntake } = await import('../calc/intake-land');
  const { CalcError } = await import('../calc/service');
  // The landing refuses BEFORE it writes a card or a note when the sender has
  // twenty requests open (docs/UCH-BAND.md: a coded client gets a new deal per
  // request, and a refused mint must leave no empty deal behind). That is the
  // queue's own refusal, for the card to say in words; with no note written,
  // the next ✅ lands the job afresh (K26).
  const target = await landIntake({
    noteId,
    section: action.section,
    facts: action.facts,
    steps: [
      "AI sotuvchi mijozning Telegram suhbatidan yig'di, egasi tasdiqladi.",
      // His 9 (2026-10-24): «kelib chiqish sertifikati bor, biz o'zimiz olamiz».
      "Kelib chiqish sertifikati: kompaniya o'zi oladi",
      // His third set «3»: cargo from China or a place we have no warehouse in is priced from ours —
      // the VED reads what the customer was told. `=== true`: an action stored before it carries none.
      ...(action.fromOurWarehouse === true ? ['Narx Xitoydagi omborimizdan; zavoddan omborgacha olib kelish alohida.'] : []),
    ],
    fileCount: 0,
    material,
    collectedBy: actor.id,
    collectedByName: me?.name ?? '',
    client,
    lead,
    leadName: identity.customerName ?? 'Telegram',
    leadPhone: null,
    // Every agent job carries the company's certificate (his 9) — never the
    // customer's answer, which the AI no longer asks for.
    hasCertificate: true,
    freightZone: freightZoneOf(action),
    // No bot door (docs/IKKI-ESHIK.md §0.1): the agent's job keeps today's
    // behaviour — its estimate still announced to the owner (his Q5 ⭐ c).
    intakeDoor: null,
  }).catch((err: unknown) => {
    if (err instanceof CalcError) return { refused: err.code } as const;
    throw err;
  });
  if ('refused' in target) return { queued: false, requestId: null, queueError: target.refused };
  return { queued: target.queued === true && Boolean(target.requestId), requestId: target.requestId ?? null, queueError: target.queueError ?? null };
}

/**
 * The zone the bot's own buttons would choose for the place the customer
 * named (Kashgar → kashgar, Horgos → horgos, Yiwu/Guangzhou → cn), or none —
 * the VED chooses; never «cn» by default (review A11). Cargo priced from our
 * China warehouses IS the China column (his third set «3»). One home for the
 * landing and its re-ask.
 */
function freightZoneOf(action: Extract<ComposedAction, { type: 'calc_submit' }>): string | null {
  if (action.section !== 'podklyuch') return null;
  return action.fromOurWarehouse === true ? 'cn' : zoneForOrigin(action.facts.fromCity ?? null);
}

/**
 * The queue asked again for a landing whose note already stands (K26) — on
 * the card that note sits on, with the request `landIntake` would have
 * opened: the same facts through the same `landingItems`, the company's
 * certificate, the same zone; and the AI VED hodimi handed the job the same
 * way. The note and the stage move are not repeated: they happened. A
 * refusal comes back as the queue's own code, for the card to say in words.
 */
async function requeueLanded(
  noteId: string,
  action: Extract<ComposedAction, { type: 'calc_submit' }>,
  actor: DeciderActor,
): Promise<{ queued: boolean; requestId: string | null; queueError: string | null }> {
  const [note] = await db
    .select({ entityType: crmActivities.entityType, entityId: crmActivities.entityId })
    .from(crmActivities)
    .where(eq(crmActivities.id, noteId));
  if (!note || (note.entityType !== 'deal' && note.entityType !== 'lead')) return { queued: false, requestId: null, queueError: 'not_found' };
  const { CalcError, openCalcRequest } = await import('../calc/service');
  try {
    const { landingItems } = await import('../calc/intake');
    const items = landingItems(action.facts);
    const opened = await openCalcRequest(
      {
        entityType: note.entityType,
        entityId: note.entityId,
        section: action.section,
        fromCity: action.facts.fromCity ?? null,
        toCity: action.facts.toCity ?? null,
        weightKg: action.facts.weightKg ?? null,
        volumeM3: action.facts.volumeM3 ?? null,
        items,
        noteId,
        source: 'bot',
        // The landing's own door, null (docs/IKKI-ESHIK.md §0.1): the re-queue
        // opens the request `landIntake` would have — today's behaviour.
        intakeDoor: null,
        hasMaterials: false,
        hasCertificate: true,
        freightZone: freightZoneOf(action),
      },
      { actorId: actor.id },
    );
    // The landing's own zero-item rule (docs/FAYL-OQISH.md §1.3 c,
    // door-break-4): a rastamojka with no goods owes no pass, here as in both
    // of `landIntake`'s queue calls — the re-queue is the agent's second path
    // to the same request, and it called the pass unguarded.
    const { landingOwesPass } = await import('../calc/intake-land');
    if (landingOwesPass(action.section, items.length)) {
      const { queueCalcPrefill } = await import('../calc/prefill-queue');
      await queueCalcPrefill({ requestId: opened.id, staffId: actor.id, section: action.section });
    }
    return { queued: true, requestId: opened.id, queueError: null };
  } catch (err) {
    logger.error({ err, noteId }, '[agent] calc re-queue failed');
    return { queued: false, requestId: null, queueError: err instanceof CalcError ? err.code : 'server_behind' };
  }
}

/**
 * 🙋 «Suhbat meniki» in the caller's transaction: the chat is his for
 * `HUMAN_TAKEOVER_HOURS`, and the replies he approved BEFORE it that are still
 * waiting are withdrawn (final review K2) — night-held to 08:30, a flood, a
 * cap: sent later, they would speak into the chat he has just taken over. By
 * `agent_off`'s compare-and-set on 'agent' (withdrawTypedBind's): the send step
 * claims by that status, so a row already claimed is the one in flight — and
 * its next step reads the press (`human_until`, approved before it: send-step
 * `approvedBeforePress`) and stands down. A reply he approves AFTER the press
 * is his newer word and goes. His own words go with the machine's — the send
 * step cannot tell them apart and must not — so the press SAYS how many it
 * took (F10). ONE body for 🙋 on a live card and on a card the machine already
 * approved (fix pass A, C3).
 *
 * The press is about the CHAT, so the chat's live reply is his too (fix pass
 * C, FIX-SEND-1): retired as his 🙋 on its own card would retire it
 * (`taken_over`, decided by him — the press the send step dates a later ✅
 * by, outbox-store `human_pressed_ms`), and its countdown stopped as his
 * (`owner_human`), FIRST — a machine press in flight on it then loses inside
 * its approval (the draft's own compare-and-set, the verdict's), and one that
 * committed while this waited on the draft is a queued reply the withdrawal
 * below reads afresh and takes back. The draft before its verdict, as the
 * machine's approval locks them. On a live card the decided draft IS the
 * chat's live reply (one per chat, 0138's `agent_drafts_live_unique`), already
 * retired by the caller: nothing more is written. `autoReady` is asked BEFORE
 * the transaction — a statement on a missing table would abort it.
 */
async function takeChatInTx(
  tx: Tx,
  d: typeof agentDrafts.$inferSelect,
  actorId: string,
  autoReady: boolean,
): Promise<{ held: string[]; own: number; retired: string[] }> {
  const now = new Date();
  const until = new Date(Date.now() + HUMAN_TAKEOVER_HOURS * 3_600_000);
  const retired = (
    await tx
      .update(agentDrafts)
      .set({ status: 'taken_over', decidedBy: actorId, decidedAt: now, updatedAt: now })
      .where(and(eq(agentDrafts.managerUserId, d.managerUserId), eq(agentDrafts.peerId, d.peerId), inArray(agentDrafts.status, ['pending', 'editing'])))
      .returning({ id: agentDrafts.id })
  ).map((r) => r.id);
  if (autoReady && retired.length > 0) {
    await tx
      .update(agentAutoVerdicts)
      .set({ state: 'stopped', outcome: 'owner_human', stoppedAt: now, stoppedBy: actorId })
      .where(and(inArray(agentAutoVerdicts.draftId, retired), inArray(agentAutoVerdicts.state, ['waiting', 'pressing'])));
  }
  await tx
    .insert(agentConversations)
    .values({ managerUserId: d.managerUserId, peerId: d.peerId, humanUntil: until })
    .onConflictDoUpdate({
      target: [agentConversations.managerUserId, agentConversations.peerId],
      set: { humanUntil: until, updatedAt: now },
    });
  const cancelled = await tx
    .update(agentOutbox)
    .set({ status: 'cancelled', lastError: 'taken_over: 🙋 he took the chat over for 24 hours' })
    .where(and(eq(agentOutbox.managerUserId, d.managerUserId), eq(agentOutbox.peerId, d.peerId), eq(agentOutbox.status, 'agent')))
    .returning({ draftId: agentOutbox.draftId });
  const held = cancelled.map((o) => o.draftId);
  let own = 0;
  if (held.length > 0) {
    const mine = await tx
      .select({ id: agentDrafts.id })
      .from(agentDrafts)
      .where(and(inArray(agentDrafts.id, held), or(isNotNull(agentDrafts.finalBody), eq(agentDrafts.kind, 'price'))));
    own = mine.length;
  }
  return { held, own, retired };
}

/** The machine's press lost inside its approval transaction — thrown to roll the approval back. */
class AutoPressLost extends Error {
  constructor(public readonly code: AutoPressLoss) {
    super(code);
  }
}

/**
 * A PERSON's press on a card whose reply the MACHINE approved (fix pass A, C3)
 * — a card still drawn with its countdown buttons (the page is not refreshed,
 * the bot's edit did not land) or the pressed card's own ❌ and 🙋. Null when the
 * machine did not approve it: the press answers as it always did.
 *  - 🙋: the chat is his — the takeover written and the chat's waiting replies
 *    withdrawn in one transaction, as on a live card — and the press says
 *    whether the machine's reply was among them or already on its way;
 *  - ❌: that reply taken back, by the web cancel's own compare-and-set (still
 *    'agent' and not yet read), audited; too late — «kech», in words;
 *  - ✅, ✏️: «kech», naming ❌ «Bekor qilish» while it can still be taken back.
 */
async function afterMachinePress(
  d: typeof agentDrafts.$inferSelect,
  decision: DraftDecision,
  actorId: string,
  ctx: AuditContext,
): Promise<DecideResult | null> {
  const pressed = await machinePressedReply(d.id);
  if (!pressed) return null;
  const o = pressed.outbox;
  const place = afterPressOf(o);
  const kech = (p: NonNullable<typeof place>): DecideResult => ({ ok: false, code: p === 'pressed' ? 'auto_pressed' : p === 'sending' ? 'auto_sending' : 'auto_sent' });
  if (decision === 'send' || decision === 'edit') return place ? kech(place) : { ok: false, code: 'not_live', detail: d.status };
  if (decision === 'reject') {
    if (!o || place !== 'pressed') return place ? kech(place) : { ok: false, code: 'not_live', detail: d.status };
    const taken = await db.transaction(async (tx) => {
      const [hit] = await tx
        .update(agentOutbox)
        .set({ status: 'cancelled', lastError: CANCELLED_BY_HOLDER })
        .where(and(eq(agentOutbox.id, o.id), eq(agentOutbox.status, 'agent'), eq(agentOutbox.readDone, false)))
        .returning({ id: agentOutbox.id });
      if (!hit) return false;
      await writeAudit(tx, ctx, {
        entityType: 'agent_outbox',
        entityId: o.id,
        action: 'status_change',
        before: { status: 'agent' },
        after: { status: 'cancelled', draftId: d.id, via: AFTER_AUTO },
      });
      return true;
    });
    if (!taken) {
      // The listener took it between the read and the cancel: say where it is now.
      const again = await machinePressedReply(d.id);
      const now = afterPressOf(again?.outbox ?? null);
      return now && now !== 'pressed' ? kech(now) : { ok: false, code: 'not_live', detail: d.status };
    }
    await refreshDraftCard(d.id);
    return { ok: true, status: 'cancelled' };
  }
  // 🙋 — the chat is his whatever became of the reply: the takeover is about the chat, not the card. Its audit row
  // is the press's record (fix pass C, FIX-SEND-1): no draft of the chat becomes his `taken_over` when none is
  // live, and the send step dates a ✅ he gives after the press by this row (outbox-store `human_pressed_ms`).
  const autoReady = await agentAutoReady();
  const changed = await db.transaction(async (tx) => {
    const out = await takeChatInTx(tx, d, actorId, autoReady);
    await writeAudit(tx, ctx, {
      entityType: 'agent_draft',
      entityId: d.id,
      action: 'update',
      before: { status: d.status },
      after: {
        takenOver: true,
        via: AFTER_AUTO,
        ...(out.held.length > 0 ? { cancelledWaiting: out.held.length } : {}),
        ...(out.retired.length > 0 ? { retiredLive: out.retired.length } : {}),
      },
    });
    return out;
  });
  await refreshDraftCard(d.id);
  for (const id of new Set([...changed.held, ...changed.retired])) if (id !== d.id) await refreshDraftCard(id);
  const gone = changed.held.includes(d.id) ? null : place === 'sending' || place === 'sent' ? place : null;
  return {
    ok: true,
    status: d.status,
    withdrawn: { total: changed.held.length, own: changed.own },
    ...(gone ? { autoReply: gone } : {}),
  };
}

/**
 * The moment his ✅ vouches for the China column (spec SPEC-P1-v2 §1.6): the draft quoted a TRUCK figure (the column
 * prices only the truck — the flight is his rate) that was priced again at this press and stands, and 0148 has
 * landed. The run's own start: the figure was priced on the column as it stood then, and a write during the run
 * must stay unconfirmed. null: nothing to vouch for.
 */
async function tariffVouchOf(d: Pick<typeof agentDrafts.$inferSelect, 'runId'>, estimates: unknown): Promise<Date | null> {
  if (!Array.isArray(estimates) || !estimates.some((e) => (e as { tool?: unknown })?.tool === 'yolkira_estimate')) return null;
  if (!d.runId || !(await agentFullP1Ready())) return null;
  const [run] = await db.select({ createdAt: agentRuns.createdAt }).from(agentRuns).where(eq(agentRuns.id, d.runId));
  return run?.createdAt ?? null;
}

/**
 * `auto`: «o'zi yuborish»'s machine press (§18.3, auto-send `pressDueAutos`) —
 * the same ✅, stricter: only 'send', only a strictly 'pending' machine reply
 * (never 'editing', never his words, never a price), only with the digest the
 * verdict was scheduled on, and refused on ANY warning of the fresh policy
 * re-run. Its approval's audit row says `via: 'auto'`; `decided_by` is the
 * holder the press speaks for. Every other call is a PERSON on the card, and
 * stops the draft's waiting auto first (`stopAutoForPerson`).
 */
export async function decideDraft(
  actor: DeciderActor,
  draftId: string,
  decision: DraftDecision,
  opts: {
    digest?: string | null;
    auto?: boolean;
    /** The machine's press: its moment, stamped as the verdict's `pressed_at` (the sweep's own clock). */
    autoAt?: Date;
  },
  ctx: AuditContext,
): Promise<DecideResult> {
  const [read] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!read) return { ok: false, code: 'not_found' };
  if (read.managerUserId !== actor.id) return { ok: false, code: 'not_account_holder' };
  // His own press on the card is his decision: the machine's waiting press stands down before anything else
  // (a row already being pressed is the draft's compare-and-set's to decide). A stop that found nothing to stop
  // may have lost to the machine's own ✅ committing between the read above and the stop (fix pass C,
  // FIX-SEND-2): the card is read again, so a reply the machine approved a moment ago is answered as one —
  // «kech», ❌ takes it back, 🙋 takes the chat — and never «faol emas» while it goes.
  const stopped = opts.auto ? false : await stopAutoForPerson(draftId, actor.id, `owner_${decision}`);
  const [d] =
    !opts.auto && !stopped && (read.status === 'pending' || read.status === 'editing')
      ? await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId))
      : [read];
  if (!d) return { ok: false, code: 'not_found' };
  const config = await readAgentConfig();
  if (decision !== 'reject' && decision !== 'human' && (!agentRunning(config) || config.ownerUserId !== d.managerUserId)) {
    return { ok: false, code: 'agent_off' };
  }
  // A reply the MACHINE approved (fix pass A, C3): his 🙋 and ❌ still mean something, and ✅/✏️ say «kech».
  if (!opts.auto && d.status === 'approved') {
    const after = await afterMachinePress(d, decision, actor.id, ctx);
    if (after) return after;
  }
  if (d.status !== 'pending' && d.status !== 'editing') return { ok: false, code: 'not_live', detail: d.status };
  // The machine presses a pending machine reply and nothing else: never a draft he opened ✏️ on, never his words.
  if (opts.auto && (decision !== 'send' || d.status !== 'pending' || d.finalBody !== null || d.kind !== 'reply')) {
    return { ok: false, code: 'not_live', detail: d.status };
  }
  if (opts.auto && !opts.digest) return { ok: false, code: 'stale_card' };

  if (decision === 'reject' || decision === 'human' || decision === 'edit') {
    const status = decision === 'reject' ? 'rejected' : decision === 'human' ? 'taken_over' : 'editing';
    const autoReady = decision === 'human' && (await agentAutoReady());
    const changed = await db.transaction(async (tx): Promise<{ held: string[]; own: number } | null> => {
      const [row] = await tx
        .update(agentDrafts)
        .set({
          status,
          updatedAt: new Date(),
          // ✏️ ends a ✍️ on the same draft (spec SPEC-P1-v2 §2.2): his own words now, never the AI's from his answer —
          // a redraft still on its way finds no `answering` and writes nothing (drafts `createDraft`).
          // …and a lesson's rewrite still on its way (§3.4) finds no mark either: ✏️ means his own words.
          ...(decision === 'edit'
            ? { policy: sql`coalesce(${agentDrafts.policy}, '{}'::jsonb) - 'answering' - 'lessonRedraft'` }
            : { decidedBy: actor.id, decidedAt: new Date() }),
        })
        .where(and(eq(agentDrafts.id, draftId), inArray(agentDrafts.status, ['pending', 'editing'])))
        .returning({ id: agentDrafts.id });
      if (!row) return null;
      // 🙋 «the chat is mine for 24 h» — and the replies still waiting in it withdrawn (`takeChatInTx`).
      const { held, own } = decision === 'human' ? await takeChatInTx(tx, d, actor.id, autoReady) : { held: [] as string[], own: 0 };
      if (decision !== 'edit') {
        await writeAudit(tx, ctx, {
          entityType: 'agent_draft',
          entityId: draftId,
          action: 'status_change',
          before: { status: d.status },
          after: { status, ...(held.length > 0 ? { cancelledWaiting: held.length } : {}) },
        });
      }
      return { held, own };
    });
    if (!changed) return { ok: false, code: 'not_live' };
    await refreshDraftCard(draftId);
    // Each cancelled reply's own card says it will not go (card-io's CANCEL_WORDS `taken_over`).
    for (const held of changed.held) await refreshDraftCard(held);
    // ❌: a line that stood down for his ✏️ on this draft (or whose card this draft superseded) is asked
    // again — the customer's EDITED line itself when he edited it after the draft (`editedSince`,
    // chatMoved's own test), else a newer message; `redraftNewest('edited')` moves on to a newer message
    // when there is one. Whatever the draft's status NOW (review): ✏️ ends on 'pending' once he types his
    // words (`submitOwnText`) or opens another draft (bot-door `releaseEdit`), and the line that stood
    // down while it was open is still drafted by nobody. The ledger decides, as on ✅ — a draft nothing
    // stood down for asks nothing (a line still in its run, or one its run answered, is that run's).
    if (decision === 'reject') await redraftQuietly(d, (await anchorEditedNow(d)) ? 'edited' : 'newer');
    return { ok: true, status, ...(decision === 'human' ? { withdrawn: { total: changed.held.length, own: changed.own } } : {}) };
  }

  // ✅ — on an `editing` draft too, while he has written nothing for it (2026-10-29): ✏️ pressed and
  // thought better of is the machine's text exactly as if ✏️ had not been pressed — the same digest,
  // the same policy, the same CAS below on the status read here. His own words, once typed, are
  // the body; a second ✏️ over them means he is changing them, and ✅ waits for the new ones.
  if (d.status === 'editing' && d.finalBody !== null) return { ok: false, code: 'editing' };
  const body = (d.finalBody ?? d.proposedBody ?? '').trim();
  if (!body) return { ok: false, code: 'empty' };
  const actions = (d.actions ?? []) as ComposedAction[];
  if (opts.digest !== undefined && opts.digest !== cardDigest(body, actions)) return { ok: false, code: 'stale_card' };

  // The CRM's own send switch stops the pump too (send-step `sending_disabled`
  // is FINAL), so an approval made while it is off would only be cancelled a
  // minute later. Said here, before anything is queued.
  if ((await getSetting('tg_sending_enabled')) !== true) return { ok: false, code: 'sending_disabled' };
  const [acc] = await db.select({ id: tgAccounts.id }).from(tgAccounts).where(eq(tgAccounts.managerUserId, d.managerUserId));
  const guard = acc ? await readGuard(acc.id) : null;
  const now = new Date();
  // A fresh pump AND a finished catch-up (review S11): a listener whose start-up walk failed would hold the
  // row on `not_caught_up` until the six-hour expiry — refused here, in words, instead.
  if (!listenerIsCurrent(guard, now)) {
    return { ok: false, code: 'listener_behind' };
  }

  const p = (d.policy ?? {}) as Partial<DraftPolicyJson>;
  // His own words — typed, or the offer text made from his typed price — pass
  // the owner subset; the machine's pass the whole policy again.
  const policy = d.finalBody || d.kind === 'price'
    ? // The press asks only the blocks; the same-text warning was on the card he pressed.
      await ownerPolicyFor(body, p.memory?.ownCodes ?? [], null)
    : p.memory
      ? await policyFor({
          managerUserId: d.managerUserId,
          peerId: d.peerId,
          body,
          memory: p.memory,
          strip: p.card?.customerLabel ? p.card.customerLabel.split(/[\s,·]+/u) : [],
        })
      : null;
  if (!policy || !policy.ok) {
    // A machine draft with no stored memory (a legacy or hand-made row) cannot be checked again,
    // so it cannot go — written as a block like any other, so the card loses its ✅ and SAYS why,
    // instead of a button that answers «policy» to every press and shows nothing.
    const blocks: PolicyHit[] = policy ? policy.blocks : [{ rule: 'G1', code: 'memory_missing' }];
    await db
      .update(agentDrafts)
      .set({ blocked: true, policy: { ...p, blocks, ...(policy ? { ledger: policy.ledger } : {}) }, updatedAt: new Date() })
      .where(eq(agentDrafts.id, draftId));
    await refreshDraftCard(draftId);
    return { ok: false, code: 'policy_block', detail: blocks.map((b) => b.code).join(',') };
  }
  // A person presses past a warning he has read on the card; the machine never does — and writes nothing.
  if (opts.auto && policy.warnings.length > 0) {
    return { ok: false, code: 'auto_warning', detail: policy.warnings.map((w) => w.code).join(',') };
  }

  const moved = await chatMoved(d);
  if (moved) {
    const status = moved === 'taken_over' ? 'taken_over' : 'superseded';
    const [retired] = await db
      .update(agentDrafts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.status, d.status)))
      .returning({ id: agentDrafts.id });
    if (moved === 'taken_over') {
      await refreshDraftCard(draftId);
      return { ok: false, code: 'taken_over' };
    }
    // Another press moved the row first (review: two presses at once — the bot and the page, a press
    // redelivered): THAT press decided the draft and said what comes, so this one never looked for a
    // card and must not answer «o‘zingiz javob bering» beside the winner's redraft. The approval's own
    // lost compare-and-set below, verbatim: still live is a changed card (his words landed), else gone.
    if (!retired) {
      const [after] = await db.select({ status: agentDrafts.status }).from(agentDrafts).where(eq(agentDrafts.id, draftId));
      return { ok: false, code: after?.status === 'pending' || after?.status === 'editing' ? 'stale_card' : 'not_live' };
    }
    // «Yangi qoralama tayyorlanadi» only where one is coming (`redraftNewest`); otherwise the press AND
    // the card tell him to answer — and an edit is said as an edit (card-io STALE_WORDS).
    const line = moved === 'anchor_edited' ? 'edited' : 'newer';
    const found: RedraftAnswer = await redraftQuietly(d, line);
    const said = SUPERSEDED_AS[found.line][found.next];
    if (said.stale) {
      await db
        .update(agentDrafts)
        .set({ policy: sql`coalesce(${agentDrafts.policy}, '{}'::jsonb) || ${JSON.stringify({ stale: said.stale })}::jsonb` })
        .where(eq(agentDrafts.id, draftId));
    }
    await refreshDraftCard(draftId);
    return { ok: false, code: 'superseded', detail: said.detail };
  }

  // Whose chat it is NOW (final review K7). The draft was written for a client
  // or a lead, and the bind may have been taken back since — the web tray's
  // ↩, «Shaxsiy», another code: approving it would queue that customer's name
  // and codes, and land its calculation on that card, in a chat that is no
  // longer theirs. Asked of the server's own identity, the run's: a phone
  // sibling is the same person (fit-12), and a lead that was WON is still the
  // lead its draft was written for (`chatIdentity` keeps it, K25).
  if (await identityMoved(d)) {
    await db
      .update(agentDrafts)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(agentDrafts.id, draftId), inArray(agentDrafts.status, ['pending', 'editing'])));
    await refreshDraftCard(draftId, ["↩ Chat endi boshqa mijozga bog'langan (yoki bog'lanmagan) — bu javob ketmaydi."]);
    return { ok: false, code: 'identity_changed' };
  }
  // Which quiet hours this chat obeys (the merge review): an agent-sourced
  // lead's reply waits for the agent's playbook window, and one that would
  // reach it only after its question is a day old is refused here, before a
  // calculation is landed for a reply that cannot go.
  const chatWindow = await sendWindowFor(d);
  const sendAt = releaseAt(now, await lastInboundAt(d), chatWindow);
  if (chatWindow === 'agent_lead') {
    const asked = await anchorSentAt(d);
    if (asked && sendAt.getTime() - asked.getTime() > AGENT_LIMITS.anchorMaxAgeMs) return { ok: false, code: 'window_closed' };
  }
  // The machine's figures priced again at THIS press (spec §1.3) — his ✅ and the machine's alike, before anything
  // is landed or queued: asked at one end only, the door queued a reply the send step was certain to cancel (the
  // 💵 precedent). His own words (`finalBody`) are his own figure.
  const memory = p.memory;
  const standing = d.finalBody === null ? await estimatesStand(memory?.estimates, now) : null;
  if (standing === 'estimate_moved') return { ok: false, code: 'estimate_moved' };
  // A PERSON's ✅ on a truck figure priced on today's China column vouches for that column (§1.6
  // `tariff_unconfirmed`) — as of the moment its run began, so a tariff write during the run stays unconfirmed.
  const vouchesTariff = !opts.auto && standing === 'stands' ? await tariffVouchOf(d, memory?.estimates) : null;
  if ((await budgetLeft(d.managerUserId, config!.startedAt, now)) <= 0) return { ok: false, code: 'budget_spent' };

  // The calculation first — the reply promises it (regression-4).
  const calc = actions.find((a): a is Extract<ComposedAction, { type: 'calc_submit' }> => a.type === 'calc_submit');
  let requestId: string | null = null;
  if (calc) {
    const landed = await landCalc(d, calc, actor);
    // Another press is landing this very job: nothing is written here — its own outcome releases the claim (F12).
    if (landed.queueError === 'in_flight') return { ok: false, code: 'calc_in_flight' };
    if (!landed.queued || !landed.requestId) {
      await db
        .update(agentDrafts)
        .set({ actionStatus: 'failed', actionError: landed.queueError ?? 'not_queued', updatedAt: new Date() })
        .where(eq(agentDrafts.id, draftId));
      // The card says why, in words, for as long as it stands (card-io `statusLine`, `calcQueueWords`).
      await refreshDraftCard(draftId);
      return { ok: false, code: 'calc_not_queued', detail: landed.queueError ?? undefined };
    }
    requestId = landed.requestId;
  }

  // The approval — one transaction. The machine's press (fix pass A, C2/C5) takes the layer's row FOR SHARE
  // as its FIRST statement and requires it armed and the account a work number (`autoPressStandsInTx`), and
  // moves its verdict 'pressing' → 'pressed' as its LAST (`settleAutoPressInTx`): a ⏸, a person's own
  // decision, a disarm or «Shaxsiy raqam» that lands first makes it lose — thrown, so the whole approval
  // rolls back — and one that comes after finds the verdict 'pressed'. A person's press reads neither.
  const approved: boolean | AutoPressLoss = await db.transaction(async (tx) => {
    if (opts.auto) {
      const lost = await autoPressStandsInTx(tx, d.managerUserId);
      if (lost) throw new AutoPressLost(lost);
    }
    // The row as it is approved, locked, must still be the card he pressed: the status read at the
    // top (`editing` included, with no words of his) and the digest's own inputs — his words, the
    // machine's, the actions — exactly as the press checked them (review: a second text of his
    // landing between the read and here put the FIRST on the queue while the card, re-drawn from
    // the row, said the second was being sent). The words that go are the words that were pressed.
    const [held] = await tx
      .select({ status: agentDrafts.status, finalBody: agentDrafts.finalBody, proposedBody: agentDrafts.proposedBody, actions: agentDrafts.actions })
      .from(agentDrafts)
      .where(eq(agentDrafts.id, draftId))
      .for('update');
    if (!held || held.status !== d.status || held.finalBody !== d.finalBody || cardDigest(digestBody(held), held.actions as ComposedAction[]) !== cardDigest(body, actions)) {
      return false;
    }
    // The chat still the machine's to answer (the final check): his 🙋, read under the draft's lock — the
    // human path keeps a card in a chat he took waiting for him; the machine never presses it.
    if (opts.auto && (await autoChatTakenInTx(tx, d.managerUserId, d.peerId))) throw new AutoPressLost('taken_over');
    const [row] = await tx
      .update(agentDrafts)
      .set({
        status: 'approved',
        decidedBy: actor.id,
        decidedAt: now,
        updatedAt: now,
        // 'pending' while ANY action is on the draft — the calculation is
        // landed above, the follow-up and the mute run after the commit, and
        // only `runDraftActions` says 'done', when every one has (A10).
        ...(actions.length ? { actionStatus: 'pending', actionError: null } : {}),
      })
      .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.status, d.status)))
      .returning({ id: agentDrafts.id });
    if (!row) return false;
    await tx.insert(agentOutbox).values({
      draftId,
      managerUserId: d.managerUserId,
      peerId: d.peerId,
      clientId: d.clientId,
      leadId: d.clientId ? null : d.leadId,
      body,
      randomId: mintRandomId(),
      answersTgMessageId: d.anchorTgMessageId,
      queuedBy: actor.id,
      queuedAt: now,
      nextStepAt: sendAt,
      // The night held it (his Q14 ⭐): the approval's age counts from the morning it was promised for (S2).
      releaseAt: sendAt.getTime() > now.getTime() ? sendAt : null,
    });
    if (requestId) {
      await tx
        .insert(agentCalcLinks)
        .values({ requestId, rootRequestId: requestId, managerUserId: d.managerUserId, peerId: d.peerId, draftId })
        .onConflictDoNothing();
    }
    // HIS ✅ teaches the chat the language he approved, where it stores none (fix pass 8, the check #1 — locale
    // `approvedLocale`): a chat whose lines said no language held its every later «ok», «GS778», «👍» for ever, his
    // press on the first held reply notwithstanding. Never the machine's press, and never over what the chat stores
    // (`coalesce`) — nor over what the draft's own reading says the customer spoke.
    const taught = opts.auto ? null : approvedLocale({ reading: p.memory?.customerLocale, language: d.language, ownText: d.finalBody });
    if (taught) {
      await tx
        .insert(agentConversations)
        .values({ managerUserId: d.managerUserId, peerId: d.peerId, locale: taught })
        .onConflictDoUpdate({
          target: [agentConversations.managerUserId, agentConversations.peerId],
          // `${table}.column` — inside ON CONFLICT the bare name is the proposed row's too (#128's cousin).
          set: { locale: sql`coalesce(${agentConversations}.locale, ${taught})`, updatedAt: now },
        });
    }
    await writeAudit(tx, ctx, {
      entityType: 'agent_draft',
      entityId: draftId,
      action: 'status_change',
      before: { status: d.status },
      after: { status: 'approved', edited: d.finalBody !== null, sendAt: sendAt.toISOString(), requestId, ...(opts.auto ? { via: 'auto' } : {}) },
    });
    if (vouchesTariff) await confirmTariffInTx(tx, vouchesTariff, actor.id);
    if (opts.auto && !(await settleAutoPressInTx(tx, draftId, opts.autoAt ?? now))) throw new AutoPressLost('auto_stopped');
    return true;
  }).catch((err: unknown) => {
    if (err instanceof AutoPressLost) return err.code;
    throw err;
  });
  if (approved !== true && approved !== false) return { ok: false, code: approved };
  if (!approved) {
    // The row moved under the press — his own words landed on it between the read and here (the
    // lock's check above): the draft is live, the card is a different one, and «faol emas» is false —
    // «Karta o'zgargan — yangi kartadagi ✅ ni bosing», on the card his new words are on.
    const [after] = await db.select({ status: agentDrafts.status }).from(agentDrafts).where(eq(agentDrafts.id, draftId));
    return { ok: false, code: after?.status === 'pending' || after?.status === 'editing' ? 'stale_card' : 'not_live' };
  }
  await runDraftActions(draftId, actor).catch((err: unknown) => logger.error({ err, draftId }, '[agent] actions failed'));
  await refreshDraftCard(draftId);
  return { ok: true, status: 'approved', sendAt, requestId };
}

/**
 * EVERY action of an approved draft, after the commit and re-runnable
 * (build-6, A10): the calculation (landed before the approval — asked again
 * here, and `noteIdFor` makes that a read of the one already landed), a
 * follow-up through the CRM's own door under the approver, a mute on the
 * conversation. 'done' only when all of them have run; a replay — the
 * sweep's, after a crash between the commit and this — writes nothing twice.
 * The outcome is stored on the draft.
 */
export async function runDraftActions(draftId: string, actor: DeciderActor): Promise<void> {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d || d.actionStatus !== 'pending') return;
  const actions = (d.actions ?? []) as ComposedAction[];
  try {
    for (const a of actions) {
      if (a.type === 'calc_submit') {
        const landed = await landCalc(d, a, actor);
        if (!landed.queued) throw new Error(landed.queueError ?? 'calc_not_queued');
      } else if (a.type === 'set_followup') {
        const kind = d.clientId ? 'client' : 'lead';
        const id = d.clientId ?? d.leadId;
        if (!id) continue;
        const { setFollowUp } = await import('../crm/service');
        await setFollowUp(kind, id, a.date, { actorId: actor.id, viewAll: actor.permissions.has('crm.leads.view_all') });
      } else if (a.type === 'mute') {
        // A replay keeps the first mute's moment — the chat went quiet then.
        await db
          .insert(agentConversations)
          .values({ managerUserId: d.managerUserId, peerId: d.peerId, mutedAt: new Date(), muteReason: a.reason })
          .onConflictDoUpdate({
            target: [agentConversations.managerUserId, agentConversations.peerId],
            // `${table}.column`: inside ON CONFLICT the bare name is the
            // proposed row's as much as the existing one's (#128's cousin).
            set: {
              mutedAt: sql`coalesce(${agentConversations}.muted_at, now())`,
              muteReason: sql`CASE WHEN ${agentConversations}.muted_at IS NULL THEN ${a.reason} ELSE ${agentConversations}.mute_reason END`,
              updatedAt: new Date(),
            },
          });
      }
    }
    await db.update(agentDrafts).set({ actionStatus: 'done', actionError: null }).where(eq(agentDrafts.id, draftId));
  } catch (err) {
    await db
      .update(agentDrafts)
      .set({ actionStatus: 'failed', actionError: err instanceof Error ? err.message.slice(0, 300) : 'error' })
      .where(eq(agentDrafts.id, draftId));
    throw err;
  }
}

/**
 * His own words for a draft (✏️): they become the body, the card comes back
 * with ✅ — never sent on their own, and never rewritten by the model (the map's
 * recommendation; spec §7.1.4 contradicts shadow as written).
 */
export async function submitOwnText(actor: DeciderActor, draftId: string, text: string, ctx: AuditContext): Promise<DecideResult> {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d) return { ok: false, code: 'not_found' };
  if (d.managerUserId !== actor.id) return { ok: false, code: 'not_account_holder' };
  // His words for a reply the MACHINE already approved (a stale page's ✏️ box): «kech», as ✏️ says (fix pass A, C3).
  if (d.status === 'approved') {
    const after = await afterMachinePress(d, 'edit', actor.id, ctx);
    if (after) return after;
  }
  if (d.status !== 'editing' && d.status !== 'pending') return { ok: false, code: 'not_live', detail: d.status };
  const body = text.trim();
  if (!body) return { ok: false, code: 'empty' };
  // His words on the card are his decision — a waiting machine press stands down. The page's ✏️ is a box, no
  // `edit`: it stopped the countdown already, before the box opened (auto-send `stopAutoForEdit`, fix pass B, C1);
  // this is the net for words that reach here any other way. Nothing stopped: the machine's ✅ may have
  // committed since the read above (fix pass C, FIX-SEND-2) — then «kech», and his words are not dropped
  // behind a «faol emas» while the AI's own text goes.
  if (!(await stopAutoForPerson(draftId, actor.id, 'owner_edit'))) {
    const [fresh] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
    if (fresh?.status === 'approved') {
      const after = await afterMachinePress(fresh, 'edit', actor.id, ctx);
      if (after) return after;
    }
  }
  const p = (d.policy ?? {}) as Partial<DraftPolicyJson>;
  // His own words end a ✍️ he had pressed (spec SPEC-P1-v2 §2.2): a redraft from his answer still on its way finds no
  // mark and writes nothing over them (drafts `createDraft`). The page's ✏️ box writes here without a ✏️ press.
  const kept: Partial<DraftPolicyJson> = { ...p };
  delete kept.answering;
  // …and a lesson's rewrite of this reply (§3.4): his own words are never rewritten under him.
  delete kept.lessonRedraft;
  // His words pass the owner subset; the same-text count is only a warning on his card (K3).
  const policy = await ownerPolicyFor(body, p.memory?.ownCodes ?? [], {
    managerUserId: d.managerUserId,
    peerId: d.peerId,
    strip: p.card?.customerLabel ? p.card.customerLabel.split(/[\s,·]+/u) : [],
  });
  const [row] = await db
    .update(agentDrafts)
    .set({
      finalBody: body,
      status: 'pending',
      blocked: !policy.ok,
      policy: { ...kept, blocks: policy.blocks, warnings: policy.warnings, ledger: [] },
      updatedAt: new Date(),
    })
    .where(and(eq(agentDrafts.id, draftId), inArray(agentDrafts.status, ['editing', 'pending'])))
    .returning();
  if (!row) return { ok: false, code: 'not_live' };
  await writeAudit(db, ctx, { entityType: 'agent_draft', entityId: draftId, action: 'update', after: { finalBody: true } });
  await refreshDraftCard(draftId);
  // What the bot answers him (C9): a ✅ only where the card draws one — the policy passed AND the
  // card can show his whole text (card-io `renderDraftCardFull`); the digest is the card's own.
  const tooLong = renderDraftCardFull(row, null).tooLong;
  return {
    ok: true,
    status: 'pending',
    blocked: !policy.ok || tooLong,
    blocks: policy.blocks,
    digest: cardDigest(digestBody(row), (row.actions ?? []) as ComposedAction[]),
    actions: (row.actions ?? []) as ComposedAction[],
  };
}

// ── «✍️ Savolga javob» (spec SPEC-P1-v2 §2.2) ───────────────────────────────────

export type AnswerRefusal = 'not_ready' | 'not_found' | 'agent_off' | 'not_live' | 'not_question' | 'empty' | 'contact';

/**
 * His press of «✍️ Savolga javob» on a question the AI put to him: the holder alone (the draft's account AND the
 * agent's — callback data can be forged, so anybody else hears «Topilmadi»), only a live question the model raised
 * (`cardAsks`: a forced one is his ✏️ text). The draft's waiting auto stops first (`owner_answer`), then the ✏️
 * compare-and-set moves it to `editing` with `policy.answering` — a customer's next line stands down (drafts
 * `createDraft`) instead of superseding the very card he is answering, until his answer or `until`.
 */
export async function answerQuestion(actor: DeciderActor, draftId: string, now: Date = new Date()): Promise<{ ok: true; until: Date } | { ok: false; code: AnswerRefusal }> {
  if (!(await agentFullP1Ready())) return { ok: false, code: 'not_ready' };
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d || d.managerUserId !== actor.id) return { ok: false, code: 'not_found' };
  const config = await readAgentConfig();
  if (!config || config.ownerUserId !== actor.id) return { ok: false, code: 'not_found' };
  if (!agentRunning(config)) return { ok: false, code: 'agent_off' };
  if (d.status !== 'pending' && d.status !== 'editing') return { ok: false, code: 'not_live' };
  if (!cardAsks(d)) return { ok: false, code: 'not_question' };
  await stopAutoForPerson(draftId, actor.id, 'owner_answer');
  const until = new Date(now.getTime() + ANSWER_WAIT_MS);
  const answering = { since: now.toISOString(), until: until.toISOString() };
  const [row] = await db
    .update(agentDrafts)
    .set({ status: 'editing', updatedAt: now, policy: sql`coalesce(${agentDrafts.policy}, '{}'::jsonb) || ${JSON.stringify({ answering })}::jsonb` })
    .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.managerUserId, actor.id), inArray(agentDrafts.status, ['pending', 'editing']), eq(agentDrafts.needsOwner, true)))
    .returning({ id: agentDrafts.id });
  if (!row) return { ok: false, code: 'not_live' };
  await refreshDraftCard(draftId);
  return { ok: true, until };
}

/**
 * His answer, typed after «✍️» (§2.2): refused in words when it carries a phone, a link or Chinese text (the AI never
 * re-types an address — ✏️ is the door), else stored on the question draft as `policy.ownerAnswer` by a
 * compare-and-set on «still editing, still waiting for an answer» — a key no sender reads — and QUEUED: the model
 * runs on the worker, never on the bot's sequential poller (round 101, #706). The question stays `editing` until the
 * redraft supersedes it; a worker that dies with it is the sweep's to hand back (`ANSWER_RUN_STALE_MS`).
 */
export async function storeOwnerAnswer(
  actor: DeciderActor,
  draftId: string,
  text: string,
  messageId: number,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; code: AnswerRefusal; contact?: AnswerContact }> {
  const body = text.trim();
  if (!body) return { ok: false, code: 'empty' };
  // What was read as the contact travels with the refusal, so the door's words can name it.
  const contact = answerTextRefusal(body);
  if (contact) return { ok: false, code: 'contact', contact };
  const ownerAnswer = { text: body, at: now.toISOString(), messageId };
  const [row] = await db
    .update(agentDrafts)
    .set({ updatedAt: now, policy: sql`coalesce(${agentDrafts.policy}, '{}'::jsonb) || ${JSON.stringify({ ownerAnswer })}::jsonb` })
    .where(
      and(
        eq(agentDrafts.id, draftId),
        eq(agentDrafts.managerUserId, actor.id),
        eq(agentDrafts.status, 'editing'),
        sql`${agentDrafts.policy} ? 'answering'`,
        sql`(${agentDrafts.policy}->'answering'->>'until')::timestamptz > ${now.toISOString()}::timestamptz`,
      ),
    )
    .returning({ peerId: agentDrafts.peerId });
  if (!row) return { ok: false, code: 'not_live' };
  await writeAudit(db, ctx, { entityType: 'agent_draft', entityId: draftId, action: 'update', after: { ownerAnswer: true, messageId } });
  await refreshDraftCard(draftId);
  const job: AgentOwnerAnswerJob = { managerUserId: actor.id, peerId: String(row.peerId), draftId, messageId };
  // retryLimit 0: a re-delivered model call is a second bill; the run's source key keeps one answer one draft. A job
  // that never queued is the sweep's to hand back, in words (`ANSWER_RUN_STALE_MS`).
  await enqueue(JOB_AGENT_OWNER_ANSWER, job, { retryLimit: 0 }).catch((err: unknown) =>
    logger.error({ err, draftId }, '[agent] owner answer not queued'),
  );
  return { ok: true };
}

/**
 * A question he pressed ✍️ on, handed back to him: `editing` → `pending`, the wait's mark gone (his stored answer
 * stays — the «📌/👤» offer under its acknowledgement reads it). The card says why (`note`), and — `redraft` — every
 * customer line that stood down while he was answering is asked again (the ❌ path, `redraftQuietly`): without it a
 * pressed-and-forgotten ✍️ would silence the chat until the 24-hour expiry. False: it was no longer waiting.
 */
export async function releaseAnswering(draftId: string, opts: { note: string | null; redraft: boolean }): Promise<boolean> {
  const [row] = await db
    .update(agentDrafts)
    .set({ status: 'pending', updatedAt: new Date(), policy: sql`${agentDrafts.policy} - 'answering'` })
    .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.status, 'editing'), sql`${agentDrafts.policy} ? 'answering'`))
    .returning();
  if (!row) return false;
  await refreshDraftCard(draftId, opts.note ? [opts.note] : []);
  if (opts.redraft) await redraftQuietly(row, (await anchorEditedNow(row)) ? 'edited' : 'newer');
  return true;
}

async function refreshDraftCard(draftId: string, notes: string[] = []): Promise<void> {
  try {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(draftId, notes);
  } catch (err) {
    logger.warn({ err, draftId }, '[agent] card not refreshed');
  }
}
