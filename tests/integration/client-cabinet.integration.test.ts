import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  clientTelegramLinks,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { addTransaction } from '@/modules/wms/finance/service';
import {
  cargoOverview,
  clientsForChat,
  debtSummary,
  lotPhotoKeys,
} from '@/modules/wms/client-cabinet/service';
import {
  autoLinkClientToVerifiedChats,
  beginClientLink,
  completeClientLink,
  failClientLink,
  linkAllClientsForPhone,
} from '@/modules/platform/telegram/client-cabinet';
import { renderClientCabinetText } from '@/modules/platform/notifications/service';
import { authenticateCabinet, cabinetPayload } from '@/modules/wms/client-cabinet/miniapp';

/** Phase 2.2: Telegram client cabinet — linking, cargo view, photos, debt. */

const WH = 'C22WH';
const CHAT_ID = 922_000_111;
let warehouseId: string;
let actorId: string;
let clientId: string;
let otherClientId: string;
let lotId: string;
let testPhone: string;
let suffix: string;
const ctx = () => ({ actorId });

beforeAll(async () => {
  const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, WH) });
  warehouseId = existing
    ? existing.id
    : (
        await db
          .insert(warehouses)
          .values({ code: WH, name: 'Cabinet WH', country: 'UZ', type: 'distribution', timezone: 'Asia/Tashkent', batchPrefix: WH })
          .returning()
      )[0]!.id;
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  suffix = String(Date.now()).slice(-6);
  // Run-unique phone so seed/other-test clients can never collide.
  testPhone = `+998${suffix}111`;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `C2${suffix}`, name: 'Cabinet client', phones: [testPhone] })
    .returning();
  clientId = c!.id;
  const [o] = await db.insert(clients).values({ clientCode: `C9${suffix}`, name: 'Other client' }).returning();
  otherClientId = o!.id;

  // One receipt with a photo so cargo + photo views have data.
  const receiptId = uuidv4();
  lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `c22test/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '客户货',
          boxCount: 3,
          dimsMode: 'uniform',
          boxLengthCm: 30,
          boxWidthCm: 30,
          boxHeightCm: 30,
          boxWeightKg: 5,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
});

afterAll(async () => {
  await pgClient.end();
});

describe('linking (two-step, phone-verified)', () => {
  async function mintCode(forClient: string) {
    const code = `c-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [row] = await db
      .insert(clientTelegramLinks)
      .values({ clientId: forClient, linkCode: code, status: 'pending', createdBy: actorId })
      .returning();
    return { code, linkId: row!.id };
  }

  it('start asks for the phone, completion links, the code is single-use', async () => {
    const { code, linkId } = await mintCode(clientId);
    expect(await beginClientLink(code, CHAT_ID)).toBe('ask_phone');

    const linked = await completeClientLink(linkId, CHAT_ID);
    expect(linked?.id).toBe(clientId);
    const chats = await clientsForChat(BigInt(CHAT_ID));
    expect(chats.map((c) => c.id)).toContain(clientId);

    // Burned on link — cannot be started or completed again.
    expect(await beginClientLink(code, CHAT_ID + 1)).toBeNull();
    expect(await completeClientLink(linkId, CHAT_ID + 1)).toBeNull();
    expect(await beginClientLink('no-such-code', CHAT_ID)).toBeNull();
  });

  it('re-linking the same client to the same chat does not duplicate', async () => {
    const { linkId } = await mintCode(clientId);
    await completeClientLink(linkId, CHAT_ID);
    const chats = await clientsForChat(BigInt(CHAT_ID));
    expect(chats.filter((c) => c.id === clientId)).toHaveLength(1);
  });

  it('failed verification burns the code (wrong-recipient incident)', async () => {
    const { code, linkId } = await mintCode(clientId);
    expect(await beginClientLink(code, CHAT_ID + 5)).toBe('ask_phone');
    await failClientLink(linkId);
    const row = await db.query.clientTelegramLinks.findFirst({
      where: eq(clientTelegramLinks.id, linkId),
    });
    expect(row?.status).toBe('revoked');
    expect(row?.linkCode).toBeNull();
    expect(await beginClientLink(code, CHAT_ID + 5)).toBeNull();
    expect(await completeClientLink(linkId, CHAT_ID + 5)).toBeNull();
  });

  it('one verified phone connects EVERY code of that person; new codes auto-join', async () => {
    const chatId = CHAT_ID + 10;
    // Second code of the same person (same phone, different formatting).
    const [second] = await db
      .insert(clients)
      .values({ clientCode: `C5${suffix}`, name: 'Same person', phones: [`998 ${suffix} 111`] })
      .returning();

    const { linkId } = await mintCode(clientId);
    await completeClientLink(linkId, chatId);
    const all = await linkAllClientsForPhone(testPhone, chatId, actorId);
    expect(all.map((c) => c.clientCode)).toContain(`C2${suffix}`);
    expect(all.map((c) => c.clientCode)).toContain(`C5${suffix}`);

    // A THIRD code opened later for the same phone joins the chat by itself.
    const [third] = await db
      .insert(clients)
      .values({ clientCode: `C7${suffix}`, name: 'Same person again', phones: [testPhone] })
      .returning();
    const added = await autoLinkClientToVerifiedChats(third!.id, actorId);
    expect(added).toBeGreaterThan(0);
    const chats = await clientsForChat(BigInt(chatId));
    expect(chats.map((c) => c.id)).toContain(third!.id);
    expect(chats.map((c) => c.id)).toContain(second!.id);

    // A client with a DIFFERENT phone never rides along.
    expect(chats.map((c) => c.id)).not.toContain(otherClientId);
  });

  it('a client without a registered phone cannot be verified, code stays for retry', async () => {
    const { code } = await mintCode(otherClientId); // otherClient has no phones
    expect(await beginClientLink(code, CHAT_ID + 6)).toBe('no_phone');
    // NOT burned — staff adds the phone, the client taps the same link again.
    const row = await db.query.clientTelegramLinks.findFirst({
      where: eq(clientTelegramLinks.linkCode, code),
    });
    expect(row?.status).toBe('pending');
  });
});

describe('cabinet views', () => {
  it('cargo overview groups the client boxes by lot with the journey rung and photos flag', async () => {
    const lots = await cargoOverview(clientId);
    const lot = lots.find((l) => l.lotId === lotId)!;
    expect(lot.total).toBe(3);
    // The rung, not the raw box status. This fixture's warehouse is an UZBEK
    // distribution one, so three boxes on its shelf are «O'zbekistonda —
    // rasmiylashtirilmoqda»: they landed here and nobody has released them.
    expect(lot.groups).toHaveLength(1);
    expect(lot.groups[0]!.stage).toBe('in_uz');
    expect(lot.groups[0]!.n).toBe(3);
    // Standing still is never given a road.
    expect(lot.groups[0]!.transit).toBeNull();
    // And the history knows when it was received — the receipt's own movement.
    expect(lot.journey.map((s) => s.key)).toEqual(['received']);
    expect(lot.warehousePlaces).toContain('Cabinet WH');
    expect(lot.hasPhotos).toBe(true);
  });

  it('lot photos are returned only to the owning client', async () => {
    const own = await lotPhotoKeys(lotId, [clientId]);
    expect(own).toHaveLength(1);
    expect(own[0]!.storageKey).toBe(`c22test/${lotId}`);
    // Another client's chat must get nothing (callback data is untrusted).
    expect(await lotPhotoKeys(lotId, [otherClientId])).toHaveLength(0);
    expect(await lotPhotoKeys(lotId, [])).toHaveLength(0);
  });

  it('debt summary mirrors the finance ledger', async () => {
    await addTransaction(
      { clientId, type: 'charge', amount: 30, currency: 'USD', txDate: '2026-07-20' },
      ctx(),
    );
    const debt = await debtSummary(clientId);
    expect(debt.balanceUsd).toBe(30);
    expect(debt.recent[0]!.type).toBe('charge');
  });
});

/**
 * The Mini App reaches the same data through a different door: no bot, no
 * chat, just a signed blob on an HTTP request. `init-data.test.ts` proves the
 * signature maths; this proves the part that decides WHOSE cargo comes back.
 */
describe('the Mini App door', () => {
  const APP_TOKEN = '922000111:MINI-APP-TEST-TOKEN';
  let savedToken: string | undefined;

  /** Telegram's construction, written out independently of the source. */
  function signFor(userId: number, token = APP_TOKEN): string {
    const fields: Record<string, string> = {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: userId, first_name: 'Client', language_code: 'ru' }),
    };
    const check = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
  }

  beforeAll(() => {
    savedToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = APP_TOKEN;
  });
  afterAll(() => {
    if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  });

  it('opens for the chat the blob is signed for, and shows only its own codes', async () => {
    const auth = await authenticateCabinet(signFor(CHAT_ID));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.clients.map((c) => c.id)).toContain(clientId);
    expect(auth.clients.map((c) => c.id)).not.toContain(otherClientId);
  });

  it('refuses a Telegram user whose chat was never linked — 403, not 401', async () => {
    // A real signature from a real person who simply is not a customer. The
    // identity is fine; the authorization is not, and telling the two apart is
    // what lets the screen say "ask your manager for a link" instead of
    // "something went wrong".
    const auth = await authenticateCabinet(signFor(CHAT_ID + 777_000));
    expect(auth).toMatchObject({ ok: false, status: 403, reason: 'not_linked' });
  });

  it('refuses a blob signed with another bot’s token', async () => {
    const auth = await authenticateCabinet(signFor(CHAT_ID, 'someone:else'));
    expect(auth).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses everything when no bot token is configured', async () => {
    // The fail-closed rule. A server that lost its token cannot CHECK a
    // signature, and a cabinet that opens without checking is worse than one
    // that does not open.
    const genuine = signFor(CHAT_ID);
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      expect(await authenticateCabinet(genuine)).toMatchObject({
        ok: false,
        status: 401,
        reason: 'not_configured',
      });
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = APP_TOKEN;
    }
  });

  it('carries the cubes, kilos, count and photo count the owner asked for', async () => {
    const auth = await authenticateCabinet(signFor(CHAT_ID));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    const payload = await cabinetPayload(auth);

    const mine = payload.clients.find((c) => c.id === clientId)!;
    const lot = mine.cargo.find((l) => l.lotId === lotId)!;
    expect(lot.total).toBe(3);
    // 3 boxes of 30×30×30 cm at 5 kg — the figures the client checks against
    // their own supplier's packing list.
    expect(lot.weightKg).toBeCloseTo(15, 2);
    expect(lot.volumeM3).toBeCloseTo(0.081, 3);
    expect(lot.perBoxKg).toBeCloseTo(5, 2);
    expect(lot.photoCount).toBe(1);

    // The header totals are the sum of what is actually listed below them.
    const boxes = payload.clients.flatMap((c) => c.cargo).reduce((n, l) => n + l.total, 0);
    expect(payload.totals.boxes).toBe(boxes);
    expect(payload.clients.map((c) => c.id)).not.toContain(otherClientId);
  });

  it('never carries what the company earns', async () => {
    // One join away in `cost_allocations` sits landed cost and margin. A
    // client reading their own cabinet must not find it, and the cheapest
    // guard against a future `select *` is a test that says so.
    const auth = await authenticateCabinet(signFor(CHAT_ID));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    const json = JSON.stringify(await cabinetPayload(auth));
    for (const leak of ['landedCost', 'costUsd', 'margin', 'profit', 'sellPrice']) {
      expect(json).not.toContain(leak);
    }
  });
});

describe('client-facing notifications', () => {
  /*
   * REWRITTEN in round 98, and the change of subject is the point.
   *
   * This used to assert that `ReadyForPickup` renders a customer's message.
   * That event fires once per unload SCAN, which is exactly the defect the
   * owner reported — one «yukingiz keldi» per carton. The customer's copy is
   * now a claimed notice (`wms/notices/arrival.ts`), so the assertion here is
   * that this event says NOTHING to the client, and the event stays for staff.
   */
  it('says nothing to the client for ReadyForPickup; renders BoxIssued; nothing for staff events', () => {
    expect(
      renderClientCabinetText('ReadyForPickup', {
        clientCode: 'GS777',
        boxCount: 13,
        warehouseCode: 'TAS1',
      }),
    ).toBeNull();
    const issued = renderClientCabinetText('BoxIssued', {
      clientCode: 'GS777',
      boxCount: 2,
      warehouseCode: 'TAS1',
      personName: 'Ali',
      remaining: 5,
    });
    expect(issued).toContain('Ali');
    expect(issued).toContain('5');
    expect(renderClientCabinetText('PlanApproved', {})).toBeNull();
  });
});
