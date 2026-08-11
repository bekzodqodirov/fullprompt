import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  clients,
  notifications,
  tgAccounts,
  tgMessages,
  tgOutbox,
  users,
} from '@/modules/platform/db/schema';
import { storeIncoming } from '@/modules/wms/crm/telegram-accounts';
import { setSetting } from '@/modules/platform/settings/service';
import { attachQuotes, conversationFor } from '@/modules/wms/crm/conversations';
import { claimNext, queueReply, OutboxError } from '@/modules/wms/crm/outbox';
import { ShareError, shareMessage, shareTargets } from '@/modules/wms/crm/share';

/**
 * The owner's Telegram-parity items, 2026-08-11: a reply that says what it
 * answers, a file in either direction, and one message shown to a colleague.
 *
 * What is provable without a Telegram connection is the wiring on both sides
 * of it — that the queue row carries the reply target, that the thread
 * resolves a quote, and that the share door refuses what it must. The gramjs
 * call itself is watched in the listener's log the first time it runs.
 */

const SUFFIX = String(Date.now()).slice(-7);
let seq = 0;
const nextPeer = () => BigInt(Date.now()) * 1000n + BigInt((seq += 1));

let actorId: string;
let colleagueId: string;
let clientId: string;
let peerId: bigint;
let accountId: string;
const madeClients: string[] = [];
const madeUsers: string[] = [];
const madeFiles: string[] = [];

const ctx = () => ({ actorId });
const actorOf = (id: string) => ({
  id,
  roles: [] as string[],
  permissions: new Set<string>(['crm.leads']),
});

beforeAll(async () => {
  const staff = await db.select().from(users).limit(1);
  actorId = staff[0]!.id;
  const [mate] = await db
    .insert(users)
    .values({
      phone: `+99894${SUFFIX}`,
      fullName: `Hamkasb ${SUFFIX}`,
      passwordHash: 'x',
      active: true,
    })
    .returning();
  colleagueId = mate!.id;
  madeUsers.push(mate!.id);

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `SH${SUFFIX}`, name: `Ulashish ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  madeClients.push(client!.id);
  peerId = nextPeer();

  // A queue that CAN send needs both halves of the bridge: the company
  // switch, and a heartbeat recent enough that `bridgeState` calls the
  // listener alive. Neither is about this round — they are the door every
  // reply already goes through, and a test about what the queue CARRIES has
  // to get past it. Both are put back in afterAll: a live bridge is
  // CONFIGURATION for every spec that runs after this one (#183).
  const [account] = await db
    .insert(tgAccounts)
    .values({
      managerUserId: actorId,
      tgPhone: `+99890${SUFFIX}`,
      sessionEnc: 'v1.x.y.z',
      status: 'active',
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tgAccounts.managerUserId,
      set: { status: 'active', lastSeenAt: new Date() },
    })
    .returning({ id: tgAccounts.id, lastSeenAt: tgAccounts.lastSeenAt });
  accountId = account!.id;
  await setSetting('tg_sending_enabled', true, actorId);
});

afterAll(async () => {
  await setSetting('tg_sending_enabled', false, actorId);
  // Not a delete: the account may have existed before this file ran (the
  // upsert above says so). Ageing the heartbeat is what puts the bridge back
  // to «not answering», which is what it was.
  if (accountId) {
    await db
      .update(tgAccounts)
      .set({ lastSeenAt: new Date(Date.now() - 86_400_000) })
      .where(eq(tgAccounts.id, accountId));
  }
  if (madeClients.length > 0) {
    await db.delete(tgOutbox).where(inArray(tgOutbox.clientId, madeClients));
    await db.delete(tgMessages).where(inArray(tgMessages.clientId, madeClients));
    // AFTER the queue rows: `tg_outbox.attachment_id` is a real FK, so
    // deleting the file first refuses — which is the same protection that
    // makes `deleteAttachment` answer «in_use» on a queued photo (round 14).
    if (madeFiles.length > 0) {
      await db.delete(attachments).where(inArray(attachments.id, madeFiles));
    }
    await db.delete(clients).where(inArray(clients.id, madeClients));
  }
  if (madeUsers.length > 0) {
    // Notifications first: they point at the user this file minted, and a
    // colleague left behind is a name in every share picker afterwards.
    await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
    await db.delete(users).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

async function incoming(tgId: bigint, body: string | null, over: Record<string, unknown> = {}) {
  const id = await storeIncoming({
    clientId,
    managerUserId: actorId,
    row: {
      peerId,
      tgMessageId: tgId,
      direction: 'in',
      body,
      hasMedia: false,
      sentAt: new Date(),
      replyToTgMessageId: null,
      fwdFrom: null,
      ...over,
    },
  });
  return id!;
}

describe('a reply names the message it answers', () => {
  it('carries the target onto the queue row and out to the sender', async () => {
    await incoming(4001n, 'Narxi qancha?');
    const { id } = await queueReply(
      {
        clientId,
        managerUserId: actorId,
        body: '30$ kubi',
        replyToTgMessageId: 4001n,
      },
      ctx(),
    );
    const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
    expect(row!.replyToTgMessageId).toBe(4001n);

    // The listener reads it off the CLAIM, not off a second query — a value
    // the claim does not return is a value the sender cannot use.
    const job = await claimNext(actorId);
    expect(job?.id).toBe(id);
    expect(job?.replyToTgMessageId).toBe(4001n);
  });

  it('resolves the quote over the page, and survives an unresolvable one', async () => {
    const answered = await incoming(4010n, 'Yuk qachon keladi?');
    await incoming(4011n, 'Ertaga', { replyToTgMessageId: 4010n });
    // A reply to something older than anything imported here — the ordinary
    // case for a chat that started before the import window.
    await incoming(4012n, 'Rahmat', { replyToTgMessageId: 3n });
    expect(answered).toBeTruthy();

    const thread = await conversationFor(clientId, { id: actorId }, 50);
    const quoting = thread.find((m) => m.body === 'Ertaga')!;
    expect(quoting.quoted?.body).toBe('Yuk qachon keladi?');
    const orphan = thread.find((m) => m.body === 'Rahmat')!;
    // Not null: «this is an answer to something» is still the fact the reader
    // needs, and the strip draws empty rather than vanishing.
    expect(orphan.quoted).not.toBeNull();
    expect(orphan.quoted?.body).toBeNull();
  });

  it('asks nothing when no message on the page is a reply', async () => {
    const rows = await attachQuotes([
      { managerUserId: actorId, peerId, replyToTgMessageId: null },
    ]);
    expect(rows[0]!.quoted).toBeNull();
  });
});

describe('a file may ride out, and the ceiling is per kind', () => {
  async function upload(kind: 'photo' | 'file', sizeBytes: number) {
    const [row] = await db
      .insert(attachments)
      .values({
        entityType: 'tg_outbox',
        entityId: crypto.randomUUID(),
        kind,
        storageKey: `tg_outbox/test/${SUFFIX}-${(seq += 1)}`,
        fileName: kind === 'photo' ? 'rasm.jpg' : 'invoys.pdf',
        contentType: kind === 'photo' ? 'image/jpeg' : 'application/pdf',
        sizeBytes,
        uploadedBy: actorId,
      })
      .returning();
    madeFiles.push(row!.id);
    return row!.id;
  }

  it('accepts a DOCUMENT, which the kind check used to refuse outright', async () => {
    await incoming(4020n, 'Hujjat yuboring');
    const file = await upload('file', 500_000);
    const { id } = await queueReply(
      { clientId, managerUserId: actorId, body: '', attachmentId: file },
      ctx(),
    );
    const [row] = await db.select().from(tgOutbox).where(eq(tgOutbox.id, id));
    expect(row!.attachmentId).toBe(file);
  });

  it('refuses a photo past the PHOTO cap and a file past the FILE cap', async () => {
    const bigPhoto = await upload('photo', 11 * 1024 * 1024);
    await expect(
      queueReply({ clientId, managerUserId: actorId, body: '', attachmentId: bigPhoto }, ctx()),
    ).rejects.toThrowError(OutboxError);
    // …and the same size is fine as a document, which is the point of asking
    // per kind rather than holding everything to the photo's ceiling.
    const okFile = await upload('file', 11 * 1024 * 1024);
    const { id } = await queueReply(
      { clientId, managerUserId: actorId, body: '', attachmentId: okFile },
      ctx(),
    );
    expect(id).toBeTruthy();
    const tooBig = await upload('file', 21 * 1024 * 1024);
    await expect(
      queueReply({ clientId, managerUserId: actorId, body: '', attachmentId: tooBig }, ctx()),
    ).rejects.toThrowError(OutboxError);
  });
});

describe('one message, handed to one colleague', () => {
  it('sends it, and writes down who was shown what', async () => {
    const messageId = await incoming(4030n, 'Yukni qachon olsam bo‘ladi?');
    await shareMessage(
      { messageId, toUserId: colleagueId, note: 'Buni ko‘rib chiq' },
      actorOf(actorId),
      ctx(),
    );
    const sent = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, colleagueId));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('ChatMessageShared');
    expect(JSON.stringify(sent[0]!.payload)).toContain('Yukni qachon');

    const trail = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, messageId));
    expect(trail.some((row) => row.action === 'share')).toBe(true);
  });

  it('refuses a message this viewer cannot read', async () => {
    const messageId = await incoming(4031n, 'Maxfiy');
    // A colleague with no supervision view posting the uuid by hand: the
    // button was never drawn for them, and the door has to say so anyway.
    await expect(
      shareMessage({ messageId, toUserId: actorId }, actorOf(colleagueId), ctx()),
    ).rejects.toThrowError(ShareError);
  });

  it('refuses a retired colleague and refuses yourself', async () => {
    const messageId = await incoming(4032n, 'Salom');
    await expect(
      shareMessage({ messageId, toUserId: actorId }, actorOf(actorId), ctx()),
    ).rejects.toThrowError(ShareError);
    await db.update(users).set({ active: false }).where(eq(users.id, colleagueId));
    await expect(
      shareMessage({ messageId, toUserId: colleagueId }, actorOf(actorId), ctx()),
    ).rejects.toThrowError(ShareError);
    await db.update(users).set({ active: true }).where(eq(users.id, colleagueId));
  });

  it('never offers you yourself', async () => {
    const people = await shareTargets(actorId);
    expect(people.some((p) => p.id === actorId)).toBe(false);
    expect(people.some((p) => p.id === colleagueId)).toBe(true);
  });
});
