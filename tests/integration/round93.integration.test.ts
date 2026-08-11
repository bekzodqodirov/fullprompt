import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  callLogs,
  callRecorderDevices,
  clients,
  tgAccounts,
  users,
} from '@/modules/platform/db/schema';
import {
  hasOwnTgAccount,
  markHistoryBackfilled,
  mayDecideChats,
  needsHistoryBackfill,
  saveAccount,
} from '@/modules/wms/crm/telegram-accounts';
import { callsFor } from '@/modules/wms/calls/service';

/**
 * Round 93 against a real database: the tray's door, the backfill stamp, and
 * the calls panel's scoping — the three answers the owner gave in one message.
 */

const STAMP = Date.now();
let seq = 0;
const uniquePhone = () => `+9989${String(seq++)}${String(STAMP).slice(-7)}`.slice(0, 13);

let sellerId: string;
let otherId: string;
let clientId: string;
let sellerDeviceId: string;
let otherDeviceId: string;

beforeAll(async () => {
  process.env.TG_SESSION_KEY = randomBytes(32).toString('base64');
  const staff = await db.select().from(users).limit(2);
  sellerId = staff[0]!.id;
  otherId = staff[1]!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `R93${STAMP}`.slice(0, 12), name: `R93 ${STAMP}`, phones: [uniquePhone()] })
    .returning({ id: clients.id });
  clientId = c!.id;
  const devices = await db
    .insert(callRecorderDevices)
    .values([
      { userId: sellerId, label: `R93a ${STAMP}`, createdBy: sellerId },
      { userId: otherId, label: `R93b ${STAMP}`, createdBy: otherId },
    ])
    .returning({ id: callRecorderDevices.id });
  sellerDeviceId = devices[0]!.id;
  otherDeviceId = devices[1]!.id;
});

afterAll(async () => {
  if (clientId) await db.delete(callLogs).where(eq(callLogs.clientId, clientId));
  if (sellerDeviceId) await db.delete(callRecorderDevices).where(eq(callRecorderDevices.id, sellerDeviceId));
  if (otherDeviceId) await db.delete(callRecorderDevices).where(eq(callRecorderDevices.id, otherDeviceId));
  if (sellerId) await db.delete(tgAccounts).where(eq(tgAccounts.managerUserId, sellerId));
  if (clientId) await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe("the tray's door (owner: «hodim o'zi tanlashi ... hodimda ko'rinmayapti»)", () => {
  const seller = () => ({ id: sellerId, permissions: new Set<string>(['crm.leads']) });

  it('is closed to a seller with no connected account', async () => {
    await db.delete(tgAccounts).where(eq(tgAccounts.managerUserId, sellerId));
    expect(await mayDecideChats(seller())).toBe(false);
  });

  it('opens the moment their own account is connected', async () => {
    await saveAccount({ managerUserId: sellerId, tgPhone: uniquePhone(), session: 'v1.test' });
    expect(await hasOwnTgAccount(sellerId)).toBe(true);
    expect(await mayDecideChats(seller())).toBe(true);
  });

  it('closes again when they sign out — a signed-out row holds no chats to answer for', async () => {
    await db
      .update(tgAccounts)
      .set({ status: 'signed_out', sessionEnc: null })
      .where(eq(tgAccounts.managerUserId, sellerId));
    expect(await mayDecideChats(seller())).toBe(false);
  });

  it('stays open to the administrator with no account at all', async () => {
    expect(
      await mayDecideChats({ id: otherId, permissions: new Set(['clients.manage']) }),
    ).toBe(true);
  });
});

describe('the connect-time week is owed per CONNECT', () => {
  it('a fresh connect owes a pull; the stamp pays it; a reconnect owes it again', async () => {
    await saveAccount({ managerUserId: sellerId, tgPhone: uniquePhone(), session: 'v1.test' });
    const account = await db.query.tgAccounts.findFirst({
      where: eq(tgAccounts.managerUserId, sellerId),
    });
    expect(await needsHistoryBackfill(account!.id)).toBe(true);

    await markHistoryBackfilled(account!.id);
    expect(await needsHistoryBackfill(account!.id)).toBe(false);

    // The manager reconnects: the week the bridge missed is owed again.
    await saveAccount({ managerUserId: sellerId, tgPhone: account!.tgPhone, session: 'v2.test' });
    expect(await needsHistoryBackfill(account!.id)).toBe(true);
  });
});

describe("the calls panel's rows are viewer-scoped BEFORE any selector touches them", () => {
  it("a seller gets only their own calls, so a hand-typed chodim can only shrink the list", async () => {
    await db.insert(callLogs).values([
      {
        deviceId: sellerDeviceId,
        userId: sellerId,
        clientId,
        direction: 'in',
        phone: '+998901234567',
        startedAt: new Date(),
        durationSec: 10,
      },
      {
        deviceId: otherDeviceId,
        userId: otherId,
        clientId,
        direction: 'out',
        phone: '+998901234567',
        startedAt: new Date(),
        durationSec: 20,
      },
    ]);

    const own = await callsFor(clientId, { id: sellerId, all: false });
    expect(own).toHaveLength(1);
    expect(own[0]!.takerId).toBe(sellerId);

    // The supervision view holds both voices — which is the only case the
    // panel offers the selector at all, mirroring the thread's rule.
    const boss = await callsFor(clientId, { id: otherId, all: true });
    expect(boss.map((r) => r.takerId).sort()).toEqual([sellerId, otherId].sort());
  });
});
