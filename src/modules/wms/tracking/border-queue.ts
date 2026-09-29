import { cache } from 'react';
import { eq, sql } from 'drizzle-orm';
import { writeAudit } from '../../platform/audit/service';
import { db, type Tx } from '../../platform/db/client';
import { isServerBehind } from '../../platform/db/errors';
import { borderQueue, users } from '../../platform/db/schema';
import type { Actor, ActorGrants } from '../../platform/rbac/authorize';
import type { BorderPost } from './engine';
import type { BorderHours } from './eta';
import { BORDER_POST_KEYS, BORDER_POSTS } from './map-data';
import { daysSince } from '../reports/dashboard-math';

/**
 * «Chegara navbatlari» — the queue at a border post as the logist typed it
 * (owner, 2026-09-29, answer 14: «sho yol ocheredda kutishlani qolda
 * kirgazish imkoni bolsa yahwi bolar edi ochered kamaysa tez otb ketadiku»).
 *
 * ONE number per post, and it moves every date at once: the customer's
 * «yetib keladi», the staff map, the bot's answer, the dashboard and the truck
 * card all read the schedule through `scheduleEstimate`, which takes these
 * hours as a REQUIRED argument. So the number is guarded twice — a 30-day cap
 * here and 720 hours in the table — and every save is audited with who typed
 * it. There is no confirmation step: he asked for the typed wait to count.
 *
 * A typed number counts until somebody changes it (the design's default (b));
 * after `BORDER_QUEUE_WARN_DAYS` Tashkent days the panel says how old it is,
 * and «Odatdagi jadvalga qaytarish» brings his usual days back.
 */

/** From this many Tashkent days the panel prints «⚠ N kun oldin kiritilgan». */
export const BORDER_QUEUE_WARN_DAYS = 3;

/** The 30-day cap on a typed wait — a «300» meant as hours stops here. */
const MAX_DAYS = 30;
const NOTE_MAX = 300;

const isPost = (post: string): post is BorderPost => Object.hasOwn(BORDER_POSTS, post);

/**
 * The typed queues as the schedule needs them: the hours, WHEN they took
 * effect (`hours_since` — never `updated_at`, which a note edit moves), and
 * the regime before them. No names and no notes — this reaches the customer's
 * cabinet and the bot, and who typed a number is the logist's trail, not the
 * customer's business.
 *
 * Once per request (React `cache`, no arguments — so every reader on one page
 * shares one read), on the pool: none of its callers is inside a transaction
 * (#714). A range that breaks the table's own rules — an unknown post, a
 * range upside down — is skipped rather than trusted: the default is always
 * an honest answer, a nonsense wait never is. A reset row is kept (its hours
 * are the default, counted from the reset for the trucks queueing at that
 * moment) only while it carries the regime it replaced; with nothing before
 * it, it IS the default.
 *
 * `server_behind` (the table not migrated yet — deploy morning, #472) reads
 * as «nothing typed», i.e. exactly today's dates.
 */
export const loadBorderHours = cache(async function loadBorderHours(): Promise<BorderHours> {
  try {
    const rows = await db
      .select({
        post: borderQueue.post,
        minHours: borderQueue.minHours,
        maxHours: borderQueue.maxHours,
        hoursSince: borderQueue.hoursSince,
        prevMinHours: borderQueue.prevMinHours,
        prevMaxHours: borderQueue.prevMaxHours,
        prevSince: borderQueue.prevSince,
      })
      .from(borderQueue);
    const out: BorderHours = {};
    for (const r of rows) {
      if (!isPost(r.post)) continue;
      const hours = range(r.minHours, r.maxHours);
      const prev = range(r.prevMinHours, r.prevMaxHours);
      if (hours === undefined || prev === undefined) continue;
      const before = r.prevSince ? { hours: prev, sinceMs: r.prevSince.getTime() } : undefined;
      if (hours === null && !before) continue;
      out[r.post] = before
        ? { hours, sinceMs: r.hoursSince.getTime(), before }
        : { hours, sinceMs: r.hoursSince.getTime() };
    }
    return out;
  } catch (err) {
    if (isServerBehind(err)) {
      console.warn('[border-queue] server behind — the default waits stand');
      return {};
    }
    throw err;
  }
});

/** A stored pair: the range, `null` for «his default», `undefined` for nonsense. */
function range(min: number | null, max: number | null): readonly [number, number] | null | undefined {
  if (min === null && max === null) return null;
  if (min === null || max === null || min < 0 || max < min) return undefined;
  return [min, max];
}

export interface BorderQueueRow {
  post: BorderPost;
  /** His default, in hours — the same constant the route's legs carry. */
  usualHours: readonly [number, number];
  /** Null = nothing typed (no row, or a reset row): the default stands. */
  typed: {
    minHours: number;
    maxHours: number;
    note: string | null;
    byName: string | null;
    at: Date;
    /** Tashkent days since it was typed. */
    ageDays: number;
    warn: boolean;
  } | null;
  /**
   * The row's `updated_at` as the panel saw it, posted back with a save so a
   * colleague's number typed in between is refused rather than overwritten
   * (`changed`). Present on a reset row too — the row exists.
   */
  seenAt: string | null;
}

/**
 * The /trucks panel's rows — one per known post, typed or not, with the name
 * of whoever typed it. For the panel only (`loadBorderHours` is what the
 * dates read). A drizzle select, so the timestamps are Dates (#923).
 */
export async function borderQueueRows(
  today: string,
): Promise<{ behind: boolean; rows: BorderQueueRow[] }> {
  let stored: {
    post: string;
    minHours: number | null;
    maxHours: number | null;
    note: string | null;
    updatedAt: Date;
    byName: string | null;
  }[];
  try {
    stored = await db
      .select({
        post: borderQueue.post,
        minHours: borderQueue.minHours,
        maxHours: borderQueue.maxHours,
        note: borderQueue.note,
        updatedAt: borderQueue.updatedAt,
        byName: users.fullName,
      })
      .from(borderQueue)
      .leftJoin(users, eq(users.id, borderQueue.updatedBy));
  } catch (err) {
    if (isServerBehind(err)) return { behind: true, rows: [] };
    throw err;
  }
  const byPost = new Map(stored.map((r) => [r.post, r]));
  const rows = BORDER_POST_KEYS.map((post): BorderQueueRow => {
    const r = byPost.get(post);
    // A NULL-hours row is a reset: it reads exactly like no row — no name,
    // no note — or the panel would credit somebody with «the usual days».
    const typed =
      r && r.minHours !== null && r.maxHours !== null
        ? (() => {
            const ageDays = daysSince(r.updatedAt, today);
            return {
              minHours: r.minHours,
              maxHours: r.maxHours,
              note: r.note,
              byName: r.byName,
              at: r.updatedAt,
              ageDays,
              warn: ageDays >= BORDER_QUEUE_WARN_DAYS,
            };
          })()
        : null;
    return {
      post,
      usualHours: BORDER_POSTS[post],
      typed,
      seenAt: r ? r.updatedAt.toISOString() : null,
    };
  });
  return { behind: false, rows };
}

/**
 * Who may type a queue: the logist's own permission (`plans.manage`, the
 * trucks are his) and never a warehouse-SCOPED holder of it. A border post
 * belongs to no warehouse, and the number moves every customer's date in the
 * company — a Yiwu operator granted planning must not move Tashkent's.
 */
export function mayEditBorderQueue(a: Pick<ActorGrants, 'permissions' | 'warehouseScoped'>): boolean {
  return a.permissions.has('plans.manage') && !a.warehouseScoped;
}

export type BorderQueueErrorCode =
  | 'forbidden'
  | 'scoped_actor'
  | 'unknown_post'
  | 'bad_number'
  | 'bad_range'
  | 'note_too_long'
  | 'changed';

export class BorderQueueError extends Error {
  constructor(public readonly code: BorderQueueErrorCode) {
    super(code);
  }
}

type Writer = Pick<Actor, 'id' | 'permissions' | 'warehouseScoped'>;
type Meta = { ip: string | null; userAgent: string | null };

/**
 * The door, asked HERE and not only by the action (#531): the permission,
 * then the scope, then the post. The action's `authorize('plans.manage')` is
 * the session half; this is the half a test can press.
 */
function assertWriter(actor: Writer, post: string): asserts post is BorderPost {
  if (!actor.permissions.has('plans.manage')) throw new BorderQueueError('forbidden');
  if (actor.warehouseScoped) throw new BorderQueueError('scoped_actor');
  if (!isPost(post)) throw new BorderQueueError('unknown_post');
}

/**
 * «3,5» is three and a half days — the comma is how a phone keyboard in
 * Tashkent types a decimal. «1 000», «abc», «-1» are not numbers here:
 * `Number('1 000')` is NaN and a NaN answers false to every guard (#777).
 */
function parseDays(raw: string): number {
  const text = raw.trim();
  if (!/^\d+([.,]\d+)?$/.test(text)) throw new BorderQueueError('bad_number');
  return Number(text.replace(',', '.'));
}

/**
 * The row under a lock, with the concurrency check the panel's `seenAt` makes.
 *
 * The advisory lock comes first because `FOR UPDATE` on a row that does not
 * exist yet locks nothing: two logists who both saw «Odatdagi» (seenAt null)
 * would both pass the check, and the second insert would land on the first
 * number in silence — exactly what `changed` promises to refuse. Keyed per
 * post, so Khorgos and Yallama never wait on each other.
 */
async function lockedRow(
  tx: Tx,
  post: BorderPost,
  seenAt: string | null,
) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`border_queue:${post}`}::text))`);
  const [row] = await tx.select().from(borderQueue).where(eq(borderQueue.post, post)).for('update');
  if ((row?.updatedAt.toISOString() ?? null) !== seenAt) throw new BorderQueueError('changed');
  return row ?? null;
}

/**
 * Type a queue: the range in DAYS as the logist thinks of it, stored in whole
 * hours as the schedule counts them. One transaction, `tx` only (#714): the
 * lock, the colleague check, the write, the audit. `updated_by` is the actor,
 * never a posted field.
 *
 * Only a change of HOURS moves the ETA's clock (`hours_since`) and hands the
 * old range down as `prev_*`. A note edit is written and audited but leaves
 * every queued truck's count alone. The same hours and the same note again —
 * the natural answer to the panel's «⚠ N kun oldin» — is a CONFIRMATION: the
 * age and the name move (so the warning goes and the panel says who looked),
 * the clock and the history do not, and there is no audit line whose before
 * equals its after (#502).
 */
export async function setBorderWait(
  actor: Writer,
  input: { post: string; minDays: string; maxDays: string; note: string; seenAt: string | null },
  meta: Meta,
): Promise<void> {
  const post = input.post;
  assertWriter(actor, post);
  const minDays = parseDays(input.minDays);
  const maxDays = parseDays(input.maxDays);
  if (minDays < 0 || maxDays < minDays || maxDays > MAX_DAYS) throw new BorderQueueError('bad_range');
  const note = input.note.trim() || null;
  if (note && note.length > NOTE_MAX) throw new BorderQueueError('note_too_long');
  const minHours = Math.round(minDays * 24);
  const maxHours = Math.round(maxDays * 24);

  await db.transaction(async (tx) => {
    const before = await lockedRow(tx, post, input.seenAt);
    // The database's clock, as the column defaults are — one clock for the
    // stamps the ETA and the panel count from, whichever door wrote them.
    const stamp = { updatedBy: actor.id, updatedAt: sql`now()` };
    if (!before) {
      const [saved] = await tx
        .insert(borderQueue)
        .values({ post, minHours, maxHours, note, updatedBy: actor.id })
        .returning({ id: borderQueue.id });
      await writeAudit(tx, { actorId: actor.id, ...meta }, {
        entityType: 'border_queue',
        entityId: saved!.id,
        action: 'update',
        before: null,
        after: { post, minHours, maxHours, note },
      });
      return;
    }
    const hoursChanged = before.minHours !== minHours || before.maxHours !== maxHours;
    if (!hoursChanged && before.note === note) {
      await tx.update(borderQueue).set(stamp).where(eq(borderQueue.id, before.id));
      return;
    }
    await tx
      .update(borderQueue)
      .set({
        minHours,
        maxHours,
        note,
        ...stamp,
        ...(hoursChanged
          ? {
              hoursSince: sql`now()`,
              prevMinHours: before.minHours,
              prevMaxHours: before.maxHours,
              prevSince: before.hoursSince,
            }
          : {}),
      })
      .where(eq(borderQueue.id, before.id));
    await writeAudit(tx, { actorId: actor.id, ...meta }, {
      entityType: 'border_queue',
      entityId: before.id,
      action: 'update',
      before: { post, minHours: before.minHours, maxHours: before.maxHours, note: before.note },
      after: { post, minHours, maxHours, note },
    });
  });
}

/**
 * «Odatdagi jadvalga qaytarish»: the hours and the note go, the row and its
 * id stay, so the audit history keeps naming one thing. The reset is a change
 * of hours like any other — his default from now, the typed range handed down
 * as `prev_*` — so a truck queueing under the typed number is counted from
 * this moment and does not jump the border because the default is shorter
 * than what it has stood. Nothing typed is nothing to clear — no row, or a row
 * already reset, writes nothing (an audit line whose before equals its after
 * is noise, #502).
 */
export async function clearBorderWait(
  actor: Writer,
  input: { post: string; seenAt: string | null },
  meta: Meta,
): Promise<void> {
  const post = input.post;
  assertWriter(actor, post);
  await db.transaction(async (tx) => {
    const before = await lockedRow(tx, post, input.seenAt);
    if (!before || (before.minHours === null && before.note === null)) return;
    const hoursChanged = before.minHours !== null;
    await tx
      .update(borderQueue)
      .set({
        minHours: null,
        maxHours: null,
        note: null,
        updatedBy: actor.id,
        updatedAt: sql`now()`,
        ...(hoursChanged
          ? {
              hoursSince: sql`now()`,
              prevMinHours: before.minHours,
              prevMaxHours: before.maxHours,
              prevSince: before.hoursSince,
            }
          : {}),
      })
      .where(eq(borderQueue.id, before.id));
    await writeAudit(tx, { actorId: actor.id, ...meta }, {
      entityType: 'border_queue',
      entityId: before.id,
      action: 'update',
      before: { post, minHours: before.minHours, maxHours: before.maxHours, note: before.note },
      after: { post, minHours: null, maxHours: null, note: null },
    });
  });
}
