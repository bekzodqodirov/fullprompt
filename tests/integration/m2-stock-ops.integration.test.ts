import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  notifications,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { sendDailyDigest } from '@/modules/platform/jobs/digest';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { confirmReceipt, voidReceipt } from '@/modules/wms/receipts/service';
import { editLot } from '@/modules/wms/receipts/edit';
import { moveReceipt, MoveError } from '@/modules/wms/receipts/move';
import { addCostEntry, recomputeEntry, voidCostEntry } from '@/modules/wms/costing/service';
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

  it('FX-converts and allocates the crating cost the moment the crate is born (round 31)', async () => {
    /**
     * The audit's unanimous find: the entry was inserted and then NOTHING ran
     * — amount_usd stayed NULL, no allocation rows, so the yashik fee reached
     * no tannarx, no client share and no P&L, ever.
     */
    await db.insert(costTypes).values({ code: 'crating', name: 'Ящик / Yashik' }).onConflictDoNothing();
    const { boxIds } = await makeReceipt({ clientId: clientAId, boxCount: 2 });
    const crateId = uuidv4();
    await createCrate(
      {
        crateId,
        warehouseId: whAId,
        boxIds,
        kind: 'yashik',
        logistApproved: true,
        cratingCost: { amount: 100, currency: 'USD' },
      },
      ctx(),
    );
    const [entry] = await db.select().from(costEntries).where(eq(costEntries.crateId, crateId));
    // USD needs no rate row, so the conversion has no excuse to be missing.
    expect(Number(entry!.amountUsd)).toBe(100);
    const shares = await db
      .select()
      .from(costAllocations)
      .where(eq(costAllocations.costEntryId, entry!.id));
    expect(shares).toHaveLength(2);
    expect(shares.reduce((a, s) => a + Number(s.amountUsd), 0)).toBeCloseTo(100, 2);
    expect(shares.every((s) => s.clientId === clientAId)).toBe(true);
  });

  it('the allocations survive the crate’s death (round 31)', async () => {
    /**
     * Recompute used to read the LIVE crate_id pointer, which dissolve/issue
     * clear — so the first FX sweep after the crate's life ended deleted the
     * shares and rebuilt them from an empty membership: money gone, silently.
     * The movement log (`crate_packed`) is what the fee was actually paid for.
     */
    await db.insert(costTypes).values({ code: 'crating', name: 'Ящик / Yashik' }).onConflictDoNothing();
    const { boxIds } = await makeReceipt({ clientId: clientAId, boxCount: 2 });
    const crateId = uuidv4();
    await createCrate(
      {
        crateId,
        warehouseId: whAId,
        boxIds,
        kind: 'yashik',
        logistApproved: true,
        cratingCost: { amount: 80, currency: 'USD' },
      },
      ctx(),
    );
    const [entry] = await db.select().from(costEntries).where(eq(costEntries.crateId, crateId));
    await dissolveCrate(crateId, ctx());
    await recomputeEntry(entry!.id);
    const shares = await db
      .select()
      .from(costAllocations)
      .where(eq(costAllocations.costEntryId, entry!.id));
    expect(shares).toHaveLength(2);
  });

  it('voiding boxes lets go of the crate — receipt void and lot-edit shrink (round 31)', async () => {
    // Receipt void: a crate holding a void ghost member could neither be
    // dissolved nor scanned (both walk members and refuse non-in_stock).
    const a = await makeReceipt({ clientId: clientAId, boxCount: 2 });
    const crateA = uuidv4();
    await createCrate(
      { crateId: crateA, warehouseId: whAId, boxIds: a.boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    await voidReceipt(a.receiptId, 'sinov uchun', ctx());
    const aBoxes = await db.select().from(boxes).where(inArray(boxes.id, a.boxIds));
    expect(aBoxes.every((b) => b.status === 'void' && b.crateId === null)).toBe(true);
    await expect(dissolveCrate(crateA, ctx())).resolves.toMatchObject({ boxCount: 0 });

    // Lot-edit shrink: the voided surplus box must leave the crate the same way.
    const b = await makeReceipt({ clientId: clientAId, boxCount: 3 });
    const crateB = uuidv4();
    await createCrate(
      { crateId: crateB, warehouseId: whAId, boxIds: b.boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    const manager = { id: actorId, permissions: new Set(['receipts.void']) } as unknown as Actor;
    await editLot(
      {
        lotId: b.lotId,
        productNameZh: '测试货',
        boxCount: 2,
        boxLengthCm: 40,
        boxWidthCm: 30,
        boxHeightCm: 20,
        boxWeightKg: 5,
      },
      manager,
      ctx(),
    );
    const bBoxes = await db.select().from(boxes).where(inArray(boxes.id, b.boxIds));
    const ghost = bBoxes.find((x) => x.status === 'void')!;
    expect(ghost.crateId).toBeNull();
    const { boxCount } = await dissolveCrate(crateB, ctx());
    expect(boxCount).toBe(2);
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

describe('a shrink moves the money onto the real boxes', () => {
  it('voided surplus boxes lose their cost shares, live boxes absorb them', async () => {
    const { receiptId, lotId, boxIds } = await makeReceipt({ clientId: clientAId, boxCount: 4 });
    const [type] = await db.select().from(costTypes).where(eq(costTypes.active, true)).limit(1);
    const entry = await addCostEntry(
      {
        scope: 'receipt',
        receiptId,
        costTypeId: type!.id,
        amount: 400,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'boxes',
      },
      ctx(),
    );
    // $100 a box while all four are real.
    const before = await db
      .select()
      .from(costAllocations)
      .where(eq(costAllocations.costEntryId, entry.id));
    expect(before).toHaveLength(4);

    // The loader miscounted: two of the four never existed. Their shares must
    // move onto the two real boxes NOW — the pricing screen reads shares
    // through batch membership a shelf-voided box can never have, so a share
    // left on a phantom box is landed cost the owner prices a trip without.
    const manager = { id: actorId, permissions: new Set(['receipts.edit']) } as unknown as Actor;
    await editLot(
      {
        lotId,
        productNameZh: '测试货',
        boxCount: 2,
        boxLengthCm: 40,
        boxWidthCm: 30,
        boxHeightCm: 20,
        boxWeightKg: 5,
      },
      manager,
      ctx(),
    );
    const after = await db
      .select()
      .from(costAllocations)
      .where(eq(costAllocations.costEntryId, entry.id));
    expect(after).toHaveLength(2);
    const liveIds = new Set(
      (await db.select().from(boxes).where(inArray(boxes.id, boxIds)))
        .filter((b) => b.status === 'in_stock')
        .map((b) => b.id),
    );
    expect(after.every((a) => liveIds.has(a.boxId))).toBe(true);
    // The whole $400 is still allocated — the money was spent on the lot,
    // the miscount changes who carries it, never how much of it exists.
    expect(after.reduce((sum, a) => sum + Number(a.amountUsd), 0)).toBe(400);
  });
});

describe('money first — a prixod with live costs refuses to void', () => {
  it('refuses while a cost stands, allows once finance voided it', async () => {
    const { receiptId } = await makeReceipt({ clientId: clientAId, boxCount: 1 });
    const [type] = await db.select().from(costTypes).where(eq(costTypes.active, true)).limit(1);
    const entry = await addCostEntry(
      {
        scope: 'receipt',
        receiptId,
        costTypeId: type!.id,
        amount: 300,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'weight',
      },
      ctx(),
    );

    // A voided prixod's costs used to stay alive for ever: in the P&L's
    // direct costs, allocated onto the void boxes, and — partner-named — as
    // the firm's standing debt for cargo that officially never existed.
    // The batch-cancel rule (#288) applies here too: money first.
    await expect(voidReceipt(receiptId, 'dublikat', ctx())).rejects.toMatchObject({
      code: 'receipt_has_costs',
    });
    const [still] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(still!.voidedAt).toBeNull();

    await voidCostEntry(entry.id, 'prixod bekor bolyapti', ctx());
    await voidReceipt(receiptId, 'dublikat', ctx());
    const [gone] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(gone!.voidedAt).not.toBeNull();
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
