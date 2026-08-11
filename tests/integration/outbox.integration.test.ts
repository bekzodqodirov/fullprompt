import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  tgAccounts,
  tgMessages,
  tgOutbox,
  users,
} from '@/modules/platform/db/schema';
import { setSetting } from '@/modules/platform/settings/service';
import { deleteAttachment, saveAttachment } from '@/modules/platform/files/service';
import { disconnectAccount, listListenablePhones } from '@/modules/wms/crm/telegram-accounts';
import {
  cancelQueued,
  claimNext,
  clientHasWritten,
  loadOutboxFile,
  markAttemptFailed,
  markSent,
  OutboxError,
  peerForClient,
  pendingFor,
  queueReply,
  dismissFailed,
  recordSent,
  recoverInFlight,
  releaseClaim,
  replyAccountFor,
  sendContextFor,
  wasSentWithPhoto,
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

const madePhotos: string[] = [];

afterAll(async () => {
  await setSetting('tg_sending_enabled', false, managerId);
  await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
  if (madePhotos.length) await db.delete(attachments).where(inArray(attachments.id, madePhotos));
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
    const shown = await pendingFor(clientId, { id: managerId });
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
    expect(await pendingFor(clientId, { id: managerId })).toHaveLength(0);
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
    expect((await pendingFor(clientId, { id: managerId })).find((r) => r.id === id)?.status).toBe('failed');
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

describe('a photo rides along (item 15, the sending half)', () => {
  /** A pre-bound upload row, exactly as /api/files/upload writes it. */
  const photoRow = async (over: Partial<typeof attachments.$inferInsert> = {}) => {
    const [row] = await db
      .insert(attachments)
      .values({
        entityType: 'tg_outbox',
        entityId: uuidv4(),
        kind: 'photo',
        storageKey: `tg_outbox/test/${uuidv4()}`,
        fileName: 'p.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        uploadedBy: managerId,
        ...over,
      })
      .returning();
    madePhotos.push(row!.id);
    return row!;
  };

  it('queues a photo with no caption at all — the relaxed CHECK allows it', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const file = await photoRow();
    // Fails on the 0037 schema twice over: the body CHECK refuses '' and the
    // column does not exist — this insert IS the proof of migration 0043.
    const { id } = await queueReply(
      { clientId, managerUserId: managerId, body: '', attachmentId: file.id },
      ctx(),
    );
    const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
    expect(row!.attachmentId).toBe(file.id);
    // The minted group id gave way to the queue row itself (pre-binding).
    const [claimed] = await db.select().from(attachments).where(eq(attachments.id, file.id));
    expect(claimed!.entityId).toBe(id);
    // …and the thread can show what is about to go out.
    expect((await pendingFor(clientId, { id: managerId })).find((r) => r.id === id)?.attachmentId).toBe(file.id);
  });

  it('refuses a stranger’s upload and an oversized photo', async () => {
    const foreign = await photoRow({ uploadedBy: otherId });
    await expect(
      queueReply(
        { clientId, managerUserId: managerId, body: 'x', attachmentId: foreign.id },
        ctx(),
      ),
    ).rejects.toThrow('bad_attachment');
    const fat = await photoRow({ sizeBytes: 10 * 1024 * 1024 + 1 });
    await expect(
      queueReply({ clientId, managerUserId: managerId, body: 'x', attachmentId: fat.id }, ctx()),
    ).rejects.toThrow('photo_too_big');
  });

  it('takes a DOCUMENT now, which this test used to prove it refused', async () => {
    // Changed on purpose, 2026-08-11: «faqat rasim emas fillar ham jonatish».
    // The old assertion («a non-photo») was right about the code and is the
    // behaviour the owner asked to have removed, so it is rewritten rather
    // than deleted — the file should say a document used to stop here. The
    // ceiling did not go with it: it is asked PER KIND now, and the
    // oversized-photo case above still holds.
    const doc = await photoRow({ kind: 'file' });
    const { id } = await queueReply(
      { clientId, managerUserId: managerId, body: 'x', attachmentId: doc.id },
      ctx(),
    );
    expect(id).toBeTruthy();
  });

  it('refuses a caption past Telegram’s own photo cap instead of truncating', async () => {
    const file = await photoRow();
    await expect(
      queueReply(
        { clientId, managerUserId: managerId, body: 'x'.repeat(1025), attachmentId: file.id },
        ctx(),
      ),
    ).rejects.toThrow('too_long');
    // The same text WITHOUT a photo is an ordinary message and goes through.
    const { id } = await queueReply(
      { clientId, managerUserId: managerId, body: 'x'.repeat(1025) },
      ctx(),
    );
    await cancelQueued(id, ctx());
  });

  it('hands the photo to the claimed job; missing bytes are a permanent fact', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const file = await photoRow(); // a row whose bytes were never stored
    await queueReply(
      { clientId, managerUserId: managerId, body: 'rasm', attachmentId: file.id },
      ctx(),
    );
    const job = await claimNext(managerId);
    expect(job?.attachmentId).toBe(file.id);
    // No bytes → null → the listener marks photo_missing, permanently.
    expect(await loadOutboxFile(file.id)).toBeNull();
  });

  it('returns real bytes for the sender', async () => {
    const { id } = await saveAttachment(
      {
        entityType: 'tg_outbox',
        entityId: uuidv4(),
        fileName: 'real.jpg',
        contentType: 'image/jpeg',
        body: Buffer.from('real-jpeg-bytes'),
        uploadedBy: managerId,
      },
      { thumbnails: 'skip' },
    );
    madePhotos.push(id);
    const photo = await loadOutboxFile(id);
    expect(photo?.bytes.toString()).toBe('real-jpeg-bytes');
    expect(photo?.fileName).toBe('real.jpg');
  });

  it('after the send the echo row owns the photo, and a replay changes nothing', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const file = await photoRow();
    await queueReply(
      { clientId, managerUserId: managerId, body: 'mana rasm', attachmentId: file.id },
      ctx(),
    );
    const job = await claimNext(managerId);
    await markSent(job!.id, 555000111n);
    const echoInput = {
      clientId,
      managerUserId: managerId,
      peerId: PEER,
      tgMessageId: 555000111n,
      body: 'mana rasm',
      attachmentId: file.id,
      sentAt: new Date(),
    };
    await recordSent(echoInput);
    const echoes = await db
      .select()
      .from(tgMessages)
      .where(and(eq(tgMessages.clientId, clientId), eq(tgMessages.tgMessageId, 555000111n)));
    expect(echoes).toHaveLength(1);
    expect(echoes[0]!.direction).toBe('out');
    expect(echoes[0]!.hasMedia).toBe(true);
    const [claimed] = await db.select().from(attachments).where(eq(attachments.id, file.id));
    expect(claimed!.entityType).toBe('tg_message');
    expect(claimed!.entityId).toBe(echoes[0]!.id);
    // The listener can tell this echo's photo is its own upload…
    expect(await wasSentWithPhoto(managerId, PEER, 555000111n)).toBe(true);
    // …and Telegram's own echo arriving later is a no-op replay.
    await recordSent(echoInput);
    expect(
      await db
        .select()
        .from(tgMessages)
        .where(and(eq(tgMessages.clientId, clientId), eq(tgMessages.tgMessageId, 555000111n))),
    ).toHaveLength(1);
  });

  it('cancelling keeps the photo row, but the queue’s photo cannot be deleted from under it', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const file = await photoRow();
    const { id } = await queueReply(
      { clientId, managerUserId: managerId, body: '', attachmentId: file.id },
      ctx(),
    );
    // The FK refuses politely while the queue row points at it.
    await expect(
      deleteAttachment(file.id, { id: managerId, permissions: new Set() }),
    ).rejects.toThrow('in_use');
    await cancelQueued(id, ctx());
    // Cancelled keeps the record — the audit-friendly orphan every
    // pre-binding flow already pays for.
    expect(await db.select().from(attachments).where(eq(attachments.id, file.id))).toHaveLength(1);
  });
});

describe('changing your mind', () => {
  it('withdraws a message that has not gone', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const { id } = await queueReply({ clientId, managerUserId: managerId, body: 'bekor' }, ctx());
    await cancelQueued(id, ctx());
    expect(await pendingFor(clientId, { id: managerId })).toHaveLength(0);
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

/**
 * Round 53, the owner's screenshot: «habar telegramdan ketyabti ammo bizning
 * sistemadagi chatda jonatgan habarlarim korinmayabti — rasim korindi habar
 * korinmadi».
 *
 * The asymmetry IS the bug. The listener wrote the echo row itself for a
 * photo and left a text reply to arrive back through the NewMessage event —
 * which Telegram never sends for a message posted on the same connection. So
 * the words reached the customer and nothing in the CRM ever knew.
 */
describe('a reply that went out is on the thread, photo or not', () => {
  it('records a TEXT send, and a later echo is a no-op replay', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const echo = {
      clientId,
      managerUserId: managerId,
      peerId: PEER,
      tgMessageId: 555000222n,
      body: 'matn javobi',
      sentAt: new Date(),
    };
    await recordSent(echo);

    const rows = await db
      .select()
      .from(tgMessages)
      .where(and(eq(tgMessages.clientId, clientId), eq(tgMessages.tgMessageId, 555000222n)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe('out');
    expect(rows[0]!.body).toBe('matn javobi');
    // No photo was sent, so nothing may claim to have one.
    expect(rows[0]!.hasMedia).toBe(false);

    // The manager's own phone echoing it back later must not double it.
    await recordSent(echo);
    expect(
      await db
        .select()
        .from(tgMessages)
        .where(and(eq(tgMessages.clientId, clientId), eq(tgMessages.tgMessageId, 555000222n))),
    ).toHaveLength(1);

    await db.delete(tgMessages).where(eq(tgMessages.tgMessageId, 555000222n));
  });
});

describe('clearing a failure off the thread', () => {
  it('removes a failed reply, and refuses to touch anything else', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    const { id } = await queueReply({ clientId, managerUserId: managerId, body: 'ketmadi' }, ctx());
    // A queued row is withdrawn, not dismissed — the two are different acts.
    await expect(dismissFailed(id, ctx())).rejects.toThrow('not_failed');

    const job = await claimNext(managerId);
    await markAttemptFailed(job!.id, '401: SESSION_REVOKED', true, MAX_ATTEMPTS);
    expect((await pendingFor(clientId, { id: managerId }))[0]!.status).toBe('failed');

    await dismissFailed(id, ctx());
    expect(await pendingFor(clientId, { id: managerId })).toHaveLength(0);
    await expect(dismissFailed(id, ctx())).rejects.toThrow('not_found');
  });
});

/**
 * «Chiqish» — round 50, the owner: «telegramga ulash bor, endi undan
 * chiqishni qo'sh».
 *
 * Last in the file on purpose: it disconnects the account every other test
 * here depends on, and the cleanup would have to rebuild it anyway.
 */
describe('a manager takes their Telegram back', () => {
  it('destroys the session, stops the queue, and leaves the history alone', async () => {
    await db.delete(tgOutbox).where(eq(tgOutbox.clientId, clientId));
    // A message id of its own: `inbound()` defaults to one this file has
    // already used, and the unique index says so.
    await inbound(50);
    const { id } = await queueReply({ clientId, managerUserId: managerId, body: 'ketmaydi' }, ctx());

    const phonesBefore = await listListenablePhones();
    expect(await disconnectAccount(managerId)).toBe(true);

    const [row] = await db.select().from(tgAccounts).where(eq(tgAccounts.id, accountId));
    // The credential is GONE, not merely disabled — this is the whole point
    // of the button: the server can no longer speak as him.
    expect(row!.sessionEnc).toBeNull();
    expect(row!.status).toBe('signed_out');

    // …and the supervisor will not start it again, which is what makes the
    // press take effect rather than merely being recorded.
    const phonesAfter = await listListenablePhones();
    expect(phonesBefore.length - phonesAfter.length).toBe(1);
    expect(phonesAfter).not.toContain(row!.tgPhone);

    // The reply that can never go now says so, rather than waiting for a
    // reconnection the manager just decided against.
    const [queued] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
    expect(queued!.status).toBe('failed');
    expect(queued!.lastError).toContain('Telegram');

    // The conversations stay. They are the company's record of what was said
    // to a customer, and logging out of a phone does not unsay it.
    const kept = await db.select().from(tgMessages).where(eq(tgMessages.clientId, clientId));
    expect(kept.length).toBeGreaterThan(0);

    // Nothing new may be queued into the void.
    await expect(
      queueReply({ clientId, managerUserId: managerId, body: 'yana' }, ctx()),
    ).rejects.toThrow('bridge_down');
  });

  it('says so honestly when there is nothing connected', async () => {
    expect(await disconnectAccount(otherId)).toBe(false);
  });
});

