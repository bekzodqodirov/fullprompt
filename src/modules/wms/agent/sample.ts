import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentDrafts, agentOutbox, agentSamples, tgMessages } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { actorGrants } from '../../platform/rbac/authorize';
import { clipText } from '../../platform/telegram/format';
import { addDays, calendarDaysBetween, tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { autoFeedback, mayArmAuto } from './auto-send';
import { agentToliq1aReady, readAgentConfig, type AgentConfig } from './config';
import { designated } from './designations';
import { agentPageReaders, agentPageUrl } from './signals';
import { chatHrefOf, draftsSeenBy, type WebViewer } from './web-page';

/**
 * «Kunlik tekshiruv» (stage 1a §4.5, his 9 a: «har kuni kechqurun 10 tasini belgilayman, bir oydan keyin haftada»):
 * at 20:10 Tashkent at most ten of the replies the MACHINE sent — money replies first, then the ones the model was
 * least sure of, then a fair shuffle of the rest — land on the AI page, and ONE line tells the people who may mark
 * them. 👍 writes «to‘g‘ri»; 👎 writes «xato» AND is the card's own 👎 (`autoFeedback`: that chat leaves the layer
 * for 30 days, two in seven days disarm it). Daily while the first sample is under 30 days old, then Fridays only,
 * the week's replies — derived from the first sample's day, no setting.
 *
 * The net under ordinary talk that goes with no ⏸ (his 82 ⭐ a): what slipped through is seen the same evening.
 */

/** At most this many a sample (his 9 a, «10 tasini»). */
export const SAMPLE_SIZE = 10;

/** Daily for the first month, then weekly (his 9 a). */
export const SAMPLE_DAILY_DAYS = 30;

/** Friday on the calendar — the weekly sample's day. */
const FRIDAY = 5;

export type SampleCadence = 'daily' | 'weekly';

/**
 * Is a sample due today, and over which span? Pure. No sample ever, or the first one under `SAMPLE_DAILY_DAYS`
 * old: every day, the replies since the last evening's draw. After that: Fridays only, the week's (`sampleSpan`).
 */
export function sampleDue(today: string, firstDay: string | null): SampleCadence | null {
  if (firstDay === null || calendarDaysBetween(firstDay, today) < SAMPLE_DAILY_DAYS) return 'daily';
  return new Date(`${today}T12:00:00Z`).getUTCDay() === FRIDAY ? 'weekly' : null;
}

/**
 * The minute a sample is drawn, Tashkent: 20:10 (his 9 a, «har kuni kechqurun»). `registerAgentWorkers` schedules
 * the job as '10 15 * * *' UTC; a unit test holds the two together.
 */
export const SAMPLE_DRAW_MINUTES = 20 * 60 + 10;

const drawAt = (day: string) => new Date(tashkentDayStart(day).getTime() + SAMPLE_DRAW_MINUTES * 60_000);

/**
 * The replies a sample of `day` draws from: the 24 hours before its draw (weekly: the seven days before it) — draw to
 * draw, so a reply pressed after one evening's draw is in the next one's. A calendar day drawn at 20:10 left
 * 20:10-24:00 out of EVERY sample (the P4 review's 4), and those are the hours hold-0 talk goes on into. A day the job
 * never ran is not reached back for — its replies are in no sample (stated).
 */
export function sampleSpan(day: string, cadence: SampleCadence): { from: Date; to: Date } {
  return { from: drawAt(addDays(day, cadence === 'weekly' ? -7 : -1)), to: drawAt(day) };
}

/**
 * The card's own 👎 on a sampled reply (`autoFeedback` — the same counter as the sample's): it IS a «xato», so the
 * row is judged and its 👍 would contradict it (the P4 review's 9). `${agentSamples}.draft_id`, never
 * `${agentSamples.draftId}`: the subquery's own table has a `draft_id`, and drizzle renders a single-table select's
 * columns unqualified (#128).
 */
const CARD_SAID_BAD = sql`EXISTS (SELECT 1 FROM agent_auto_verdicts fv WHERE fv.draft_id = ${agentSamples}.draft_id AND fv.feedback = 'bad')`;

/** A sampled reply nobody has judged — no mark here and no 👎 on its card: the badge, the page's count, the morning's. */
export const SAMPLE_UNMARKED = sql`(${agentSamples}.mark IS NULL AND NOT ${CARD_SAID_BAD})`;

/** A draft's ledger holds a money line — the stored policy's own rows (numbers `LedgerEntry`, `kind: 'money'`). */
const MONEY_REPLY = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(${agentDrafts}.policy->'ledger') = 'array' THEN ${agentDrafts}.policy->'ledger' ELSE '[]'::jsonb END) e
  WHERE e->>'kind' = 'money')`;

/**
 * A tayyor matn the code wrote (`policy.system`, stage 1a P3) — never the model's words. The sample leaves it out: it
 * has no model rating at all (stored NULL), so «an unknown confidence first» put every «write it as text» line of the
 * day ahead of the replies the net is for (the merged-tree seam review, finding 2), and its words are his own, read
 * once in the deploy message. Any `system` key at all — the draw asks the same «not a model reply» whatever reason a
 * later build gives it.
 */
const TAYYOR_MATN = sql`(${agentDrafts}.policy->>'system') IS NOT NULL`;

/**
 * Draw the sample of `day`, once: under one lock per day, nothing is drawn when the day already has one (a second
 * run of the job draws no second ten). The replies: pressed by the machine (`agent_auto_verdicts.state = 'pressed'`),
 * whose outbox row is `sent` — a reply the customer GOT — in the span, never one drawn before, never a tayyor matn;
 * money first, then the lowest stored confidence (an unknown one first), then a hash of (day, id): fair, and the same
 * on a re-read. Returns how many it drew. One migration behind 0151: none.
 */
export async function drawSample(day: string, cadence: SampleCadence): Promise<number> {
  if (!(await agentToliq1aReady())) return 0;
  const { from, to } = sampleSpan(day, cadence);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent_samples:${day}`}))`);
    const [already] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentSamples).where(eq(agentSamples.day, day));
    if (Number(already?.n ?? 0) > 0) return 0;
    const picked = await tx.execute<{ id: string; manager_user_id: string; peer_id: string }>(sql`
      SELECT ${agentDrafts}.id::text AS id, ${agentDrafts}.manager_user_id::text AS manager_user_id, ${agentDrafts}.peer_id::text AS peer_id
        FROM agent_auto_verdicts v
        JOIN ${agentDrafts} ON ${agentDrafts}.id = v.draft_id
        JOIN agent_outbox o ON o.draft_id = v.draft_id
       WHERE v.state = 'pressed' AND o.status = 'sent'
         AND v.pressed_at >= ${from.toISOString()}::timestamptz AND v.pressed_at < ${to.toISOString()}::timestamptz
         AND NOT EXISTS (SELECT 1 FROM agent_samples s WHERE s.draft_id = v.draft_id)
         AND NOT ${TAYYOR_MATN}
       ORDER BY ${MONEY_REPLY} DESC, ${agentDrafts}.confidence ASC NULLS FIRST, md5(${day} || ${agentDrafts}.id::text)
       LIMIT ${SAMPLE_SIZE}`);
    const rows = [...picked];
    if (rows.length === 0) return 0;
    await tx.insert(agentSamples).values(
      rows.map((r, i) => ({ day, draftId: r.id, managerUserId: r.manager_user_id, peerId: BigInt(r.peer_id), pos: i + 1 })),
    );
    return rows.length;
  });
}

/** The line that tells them — a count and how long it takes; the page's tab last (the drain's «↗️ Ochish»). */
export function sampleLineText(n: number, cadence: SampleCadence, withPage: boolean): string {
  const minutes = Math.max(1, Math.ceil(n / 2));
  const head = `🔎 ${cadence === 'weekly' ? 'Haftalik' : 'Bugungi'} tekshiruv: ${n} ta javob — ${minutes} daqiqa. AI o‘zi yuborgan javoblarni 👍 yoki 👎 bilan belgilang.`;
  return withPage ? [head, agentPageUrl('tekshiruv')].join('\n') : head;
}

/**
 * Who may mark — the arming rule, `mayArmAuto` (the reply's holder, or a super_admin while the holder is the AI seat):
 * the 👎 IS the layer's own step-down, so it is pressed by whoever may arm it.
 */
async function mayMark(userId: string, holderId: string | null): Promise<boolean> {
  const grants = await actorGrants(userId);
  return mayArmAuto({ id: userId, roles: grants.roles }, holderId);
}

/**
 * The 20:10 job: when a sample is due, draw it and tell — J17: the line goes to the «rahbar va o‘rinbosar» pair
 * the arming rule lets mark; when it lets none of them (he designated people who cannot press), to rank 1 alone, so
 * the line is never lost; the link only for whom the page admits. Outside any transaction.
 */
export async function sendSample(now: Date = new Date()): Promise<number> {
  if (!(await agentToliq1aReady())) return 0;
  const config = await readAgentConfig();
  if (!config?.ownerUserId) return 0;
  const today = tashkentDay(now);
  const [first] = await db.select({ day: sql<string | null>`min(${agentSamples.day})::text` }).from(agentSamples);
  const cadence = sampleDue(today, first?.day ?? null);
  if (!cadence) return 0;
  const drawn = await drawSample(today, cadence);
  if (drawn === 0) return 0;
  await tellSample(config, drawn, cadence);
  logger.info({ day: today, drawn, cadence }, '[agent] evening sample');
  return drawn;
}

async function tellSample(config: Pick<AgentConfig, 'ownerUserId'>, n: number, cadence: SampleCadence): Promise<void> {
  const pair = await designated('supervisor');
  const markers: string[] = [];
  for (const id of pair) if (await mayMark(id, config.ownerUserId)) markers.push(id);
  const recipients = markers.length > 0 ? markers : pair.slice(0, 1);
  const readers = await agentPageReaders(recipients, config);
  for (const userId of recipients) {
    await notifyStaffTelegram({ userIds: [userId], type: 'AgentSample', text: sampleLineText(n, cadence, readers.has(userId)) });
  }
}

export type SampleMarkRefusal = 'not_ready' | 'not_found' | 'already' | 'forbidden';

/**
 * 👍 / 👎 on one sampled reply. The door is the arming rule (`mayArmAuto`, asked of the reply's own holder). 👎 is the
 * card's 👎 first (`autoFeedback` — the chat off for 30 days, two in seven days disarm); only when it took (or the
 * card's 👎 had already been given) is the mark written, so the two never disagree. A reply marked already answers
 * `already` — and so does a 👍 on a reply whose card was given 👎 (in the same statement that writes it).
 */
export async function markSample(
  actor: { id: string; roles: readonly string[] },
  input: { day: string; draftId: string; mark: 'good' | 'bad' },
  now: Date = new Date(),
): Promise<{ ok: true; disarmed: boolean } | { ok: false; code: SampleMarkRefusal }> {
  if (!(await agentToliq1aReady())) return { ok: false, code: 'not_ready' };
  const [row] = await db
    .select({ managerUserId: agentSamples.managerUserId, mark: agentSamples.mark })
    .from(agentSamples)
    .where(and(eq(agentSamples.day, input.day), eq(agentSamples.draftId, input.draftId)));
  if (!row) return { ok: false, code: 'not_found' };
  if (!(await mayArmAuto(actor, row.managerUserId))) return { ok: false, code: 'forbidden' };
  if (row.mark !== null) return { ok: false, code: 'already' };
  let disarmed = false;
  if (input.mark === 'bad') {
    // The card's own 👎 — its door is asked again inside; a press it refuses writes no mark.
    const fb = await autoFeedback(actor, input.draftId, now);
    if (!fb.ok && fb.code !== 'already') return { ok: false, code: fb.code === 'not_account_holder' ? 'forbidden' : 'not_found' };
    disarmed = fb.ok && fb.disarmed;
  }
  const marked = await db
    .update(agentSamples)
    .set({ mark: input.mark, markedBy: actor.id, markedAt: now })
    .where(
      and(
        eq(agentSamples.day, input.day),
        eq(agentSamples.draftId, input.draftId),
        isNull(agentSamples.mark),
        input.mark === 'good' ? sql`NOT ${CARD_SAID_BAD}` : undefined,
      ),
    )
    .returning({ draftId: agentSamples.draftId });
  return marked.length > 0 ? { ok: true, disarmed } : { ok: false, code: 'already' };
}

/** One sampled reply as the page draws it. */
export interface SampleRow {
  day: string;
  draftId: string;
  pos: number;
  /** The customer's line the reply answered — clipped; the page shows it to whoever may read that chat. */
  customer: string;
  /** What the customer got. */
  reply: string;
  mark: 'good' | 'bad' | null;
  /** The reader may press 👍 / 👎 here (the arming rule). */
  mayMark: boolean;
  chatHref: string | null;
}

export interface SampleView {
  ready: boolean;
  /** The newest sample's day, or null when none was ever drawn. */
  day: string | null;
  /** That day's rows, then the older ones still unmarked (newest first). */
  rows: SampleRow[];
  /** Unmarked rows of the days before the newest. */
  olderUnmarked: number;
}

/** How many older unmarked rows the page lists under the newest day's. */
const OLDER_SHOWN = 30;

/**
 * «Kunlik tekshiruv» as one reader sees it: rows only of the chats he may read (`draftsSeenBy` — the page's own sight,
 * K10), each with whether he may mark it. One migration behind 0151: `ready` false, nothing read.
 */
export async function sampleView(viewer: WebViewer & { roles: readonly string[] }): Promise<SampleView> {
  if (!(await agentToliq1aReady())) return { ready: false, day: null, rows: [], olderUnmarked: 0 };
  const [newest] = await db.select({ day: sql<string | null>`max(${agentSamples.day})::text` }).from(agentSamples);
  const day = newest?.day ?? null;
  if (!day) return { ready: true, day: null, rows: [], olderUnmarked: 0 };
  const seen = draftsSeenBy(viewer);
  const select = () =>
    db
      .select({ s: agentSamples, d: agentDrafts, reply: agentOutbox.body, customer: tgMessages.body, cardBad: sql<boolean>`${CARD_SAID_BAD}` })
      .from(agentSamples)
      .innerJoin(agentDrafts, eq(agentDrafts.id, agentSamples.draftId))
      .leftJoin(agentOutbox, eq(agentOutbox.draftId, agentSamples.draftId))
      .leftJoin(
        tgMessages,
        and(
          eq(tgMessages.managerUserId, agentDrafts.managerUserId),
          eq(tgMessages.peerId, agentDrafts.peerId),
          eq(tgMessages.tgMessageId, agentDrafts.anchorTgMessageId),
        ),
      );
  const [today, older, olderCount] = await Promise.all([
    select().where(and(eq(agentSamples.day, day), seen)).orderBy(asc(agentSamples.pos)),
    select()
      .where(and(sql`${agentSamples.day} < ${day}::date`, SAMPLE_UNMARKED, seen))
      .orderBy(desc(agentSamples.day), asc(agentSamples.pos))
      .limit(OLDER_SHOWN),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentSamples)
      .innerJoin(agentDrafts, eq(agentDrafts.id, agentSamples.draftId))
      .where(and(sql`${agentSamples.day} < ${day}::date`, SAMPLE_UNMARKED, seen)),
  ]);
  const holders = [...new Set([...today, ...older].map((r) => r.s.managerUserId))];
  const marks = new Map<string, boolean>();
  for (const id of holders) marks.set(id, await mayArmAuto(viewer, id));
  const rows = [...today, ...older].map(
    (r): SampleRow => ({
      day: r.s.day,
      draftId: r.s.draftId,
      pos: r.s.pos,
      customer: clipText((r.customer ?? '').trim() || '—', 500),
      reply: (r.reply ?? r.d.finalBody ?? r.d.proposedBody ?? '').trim(),
      // The card's 👎 is this row's «xato» too — drawn as marked, with no 👍 to contradict it.
      mark: r.s.mark === 'good' || r.s.mark === 'bad' ? r.s.mark : r.cardBad ? 'bad' : null,
      mayMark: marks.get(r.s.managerUserId) === true,
      chatHref: chatHrefOf(r.d),
    }),
  );
  return { ready: true, day, rows, olderUnmarked: Number(olderCount[0]?.n ?? 0) };
}

/** Unmarked rows of the newest sample — the tab's badge. */
export async function sampleUnmarkedToday(viewer: WebViewer): Promise<number> {
  if (!(await agentToliq1aReady())) return 0;
  const [newest] = await db.select({ day: sql<string | null>`max(${agentSamples.day})::text` }).from(agentSamples);
  if (!newest?.day) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentSamples)
    .innerJoin(agentDrafts, eq(agentDrafts.id, agentSamples.draftId))
    .where(and(eq(agentSamples.day, newest.day), SAMPLE_UNMARKED, draftsSeenBy(viewer)));
  return Number(row?.n ?? 0);
}

