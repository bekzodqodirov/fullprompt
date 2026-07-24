import 'dotenv/config';
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
  beginClientLink,
  completeClientLink,
  failClientLink,
} from '@/modules/platform/telegram/client-cabinet';
import { renderClientCabinetText } from '@/modules/platform/notifications/service';

/** Phase 2.2: Telegram client cabinet — linking, cargo view, photos, debt. */

const WH = 'C22WH';
const CHAT_ID = 922_000_111;
let warehouseId: string;
let actorId: string;
let clientId: string;
let otherClientId: string;
let lotId: string;
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
  const suffix = String(Date.now()).slice(-6);
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `C2${suffix}`, name: 'Cabinet client', phones: ['+998 90 175 78 00'] })
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
  it('cargo overview groups the client boxes by lot with statuses and photos flag', async () => {
    const lots = await cargoOverview(clientId);
    const lot = lots.find((l) => l.lotId === lotId)!;
    expect(lot.total).toBe(3);
    expect(lot.statuses.in_stock).toBe(3);
    expect(lot.warehouseCodes).toContain(WH);
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

describe('client-facing notifications', () => {
  it('renders uz texts for ReadyForPickup and BoxIssued, nothing for staff events', () => {
    const ready = renderClientCabinetText('ReadyForPickup', {
      clientCode: 'GS777',
      boxCount: 13,
      warehouseCode: 'TAS1',
    });
    expect(ready).toContain('GS777');
    expect(ready).toContain('13');
    expect(ready).toContain('TAS1');
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
