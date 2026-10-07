import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../platform/db/client';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { logger } from '../../platform/logger';
import { isServerBehind } from '../../platform/db/errors';
import {
  THREAD_INSTANT,
  THREAD_PING_TYPES,
  THREAD_TEXT_MAX,
  THREAD_UUID,
  THREAD_WINDOW_DAYS,
  threadKey,
  type ThreadKind,
  type ThreadRef,
} from '../../platform/notifications/thread-ref';
import { kartaHref, newestRequestOn } from '../calc/card-door';
import { canWriteDeal } from '../deals/door';
import { mayOpenLead } from './lead-door';
import { threadDoorsFor } from './thread-door';
import { involvedInDeal, involvementOf, plainSeller } from './thread-involvement';

/**
 * The staff thread's writer and its reads (the owner's E answers,
 * 2026-10-07; docs in thread-ref.ts and thread-door.ts).
 *
 * The three 0127 columns of `crm_activities` (`calc_request_id`,
 * `tg_chat_id`, `tg_message_id`) are NOT declared on the drizzle table this
 * release: drizzle names every declared column in every INSERT, every bare
 * RETURNING and every whole-row select, and those statements are every note
 * writer in the app — on a database one migration behind they would all turn
 * into 42703 (#472). So this file and `thread-reply.ts` are the ONLY places
 * the columns are named bare, in raw SQL, and every caller of both catches
 * `isServerBehind`; everybody else reads them through `to_jsonb(row)`, which
 * answers NULL instead of failing on an old schema.
 */

export class ThreadError extends Error {
  constructor(readonly code: 'forbidden' | 'empty' | 'too_long' | 'not_found') {
    super(code);
    this.name = 'ThreadError';
  }
}

/**
 * What the calc Q&A box is told (§3.4) — here and not in the `'use server'`
 * action file, which may export async functions only. Every code is a
 * `threads.errors.*` / `threads.unreachable.*` key in all four bundles
 * (#163 — the locale test reads these lists).
 */
export type UnreachableReason = 'no_door' | 'no_chat' | 'muted';
export const UNREACHABLE_REASONS: readonly UnreachableReason[] = ['no_door', 'no_chat', 'muted'];

export type CalcThreadError = 'forbidden' | 'empty' | 'too_long' | 'not_found' | 'server_behind' | 'save_failed';
export const CALC_THREAD_ERRORS: readonly CalcThreadError[] = [
  'forbidden',
  'empty',
  'too_long',
  'not_found',
  'server_behind',
  'save_failed',
];

export interface CalcThreadState {
  ok?: boolean;
  error?: CalcThreadError;
  unreachable?: { name: string; reason: UnreachableReason }[];
  noAudience?: boolean;
  /** A fresh value on every success, so the box clears exactly once per send. */
  sent?: number;
}

export interface ThreadMessage {
  id: string;
  body: string;
  at: Date;
  authorId: string | null;
  authorName: string | null;
  /** Landed from a Telegram reply — the bubble says so. */
  viaTelegram: boolean;
}

type CardKind = 'lead' | 'deal' | 'client';

/**
 * A timestamp as the read mark's instant (thread-ref.ts `THREAD_INSTANT`):
 * UTC to the microsecond, spelled by postgres itself — never through a JS
 * Date, which would drop the microseconds and put the mark BEFORE its note.
 */
function instantSql(expr: SqlFragment): SqlFragment {
  return sql`to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** A raw timestamp is TEXT through `db.execute` (history.ts's lesson) — a Date here, always. */
function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** Where a thread message is WRITTEN: the card itself, or the request's card of the moment. */
async function targetOf(
  executor: Pick<typeof db, 'execute'>,
  ref: ThreadRef,
): Promise<{ entityType: CardKind; entityId: string; calcRequestId: string | null } | null> {
  if (!THREAD_UUID.test(ref.id)) return null;
  if (ref.kind === 'calc') {
    const rows = await executor.execute<{ entity_type: string; entity_id: string }>(sql`
      SELECT entity_type, entity_id::text AS entity_id FROM calc_requests WHERE id = ${ref.id}::uuid
    `);
    const row = rows[0];
    if (!row || (row.entity_type !== 'lead' && row.entity_type !== 'deal')) return null;
    return { entityType: row.entity_type, entityId: row.entity_id, calcRequestId: ref.id.toLowerCase() };
  }
  const table = ref.kind === 'lead' ? sql`leads` : ref.kind === 'deal' ? sql`deals` : sql`clients`;
  const rows = await executor.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = ${ref.id}::uuid) AS ok
  `);
  if (!rows[0]?.ok) return null;
  return { entityType: ref.kind, entityId: ref.id.toLowerCase(), calcRequestId: null };
}

/**
 * Write one thread message — the ONE writer that sets the tag or the
 * Telegram pair (`addActivity` stays the lenta's, unchanged).
 *
 * One transaction, raw: the INSERT names the new columns itself (they are not
 * drizzle's, see above) and carries the partial-index conflict clause, so a
 * re-delivered Telegram update writes nothing the second time and says so
 * (`duplicate`) — NOTHING else is written then, no audit row and, by the
 * caller, no ping. The audit row is `addActivity`'s own shape, in the same tx.
 * No pooled read inside the transaction (#714): every read goes through `tx`.
 */
export async function addThreadMessage(
  input: { ref: ThreadRef; body: string; tg?: { chatId: bigint; messageId: number } },
  ctx: AuditContext,
): Promise<{
  activityId: string;
  entityType: CardKind;
  entityId: string;
  calcRequestId: string | null;
  duplicate: boolean;
}> {
  const body = input.body.trim();
  if (!body) throw new ThreadError('empty');
  if (body.length > THREAD_TEXT_MAX) throw new ThreadError('too_long');
  const tgChat = input.tg ? input.tg.chatId.toString() : null;
  const tgMessage = input.tg ? String(input.tg.messageId) : null;

  const out = await db.transaction(async (tx) => {
    const target = await targetOf(tx, input.ref);
    if (!target) throw new ThreadError('not_found');
    // The id is the schema's own (`id()` mints a uuidv7 in the application —
    // the column has NO database default, so a raw INSERT must bring one).
    const inserted = await tx.execute<{ id: string; created_at: string }>(sql`
      INSERT INTO crm_activities
        (id, entity_type, entity_id, kind, note, happened_at, created_by, calc_request_id, tg_chat_id, tg_message_id)
      VALUES
        (${uuidv7()}::uuid, ${target.entityType}, ${target.entityId}::uuid, 'note', ${body}, now(), ${ctx.actorId}::uuid,
         ${target.calcRequestId}::uuid, ${tgChat}::bigint, ${tgMessage}::bigint)
      ON CONFLICT (tg_chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL DO NOTHING
      RETURNING id::text AS id, ${instantSql(sql`created_at`)} AS created_at
    `);
    const id = inserted[0]?.id;
    if (!id) {
      // The same Telegram message landed before: point at THAT note, write nothing.
      const existing = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM crm_activities
         WHERE tg_chat_id = ${tgChat}::bigint AND tg_message_id = ${tgMessage}::bigint
      `);
      return { ...target, activityId: existing[0]?.id ?? '', duplicate: true, createdAt: null };
    }
    await writeAudit(tx, ctx, {
      entityType: `crm_${target.entityType}_activity`,
      entityId: target.entityId,
      action: 'create',
      after: {
        kind: 'note',
        note: body.slice(0, 200),
        ...(target.calcRequestId ? { calcRequestId: target.calcRequestId } : {}),
        ...(input.tg ? { viaTelegram: true } : {}),
      },
    });
    return { ...target, activityId: id, duplicate: false, createdAt: inserted[0]!.created_at };
  });

  // Your own message is read — up to ITSELF, after the commit, and never
  // failing the write.
  const { createdAt, ...result } = out;
  if (createdAt && ctx.actorId) {
    await markThreadRead(ctx.actorId, input.ref, createdAt).catch((err: unknown) =>
      logger.warn({ err, activityId: out.activityId }, '[thread] own read mark failed'),
    );
  }
  return result;
}

/**
 * Mark a thread read for one person — UP TO WHAT WAS DRAWN. `asOf` is the
 * moment of the newest message the screen rendered (`threadReadMarks`), never
 * the moment the mark arrives: the POST lands seconds after the render (a
 * fold toggled open, minutes), and a note committed in between was never on
 * the screen — stamping `now()` read it for the person, and its ● never
 * appeared anywhere. REQUIRED: a mark with no «as of» is exactly that defect.
 * `LEAST(now(), …)`: the instant comes from a browser and a future one would
 * read tomorrow's notes in advance. `GREATEST` (tg_chat_reads' shape, 0071):
 * an out-of-order write — two tabs, a slow request — never moves it back.
 */
export async function markThreadRead(userId: string, ref: ThreadRef, asOf: string): Promise<void> {
  if (!THREAD_UUID.test(userId) || !THREAD_UUID.test(ref.id) || !THREAD_INSTANT.test(asOf)) return;
  await db.execute(sql`
    INSERT INTO thread_reads (user_id, thread_kind, thread_id, read_at)
    VALUES (${userId}::uuid, ${ref.kind}, ${ref.id}::uuid, LEAST(now(), ${asOf}::timestamptz))
    ON CONFLICT (user_id, thread_kind, thread_id)
    DO UPDATE SET read_at = GREATEST(thread_reads.read_at, EXCLUDED.read_at)
  `);
}

/**
 * The «as of» each thread's read mark carries (`markThreadRead`): the newest
 * message of the thread at the moment the PAGE asked — awaited by the page
 * BEFORE it renders the list, so whatever the list draws is at least this new
 * and a note that lands later stays ● until a render that shows it. Null for
 * a thread with no message (nothing to mark). A database one migration behind
 * answers an empty list: the mark is a convenience, never a reason for an
 * error on the card (#472).
 */
export async function threadReadMarks<R extends ThreadRef>(refs: readonly R[]): Promise<(R & { asOf: string | null })[]> {
  const out: (R & { asOf: string | null })[] = [];
  try {
    for (const ref of refs) {
      if (!THREAD_UUID.test(ref.id)) continue;
      const where =
        ref.kind === 'calc'
          ? sql`a.calc_request_id = ${ref.id}::uuid`
          : sql`a.entity_type = ${ref.kind} AND a.entity_id = ${ref.id}::uuid AND a.calc_request_id IS NULL`;
      const rows = await db.execute<{ at: string | null }>(sql`
        SELECT ${instantSql(sql`max(a.created_at)`)} AS at FROM crm_activities a WHERE ${where} AND a.kind = 'note'
      `);
      out.push({ ...ref, asOf: rows[0]?.at ?? null });
    }
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    return [];
  }
  return out;
}

/** The read mark's «as of» out of a pulse token (`threadToken`, `n:<iso>`) — null when the thread is empty. */
export function asOfOfToken(token: string): string | null {
  const at = token.slice(token.indexOf(':') + 1);
  return at ? at : null;
}

/** One calculation's Q&A, in reading order — E5 a: ONLY that calculation's notes. */
export async function calcThreadMessages(requestId: string, limit = 100): Promise<ThreadMessage[]> {
  if (!THREAD_UUID.test(requestId)) return [];
  const rows = await db.execute<{
    id: string;
    note: string;
    at: string | Date;
    created_by: string | null;
    author: string | null;
    via_telegram: boolean;
  }>(sql`
    SELECT * FROM (
      SELECT a.id::text AS id, a.note, a.happened_at AS at, a.created_by::text AS created_by,
             u.full_name AS author, (a.tg_message_id IS NOT NULL) AS via_telegram, a.created_at
        FROM crm_activities a
        LEFT JOIN users u ON u.id = a.created_by
       WHERE a.calc_request_id = ${requestId}::uuid AND a.kind = 'note'
       ORDER BY a.happened_at DESC, a.created_at DESC
       LIMIT ${limit}
    ) newest
    ORDER BY newest.at ASC, newest.created_at ASC
  `);
  return rows.map((row) => ({
    id: row.id,
    body: row.note,
    at: asDate(row.at),
    authorId: row.created_by,
    authorName: row.author,
    viaTelegram: Boolean(row.via_telegram),
  }));
}

/**
 * Everyone who has written in one calculation's Q&A — the calc audience's
 * participants (internal-chat.ts asks it here, because only this file names
 * the tag bare). A machine's note has no author and is nobody.
 */
export async function calcThreadAuthors(requestId: string): Promise<string[]> {
  if (!THREAD_UUID.test(requestId)) return [];
  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT a.created_by::text AS id FROM crm_activities a
     WHERE a.calc_request_id = ${requestId}::uuid AND a.created_by IS NOT NULL
  `);
  return rows.map((row) => row.id);
}

/** «Unread» for one reader, DERIVED: the newest note is somebody else's and later than my mark. */
function unreadSql(viewerId: string, kind: ThreadKind, threadId: SqlFragment, lastBy: SqlFragment, lastAt: SqlFragment) {
  return sql`(${lastAt} IS NOT NULL
    AND ${lastBy} IS DISTINCT FROM ${viewerId}::uuid
    AND NOT EXISTS (
      SELECT 1 FROM thread_reads tr
       WHERE tr.user_id = ${viewerId}::uuid AND tr.thread_kind = ${kind} AND tr.thread_id = ${threadId}
         AND tr.read_at >= ${lastAt}
    ))`;
}
type SqlFragment = ReturnType<typeof sql>;

export interface CardCalcThread {
  requestId: string;
  section: string | null;
  open: boolean;
  count: number;
  unread: boolean;
  /** The newest message's moment as this list read it — the fold's read-mark «as of». */
  lastAt: string | null;
}

/**
 * The calculations whose Q&A a lead or deal card folds (§3.5 b): every
 * request standing on the card that is OPEN or has ≥1 tagged note, newest
 * first, at most five — with the count and «new» for this reader.
 */
export async function calcThreadsOnCard(
  entity: { entityType: 'lead' | 'deal'; entityId: string },
  viewerId: string,
): Promise<CardCalcThread[]> {
  if (!THREAD_UUID.test(entity.entityId) || !THREAD_UUID.test(viewerId)) return [];
  const rows = await db.execute<{
    id: string;
    section: string | null;
    open: boolean;
    count: number | string;
    unread: boolean;
    last_at: string | null;
  }>(sql`
    SELECT r.id::text AS id, r.section, (r.completed_at IS NULL) AS open, s.count, ${instantSql(sql`s.last_at`)} AS last_at,
           ${unreadSql(viewerId, 'calc', sql`r.id`, sql`last.created_by`, sql`last.created_at`)} AS unread
      FROM calc_requests r
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS count, max(a.created_at) AS last_at FROM crm_activities a
         WHERE a.calc_request_id = r.id AND a.kind = 'note'
      ) s
      LEFT JOIN LATERAL (
        SELECT a.created_by, a.created_at FROM crm_activities a
         WHERE a.calc_request_id = r.id AND a.kind = 'note'
         ORDER BY a.happened_at DESC, a.created_at DESC
         LIMIT 1
      ) last ON true
     WHERE r.entity_type = ${entity.entityType} AND r.entity_id = ${entity.entityId}::uuid
       AND (r.completed_at IS NULL OR s.count > 0)
     ORDER BY r.requested_at DESC
     LIMIT 5
  `);
  return rows.map((row) => ({
    requestId: row.id,
    section: row.section,
    open: Boolean(row.open),
    count: Number(row.count),
    unread: Boolean(row.unread),
    lastAt: row.last_at ?? null,
  }));
}

/** The calc page's jump chip: how many messages, and whether one is new to this reader. */
export async function calcThreadSummary(
  requestId: string,
  viewerId: string,
): Promise<{ count: number; unread: boolean }> {
  if (!THREAD_UUID.test(requestId) || !THREAD_UUID.test(viewerId)) return { count: 0, unread: false };
  const rows = await db.execute<{ count: number | string; unread: boolean }>(sql`
    SELECT s.count,
           ${unreadSql(viewerId, 'calc', sql`${requestId}::uuid`, sql`last.created_by`, sql`last.created_at`)} AS unread
      FROM (SELECT count(*)::int AS count FROM crm_activities a
             WHERE a.calc_request_id = ${requestId}::uuid AND a.kind = 'note') s
      LEFT JOIN LATERAL (
        SELECT a.created_by, a.created_at FROM crm_activities a
         WHERE a.calc_request_id = ${requestId}::uuid AND a.kind = 'note'
         ORDER BY a.happened_at DESC, a.created_at DESC
         LIMIT 1
      ) last ON true
  `);
  return { count: Number(rows[0]?.count ?? 0), unread: Boolean(rows[0]?.unread) };
}

/**
 * «An OPEN request stands on this card AND has a question in the window» —
 * the lenta box's hint (§3.5 c): a seller answering in the ordinary lenta box
 * right under the VED's question would answer nobody, so the box says where.
 */
export async function openCalcThreadOn(entity: { entityType: 'lead' | 'deal'; entityId: string }): Promise<boolean> {
  if (!THREAD_UUID.test(entity.entityId)) return false;
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM calc_requests r
       WHERE r.entity_type = ${entity.entityType} AND r.entity_id = ${entity.entityId}::uuid
         AND r.completed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM crm_activities a
            WHERE a.calc_request_id = r.id AND a.kind = 'note'
              AND a.happened_at >= now() - make_interval(days => ${THREAD_WINDOW_DAYS})
         )
    ) AS ok
  `);
  return Boolean(rows[0]?.ok);
}

/** The pulse's token: the thread's note count and its newest moment. */
export async function threadToken(ref: ThreadRef): Promise<string> {
  if (!THREAD_UUID.test(ref.id)) return '0:';
  const where =
    ref.kind === 'calc'
      ? sql`a.calc_request_id = ${ref.id}::uuid`
      : sql`a.entity_type = ${ref.kind} AND a.entity_id = ${ref.id}::uuid AND a.calc_request_id IS NULL`;
  const rows = await db.execute<{ n: number | string; at: string | null }>(sql`
    SELECT count(*)::int AS n, ${instantSql(sql`max(a.created_at)`)} AS at
      FROM crm_activities a WHERE ${where} AND a.kind = 'note'
  `);
  const row = rows[0];
  // The newest moment to the microsecond: the calc page's read mark is taken
  // out of this token (`asOfOfToken`), and a millisecond one sits before its note.
  return `${Number(row?.n ?? 0)}:${row?.at ?? ''}`;
}

/** What a viewer the href rule needs: who, and the grants. */
interface Viewer {
  id: string;
  permissions: { has(code: string): boolean };
}

/**
 * The ONE href rule for a thread (§3.7) — the dock's rows, the lenta's
 * «🧮 Hisob savoli» chip and nothing else may invent one. Null when the
 * viewer could not open what it would point at: a row whose link bounces is a
 * dead door.
 *
 *   lead   → the CRM card `#ichki` when it admits the viewer, else the karta
 *            for a calc-card VED, else nothing;
 *   deal   → `/bitimlar/<id>#ichki` for whoever the deal card admits;
 *   client → `/admin/clients/<id>#ichki` (the thread door implies the card's);
 *   calc   → `/hisoblash/<id>#savol` for `ved.docs`, else the request's
 *            CURRENT card's fold `#calc-thread-<id>` when that card admits the
 *            viewer, else nothing.
 */
export async function threadHrefsFor(viewer: Viewer, refs: readonly ThreadRef[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const valid = refs.filter((ref) => THREAD_UUID.test(ref.id));
  const reader = { id: viewer.id, permissions: viewer.permissions as ReadonlySet<string> };
  const leadIds = [...new Set(valid.filter((r) => r.kind === 'lead').map((r) => r.id.toLowerCase()))];
  const calcIds = [...new Set(valid.filter((r) => r.kind === 'calc').map((r) => r.id.toLowerCase()))];
  const ids = (list: string[]) => sql.join(list.map((id) => sql`${id}::uuid`), sql`, `);
  const [leadRows, calcRows] = await Promise.all([
    leadIds.length
      ? db.execute<{ id: string; owner_id: string | null }>(sql`
          SELECT id::text AS id, owner_id::text AS owner_id FROM leads WHERE id IN (${ids(leadIds)})
        `)
      : Promise.resolve([] as { id: string; owner_id: string | null }[]),
    calcIds.length
      ? db.execute<{ id: string; entity_type: string; entity_id: string; owner_id: string | null }>(sql`
          SELECT r.id::text AS id, r.entity_type, r.entity_id::text AS entity_id, l.owner_id::text AS owner_id
            FROM calc_requests r
            LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
           WHERE r.id IN (${ids(calcIds)})
        `)
      : Promise.resolve([] as { id: string; entity_type: string; entity_id: string; owner_id: string | null }[]),
  ]);
  const owners = new Map(leadRows.map((r) => [r.id, r.owner_id] as const));
  const requests = new Map(calcRows.map((r) => [r.id, r] as const));
  for (const ref of valid) {
    const id = ref.id.toLowerCase();
    let href: string | null = null;
    if (ref.kind === 'lead') {
      if (owners.has(id) && mayOpenLead(reader, { ownerId: owners.get(id) ?? null })) {
        href = `/crm/leads/${id}#ichki`;
      } else if (owners.has(id) && viewer.permissions.has('ved.docs')) {
        const requestId = await newestRequestOn({ entityType: 'lead', entityId: id });
        href = requestId ? `${kartaHref(requestId, id)}#ichki` : null;
      }
    } else if (ref.kind === 'deal') {
      href = canWriteDeal(viewer.permissions) ? `/bitimlar/${id}#ichki` : null;
    } else if (ref.kind === 'client') {
      href = `/admin/clients/${id}#ichki`;
    } else {
      const request = requests.get(id);
      if (viewer.permissions.has('ved.docs')) href = request ? `/hisoblash/${id}#savol` : null;
      else if (request?.entity_type === 'lead' && mayOpenLead(reader, { ownerId: request.owner_id })) {
        href = `/crm/leads/${request.entity_id}#calc-thread-${id}`;
      } else if (request?.entity_type === 'deal' && canWriteDeal(viewer.permissions)) {
        href = `/bitimlar/${request.entity_id}#calc-thread-${id}`;
      }
    }
    out.set(threadKey(ref), href);
  }
  return out;
}

export async function threadHref(viewer: Viewer, ref: ThreadRef): Promise<string | null> {
  return (await threadHrefsFor(viewer, [ref])).get(threadKey(ref)) ?? null;
}

export interface DockThreadRow {
  kind: ThreadKind;
  id: string;
  label: string;
  /** A calculation's section (the dock names it in the reader's language), else null. */
  section: string | null;
  /** The newest message's author and its first 120 characters. */
  author: string | null;
  excerpt: string;
  at: string | null;
  unread: boolean;
  href: string;
}

/**
 * The ping types as LITERALS, not parameters: `notifications_thread_idx` is
 * partial on exactly this list, and the planner can prove a partial index's
 * predicate only from constants — postgres.js prepares its statements, and a
 * generic plan over `type IN ($2, $3, $4)` would walk every notification the
 * person has ever had. The values are this module's own constants, never
 * input; thread-wire.test pins the index's list to `THREAD_PING_TYPES`.
 */
const THREAD_PING_LIST = sql.raw(THREAD_PING_TYPES.map((type) => `'${type}'`).join(', '));

/**
 * How many of the newest rows of EACH source the dock reads before grouping
 * them into threads. Measured (680 000 notifications, one seller holding
 * 50 000 of them, 5 000 notes he wrote): unbounded, the statement read every
 * one of his rows — 110 ms when one in ten is a ping, 230 ms at three in five;
 * bounded through the two partial indexes, 9.4 ms and 6.6 ms. The cost,
 * stated: a thread whose only touches lie behind a thousand newer ones falls
 * off the dock — it is still on its card.
 */
const DOCK_SCAN_ROWS = 1000;

/**
 * «👥 Ichki» — the threads I am in (§3.7): those I WROTE in and those I was
 * PINGED about, in the window, newest touch first; the newest message of
 * each, whether it is new to me, and — through `threadDoorsFor` — only the
 * ones I may READ. A mention-only addressee and a standing-only owner reply
 * from Telegram and are not shown the card's thread here (E2 a's «reply
 * only»); a lead handed away from me vanishes (E9 a). A muted ping still
 * lists: the row exists, and the dock is exactly where a muter reads.
 *
 * ONE statement for the candidates, the last message and the read state; the
 * two LATERAL arms are separate (card notes by `crm_activities_entity_idx`,
 * calc notes by `crm_activities_calc_idx`) — an OR between them would defeat
 * both indexes.
 */
export async function myThreads(viewer: Viewer, limit = 30): Promise<DockThreadRow[]> {
  if (!THREAD_UUID.test(viewer.id)) return [];
  const rows = await db.execute<{
    kind: ThreadKind;
    id: string;
    last_note: string | null;
    last_at: string | Date | null;
    last_by: string | null;
    author: string | null;
    unread: boolean;
  }>(sql`
    WITH mine AS (
      SELECT kind, id, max(touched) AS touched FROM (
        SELECT CASE WHEN a.calc_request_id IS NOT NULL THEN 'calc' ELSE a.entity_type END AS kind,
               COALESCE(a.calc_request_id, a.entity_id) AS id,
               a.created_at AS touched
          FROM crm_activities a
         WHERE a.created_by = ${viewer.id}::uuid
           AND a.kind = 'note'
           AND a.happened_at >= now() - make_interval(days => ${THREAD_WINDOW_DAYS})
         ORDER BY a.happened_at DESC
         LIMIT ${DOCK_SCAN_ROWS}
      ) m GROUP BY 1, 2
    ), pinged AS (
      SELECT kind, id::uuid AS id, max(touched) AS touched FROM (
        SELECT n.payload -> 'thread' ->> 'kind' AS kind,
               n.payload -> 'thread' ->> 'id' AS id,
               n.created_at AS touched
          FROM notifications n
         WHERE n.user_id = ${viewer.id}::uuid
           AND n.type IN (${THREAD_PING_LIST})
           AND n.created_at >= now() - make_interval(days => ${THREAD_WINDOW_DAYS})
           AND n.payload ? 'thread'
           AND n.payload -> 'thread' ->> 'kind' IN ('lead', 'deal', 'client', 'calc')
           -- Checked inside, before the outer cast: one malformed payload must not 22P02 the dock.
           AND n.payload -> 'thread' ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         ORDER BY n.created_at DESC
         LIMIT ${DOCK_SCAN_ROWS}
      ) p GROUP BY 1, 2
    ), cand AS (
      SELECT kind, id, max(touched) AS touched
        FROM (SELECT * FROM mine UNION ALL SELECT * FROM pinged) x
       GROUP BY 1, 2
       ORDER BY 3 DESC
       LIMIT 60
    )
    SELECT c.kind, c.id::text AS id,
           COALESCE(card.note, calc.note) AS last_note,
           COALESCE(card.created_at, calc.created_at) AS last_at,
           COALESCE(card.created_by, calc.created_by)::text AS last_by,
           u.full_name AS author,
           (COALESCE(card.created_at, calc.created_at) IS NOT NULL
             AND COALESCE(card.created_by, calc.created_by) IS DISTINCT FROM ${viewer.id}::uuid
             AND NOT EXISTS (
               SELECT 1 FROM thread_reads tr
                WHERE tr.user_id = ${viewer.id}::uuid AND tr.thread_kind = c.kind AND tr.thread_id = c.id
                  AND tr.read_at >= COALESCE(card.created_at, calc.created_at)
             )) AS unread
      FROM cand c
      LEFT JOIN LATERAL (
        SELECT a.note, a.created_at, a.created_by FROM crm_activities a
         WHERE c.kind <> 'calc' AND a.entity_type = c.kind AND a.entity_id = c.id
           AND a.calc_request_id IS NULL AND a.kind = 'note'
         ORDER BY a.happened_at DESC
         LIMIT 1
      ) card ON true
      LEFT JOIN LATERAL (
        SELECT a.note, a.created_at, a.created_by FROM crm_activities a
         WHERE c.kind = 'calc' AND a.calc_request_id = c.id AND a.kind = 'note'
         ORDER BY a.happened_at DESC
         LIMIT 1
      ) calc ON true
      LEFT JOIN users u ON u.id = COALESCE(card.created_by, calc.created_by)
     ORDER BY COALESCE(card.created_at, calc.created_at, c.touched) DESC
  `);

  const refs = rows.map((row) => ({ kind: row.kind, id: row.id }));
  const [admitted, hrefs, involved] = await Promise.all([
    threadDoorsFor(viewer, refs),
    threadHrefsFor(viewer, refs),
    stillInvolved(viewer, refs),
  ]);
  const visible = rows
    .filter((row) => admitted.has(threadKey(row)) && hrefs.get(threadKey(row)) && involved(row))
    .slice(0, limit);
  const labels = await threadLabels(visible.map((row) => ({ kind: row.kind, id: row.id })));
  return visible.map((row) => ({
    kind: row.kind,
    id: row.id,
    label: labels.get(threadKey(row))?.label ?? '—',
    section: labels.get(threadKey(row))?.section ?? null,
    author: row.author,
    excerpt: (row.last_note ?? '').slice(0, 120),
    at: row.last_at ? asDate(row.last_at).toISOString() : null,
    unread: Boolean(row.unread),
    href: hrefs.get(threadKey(row))!,
  }));
}

/**
 * E9 on deal and client threads, from the DOCK's side (§3.4 filter 2): their
 * doors have no ownership, so a plain seller who once wrote on a client whose
 * lead went to a colleague is still admitted by the door — and the audience
 * has stopped pinging him. The list must agree with the ping, or his dock
 * goes on showing a ● on every message of a conversation he left. The SAME
 * relation the audience asks (`thread-involvement.ts`), and the same
 * exemptions: only a plain seller is judged, never a lead thread (the door
 * does E9 there), and a calculation's requester is never judged (he asked).
 */
async function stillInvolved(
  viewer: Viewer,
  refs: readonly ThreadRef[],
): Promise<(ref: ThreadRef) => boolean> {
  if (!plainSeller(viewer.permissions)) return () => true;
  const dealIds = [...new Set(refs.filter((r) => r.kind === 'deal').map((r) => r.id.toLowerCase()))];
  const calcIds = [...new Set(refs.filter((r) => r.kind === 'calc').map((r) => r.id.toLowerCase()))];
  if (!refs.some((r) => r.kind === 'client') && dealIds.length === 0 && calcIds.length === 0) return () => true;
  const ids = (list: string[]) => sql.join(list.map((id) => sql`${id}::uuid`), sql`, `);
  const [mine, dealRows, calcRows] = await Promise.all([
    involvementOf(viewer.id),
    dealIds.length
      ? db.execute<{ id: string; client_id: string | null }>(sql`
          SELECT id::text AS id, client_id::text AS client_id FROM deals WHERE id IN (${ids(dealIds)})
        `)
      : Promise.resolve([] as { id: string; client_id: string | null }[]),
    calcIds.length
      ? db.execute<{ id: string; requested_by: string | null; deal_id: string | null; client_id: string | null }>(sql`
          SELECT r.id::text AS id, r.requested_by::text AS requested_by,
                 d.id::text AS deal_id, d.client_id::text AS client_id
            FROM calc_requests r
            LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
           WHERE r.id IN (${ids(calcIds)})
        `)
      : Promise.resolve([] as { id: string; requested_by: string | null; deal_id: string | null; client_id: string | null }[]),
  ]);
  const dealClient = new Map(dealRows.map((r) => [r.id, r.client_id] as const));
  const calcs = new Map(calcRows.map((r) => [r.id, r] as const));
  return (ref) => {
    const id = ref.id.toLowerCase();
    if (ref.kind === 'client') return mine.clients.has(id);
    if (ref.kind === 'deal') return involvedInDeal(mine, { id, clientId: dealClient.get(id) ?? null });
    if (ref.kind === 'calc') {
      const calc = calcs.get(id);
      // A calculation on a LEAD is the lead's door's; one he asked for is his.
      if (!calc?.deal_id || calc.requested_by === viewer.id) return true;
      return involvedInDeal(mine, { id: calc.deal_id, clientId: calc.client_id });
    }
    return true;
  };
}

/** What to call each thread on a list — one query per kind present. */
export async function threadLabels(
  refs: readonly ThreadRef[],
): Promise<Map<string, { label: string; section: string | null }>> {
  const out = new Map<string, { label: string; section: string | null }>();
  const idsOf = (kind: ThreadKind) => [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id.toLowerCase()))];
  const list = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const [leadIds, dealIds, clientIds, calcIds] = [idsOf('lead'), idsOf('deal'), idsOf('client'), idsOf('calc')];
  const [leadRows, dealRows, clientRows, calcRows] = await Promise.all([
    leadIds.length
      ? db.execute<{ id: string; label: string }>(sql`SELECT id::text AS id, name AS label FROM leads WHERE id IN (${list(leadIds)})`)
      : Promise.resolve([] as { id: string; label: string }[]),
    dealIds.length
      ? db.execute<{ id: string; label: string }>(sql`
          SELECT id::text AS id, code || COALESCE(' ' || NULLIF(title, ''), '') AS label FROM deals WHERE id IN (${list(dealIds)})
        `)
      : Promise.resolve([] as { id: string; label: string }[]),
    clientIds.length
      ? db.execute<{ id: string; label: string }>(sql`
          SELECT id::text AS id, client_code || ' ' || name AS label FROM clients WHERE id IN (${list(clientIds)})
        `)
      : Promise.resolve([] as { id: string; label: string }[]),
    calcIds.length
      ? db.execute<{ id: string; label: string; section: string | null }>(sql`
          SELECT r.id::text AS id, r.section,
                 COALESCE(l.name, d.code || COALESCE(' ' || NULLIF(d.title, ''), ''), '—') AS label
            FROM calc_requests r
            LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
            LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
           WHERE r.id IN (${list(calcIds)})
        `)
      : Promise.resolve([] as { id: string; label: string; section: string | null }[]),
  ]);
  for (const row of leadRows) out.set(`lead:${row.id}`, { label: row.label, section: null });
  for (const row of dealRows) out.set(`deal:${row.id}`, { label: row.label, section: null });
  for (const row of clientRows) out.set(`client:${row.id}`, { label: row.label, section: null });
  for (const row of calcRows) out.set(`calc:${row.id}`, { label: `🧮 ${row.label}`, section: row.section });
  return out;
}
