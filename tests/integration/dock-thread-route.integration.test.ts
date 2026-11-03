import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The dock's reply verdict when the ACCOUNT holds a reply (send review): the
 * route answers why — and for Telegram's send wait, until when, because the
 * guard row persists it uncapped and a wait of hours read «Bir daqiqa
 * kuting» in the drawer. Asked of the ROUTE, with the actor stood in.
 */
const override = vi.hoisted(() => ({ actor: null as null | { id: string; roles: string[]; permissions: Set<string> } }));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    getActor: async () => override.actor as Awaited<ReturnType<typeof real.getActor>>,
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import { clients, tgAccountGuard, tgAccounts, tgMessages, users } from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { GET as dockThread } from '@/app/api/dock/thread/route';

const STAMP = String(Date.now()).slice(-7);
const PEER = BigInt(`93${STAMP}`);
let managerId = '';
let accountId = '';
let clientId = '';
let sendingBefore = false;

beforeAll(async () => {
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${STAMP}55`, fullName: `Dock thread ${STAMP}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  managerId = u!.id;
  const [a] = await db
    .insert(tgAccounts)
    .values({ managerUserId: managerId, tgPhone: `+99892${STAMP}55`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = a!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `DT${STAMP}`, name: `Dock thread mijoz ${STAMP}` })
    .returning({ id: clients.id });
  clientId = c!.id;
  // The customer wrote first, on this account — the never-initiate rule is met.
  await db.insert(tgMessages).values({
    clientId,
    managerUserId: managerId,
    peerId: PEER,
    tgMessageId: BigInt(`5${STAMP}`),
    direction: 'in',
    body: 'Salom',
    sentAt: new Date(),
  });
  // A company switch (#183): put back as found in afterAll.
  await setSetting('tg_sending_enabled', true, managerId);
  override.actor = { id: managerId, roles: [], permissions: new Set(['crm.leads']) };
});

afterAll(async () => {
  await setSetting('tg_sending_enabled', sendingBefore, managerId);
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgMessages).where(eq(tgMessages.managerUserId, managerId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db
    .delete(users)
    .where(inArray(users.id, [managerId]))
    .catch(() => db.update(users).set({ active: false }).where(eq(users.id, managerId)));
  await pgClient.end();
});

async function verdict() {
  const res = await dockThread(new Request(`http://localhost/api/dock/thread?client=${clientId}`));
  expect(res.status).toBe(200);
  return (await res.json()) as { canReply: boolean; reason: string | null; floodUntil?: string | null };
}

describe('the dock says why the account holds a reply (send review)', () => {
  it('nothing held: it may reply, and no wait is named', async () => {
    expect(await verdict()).toMatchObject({ canReply: true, reason: null, floodUntil: null });
  });

  it('Telegram’s send wait comes with its end', async () => {
    const until = new Date(Date.now() + 5 * 3_600_000);
    await db.insert(tgAccountGuard).values({ accountId, floodUntil: until });
    const v = await verdict();
    expect(v).toMatchObject({ canReply: false, reason: 'flood_wait' });
    expect(new Date(v.floodUntil!).getTime()).toBe(until.getTime());
  });

  it('a restriction is its own reason, with no wait beside it', async () => {
    await db
      .update(tgAccountGuard)
      .set({ pausedAt: new Date(), pausedKind: 'restricted', pauseReason: 'PEER_FLOOD' })
      .where(eq(tgAccountGuard.accountId, accountId));
    expect(await verdict()).toMatchObject({ canReply: false, reason: 'account_paused', floodUntil: null });
  });
});
