import type PgBoss from 'pg-boss';
import { sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../db/client';
import { logger } from '../logger';
import { redeliveryReady } from './redelivery-ready';

/**
 * One claim per Telegram identity (0130, Q5 a).
 *
 * Now that the bot keeps the backlog, the same update can be delivered TWICE
 * (a kill mid-batch: grammy confirms a batch only by the next getUpdates) and
 * the same button tapped MANY times while nobody answered (every tap is its
 * own callback_query with its own id). An effect that is not already a CAS —
 * a question to the giver, a reschedule, the sources forwarded again, a
 * customer's message to their manager — claims a key in the SAME transaction
 * as the effect, and a second claim says «already done».
 *
 * The key is the Telegram identity of the MESSAGE, never of the update:
 *  - `m:<chat>:<message>:<effect>` — an effect of one incoming message,
 *    identical in every redelivery of it;
 *  - `q:<chat>:<pressed message>:<effect>` — an effect of a press, keyed by
 *    the message PRESSED, so a redelivery and every repeat tap (each with its
 *    own callback_query id) share it. Live this is exactly today's behaviour:
 *    each of these keyboards is used up by its own first edit.
 *
 * A key is minted only through `readyKey` (fenced): a server one migration
 * behind gets `null`, which is today's un-keyed behaviour.
 */

export type OnceEffect =
  | 'ask'
  | 'answer'
  | 'reschedule'
  | 'sources'
  | 'search'
  | 'client_forward'
  | 'link_alert'
  /** «this message answered a wait» — recorded after the effect (markOnce). */
  | 'wait'
  /** «this contact linked a colleague» — recorded after linkStaffChat. */
  | 'staff_link';

export type OnceKey = string & { readonly __once: unique symbol };

export const onceKey = {
  /** An effect of ONE incoming message — identical in every redelivery of it. */
  message(chatId: bigint | number, messageId: number, effect: OnceEffect): OnceKey {
    return `m:${String(chatId)}:${messageId}:${effect}` as OnceKey;
  },
  /** An effect of a press, keyed by the MESSAGE pressed — identical for a redelivery AND for every repeat tap. */
  press(chatId: bigint | number, pressedMessageId: number, effect: OnceEffect): OnceKey {
    return `q:${String(chatId)}:${pressedMessageId}:${effect}` as OnceKey;
  },
};

/** The key when 0130 is in, null on a server one migration behind. The ONLY place `onceKey.` may be called from (fenced). */
export async function readyKey(make: () => OnceKey): Promise<OnceKey | null> {
  if (!(await redeliveryReady())) return null;
  return make();
}

/** The key of an effect of this incoming message; null when the ctx carries no message (a test fake — never an id of 0). */
export async function messageKey(
  ctx: { chat?: { id: number }; message?: { message_id: number } },
  effect: OnceEffect,
): Promise<OnceKey | null> {
  const chat = ctx.chat?.id;
  const message = ctx.message?.message_id;
  if (chat === undefined || !message) return null;
  return readyKey(() => onceKey.message(chat, message, effect));
}

/** The key of an effect of this press, by the message pressed; null when the press carries no message. */
export async function pressKey(
  ctx: {
    chat?: { id: number };
    callbackQuery?: { from: { id: number }; message?: { message_id: number } };
  },
  effect: OnceEffect,
): Promise<OnceKey | null> {
  const q = ctx.callbackQuery;
  const chat = ctx.chat?.id ?? q?.from.id;
  const pressed = q?.message?.message_id;
  if (chat === undefined || !pressed) return null;
  return readyKey(() => onceKey.press(chat, pressed, effect));
}

/**
 * True when THIS call claimed the key (the effect may happen); false = it
 * already happened. Called INSIDE the effect's transaction, so a rolled-back
 * effect rolls its claim back with it.
 */
export async function claimOnce(dbOrTx: Db | Tx, key: OnceKey): Promise<boolean> {
  const rows = await dbOrTx.execute<{ key: string }>(sql`
    INSERT INTO telegram_once (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING RETURNING key`);
  return rows.length > 0;
}

/** A read for the throttle's sake only (forwardClientMessage) — the claim is the fence. */
export async function claimedAlready(key: OnceKey): Promise<boolean> {
  const rows = await db.execute<{ one: number }>(sql`SELECT 1 AS one FROM telegram_once WHERE key = ${key} LIMIT 1`);
  return rows.length > 0;
}

/**
 * After an effect whose own CAS/dedup already fences a repeat — the record
 * only lets a redelivery SAY so (`handledAlready`). Never throws.
 */
export async function markOnce(key: OnceKey | null): Promise<void> {
  if (!key) return;
  await db
    .execute(sql`INSERT INTO telegram_once (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING`)
    .catch((err: unknown) => logger.warn({ err }, '[bot] redelivery mark not written'));
}

/** The message effects a crash redelivery asks about — exact keys, never a LIKE (a btree serves LIKE only under C). */
export const MESSAGE_EFFECTS_DONE: readonly OnceEffect[] = ['wait', 'ask', 'answer', 'reschedule', 'staff_link'];

/** What this incoming message already did, if anything. null when nothing (or 0130 is not in). */
export async function handledAlready(chatId: bigint | number, messageId: number): Promise<OnceEffect | null> {
  if (!(await redeliveryReady())) return null;
  const keys = MESSAGE_EFFECTS_DONE.map((effect) => ({ effect, key: onceKey.message(chatId, messageId, effect) }));
  const rows = await db.execute<{ key: string }>(sql`
    SELECT key FROM telegram_once
     WHERE key IN (${sql.join(keys.map((k) => sql`${k.key}`), sql`, `)})
     LIMIT 1`);
  const hit = rows[0]?.key;
  return hit ? (keys.find((k) => k.key === hit)?.effect ?? null) : null;
}

/**
 * Both tables pruned. Safe here — unlike `automation_fires` (#614), where a
 * deleted row re-arms a rule: Telegram cannot deliver an update older than
 * 24 h, so a key past three days can never be asked again, and a wait that
 * expired more than 24 h ago can be answered by no message Telegram still
 * holds.
 */
export async function pruneTelegramRedelivery(): Promise<{ once: number; waits: number }> {
  if (!(await redeliveryReady())) return { once: 0, waits: 0 };
  const once = await db.execute<{ key: string }>(sql`
    DELETE FROM telegram_once WHERE created_at < now() - interval '3 days' RETURNING key`);
  const waits = await db.execute<{ chat_id: string }>(sql`
    DELETE FROM telegram_chat_waits WHERE expires_at < now() - interval '24 hours' RETURNING chat_id::text AS chat_id`);
  return { once: once.length, waits: waits.length };
}

export const JOB_TELEGRAM_PRUNE = 'telegram.redelivery-prune';

/** Nightly, 03:50 Tashkent (22:50 UTC). */
export async function registerTelegramPruneWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_TELEGRAM_PRUNE);
  await boss.schedule(JOB_TELEGRAM_PRUNE, '50 22 * * *');
  await boss.work(JOB_TELEGRAM_PRUNE, async () => {
    try {
      const removed = await pruneTelegramRedelivery();
      if (removed.once + removed.waits > 0) logger.info(removed, 'telegram redelivery records pruned');
    } catch (err) {
      logger.error({ err }, 'telegram redelivery prune failed');
      throw err;
    }
  });
}
