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
import { linkClientChat } from '@/modules/platform/telegram/client-cabinet';
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
  const [c] = await db.insert(clients).values({ clientCode: `C2${suffix}`, name: 'Cabinet client' }).returning();
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

describe('linking', () => {
  it('one-time code links a chat to the client; revoked/unknown codes fail', async () => {
    const code = `c-test-${Date.now()}`;
    await db
      .insert(clientTelegramLinks)
      .values({ clientId, linkCode: code, status: 'pending', createdBy: actorId });

    const linked = await linkClientChat(code, CHAT_ID);
    expect(linked?.id).toBe(clientId);

    const chats = await clientsForChat(BigInt(CHAT_ID));
    expect(chats.map((c) => c.id)).toContain(clientId);

    // The code is single-use — burned on link.
    expect(await linkClientChat(code, CHAT_ID + 1)).toBeNull();
    expect(await linkClientChat('no-such-code', CHAT_ID)).toBeNull();
  });

  it('re-linking the same client to the same chat does not duplicate', async () => {
    const code = `c-test2-${Date.now()}`;
    await db
      .insert(clientTelegramLinks)
      .values({ clientId, linkCode: code, status: 'pending', createdBy: actorId });
    await linkClientChat(code, CHAT_ID);
    const chats = await clientsForChat(BigInt(CHAT_ID));
    expect(chats.filter((c) => c.id === clientId)).toHaveLength(1);
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
