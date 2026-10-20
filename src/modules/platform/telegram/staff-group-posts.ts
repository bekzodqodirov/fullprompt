import type PgBoss from 'pg-boss';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { staffGroupChats } from '../db/schema';
import { logger } from '../logger';
import { getStorage } from '../files/storage';
import { enqueue } from '../jobs/boss';
import { quietHour, sendAnimation, sendPhoto, sendText, type SendResult } from './send';
import { activeStaffGroup, migrateStaffGroup } from './staff-group';
import { groupVerdict, staleAfterHours } from './staff-group-rules';
import { STAFF_GROUP_MEDIA_ENTITY, STAFF_GROUP_MEDIA_TYPE, STAFF_GROUP_MEDIA_TYPES } from './staff-group-media';

/**
 * What the bot SAYS in the staff group (0134) — one row per thing, claimed by
 * its `dedupe_key` before anything is sent, and sent by a pg-boss job, never
 * inline: a GIF read from storage and uploaded must never sit on the button
 * that minted a client code, nor on the bot's sequential poller (#706).
 */

export const JOB_STAFF_GROUP = 'staff-group.drain';

export type GroupPostKind = 'client' | 'won' | 'first_cargo' | 'rating' | 'champion' | 'test';

export interface GroupPostInput {
  kind: GroupPostKind;
  dedupeKey: string;
  /** Safe HTML (format.ts). With media it rides as the caption, so ≤ 1024 visible characters. */
  html: string;
  /** Who is praised — the panel names them; null for the rating. */
  subjectUserId?: string | null;
  /** Pick one of the uploaded GIFs (the rotation). */
  withMedia?: boolean;
  /** The rating's posted standings, so streaks are read from what people saw. */
  standings?: unknown;
}

/**
 * The least recently shown of the uploaded GIFs and photos, marked shown NOW —
 * his «2 3 gif yuklab qoyaylik zerkarli bolmasin». A rotation and not a
 * random pick: with three files a random pick repeats the same one twice in
 * a row a third of the time, and that is exactly the «zerikarli» he named.
 */
export async function pickGroupMedia(): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    WITH next AS (
      SELECT a.id
        FROM attachments a
        LEFT JOIN staff_group_media m ON m.attachment_id = a.id
       WHERE a.entity_type = ${STAFF_GROUP_MEDIA_TYPE}
         AND a.entity_id = ${STAFF_GROUP_MEDIA_ENTITY}::uuid
       ORDER BY m.last_used_at NULLS FIRST, a.created_at, a.id
       LIMIT 1)
    INSERT INTO staff_group_media (attachment_id, last_used_at)
    SELECT id, now() FROM next
    ON CONFLICT (attachment_id) DO UPDATE SET last_used_at = now()
    RETURNING attachment_id::text AS id`);
  return rows[0]?.id ?? null;
}

/**
 * Claim and queue one thing to say. Returns false when it was said (or
 * claimed) before — the whole of the «never twice» rule. With no staff group
 * the row is written `skipped/no_group`: the claim still stands, so connecting
 * a group later does not flood it with last month's praise.
 *
 * Never inside the caller's transaction (#714) and never throws at a caller
 * whose own work already committed — a celebration is an addition.
 */
export async function queueGroupPost(input: GroupPostInput): Promise<boolean> {
  try {
    const group = await activeStaffGroup();
    const media = group && input.withMedia ? await pickGroupMedia() : null;
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO staff_group_posts (kind, dedupe_key, subject_user_id, html, media_attachment_id, standings, status, skip_reason)
      VALUES (${input.kind}, ${input.dedupeKey}, ${input.subjectUserId ?? null}::uuid, ${input.html},
              ${media}::uuid, ${input.standings === undefined ? null : JSON.stringify(input.standings)}::jsonb,
              ${group ? 'pending' : 'skipped'}, ${group ? null : 'no_group'})
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id::text AS id`);
    const queued = inserted.length > 0;
    if (queued && group) {
      try {
        await enqueue(JOB_STAFF_GROUP, {});
      } catch (err) {
        // The minute sweep sends it anyway; a missed kick is a minute late.
        logger.warn({ err }, '[staff-group] drain kick failed');
      }
    }
    return queued;
  } catch (err) {
    logger.error({ err, dedupeKey: input.dedupeKey }, '[staff-group] post not queued');
    return false;
  }
}

/**
 * A claim that was written `skipped/no_group` — the rating of a Saturday the
 * group was not yet connected — re-armed by a person's press with today's
 * words. Only a SKIPPED row: a sent one stays sent (never twice).
 */
export async function requeueSkippedGroupPost(dedupeKey: string, html: string, standings: unknown): Promise<boolean> {
  if (!(await activeStaffGroup())) return false;
  const rows = await db.execute(sql`
    UPDATE staff_group_posts
       SET status = 'pending', skip_reason = NULL, html = ${html},
           standings = ${JSON.stringify(standings)}::jsonb, attempts = 0, not_before = NULL,
           claimed_at = NULL, last_error = NULL, created_at = now()
     WHERE dedupe_key = ${dedupeKey} AND status = 'skipped'
     RETURNING id`);
  if (rows.length === 0) return false;
  try {
    await enqueue(JOB_STAFF_GROUP, {});
  } catch {
    /* the minute sweep */
  }
  return true;
}

/** «Qayta yuborish» on a failed row — a person decided it did not reach the group. */
export async function retryGroupPost(id: string): Promise<boolean> {
  const rows = await db.execute(sql`
    UPDATE staff_group_posts
       SET status = 'pending', attempts = 0, not_before = NULL, claimed_at = NULL, last_error = NULL,
           created_at = now()
     WHERE id = ${id}::uuid AND status = 'failed'
     RETURNING id`);
  if (rows.length === 0) return false;
  try {
    await enqueue(JOB_STAFF_GROUP, {});
  } catch {
    /* the minute sweep */
  }
  return true;
}

type Claimed = {
  id: string;
  kind: string;
  html: string;
  media_attachment_id: string | null;
  attempts: number;
  created_ms: string;
  claimed_at: string;
};

async function claimNext(): Promise<Claimed | null> {
  const rows = await db.execute<Claimed>(sql`
    UPDATE staff_group_posts
       SET status = 'sending', claimed_at = now(), attempts = attempts + 1
     WHERE id = (SELECT id FROM staff_group_posts
                  WHERE status = 'pending' AND (not_before IS NULL OR not_before <= now())
                  ORDER BY created_at, id
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1)
    RETURNING id::text AS id, kind, html, media_attachment_id::text AS media_attachment_id, attempts,
              (extract(epoch FROM created_at) * 1000)::bigint::text AS created_ms, claimed_at::text AS claimed_at`);
  return rows[0] ?? null;
}

/** A write that lands only while this run still holds the row (0082's claim shape). */
async function settle(row: Claimed, set: SQL): Promise<void> {
  await db.execute(sql`
    UPDATE staff_group_posts SET ${set}
     WHERE id = ${row.id}::uuid AND status = 'sending' AND claimed_at = ${row.claimed_at}::timestamptz`);
}

const release = (row: Claimed, notBeforeSec = 0) =>
  settle(
    row,
    notBeforeSec > 0
      ? sql`status = 'pending', not_before = now() + make_interval(secs => ${notBeforeSec})`
      : sql`status = 'pending'`,
  );

type MediaFile = {
  attachmentId: string;
  sendAs: 'animation' | 'photo';
  source: { fileId: string } | { bytes: Buffer; filename: string; contentType: string };
};

/** The row's GIF, by Telegram's id when one was minted by the same method, else its bytes. */
async function mediaFor(attachmentId: string): Promise<MediaFile | null> {
  const rows = await db.execute<{
    storage_key: string;
    file_name: string;
    content_type: string;
    telegram_file_id: string | null;
    telegram_sent_as: string | null;
  }>(sql`
    SELECT a.storage_key, a.file_name, a.content_type, m.telegram_file_id, m.telegram_sent_as
      FROM attachments a
      LEFT JOIN staff_group_media m ON m.attachment_id = a.id
     WHERE a.id = ${attachmentId}::uuid`);
  const row = rows[0];
  if (!row) return null;
  const sendAs = STAFF_GROUP_MEDIA_TYPES[row.content_type];
  if (!sendAs) return null;
  if (row.telegram_file_id && row.telegram_sent_as === sendAs) {
    return { attachmentId, sendAs, source: { fileId: row.telegram_file_id } };
  }
  const bytes = await getStorage().get(row.storage_key);
  return { attachmentId, sendAs, source: { bytes, filename: row.file_name, contentType: row.content_type } };
}

async function rememberFileId(attachmentId: string, sendAs: 'animation' | 'photo', fileId: string | null) {
  if (!fileId) return;
  await db.execute(sql`
    INSERT INTO staff_group_media (attachment_id, telegram_file_id, telegram_sent_as)
    VALUES (${attachmentId}::uuid, ${fileId}, ${sendAs})
    ON CONFLICT (attachment_id) DO UPDATE SET telegram_file_id = ${fileId}, telegram_sent_as = ${sendAs}`);
}

async function forgetFileId(attachmentId: string) {
  await db.execute(sql`
    UPDATE staff_group_media SET telegram_file_id = NULL, telegram_sent_as = NULL
     WHERE attachment_id = ${attachmentId}::uuid`);
}

/** Telegram does not know an id we cached (a re-created bot, a wiped file) — the bytes go next time. */
const UNKNOWN_FILE_ID = /wrong file identifier|file reference|wrong remote file|FILE_ID_INVALID/i;

/**
 * Send one row: the GIF with the words as its caption, or the words alone.
 * The picture is an ADDITION — a refused or unreadable GIF sends the words
 * alone in the same run, because a celebration nobody saw is worse than one
 * without its animation.
 */
async function sendOne(row: Claimed, chatId: string, silent: boolean): Promise<SendResult> {
  if (row.media_attachment_id) {
    let media: MediaFile | null = null;
    try {
      media = await mediaFor(row.media_attachment_id);
    } catch (err) {
      logger.warn({ err, attachmentId: row.media_attachment_id }, '[staff-group] media unreadable — words alone');
    }
    if (media) {
      const sent =
        media.sendAs === 'animation'
          ? await sendAnimation({ chatId, animation: media.source, captionHtml: row.html, silent })
          : await sendPhoto({ chatId, photo: media.source, captionHtml: row.html, silent });
      if (sent.ok) {
        await rememberFileId(media.attachmentId, media.sendAs, sent.fileId);
        return sent;
      }
      if ('fileId' in media.source && UNKNOWN_FILE_ID.test(sent.description)) {
        await forgetFileId(media.attachmentId);
      }
      // Only a refusal about the PICTURE falls back to words; anything about
      // the group, the moment or the token is the row's verdict as it stands.
      if (sent.status !== 400 || sent.migrateToChatId) return sent;
      logger.warn({ description: sent.description }, '[staff-group] media refused — words alone');
    }
  }
  return sendText({ chatId, html: row.html, silent });
}

export interface GroupDrainResult {
  sent: number;
  skipped: number;
  paused: string | null;
}

/**
 * The drain: a few rows a run (a group takes 20 messages a minute and a burst
 * of codes is never urgent), each settled by `groupVerdict`. Rows queued
 * while no group was active were written `skipped` at the claim, so nothing
 * here can flood a freshly connected group.
 */
export async function drainStaffGroup(now: Date = new Date()): Promise<GroupDrainResult> {
  const result: GroupDrainResult = { sent: 0, skipped: 0, paused: null };
  let group = await activeStaffGroup();
  if (!group) return result;

  // Stuck in `sending` for ten minutes: Telegram may have published it, so it
  // is NEVER re-sent by the machine — the admin looks at the group and presses.
  await db.execute(sql`
    UPDATE staff_group_posts SET status = 'failed', last_error = 'stuck_sending'
     WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes'`);

  const silent = quietHour(now);
  for (let i = 0; i < 5; i += 1) {
    const row = await claimNext();
    if (!row) break;
    const age = now.getTime() - Number(row.created_ms);
    if (age > staleAfterHours(row.kind) * 3600_000) {
      await settle(row, sql`status = 'skipped', skip_reason = 'stale'`);
      result.skipped += 1;
      continue;
    }
    const chatId = group.chatId.toString();
    let sent: SendResult;
    try {
      sent = await sendOne(row, chatId, silent);
    } catch (err) {
      // Nothing in sendOne throws after the network call (the sender answers,
      // never throws), so a throw here means nothing was published.
      logger.error({ err, id: row.id }, '[staff-group] send threw — released');
      await release(row, 60);
      continue;
    }
    const verdict = groupVerdict(sent, row.attempts);
    if (verdict.next === 'sent') {
      await settle(
        row,
        sql`status = 'sent', chat_id = ${chatId}::bigint, message_id = ${sent.messageId}, sent_at = now(), last_error = NULL`,
      );
      result.sent += 1;
      continue;
    }
    if (verdict.next === 'migrated') {
      await migrateStaffGroup(chatId, verdict.chatId);
      await release(row);
      group = await activeStaffGroup();
      if (!group) break;
      continue;
    }
    if (verdict.next === 'retry') {
      await release(row, verdict.notBeforeSec);
      continue;
    }
    if (verdict.next === 'pause') {
      await release(row, 60);
      if (verdict.groupRefused) {
        await db
          .update(staffGroupChats)
          .set({ canPost: false, lastError: verdict.lastError, updatedAt: new Date() })
          .where(eq(staffGroupChats.chatId, group.chatId));
      }
      result.paused = verdict.lastError;
      break;
    }
    await settle(row, sql`status = 'failed', last_error = ${verdict.lastError}`);
  }
  return result;
}

export async function registerStaffGroupWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_STAFF_GROUP);
  await boss.schedule(JOB_STAFF_GROUP, '* * * * *');
  await boss.work(JOB_STAFF_GROUP, async () => {
    try {
      const run = await drainStaffGroup();
      if (run.sent > 0 || run.paused) logger.info(run, '[staff-group] drain');
    } catch (err) {
      logger.error({ err }, '[staff-group] drain failed');
    }
  });
}

/** The group's media list for the panel (newest first). */
export async function groupMediaList(): Promise<
  { id: string; fileName: string; contentType: string; sizeBytes: number; lastUsedAt: string | null }[]
> {
  const rows = await db.execute<{
    id: string;
    file_name: string;
    content_type: string;
    size_bytes: string | number;
    last_used_at: string | null;
  }>(sql`
    SELECT a.id::text AS id, a.file_name, a.content_type, a.size_bytes, m.last_used_at::text AS last_used_at
      FROM attachments a
      LEFT JOIN staff_group_media m ON m.attachment_id = a.id
     WHERE a.entity_type = ${STAFF_GROUP_MEDIA_TYPE}
       AND a.entity_id = ${STAFF_GROUP_MEDIA_ENTITY}::uuid
     ORDER BY a.created_at DESC`);
  return Array.from(rows).map((r) => ({
    id: r.id,
    fileName: r.file_name,
    contentType: r.content_type,
    sizeBytes: Number(r.size_bytes),
    lastUsedAt: r.last_used_at,
  }));
}
