import { asc, eq, sql } from 'drizzle-orm';
import { db, pgClient } from '../../platform/db/client';
import { clients, tgAccounts, tgMessages, users } from '../../platform/db/schema';
import { openSession, sealSession, sessionKey, sessionOpens } from './telegram-session';
import { bridgeState, type BridgeState } from './telegram-live';
import type { ClientPhones, MessageRow } from './telegram-import';

/**
 * The stored Telegram logins, and the messages the live bridge writes.
 *
 * Everything that touches the encrypted session goes through here, so there is
 * one place where a session string exists in the clear and it is a local
 * variable inside a function — never a field on a returned object, never a
 * column read by a screen, never in a log line.
 */

/** Save (or replace) a manager's login — `pnpm tg-login` or the «ulash» screen. */
export async function saveAccount(input: {
  managerUserId: string;
  tgPhone: string;
  session: string;
}): Promise<void> {
  const sealed = sealSession(input.session, input.managerUserId, sessionKey());
  await db
    .insert(tgAccounts)
    .values({
      managerUserId: input.managerUserId,
      tgPhone: input.tgPhone,
      sessionEnc: sealed,
      status: 'active',
    })
    // Logging in again REPLACES: one account, one session. Two live
    // connections on one personal Telegram is what gets it flagged.
    .onConflictDoUpdate({
      target: tgAccounts.managerUserId,
      set: {
        tgPhone: input.tgPhone,
        sessionEnc: sealed,
        status: 'active',
        lastError: null,
        lastSeenAt: null,
        updatedAt: new Date(),
      },
    });
}

export interface LoadedAccount {
  id: string;
  managerUserId: string;
  managerName: string;
  tgPhone: string;
  /** In the clear, for the listener only. Never leaves this process. */
  session: string;
}

/** The account the listener is to run, decrypted. Null when there is none. */
export async function loadAccount(tgPhone: string): Promise<LoadedAccount | null> {
  const [row] = await db
    .select({
      id: tgAccounts.id,
      managerUserId: tgAccounts.managerUserId,
      managerName: users.fullName,
      tgPhone: tgAccounts.tgPhone,
      sessionEnc: tgAccounts.sessionEnc,
      status: tgAccounts.status,
    })
    .from(tgAccounts)
    .innerJoin(users, eq(tgAccounts.managerUserId, users.id))
    .where(eq(tgAccounts.tgPhone, tgPhone))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    managerUserId: row.managerUserId,
    managerName: row.managerName,
    tgPhone: row.tgPhone,
    session: openSession(row.sessionEnc, row.managerUserId, sessionKey()),
  };
}

/**
 * Every account the supervisor should be listening to. `signed_out` is
 * excluded — Telegram has ended that session, and knocking on it once a
 * minute until somebody logs in again is exactly the pattern that gets an
 * account flagged. A fresh login writes 'active' and the next scan picks
 * it up (round 21: connect from the screen, no container restarts).
 */
export async function listListenablePhones(): Promise<string[]> {
  const rows = await db
    .select({ tgPhone: tgAccounts.tgPhone })
    .from(tgAccounts)
    .where(sql`${tgAccounts.status} <> 'signed_out'`)
    .orderBy(asc(tgAccounts.createdAt));
  return rows.map((r) => r.tgPhone);
}

export interface AccountStatus {
  id: string;
  managerUserId: string;
  managerName: string;
  tgPhone: string;
  state: BridgeState;
  lastSeenAt: Date | null;
  lastError: string | null;
  /**
   * False when the stored blob no longer opens with the key the server holds.
   * A rotated `TG_SESSION_KEY` and a session Telegram ended look identical
   * from outside — "not connected" — and have completely different answers.
   */
  keyOpens: boolean;
}

/** For the status panel. Deliberately returns no session material at all. */
export async function accountStatuses(now = new Date()): Promise<AccountStatus[]> {
  const rows = await db
    .select({
      id: tgAccounts.id,
      managerUserId: tgAccounts.managerUserId,
      managerName: users.fullName,
      tgPhone: tgAccounts.tgPhone,
      sessionEnc: tgAccounts.sessionEnc,
      status: tgAccounts.status,
      lastSeenAt: tgAccounts.lastSeenAt,
      lastError: tgAccounts.lastError,
    })
    .from(tgAccounts)
    .innerJoin(users, eq(tgAccounts.managerUserId, users.id))
    .orderBy(users.fullName);

  // A missing or wrong key must not take the SCREEN down — the screen is where
  // somebody would find out that the key is wrong.
  let key: Buffer | null = null;
  try {
    key = sessionKey();
  } catch {
    key = null;
  }

  return rows.map((r) => ({
    id: r.id,
    managerUserId: r.managerUserId,
    managerName: r.managerName,
    tgPhone: r.tgPhone,
    state: bridgeState({ status: r.status, lastSeenAt: r.lastSeenAt }, now),
    lastSeenAt: r.lastSeenAt,
    lastError: r.lastError,
    keyOpens: key !== null && sessionOpens(r.sessionEnc, r.managerUserId, key),
  }));
}

/**
 * The listener has started and the link is up.
 *
 * Without this, `status` was a one-way street: a graceful stop wrote
 * 'stopped' and only a fresh `pnpm tg-login` ever wrote 'active' again. One
 * ordinary restart therefore left the bridge reading "stopped" for ever —
 * and because queueing a reply refuses when the bridge is not live, it also
 * made the whole of phase 4 unusable until somebody logged in again.
 */
export async function markAccountActive(accountId: string): Promise<void> {
  await db
    .update(tgAccounts)
    .set({ status: 'active', lastError: null, lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(tgAccounts.id, accountId));
}

/** The listener is alive. Called on a timer, not per message. */
export async function heartbeat(accountId: string): Promise<void> {
  await db
    .update(tgAccounts)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(tgAccounts.id, accountId));
}

/**
 * The connection ended, and why.
 *
 * `signed_out` is terminal and needs a new login; `stopped` is an ordinary
 * shutdown. The reason is stored as text because it is read by a person, and
 * the set of things Telegram can say is not ours to enumerate.
 */
export async function markAccount(
  accountId: string,
  status: 'stopped' | 'signed_out',
  lastError: string | null,
): Promise<void> {
  await db
    .update(tgAccounts)
    .set({ status, lastError, updatedAt: new Date() })
    .where(eq(tgAccounts.id, accountId));
}

/**
 * The client book, in the shape the decision functions want.
 *
 * ORDERED, and that is not tidiness. One person here routinely holds several
 * codes on one phone number (777, 555, 444 in one pair of hands), and
 * `classifyDialog` takes the FIRST match — so without an order the same
 * conversation lands under a different code depending on what postgres felt
 * like returning. By client code means the same chat always files under the
 * same one, and a wrong-but-stable answer can at least be corrected.
 */
export async function clientBook(): Promise<ClientPhones[]> {
  return db
    .select({ id: clients.id, clientCode: clients.clientCode, phones: clients.phones })
    .from(clients)
    .orderBy(asc(clients.clientCode));
}

/**
 * A message the sender EDITED after we stored it — the thread must show what
 * it says NOW, not what it said first (queued follow-up from phase 3).
 *
 * UPDATE-only, never an insert, and that is the privacy half: an edit in a
 * chat we never kept must leave no trace, and the cheapest way to guarantee
 * that is to only ever touch rows that already exist. Media flips are folded
 * to true-only: Telegram lets a caption change but not the photo itself, so
 * a stored `has_media` never becomes false by edit. Returns whether a row
 * was actually there.
 */
export async function applyEdit(input: {
  managerUserId: string;
  peerId: bigint;
  tgMessageId: bigint;
  body: string | null;
}): Promise<boolean> {
  const rows = await db
    .update(tgMessages)
    .set({ body: input.body })
    .where(
      sql`${tgMessages.managerUserId} = ${input.managerUserId}
        AND ${tgMessages.peerId} = ${input.peerId}
        AND ${tgMessages.tgMessageId} = ${input.tgMessageId}`,
    )
    .returning({ id: tgMessages.id });
  return rows.length > 0;
}

export interface ResumePoint {
  peerId: bigint;
  /** The highest Telegram message id already stored for this chat. */
  lastMessageId: bigint;
}

/**
 * Where to pick each conversation back up after the listener was away.
 *
 * There is no other source for this. GramJS's `catchUp()` is an empty stub
 * (`client/updates.js:65` — literally `{ // TODO }`) and the package makes no
 * `updates.GetDifference` call at all, so a reconnect resumes from wherever
 * the new session happens to start and everything sent in between is never
 * delivered to anybody. Nothing was written down on this side either:
 * `storeIncoming` was fire-and-forget and no high-water mark was read back.
 *
 * The mark is per PEER, because Telegram message ids are per conversation and
 * one global number would be meaningless across chats. It costs a single
 * grouped query at startup.
 */
export async function resumePoints(managerUserId: string): Promise<ResumePoint[]> {
  const rows = await db.execute<{ peer_id: string; last_id: string }>(sql`
    SELECT peer_id, max(tg_message_id) AS last_id
    FROM tg_messages
    WHERE manager_user_id = ${managerUserId}
    GROUP BY peer_id
  `);
  // Through strings: a Telegram id does not survive Number().
  return rows.map((r) => ({ peerId: BigInt(r.peer_id), lastMessageId: BigInt(r.last_id) }));
}

/**
 * Write one live message.
 *
 * `onConflictDoNothing` against the same unique index the import uses, so a
 * reconnect that replays recent history — which Telegram does — costs nothing
 * and duplicates nothing. Returns the NEW row's id, or null for a replay —
 * which is both the listener's counter and the key a downloaded photo binds
 * to, and the null is what makes a replay never re-download.
 */
export async function storeIncoming(input: {
  clientId: string;
  managerUserId: string;
  row: MessageRow;
}): Promise<string | null> {
  const written = await db
    .insert(tgMessages)
    .values({
      clientId: input.clientId,
      managerUserId: input.managerUserId,
      peerId: input.row.peerId,
      tgMessageId: input.row.tgMessageId,
      direction: input.row.direction,
      body: input.row.body,
      hasMedia: input.row.hasMedia,
      sentAt: input.row.sentAt,
    })
    .onConflictDoNothing()
    .returning({ id: tgMessages.id });
  return written[0]?.id ?? null;
}

/**
 * One listener per account, enforced by postgres rather than by hoping.
 *
 * A second connection on the same personal Telegram account is the thing that
 * gets it limited, and "did I leave one running on the other machine" is not a
 * question anybody can answer at the time. An advisory lock is held by the
 * CONNECTION and released when it closes — including when the process dies
 * badly, which a "who is running" table would not survive.
 *
 * It takes a RESERVED connection rather than borrowing one from the pool: a
 * pooled connection can be closed underneath us and would take the lock with
 * it silently, which is the one failure this must not have. The reservation is
 * held for the life of the listener, so the lock's lifetime is the process's.
 *
 * Releasing UNLOCKS before handing the connection back. `release()` alone
 * returns the connection to the pool without closing it, so the lock rides
 * along on an idle connection and the account stays locked for a process that
 * has already let it go — proved by the integration test, which could not take
 * the lock again after a clean release.
 */
export async function takeListenerLock(accountId: string): Promise<(() => Promise<void>) | null> {
  const reserved = await pgClient.reserve();
  // The key is spelled out at both call sites rather than built as a fragment:
  // this is a postgres.js template, not a drizzle one, and a fragment from the
  // wrong library interpolates as a value instead of as SQL.
  const [row] = await reserved<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('gsr-tg-listen'), hashtext(${accountId})) AS locked`;
  if (row?.locked !== true) {
    reserved.release();
    return null;
  }
  return async () => {
    try {
      await reserved`SELECT pg_advisory_unlock(hashtext('gsr-tg-listen'), hashtext(${accountId}))`;
    } finally {
      reserved.release();
    }
  };
}
