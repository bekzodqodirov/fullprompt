import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  tgMessages,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { botLookup, type BotActor } from '@/modules/wms/bot/lookup';
import { unansweredChats, unansweredText } from '@/modules/wms/crm/unanswered';

/**
 * "Where is it?" and "who is waiting?" — the two questions batch B answers
 * in the bot. What matters in both is that the bot reads exactly as far as
 * the person's own grants and warehouses do: a bot that is wider than the
 * screens is a back door with a keyboard.
 */

const WH_O = 'BLKO';
const WH_D = 'BLKD';
let originId: string;
let destId: string;
let actorId: string;
let clientId: string;
let clientCode: string;
const ctx = () => ({ actorId });

/** The unscoped reader (a logist): sees everything, money included. */
const boss = (): BotActor => ({
  id: actorId,
  permissions: new Set(['finance.view', 'plans.manage']),
  warehouseScoped: false,
  warehouseIds: [],
});

/** A warehouse hand at the DESTINATION, with no money grant. */
const destHand = (): BotActor => ({
  id: actorId,
  permissions: new Set(['scan.unload']),
  warehouseScoped: true,
  warehouseIds: [destId],
});

async function makeLot(boxCount: number) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `blk/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: originId,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '手机壳',
          productNameRu: 'Chexol',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 40,
          boxWidthCm: 30,
          boxHeightCm: 20,
          boxWeightKg: 5,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { lotId, boxIds: rows.map((b) => b.id), shortCodes: rows.map((b) => b.shortCode) };
}

beforeAll(async () => {
  async function ensureWarehouse(code: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({
        code,
        name: `Bot ${code}`,
        country: 'CN',
        type: 'origin',
        timezone: 'Asia/Shanghai',
        batchPrefix: code,
      })
      .returning();
    return wh!.id;
  }
  originId = await ensureWarehouse(WH_O);
  destId = await ensureWarehouse(WH_D);
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  clientCode = `BL${String(Date.now()).slice(-6)}`;
  const [c] = await db.insert(clients).values({ clientCode, name: 'Bot lookup mijoz' }).returning();
  clientId = c!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('the bot answers "where is it?"', () => {
  it('a box code says whose it is, what it is and where', async () => {
    const lot = await makeLot(2);
    const answer = await botLookup(boss(), lot.shortCodes[0]!.toLowerCase());
    expect(answer).toContain(lot.shortCodes[0]!);
    expect(answer).toContain(clientCode);
    // The Russian name is preferred over the Chinese one, like everywhere else.
    expect(answer).toContain('Chexol');
    expect(answer).toContain('omborda');
    expect(answer).toContain(WH_O);
  });

  it('a client code totals the cargo, and the balance line obeys the grant', async () => {
    await makeLot(3);
    const withMoney = await botLookup(boss(), clientCode);
    expect(withMoney).toContain(clientCode);
    expect(withMoney).toContain('Balans');

    const noMoney = await botLookup(
      { ...boss(), permissions: new Set(['scan.load']) },
      clientCode,
    );
    // Same cargo, no money line — the finance screens' own gate.
    expect(noMoney).toContain(clientCode);
    expect(noMoney).not.toContain('Balans');
  });

  it('a warehouse-scoped hand is told when cargo is not on their floor', async () => {
    const lot = await makeLot(1);
    const answer = await botLookup(destHand(), lot.shortCodes[0]!);
    // The box sits at the ORIGIN and this person works the destination.
    expect(answer).toContain('omboringizda emas');
    expect(answer).not.toContain('omborda');
  });

  it('a batch code says where it is going and how much rode it', async () => {
    const lot = await makeLot(2);
    const sub = await submitPlan(
      {
        originWarehouseId: originId,
        destWarehouseId: destId,
        lines: [{ lotId: lot.lotId, boxCount: 2 }],
      },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    for (const code of lot.shortCodes) {
      await ingestLoadScans(
        [
          {
            clientEventUuid: uuidv4(),
            batchId: batch!.id,
            code,
            method: 'qr' as const,
            addedOnSpot: false,
            scannedAt: new Date().toISOString(),
          },
        ],
        ctx(),
      );
    }
    await departBatch(batch!.id, ctx());

    const answer = await botLookup(boss(), batch!.code);
    expect(answer).toContain(batch!.code);
    expect(answer).toContain(`${WH_O} → ${WH_D}`);
    expect(answer).toContain('Yuklangan: 2');

    // And the box now names its truck.
    const boxAnswer = await botLookup(boss(), lot.shortCodes[0]!);
    expect(boxAnswer).toContain(batch!.code);
    expect(boxAnswer).toContain('yo‘lda');
  });

  it('nonsense and too-short input answer nothing at all', async () => {
    expect(await botLookup(boss(), 'zz')).toBeNull();
    expect(await botLookup(boss(), 'ZZ99-999999')).toBeNull();
  });
});

describe('the waiting-customer reminder', () => {
  it('fires once, only for silence past the threshold, and never after a reply', async () => {
    const peer = BigInt(Date.now()) * 1000n + 5n;
    const long = new Date(Date.now() - 90 * 60_000);
    const [old] = await db
      .insert(tgMessages)
      .values({
        clientId,
        managerUserId: actorId,
        peerId: peer,
        tgMessageId: 1n,
        direction: 'in',
        body: 'Narx qancha?',
        sentAt: long,
      })
      .returning();

    const due = await unansweredChats(30);
    const mine = due.find((c) => c.clientId === clientId);
    expect(mine, 'a client waiting 90 minutes is due at a 30-minute threshold').toBeDefined();
    expect(mine!.managerUserId).toBe(actorId);
    expect(mine!.waitingMinutes).toBeGreaterThanOrEqual(89);
    expect(unansweredText(mine!, 'https://x')).toContain(clientCode);
    expect(unansweredText(mine!, 'https://x')).toContain('Narx qancha?');

    // Marked → the same silence is never reported twice.
    await db
      .update(tgMessages)
      .set({ remindedAt: new Date() })
      .where(eq(tgMessages.id, old!.id));
    expect((await unansweredChats(30)).some((c) => c.clientId === clientId)).toBe(false);

    // A newer OUTGOING message means the ball is ours no longer.
    await db.insert(tgMessages).values({
      clientId,
      managerUserId: actorId,
      peerId: peer,
      tgMessageId: 2n,
      direction: 'out',
      body: 'Hozir hisoblab beramiz',
      sentAt: new Date(Date.now() - 60 * 60_000),
    });
    await db
      .update(tgMessages)
      .set({ remindedAt: null })
      .where(eq(tgMessages.id, old!.id));
    expect((await unansweredChats(30)).some((c) => c.clientId === clientId)).toBe(false);

    // A threshold of 0 switches the whole thing off.
    expect(await unansweredChats(0)).toEqual([]);
  });
});
