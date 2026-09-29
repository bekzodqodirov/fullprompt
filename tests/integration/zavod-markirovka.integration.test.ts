import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  boxes,
  clients,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { confirmReceipt, confirmReceiptSchema } from '@/modules/wms/receipts/service';
import { editLot, editLotSchema } from '@/modules/wms/receipts/edit';
import { globalSearch, type SearchActor } from '@/modules/wms/search/service';
import { stockTextWhere } from '@/modules/wms/inventory/stock-filter';

/**
 * The factory's code after the barcode was retired (DECISIONS #1224, the
 * owner's «zavotdan bar code kelmaydi faqat qandaydur text da yozilgan kod …
 * klient codini yozadgan joydan ham hal qilsa boladi»).
 *
 * A factory writes a TEXT code — numbers, a name, letters, in any script —
 * and it goes where an unknown code already went: the receipt's unclaimed
 * marking. So the marking must be findable by a fragment on /stock and in ⌘K,
 * whatever script it is in; and a phone still running the old bundle, which
 * posts `factoryBarcode`, must neither be refused nor write the retired
 * column — nor clear a value typed there on 2026-09-28/29.
 *
 * Its own warehouse, DEACTIVATED at the end (audit_log FK); its unclaimed
 * prixods VOIDED at the end, or every later spec's «egasiz yuk» counts them
 * (#154).
 */

const S = String(Date.now()).slice(-7);
const EAN = `69${String(Date.now()).slice(-11)}`;
const CYRILLIC = `ЗАВОД ОЛМА ${S}`;
const CHINESE = `义乌工厂${S} A08`;
let actorId = '';
let warehouseId = '';
const made = { receipts: [] as string[], lots: [] as string[] };
const ctx = () => ({ actorId });

async function receive(marking: string, extraLot: Record<string, unknown> = {}) {
  const rid = uuidv4();
  const lid = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lid,
    kind: 'photo',
    storageKey: `markirovka/${lid}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  // Through the action's own schema: that is where a stale phone's extra key
  // meets the server, and it must be STRIPPED there, not refused.
  const input = confirmReceiptSchema.parse({
    receiptId: rid,
    warehouseId,
    clientId: null,
    dealId: null,
    unclaimedMarking: marking,
    lots: [
      {
        id: lid,
        productNameZh: `马克货${S}`,
        boxCount: 2,
        dimsMode: 'uniform',
        boxLengthCm: 40,
        boxWidthCm: 30,
        boxHeightCm: 20,
        boxWeightKg: 5,
        ...extraLot,
      },
    ],
    extraCosts: [],
  });
  expect(JSON.stringify(input)).not.toContain('factoryBarcode');
  await confirmReceipt(input, ctx());
  made.receipts.push(rid);
  made.lots.push(lid);
  return { receiptId: rid, lotId: lid };
}

const manager = () =>
  ({
    id: actorId,
    fullName: 'Markirovka',
    roles: [],
    permissions: new Set(['receipts.void', 'receipts.edit']),
    warehouseScoped: false,
    warehouseIds: [],
  }) as unknown as Actor;

async function storedBarcode(lotId: string) {
  return (
    await db
      .select({ key: receiptLots.factoryBarcode })
      .from(receiptLots)
      .where(eq(receiptLots.id, lotId))
  )[0]!.key;
}

/** /stock's own join and predicate, the screen's and the XLSX's (#513). */
async function stockHits(lotId: string, q: string) {
  return db
    .select({ id: receiptLots.id })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(and(eq(boxes.lotId, lotId), stockTextWhere(q)));
}

const owner: SearchActor = {
  id: '',
  permissions: new Set(),
  warehouseScoped: false,
  warehouseIds: [],
};
const lotHit = async (q: string, lotId: string) =>
  (await globalSearch({ ...owner, id: actorId }, q)).find(
    (hit) => hit.kind === 'lot' && hit.id === lotId,
  );

let cyr = { receiptId: '', lotId: '' };
let zh = { receiptId: '', lotId: '' };

beforeAll(async () => {
  actorId = (
    await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1)
  )[0]!.id;
  const [wh] = await db
    .insert(warehouses)
    .values({
      code: `MK${S}`,
      batchPrefix: `MK${S}`,
      name: `Markirovka ${S}`,
      country: 'CN',
      type: 'origin',
      timezone: 'Asia/Shanghai',
    })
    .returning({ id: warehouses.id });
  warehouseId = wh!.id;
});

afterAll(async () => {
  if (made.lots.length) {
    await db.update(boxes).set({ status: 'void' }).where(inArray(boxes.lotId, made.lots));
  }
  if (made.receipts.length) {
    await db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' })
      .where(inArray(receipts.id, made.receipts));
  }
  if (warehouseId)
    await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, warehouseId));
  await pgClient.end();
});

describe('a phone still running the old bundle', () => {
  it('posts a factory barcode and the prixod is accepted, the retired column untouched', async () => {
    cyr = await receive(CYRILLIC, { factoryBarcode: EAN });
    expect(await storedBarcode(cyr.lotId)).toBeNull();
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, cyr.receiptId), eq(auditLog.action, 'create')));
    expect(JSON.stringify(audit!.after)).not.toContain(EAN);
    // The factory's text is the prixod's marking, as typed.
    const [row] = await db
      .select({ marking: receipts.unclaimedMarking })
      .from(receipts)
      .where(eq(receipts.id, cyr.receiptId));
    expect(row!.marking).toBe(CYRILLIC);
  });

  it('neither clears nor rewrites a barcode typed before the retirement, and writes no audit', async () => {
    // A value from 2026-09-28/29, when the field existed.
    await db.update(receiptLots).set({ factoryBarcode: EAN }).where(eq(receiptLots.id, cyr.lotId));
    const lotForm = (extra: Record<string, unknown>) => ({
      lotId: cyr.lotId,
      productNameZh: `马克货${S}`,
      productNameRu: '',
      boxCount: 2,
      boxLengthCm: 40,
      boxWidthCm: 30,
      boxHeightCm: 20,
      boxWeightKg: 5,
      note: null,
      ...extra,
    });
    const before = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.entityId, cyr.receiptId));
    await editLot(editLotSchema.parse(lotForm({ factoryBarcode: '' })), manager(), ctx());
    expect(await storedBarcode(cyr.lotId)).toBe(EAN);
    await editLot(editLotSchema.parse(lotForm({ factoryBarcode: 'AB-1234' })), manager(), ctx());
    expect(await storedBarcode(cyr.lotId)).toBe(EAN);
    const after = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.entityId, cyr.receiptId));
    expect(after).toHaveLength(before.length);
  });
});

describe('the factory text code in the marking', () => {
  it('is found on /stock by a fragment, in any script', async () => {
    zh = await receive(CHINESE);
    expect(await stockHits(cyr.lotId, `ОЛМА ${S}`)).not.toHaveLength(0);
    expect(await stockHits(zh.lotId, `工厂${S}`)).not.toHaveLength(0);
    // Wildcards are escaped: `%` is a character, not «everything».
    expect(await stockHits(cyr.lotId, '%')).toHaveLength(0);
  });

  it('is found in the global search as the lot, named by its marking', async () => {
    const hit = await lotHit(`ОЛМА ${S}`, cyr.lotId);
    expect(hit?.code).toBe(`${CYRILLIC}-A`);
    expect(await lotHit(`工厂${S}`, zh.lotId)).toBeDefined();
  });

  it('a retired barcode finds nothing any more — not on /stock, not in the search', async () => {
    expect(await storedBarcode(cyr.lotId)).toBe(EAN);
    expect(await stockHits(cyr.lotId, EAN)).toHaveLength(0);
    expect(await lotHit(EAN, cyr.lotId)).toBeUndefined();
  });
});
