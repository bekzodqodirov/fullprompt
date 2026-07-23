import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  costEntries,
  costTypes,
  notifications,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { sendDailyDigest } from '@/modules/platform/jobs/digest';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { moveReceipt, MoveError } from '@/modules/wms/receipts/move';
import { createCrate, dissolveCrate, resolveCrate, CrateError } from '@/modules/wms/crates/service';
import { setBoxStatus, BoxStatusError } from '@/modules/wms/boxes/status';
import { returnUnclaimedToSender } from '@/modules/wms/unclaimed/return';

/** M2 stock-ops services against a real DB (crates, lost/void, move, return). */

const WH_A = 'MTSTA';
const WH_B = 'MTSTB';
let whAId: string;
let whBId: string;
let actorId: string;
let clientAId: string;
let clientBId: string;
const ctx = () => ({ actorId });

async function makeReceipt(opts: { clientId: string | null; boxCount?: number; marking?: string }) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  // Satisfy the min-1-photo rule with a metadata-only attachment row.
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `itest/${lotId}`,
    fileName: 'itest.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  const result = await confirmReceipt(
    {
      receiptId,
      warehouseId: whAId,
      clientId: opts.clientId,
      unclaimedMarking: opts.marking ?? '',
      lots: [
        {
          id: lotId,
          productNameZh: '测试货',
          boxCount: opts.boxCount ?? 3,
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
  const boxRows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { receiptId, lotId, boxIds: boxRows.map((b) => b.id), result };
}

beforeAll(async () => {
  // Audit rows reference these warehouses across runs (audit_log is
  // append-only), so reuse-or-create instead of delete-and-recreate.
  async function ensureWarehouse(code: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `M2 test WH ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
      .returning();
    return wh!.id;
  }
  whAId = await ensureWarehouse(WH_A);
  whBId = await ensureWarehouse(WH_B);
  const anyUser = await db.select().from(users).limit(1);
  actorId = anyUser[0]!.id;
  const suffix = String(Date.now()).slice(-6);
  const [ca] = await db
    .insert(clients)
    .values({ clientCode: `MA${suffix}`, name: 'M2 test client A' })
    .returning();
  const [cb] = await db
    .insert(clients)
    .values({ clientCode: `MB${suffix}`, name: 'M2 test client B' })
    .returning();
  clientAId = ca!.id;
  clientBId = cb!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('crates', () => {
  it('creates a crate from same-client in-stock boxes, resolves, dissolves', async () => {
    const { boxIds } = await makeReceipt({ clientId: clientAId });
    const crateId = uuidv4();
    const crate = await createCrate(
      { crateId, warehouseId: whAId, boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    expect(crate.code).toMatch(new RegExp(`^CR-${WH_A}\\d{2}-\\d{5}$`));

    const members = await db.select().from(boxes).where(inArray(boxes.id, boxIds));
    expect(members.every((b) => b.crateId === crateId)).toBe(true);
    expect(members.every((b) => b.status === 'in_stock')).toBe(true);

    const resolved = await resolveCrate(crate.code);
    expect(resolved?.members).toHaveLength(boxIds.length);

    // Idempotent create (double-tap)
    const again = await createCrate(
      { crateId, warehouseId: whAId, boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    expect(again.id).toBe(crateId);

    const { boxCount } = await dissolveCrate(crateId, ctx());
    expect(boxCount).toBe(boxIds.length);
    const after = await db.select().from(boxes).where(inArray(boxes.id, boxIds));
    expect(after.every((b) => b.crateId === null)).toBe(true);
  });

  it('records the crating cost against the crate (scope=crate)', async () => {
    await db
      .insert(costTypes)
      .values({ code: 'crating', name: 'Ящик / Yashik' })
      .onConflictDoNothing();
    const { boxIds } = await makeReceipt({ clientId: clientAId });
    const crateId = uuidv4();
    await createCrate(
      {
        crateId,
        warehouseId: whAId,
        boxIds,
        kind: 'yashik',
        logistApproved: true,
        cratingCost: { amount: 150, currency: 'CNY' },
      },
      ctx(),
    );
    const rows = await db.select().from(costEntries).where(eq(costEntries.crateId, crateId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe('crate');
    expect(Number(rows[0]!.amount)).toBe(150);
    expect(rows[0]!.clientId).toBe(clientAId);
  });

  it('rejects cross-client and unclaimed boxes', async () => {
    const a = await makeReceipt({ clientId: clientAId });
    const b = await makeReceipt({ clientId: clientBId });
    await expect(
      createCrate(
        { crateId: uuidv4(), warehouseId: whAId, boxIds: [...a.boxIds, ...b.boxIds], kind: 'yashik', logistApproved: true },
        ctx(),
      ),
    ).rejects.toThrowError(new CrateError('multiple_clients'));

    const u = await makeReceipt({ clientId: null, marking: 'X99' });
    await expect(
      createCrate(
        { crateId: uuidv4(), warehouseId: whAId, boxIds: u.boxIds, kind: 'yashik', logistApproved: true },
        ctx(),
      ),
    ).rejects.toThrowError(new CrateError('unclaimed_not_allowed'));
  });
});

describe('box lost/void/found', () => {
  it('marks lost with reason, then found back to stock; blocks crated boxes', async () => {
    const { boxIds } = await makeReceipt({ clientId: clientAId });
    const target = boxIds[0]!;
    await setBoxStatus({ boxId: target, to: 'lost', reason: 'not found at slot' }, ctx());
    let row = (await db.select().from(boxes).where(eq(boxes.id, target)))[0]!;
    expect(row.status).toBe('lost');
    expect(row.statusReason).toBe('not found at slot');

    await expect(
      setBoxStatus({ boxId: target, to: 'void', reason: 'nope' }, ctx()),
    ).rejects.toThrowError(new BoxStatusError('transition_not_allowed'));

    await setBoxStatus({ boxId: target, to: 'in_stock', reason: 'found behind rack' }, ctx());
    row = (await db.select().from(boxes).where(eq(boxes.id, target)))[0]!;
    expect(row.status).toBe('in_stock');
    expect(row.statusReason).toBeNull();

    const crateId = uuidv4();
    await createCrate(
      { crateId, warehouseId: whAId, boxIds, kind: 'karkas', logistApproved: true },
      ctx(),
    );
    await expect(
      setBoxStatus({ boxId: target, to: 'lost', reason: 'gone' }, ctx()),
    ).rejects.toThrowError(new BoxStatusError('box_in_crate'));
  });
});

describe('receipt move (wrong warehouse fix)', () => {
  it('moves all boxes and the receipt; blocks crated/issued receipts', async () => {
    const { receiptId, boxIds } = await makeReceipt({ clientId: clientAId });
    const { boxCount, toCode } = await moveReceipt(receiptId, whBId, ctx());
    expect(boxCount).toBe(boxIds.length);
    expect(toCode).toBe(WH_B);
    const moved = await db.select().from(boxes).where(inArray(boxes.id, boxIds));
    expect(moved.every((b) => b.currentWarehouseId === whBId)).toBe(true);

    await expect(moveReceipt(receiptId, whBId, ctx())).rejects.toThrowError(
      new MoveError('same_warehouse'),
    );

    const crated = await makeReceipt({ clientId: clientAId });
    await createCrate(
      { crateId: uuidv4(), warehouseId: whAId, boxIds: crated.boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    await expect(moveReceipt(crated.receiptId, whBId, ctx())).rejects.toThrowError(
      new MoveError('box_in_crate'),
    );
  });
});

describe('unclaimed return to sender', () => {
  it('issues all boxes with a handover record; idempotent', async () => {
    const { receiptId, boxIds } = await makeReceipt({ clientId: null, marking: 'R77' });
    const handoverId = uuidv4();
    const handover = await returnUnclaimedToSender(
      { handoverId, receiptId, personName: 'Ali Sender', personPhone: '+998901112233' },
      ctx(),
    );
    expect(handover.personName).toBe('Ali Sender');
    const after = await db.select().from(boxes).where(inArray(boxes.id, boxIds));
    expect(after.every((b) => b.status === 'issued' && b.statusReason === 'returned_to_sender')).toBe(true);

    const again = await returnUnclaimedToSender(
      { handoverId, receiptId, personName: 'Ali Sender', personPhone: '+998901112233' },
      ctx(),
    );
    expect(again.id).toBe(handover.id);
  });

  it('rejects a receipt that has a client', async () => {
    const { receiptId } = await makeReceipt({ clientId: clientAId });
    await expect(
      returnUnclaimedToSender(
        { handoverId: uuidv4(), receiptId, personName: 'X Y', personPhone: '+998900000000' },
        ctx(),
      ),
    ).rejects.toThrow('not_unclaimed');
  });
});

describe('daily digest', () => {
  it('notifies logist/admins about aged unclaimed cargo (evaluated at a future date)', async () => {
    await makeReceipt({ clientId: null, marking: 'DG1' });
    const before = await db.$count(notifications, eq(notifications.type, 'DailyDigest'));
    const future = new Date(Date.now() + 10 * 86_400_000);
    const sent = await sendDailyDigest(future);
    expect(sent).toBe(true);
    const after = await db.$count(notifications, eq(notifications.type, 'DailyDigest'));
    expect(after).toBeGreaterThan(before);
  });
});
