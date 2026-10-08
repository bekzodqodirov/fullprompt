import type { Bot, Context, MiddlewareFn } from 'grammy';
import type { Update } from 'grammy/types';
import { logger } from '../logger';

/**
 * The bot's start and stop (Q5 a, the owner 2026-10-07: «O'rnatish paytida
 * botga Telegramda yozilgan javoblar — bot qayta yoqilganda qayta
 * ishlansin»).
 *
 * The bot no longer drops what Telegram held while no process was polling, so
 * two moments matter and both live here, with no database:
 *
 *  - BOOT — when this process started taking updates. Every prompt, wait and
 *    collector this process opened was opened after it, and every backlog
 *    message is dated before it, so a backlog message cannot have been written
 *    in answer to anything this process put on the screen (`isBacklog`).
 *  - STOP — confirming to Telegram exactly what FINISHED. grammy's own
 *    `bot.stop()` confirms `lastTriedUpdateId + 1`, i.e. it marks the update
 *    being handled at that instant as done before it is, and its `for` loop
 *    never reads `pollingRunning`, so the rest of the batch goes on being
 *    handled after the stop while staying unconfirmed. Hence the guard below
 *    HOLDS (never runs, never skips) every update that arrives once stopping
 *    began, and the stop confirms `lastDone + 1` itself.
 */

/** Unix SECONDS — Telegram's own unit for `message.date`. 0 = not booted (a test: nothing is backlog). */
let bootSec = 0;

/** When this process started taking updates — the backlog line (§3.5). */
export function markBoot(at: Date = new Date()): void {
  bootSec = Math.floor(at.getTime() / 1000);
}

export function bootedAtSec(): number {
  return bootSec;
}

/** A message written before this process could have seen it. */
export function isBacklog(messageDateSec: number): boolean {
  return bootSec > 0 && messageDateSec < bootSec;
}

/**
 * Settles (never rejects) when `p` settles or after `ms`, whichever is first.
 * The ONE race helper: a stop that throws, or hangs on Telegram, must never
 * keep the process from handing the signal on.
 */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<'settled' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve('settled');
      },
      () => {
        clearTimeout(timer);
        resolve('settled');
      },
    );
  });
}

interface LifecycleState {
  stopping: boolean;
  /** The update being handled, in its SETTLED form (a throw must not abort the stop). */
  inFlight: Promise<void> | null;
  /** The highest update id whose handler returned (or threw) in this process. */
  lastDone: number;
  /** The first update that arrived after the signal and was held. */
  held: number | null;
}

const state: LifecycleState = { stopping: false, inFlight: null, lastDone: 0, held: null };

const NEVER = new Promise<never>(() => {});
const noop = () => {};

export function isStopping(): boolean {
  return state.stopping;
}

export function lastDoneUpdateId(): number {
  return state.lastDone;
}

/**
 * The ONE first middleware (fenced: the first registration in
 * `registerBotHandlers`). Holds every update that arrives once stopping
 * began; tracks the one in flight.
 *
 * WHY hold and not skip: a skipped update lets grammy's loop advance
 * `lastTriedUpdateId` and, at the batch end, confirm it with the next
 * `getUpdates` — lost. A held update parks the loop, so nothing after
 * `lastDone` is ever confirmed. A signal cannot land between grammy setting
 * `lastTriedUpdateId` and this guard running: both are one synchronous run,
 * and signal callbacks are macrotasks.
 */
export function stoppingGuard(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (state.stopping) {
      state.held ??= ctx.update.update_id;
      await NEVER;
      return;
    }
    const run = (async () => {
      await next();
    })();
    state.inFlight = run.then(noop, noop);
    try {
      await run;
    } finally {
      state.lastDone = ctx.update.update_id;
      state.inFlight = null;
    }
  };
}

export interface StopOutcome {
  via: 'stop' | 'confirm' | 'not_running';
  confirmedThrough: number | null;
  inFlightFinished: boolean;
  ms: number;
}

/** The whole stop's ceiling, chained before Next's own cleanup (owner Q5 a: 5 s). */
export const BOT_STOP_DEADLINE_MS = 5_000;

/** How long the update in flight (and the membership chain) may take to finish. */
const IN_FLIGHT_MS = 3_000;
/** How long the durable waits may take to reach the table. */
const FLUSH_MS = 1_000;
/** How long the confirm itself may take. */
const CONFIRM_MS = 1_000;

export async function stopTelegramBot(deps: {
  bot: Pick<Bot, 'stop' | 'isRunning'> & { api: Pick<Bot['api'], 'getUpdates'> };
  /** flushWaitWrites (waits.ts) — durability before confirmation. */
  flush: () => Promise<void>;
  /** membershipSettled (price-channel-handlers.ts). */
  drain: () => Promise<void>;
  deadlineMs?: number;
}): Promise<StopOutcome> {
  const started = Date.now();
  // Synchronous, first: `startPolling` reads it before every `bot.start`, so
  // a 409 wait cannot restart polling after the signal.
  state.stopping = true;
  const budget = deps.deadlineMs ?? BOT_STOP_DEADLINE_MS;
  const left = (ms: number) => Math.max(0, Math.min(ms, budget - (Date.now() - started)));

  if (!deps.bot.isRunning()) {
    await settleWithin(Promise.resolve().then(deps.flush), left(FLUSH_MS));
    const outcome: StopOutcome = { via: 'not_running', confirmedThrough: null, inFlightFinished: true, ms: Date.now() - started };
    logger.info({ ...outcome }, 'telegram bot stopped');
    return outcome;
  }

  // The update in flight AND the price-channel membership chain, one budget.
  const waited = await settleWithin(
    Promise.all([state.inFlight ?? Promise.resolve(), Promise.resolve().then(deps.drain)]),
    left(IN_FLIGHT_MS),
  );
  // Durability before confirmation: a wait armed by a handled update is
  // written before that update is confirmed.
  await settleWithin(Promise.resolve().then(deps.flush), left(FLUSH_MS));

  let outcome: StopOutcome;
  if (state.inFlight === null && state.held === null) {
    // Idle in the long poll: grammy's offset is then exactly lastDone + 1,
    // and its stop aborts the poll.
    await settleWithin(
      Promise.resolve()
        .then(() => deps.bot.stop())
        .catch((err: unknown) => logger.warn({ err }, 'telegram stop confirm failed')),
      left(CONFIRM_MS),
    );
    outcome = { via: 'stop', confirmedThrough: state.lastDone || null, inFlightFinished: waited === 'settled', ms: 0 };
  } else {
    // Still inside handleUpdates (an update running past the budget, or one
    // held): no long poll is open, so confirm through lastDone ourselves. The
    // unfinished and the held updates stay unconfirmed and reach the next
    // process.
    const through = state.lastDone;
    await settleWithin(
      Promise.resolve()
        .then(() =>
          deps.bot.api.getUpdates(
            { offset: through + 1, limit: 1, timeout: 0 },
            AbortSignal.timeout(CONFIRM_MS),
          ),
        )
        .catch((err: unknown) => logger.warn({ err }, 'telegram stop confirm failed')),
      left(CONFIRM_MS),
    );
    outcome = {
      via: 'confirm',
      confirmedThrough: through || null,
      inFlightFinished: state.inFlight === null,
      ms: 0,
    };
  }
  outcome.ms = Date.now() - started;
  logger.info({ ...outcome }, 'telegram bot stopped');
  return outcome;
}

type SignalTarget = Pick<NodeJS.Process, 'listeners' | 'removeAllListeners' | 'once' | 'kill' | 'pid'>;

/**
 * Stop the bot FIRST (raced against the deadline here, so a stop that never
 * settles still hands the signal on), then hand the signal to whoever listened
 * before — Next's own cleanup, which closes HTTP and exits.
 *
 * WHY chain instead of racing Next: Next's cleanup ends in `process.exit(0)`
 * after `server.close()`, milliseconds on Node 22; the confirm is a round trip
 * to Telegram, and running alongside it loses most of the time. `once`: a
 * second Ctrl+C inside the window meets the default action and kills at once.
 */
export function installBotShutdown(
  target: SignalTarget,
  stop: () => Promise<unknown>,
  deadlineMs: number = BOT_STOP_DEADLINE_MS,
): void {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    const before = target.listeners(sig) as ((s: NodeJS.Signals) => void)[];
    target.removeAllListeners(sig);
    target.once(sig, () => {
      void settleWithin(Promise.resolve().then(stop), deadlineMs).then(() => {
        if (before.length > 0) for (const listener of before) listener(sig);
        else target.kill(target.pid, sig);
      });
    });
  }
}

/** For bot.catch: which update threw — the old log line named none of it. */
export function updateSummary(update: Update): { id: number; kind: string; chatId: number | null } {
  const kind = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
  const body = (update as unknown as Record<string, unknown>)[kind] as
    | { chat?: { id?: number }; message?: { chat?: { id?: number } }; from?: { id?: number } }
    | undefined;
  const chatId = body?.chat?.id ?? body?.message?.chat?.id ?? body?.from?.id ?? null;
  return { id: update.update_id, kind, chatId: typeof chatId === 'number' ? chatId : null };
}

/** Tests: stopping=false, inFlight=null, lastDone=0, held=null, boot=0. */
export function __resetLifecycle(): void {
  state.stopping = false;
  state.inFlight = null;
  state.lastDone = 0;
  state.held = null;
  bootSec = 0;
}
