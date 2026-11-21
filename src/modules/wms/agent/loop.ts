import { sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { agentSignals } from '../../platform/db/schema';
import { kickTelegramDrain, queueStaffTelegram } from '../../platform/notifications/staff';
import { AUTO_REFUSAL_WORDS } from './auto-gate';
import { agentToliq1aReady, agentToliq1aReadyOn } from './config';
import { AGENT_LIMITS } from './limits';

/**
 * The CHAT loop detector (stage 1a §4.3 «Halqa», J8, J33) — ONE rule for «this chat is a robot answering our robot»
 * (ban-4: an away-message talking to an AI that answers by itself is the account's ban risk). Not the model's tool
 * loop (`run.ts runLoop`, tests/integration/agent-loop.integration.test.ts): that one is the rounds of ONE run.
 *
 * It replaces two rules that each saw half of it. Eligibility's `repeat` (the anchor equal to one of the peer's last
 * three lines) refused an impatient customer's FIRST «Salom?» with no word to anybody; the gate's `streak` (two
 * machine replies in a row) would stop the third answer of every ordinary conversation once talk goes by itself. A
 * loop is three things, each asked where its facts are:
 *  - `same_inbound` (eligibility): the anchor's words, folded, on at least `sameInbound` earlier lines of the window
 *    that WE ANSWERED — a machine send after each, before the next equal line — so the first answered repeat is
 *    answered again, the second is a loop. A line nobody of ours answered is no robot answering our robot (the
 *    listener down, his human pause, his own chat: ban-4 needs our sends). Only an anchor WITH words and with no file:
 *    a photo, a file or a voice note with no caption has an empty body, and without this guard three invoice pages in
 *    a row would be «the same line» three times (§4.3, the lead's ruling of 2026-11-20); a caption is the customer's
 *    words about THAT file, so three photos of one product under one question are three lines too. And J8's own rule:
 *    a typing stamp newer than the previous equal line means a person typed the anchor — a robot never types;
 *  - `fast_peer` (eligibility, J8): an answer within `fastMs` of our machine send, to `fastSends` DISTINCT sends — at
 *    most ONE line per send (the first after it), and never one the peer may have TYPED: the listener keeps only the
 *    newest typing stamp, so a send it came after counts for nothing (see `fastPairs`);
 *  - `own_repeat` (the gate): the reply about to go is, folded, one of our last `ownSends` sends — the machine never
 *    presses the same words twice in a row of the window; his ✅ still can (a card, never a silence).
 *
 * The fold is `loopFold` — never policy's `textFingerprint`, which blanks every run of digits: right for G10's «did two
 * CHATS get one text», wrong here, where «5 kub narxi qancha?» and «7 kub narxi qancha?» are the commonest half hour
 * of a price chat and two honest quotes differ only in their figures. A responder that stamps a counter is
 * `fast_peer`'s; `runsPerChatPerDay` stays the last fuse.
 *
 * The signals are recomputed from the stored chat every time. The hold is not (J33): the notice tells him «AI 30
 * daqiqa bu chatga javob yozmaydi», so its claim (`agent_signals`, topic `loop`) IS read back — a line judged within
 * the window after it is refused `loop` too, whatever it says (eligibility), and so is a reply about to go there (the
 * gate: a card for his ✅). A sentence he is told must be true of the code, or the AI answers the chat he was sent to
 * take himself: two voices to the customer. The hold starts only where the notice was queued to somebody (a claim
 * nobody heard is rolled back), and one migration behind there is neither.
 */

export type LoopSignal = 'same_inbound' | 'fast_peer' | 'own_repeat';

/** One line of the chat as the detector reads it: when, and its words (none for a caption-less photo or voice note). */
export interface LoopLine {
  at: Date;
  body: string;
}

/** A customer's line — and whether a photo, a file or a voice note came with it (`tg_messages.has_media`). */
export interface LoopInLine extends LoopLine {
  media: boolean;
}

export interface LoopFacts {
  /** The customer's line the run answers; null when it is no longer stored (then only `own_repeat` is asked). */
  anchor: LoopInLine | null;
  /** His lines BEFORE the anchor, as stored (deleted ones left out). */
  inbound: readonly LoopInLine[];
  /**
   * Our machine sends to this chat — `agent_outbox` rows handed to Telegram ('sent', and 'unknown': perhaps delivered),
   * whoever pressed them (a loop with a robot is the same loop under his ✅), timed by the thread's copy.
   */
  sends: readonly LoopLine[];
  /** The newest moment the listener saw the customer typing (`agent_conversations.peer_typing_at`). */
  typingAt: Date | null;
  /**
   * The newest moment he was TOLD this chat loops (the notice's claim, `agent_signals` topic `loop`) — null when not
   * inside the window, and one migration behind.
   */
  toldAt: Date | null;
  /** The moment judged: the run's own, or when the reply would go (the gate). */
  now: Date;
  /** The reply about to go and the moment it would go — the gate's; null at eligibility. */
  draft: LoopLine | null;
}

export interface LoopVerdict {
  /** Every signal that tripped, in one stable order; none = no loop. */
  signals: readonly LoopSignal[];
  /** He was told this chat loops less than the window before `now` — the notice's promise holds the chat (J33). */
  held: boolean;
  /** `fast_peer`'s counted answers: each one's delay after its send, in ms — the claim records them (J8). */
  fastDelaysMs: readonly number[];
}

/** The fold both text signals compare by: trimmed, lower case, a run of white space as one space. */
export function loopFold(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, ' ');
}

const L = AGENT_LIMITS.loop;
const ms = (d: Date) => d.getTime();
const within = (at: Date, end: Date) => ms(at) <= ms(end) && ms(at) >= ms(end) - L.windowMs;
const byTime = (a: LoopLine, b: LoopLine) => ms(a.at) - ms(b.at);

/**
 * Our sends that got a fast answer (J8) — each counted pair's answer delay. Each send owns the lines from its own
 * moment to the next send's, and only the FIRST of them is its answer — so three lines typed after one question are one
 * answer, not three. The send is timed by our clock after Telegram took it, the answer by Telegram's whole second: an
 * away-message that answers in the same second reads up to `clockSlackMs` BEFORE the send, and is its answer all the
 * same.
 *
 * The typing clause, with the one stamp the listener keeps: J8 says a line the peer typed is never a robot's. Only the
 * NEWEST stamp is stored, so for a send after it nothing was typed before its answer (a robot), and for a send before
 * it nobody can tell — a person who typed his fourth quick answer would otherwise have his first three counted. The
 * doubt goes to the person; an away-message never types at all.
 */
function fastPairs(anchor: LoopLine, inbound: readonly LoopLine[], sends: readonly LoopLine[], typingAt: Date | null): number[] {
  const lines = [...inbound, anchor].filter((l) => within(l.at, anchor.at)).sort(byTime);
  // The send the anchor answers may read up to the slack AFTER it (the two clocks) — it is still the anchor's.
  const ours = sends.filter((s) => within(s.at, new Date(ms(anchor.at) + L.clockSlackMs))).sort(byTime);
  const delays: number[] = [];
  ours.forEach((s, i) => {
    const from = ms(s.at) - L.clockSlackMs;
    const next = ours[i + 1];
    const to = next ? ms(next.at) - L.clockSlackMs : Number.POSITIVE_INFINITY;
    const answer = lines.find((l) => ms(l.at) >= from && ms(l.at) < to);
    if (!answer || ms(answer.at) - ms(s.at) > L.fastMs) return;
    if (typingAt !== null && ms(typingAt) >= ms(s.at)) return;
    delays.push(ms(answer.at) - ms(s.at));
  });
  return delays;
}

/**
 * How many earlier lines of the window carry the anchor's words AND were answered by us (`same_inbound`). Equal lines
 * are taken in order, and each counts only when one of our sends lies after it and no later than the next equal line
 * (the anchor for the last) — the clock slack again, since a robot answering in the very second of our send reads up
 * to it before the send. A file's caption, a text-less line and an anchor with a file count for nothing; a typing
 * stamp at or after the previous equal line means the anchor was typed (J8), and a person is never a loop of this.
 */
function answeredRepeats(anchor: LoopInLine, inbound: readonly LoopInLine[], sends: readonly LoopLine[], typingAt: Date | null): number {
  const words = loopFold(anchor.body);
  if (anchor.media || words === '') return 0;
  const equal = inbound.filter((l) => !l.media && within(l.at, anchor.at) && loopFold(l.body) === words).sort(byTime);
  const prev = equal.at(-1);
  if (!prev || (typingAt !== null && ms(typingAt) >= ms(prev.at))) return 0;
  return equal.filter((l, i) => {
    const next = equal[i + 1] ?? anchor;
    return sends.some((s) => ms(s.at) > ms(l.at) && ms(s.at) <= ms(next.at) + L.clockSlackMs);
  }).length;
}

/** The detector — pure: `loopFactsFor` reads the facts, this judges them. */
export function loopVerdict(f: LoopFacts): LoopVerdict {
  const signals: LoopSignal[] = [];
  let fastDelaysMs: number[] = [];
  const { anchor } = f;
  if (anchor) {
    if (answeredRepeats(anchor, f.inbound, f.sends, f.typingAt) >= L.sameInbound) signals.push('same_inbound');
    const delays = fastPairs(anchor, f.inbound, f.sends, f.typingAt);
    if (delays.length >= L.fastSends) {
      signals.push('fast_peer');
      fastDelaysMs = delays;
    }
  }
  if (f.draft) {
    const { draft } = f;
    const words = loopFold(draft.body);
    const last = f.sends
      .filter((s) => within(s.at, draft.at))
      .sort((a, b) => byTime(b, a))
      .slice(0, L.ownSends);
    if (words !== '' && last.some((s) => loopFold(s.body) === words)) signals.push('own_repeat');
  }
  // A notice queued later than the line it judges holds that line too: the promise is about when the AI writes.
  const held = f.toldAt !== null && ms(f.now) - ms(f.toldAt) < L.windowMs;
  return { signals, held, fastDelaysMs };
}

/**
 * The detector's facts — ONE statement over the chat's window: the anchor, his earlier lines (each with its file
 * flag), our sends, his typing and the newest notice. The window reaches back `windowMs` from the earlier of the
 * anchor and `now`, so the anchor's own window, the gate's (ending at the moment the reply would go) and the hold
 * before `now` are all in it. «Our sends» are every `agent_outbox` row handed to Telegram — 'sent', and 'unknown' (the
 * answer lost: perhaps delivered, and a rule that cannot see it lets the same words be pressed again), timed by the
 * thread's copy, else the moment it left, else its claim before the send (the send step's caps read them the same).
 * The notice is read only under the 0151 probe, asked on the caller's handle BEFORE the statement — one migration
 * behind `agent_signals` does not exist and the whole statement would fail. The caller's handle, so a reader inside a
 * transaction never reaches the pool (#714). Raw timestamps come back as text, so each is read as epoch milliseconds.
 */
export async function loopFactsFor(
  handle: Db | Tx,
  managerUserId: string,
  peerId: bigint,
  anchorTgMessageId: bigint,
  now: Date,
  draftBody: string | null,
): Promise<LoopFacts> {
  const mgr = managerUserId;
  const peer = String(peerId);
  const anchorId = String(anchorTgMessageId);
  const told = (await agentToliq1aReadyOn(handle))
    ? sql`
    UNION ALL
    SELECT 'told', (extract(epoch FROM max(s.created_at)) * 1000)::float8, NULL, false
      FROM agent_signals s CROSS JOIN w
     WHERE s.topic = 'loop' AND s.manager_user_id = ${mgr}::uuid AND s.peer_id = ${peer}::bigint
       AND s.created_at >= w.since
    HAVING count(*) > 0`
    : sql``;
  const rows = await handle.execute<{ kind: string; ms: string | number; body: string | null; media: boolean | null }>(sql`
    WITH a AS (
      SELECT m.sent_at, m.body, m.has_media FROM tg_messages m
       WHERE m.manager_user_id = ${mgr}::uuid AND m.peer_id = ${peer}::bigint
         AND m.tg_message_id = ${anchorId}::bigint AND m.direction = 'in'
    ), w AS (
      SELECT least(coalesce((SELECT sent_at FROM a), ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz)
             - make_interval(secs => ${L.windowMs / 1000}::float8) AS since
    )
    SELECT 'anchor' AS kind, (extract(epoch FROM a.sent_at) * 1000)::float8 AS ms, a.body, a.has_media AS media FROM a
    UNION ALL
    SELECT 'in', (extract(epoch FROM m.sent_at) * 1000)::float8, m.body, m.has_media
      FROM tg_messages m
      LEFT JOIN tg_message_flags f ON f.message_id = m.id
      CROSS JOIN w
     WHERE m.manager_user_id = ${mgr}::uuid AND m.peer_id = ${peer}::bigint AND m.direction = 'in'
       AND f.deleted_at IS NULL AND m.tg_message_id < ${anchorId}::bigint AND m.sent_at >= w.since
    UNION ALL
    SELECT 'out', (extract(epoch FROM coalesce(t.sent_at, o.sent_at, o.step_claimed_at)) * 1000)::float8, o.body, false
      FROM agent_outbox o
      LEFT JOIN tg_messages t
        ON t.manager_user_id = o.manager_user_id AND t.peer_id = o.peer_id AND t.tg_message_id = o.tg_message_id
      CROSS JOIN w
     WHERE o.manager_user_id = ${mgr}::uuid AND o.peer_id = ${peer}::bigint AND o.status IN ('sent', 'unknown')
       AND coalesce(t.sent_at, o.sent_at, o.step_claimed_at) >= w.since
    UNION ALL
    SELECT 'typing', (extract(epoch FROM c.peer_typing_at) * 1000)::float8, NULL, false
      FROM agent_conversations c
     WHERE c.manager_user_id = ${mgr}::uuid AND c.peer_id = ${peer}::bigint AND c.peer_typing_at IS NOT NULL${told}`);
  const line = (r: { ms: string | number; body: string | null }): LoopLine => ({ at: new Date(Number(r.ms)), body: r.body ?? '' });
  const inLine = (r: { ms: string | number; body: string | null; media: boolean | null }): LoopInLine => ({ ...line(r), media: r.media === true });
  const all = [...rows];
  const anchorRow = all.find((r) => r.kind === 'anchor');
  const typing = all.find((r) => r.kind === 'typing');
  const toldRow = all.find((r) => r.kind === 'told');
  return {
    anchor: anchorRow ? inLine(anchorRow) : null,
    inbound: all.filter((r) => r.kind === 'in').map(inLine),
    sends: all.filter((r) => r.kind === 'out').map(line),
    typingAt: typing ? new Date(Number(typing.ms)) : null,
    toldAt: toldRow ? new Date(Number(toldRow.ms)) : null,
    now,
    draft: draftBody === null ? null : { at: now, body: draftBody },
  };
}

/**
 * The gate's two loop halves (`auto-send autoLoopFact` decides which count), judged at `at` — when the reply would
 * go — at the scheduling and again at the press, like every other fact: the reply is one of our last sends, word for
 * word (`ownRepeat`), and he was told this chat loops less than the window before (`held`, J33 — a reply written
 * before the notice, or his ✍️ or a VED answer meanwhile, waits for his ✅). Not the anchor's two signals: those are
 * eligibility's, which an owner-triggered draft never asked and must not meet here. Two halves and not one answer
 * because a tayyor matn's own repeat is not the loop's to judge (its rule is «once per silence», context
 * `toldInSilenceOf`): the same line for a chat is the point of `pick`, and «the same words again» would refuse it.
 */
export async function gateLoopFor(
  d: { managerUserId: string; peerId: bigint; anchorTgMessageId: bigint; body: string },
  at: Date,
): Promise<{ held: boolean; ownRepeat: boolean }> {
  const verdict = loopVerdict(await loopFactsFor(db, d.managerUserId, d.peerId, d.anchorTgMessageId, at, d.body));
  return { held: verdict.held, ownRepeat: verdict.signals.includes('own_repeat') };
}

/**
 * The notice's bucket: the anchor's moment FLOORED to the window. A fixed bucket, never the sliding window's own start,
 * which moves with every line and would mint a notice per line.
 */
export function loopBucketStart(at: Date): Date {
  return new Date(Math.floor(ms(at) / L.windowMs) * L.windowMs);
}

/**
 * The claim's key — once per chat per bucket (`agent_signals.dedupe_key`, unique over the whole table). The account
 * is in it: a chat is (account, peer), and after the AI changes hands inside a bucket the new holder's notice must not
 * be swallowed by the old holder's claim.
 */
export function loopSignalKey(managerUserId: string, peerId: bigint, anchorAt: Date): string {
  return `loop:${managerUserId}:${peerId}:${loopBucketStart(anchorAt).toISOString()}`;
}

/**
 * What he is told (J33): one word for the one loop — the refusal's own (`AUTO_REFUSAL_WORDS.loop`, which the card and
 * the morning line print) — and how long the AI keeps out: the window, which the hold is judged by (`loopVerdict`
 * `held`), so the sentence is the code's. No customer text.
 */
export const LOOP_NOTICE = `🔁 Bu ${AUTO_REFUSAL_WORDS.loop} (avtojavob bo'lishi mumkin) — AI ${L.windowMs / 60_000} daqiqa bu chatga javob yozmaydi, o'zingiz qarang.`;

export interface LoopNoticeInput {
  managerUserId: string;
  peerId: bigint;
  clientId: string | null;
  leadId: string | null;
  anchorAt: Date;
  anchorTgMessageId: bigint;
  /** The moment he is told — the run's clock; the hold is counted from it (the claim's `created_at`). */
  at: Date;
  signals: readonly LoopSignal[];
  fastDelaysMs: readonly number[];
  /** Who the chat is (drafts `customerLabel`) — the code and the name, never what was written. */
  label: string;
}

/** Thrown inside the claim's transaction to take the claim back: nobody was queued the notice. */
class NoticeUnheard extends Error {}

/**
 * Say a loop ONCE per bucket (J33): the claim (`agent_signals`, unique `dedupe_key`) and the card in ONE transaction,
 * so a claim never stands without its card. The claim IS the hold (`loopVerdict` `held`), and a hold nobody was told
 * of is thirty silent minutes with no promise behind them — so when the card reaches nobody (the holder cannot log
 * in: a seat with its login off, a leaver — `queueStaffTelegram` queues no row; an AgentNotice cannot be muted) the
 * transaction is rolled back, claim and all: 'unheard', and the looping lines stay refused by their own signals. To
 * the account holder, naming the chat by the very key the purge blanks a notice by (`extra.peerId`). One migration
 * behind (no 0151) nothing is claimed and nothing said: 'behind'. The probe is read BEFORE the transaction (#714). The
 * facts keep which signals tripped and, for `fast_peer`, each counted answer's delay — J8's first-week measurement of
 * the 10 s reads them beside the stored chats.
 */
export async function loopNoticeOnce(input: LoopNoticeInput): Promise<'said' | 'already' | 'unheard' | 'behind'> {
  if (!(await agentToliq1aReady())) return 'behind';
  let queued: number | null;
  try {
    queued = await db.transaction(async (tx) => {
      const claimed = await tx
        .insert(agentSignals)
        .values({
          topic: 'loop',
          managerUserId: input.managerUserId,
          peerId: input.peerId,
          leadId: input.leadId,
          clientId: input.clientId,
          facts: {
            signals: [...input.signals],
            fastDelaysMs: [...input.fastDelaysMs],
            anchorTgMessageId: String(input.anchorTgMessageId),
          },
          dedupeKey: loopSignalKey(input.managerUserId, input.peerId, input.anchorAt),
          createdAt: input.at,
        })
        .onConflictDoNothing({ target: agentSignals.dedupeKey })
        .returning({ id: agentSignals.id });
      if (claimed.length === 0) return null;
      const n = await queueStaffTelegram(tx, {
        userIds: [input.managerUserId],
        type: 'AgentNotice',
        text: [LOOP_NOTICE, input.label].join('\n'),
        extra: { peerId: String(input.peerId) },
      });
      if (n === 0) throw new NoticeUnheard();
      return n;
    });
  } catch (err) {
    if (err instanceof NoticeUnheard) return 'unheard';
    throw err;
  }
  if (queued === null) return 'already';
  await kickTelegramDrain();
  return 'said';
}
