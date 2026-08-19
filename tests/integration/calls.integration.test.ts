import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  callLogs,
  callRecorderDevices,
  clients,
  deals,
  leads,
  leadStages,
  users,
} from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { winLead } from '@/modules/wms/crm/service';
import {
  attachCallAudio,
  callDeviceForToken,
  callsFor,
  callsForCard,
  callsForLeadCard,
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
const LEAD_PHONE = `+99897${SUFFIX.slice(-7)}`;

let sellerId = '';
let otherSellerId = '';
let clientId = '';
let siblingId = '';
let leadId = '';
let convertedClientId = '';
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
  if (leadId) await db.delete(callLogs).where(eq(callLogs.leadId, leadId));
  if (convertedClientId) await db.delete(callLogs).where(eq(callLogs.clientId, convertedClientId));
  if (attachmentId) await db.delete(attachments).where(eq(attachments.id, attachmentId));
  await db.delete(callRecorderDevices).where(inArray(callRecorderDevices.userId, [sellerId]));
  if (leadId) await db.delete(leads).where(eq(leads.id, leadId));
  // winLead opens a deal per win (round 107) — its FK holds the client row.
  if (convertedClientId) await db.delete(deals).where(eq(deals.clientId, convertedClientId));
  await db
    .delete(clients)
    .where(inArray(clients.id, [clientId, siblingId, convertedClientId].filter(Boolean)));
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
    const rows = await db.select().from(callLogs).where(eq(callLogs.clientId, clientId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phone).toBe(CLIENT_PHONE);

    // The phone re-sends its recent log every cycle; the replay is a no-op.
    await ingestCalls(device, {
      calls: [{ phone: CLIENT_PHONE, direction: 'in', startedAt, durationSec: 95 }],
    });
    expect(await db.select().from(callLogs).where(eq(callLogs.clientId, clientId))).toHaveLength(1);

    // Revoke + re-pair mints a NEW device; the phone then re-reads its whole
    // install-day register under the new token. The fact is the PERSON's
    // call — a second pairing reporting it must still be a no-op (0061:
    // production's first day stored every call twice).
    const second = await createCallDevice({ label: 'Qayta ulash' }, ctx(sellerId));
    await ingestCalls({ id: second.id, userId: sellerId }, {
      calls: [{ phone: CLIENT_PHONE, direction: 'in', startedAt, durationSec: 95 }],
    });
    expect(await db.select().from(callLogs).where(eq(callLogs.clientId, clientId))).toHaveLength(1);
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
    const [call] = await db.select().from(callLogs).where(eq(callLogs.clientId, clientId));
    // The upload route's lookup is scoped by USER, not device (0061): the
    // row keeps the FIRST pairing's device id, and after a re-pair a
    // device-scoped find would refuse the same person's audio for ever.
    const found = await findCallForAudio({ userId: sellerId }, {
      phone: CLIENT_PHONE,
      startedAt: call!.startedAt.getTime(),
    });
    expect(found?.id).toBe(call!.id);
    // A COLLEAGUE's token must not find (so cannot claim onto) this call.
    const foreign = await findCallForAudio({ userId: otherSellerId }, {
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

describe('the card follows the person, not the code', () => {
  it("a sibling code's card shows the call, which stays on the code that took it", async () => {
    // One person, a second GS code, the same phone — the owner's reality,
    // and his first real call: it landed on the OLDEST code while he read
    // the card of the newer one (round 32's empty-card shape, on calls).
    siblingId = (
      await createClient(
        { name: `Qo'ng'iroq mijoz 2 ${SUFFIX}`, clientCode: `CS${SUFFIX.slice(-6)}`, phones: [CLIENT_PHONE] },
        ctx(sellerId),
      )
    ).id;
    const onSibling = await callsForCard(siblingId, { id: sellerId, all: false });
    expect(onSibling).toHaveLength(1);
    expect(onSibling[0]!.clientId).toBe(clientId); // the DATA stays where it landed
    // The narrow read stays narrow — the widening belongs to the card alone.
    expect(await callsFor(siblingId, { id: sellerId, all: false })).toHaveLength(0);
  });
});

describe("an open lead's phone is the second door (0063)", () => {
  it("keeps a prospect's call on the lead, shows it on the lead card", async () => {
    const [stage] = await db
      .select({ id: leadStages.id })
      .from(leadStages)
      .where(eq(leadStages.kind, 'open'))
      .limit(1);
    leadId = (
      await db
        .insert(leads)
        .values({ name: `Prospekt ${SUFFIX}`, phone: LEAD_PHONE, stageId: stage!.id, createdBy: sellerId })
        .returning({ id: leads.id })
    )[0]!.id;

    const verdicts = await ingestCalls({ id: deviceId, userId: sellerId }, {
      calls: [{ phone: LEAD_PHONE, direction: 'in', startedAt: Date.now() - 30_000, durationSec: 40 }],
    });
    expect(verdicts[0]!.matched).toBe(true);
    const [row] = await db.select().from(callLogs).where(eq(callLogs.leadId, leadId));
    expect(row).toBeDefined();
    expect(row!.clientId).toBeNull();

    const onLead = await callsForLeadCard({ id: leadId, phone: LEAD_PHONE }, { id: sellerId, all: false });
    expect(onLead).toHaveLength(1);
    expect(onLead[0]!.clientCode).toBeNull();
  });

  it("the owner's case: a lead sharing the CLIENT's phone shows the client's call", async () => {
    // conversationClientForLead refuses this (two sibling codes = ambiguous),
    // which blanked the lead card while the client card played the audio.
    const onAmbiguous = await callsForLeadCard(
      { id: leadId, phone: CLIENT_PHONE },
      { id: sellerId, all: false },
    );
    expect(onAmbiguous.length).toBeGreaterThanOrEqual(1);
    expect(onAmbiguous.some((r) => r.clientId === clientId)).toBe(true);
  });

  it('converting the lead moves its calls onto the new code', async () => {
    // Round 107: conversion goes through winLead (won = client + deal, one
    // landing). What this test proves — the rekey — rides the same path.
    const won = await winLead(leadId, {}, ctx(sellerId));
    convertedClientId = won.clientId;
    // The call follows the person: readable by the CLIENT card's exact read.
    const onClient = await callsFor(convertedClientId, { id: sellerId, all: false });
    expect(onClient).toHaveLength(1);
    // The lead key stays — the lead card's history does not go blank.
    const [row] = await db
      .select()
      .from(callLogs)
      .where(and(eq(callLogs.leadId, leadId), isNull(callLogs.clientId)));
    expect(row).toBeUndefined();
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
