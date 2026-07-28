import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { tgAccounts, tgMessages, tgOutbox, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { getSetting } from '../../platform/settings/service';
import { bridgeState } from './telegram-live';
import {
  bodyTooLong,
  canQueue,
  DEFAULT_LIMITS,
  type SendContext,
  type SendVerdict,
} from './telegram-send';

/**
 * The reply queue — the database half of phase 4.
 *
 * The web app never sends. It writes a row here and the listener, which is the
 * one process allowed to hold a connection to the account, picks it up. That
 * is not indirection for its own sake: two connections on one personal
 * Telegram account is the thing the whole design exists to avoid.
 */

export class OutboxError extends Error {}

/**
 * Which Telegram chat this client is reachable on, through this manager.
 *
 * Taken from the conversation itself rather than from a phone number, because
 * the peer id is the thing Telegram actually addresses and it is already in
 * `tg_messages` — the same id the import and the listener store. Deriving it
 * from a phone would mean resolving a number to a user, which is an API call
 * that looks exactly like the behaviour that gets accounts flagged.
 *
 * Null when this manager has never exchanged anything with this client: there
 * is then no conversation to reply in, which is precisely the case the
 * never-initiate rule refuses.
 */
export async function peerForClient(
  clientId: string,
  managerUserId: string,
): Promise<bigint | null> {
  const [row] = await db
    .select({ peerId: tgMessages.peerId })
    .from(tgMessages)
    .where(and(eq(tgMessages.clientId, clientId), eq(tgMessages.managerUserId, managerUserId)))
    .orderBy(desc(tgMessages.sentAt))
    .limit(1);
  return row?.peerId ?? null;
}

/**
 * May this person reply in this conversation, and from whose account?
 *
 * Only from their OWN. The message leaves a manager's personal Telegram and
 * arrives under that manager's name and photograph — so replying "as" a
 * colleague is not a permission question, it is impersonating them to a
 * customer. The owner is not exempt: it is his employee's own account, not a
 * company mailbox.
 *
 * Returns null when the actor has no conversation with this client of their
 * own, which is also the honest answer for a manager reading somebody else's
 * thread: they may read it (that is what the CRM is for) and they may not
 * speak in it.
 */
export async function replyAccountFor(
  clientId: string,
  actorId: string,
): Promise<{ managerUserId: string; peerId: bigint } | null> {
  const peerId = await peerForClient(clientId, actorId);
  if (peerId === null) return null;
  return { managerUserId: actorId, peerId };
}

/** Whose accounts hold a conversation with this client — for the screen's note. */
export async function conversationManagers(clientId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: users.fullName })
    .from(tgMessages)
    .innerJoin(users, eq(tgMessages.managerUserId, users.id))
    .where(eq(tgMessages.clientId, clientId));
  return rows.map((r) => r.name);
}

const minuteAgo = (now: Date) => new Date(now.getTime() - 60_000);
const dayAgo = (now: Date) => new Date(now.getTime() - 24 * 60 * 60 * 1000);

/**
 * Everything the send rules need, gathered once.
 *
 * The counts are of rows that were actually SENT, not queued: a row sitting in
 * the queue has cost the account nothing, and counting it would make a stalled
 * listener look like a rate-limit breach.
 */
export async function sendContextFor(input: {
  clientId: string;
  managerUserId: string;
  peerId: bigint | null;
  now?: Date;
}): Promise<SendContext> {
  const now = input.now ?? new Date();
  const [enabled, account] = await Promise.all([
    getSetting('tg_sending_enabled'),
    db
      .select({ status: tgAccounts.status, lastSeenAt: tgAccounts.lastSeenAt })
      .from(tgAccounts)
      .where(eq(tgAccounts.managerUserId, input.managerUserId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  const counted = async (since: Date, peerId?: bigint) => {
    const where = [
      eq(tgOutbox.managerUserId, input.managerUserId),
      eq(tgOutbox.status, 'sent'),
      gte(tgOutbox.sentAt, since),
      peerId !== undefined ? eq(tgOutbox.peerId, peerId) : undefined,
    ].filter(Boolean);
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(tgOutbox)
      .where(and(...where));
    return Number(row?.n ?? 0);
  };

  const [sentLastMinute, sentLastDay, sentToChatLastMinute, inbound] = await Promise.all([
    counted(minuteAgo(now)),
    counted(dayAgo(now)),
    input.peerId === null ? Promise.resolve(0) : counted(minuteAgo(now), input.peerId),
    db
      .select({ id: tgMessages.id })
      .from(tgMessages)
      .where(
        and(
          eq(tgMessages.clientId, input.clientId),
          eq(tgMessages.managerUserId, input.managerUserId),
          eq(tgMessages.direction, 'in'),
        ),
      )
      .limit(1),
  ]);

  return {
    sentLastMinute,
    sentLastDay,
    sentToChatLastMinute,
    // The never-initiate rule, answered from the record rather than from a
    // flag somebody could set: they must have written to US, on THIS account.
    clientHasWrittenFirst: inbound.length > 0,
    sendingEnabled: enabled === true,
    // Held on the account row by the listener when Telegram tells it to wait.
    floodWaitUntil: null,
    bridgeLive: account !== null && bridgeState(account, now) === 'live',
  };
}

export interface QueuedReply {
  id: string;
  clientId: string;
  body: string;
  status: string;
  queuedAt: Date;
  sentAt: Date | null;
  lastError: string | null;
  manager: string;
}

/**
 * Put a reply in the queue.
 *
 * Every refusal is re-checked here even though the screen checked first: a
 * screen is a view and an action is a door. `never_wrote_first` in particular
 * must be impossible to get around by posting a form.
 */
export async function queueReply(
  input: { clientId: string; managerUserId: string; body: string },
  ctx: AuditContext,
): Promise<{ id: string }> {
  const body = input.body.trim();
  if (bodyTooLong(body)) throw new OutboxError('too_long');

  const peerId = await peerForClient(input.clientId, input.managerUserId);
  if (peerId === null) throw new OutboxError('never_wrote_first');

  const sendCtx = await sendContextFor({
    clientId: input.clientId,
    managerUserId: input.managerUserId,
    peerId,
  });
  const verdict = canQueue(body, sendCtx);
  if (!verdict.ok) throw new OutboxError(verdict.reason);

  const [row] = await db
    .insert(tgOutbox)
    .values({
      clientId: input.clientId,
      managerUserId: input.managerUserId,
      peerId,
      body,
      status: 'queued',
      queuedBy: ctx.actorId!,
    })
    .returning({ id: tgOutbox.id });

  await writeAudit(db, ctx, {
    entityType: 'tg_outbox',
    entityId: row!.id,
    action: 'create',
    // The text is in the row and in the conversation; the audit entry records
    // the decision, not a second copy of what was said.
    after: { clientId: input.clientId, managerUserId: input.managerUserId, chars: body.length },
  });
  return { id: row!.id };
}

/**
 * What the thread must show below the real messages.
 *
 * Only rows that have NOT been sent. A sent one arrives back through the
 * listener as an ordinary outgoing message and belongs in the conversation
 * itself; showing it from here too would double it.
 */
export async function pendingFor(clientId: string): Promise<QueuedReply[]> {
  const rows = await db
    .select({
      id: tgOutbox.id,
      clientId: tgOutbox.clientId,
      body: tgOutbox.body,
      status: tgOutbox.status,
      queuedAt: tgOutbox.queuedAt,
      sentAt: tgOutbox.sentAt,
      lastError: tgOutbox.lastError,
      manager: users.fullName,
    })
    .from(tgOutbox)
    .innerJoin(users, eq(tgOutbox.managerUserId, users.id))
    // 'sending' too: a message in flight is not yet a message, and the thread
    // must not show it as one.
    .where(
      and(
        eq(tgOutbox.clientId, clientId),
        sql`${tgOutbox.status} IN ('queued', 'sending', 'failed')`,
      ),
    )
    .orderBy(asc(tgOutbox.queuedAt));
  return rows;
}

/** Change your mind, while it is still only a row. */
export async function cancelQueued(id: string, ctx: AuditContext): Promise<void> {
  const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
  if (!row) throw new OutboxError('not_found');
  // Not 'sent': that one is on somebody's phone and cannot be recalled from
  // here. Saying otherwise on a screen would be a lie about the world.
  if (row.status === 'sent') throw new OutboxError('already_sent');
  // 'sending' is out of reach too: it is with Telegram right now, and
  // cancelling it here would only make the record disagree with the world.
  if (row.status === 'sending') throw new OutboxError('already_sent');
  await db.update(tgOutbox).set({ status: 'cancelled' }).where(eq(tgOutbox.id, id));
  await writeAudit(db, ctx, {
    entityType: 'tg_outbox',
    entityId: id,
    action: 'void',
    before: { status: row.status },
    after: { status: 'cancelled' },
  });
}

/* ------------------------------------------------------------------ *
 * The listener's half. Called only from `scripts/tg-listen.ts`.
 * ------------------------------------------------------------------ */

export interface OutboxJob {
  id: string;
  clientId: string;
  peerId: bigint;
  body: string;
  attempts: number;
}

/**
 * Take the oldest queued reply for this account, atomically.
 *
 * One UPDATE, not a SELECT followed by a write: a read-then-write claim is two
 * statements with a gap, and a gap is where the same message goes out twice.
 * `FOR UPDATE SKIP LOCKED` inside the subquery does the real work — on its own
 * in a `SELECT` it would be pointless here, because postgres.js runs a lone
 * statement in its own transaction and the lock would be released the instant
 * the row came back.
 *
 * Exactly one listener may run per account (the advisory lock), so this is
 * belt and braces — but the belt is held by a different process, and a queue
 * that depends on a promise made elsewhere fails on the day that promise does.
 */
export async function claimNext(managerUserId: string): Promise<OutboxJob | null> {
  const rows = await db.execute<{
    id: string;
    client_id: string;
    peer_id: string;
    body: string;
    attempts: number;
  }>(sql`
    UPDATE tg_outbox SET status = 'sending', attempts = attempts + 1
    WHERE id = (
      SELECT id FROM tg_outbox
      WHERE manager_user_id = ${managerUserId} AND status = 'queued'
      ORDER BY queued_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, client_id, peer_id, body, attempts
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    // Through a string: postgres returns bigint as text, and Number() on a
    // Telegram id is a silent wrong recipient.
    peerId: BigInt(row.peer_id),
    body: row.body,
    attempts: row.attempts,
  };
}

/**
 * A message was in flight when the listener died.
 *
 * Nobody can tell from here whether Telegram received it, so neither guess is
 * safe to make silently: re-queueing may send it twice, dropping it loses a
 * reply a client is waiting for. It is marked FAILED with the reason spelled
 * out, which puts it in front of the manager on the thread — the one person
 * who can open their own Telegram and look.
 */
export async function recoverInFlight(managerUserId: string): Promise<number> {
  const rows = await db
    .update(tgOutbox)
    .set({
      status: 'failed',
      lastError: 'listener restarted while sending — check Telegram, then send again if needed',
    })
    .where(and(eq(tgOutbox.managerUserId, managerUserId), eq(tgOutbox.status, 'sending')))
    .returning({ id: tgOutbox.id });
  return rows.length;
}

/** Put a claimed job back when a rate limit says "not yet" — not a failure. */
export async function releaseClaim(id: string): Promise<void> {
  // `attempts` is deliberately NOT decremented: it counts trips through the
  // sender, and a row that keeps bouncing off a limit is worth noticing.
  await db.update(tgOutbox).set({ status: 'queued' }).where(eq(tgOutbox.id, id));
}

export async function markSent(id: string, tgMessageId: bigint | null): Promise<void> {
  await db
    .update(tgOutbox)
    .set({ status: 'sent', sentAt: new Date(), tgMessageId, lastError: null })
    .where(eq(tgOutbox.id, id));
}

/**
 * A send that did not work.
 *
 * `permanent` decides whether it goes back in the queue or stops. Retrying a
 * refusal the other person made — they blocked us, their privacy settings
 * forbid it — is the abuse pattern itself, not a way around it.
 */
export async function markAttemptFailed(
  id: string,
  error: string,
  permanent: boolean,
  maxAttempts: number,
): Promise<void> {
  const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
  if (!row) return;
  const attempts = row.attempts + 1;
  await db
    .update(tgOutbox)
    .set({
      attempts,
      lastError: error.slice(0, 500),
      status: permanent || attempts >= maxAttempts ? 'failed' : 'queued',
    })
    .where(eq(tgOutbox.id, id));
}

/** Counts for the listener's own limit check, without the settings round trip. */
export async function sentCounts(
  managerUserId: string,
  peerId: bigint,
  now = new Date(),
): Promise<Pick<SendContext, 'sentLastMinute' | 'sentLastDay' | 'sentToChatLastMinute'>> {
  const count = async (since: Date, chat?: bigint) => {
    const where = [
      eq(tgOutbox.managerUserId, managerUserId),
      eq(tgOutbox.status, 'sent'),
      gte(tgOutbox.sentAt, since),
      chat !== undefined ? eq(tgOutbox.peerId, chat) : undefined,
    ].filter(Boolean);
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(tgOutbox)
      .where(and(...where));
    return Number(row?.n ?? 0);
  };
  const [sentLastMinute, sentLastDay, sentToChatLastMinute] = await Promise.all([
    count(minuteAgo(now)),
    count(dayAgo(now)),
    count(minuteAgo(now), peerId),
  ]);
  return { sentLastMinute, sentLastDay, sentToChatLastMinute };
}

/** Has this client written to this manager? Re-asked at send time. */
export async function clientHasWritten(
  clientId: string,
  managerUserId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: tgMessages.id })
    .from(tgMessages)
    .where(
      and(
        eq(tgMessages.clientId, clientId),
        eq(tgMessages.managerUserId, managerUserId),
        eq(tgMessages.direction, 'in'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export { DEFAULT_LIMITS };
export type { SendVerdict };
