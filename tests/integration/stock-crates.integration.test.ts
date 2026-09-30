import 'dotenv/config';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
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
import { crateCodesForLot, crateContents, stockCrates } from '@/modules/wms/inventory/stock-crates';
import { stockBoxFilter, stockTextWhere } from '@/modules/wms/inventory/stock-filter';
import { placesOf, rowKey } from '@/modules/wms/inventory/crate-grouping';

/**
 * The crates a /stock row stands in (owner, 2026-09-30, his «B»): the row
 * stays one lot at one warehouse and says «🧰 N yashik», opening to the
 * crates; the Σ gains «N mesta» — loose cartons plus crates, a crate being
 * one piece to the skladchi counting the shelf.
 *
 * The fixture carries every case the membership rule exists for:
 *  · round 31's teleport — a member that kept its crate_id while standing at
 *    ANOTHER warehouse (it is LOOSE where it stands, never inside);
 *  · an issued member (not on the shelf at all);
 *  · the four shelf statuses inside one crate;
 *  · a MIXED crate holding two lots, so exactly one row may count it;
 *  · an empty crate and a dissolved one (no row, no place).
 */

const SUFFIX = String(Date.now()).slice(-6);
let actorId: string;
let whA: string;
let whB: string;
let clientId: string;
let receiptId: string;
let lotA: string;
let lotB: string;
let crateFull: string;
let crateMixed: string;
let crateEmpty: string;
let crateGone: string;
const madeBoxes: string[] = [];

const UNSCOPED = { warehouseScoped: false, warehouseIds: [] as string[] };
const PRODUCT_A = `Yashikgoods${SUFFIX}`;
const PRODUCT_B = `Boshqagoods${SUFFIX}`;

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
  receiptId = (
    await db
      .insert(receipts)
      .values({ warehouseId: whA, clientId, status: 'confirmed', createdBy: actorId })
      .returning({ id: receipts.id })
  )[0]!.id;
  const lot = async (seq: number, letter: string, name: string, count: number) =>
    (
      await db
        .insert(receiptLots)
        .values({
          receiptId,
          seq,
          letter,
          productNameZh: name,
          boxCount: count,
          dimsMode: 'mixed',
          // 1 m³ and 10 kg a carton — the share arithmetic stays legible.
          totalWeightKg: String(count * 10),
          totalVolumeM3: String(count),
        })
        .returning({ id: receiptLots.id })
    )[0]!.id;
  lotA = await lot(1, 'A', PRODUCT_A, 10);
  lotB = await lot(2, 'B', PRODUCT_B, 3);

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
  // Stated 1 m³ / 500 kg; its contents will be 4 m³ / 40 kg → over by volume.
  crateFull = await mintCrate({
    code: `CR-ZZ${SUFFIX}-1`,
    lengthCm: 100,
    widthCm: 100,
    heightCm: 100,
    weightKg: '500',
  });
  crateMixed = await mintCrate({ code: `CR-ZZ${SUFFIX}-2`, kind: 'palet' });
  crateEmpty = await mintCrate({ code: `CR-ZZ${SUFFIX}-3` });
  crateGone = await mintCrate({ code: `CR-ZZ${SUFFIX}-4`, status: 'dissolved' });

  const box = (lotId: string, seq: number, over: Record<string, unknown>) => ({
    lotId,
    shortCode: `ZZ${lotId === lotA ? 'A' : 'B'}${SUFFIX}${seq}`,
    seqInLot: seq,
    currentWarehouseId: whA,
    status: 'in_stock',
    ...over,
  });
  const rows = await db
    .insert(boxes)
    .values([
      // Lot A: four members inside the measured crate, across the shelf statuses…
      box(lotA, 1, { crateId: crateFull }),
      box(lotA, 2, { crateId: crateFull, status: 'planned' }),
      box(lotA, 3, { crateId: crateFull, status: 'loading' }),
      box(lotA, 4, { crateId: crateFull, status: 'ready_for_pickup' }),
      // …round 31's teleport: kept its crate_id, stands at the OTHER warehouse…
      box(lotA, 5, { crateId: crateFull, currentWarehouseId: whB }),
      // …an issued member is off the shelf whatever its pointer says…
      box(lotA, 6, { crateId: crateFull, status: 'issued', currentWarehouseId: null }),
      // …one carton in the mixed crate, and three loose.
      box(lotA, 7, { crateId: crateMixed }),
      box(lotA, 8, {}),
      box(lotA, 9, {}),
      box(lotA, 10, {}),
      // Lot B: two in the mixed crate (the majority → B's row owns it), one loose.
      box(lotB, 1, { crateId: crateMixed }),
      box(lotB, 2, { crateId: crateMixed }),
      box(lotB, 3, {}),
    ] as (typeof boxes.$inferInsert)[])
    .returning({ id: boxes.id });
  madeBoxes.push(...rows.map((row) => row.id));
});

afterAll(async () => {
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  await db.delete(crates).where(inArray(crates.id, [crateFull, crateMixed, crateEmpty, crateGone]));
  await db.delete(receiptLots).where(inArray(receiptLots.id, [lotA, lotB]));
  await db.delete(receipts).where(eq(receipts.id, receiptId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(warehouses).where(inArray(warehouses.id, [whA, whB]));
  await pgClient.end();
});

/** The client's own cartons only — the shared database holds other fixtures. */
const own = (filters: SQL[]) => [...filters, eq(receipts.clientId, clientId)];

/** The table's row counts, by the page's own grouping, for the same filter. */
async function rowCounts(filters: SQL[]): Promise<Map<string, number>> {
  const rows = await db
    .select({
      lotId: receiptLots.id,
      whId: warehouses.id,
      n: sql<number>`count(*)::int`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(and(...filters))
    .groupBy(receiptLots.id, warehouses.id);
  return new Map(rows.map((row) => [rowKey(row.lotId, row.whId), Number(row.n)]));
}

describe('stockCrates — the crates a stock row stands in', () => {
  it('counts only members standing WHERE THE CRATE IS', async () => {
    const result = await stockCrates(own(stockBoxFilter(UNSCOPED, { wh: whA })), {
      narrowed: false,
    });
    const rowA = result.byRow.get(rowKey(lotA, whA))!;
    expect(rowA, 'lot A at A holds crated cartons').toBeDefined();
    const full = rowA.crates.find((crate) => crate.id === crateFull)!;
    // 1-4 are inside; the teleported 5 (at B) and the issued 6 are not.
    expect(full.n).toBe(4);
    expect(full.seqs).toEqual([1, 2, 3, 4]);
    expect(full.total).toBe(4);
    expect(rowA.crated).toBe(5);
  });

  it('a mixed crate is ONE place, counted by the lot with most cartons inside', async () => {
    const result = await stockCrates(own(stockBoxFilter(UNSCOPED, { wh: whA })), {
      narrowed: false,
    });
    const rowA = result.byRow.get(rowKey(lotA, whA))!;
    const rowB = result.byRow.get(rowKey(lotB, whA))!;
    const mixedInA = rowA.crates.find((crate) => crate.id === crateMixed)!;
    const mixedInB = rowB.crates.find((crate) => crate.id === crateMixed)!;
    expect(mixedInA.owned).toBe(false);
    expect(mixedInB.owned).toBe(true);
    // Each row names the other contents, and the row that does not count it
    // says where it IS counted — the paper and the shelf agree on one piece.
    expect(mixedInA.ownerCode).toBe(`ZY${SUFFIX}-B`);
    expect(mixedInA.others).toEqual([{ code: `ZY${SUFFIX}-B`, n: 2 }]);
    expect(mixedInB.others).toEqual([{ code: `ZY${SUFFIX}-A`, n: 1 }]);
    expect(mixedInB.kind).toBe('palet');
    // Nothing hidden: both rows are in the result, so no «n/total» is due.
    expect(mixedInA.unseen).toBe(0);
    expect(mixedInB.unseen).toBe(0);
    expect(rowA.owned).toBe(1);
    expect(rowB.owned).toBe(1);
  });

  it('partition: rows add up to the Σ, cartons and places alike', async () => {
    const filters = own(stockBoxFilter(UNSCOPED, { wh: whA }));
    const result = await stockCrates(filters, { narrowed: false });
    const counts = await rowCounts(filters);
    // A: 1-4, 7, 8-10 = 8 on the shelf here; B: 3.
    expect(counts.get(rowKey(lotA, whA))).toBe(8);
    expect(counts.get(rowKey(lotB, whA))).toBe(3);
    const cartons = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const places = [...counts].reduce(
      (sum, [key, n]) => sum + placesOf(n, result.byRow.get(key)),
      0,
    );
    // A = crate 1 + 3 loose = 4 places; B = the mixed crate + 1 loose = 2.
    expect(placesOf(8, result.byRow.get(rowKey(lotA, whA)))).toBe(4);
    expect(placesOf(3, result.byRow.get(rowKey(lotB, whA)))).toBe(2);
    // The Σ's own arithmetic, from the result alone, equals the rows' sum.
    expect(cartons - result.crated + result.crates.length).toBe(places);
    expect(places).toBe(6);
  });

  it('the teleported member is LOOSE where it stands — never lost, never inside', async () => {
    const filters = own(stockBoxFilter(UNSCOPED, { wh: whB }));
    const result = await stockCrates(filters, { narrowed: false });
    expect(result.byRow.size).toBe(0);
    const counts = await rowCounts(filters);
    expect(counts.get(rowKey(lotA, whB))).toBe(1);
    expect(placesOf(1, result.byRow.get(rowKey(lotA, whB)))).toBe(1);
  });

  it('flags overflow against the measured size, only where a measure exists', async () => {
    const result = await stockCrates(own(stockBoxFilter(UNSCOPED, { wh: whA })), {
      narrowed: false,
    });
    const full = result.byRow.get(rowKey(lotA, whA))!.crates.find((c) => c.id === crateFull)!;
    // 4 m³ of goods in a stated 1 m³ crate.
    expect(full.statedM3).toBe(1);
    expect(full.statedKg).toBe(500);
    expect(full.over).toBe(true);
    expect(result.crates.find((c) => c.id === crateFull)?.over).toBe(true);
    const mixed = result.byRow.get(rowKey(lotB, whA))!.crates.find((c) => c.id === crateMixed)!;
    expect(mixed.statedM3).toBeNull();
    expect(mixed.statedKg).toBeNull();
    expect(mixed.over).toBe(false);
  });

  it('a zero measure reads as unmeasured, never as a permanent ⚠', async () => {
    await db.update(crates).set({ lengthCm: 0, weightKg: '0' }).where(eq(crates.id, crateFull));
    try {
      const result = await stockCrates(own(stockBoxFilter(UNSCOPED, { wh: whA })), {
        narrowed: false,
      });
      const full = result.byRow.get(rowKey(lotA, whA))!.crates.find((c) => c.id === crateFull)!;
      expect(full.statedM3).toBeNull();
      expect(full.statedKg).toBeNull();
      expect(full.over).toBe(false);
    } finally {
      await db
        .update(crates)
        .set({ lengthCm: 100, weightKg: '500' })
        .where(eq(crates.id, crateFull));
    }
  });

  it('an empty crate and a dissolved one are no row and no place', async () => {
    const result = await stockCrates(own(stockBoxFilter(UNSCOPED, { wh: whA })), {
      narrowed: false,
    });
    const ids = result.crates.map((crate) => crate.id);
    expect(ids).not.toContain(crateEmpty);
    expect(ids).not.toContain(crateGone);
    expect(ids.sort()).toEqual([crateFull, crateMixed].sort());
  });

  it('a search narrows the crates with the rows — and the ⚠ stays the whole crate’s', async () => {
    const filters = [...own(stockBoxFilter(UNSCOPED, { wh: whA })), stockTextWhere(PRODUCT_A)];
    // Measure the mixed crate at 2 m³: its three cartons (3 m³) overflow it,
    // while the ONE carton this search shows (1 m³) alone would not.
    await db
      .update(crates)
      .set({ lengthCm: 200, widthCm: 100, heightCm: 100 })
      .where(eq(crates.id, crateMixed));
    try {
      const result = await stockCrates(filters, { narrowed: true });
      expect(result.byRow.has(rowKey(lotB, whA))).toBe(false);
      const rowA = result.byRow.get(rowKey(lotA, whA))!;
      const mixed = rowA.crates.find((crate) => crate.id === crateMixed)!;
      // Only A's carton matches, so A counts the crate here — one place still.
      expect(mixed.n).toBe(1);
      expect(mixed.total).toBe(3);
      expect(mixed.unseen).toBe(2);
      expect(mixed.owned).toBe(true);
      // An overfull crate does not stop being overfull because somebody
      // searched one of its lots.
      expect(mixed.statedM3).toBe(2);
      expect(mixed.over).toBe(true);
      expect(result.crates.find((crate) => crate.id === crateMixed)?.over).toBe(true);
      const counts = await rowCounts(filters);
      const cartons = [...counts.values()].reduce((sum, n) => sum + n, 0);
      const places = [...counts].reduce(
        (sum, [key, n]) => sum + placesOf(n, result.byRow.get(key)),
        0,
      );
      expect(cartons - result.crated + result.crates.length).toBe(places);
    } finally {
      await db
        .update(crates)
        .set({ lengthCm: null, widthCm: null, heightCm: null })
        .where(eq(crates.id, crateMixed));
    }
  });

  it('the CR- code printed on a crate finds exactly its cartons', async () => {
    const filters = [
      ...own(stockBoxFilter(UNSCOPED, { wh: whA })),
      stockTextWhere(`CR-ZZ${SUFFIX}-1`),
    ];
    const counts = await rowCounts(filters);
    expect([...counts.values()]).toEqual([4]);
    const result = await stockCrates(filters, { narrowed: true });
    expect(result.crates.map((crate) => crate.id)).toEqual([crateFull]);
    expect(result.crated).toBe(4);
  });

  it('honors the wh filter and treats a malformed one as absent', async () => {
    const atB = await stockCrates(own(stockBoxFilter(UNSCOPED, { wh: whB })), { narrowed: false });
    expect(atB.crates).toHaveLength(0);
    // «5..» behaves exactly like no filter — never a 22P02 error page.
    const garbage = await stockCrates(own(stockBoxFilter(UNSCOPED, { wh: '5..' })), {
      narrowed: false,
    });
    const unfiltered = await stockCrates(own(stockBoxFilter(UNSCOPED, {})), { narrowed: false });
    expect(garbage.crates.map((c) => c.id)).toEqual(unfiltered.crates.map((c) => c.id));
    expect(unfiltered.crates.map((c) => c.id).sort()).toEqual([crateFull, crateMixed].sort());
  });

  it('a scoped actor sees only their warehouses’ crates — and none with none', async () => {
    const foreign = await stockCrates(
      own(stockBoxFilter({ warehouseScoped: true, warehouseIds: [whB] }, {})),
      { narrowed: false },
    );
    expect(foreign.crates).toHaveLength(0);
    const mine = await stockCrates(
      own(stockBoxFilter({ warehouseScoped: true, warehouseIds: [whA] }, {})),
      { narrowed: false },
    );
    expect(mine.crates.map((c) => c.id).sort()).toEqual([crateFull, crateMixed].sort());
    const nobody = await stockCrates(
      own(stockBoxFilter({ warehouseScoped: true, warehouseIds: [] }, {})),
      { narrowed: false },
    );
    expect(nobody.crates).toHaveLength(0);
  });
});

describe('crateContents — one crate opened, carton by carton', () => {
  it('lists the cartons standing in it, grouped by lot, and counts the rest as away', async () => {
    const opened = await crateContents(UNSCOPED, crateFull);
    expect(opened).not.toBeNull();
    expect(opened!.code).toBe(`CR-ZZ${SUFFIX}-1`);
    expect(opened!.lots).toHaveLength(1);
    expect(opened!.lots[0]!.cartons.map((carton) => carton.seqInLot)).toEqual([1, 2, 3, 4]);
    // The teleported 5 is away; the issued 6 no longer points at the crate in
    // production (issue clears it) but in this fixture it still does — away too.
    expect(opened!.away).toBe(2);
    expect(opened!.m3).toBe(4);
    expect(opened!.over).toBe(true);
  });

  it('a mixed crate opens to both lots', async () => {
    const opened = await crateContents(UNSCOPED, crateMixed);
    expect(opened!.lots.map((lot) => [lot.lotCode, lot.cartons.length])).toEqual([
      [`ZY${SUFFIX}-A`, 1],
      [`ZY${SUFFIX}-B`, 2],
    ]);
  });

  it('is scoped like the stock screen — out of scope is nothing', async () => {
    expect(
      await crateContents({ warehouseScoped: true, warehouseIds: [whB] }, crateFull),
    ).toBeNull();
    expect(
      await crateContents({ warehouseScoped: true, warehouseIds: [whA] }, crateFull),
    ).not.toBeNull();
  });
});

describe('crateCodesForLot — the lot drill-down’s chips', () => {
  it('names the crate only for cartons standing in it', async () => {
    const codes = await crateCodesForLot(lotA);
    const bySeq = new Map<number, string | undefined>();
    const rows = await db
      .select({ id: boxes.id, seq: boxes.seqInLot })
      .from(boxes)
      .where(eq(boxes.lotId, lotA));
    for (const row of rows) bySeq.set(row.seq, codes.get(row.id));
    expect(bySeq.get(1)).toBe(`CR-ZZ${SUFFIX}-1`);
    expect(bySeq.get(7)).toBe(`CR-ZZ${SUFFIX}-2`);
    // The teleported carton wears no chip for a crate standing elsewhere.
    expect(bySeq.get(5)).toBeUndefined();
    expect(bySeq.get(8)).toBeUndefined();
  });
});
