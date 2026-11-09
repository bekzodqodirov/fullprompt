import { logger } from '../logger';

/**
 * «Always the last message» (docs/IKKI-ESHIK.md §1.4, §4.1, §4.2): the
 * collection's ONE «Qabul qilindi» prompt, a burst's ONE offer and a parked
 * collection's ONE pause line each stay BELOW what the seller sent, so the
 * button he needs is the one at the bottom of the chat. ONE home for the
 * three (#513): each of them restated «edit, or delete and send again» once
 * already, and the restatements disagreed on what a refused edit means.
 *
 * Message ids in a chat only grow, the bot's own included, so «is the old
 * copy still last» is a comparison: nothing the caller knows of is newer.
 */

/** What Telegram said about a refused call. */
export function saidOf(err: unknown): string {
  const said = (err as { description?: unknown } | null)?.description;
  return typeof said === 'string' ? said : String(err);
}

/** Telegram's 400 «message is not modified» — success, never a reason to send again. */
export function notModified(err: unknown): boolean {
  return /message is not modified/iu.test(saidOf(err));
}

/**
 * The message itself is gone or past editing (too old, deleted) — the one
 * refusal a fresh message answers. A 429 past the brief retry, a timeout or a
 * reset is NOT: the edit may even have landed (review adv-16).
 */
export function editGone(err: unknown): boolean {
  return /message to edit not found|message can'?t be edited|MESSAGE_ID_INVALID/iu.test(saidOf(err));
}

/**
 * Is `prior` still the chat's last message? `newest` is the largest message
 * id the caller knows of in the chat — the incoming one that made it draw, or
 * a message the bot itself sent since. No prior copy is never «still last».
 */
export function stillLast(prior: number | null, newest: number | null): boolean {
  if (prior === null) return false;
  return newest === null || prior >= newest;
}

/** The api a kept-last draw needs: edit, and (optionally) delete the old copy. */
export type KeptLastApi = {
  editMessageText: (chatId: string, messageId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown>;
  deleteMessage?: (chatId: string, messageId: number) => Promise<unknown>;
};

export interface KeptLastDraw {
  /** The id the message now has — the caller stores it. */
  messageId: number;
  /** A new copy was sent below. */
  moved: boolean;
  /**
   * The older copy that could NOT be deleted (null when there was none or it
   * went): the caller keeps it among its own messages, so a press on its
   * buttons still works (§1.4).
   */
  kept: number | null;
}

/**
 * Draw `text` as the chat's last message. While `prior` is still last it is
 * EDITED — «not modified» is success. Otherwise (or when the edit is refused
 * because the message is gone) a new copy is sent below and the old one
 * deleted, best-effort. A refusal that is neither «gone» nor «not modified»
 * (a 429, a timeout) leaves the old copy standing: sending a second one there
 * would move the stored id off the message the seller is reading.
 */
export async function drawKeptLast(
  ctx: { reply: (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number }>; api?: KeptLastApi },
  chatId: bigint,
  prior: number | null,
  newest: number | null,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<KeptLastDraw> {
  if (prior !== null && ctx.api && stillLast(prior, newest)) {
    try {
      await ctx.api.editMessageText(String(chatId), prior, text, extra);
      return { messageId: prior, moved: false, kept: null };
    } catch (err) {
      if (notModified(err)) return { messageId: prior, moved: false, kept: null };
      if (!editGone(err)) {
        logger.warn({ err }, '[kept-last] edit refused — the old copy stays');
        return { messageId: prior, moved: false, kept: null };
      }
      // Gone: the copy below is the only one left to draw.
      const sent = await ctx.reply(text, extra);
      return { messageId: sent.message_id, moved: true, kept: null };
    }
  }
  const sent = await ctx.reply(text, extra);
  if (prior === null || prior === sent.message_id) return { messageId: sent.message_id, moved: true, kept: null };
  const deleted = await retireCopy(ctx.api, chatId, prior);
  return { messageId: sent.message_id, moved: true, kept: deleted ? null : prior };
}

/**
 * The older copy, once a new one stands below it: deleted, best-effort.
 * False = it stays, and the caller keeps it among its own messages so a press
 * on its buttons still works (§1.4). The other half of `drawKeptLast`, for a
 * caller whose new copy was sent by somebody else's draw (calc-amend's take:
 * the ONE prompt sent fresh with the take's line on top).
 */
export async function retireCopy(api: Pick<KeptLastApi, 'deleteMessage'> | undefined, chatId: bigint, messageId: number): Promise<boolean> {
  if (!api?.deleteMessage) return false;
  return api.deleteMessage(String(chatId), messageId).then(
    () => true,
    (err: unknown) => {
      logger.info({ err }, '[kept-last] older copy not deleted — it stays, its buttons still work');
      return false;
    },
  );
}

/** How long a burst of parts waits before the kept-last message is moved once (§1.4: an album moves it once). */
export const KEPT_LAST_DEBOUNCE_MS = 700;

const pending = new Map<string, { timer: ReturnType<typeof setTimeout> | null; run: () => Promise<void>; running: Promise<void> | null; again: boolean }>();

/**
 * Coalesce kept-last draws per `key` (the chat and what is drawn, e.g.
 * `prompt:<chat>`): the newest `run` wins, and it runs once after
 * `KEPT_LAST_DEBOUNCE_MS` of quiet — an album of ten files moves the prompt
 * ONCE, not ten times. A run already in flight is followed by one more when a
 * newer one arrived meanwhile. Dispatched `void`: never awaited on the poller.
 */
export function keepLastSoon(key: string, run: () => Promise<void>, ms: number = KEPT_LAST_DEBOUNCE_MS): void {
  const entry = pending.get(key);
  if (entry) {
    entry.run = run;
    if (entry.running) {
      entry.again = true;
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => fire(key), ms);
    return;
  }
  pending.set(key, { timer: setTimeout(() => fire(key), ms), run, running: null, again: false });
}

function fire(key: string): void {
  const entry = pending.get(key);
  if (!entry) return;
  entry.timer = null;
  entry.running = (async () => {
    do {
      entry.again = false;
      await entry.run().catch((err: unknown) => logger.warn({ err, key }, '[kept-last] draw failed'));
    } while (entry.again);
  })().finally(() => {
    pending.delete(key);
  });
}

/**
 * Every pending kept-last draw, run now and settled — the tests' and the
 * stop's wait (a draw owed when the process stops would otherwise be lost).
 */
export async function keptLastSettled(): Promise<void> {
  while (pending.size > 0) {
    for (const [key, entry] of pending) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        fire(key);
      }
    }
    await Promise.all([...pending.values()].map((e) => e.running ?? Promise.resolve()));
  }
}
