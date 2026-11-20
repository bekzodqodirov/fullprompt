import { sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { agentSignals } from '../../platform/db/schema';
import { kickTelegramDrain, queueStaffTelegram } from '../../platform/notifications/staff';
import { AUTO_REFUSAL_WORDS } from './auto-gate';
import { agentToliq1aReady } from './config';
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
 *  - `same_inbound` (eligibility): the anchor's words, folded, at least `sameInbound` times BEFORE it in the window —
 *    the first repeat is answered, the second is a loop. Only an anchor WITH words: a photo, a file or a voice note
 *    with no caption has an empty body, and without this guard three invoice pages in a row would be «the same line»
 *    three times (§4.3, the lead's ruling of 2026-11-20);
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
 * Stateless: the verdict is recomputed from the stored chat every time. The one row it writes — the notice's claim
 * (`agent_signals`, once per window bucket) — is never read back as a rule.
 */

export type LoopSignal = 'same_inbound' | 'fast_peer' | 'own_repeat';

/** One line of the chat as the detector reads it: when, and its words (none for a caption-less photo or voice note). */
export interface LoopLine {
  at: Date;
  body: string;
}

export interface LoopFacts {
  /** The customer's line the run answers; null when it is no longer stored (then only `own_repeat` is asked). */
  anchor: LoopLine | null;
  /** His lines BEFORE the anchor, as stored (deleted ones left out). */
  inbound: readonly LoopLine[];
  /**
   * Our machine sends to this chat — `agent_outbox` rows that WENT, whoever pressed them (a loop with a robot is the
   * same loop under his ✅), timed by the thread's copy.
   */
  sends: readonly LoopLine[];
  /** The newest moment the listener saw the customer typing (`agent_conversations.peer_typing_at`). */
  typingAt: Date | null;
  /** The reply about to go and the moment it would go — the gate's; null at eligibility. */
  draft: LoopLine | null;
}

export interface LoopVerdict {
  /** Every signal that tripped, in one stable order; none = no loop. */
  signals: readonly LoopSignal[];
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
 * How many of our sends got a fast answer (J8). Each send owns the lines from its own moment to the next send's, and
 * only the FIRST of them is its answer — so three lines typed after one question are one answer, not three. The send
 * is timed by our clock after Telegram took it, the answer by Telegram's whole second: an away-message that answers
 * in the same second reads up to `clockSlackMs` BEFORE the send, and is its answer all the same.
 *
 * The typing clause, with the one stamp the listener keeps: J8 says a line the peer typed is never a robot's. Only the
 * NEWEST stamp is stored, so for a send after it nothing was typed before its answer (a robot), and for a send before
 * it nobody can tell — a person who typed his fourth quick answer would otherwise have his first three counted. The
 * doubt goes to the person; an away-message never types at all.
 */
function fastPairs(anchor: LoopLine, inbound: readonly LoopLine[], sends: readonly LoopLine[], typingAt: Date | null): number {
  const lines = [...inbound, anchor].filter((l) => within(l.at, anchor.at)).sort(byTime);
  // The send the anchor answers may read up to the slack AFTER it (the two clocks) — it is still the anchor's.
  const ours = sends.filter((s) => within(s.at, new Date(ms(anchor.at) + L.clockSlackMs))).sort(byTime);
  let fast = 0;
  ours.forEach((s, i) => {
    const from = ms(s.at) - L.clockSlackMs;
    const next = ours[i + 1];
    const to = next ? ms(next.at) - L.clockSlackMs : Number.POSITIVE_INFINITY;
    const answer = lines.find((l) => ms(l.at) >= from && ms(l.at) < to);
    if (!answer || ms(answer.at) - ms(s.at) > L.fastMs) return;
    if (typingAt !== null && ms(typingAt) >= ms(s.at)) return;
    fast += 1;
  });
  return fast;
}

/** The detector — pure: `loopFactsFor` reads the facts, this judges them. */
export function loopVerdict(f: LoopFacts): LoopVerdict {
  const signals: LoopSignal[] = [];
  const { anchor } = f;
  if (anchor) {
    const words = loopFold(anchor.body);
    // A text-less anchor is never «the same line again», and a text-less earlier line matches nothing (§4.3).
    if (words !== '') {
      const same = f.inbound.filter((l) => within(l.at, anchor.at) && loopFold(l.body) === words).length;
      if (same >= L.sameInbound) signals.push('same_inbound');
    }
    if (fastPairs(anchor, f.inbound, f.sends, f.typingAt) >= L.fastSends) signals.push('fast_peer');
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
  return { signals };
}

/**
 * The detector's facts — ONE statement over the chat's window: the anchor, his earlier lines, our sends and his
 * typing. The window reaches back `windowMs` from the earlier of the anchor and `now`, so the anchor's own window and
 * the gate's (ending at the moment the reply would go) are both in it. The caller's handle, so a reader inside a
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
  const rows = await handle.execute<{ kind: string; ms: string | number; body: string | null }>(sql`
    WITH a AS (
      SELECT m.sent_at, m.body FROM tg_messages m
       WHERE m.manager_user_id = ${mgr}::uuid AND m.peer_id = ${peer}::bigint
         AND m.tg_message_id = ${anchorId}::bigint AND m.direction = 'in'
    ), w AS (
      SELECT least(coalesce((SELECT sent_at FROM a), ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz)
             - make_interval(secs => ${L.windowMs / 1000}::float8) AS since
    )
    SELECT 'anchor' AS kind, (extract(epoch FROM a.sent_at) * 1000)::float8 AS ms, a.body FROM a
    UNION ALL
    SELECT 'in', (extract(epoch FROM m.sent_at) * 1000)::float8, m.body
      FROM tg_messages m
      LEFT JOIN tg_message_flags f ON f.message_id = m.id
      CROSS JOIN w
     WHERE m.manager_user_id = ${mgr}::uuid AND m.peer_id = ${peer}::bigint AND m.direction = 'in'
       AND f.deleted_at IS NULL AND m.tg_message_id < ${anchorId}::bigint AND m.sent_at >= w.since
    UNION ALL
    SELECT 'out', (extract(epoch FROM coalesce(t.sent_at, o.sent_at)) * 1000)::float8, o.body
      FROM agent_outbox o
      LEFT JOIN tg_messages t
        ON t.manager_user_id = o.manager_user_id AND t.peer_id = o.peer_id AND t.tg_message_id = o.tg_message_id
      CROSS JOIN w
     WHERE o.manager_user_id = ${mgr}::uuid AND o.peer_id = ${peer}::bigint AND o.status = 'sent'
       AND coalesce(t.sent_at, o.sent_at) >= w.since
    UNION ALL
    SELECT 'typing', (extract(epoch FROM c.peer_typing_at) * 1000)::float8, NULL
      FROM agent_conversations c
     WHERE c.manager_user_id = ${mgr}::uuid AND c.peer_id = ${peer}::bigint AND c.peer_typing_at IS NOT NULL`);
  const line = (r: { ms: string | number; body: string | null }): LoopLine => ({ at: new Date(Number(r.ms)), body: r.body ?? '' });
  const all = [...rows];
  const anchorRow = all.find((r) => r.kind === 'anchor');
  const typing = all.find((r) => r.kind === 'typing');
  return {
    anchor: anchorRow ? line(anchorRow) : null,
    inbound: all.filter((r) => r.kind === 'in').map(line),
    sends: all.filter((r) => r.kind === 'out').map(line),
    typingAt: typing ? new Date(Number(typing.ms)) : null,
    draft: draftBody === null ? null : { at: now, body: draftBody },
  };
}

/**
 * The gate's `loop` fact (`auto-send autoFactsFor`): the reply about to go is one of our last sends, word for word —
 * read at the scheduling and again at the press, like every other fact. Only `own_repeat`: the anchor's two signals
 * are eligibility's, which an owner-triggered draft (his ✍️, a VED answer) never asked and must not meet here.
 */
export async function ownRepeatFor(
  d: { managerUserId: string; peerId: bigint; anchorTgMessageId: bigint; body: string },
  now: Date,
): Promise<boolean> {
  const facts = await loopFactsFor(db, d.managerUserId, d.peerId, d.anchorTgMessageId, now, d.body);
  return loopVerdict(facts).signals.includes('own_repeat');
}

/**
 * The notice's bucket: the anchor's moment FLOORED to the window. A fixed bucket, never the sliding window's own start,
 * which moves with every line and would mint a notice per line.
 */
export function loopBucketStart(at: Date): Date {
  return new Date(Math.floor(ms(at) / L.windowMs) * L.windowMs);
}

/** The claim's key — once per chat per bucket (`agent_signals.dedupe_key`). */
export function loopSignalKey(peerId: bigint, anchorAt: Date): string {
  return `loop:${peerId}:${loopBucketStart(anchorAt).toISOString()}`;
}

/**
 * What he is told (J33): one word for the one loop — the refusal's own (`AUTO_REFUSAL_WORDS.loop`, which the card and
 * the morning line print) — and how long the AI keeps out, from the window it judges by. No customer text.
 */
export const LOOP_NOTICE = `🔁 Bu ${AUTO_REFUSAL_WORDS.loop} (avtojavob bo'lishi mumkin) — AI ${L.windowMs / 60_000} daqiqa bu chatga javob yozmaydi, o'zingiz qarang.`;

export interface LoopNoticeInput {
  managerUserId: string;
  peerId: bigint;
  clientId: string | null;
  leadId: string | null;
  anchorAt: Date;
  anchorTgMessageId: bigint;
  signals: readonly LoopSignal[];
  /** Who the chat is (drafts `customerLabel`) — the code and the name, never what was written. */
  label: string;
}

/**
 * Say a loop ONCE per bucket (J33): the claim (`agent_signals`, unique `dedupe_key`) and the card in ONE transaction,
 * so a claim never stands without its card. To the account holder, naming the chat by the very key the purge blanks a
 * notice by (`extra.peerId`). One migration behind (no 0151) nothing is claimed and nothing said: 'behind'. The probe
 * is read BEFORE the transaction (#714). The facts keep which signals tripped — the 10 s is measured from them.
 */
export async function loopNoticeOnce(input: LoopNoticeInput): Promise<'said' | 'already' | 'behind'> {
  if (!(await agentToliq1aReady())) return 'behind';
  const queued = await db.transaction(async (tx) => {
    const claimed = await tx
      .insert(agentSignals)
      .values({
        topic: 'loop',
        managerUserId: input.managerUserId,
        peerId: input.peerId,
        leadId: input.leadId,
        clientId: input.clientId,
        facts: { signals: [...input.signals], anchorTgMessageId: String(input.anchorTgMessageId) },
        dedupeKey: loopSignalKey(input.peerId, input.anchorAt),
      })
      .onConflictDoNothing({ target: agentSignals.dedupeKey })
      .returning({ id: agentSignals.id });
    if (claimed.length === 0) return null;
    return queueStaffTelegram(tx, {
      userIds: [input.managerUserId],
      type: 'AgentNotice',
      text: [LOOP_NOTICE, input.label].join('\n'),
      extra: { peerId: String(input.peerId) },
    });
  });
  if (queued === null) return 'already';
  if (queued > 0) await kickTelegramDrain();
  return 'said';
}
