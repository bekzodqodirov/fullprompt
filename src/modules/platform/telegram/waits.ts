import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { logger } from '../logger';
import { redeliveryReady } from './redelivery-ready';

/**
 * The bot's one-message waits, durable (0130, Q5 a).
 *
 * «Natijani yozib yuboring», «Hodim» → the phone, an advert's «send your
 * number», a cabinet link code's contact step — each is something a person
 * was ASKED for, and until this round each lived only in this process's
 * memory, so a deploy forgot the question while the bot dropped the answer.
 * Now the backlog is kept, so the answer comes back: the question must too.
 *
 * MEMORY STAYS THE READER. Every reader on the ladder stays synchronous (a
 * delete-on-read at the heart of a ladder whose order eight test files pin)
 * and one process polls, so memory is authoritative while it lives; the table
 * only has to survive it. When durable, every arm and drop appends a write to
 * ONE promise chain — order preserved, never awaited on the poller except
 * where a consumer must: a consumer awaits the DELETE before its effect runs,
 * so a hydrated wait is never an already-used one.
 */

export type WaitKind = 'task' | 'staff_entry' | 'ad_visit' | 'cabinet_link';

/** Unix SECONDS, Telegram's unit. */
export interface WaitEntry<P> {
  payload: P;
  armedAt: number;
  expiresAt: number;
}

export type WaitVerdict = 'answers' | 'early' | 'expired';

/**
 * Pure. `early` only when the caller says the rule applies (a backlog TEXT
 * against a task wait, §3.4.3): a message that cannot have been written in
 * answer to a prompt that did not exist yet.
 */
export function waitVerdict(entry: { armedAt: number; expiresAt: number }, atSec: number, earlyApplies: boolean): WaitVerdict {
  if (atSec >= entry.expiresAt) return 'expired';
  if (earlyApplies && atSec < entry.armedAt) return 'early';
  return 'answers';
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const memory = new Map<string, WaitEntry<unknown>>();
const keyOf = (chatId: bigint | number | string, kind: WaitKind) => `${kind}:${String(chatId)}`;

let durable = false;
let writes: Promise<void> = Promise.resolve();
let writeCount = 0;
let warned = false;

function queueWrite(op: () => Promise<unknown>): void {
  if (!durable) return;
  writes = writes
    .then(async () => {
      if (!(await redeliveryReady())) return;
      writeCount += 1;
      await op();
    })
    .catch((err: unknown) => {
      // One line per process: a table that refuses every write must not
      // drown the log, and memory still answers while the process lives.
      if (!warned) logger.warn({ err }, '[bot] wait not written to the table');
      warned = true;
    });
}

/**
 * Arm (or re-arm) a wait. `merge(prev)` says whether an UNEXPIRED existing
 * entry is the SAME target; then the new entry keeps the earliest prompt's
 * time and the latest expiry — a second prompt for the same thing never
 * makes an answer to the first one «early» (judge Q5H-1).
 */
export function armWait<P extends object>(
  chatId: bigint | number,
  kind: WaitKind,
  payload: P,
  ttlMs: number,
  armedAtSec: number,
  merge?: (prev: P) => boolean,
): void {
  const key = keyOf(chatId, kind);
  const ttl = Math.max(1, Math.round(ttlMs / 1000));
  const prev = memory.get(key) as WaitEntry<P> | undefined;
  const same = prev !== undefined && prev.expiresAt > nowSec() && merge !== undefined && merge(prev.payload);
  const entry: WaitEntry<P> = same
    ? {
        payload,
        armedAt: Math.min(prev!.armedAt, armedAtSec),
        expiresAt: Math.max(prev!.expiresAt, armedAtSec + ttl),
      }
    : { payload, armedAt: armedAtSec, expiresAt: armedAtSec + ttl };
  memory.set(key, entry);
  queueWrite(() =>
    db.execute(sql`
      INSERT INTO telegram_chat_waits (chat_id, kind, payload, armed_at, expires_at)
      VALUES (${String(chatId)}::bigint, ${kind}, ${JSON.stringify(entry.payload)}::jsonb,
              to_timestamp(${entry.armedAt}::double precision), to_timestamp(${entry.expiresAt}::double precision))
      ON CONFLICT (chat_id, kind) DO UPDATE
        SET payload = EXCLUDED.payload, armed_at = EXCLUDED.armed_at, expires_at = EXCLUDED.expires_at`),
  );
}

/** Memory only — the verdict is the caller's. */
export function readWait<P>(chatId: bigint | number, kind: WaitKind): WaitEntry<P> | null {
  return (memory.get(keyOf(chatId, kind)) as WaitEntry<P> | undefined) ?? null;
}

export function dropWait(chatId: bigint | number, kind: WaitKind): void {
  const key = keyOf(chatId, kind);
  // Only what memory holds: the table never holds a wait this process does
  // not know (hydration loads it all), and the draft's door drops on every
  // start — a DELETE per «➕ Topshiriq» for nothing.
  if (!memory.has(key)) return;
  memory.delete(key);
  queueWrite(() =>
    db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id = ${String(chatId)}::bigint AND kind = ${kind}`),
  );
}

/** Production only (startTelegramBot); a test file opts in. Off = memory only, exactly as before 0130. */
export function setDurableWaits(on: boolean): void {
  durable = on;
}

/** The write chain as it stands — the stop awaits it, and so does every consumer before its effect. */
export function flushWaitWrites(): Promise<void> {
  return writes;
}

/**
 * Load the table into memory before the first getUpdates. A wait that
 * expired by the CLOCK can still be answered by a backlog message dated
 * inside its window, so the load reaches back as far as Telegram can (24 h).
 * Memory wins where it already holds a key.
 */
export async function hydrateWaits(): Promise<number> {
  await flushWaitWrites();
  if (!durable || !(await redeliveryReady())) return 0;
  const rows = await db.execute<{
    chat_id: string;
    kind: WaitKind;
    payload: unknown;
    armed_at: string | number;
    expires_at: string | number;
  }>(sql`
    SELECT chat_id::text AS chat_id, kind, payload,
           extract(epoch FROM armed_at)::bigint AS armed_at,
           extract(epoch FROM expires_at)::bigint AS expires_at
      FROM telegram_chat_waits
     WHERE expires_at > now() - interval '24 hours'`);
  let loaded = 0;
  for (const row of rows) {
    const key = keyOf(row.chat_id, row.kind);
    if (memory.has(key)) continue;
    memory.set(key, { payload: row.payload, armedAt: Number(row.armed_at), expiresAt: Number(row.expires_at) });
    loaded += 1;
  }
  return loaded;
}

/** Tests: a restart, as far as memory is concerned. */
export function __forgetWaitMemory(): void {
  memory.clear();
}

/** Tests: how many upserts/deletes were SENT to the table (0 while durable is off or not ready). */
export function __waitWriteCount(): number {
  return writeCount;
}

/** Tests: stall the write chain until the returned release is called — «awaited before the effect», deterministically. */
export function __holdWaitWrites(): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  writes = writes.then(() => gate);
  return release;
}
