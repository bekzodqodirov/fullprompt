import { cache } from 'react';
import { eq, isNotNull, sql } from 'drizzle-orm';
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
 * The typed queues as the schedule needs them: hours and WHEN they were
 * typed, nothing else. No names and no notes — this reaches the customer's
 * cabinet and the bot, and who typed a number is the logist's trail, not the
 * customer's business.
 *
 * Once per request (React `cache`, no arguments — so every reader on one page
 * shares one read), on the pool: none of its callers is inside a transaction
 * (#714). A row that breaks the table's own rules — an unknown post, a range
 * upside down — is skipped rather than trusted: the default is always an
 * honest answer, a nonsense wait never is.
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
        updatedAt: borderQueue.updatedAt,
      })
      .from(borderQueue)
      .where(isNotNull(borderQueue.minHours));
    const out: BorderHours = {};
    for (const r of rows) {
      if (!isPost(r.post) || r.minHours === null || r.maxHours === null) continue;
      if (r.minHours < 0 || r.maxHours < r.minHours) continue;
      out[r.post] = { hours: [r.minHours, r.maxHours], sinceMs: r.updatedAt.getTime() };
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

/** The row under a lock, with the concurrency check the panel's `seenAt` makes. */
async function lockedRow(
  tx: Tx,
  post: BorderPost,
  seenAt: string | null,
) {
  const [row] = await tx.select().from(borderQueue).where(eq(borderQueue.post, post)).for('update');
  if ((row?.updatedAt.toISOString() ?? null) !== seenAt) throw new BorderQueueError('changed');
  return row ?? null;
}

/**
 * Type a queue: the range in DAYS as the logist thinks of it, stored in whole
 * hours as the schedule counts them. One transaction, `tx` only (#714): the
 * row under `FOR UPDATE`, the colleague check, the upsert, the audit.
 * `updated_by` is the actor, never a posted field.
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
  const note = input.note.trim();
  if (note.length > NOTE_MAX) throw new BorderQueueError('note_too_long');
  const minHours = Math.round(minDays * 24);
  const maxHours = Math.round(maxDays * 24);

  await db.transaction(async (tx) => {
    const before = await lockedRow(tx, post, input.seenAt);
    const [saved] = await tx
      .insert(borderQueue)
      .values({ post, minHours, maxHours, note: note || null, updatedBy: actor.id })
      .onConflictDoUpdate({
        target: borderQueue.post,
        set: {
          minHours,
          maxHours,
          note: note || null,
          updatedBy: actor.id,
          // The database's clock, as the column default is — one clock for
          // the stamp the ETA counts from, whichever door wrote it.
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: borderQueue.id });
    await writeAudit(tx, { actorId: actor.id, ...meta }, {
      entityType: 'border_queue',
      entityId: saved!.id,
      action: 'update',
      before: before
        ? { post, minHours: before.minHours, maxHours: before.maxHours, note: before.note }
        : null,
      after: { post, minHours, maxHours, note: note || null },
    });
  });
}

/**
 * «Odatdagi jadvalga qaytarish»: the hours and the note go, the row and its
 * id stay, so the audit history keeps naming one thing. Nothing typed is
 * nothing to clear — no row, or a row already reset, writes nothing (an
 * audit line whose before equals its after is noise, #502).
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
    await tx
      .update(borderQueue)
      .set({ minHours: null, maxHours: null, note: null, updatedBy: actor.id, updatedAt: sql`now()` })
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
