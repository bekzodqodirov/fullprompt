import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, tgAccounts, tgMessages, tgOutbox, users } from '@/modules/platform/db/schema';
import { setSetting } from '@/modules/platform/settings/service';
import {
  cancelQueued,
  claimNext,
  clientHasWritten,
  markAttemptFailed,
  markSent,
  OutboxError,
  peerForClient,
  pendingFor,
  queueReply,
  recoverInFlight,
  releaseClaim,
  replyAccountFor,
  sendContextFor,
} from '@/modules/wms/crm/outbox';
import { MAX_ATTEMPTS } from '@/modules/wms/crm/telegram-send';

/**
 * The reply queue against a real database — phase 4.
 *
 * The rules themselves are pure and proved in `telegram-send.test.ts`. What
 * only this file can show is that they are actually WIRED: that a client who
 * never wrote cannot be messaged however the row is created, that claiming a
 * job is atomic, and that a message in flight when the process died is not
 * silently sent twice or silently lost.
 */

const STAMP = Date.now();
const PEER = BigInt(STAMP);

let managerId: string;
let otherId: string;
let clientId: string;
let accountId: string;

const ctx = () => ({ actorId: managerId, ip: null, userAgent: null });

beforeAll(async () => {
  const staff = await db.select().from(users).limit(2);
  managerId = staff[0]!.id;
  otherId = (staff[1] ?? staff[0])!.id;

  const [row] = await db
    .insert(clients)
    .values({ clientCode: `OB${STAMP}`.slice(0, 12), name: `Outbox ${STAMP}`, phones: ['+998907771122'] })
    .returning({ id: clients.id });
  clientId = row!.id;

  // A live bridge: sending is refused outright without one, so every other
  // assertion here would be the same refusal.
  const [acc] = await db
    .insert(tgAccounts)
    .values({
      managerUserId: managerId,
      tgPhone: `+99890${String(STAMP).slice(-7)}`,
      sessionEnc: 'v1.x.y.z',
      status: 'active',
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tgAccounts.managerUserId,
      set: { status: 'active', lastSeenAt: new Date() },
    })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  await setSetting('tg_sending_enabled', true, managerId);
});

afterAll(async () => {
  await setSetting('tg_sending_enabled', false, managerId);
  await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
  await db.delete(tgMessages).where(eq(tgMessages.clientId, clientId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

const inbound = async (n = 1) =>
  db.insert(tgMessages).values({
    clientId,
    managerUserId: managerId,
    peerId: PEER,
    tgMessageId: BigInt(STAMP + n),
    direction: 'in',
    body: 'Yuk qayerda?',
    sentAt: new Date(),
  });

describe('before the client has written to us', () => {
  it('has no chat to reply in', async () => {
    expect(await peerForClient(clientId, managerId)).toBeNull();
    expect(await replyAccountFor(clientId, managerId)).toBeNull();
    expect(await clientHasWritten(clientId, managerId)).toBe(false);
  });

  it('refuses to queue anything at all', async () => {
    // The rule that protects the account. It must not be reachable by posting
    // a form, which is why the action calls this and not the screen's opinion.
    await expect(
      queueReply({ clientId, managerUserId: managerId, body: 'Salom' }, ctx()),
    ).rejects.toBeInstanceOf(OutboxError);
  });
});

describe('once the client has written', () => {
  beforeAll(async () => {
    await inbound(1);
  });

  it('finds the chat from the conversation, not from a phone number', async () => {
    expect(await peerForClient(clientId, managerId)).toBe(PEER);
    const account = await replyAccountFor(clientId, managerId);
    expect(account).toEqual({ managerUserId: managerId, peerId: PEER });
  });

  it('will not let anybody reply through somebody else’s account', async () => {
    // The message would arrive under that manager's own name and photograph.
    // This is not a permission question — it is impersonation.
    if (otherId !== managerId) {
      expect(await replyAccountFor(clientId, otherId)).toBeNull();
    }
  });

  it('queues a reply and shows it as NOT sent', async () => {
    const { id } = await queueReply(
      { clientId, managerUserId: managerId, body: 'Ertaga jo‘naydi' },
      ctx(),
    );
    const shown = await pendingFor(clientId);
    expect(shown.map((r) => r.id)).toContain(id);
    expect(shown.find((r) => r.id === id)?.status).toBe('queued');
  });

  it('refuses while the company switch is off', async () => {
    await setSetting('tg_sending_enabled', false, managerId);
    await expect(
      queueReply({ clientId, managerUserId: managerId, body: 'x' }, ctx()),
    ).rejects.toThrow('sending_disabled');
    await setSetting('tg_sending_enabled', true, managerId);
  });

  it('refuses when the bridge is not live', async () => {
    // A queued row would be valid and would go out eventually — but eventually
    // may be tomorrow, and the manager would believe the client had it.
    await db.update(tgAccounts).set({ lastSeenAt: null }).where(eq(tgAccounts.id, accountId));
    await expect(
      queueReply({ clientId, managerUserId: managerId, body: 'x' }, ctx()),
    ).rejects.toThrow('bridge_down');
    await db.update(tgAccounts).set({ lastSeenAt: new Date() }).where(eq(tgAccounts.id, accountId));
  });

  it('reports a live bridge and a client who wrote first', async () => {
    const sendCtx = await sendContextFor({ clientId, managerUserId: managerId, peerId: PEER });
    expect(sendCtx.clientHasWrittenFirst).toBe(true);
    expect(sendCtx.bridgeLive).toBe(true);
    expect(sendCtx.sendingEnabled).toBe(true);
  });
});

describe('the listener taking a job', () => {
  it('claims one atomically and never hands the same row out twice', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    await queueReply({ clientId, managerUserId: managerId, body: 'birinchi' }, ctx());

    const first = await claimNext(managerId);
    expect(first?.body).toBe('birinchi');
    expect(first?.peerId).toBe(PEER);
    // The claim FLIPS the status in the same statement, so a second sender
    // finds nothing rather than the same message.
    expect(await claimNext(managerId)).toBeNull();
    expect(first?.attempts).toBe(1);
  });

  it('returns the peer id intact — a Telegram id is bigger than a JS number', async () => {
    const claimed = await db.select().from(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    expect(claimed[0]!.peerId).toBe(PEER);
  });

  it('puts a job back when a rate limit says “not yet”', async () => {
    const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    await releaseClaim(row!.id);
    const again = await claimNext(managerId);
    expect(again?.id).toBe(row!.id);
    // Attempts still counts up: a row bouncing off a limit for ever is worth
    // being able to see.
    expect(again?.attempts).toBe(2);
  });

  it('marks a sent message with Telegram’s own id', async () => {
    const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    await markSent(row!.id, 987654321n);
    const [after] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, row!.id));
    expect(after!.status).toBe('sent');
    expect(after!.tgMessageId).toBe(987654321n);
    // A sent message belongs in the conversation, which the listener writes
    // when the copy echoes back. Showing it from the queue too would double it.
    expect(await pendingFor(clientId)).toHaveLength(0);
  });
});

describe('when sending goes wrong', () => {
  it('stops for good on a refusal the other person made', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const { id } = await queueReply({ clientId, managerUserId: managerId, body: 'x' }, ctx());
    await markAttemptFailed(id, 'USER_IS_BLOCKED', true, MAX_ATTEMPTS);
    const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
    // Retrying a block IS the abuse pattern, not a way around it.
    expect(row!.status).toBe('failed');
  });

  it('retries a network failure, but not for ever', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const { id } = await queueReply({ clientId, managerUserId: managerId, body: 'y' }, ctx());
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      await markAttemptFailed(id, 'socket hang up', false, MAX_ATTEMPTS);
      const [mid] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
      expect(mid!.status).toBe('queued');
    }
    await markAttemptFailed(id, 'socket hang up', false, MAX_ATTEMPTS);
    const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
    expect(row!.status).toBe('failed');
    // And the failure is on the thread, where a person will see it.
    expect((await pendingFor(clientId)).find((r) => r.id === id)?.status).toBe('failed');
  });

  it('never guesses about a message that was in flight when the process died', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const { id } = await queueReply({ clientId, managerUserId: managerId, body: 'z' }, ctx());
    await claimNext(managerId); // now 'sending'
    const recovered = await recoverInFlight(managerId);
    expect(recovered).toBe(1);
    const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
    // Re-queueing might send it twice; dropping it loses a reply a client is
    // waiting for. Neither is safe to do silently, so a person is told.
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toContain('listener restarted');
  });
});

describe('changing your mind', () => {
  it('withdraws a message that has not gone', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const { id } = await queueReply({ clientId, managerUserId: managerId, body: 'bekor' }, ctx());
    await cancelQueued(id, ctx());
    expect(await pendingFor(clientId)).toHaveLength(0);
  });

  it('cannot recall one that is already on somebody’s phone', async () => {
    const { id } = await queueReply({ clientId, managerUserId: managerId, body: 'ketdi' }, ctx());
    await markSent(id, 1n);
    // Saying otherwise on a screen would be a lie about the world.
    await expect(cancelQueued(id, ctx())).rejects.toThrow('already_sent');
  });

  it('cannot recall one that is with Telegram right now', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    await queueReply({ clientId, managerUserId: managerId, body: 'uchmoqda' }, ctx());
    const job = await claimNext(managerId);
    await expect(cancelQueued(job!.id, ctx())).rejects.toThrow('already_sent');
  });
});
