import { createHash } from 'node:crypto';
import { desc, eq, gte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { systemErrors, users } from '../db/schema';
import { sideSql } from '../db/side';
import { hashToken, SESSION_COOKIE } from '../auth/session';
import { clipText } from '../telegram/format';
import { logger } from '../logger';

/**
 * «Tizim xatolari» — the server's own errors, kept where the owner can look
 * one up (B9).
 *
 * A staff member's screenshot carries «#2832070603» and nothing else — the
 * error page shows the digest on purpose (round 100's item 7 was one), and
 * until now that number led nowhere without somebody reading `docker logs`
 * on the server. Every server error Next reports goes through
 * `instrumentation.ts` → `recordRequestError` → one COUNTED row per digest,
 * and `/admin/xatolar` answers the number.
 *
 * WHY each shape:
 *  - the SIDE connection (`db/side.ts`), never the pool: the error being
 *    recorded may BE the pool freeze (#714), and a recorder queued behind the
 *    ten connections it is reporting on records nothing;
 *  - one row per key, `count + 1` on a repeat — an error in a loop must not
 *    fill the disk the database lives on;
 *  - two brakes in memory: the same key is written at most once per five
 *    seconds (one render error reaches the hook from BOTH the RSC render and
 *    the HTML render, and a hot page repeats it per request), and at most
 *    thirty writes a minute in all — the recorder must never become the load;
 *  - the path WITHOUT its query (queries carry phone numbers), the message
 *    clipped to 300 characters, the stack's head to 2 000, and no body or
 *    headers at all: messages still can hold a client's phone («Key (phone)=»),
 *    which is why the page is the super admin's alone and nothing here is
 *    ever pushed to Telegram.
 *
 * Next itself filters the router's own throws (`redirect()`, `notFound()`)
 * before it calls the hook (create-error-handler.js), so there is no skip
 * list here — a list of names that never arrive would be a comment pretending
 * to be code.
 */

export type ErrorKind = 'render' | 'action' | 'route' | 'other';

export interface ServerErrorInput {
  digest: string | null;
  kind: ErrorKind;
  /** The request path; the query is stripped before anything is stored. */
  path: string | null;
  /** Next's own route pattern, for a keyless route handler error. */
  routePath: string | null;
  message: string;
  stack: string | null;
  /** The raw `gsr_session` cookie value, hashed before it is used. */
  sessionToken: string | null;
}

/** The same key is written at most once in this window. */
export const SAME_KEY_QUIET_MS = 5_000;
/** At most this many writes a minute, whatever happens. */
export const WRITES_PER_MINUTE = 30;
/** How long a row is kept, and how many at most. */
export const ERROR_KEEP_DAYS = 30;
export const ERROR_KEEP_ROWS = 2_000;
/** «Tizim xatolari (24 soat)» — one window for the home row and the page. */
export const ERROR_RECENT_HOURS = 24;

/**
 * The watchdog (`ops/health-probe.mjs`) leaves this note before it kills a
 * stuck server; the next boot records it here and removes it. A restart keeps
 * the container's /tmp, a recreate does not — so a note never outlives the
 * container it describes. The probe restates the path; a unit test holds the
 * two equal.
 */
export const WATCHDOG_MARK_FILE = '/tmp/gsr-watchdog';

/**
 * Who may read the list: the super admin ROLE, the shape of `mayAnnul` — no
 * permission code separates him from an admin (both hold all of them) and
 * #170 forbids minting one. One predicate for the page, the hub door and the
 * home row.
 */
export function mayReadSystemErrors(actor: { roles: string[] }): boolean {
  return actor.roles.includes('super_admin');
}

/** Everything after the first `?` or `#` goes — a query can carry a phone. */
export function pathOnly(path: string | null): string | null {
  if (!path) return null;
  const cut = path.split(/[?#]/, 1)[0] ?? '';
  return cut.slice(0, 500) || null;
}

/**
 * The row's key. A render's digest is what the screenshot shows, so it IS the
 * key; a route handler carries no digest, so its key is the route and the
 * message hashed — the same fault on the same route counts on one row. Next
 * may append «@E123» to the digest it shows the BROWSER (its own error code);
 * the part before the «@» is the one the hook hands us, so that is kept.
 */
export function errorKey(input: { digest: string | null; routePath: string | null; message: string }): string {
  const digest = input.digest?.split('@', 1)[0]?.trim();
  if (digest) return digest;
  return createHash('sha1')
    .update(`${input.routePath ?? ''}|${input.message}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * What a person typed into the search: «#2832070603», «2832070603@E394» or the
 * bare digits all mean the same row. Anything that is not a plain token
 * answers nothing rather than a LIKE over every message.
 */
export function digestQuery(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? '').trim().replace(/^#+/, '').split('@', 1)[0]!.trim();
  return /^[A-Za-z0-9_-]{3,64}$/.test(cleaned) ? cleaned : null;
}

/** `gsr_session` out of a Cookie header (a string, or Node's string[]). */
export function sessionFromCookie(header: string | string[] | undefined): string | null {
  const line = Array.isArray(header) ? header.join('; ') : (header ?? '');
  for (const part of line.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return value || null;
    }
  }
  return null;
}

const brake = {
  lastByKey: new Map<string, number>(),
  windowStart: 0,
  windowWrites: 0,
};

/** Tests only: a fresh brake, so one case's writes do not silence the next. */
export function __resetErrorBrake(): void {
  brake.lastByKey.clear();
  brake.windowStart = 0;
  brake.windowWrites = 0;
}

/**
 * The two brakes, asked BEFORE anything is written — the same key inside five
 * seconds is the same occurrence reaching the hook twice, not a second one,
 * so it must not become `count + 1`.
 */
export function mayWrite(key: string, now: number): boolean {
  const last = brake.lastByKey.get(key);
  if (last !== undefined && now - last < SAME_KEY_QUIET_MS) return false;
  if (now - brake.windowStart >= 60_000) {
    brake.windowStart = now;
    brake.windowWrites = 0;
  }
  if (brake.windowWrites >= WRITES_PER_MINUTE) return false;
  brake.windowWrites += 1;
  brake.lastByKey.set(key, now);
  // The map is a memory, not a log: forget keys that are long quiet.
  if (brake.lastByKey.size > 500) {
    for (const [k, at] of brake.lastByKey) if (now - at > SAME_KEY_QUIET_MS) brake.lastByKey.delete(k);
  }
  return true;
}

/**
 * One error, counted. Never throws — a recorder that can take the request
 * down with it is worse than none — and answers whether a row was written.
 */
export async function recordServerError(input: ServerErrorInput, now = Date.now()): Promise<boolean> {
  try {
    const key = errorKey(input);
    if (!mayWrite(key, now)) return false;
    const message = clipText(input.message || '(xabarsiz xato)', 300);
    const stack = input.stack ? input.stack.slice(0, 2_000) : null;
    const path = pathOnly(input.path);
    const tokenHash = input.sessionToken ? hashToken(input.sessionToken) : null;
    const side = sideSql();
    // The person is resolved INSIDE the insert, from the session the request
    // carried — no second round trip, and a stale or forged cookie resolves
    // to nobody rather than to an error.
    await side`
      INSERT INTO system_errors (key, digest, kind, path, message, stack, user_id)
      VALUES (
        ${key}, ${input.digest ? key : null}, ${input.kind}, ${path}, ${message}, ${stack},
        (SELECT user_id FROM sessions
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > now()
          LIMIT 1)
      )
      ON CONFLICT (key) DO UPDATE SET
        count = system_errors.count + 1,
        last_seen_at = now(),
        path = COALESCE(EXCLUDED.path, system_errors.path),
        user_id = COALESCE(EXCLUDED.user_id, system_errors.user_id)`;
    return true;
  } catch (err) {
    logger.warn({ err }, 'system error not recorded');
    return false;
  }
}

/** The instrumentation hook's own shape, turned into one recorded row. */
export async function recordRequestError(
  error: unknown,
  request: Readonly<{ path: string; method: string; headers: NodeJS.Dict<string | string[]> }>,
  context: Readonly<{ routePath: string; routeType: string }>,
): Promise<void> {
  const err: Error & { digest?: unknown } = error instanceof Error ? error : new Error(String(error));
  const digest = typeof err.digest === 'string' ? err.digest : null;
  const kind: ErrorKind =
    context.routeType === 'render' || context.routeType === 'action' || context.routeType === 'route'
      ? context.routeType
      : 'other';
  await recordServerError({
    digest,
    kind,
    path: request.path,
    routePath: context.routePath,
    message: err.message,
    stack: err.stack ?? null,
    sessionToken: sessionFromCookie(request.headers.cookie),
  });
}

/**
 * The watchdog's note, if the last process was killed by it: recorded as one
 * «other» row and removed, so the owner reads «ilova qayta ishga tushirildi»
 * on the same page as the error that caused it.
 */
interface WatchdogNote {
  at?: string;
  reason?: string;
  failures?: number;
}

export async function recordWatchdogRestart(): Promise<void> {
  const { readFile, unlink } = await import('node:fs/promises');
  let note: WatchdogNote;
  try {
    note = JSON.parse(await readFile(WATCHDOG_MARK_FILE, 'utf8')) as WatchdogNote;
  } catch {
    return;
  }
  await unlink(WATCHDOG_MARK_FILE).catch(() => {});
  const reason = note?.reason ?? "noma'lum";
  const failures = Number(note?.failures ?? 0);
  await recordServerError({
    digest: null,
    kind: 'other',
    path: null,
    routePath: 'watchdog',
    message: `ilova qayta ishga tushirildi: ${reason} ×${failures}`,
    stack: note?.at ? `watchdog: ${note.at}` : null,
    sessionToken: null,
  });
}

export interface SystemErrorRow {
  key: string;
  digest: string | null;
  kind: string;
  path: string | null;
  message: string;
  stack: string | null;
  userName: string | null;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const errorColumns = {
  key: systemErrors.key,
  digest: systemErrors.digest,
  kind: systemErrors.kind,
  path: systemErrors.path,
  message: systemErrors.message,
  stack: systemErrors.stack,
  userName: users.fullName,
  count: systemErrors.count,
  firstSeenAt: systemErrors.firstSeenAt,
  lastSeenAt: systemErrors.lastSeenAt,
};

/** «Seen in the last 24 hours» — the home row's N and the page's first list. */
function recentSince(now: Date): Date {
  return new Date(now.getTime() - ERROR_RECENT_HOURS * 3_600_000);
}

export async function recentErrorCount(now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(systemErrors)
    .where(gte(systemErrors.lastSeenAt, recentSince(now)));
  return Number(row?.n ?? 0);
}

/**
 * The page's list. With a digest: that row, from the whole retained month.
 * Without: `recent` = the rows the home counted, else the newest of the month.
 */
export async function listSystemErrors(opts: {
  q?: string | null;
  recent?: boolean;
  limit?: number;
  now?: Date;
}): Promise<SystemErrorRow[]> {
  const base = db
    .select(errorColumns)
    .from(systemErrors)
    .leftJoin(users, eq(users.id, systemErrors.userId));
  if (opts.q !== undefined) {
    const needle = digestQuery(opts.q);
    if (!needle) return [];
    return base.where(or(eq(systemErrors.key, needle), eq(systemErrors.digest, needle))).limit(5);
  }
  const limit = opts.limit ?? 50;
  const rows = opts.recent
    ? base.where(gte(systemErrors.lastSeenAt, recentSince(opts.now ?? new Date())))
    : base;
  return rows.orderBy(desc(systemErrors.lastSeenAt)).limit(limit);
}

/**
 * A month and two thousand rows, whichever is smaller — pg-boss keeps its own
 * failed jobs a week and deletes them itself, so there is nothing of ours to
 * prune there.
 */
export async function pruneSystemErrors(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ERROR_KEEP_DAYS * 86_400_000).toISOString();
  const old = await db.execute<{ key: string }>(sql`
    DELETE FROM system_errors WHERE last_seen_at < ${cutoff}::timestamptz RETURNING key`);
  const overflow = await db.execute<{ key: string }>(sql`
    DELETE FROM system_errors WHERE key IN (
      SELECT key FROM system_errors ORDER BY last_seen_at DESC OFFSET ${ERROR_KEEP_ROWS})
    RETURNING key`);
  return old.length + overflow.length;
}

export interface FailedJobRow {
  name: string;
  count: number;
  lastAt: Date;
  lastMessage: string | null;
}

/**
 * The background jobs that gave up in the last week — pg-boss's own record,
 * read where it keeps it: a failed job stays in `pgboss.job` until its
 * archive pass, then lives in `pgboss.archive` until pg-boss deletes it. Both
 * tables are asked for by name first: a fresh test database has no pgboss
 * schema until something starts the boss.
 */
export async function failedJobs(days = 7): Promise<FailedJobRow[]> {
  const [present] = await db.execute<{ job: boolean; archive: boolean }>(sql`
    SELECT to_regclass('pgboss.job') IS NOT NULL AS job,
           to_regclass('pgboss.archive') IS NOT NULL AS archive`);
  const parts: SQL[] = [];
  if (present?.job) {
    parts.push(sql`SELECT name, completed_on, output FROM pgboss.job
      WHERE state = 'failed' AND completed_on > now() - make_interval(days => ${days})`);
  }
  if (present?.archive) {
    parts.push(sql`SELECT name, completed_on, output FROM pgboss.archive
      WHERE state = 'failed' AND completed_on > now() - make_interval(days => ${days})`);
  }
  if (parts.length === 0) return [];
  const rows = await db.execute<{ name: string; n: number; last_at: string; last_message: string | null }>(sql`
    SELECT name, count(*)::int AS n, max(completed_on) AS last_at,
           (array_agg(output->>'message' ORDER BY completed_on DESC))[1] AS last_message
      FROM (${sql.join(parts, sql` UNION ALL `)}) f
     GROUP BY name
     ORDER BY max(completed_on) DESC`);
  // Raw timestamps come back as TEXT (#923).
  return rows.map((r) => ({
    name: r.name,
    count: Number(r.n),
    lastAt: new Date(r.last_at),
    lastMessage: r.last_message,
  }));
}
