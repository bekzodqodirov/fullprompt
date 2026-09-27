import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  batches,
  boxes,
  clientNotices,
  clients,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { confirmReceipt, ReceiptError } from '@/modules/wms/receipts/service';
import { EditError, editLot } from '@/modules/wms/receipts/edit';
import { globalSearch, type SearchActor } from '@/modules/wms/search/service';
import { stockTextWhere } from '@/modules/wms/inventory/stock-filter';

/**
 * The factory barcode (0112, the owner's Q10 c): stored as one canonical key
 * per lot, edited on the lot form without the structural lock, and found by
 * the global search under the cargo-near rule and by /stock's own predicate.
 * Its own three warehouses — the lot is received at A, a carton is moved to B,
 * C never sees it — DEACTIVATED at the end, never deleted (audit_log FK).
 */

const S = String(Date.now()).slice(-7);
// A unique EAN-13 per run: the search is an EXACT key match, and another
// run's lot with the same key would be a true hit too.
const EAN = `69${String(Date.now()).slice(-11)}`;
const W = { a: '', b: '', c: '' };
let actorId = '';
let clientId = '';
let lotId = '';
let receiptId = '';
const ctx = () => ({ actorId });

async function mintWarehouse(tag: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code: `FB${tag}${S}`, batchPrefix: `FB${tag}${S}`, name: `Shtrix ${tag} ${S}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' })
    .returning({ id: warehouses.id });
  return row!.id;
}

async function receive(barcode: string, count = 3) {
  const rid = uuidv4();
  const lid = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lid,
    kind: 'photo',
    storageKey: `shtrix/${lid}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId: rid,
      warehouseId: W.a,
      clientId,
      dealId: null,
      unclaimedMarking: '',
      lots: [
        {
          id: lid,
          productNameZh: `条码货${S}`,
          boxCount: count,
          dimsMode: 'uniform',
          boxLengthCm: 40,
          boxWidthCm: 30,
          boxHeightCm: 20,
          boxWeightKg: 5,
          factoryBarcode: barcode,
        },
      ],
      extraCosts: [],
    } as never,
    ctx(),
  );
  return { receiptId: rid, lotId: lid };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no refusal';
  } catch (err) {
    if (err instanceof ReceiptError || err instanceof EditError) return err.code;
    throw err;
  }
}

const manager = () =>
  ({ id: actorId, fullName: 'Shtrix', roles: [], permissions: new Set(['receipts.void', 'receipts.edit']), warehouseScoped: false, warehouseIds: [] }) as unknown as Actor;

function lotForm(extra: Record<string, unknown>) {
  return {
    lotId,
    productNameZh: `条码货${S}`,
    productNameRu: '',
    boxCount: 3,
    boxLengthCm: 40,
    boxWidthCm: 30,
    boxHeightCm: 20,
    boxWeightKg: 5,
    note: null,
    ...extra,
  };
}

async function storedKey() {
  return (await db.select({ key: receiptLots.factoryBarcode }).from(receiptLots).where(eq(receiptLots.id, lotId)))[0]!.key;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  W.a = await mintWarehouse('A');
  W.b = await mintWarehouse('B');
  W.c = await mintWarehouse('C');
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `FB${S}`, name: `Shtrix mijoz ${S}` })
    .returning({ id: clients.id });
  clientId = client!.id;
});

afterAll(async () => {
  if (clientId) await db.delete(clientNotices).where(eq(clientNotices.clientId, clientId));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('the barcode at the receive door', () => {
  it('stores the canonical key of what the Chinese IME typed', async () => {
    const fullWidth = [...EAN].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
    ({ receiptId, lotId } = await receive(fullWidth));
    expect(await storedKey()).toBe(EAN);
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, receiptId), eq(auditLog.action, 'create')));
    expect(JSON.stringify(audit!.after)).toContain(EAN);
  });

  it('refuses one of OUR codes and a string that is no barcode, naming the lot', async () => {
    const ours = await refusal(receive('YW26-000123'));
    expect(ours).toBe('barcode_is_ours');
    expect(await refusal(receive('汉字'))).toBe('barcode_invalid');
    // The lot's name rides the message, the photo rule's shape.
    const err = await receive('CR-YW26-00001').catch((e: ReceiptError) => e);
    expect((err as ReceiptError).message).toBe(`条码货${S}`);
  });
});

describe('the barcode on the lot form', () => {
  it('sets, leaves and clears it, with the diff on the audit row', async () => {
    const before = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, receiptId));
    await editLot(lotForm({ factoryBarcode: 'ab-12 34' }) as never, manager(), ctx());
    expect(await storedKey()).toBe('AB-1234');
    const [row] = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, receiptId), eq(auditLog.action, 'update')))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(row!.before).toMatchObject({ factoryBarcode: EAN });
    expect(row!.after).toMatchObject({ factoryBarcode: 'AB-1234' });
    expect((await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, receiptId))).length).toBe(
      before.length + 1,
    );
    // Absent from the form = leave it.
    await editLot(lotForm({ note: 'izoh' }) as never, manager(), ctx());
    expect(await storedKey()).toBe('AB-1234');
    // '' clears it.
    await editLot(lotForm({ factoryBarcode: '' }) as never, manager(), ctx());
    expect(await storedKey()).toBeNull();
    expect(await refusal(editLot(lotForm({ factoryBarcode: 'YW26-000999' }) as never, manager(), ctx()))).toBe(
      'barcode_is_ours',
    );
  });

  it('is not structural: a barcode fix is accepted after a carton has left the shelf', async () => {
    const [first] = await db.select({ id: boxes.id }).from(boxes).where(eq(boxes.lotId, lotId)).orderBy(boxes.seqInLot).limit(1);
    await db.update(boxes).set({ status: 'planned' }).where(eq(boxes.id, first!.id));
    // A plain operator (receipts.edit, the creator, the same day) — a count
    // change would be refused now; the barcode is not.
    const operator = { ...manager(), permissions: new Set(['receipts.edit']) } as unknown as Actor;
    await editLot(lotForm({ factoryBarcode: EAN }) as never, operator, ctx());
    expect(await storedKey()).toBe(EAN);
    expect(await refusal(editLot(lotForm({ boxCount: 4 }) as never, operator, ctx()))).toBe('structural_locked');
    await db.update(boxes).set({ status: 'in_stock' }).where(eq(boxes.id, first!.id));
  });
});

describe('finding a lot by its barcode', () => {
  const scoped = (warehouseId: string): SearchActor => ({
    id: actorId,
    permissions: new Set(['receipts.create']),
    warehouseScoped: true,
    warehouseIds: [warehouseId],
  });
  const lotHits = async (actor: SearchActor, q: string) =>
    (await globalSearch(actor, q)).filter((hit) => hit.kind === 'lot' && hit.id === lotId);

  it('finds it where the cargo STANDS, not only where it was received', async () => {
    // One carton moves to B; C never sees the lot.
    const [last] = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(eq(boxes.lotId, lotId))
      .orderBy(sql`${boxes.seqInLot} DESC`)
      .limit(1);
    await db.update(boxes).set({ currentWarehouseId: W.b }).where(eq(boxes.id, last!.id));
    expect(await lotHits(scoped(W.b), EAN)).toHaveLength(1);
    expect(await lotHits(scoped(W.c), EAN)).toHaveLength(0);
    // The desk that received it always finds what it typed.
    expect(await lotHits(scoped(W.a), EAN)).toHaveLength(1);
  });

  it('finds it riding a truck with an end in the reader’s warehouse', async () => {
    const [truck] = await db
      .insert(batches)
      .values({ code: `FBT${S}`, originWarehouseId: W.a, destWarehouseId: W.c, status: 'in_transit', departedAt: new Date(), createdBy: actorId })
      .returning({ id: batches.id });
    const [moved] = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(and(eq(boxes.lotId, lotId), eq(boxes.currentWarehouseId, W.b)));
    await db
      .update(boxes)
      .set({ currentWarehouseId: null, currentBatchId: truck!.id, status: 'in_transit' })
      .where(eq(boxes.id, moved!.id));
    expect(await lotHits(scoped(W.c), EAN)).toHaveLength(1);
    // Put it back on B's shelf for the next test's world.
    await db
      .update(boxes)
      .set({ currentWarehouseId: W.b, currentBatchId: null, status: 'in_stock' })
      .where(eq(boxes.id, moved!.id));
    await db.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, truck!.id));
  });

  it('answers the UPC reading of the same product, first in the list', async () => {
    const owner: SearchActor = { id: actorId, permissions: new Set(), warehouseScoped: false, warehouseIds: [] };
    const hits = await globalSearch(owner, `000${EAN}`);
    expect(hits.find((hit) => hit.id === lotId)?.label).toContain(`🏷 ${EAN}`);
    expect(hits[0]!.kind).toBe('lot');
  });

  it('is what the /stock search box and its XLSX match', async () => {
    const rows = await db
      .select({ id: receiptLots.id })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .leftJoin(clients, eq(receipts.clientId, clients.id))
      .where(and(eq(boxes.lotId, lotId), stockTextWhere(`0${EAN}`)));
    expect(rows.length).toBeGreaterThan(0);
    // The text half still works, wildcards escaped.
    const none = await db
      .select({ id: receiptLots.id })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .leftJoin(clients, eq(receipts.clientId, clients.id))
      .where(and(eq(boxes.lotId, lotId), stockTextWhere('%')));
    expect(none).toHaveLength(0);
  });
});
