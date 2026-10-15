import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  crates,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { crateStock } from '@/modules/wms/inventory/service';

/**
 * The yashik layer of /stock (round 107, item 6): one row per active crate
 * with cargo standing HERE, contents as a share of the lot, and the
 * screen-only overflow flag.
 *
 * The fixture deliberately holds round 31's teleport case — a short-loaded
 * member that kept its crateId while standing at ANOTHER warehouse — because
 * the bare `boxes.crate_id` join was the trap the design review named: it
 * counts a carton in Yiwu into a Tashkent row.
 */

const SUFFIX = String(Date.now()).slice(-6);
let actorId: string;
let whA: string;
let whB: string;
let clientId: string;
let crateFull: string;
let crateBare: string;
let crateEmpty: string;
let crateGone: string;
const madeBoxes: string[] = [];

const UNSCOPED = { warehouseScoped: false, warehouseIds: [] as string[] };

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  const wh = (over: { code: string; batchPrefix: string }): typeof warehouses.$inferInsert => ({
    name: `Yashik sklad ${SUFFIX}`,
    country: 'CN',
    type: 'origin',
    timezone: 'Asia/Shanghai',
    ...over,
  });
  whA = (
    await db
      .insert(warehouses)
      .values(wh({ code: `ZA${SUFFIX}`, batchPrefix: `ZA${SUFFIX}` }))
      .returning({ id: warehouses.id })
  )[0]!.id;
  whB = (
    await db
      .insert(warehouses)
      .values(wh({ code: `ZB${SUFFIX}`, batchPrefix: `ZB${SUFFIX}` }))
      .returning({ id: warehouses.id })
  )[0]!.id;
  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `ZY${SUFFIX}`, name: `Yashik mijoz ${SUFFIX}` })
      .returning({ id: clients.id })
  )[0]!.id;

  const receiptId = (
    await db
      .insert(receipts)
      .values({ warehouseId: whA, clientId, status: 'confirmed', createdBy: actorId })
      .returning({ id: receipts.id })
  )[0]!.id;
  // 10 boxes, 1 m³ and 10 kg each — the share arithmetic stays legible.
  const lotId = (
    await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        productNameZh: `货${SUFFIX}`,
        boxCount: 10,
        dimsMode: 'mixed',
        totalWeightKg: '100',
        totalVolumeM3: '10',
      })
      .returning({ id: receiptLots.id })
  )[0]!.id;

  const mintCrate = async (over: Record<string, unknown>) =>
    (
      await db
        .insert(crates)
        .values({
          warehouseId: whA,
          clientId,
          createdBy: actorId,
          status: 'active',
          ...over,
        } as typeof crates.$inferInsert)
        .returning({ id: crates.id })
    )[0]!.id;

  // Stated 1 m³ / 500 kg; contents will be 4 m³ / 40 kg → over by volume only.
  crateFull = await mintCrate({
    code: `CR-ZZ${SUFFIX}-1`,
    lengthCm: 100,
    widthCm: 100,
    heightCm: 100,
    weightKg: '500',
  });
  crateBare = await mintCrate({ code: `CR-ZZ${SUFFIX}-2` });
  crateEmpty = await mintCrate({ code: `CR-ZZ${SUFFIX}-3` });
  crateGone = await mintCrate({ code: `CR-ZZ${SUFFIX}-4`, status: 'dissolved' });

  const box = (seq: number, over: Record<string, unknown>) => ({
    lotId,
    shortCode: `ZZC${SUFFIX}${seq}`,
    seqInLot: seq,
    currentWarehouseId: whA,
    ...over,
  });
  const rows = await db
    .insert(boxes)
    .values([
      // Present members, across the stock page's own statuses.
      box(1, { crateId: crateFull, status: 'in_stock' }),
      box(2, { crateId: crateFull, status: 'planned' }),
      box(3, { crateId: crateFull, status: 'loading' }),
      box(4, { crateId: crateFull, status: 'ready_for_pickup' }),
      // Round 31's teleport: kept its crateId, stands at the OTHER warehouse.
      box(5, { crateId: crateFull, status: 'in_stock', currentWarehouseId: whB }),
      // Issued cargo is gone from the shelf, crate pointer or not.
      box(6, { crateId: crateFull, status: 'issued' }),
      // The unmeasured crate holds one carton.
      box(7, { crateId: crateBare, status: 'in_stock' }),
    ] as (typeof boxes.$inferInsert)[])
    .returning({ id: boxes.id });
  madeBoxes.push(...rows.map((row) => row.id));
});

afterAll(async () => {
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  await db
    .delete(crates)
    .where(inArray(crates.id, [crateFull, crateBare, crateEmpty, crateGone]));
  const lots = await db
    .select({ id: receiptLots.id, receiptId: receiptLots.receiptId })
    .from(receiptLots)
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(eq(receipts.clientId, clientId));
  if (lots.length) {
    await db.delete(receiptLots).where(inArray(receiptLots.id, lots.map((l) => l.id)));
    await db.delete(receipts).where(inArray(receipts.id, lots.map((l) => l.receiptId)));
  }
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(warehouses).where(inArray(warehouses.id, [whA, whB]));
  await pgClient.end();
});

describe('crateStock', () => {
  it('counts only members standing WHERE THE CRATE IS, as a share of the lot', async () => {
    const { rows } = await crateStock(UNSCOPED, whA);
    const full = rows.find((row) => row.id === crateFull);
    expect(full, 'the measured crate must be a row').toBeDefined();
    // 4 present members — the teleported box (wh B) and the issued one are
    // not «ichida» however loudly their crate_id claims it.
    expect(full!.boxCount).toBe(4);
    expect(full!.m3).toBe(4);
    expect(full!.kg).toBe(40);
    expect(full!.clientCode).toBe(`ZY${SUFFIX}`);
  });

  it('flags overflow against the measured size, only where a measure exists', async () => {
    const { rows } = await crateStock(UNSCOPED, whA);
    const full = rows.find((row) => row.id === crateFull)!;
    // 4 m³ of contents in a stated 1 m³ box — the owner's warning, screen-only.
    expect(full.statedM3).toBe(1);
    expect(full.over).toBe(true);
    const bare = rows.find((row) => row.id === crateBare)!;
    expect(bare.statedM3).toBeNull();
    expect(bare.statedKg).toBeNull();
    expect(bare.over).toBe(false);
  });

  it('a zero measure reads as unmeasured, never as a permanent ⚠', async () => {
    // The crate EDIT path can store 0 (no min on update) — a 0 m³ «size»
    // must not flag every carton inside as overflow.
    await db
      .update(crates)
      .set({ lengthCm: 0, weightKg: '0' })
      .where(eq(crates.id, crateFull));
    const { rows } = await crateStock(UNSCOPED, whA);
    const full = rows.find((row) => row.id === crateFull)!;
    expect(full.statedM3).toBeNull();
    expect(full.statedKg).toBeNull();
    expect(full.over).toBe(false);
    await db
      .update(crates)
      .set({ lengthCm: 100, weightKg: '500' })
      .where(eq(crates.id, crateFull));
  });

  it('an empty crate and a dissolved one produce no row', async () => {
    const { rows } = await crateStock(UNSCOPED, whA);
    expect(rows.some((row) => row.id === crateEmpty)).toBe(false);
    expect(rows.some((row) => row.id === crateGone)).toBe(false);
  });

  it('honors the wh filter and treats a malformed one as absent', async () => {
    const atB = await crateStock(UNSCOPED, whB);
    expect(atB.rows.some((row) => row.id === crateFull)).toBe(false);
    // «5..» must behave exactly like no filter — never a 22P02 error page.
    // Compared against the UNFILTERED answer, not against our own row: the
    // unfiltered list is shared and capped, so on a long-lived database our
    // fixture may legitimately fall past the cap (#713's rule).
    const garbage = await crateStock(UNSCOPED, '5..');
    const unfiltered = await crateStock(UNSCOPED);
    expect(garbage.rows.map((row) => row.id)).toEqual(unfiltered.rows.map((row) => row.id));
  });

  it('a scoped actor sees only their warehouses’ crates — and none with none', async () => {
    const foreign = await crateStock({ warehouseScoped: true, warehouseIds: [whB] });
    expect(foreign.rows.some((row) => row.id === crateFull)).toBe(false);
    const own = await crateStock({ warehouseScoped: true, warehouseIds: [whA] });
    expect(own.rows.some((row) => row.id === crateFull)).toBe(true);
    const nobody = await crateStock({ warehouseScoped: true, warehouseIds: [] });
    expect(nobody.rows).toHaveLength(0);
  });
});
