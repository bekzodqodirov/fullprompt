import type { Context, MiddlewareFn } from 'grammy';
import { logger } from '../logger';
import { clipText } from './format';

/**
 * The press — every inline button's answer goes through here (Q5 a).
 *
 * Telegram refuses `answerCallbackQuery` for a press older than its wait
 * («query is too old and response timeout expired or query ID is invalid»,
 * and a second spelling «QUERY_ID_INVALID»). Until this round that refusal
 * was a thrown GrammyError with no catch anywhere, so the ORDER of answer and
 * work decided what a late press did: answer-first handlers did nothing,
 * act-first ones wrote and lost their confirmation, arm-first ones armed a
 * wait the person never saw a prompt for. Now the bot keeps the backlog, so
 * every press made during a deploy arrives late — and the answer must be a
 * logged no-op, never an abort.
 *
 * Two more things a late press needs, in `pressMiddleware`:
 *  - the toast Telegram would not show is SAID in the chat, unless the
 *    handler already said something there, or the toast is a progress notice
 *    for work that was dispatched (`say: false`), and at most once per pressed
 *    message;
 *  - a person who saw no answer taps again, and every tap is its own update:
 *    a repeat of a LATE press on the same message is answered and NOT run.
 */

export type PressAnswer = 'answered' | 'stale' | 'failed';

type PressCtx = { answerCallbackQuery: (other?: { text?: string }) => Promise<unknown> };

/** What a late press would have said — read back by the middleware after the handler. */
const lateOf = new WeakMap<object, { toast: string | null; say: boolean }>();

/** Telegram's «too late» for a press: 400 + «query is too old» / «query ID is invalid» / «QUERY_ID_INVALID». */
export function isStalePress(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { error_code?: unknown }).error_code;
  const description = (err as { description?: unknown }).description;
  return (
    Number(code) === 400 &&
    typeof description === 'string' &&
    /query is too old|query[ _]id[ _](?:is[ _])?invalid/i.test(description)
  );
}

/**
 * The ONLY caller of answerCallbackQuery (fenced). Never throws. `say: false`
 * = a progress notice for dispatched work, which is never repeated as a chat
 * message when it comes too late to be a toast.
 */
export async function answerPress(ctx: PressCtx, toast?: string, opts: { say?: boolean } = {}): Promise<PressAnswer> {
  try {
    await ctx.answerCallbackQuery(toast ? { text: clipText(toast, 200) } : undefined);
    return 'answered';
  } catch (err) {
    if (isStalePress(err)) {
      lateOf.set(ctx, { toast: toast ?? null, say: opts.say !== false });
      logger.info({ data: (ctx as unknown as Context).callbackQuery?.data }, '[bot] press answered late');
      return 'stale';
    }
    // A network blip: the messages after it will fail on their own; the work still runs.
    logger.warn({ err }, '[bot] press not answered');
    return 'failed';
  }
}

/** How long a repeat of a LATE press on the same message is answered and not run. Processing clock. */
export const REPEAT_PRESS_MS = 60_000;

/** The Bot API methods that put something the person can SEE into the chat. */
const VISIBLE = new Set([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendMediaGroup',
  'copyMessage',
  'forwardMessage',
  'editMessageText',
]);

/** `${chat}:${message}:${data}` → when its press was answered late. */
const lateAt = new Map<string, number>();
/** `${chat}:${message}:${toast}` — a late toast already said in that chat. */
const toastSaid = new Map<string, number>();

function prune(map: Map<string, number>, now: number): void {
  if (map.size > 10_000) map.clear();
  for (const [key, at] of map) if (now - at >= REPEAT_PRESS_MS) map.delete(key);
}

/**
 * Says a refused toast in the chat when the handler said nothing there
 * itself; answers repeats of a late press once. Only for callback queries.
 */
export function pressMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const q = ctx.callbackQuery;
    if (!q) return next();
    const chat = ctx.chat?.id ?? q.from.id;
    const msg = q.message?.message_id ?? 0;
    const same = `${chat}:${msg}:${q.data ?? ''}`;
    const last = lateAt.get(same);
    if (last !== undefined && Date.now() - last < REPEAT_PRESS_MS) {
      // A repeat tap of a press that could not even be answered — the person
      // was tapping into a bot that was not there. Five «📷» are one request.
      await answerPress(ctx);
      return;
    }
    let said = false;
    ctx.api.config.use((prev, method, payload, signal) => {
      const target = (payload as { chat_id?: unknown } | undefined)?.chat_id;
      if (VISIBLE.has(method) && target !== undefined && String(target) === String(ctx.chat?.id)) said = true;
      return prev(method, payload, signal);
    });
    await next();
    const late = lateOf.get(ctx);
    if (!late) return;
    const now = Date.now();
    prune(lateAt, now);
    lateAt.set(same, now);
    const toastKey = `${chat}:${msg}:${late.toast ?? ''}`;
    if (late.toast && late.say && !said && !toastSaid.has(toastKey)) {
      prune(toastSaid, now);
      toastSaid.set(toastKey, now);
      await ctx.reply(late.toast).catch((err: unknown) => logger.warn({ err }, '[bot] late toast not said'));
    }
  };
}

/** Tests: forget every late press. */
export function __resetPresses(): void {
  lateAt.clear();
  toastSaid.clear();
}
