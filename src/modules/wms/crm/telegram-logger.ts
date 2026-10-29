import { Logger, type LogLevel } from 'telegram/extensions/Logger';
import { parseFloodSleep } from './telegram-guard';

/**
 * gramjs's own flood sleeps, made into rows (review ban-2's DEVIATION).
 *
 * `invoke` swallows every FLOOD_WAIT up to the client's floodSleepThreshold
 * (60 s, gramjs's default and deliberately kept — at 0 every dialog walk,
 * getChat and media download becomes a throw): it logs «Sleeping for Ns on
 * flood wait (Caused by X)», sleeps, and re-sends the same request. Those are
 * the ORDINARY waits on messages.SendMessage, and until now they reached
 * nobody — the pump only ever saw the ones over a minute. So the line itself
 * is the signal: this logger reads it before anything else and hands it to
 * `onSleep`, which writes `tg_account_floods` («two in 24 h» counts that
 * table).
 *
 * It reads `info()` BEFORE the level check — the parent decides whether the
 * line is printed, never whether it is seen — so a listener that one day
 * lowers gramjs's log level does not quietly switch the ledger off with it.
 * A throwing callback must not break gramjs's invoke loop, so it is caught.
 */
export class FloodRecordingLogger extends Logger {
  constructor(
    private readonly onSleep: (sleep: { seconds: number; method: string }) => void,
    level?: LogLevel,
  ) {
    super(level);
  }

  override info(message: string): void {
    const sleep = typeof message === 'string' ? parseFloodSleep(message) : null;
    if (sleep) {
      try {
        this.onSleep(sleep);
      } catch {
        // The ledger is a record of the wait, never a reason to break it.
      }
    }
    super.info(message);
  }
}
