import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, clients, tgAccounts, tgMessages, users } from '@/modules/platform/db/schema';
import {
  accountStatuses,
  clientBook,
  heartbeat,
  loadAccount,
  markAccount,
  saveAccount,
  resumePoints,
  applyEdit,
  storeIncoming,
  takeListenerLock,
} from '@/modules/wms/crm/telegram-accounts';
import { decideIncoming } from '@/modules/wms/crm/telegram-live';
import { attachMedia } from '@/modules/wms/crm/conversations';

/**
 * The live bridge against a real database.
 *
 * What can only be proved here: that a session survives a round trip through
 * the column, that two listeners cannot both take the same account, and that a
 * reconnect replaying yesterday's messages writes nothing twice.
 *
 * `TG_SESSION_KEY` is set by this file rather than expected in the
 * environment — the tests are about the storage, not about the deployment, and
 * a suite that only passes on a configured server is a suite nobody runs.
 */

const KEY = randomBytes(32).toString('base64');
// Every fixture is stamped, because specs share one database and a run must
// not depend on being the first (#298).
const STAMP = Date.now();
const PEER = BigInt(STAMP);

let managerId: string;
let clientId: string;
let accountId: string;
const mediaAttachments: string[] = [];

beforeAll(async () => {
  process.env.TG_SESSION_KEY = KEY;
  const [staff] = await db.select().from(users).limit(1);
  managerId = staff!.id;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `TL${STAMP}`.slice(0, 12), name: `Live ${STAMP}`, phones: ['+998901112233'] })
    .returning({ id: clients.id });
  clientId = row!.id;
});

afterAll(async () => {
  // Attachments first: a tg_message row is what an attachment points AT, and
  // the media test writes one.
  for (const id of mediaAttachments) {
    await db.delete(attachments).where(eq(attachments.id, id));
  }
  await db.delete(tgMessages).where(eq(tgMessages.clientId, clientId));
  await db.delete(tgAccounts).where(eq(tgAccounts.managerUserId, managerId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

const SESSION = `1BQANOTEuMTA4${STAMP}fake-session`;
const TG_PHONE = `+99890${String(STAMP).slice(-7)}`;

describe('storing a manager login', () => {
  it('round-trips the session and never writes it in the clear', async () => {
    await saveAccount({ managerUserId: managerId, tgPhone: TG_PHONE, session: SESSION });
    const [stored] = await db
      .select({ id: tgAccounts.id, enc: tgAccounts.sessionEnc })
      .from(tgAccounts)
      .where(eq(tgAccounts.managerUserId, managerId));
    accountId = stored!.id;
    // The column must not contain the credential — this is the whole promise.
    expect(stored!.enc).not.toContain(SESSION);
    const loaded = await loadAccount(TG_PHONE);
    expect(loaded?.session).toBe(SESSION);
    expect(loaded?.managerUserId).toBe(managerId);
  });

  it('replaces rather than accumulates when a manager logs in again', async () => {
    // Two rows would mean two listeners could each pick one up and open two
    // connections on one personal account.
    await saveAccount({ managerUserId: managerId, tgPhone: TG_PHONE, session: `${SESSION}-2` });
    const rows = await db.select().from(tgAccounts).where(eq(tgAccounts.managerUserId, managerId));
    expect(rows).toHaveLength(1);
    expect((await loadAccount(TG_PHONE))?.session).toBe(`${SESSION}-2`);
  });

  it('has nothing for a phone that never logged in', async () => {
    expect(await loadAccount('+99899000000000')).toBeNull();
  });
});

describe('the listener lock', () => {
  it('is taken once and refused to the second process', async () => {
    const first = await takeListenerLock(accountId);
    expect(first).not.toBeNull();
    // The failure this prevents is not a race in the code — it is a person
    // starting a second copy on another machine and Telegram limiting the
    // account for it.
    expect(await takeListenerLock(accountId)).toBeNull();
    await first!();
  });

  it('is available again once released', async () => {
    const again = await takeListenerLock(accountId);
    expect(again).not.toBeNull();
    await again!();
  });
});

describe('what the bridge writes', () => {
  const peer = {
    id: PEER,
    phone: '+998901112233',
    isPrivate: true,
    isBot: false,
  };
  const msg = { id: 5001, message: 'Yuk qachon jo‘naydi?', date: 1784000000, out: false };

  it('stores a client message once, however many times it is replayed', async () => {
    const book = await clientBook();
    const verdict = decideIncoming(peer, msg, book);
    expect(verdict.store).toBe(true);
    if (!verdict.store) throw new Error('unreachable');
    expect(verdict.clientId).toBe(clientId);

    // A NEW row answers with its id — the key a downloaded photo binds to.
    expect(
      await storeIncoming({ clientId: verdict.clientId, managerUserId: managerId, row: verdict.row }),
    ).toMatch(/^[0-9a-f-]{36}$/);
    // Telegram replays recent history on reconnect. The unique index is what
    // makes that free, which is why the listener keeps no position of its own
    // — and the null is what stops a replay re-downloading the photo.
    expect(
      await storeIncoming({ clientId: verdict.clientId, managerUserId: managerId, row: verdict.row }),
    ).toBeNull();

    const rows = await db.select().from(tgMessages).where(eq(tgMessages.clientId, clientId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('Yuk qachon jo‘naydi?');
  });

  it('writes nothing at all for a number that is not in the client book', async () => {
    const before = await db.select().from(tgMessages).where(eq(tgMessages.clientId, clientId));
    const verdict = decideIncoming({ ...peer, phone: '+998995554433' }, msg, await clientBook());
    // Round 79: on a PERSONAL account (the default, and what every connected
    // account is today) a stranger is a question on the tray, not a refusal —
    // but still not one word is stored until somebody answers it.
    expect(verdict).toMatchObject({ store: false, ask: true, phone: '+998995554433' });
    expect(verdict).not.toHaveProperty('row');
    // The promise made to twelve people about their private conversations,
    // asserted against the table rather than against the verdict.
    const after = await db.select().from(tgMessages).where(eq(tgMessages.clientId, clientId));
    expect(after).toHaveLength(before.length);
  });

  it('follows a sender’s EDIT on a stored row, and never creates one (round 22)', async () => {
    // The message stored above, edited by its sender: the record must say
    // what it says NOW — a corrected price acted on from the old text is a
    // real mistake with real money in it.
    expect(
      await applyEdit({
        managerUserId: managerId,
        peerId: PEER,
        tgMessageId: 5001n,
        body: 'Yuk ERTAGA jo‘naydi',
      }),
    ).toBe(true);
    const [row] = await db.select().from(tgMessages).where(eq(tgMessages.clientId, clientId));
    expect(row!.body).toBe('Yuk ERTAGA jo‘naydi');

    // An edit in a chat we never kept touches nothing — UPDATE-only is the
    // privacy half, and "no new rows" is the whole proof.
    const before = await db.select().from(tgMessages);
    expect(
      await applyEdit({
        managerUserId: managerId,
        peerId: PEER + 999n,
        tgMessageId: 1n,
        body: 'begona chat',
      }),
    ).toBe(false);
    expect((await db.select().from(tgMessages)).length).toBe(before.length);
  });
});

describe('what the status screen is told', () => {
  it('reports live after a heartbeat, and never before one', async () => {
    await db.update(tgAccounts).set({ lastSeenAt: null, status: 'active' }).where(eq(tgAccounts.id, accountId));
    const before = (await accountStatuses()).find((a) => a.id === accountId);
    expect(before?.state).toBe('never');
    expect(before?.keyOpens).toBe(true);

    await heartbeat(accountId);
    const after = (await accountStatuses()).find((a) => a.id === accountId);
    expect(after?.state).toBe('live');
    expect(after?.tgPhone).toBe(TG_PHONE);
  });

  it('says signed_out over the clock, so nobody restarts a process that cannot start', async () => {
    await markAccount(accountId, 'signed_out', 'AUTH_KEY_UNREGISTERED');
    const status = (await accountStatuses()).find((a) => a.id === accountId);
    expect(status?.state).toBe('signed_out');
    expect(status?.lastError).toBe('AUTH_KEY_UNREGISTERED');
  });

  it('tells a rotated key apart from a dead session', async () => {
    // Both read as "not connected" and have completely different answers: fix
    // the .env, or ask the manager to log in again.
    const good = (await accountStatuses()).find((a) => a.id === accountId);
    expect(good?.keyOpens).toBe(true);
    process.env.TG_SESSION_KEY = randomBytes(32).toString('base64');
    const rotated = (await accountStatuses()).find((a) => a.id === accountId);
    expect(rotated?.keyOpens).toBe(false);
    process.env.TG_SESSION_KEY = KEY;
  });

  it('renders even when the key is missing entirely', async () => {
    // The status screen is where somebody would FIND OUT the key is missing;
    // it must not be the screen that crashes because of it.
    delete process.env.TG_SESSION_KEY;
    const status = (await accountStatuses()).find((a) => a.id === accountId);
    expect(status?.keyOpens).toBe(false);
    process.env.TG_SESSION_KEY = KEY;
  });
});

describe('picking a conversation back up after the listener was away', () => {
  /**
   * GramJS does not do this: `catchUp()` is an empty stub and the package
   * never calls `updates.GetDifference`, so everything sent while the
   * listener was down is delivered to nobody, ever. A `docker compose up -d
   * --build` takes it down for a minute, and this company deploys.
   *
   * What can be proved here is the part that decides where to resume.
   */
  it('remembers the newest message id per chat, not one number for everything', async () => {
    const other = BigInt(STAMP + 500);
    await db.insert(tgMessages).values([
      {
        clientId,
        managerUserId: managerId,
        peerId: PEER,
        tgMessageId: 9000n,
        direction: 'in',
        body: 'a',
        sentAt: new Date(),
      },
      {
        clientId,
        managerUserId: managerId,
        peerId: other,
        tgMessageId: 42n,
        direction: 'in',
        body: 'b',
        sentAt: new Date(),
      },
    ]);

    const points = await resumePoints(managerId);
    const mine = new Map(points.map((p) => [p.peerId, p.lastMessageId]));
    // Telegram ids are per conversation — one global cursor would be
    // meaningless across chats, and would silently skip the quieter ones.
    expect(mine.get(PEER)).toBe(9000n);
    expect(mine.get(other)).toBe(42n);
  });

  it('returns ids as bigint, because a Telegram id does not survive Number()', async () => {
    const huge = BigInt('7100000000000000123');
    await db.insert(tgMessages).values({
      clientId,
      managerUserId: managerId,
      peerId: BigInt(STAMP + 501),
      tgMessageId: huge,
      direction: 'in',
      body: 'c',
      sentAt: new Date(),
    });
    const point = (await resumePoints(managerId)).find((p) => p.peerId === BigInt(STAMP + 501));
    expect(point?.lastMessageId).toBe(huge);
  });
});

/**
 * A client's VOICE note reaches the thread as a player, not as a broken image
 * (owner, 2026-08-07: «audio habarlar bizni sistemada korinmayabti»).
 *
 * What only this level can prove: the read that pins media onto messages
 * SPLITS it by kind. It fetches every attachment of a `tg_message` — so the
 * moment the listener started storing voice notes, one undivided `photos`
 * list would have handed the bubble an `<img>` pointing at an Ogg file.
 */
describe('media on a message is split by kind', () => {
  it('a voice note lands in audios, a photo in photos, a pdf in neither', async () => {
    const written = await storeIncoming({
      clientId,
      managerUserId: managerId,
      row: {
        peerId: PEER,
        tgMessageId: BigInt(STAMP + 991),
        direction: 'in',
        body: null,
        hasMedia: true,
        sentAt: new Date(),
      },
    });
    expect(written, 'the fixture message must be new').toBeTruthy();

    for (const media of [
      { kind: 'file', contentType: 'audio/ogg', fileName: 'voice_1.oga' },
      { kind: 'photo', contentType: 'image/jpeg', fileName: 'photo_1.jpg' },
      { kind: 'file', contentType: 'application/pdf', fileName: 'invoice.pdf' },
    ]) {
      const [row] = await db
        .insert(attachments)
        .values({
          entityType: 'tg_message',
          entityId: written!,
          kind: media.kind,
          storageKey: `test/tg-media-${STAMP}-${media.fileName}`,
          fileName: media.fileName,
          contentType: media.contentType,
          sizeBytes: 1234,
          uploadedBy: managerId,
        })
        .returning({ id: attachments.id });
      mediaAttachments.push(row!.id);
    }

    const [message] = await attachMedia([{ id: written! }]);
    expect(message!.audios.map((a) => a.fileName)).toEqual(['voice_1.oga']);
    expect(message!.photos).toHaveLength(1);
    // The pdf is in NEITHER: a bubble must not offer a player for a file no
    // browser here can play, and it must not draw it as a picture.
    expect(message!.audios).toHaveLength(1);
    expect(message!.photos.length + message!.audios.length).toBe(2);
  });
});
