import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, callLogs, callRecorderDevices, clients, users } from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import {
  attachCallAudio,
  callDeviceForToken,
  callsFor,
  canReadCallAudio,
  createCallDevice,
  findCallForAudio,
  ingestCalls,
  pairCallDevice,
  revokeCallDevice,
} from '@/modules/wms/calls/service';

/**
 * The calls round's two rules, proven where a screen cannot fake them:
 * a number the client book does not know is never stored, and a call is
 * readable by its taker and the supervision set — nobody else.
 */

const SUFFIX = String(Date.now()).slice(-7);
const CLIENT_PHONE = `+99893${SUFFIX.slice(-7)}`;
const STRANGER_PHONE = `+99871${SUFFIX.slice(-7)}`;

let sellerId = '';
let otherSellerId = '';
let clientId = '';
let deviceId = '';
let token = '';
let attachmentId = '';

const ctx = (actorId: string) => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(2);
  sellerId = staff[0]!.id;
  otherSellerId = staff[1]!.id;
  clientId = (
    await createClient(
      { name: `Qo'ng'iroq mijoz ${SUFFIX}`, clientCode: `CL${SUFFIX.slice(-6)}`, phones: [CLIENT_PHONE] },
      ctx(sellerId),
    )
  ).id;
});

afterAll(async () => {
  // Calls first: their attachment_id FK points at the attachments row.
  await db.delete(callLogs).where(eq(callLogs.clientId, clientId));
  if (attachmentId) await db.delete(attachments).where(eq(attachments.id, attachmentId));
  await db.delete(callRecorderDevices).where(inArray(callRecorderDevices.userId, [sellerId]));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe('pairing, the driver contract', () => {
  it('a code is single-use and binds the device to its minter', async () => {
    const device = await createCallDevice({ label: 'Test tel' }, ctx(sellerId));
    deviceId = device.id;
    expect(device.pairCode).toMatch(/^[A-Z0-9]{6}$/);

    const paired = await pairCallDevice(device.pairCode!);
    token = paired.token;
    expect(paired.deviceId).toBe(deviceId);
    // Burned: the same code pairs nothing twice.
    await expect(pairCallDevice(device.pairCode!)).rejects.toMatchObject({ code: 'bad_code' });

    const found = await callDeviceForToken(token);
    expect(found.userId).toBe(sellerId);
  });
});

describe('the client book is the door', () => {
  it("stores the client's call, drops the stranger's — and says which is which", async () => {
    const device = { id: deviceId, userId: sellerId };
    const startedAt = Date.now() - 60_000;
    const verdicts = await ingestCalls(device, {
      calls: [
        { phone: CLIENT_PHONE, direction: 'in', startedAt, durationSec: 95 },
        { phone: STRANGER_PHONE, direction: 'out', startedAt: startedAt + 1000, durationSec: 30 },
      ],
    });
    expect(verdicts.find((v) => v.phone === CLIENT_PHONE)!.matched).toBe(true);
    expect(verdicts.find((v) => v.phone === STRANGER_PHONE)!.matched).toBe(false);

    // The stranger's number left NO trace — the tg-import rule as a row count.
    const rows = await db.select().from(callLogs).where(eq(callLogs.deviceId, deviceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phone).toBe(CLIENT_PHONE);
    expect(rows[0]!.clientId).toBe(clientId);

    // The phone re-sends its recent log every cycle; the replay is a no-op.
    await ingestCalls(device, {
      calls: [{ phone: CLIENT_PHONE, direction: 'in', startedAt, durationSec: 95 }],
    });
    expect(await db.select().from(callLogs).where(eq(callLogs.deviceId, deviceId))).toHaveLength(1);
  });
});

describe('who reads a call — the Telegram rule', () => {
  it('the taker sees it, a colleague does not, supervision sees everything', async () => {
    const own = await callsFor(clientId, { id: sellerId, all: false });
    expect(own).toHaveLength(1);
    expect(own[0]!.durationSec).toBe(95);

    const colleague = await callsFor(clientId, { id: otherSellerId, all: false });
    expect(colleague).toHaveLength(0);

    const boss = await callsFor(clientId, { id: otherSellerId, all: true });
    expect(boss).toHaveLength(1);
  });

  it('the audio answers to the same eyes', async () => {
    const [call] = await db.select().from(callLogs).where(eq(callLogs.deviceId, deviceId));
    // The upload route's lookup: found for the OWN device …
    const found = await findCallForAudio({ id: deviceId }, {
      phone: CLIENT_PHONE,
      startedAt: call!.startedAt.getTime(),
    });
    expect(found?.id).toBe(call!.id);
    // … and a FOREIGN device must not find (so cannot claim onto) this call.
    const foreign = await findCallForAudio({ id: '00000000-0000-0000-0000-000000000001' }, {
      phone: CLIENT_PHONE,
      startedAt: call!.startedAt.getTime(),
    });
    expect(foreign).toBeNull();

    // Claim a recording onto the call: first write wins, the replay is told so.
    const [att] = await db
      .insert(attachments)
      .values({
        entityType: 'call_log',
        entityId: call!.id,
        kind: 'file',
        storageKey: `test/call-audio-${SUFFIX}.m4a`,
        fileName: 'call.m4a',
        contentType: 'audio/mp4',
        sizeBytes: 12,
        uploadedBy: sellerId,
      })
      .returning({ id: attachments.id });
    attachmentId = att!.id;
    expect(await attachCallAudio(call!.id, att!.id)).toBe(true);
    expect(await attachCallAudio(call!.id, att!.id)).toBe(false);

    // The bytes obey the panel's rule: taker yes, colleague no, supervision yes.
    expect(await canReadCallAudio(att!.id, { id: sellerId, roles: [] })).toBe(true);
    expect(await canReadCallAudio(att!.id, { id: otherSellerId, roles: [] })).toBe(false);
    expect(await canReadCallAudio(att!.id, { id: otherSellerId, roles: ['super_admin'] })).toBe(true);
  });
});

describe('revocation stops the phone', () => {
  it("a colleague cannot revoke; the owner can; the token then answers 'revoked'", async () => {
    await expect(revokeCallDevice(deviceId, ctx(otherSellerId))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await revokeCallDevice(deviceId, ctx(sellerId));
    // 410's server half: the token resolves to nothing retryable.
    await expect(callDeviceForToken(token)).rejects.toMatchObject({ code: 'revoked' });
  });
});
