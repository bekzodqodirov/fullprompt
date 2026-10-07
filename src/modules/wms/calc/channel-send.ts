import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { logger } from '@/modules/platform/logger';
import { getStorage } from '@/modules/platform/files/storage';
import { usersWithPermission } from '@/modules/platform/notifications/service';
import {
  editCaption,
  editText,
  quietHour,
  sendAlbum,
  sendText,
  type SendResult,
} from '@/modules/platform/telegram/send';
import {
  connectedChannel,
  pauseForVet,
  staticPause,
  vetForDrain,
} from '@/modules/platform/telegram/price-channel';
import type { PauseReason } from '@/modules/platform/telegram/price-channel-rules';
import { photoSource } from '../client-cabinet/bot-text';
import { childStateSql, type ChildState } from './chain';
import { buildChannelPostView, postPhotosFor, queueMissedPrices } from './channel-queue';
import {
  channelPostHtml,
  childPostedFor,
  type ChannelPostView,
  type PostKind,
  type PostStatus,
} from './channel-post';

/**
 * The price channel's SENDER (the owner's F, 2026-10-07) — a pg-boss job,
 * never inline: up to ten photographs read from storage and uploaded must
 * never sit on a VED's button or the bot's sequential poller (#706).
 *
 * The rule that shapes every branch: a price posted TWICE in a channel the
 * whole company reads is worse than one the admin re-sends with a press (#48).
 * So an answer that may have reached Telegram (our deadline, a reset socket, a
 * 502/504) is never retried by the machine — it is `failed/ambiguous_send` and
 * the panel says «yuborilgan bo‘lishi mumkin»; only a fault where nothing left
 * the machine (a refused connect) is retried.
 */

/** A refusal about the CHANNEL, not the post — one demoted bot must not burn the whole queue into `failed`. */
const CHANNEL_REFUSAL =
  /chat not found|not enough rights|have no rights|need administrator|not a member|CHAT_WRITE_FORBIDDEN|bot was kicked/i;
/** A connect-phase fault: nothing left the machine, so a retry cannot double-post. */
const CONNECT_PHASE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)\b/;

export type ChannelVerdict =
  | { next: 'sent' }
  | { next: 'retry'; notBeforeSec: number; refund: boolean }
  | { next: 'pause'; lastError: string; channelRefused: boolean }
  | { next: 'failed'; lastError: string };

/** What a send's answer means for the row — PURE, a table in the unit test. */
export function channelVerdict(
  result: Pick<SendResult, 'ok' | 'status' | 'description' | 'retryAfter' | 'botDown'>,
  attempts: number,
): ChannelVerdict {
  if (result.ok) return { next: 'sent' };
  if (result.status === 429 || result.retryAfter !== null) {
    return { next: 'retry', notBeforeSec: result.retryAfter ?? 60, refund: true };
  }
  if (result.botDown) return { next: 'pause', lastError: result.description, channelRefused: false };
  if (result.status === 0 && result.description === 'no_bot_token') {
    return { next: 'pause', lastError: result.description, channelRefused: false };
  }
  if (result.status === 403 || (result.status === 400 && CHANNEL_REFUSAL.test(result.description))) {
    return { next: 'pause', lastError: result.description, channelRefused: true };
  }
  if (result.status === 0) {
    if (CONNECT_PHASE.test(result.description)) {
      return attempts >= 8
        ? { next: 'failed', lastError: result.description }
        : { next: 'retry', notBeforeSec: 60, refund: false };
    }
    // Our deadline, a reset, an unrecognised throw: the body may already be
    // in Telegram — a 10-photo album that timed out AFTER publishing would
    // otherwise go out a second time a minute later.
    return { next: 'failed', lastError: 'ambiguous_send' };
  }
  if (result.status === 502 || result.status === 504) return { next: 'failed', lastError: 'ambiguous_send' };
  // Telegram's own «try later». A 500 after publishing is possible and accepted (stated).
  if (result.status >= 500) return { next: 'retry', notBeforeSec: 60, refund: false };
  return { next: 'failed', lastError: result.description };
}

type ClaimedRow = {
  id: string;
  kind: PostKind;
  request_id: string;
  version_id: string | null;
  chat_id: string | null;
  attempts: number;
  created_ms: string;
};

async function claimNext(): Promise<ClaimedRow | null> {
  const rows = await db.execute<ClaimedRow>(sql`
    UPDATE price_channel_posts
       SET status = 'sending', claimed_at = now(), attempts = attempts + 1
     WHERE id = (SELECT id FROM price_channel_posts
                  WHERE status = 'pending' AND (not_before IS NULL OR not_before <= now())
                  ORDER BY created_at, id
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1)
    RETURNING id::text AS id, kind, request_id::text AS request_id, version_id::text AS version_id,
              chat_id::text AS chat_id, attempts, (extract(epoch FROM created_at) * 1000)::bigint::text AS created_ms`);
  return rows[0] ?? null;
}

async function setRow(id: string, set: SQL): Promise<void> {
  await db.execute(sql`UPDATE price_channel_posts SET ${set} WHERE id = ${id}::uuid`);
}

/** The nearest ANCESTOR (up the correction chain, ≤ 64) whose post is sent in this channel — the reply target. */
async function replyTargetFor(requestId: string, chatId: string): Promise<number | null> {
  const rows = await db.execute<{ message_id: number }>(sql`
    WITH RECURSIVE up AS (
      SELECT r.supersedes_request_id AS id, 1 AS depth FROM calc_requests r WHERE r.id = ${requestId}::uuid
      UNION ALL
      SELECT r.supersedes_request_id, up.depth + 1
        FROM calc_requests r JOIN up ON r.id = up.id
       WHERE up.depth < 64 AND r.supersedes_request_id IS NOT NULL
    )
    SELECT p.message_id
      FROM up
      JOIN price_channel_posts p ON p.request_id = up.id AND p.status = 'sent' AND p.chat_id = ${chatId}::bigint
     WHERE up.id IS NOT NULL
     ORDER BY up.depth, p.sent_at DESC
     LIMIT 1`);
  return rows[0] ? Number(rows[0].message_id) : null;
}

async function parentPostStatus(parentRequestId: string): Promise<PostStatus | null> {
  const rows = await db.execute<{ status: PostStatus }>(sql`
    SELECT status FROM price_channel_posts WHERE request_id = ${parentRequestId}::uuid
     ORDER BY created_at DESC LIMIT 1`);
  return rows[0]?.status ?? null;
}

/** Each photo read in its own try — one missing object costs one photo (client-cabinet.ts's rule). */
async function readPhotos(requestId: string): Promise<{ bytes: Buffer; filename: string; contentType: string }[]> {
  const storage = getStorage();
  const out: { bytes: Buffer; filename: string; contentType: string }[] = [];
  for (const p of await postPhotosFor(requestId)) {
    const source = photoSource(p);
    if (!source) continue;
    try {
      out.push({
        bytes: await storage.get(source.key),
        filename: source.key.split('/').pop() || 'photo.jpg',
        contentType: source.contentType,
      });
    } catch (err) {
      logger.warn({ err, requestId }, '[price-channel] photo unreadable — skipped');
    }
  }
  return out;
}

export interface DrainResult {
  paused: PauseReason | null;
  sent: number;
  skipped: number;
}

/**
 * One drain run, in order: the channel and its authority (every door passes
 * through here, so the drain re-checks rather than trusting whoever wrote the
 * row), the net, the stuck rows, then up to three posts.
 */
export async function drainPriceChannel(now: Date = new Date()): Promise<DrainResult> {
  const result: DrainResult = { paused: null, sent: 0, skipped: 0 };
  const channel = await connectedChannel();
  if (!channel) return result;
  const chatId = channel.chatId.toString();
  const pause = staticPause({
    hasToken: !!process.env.TELEGRAM_BOT_TOKEN,
    row: channel,
    settingsAdminIds: process.env.TELEGRAM_BOT_TOKEN ? await usersWithPermission('admin.settings.manage') : [],
  });
  if (pause) return { ...result, paused: pause };
  const vet = await vetForDrain(chatId, now.getTime());
  if (!vet.ok) return { ...result, paused: pauseForVet(vet.verdict) };

  await queueMissedPrices();

  // Stuck in `sending` for ten minutes: Telegram may have published it, so it
  // is NEVER re-sent automatically — the admin checks the channel and presses.
  await db.execute(sql`
    UPDATE price_channel_posts SET status = 'failed', last_error = 'stuck_sending'
     WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes'`);

  for (let i = 0; i < 3; i += 1) {
    const row = await claimNext();
    if (!row) break;
    const outcome = await sendOne(row, chatId, now);
    if (outcome === 'sent') result.sent += 1;
    if (outcome === 'skipped') result.skipped += 1;
    if (outcome === 'stop') break;
  }
  return result;
}

async function sendOne(row: ClaimedRow, chatId: string, now: Date): Promise<'sent' | 'skipped' | 'next' | 'stop'> {
  // A price queued for channel A never lands in B.
  if (row.chat_id !== chatId) {
    await setRow(row.id, sql`status = 'skipped', skip_reason = 'channel_changed'`);
    return 'skipped';
  }
  const built = await buildChannelPostView({ kind: row.kind, requestId: row.request_id, versionId: row.version_id });
  if (!built) {
    await setRow(row.id, sql`status = 'failed', last_error = 'not_found'`);
    return 'next';
  }
  // Stale: rows paused for weeks (bot removed, token missing, channel refused)
  // must not flood the channel with expired and superseded prices three a
  // minute when the bot comes back — the same «no backlog» rule as no_channel.
  const age = now.getTime() - Number(row.created_ms);
  if (age > 24 * 3600_000 || !built.standing) {
    await setRow(row.id, sql`status = 'skipped', skip_reason = 'stale'`);
    return 'skipped';
  }

  let replyTo: number | null = null;
  if (built.parentRequestId) {
    const parent = await parentPostStatus(built.parentRequestId);
    if ((parent === 'pending' || parent === 'sending') && age < 30 * 60_000) {
      // The reply must not race ahead of what it answers.
      await setRow(
        row.id,
        sql`status = 'pending', not_before = now() + interval '60 seconds', attempts = attempts - 1`,
      );
      return 'next';
    }
    replyTo = await replyTargetFor(row.request_id, chatId);
  }

  const html = channelPostHtml(built.view, null);
  const common = {
    chatId,
    protectContent: true,
    silent: quietHour(now),
    ...(replyTo !== null ? { replyToMessageId: replyTo } : {}),
  };
  // Photos only on a post that replies to nothing: a correction's photos are
  // one tap up, and an album of ten counts as ten messages against the rate.
  const photos = replyTo === null ? await readPhotos(row.request_id) : [];
  let sent: SendResult;
  let carrier: 'text' | 'caption' = 'text';
  let photoCount = 0;
  if (photos.length > 0) {
    sent = await sendAlbum({ ...common, photos, captionHtml: html, protectContent: true });
    carrier = 'caption';
    photoCount = Math.min(10, photos.length);
    if (!sent.ok && sent.status === 400 && !CHANNEL_REFUSAL.test(sent.description)) {
      // A 400 proves nothing was published: the photo is an addition, never the delivery (round C).
      logger.warn({ id: row.id, description: sent.description }, '[price-channel] album refused — sent as text');
      sent = await sendText({ ...common, html, protectContent: true });
      carrier = 'text';
      photoCount = 0;
    }
  } else {
    sent = await sendText({ ...common, html, protectContent: true });
  }

  const verdict = channelVerdict(sent, row.attempts);
  if (verdict.next === 'sent') {
    if (sent.messageId === null) {
      await setRow(row.id, sql`status = 'failed', last_error = 'ambiguous_send'`);
      return 'next';
    }
    await recordSent(row.id, {
      messageId: sent.messageId,
      carrier,
      view: built.view,
      replyTo,
      photoCount,
    });
    return 'sent';
  }
  if (verdict.next === 'retry') {
    await setRow(
      row.id,
      verdict.refund
        ? sql`status = 'pending', not_before = now() + make_interval(secs => ${verdict.notBeforeSec}), attempts = attempts - 1`
        : sql`status = 'pending', not_before = now() + make_interval(secs => ${verdict.notBeforeSec})`,
    );
    return 'stop';
  }
  if (verdict.next === 'pause') {
    await setRow(row.id, sql`status = 'pending', attempts = attempts - 1, last_error = ${verdict.lastError}`);
    if (verdict.channelRefused) {
      await db.execute(sql`
        UPDATE price_channel_chats SET last_error = ${`channel_refused:${verdict.lastError}`}, updated_at = now()
         WHERE chat_id = ${chatId}::bigint`);
    }
    return 'stop';
  }
  await setRow(row.id, sql`status = 'failed', last_error = ${verdict.lastError}`);
  return 'next';
}

/**
 * The result write after a successful send, retried in-process: if it still
 * fails the row stays `sending` and the stuck step turns it `failed` — never a
 * second automatic post.
 */
async function recordSent(
  id: string,
  o: { messageId: number; carrier: 'text' | 'caption'; view: ChannelPostView; replyTo: number | null; photoCount: number },
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await setRow(
        id,
        sql`status = 'sent', message_id = ${o.messageId}, carrier = ${o.carrier}, view = ${JSON.stringify(o.view)}::jsonb,
            marked_state = NULL, reply_to_message_id = ${o.replyTo}, photo_count = ${o.photoCount},
            sent_at = now(), last_error = NULL`,
      );
      return;
    } catch (err) {
      logger.error({ err, id, attempt }, '[price-channel] sent but not recorded');
    }
  }
}

/**
 * CORRECTIONS — the old post is EDITED, and what it says is DERIVED from the
 * correction graph, not stored by a hook per ending (four hooks and a missed
 * fifth door, #528's pair-rule shape). Every way a posted price stops standing
 * is one of chain.ts's five child states; `marked_state` only moves forward
 * (null → open → terminal, or null → terminal). The hooks only KICK.
 */
export async function reconcilePriceChannelMarks(now: Date = new Date()): Promise<number> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return 0;
  const rows = await db.execute<{
    id: string;
    chat_id: string;
    message_id: number;
    carrier: 'text' | 'caption';
    view: ChannelPostView;
    state: ChildState;
    child_completed_ms: string | null;
    child_post_status: PostStatus | null;
  }>(sql`
    SELECT p.id::text AS id, p.chat_id::text AS chat_id, p.message_id, p.carrier, p.view, cs.state,
           (extract(epoch FROM c.completed_at) * 1000)::bigint::text AS child_completed_ms,
           cp.status AS child_post_status
      FROM price_channel_posts p
      JOIN calc_requests c ON c.supersedes_request_id = p.request_id
      JOIN LATERAL (SELECT ${childStateSql(sql`p.request_id`)} AS state) cs ON true
      LEFT JOIN LATERAL (SELECT q.status FROM price_channel_posts q WHERE q.request_id = c.id
                          ORDER BY q.created_at DESC LIMIT 1) cp ON true
     WHERE p.status = 'sent'
       AND (p.marked_state IS NULL OR p.marked_state = 'open')
       AND cs.state IS DISTINCT FROM p.marked_state
       AND (p.mark_claimed_at IS NULL OR p.mark_claimed_at < now() - interval '5 minutes')
     ORDER BY p.sent_at
     LIMIT 10`);
  let edited = 0;
  for (const r of rows) {
    const posted = childPostedFor({
      state: r.state,
      childPostStatus: r.child_post_status,
      childCompletedAt: r.child_completed_ms ? new Date(Number(r.child_completed_ms)) : null,
      now,
    });
    if (posted === 'waiting') continue;
    const claimed = await db.execute<{ id: string }>(sql`
      UPDATE price_channel_posts SET mark_claimed_at = now()
       WHERE id = ${r.id}::uuid AND status = 'sent' AND (marked_state IS NULL OR marked_state = 'open')
         AND (mark_claimed_at IS NULL OR mark_claimed_at < now() - interval '5 minutes')
      RETURNING id::text AS id`);
    if (claimed.length === 0) continue;
    const html = channelPostHtml(r.view, { state: r.state, childPosted: posted === 'posted' });
    const answer =
      r.carrier === 'caption'
        ? await editCaption({ chatId: r.chat_id, messageId: Number(r.message_id), captionHtml: html })
        : await editText({ chatId: r.chat_id, messageId: Number(r.message_id), html });
    if (answer.ok) {
      await setRow(r.id, sql`marked_state = ${r.state}, marked_at = now(), mark_claimed_at = NULL`);
      edited += 1;
      continue;
    }
    const stop =
      answer.status === 429 ||
      answer.botDown ||
      answer.status === 403 ||
      (answer.status === 0 && answer.description === 'no_bot_token') ||
      (answer.status === 400 && CHANNEL_REFUSAL.test(answer.description));
    if (stop) {
      await setRow(r.id, sql`mark_claimed_at = NULL`);
      break;
    }
    if (answer.status === 400) {
      // The owner deleted the post, or it can no longer be edited: we stop
      // asking, and the panel counts it. No retry storm.
      await setRow(r.id, sql`marked_state = ${r.state}, marked_at = now(), mark_error = ${answer.description}`);
      continue;
    }
    // A network fault on an idempotent edit: simply asked again next run.
    await setRow(r.id, sql`mark_claimed_at = NULL`);
  }
  return edited;
}
