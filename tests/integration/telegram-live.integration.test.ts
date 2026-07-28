import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, tgAccounts, tgMessages, users } from '@/modules/platform/db/schema';
import {
  accountStatuses,
  clientBook,
  heartbeat,
  loadAccount,
  markAccount,
  saveAccount,
  storeIncoming,
  takeListenerLock,
} from '@/modules/wms/crm/telegram-accounts';
import { decideIncoming } from '@/modules/wms/crm/telegram-live';

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

    expect(
      await storeIncoming({ clientId: verdict.clientId, managerUserId: managerId, row: verdict.row }),
    ).toBe(true);
    // Telegram replays recent history on reconnect. The unique index is what
    // makes that free, which is why the listener keeps no position of its own.
    expect(
      await storeIncoming({ clientId: verdict.clientId, managerUserId: managerId, row: verdict.row }),
    ).toBe(false);

    const rows = await db.select().from(tgMessages).where(eq(tgMessages.clientId, clientId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('Yuk qachon jo‘naydi?');
  });

  it('writes nothing at all for a number that is not in the client book', async () => {
    const before = await db.select().from(tgMessages).where(eq(tgMessages.clientId, clientId));
    const verdict = decideIncoming({ ...peer, phone: '+998995554433' }, msg, await clientBook());
    expect(verdict).toEqual({ store: false, reason: 'not_a_client' });
    // There is no branch that could store it: `client_id` is NOT NULL and the
    // verdict carries no id. Asserted anyway, because this is the promise made
    // to twelve people about their private conversations.
    const after = await db.select().from(tgMessages).where(eq(tgMessages.clientId, clientId));
    expect(after).toHaveLength(before.length);
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
