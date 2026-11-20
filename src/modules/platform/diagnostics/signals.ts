import { eq, like, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { systemSignals } from '../db/schema';

/**
 * The ONE writer of `system_signals` (0115) — a row per thing that is wrong
 * with the system right now, deleted when it clears.
 *
 * One module because two writers of one fact is how facts go stale (#513).
 * The judge of this package found exactly that in the first design: the bot's
 * «refused» was to be written by the staff drain and cleared by a different
 * rule, while two other senders (the customer notices, the broadcast) saw the
 * same refusal and said nothing — so the red line could stand all night after
 * the token was fixed. The bot fact is now recorded by the sender every Bot API
 * call goes through (telegram/send.ts `noteBotAnswer`), which calls
 * `recordBotState` below and nothing else; a unit fence pins that no other file
 * names the key.
 */

/** The bot's token was refused by Telegram (401/404). */
export const BOT_SIGNAL = 'telegram:bot';

/** Disk signals: `disk:db` (the database + backups disk), `disk:photos`. */
export type DiskSignalKey = 'disk:db' | 'disk:photos';

export interface BotRefused {
  since: Date;
  detail: string | null;
}

/**
 * Telegram refused the token, or took it back. `since` is written ONCE — a
 * second refusal moves only the detail and the clock of the last sighting, so
 * «14:02 dan beri» keeps meaning when it started.
 */
export async function recordBotState(state: { down: boolean; detail: string }): Promise<void> {
  if (!state.down) {
    await db.delete(systemSignals).where(eq(systemSignals.key, BOT_SIGNAL));
    return;
  }
  const detail = state.detail.slice(0, 300) || null;
  await db
    .insert(systemSignals)
    .values({ key: BOT_SIGNAL, detail })
    .onConflictDoUpdate({
      target: systemSignals.key,
      set: { detail, updatedAt: sql`now()` },
    });
}

export async function botRefused(): Promise<BotRefused | null> {
  const [row] = await db
    .select({ since: systemSignals.since, detail: systemSignals.detail })
    .from(systemSignals)
    .where(eq(systemSignals.key, BOT_SIGNAL));
  return row ?? null;
}

export interface DiskSignal {
  key: DiskSignalKey;
  level: number;
  detail: string | null;
}

/** Every disk signal standing now — the home screen reads these rows, never statfs. */
export async function diskSignals(): Promise<DiskSignal[]> {
  const rows = await db
    .select({ key: systemSignals.key, level: systemSignals.level, detail: systemSignals.detail })
    .from(systemSignals)
    .where(like(systemSignals.key, 'disk:%'));
  return rows.map((r) => ({ key: r.key as DiskSignalKey, level: r.level, detail: r.detail }));
}

/**
 * A fault said ONCE and taken back once (stage 1a §4.5 — the AI seller's liveness alarm, key `agent:liveness`): the
 * row stands while the fault does. `raiseSignal` writes it or moves its detail, and answers TRUE only for the write
 * that OPENED the row (`xmax = 0` — the claim, #599): two sweeps at once, or a sweep every minute while it stands,
 * tell nobody twice. `since` is written once, like the bot's. Generic on purpose — the key is free text (0115 put no
 * CHECK on it), so a later watch needs no migration; `diskSignals` reads `disk:%` and `botRefused` its own key, so
 * neither picks another's row up.
 */
export async function raiseSignal(key: string, detail: string | null): Promise<boolean> {
  const text = detail === null ? null : detail.slice(0, 300) || null;
  const rows = await db.execute<{ opened: boolean }>(sql`
    INSERT INTO system_signals (key, detail) VALUES (${key}, ${text})
    ON CONFLICT (key) DO UPDATE SET detail = EXCLUDED.detail, updated_at = now()
    RETURNING (xmax = 0) AS opened`);
  return [...rows][0]?.opened === true;
}

/** The fault cleared: the row goes, and TRUE only for the call that took it (the one «it is over» to say). */
export async function clearSignal(key: string): Promise<boolean> {
  const gone = await db.delete(systemSignals).where(eq(systemSignals.key, key)).returning({ key: systemSignals.key });
  return gone.length > 0;
}

export interface StandingSignal {
  since: Date;
  detail: string | null;
  updatedAt: Date;
}

/** Is this fault standing now — the screens' read of a row `raiseSignal` wrote (the home's red row, the AI page). */
export async function signalStanding(key: string): Promise<StandingSignal | null> {
  const [row] = await db
    .select({ since: systemSignals.since, detail: systemSignals.detail, updatedAt: systemSignals.updatedAt })
    .from(systemSignals)
    .where(eq(systemSignals.key, key));
  return row ?? null;
}

/** The same rows as key → level (80 / 90), for the hourly check. */
export async function diskLevels(): Promise<Map<DiskSignalKey, number>> {
  return new Map((await diskSignals()).map((s) => [s.key, s.level]));
}

/**
 * Store a disk's alarm step. 0 deletes the row (nothing is wrong); a new step
 * keeps `since` — the disk has been filling since it first crossed 80.
 */
export async function setDiskLevel(key: DiskSignalKey, level: number, detail: string | null): Promise<void> {
  if (level <= 0) {
    await db.delete(systemSignals).where(eq(systemSignals.key, key));
    return;
  }
  await db
    .insert(systemSignals)
    .values({ key, level, detail })
    .onConflictDoUpdate({
      target: systemSignals.key,
      set: { level, detail, updatedAt: sql`now()` },
    });
}
