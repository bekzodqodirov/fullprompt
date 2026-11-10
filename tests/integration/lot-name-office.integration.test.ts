import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  dealStages,
  deals,
  handovers,
  lotCompositionLines,
  lotCompositions,
  receiptLots,
  receipts,
  scanEvents,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { splitLabelCount } from '@/modules/platform/text/label-count';
import { MAX_BUTTON_CHARS } from '@/modules/platform/telegram/limits';
import { cargoMessages, photoButtonRows, photoCaption, productName } from '@/modules/wms/client-cabinet/bot-text';
import { cabinetMap } from '@/modules/wms/client-cabinet/map';
import { cargoOverview, issuedHandovers } from '@/modules/wms/client-cabinet/service';
import { lotIdentityOf } from '@/modules/wms/costing/freight-split';
import { boxMeasures } from '@/modules/wms/costing/service';
import { clientFeed } from '@/modules/wms/crm/feed';
import { dealCargoLabel } from '@/modules/wms/deals/cargo-label';
import { dealById, dealCargoFor, unlinkedReceipts } from '@/modules/wms/deals/service';
import { actRowText, buildHandoverAct, handoverActRows } from '@/modules/wms/documents/handover-act';
import { buildManifestXlsx } from '@/modules/wms/documents/manifest-xlsx';
import { lostCargoForClient } from '@/modules/wms/finance/compensation';
import { GATE_OFF, unpricedReceiptsOn } from '@/modules/wms/finance/unpriced';
import { uncollectedCargo } from '@/modules/wms/issue/waiting';
import { arrivedSummary } from '@/modules/wms/notices/arrival';
import { issuedFacts, receivedFacts } from '@/modules/wms/notices/client-summary';
import { PUSH_NAME_CHARS, lotLines } from '@/modules/wms/notices/client-text';
import { receiptFacts } from '@/modules/wms/pickups/double-received';
import { clientHistory, landedCostByLot, stockAging } from '@/modules/wms/reports/queries';
import { buildClientHistoryXlsx, buildLandedCostXlsx, buildStockAgingXlsx } from '@/modules/wms/reports/xlsx';
import { receiveStamped, removeStamped } from '../fixtures/stamped-cargo';

/**
 * The name a lot is SHOWN under, on the office's lists and the customer's
 * surfaces (the owner's items 3-4, 2026-11-10; docs/TARKIB-TUZATISH.md §3,
 * §9.2): while a tarkib stands every one of these readers prints the tarkib's
 * name — one line → its name, several → «first +N» — and the two lists that
 * already count goods print ONE number, never «Клавиатура +2 +1».
 *
 * Each reader is called through its own exported function, never a restated
 * query (#166): no existing test seeds a tarkib and reads it back through a
 * list, so until this file a reader swapped back to the stored column stayed
 * green everywhere. The stored column itself must not move — the papers, the
 * memory and the sticker read it as the lot's identity — and a lot with no
 * tarkib must read exactly as it did.
 *
 * The cargo is written straight to the tables (`receiveStamped`, the kernel
 * test's own shape); the writers' rules are proven in lot-composition.integration.
 */

const RUN = String(Date.now()).slice(-6);
/**
 * ONE instant for the landings and for the list's «today»: read twice, a run
 * that crosses Tashkent's midnight between the fixture and the assertion
 * counts a day more (R5 — a test's clock must be the app's).
 */
const NOW = Date.now();
const DAY = 86_400_000;
const THREE = ['Клавиатура', 'Мышь', 'Наушники'];
const LABEL = 'Клавиатура +2';
const ZH = `键盘${RUN}`;
const PLAIN_RU = `Шнур ${RUN}`;
/** A tarkib's names are invoice wording — long by nature. 102 characters, one space. */
const LONG_FIRST = `Клавиатура ${'проводная-мембранная-'.repeat(4)}игровая`;
const LONG_LABEL = `${LONG_FIRST} +2`;

let actorId = '';
let clientId = '';
let clientCode = '';
/** A warehouse that hands cargo to clients — where the waiting cargo stands. */
let whUz = { id: '', code: '' };
/** A Chinese warehouse, for the cargo that is nobody's «uncollected». */
let whCn = { id: '', code: '' };
let dealMixed = '';
let dealOne = '';
let handoverId = '';
let costEntryId = '';
const batchId = uuidv4();
const batchCode = `LN${RUN}-T`;

interface Lot {
  receiptId: string;
  lotId: string;
  boxIds: string[];
}
const lot: Record<'three' | 'plain' | 'swapped' | 'long' | 'handed' | 'lost', Lot> = {
  three: { receiptId: '', lotId: '', boxIds: [] },
  plain: { receiptId: '', lotId: '', boxIds: [] },
  swapped: { receiptId: '', lotId: '', boxIds: [] },
  long: { receiptId: '', lotId: '', boxIds: [] },
  handed: { receiptId: '', lotId: '', boxIds: [] },
  lost: { receiptId: '', lotId: '', boxIds: [] },
};

async function mint(input: {
  letter: string;
  zh: string;
  ru: string | null;
  boxes: number;
  dealId?: string;
  warehouseId: string;
  status: 'in_stock' | 'ready_for_pickup' | 'issued';
}): Promise<Lot> {
  const made = await receiveStamped({
    clientId,
    actorId,
    sellerId: null,
    m3: 0.6,
    kg: 60,
    boxes: input.boxes,
    dealId: input.dealId ?? null,
  });
  await db.update(receipts).set({ warehouseId: input.warehouseId }).where(eq(receipts.id, made.receiptId));
  await db
    .update(receiptLots)
    .set({ letter: input.letter, productNameZh: input.zh, productNameRu: input.ru })
    .where(eq(receiptLots.id, made.lotId));
  await db
    .update(boxes)
    .set({ status: input.status, currentWarehouseId: input.status === 'issued' ? null : input.warehouseId })
    .where(inArray(boxes.id, made.boxIds));
  return made;
}

async function compose(lotId: string, names: readonly string[]): Promise<void> {
  await db.insert(lotCompositions).values({ lotId, seenBoxCount: 1, savedBy: actorId });
  await db
    .insert(lotCompositionLines)
    .values(names.map((name, i) => ({ lotId, seq: i + 1, name, weightKg: '1.000', volumeM3: '0.1000' })));
}

/** A truck landed these cartons at `whUz` — what makes them «arrived» and dates how long they wait. */
async function land(boxIds: string[], at: Date): Promise<void> {
  await db.insert(boxMovements).values(
    boxIds.map((boxId) => ({
      boxId,
      fromWarehouseId: whCn.id,
      toWarehouseId: whUz.id,
      fromStatus: 'in_transit',
      toStatus: 'ready_for_pickup',
      cause: 'unload_scan',
      refType: 'batch',
      refId: batchId,
      actorId,
      createdAt: at,
    })),
  );
}

/** Every string cell of a built workbook, sheet by sheet — what a person opening the file reads. */
async function cellsOf(file: Buffer): Promise<string[][]> {
  const book = new ExcelJS.Workbook();
  // exceljs' own typing wants a Node `Buffer` of the pre-generic kind.
  await book.xlsx.load(file as unknown as ArrayBuffer);
  return book.worksheets.map((sheet) => {
    const cells: string[] = [];
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (typeof cell.value === 'string') cells.push(cell.value);
      }),
    );
    return cells;
  });
}

const storedRu = async (lotId: string) =>
  (await db.select({ ru: receiptLots.productNameRu }).from(receiptLots).where(eq(receiptLots.id, lotId)))[0]!.ru;

beforeAll(async () => {
  const [u] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1);
  actorId = u!.id;
  const [uz] = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .where(and(eq(warehouses.issuesToClients, true), eq(warehouses.active, true), eq(warehouses.country, 'UZ')))
    .orderBy(asc(warehouses.code))
    .limit(1);
  const [cn] = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .where(and(eq(warehouses.issuesToClients, false), eq(warehouses.active, true), eq(warehouses.country, 'CN')))
    .orderBy(asc(warehouses.code))
    .limit(1);
  whUz = uz!;
  whCn = cn!;

  clientCode = `LN${RUN}`;
  const [c] = await db
    .insert(clients)
    .values({ clientCode, name: `Lot name ${RUN}`, phones: [`+99893${RUN}7`] })
    .returning({ id: clients.id });
  clientId = c!.id;

  const [stage] = await db.select({ id: dealStages.id }).from(dealStages).orderBy(asc(dealStages.sortOrder)).limit(1);
  const madeDeals = await db
    .insert(deals)
    .values([
      { code: `LN${RUN}-M`, clientId, stageId: stage!.id, title: `Lot name mixed ${RUN}`, createdBy: actorId },
      { code: `LN${RUN}-O`, clientId, stageId: stage!.id, title: `Lot name one ${RUN}`, createdBy: actorId },
    ])
    .returning({ id: deals.id, code: deals.code });
  dealMixed = madeDeals.find((d) => d.code.endsWith('-M'))!.id;
  dealOne = madeDeals.find((d) => d.code.endsWith('-O'))!.id;

  // Waiting in Uzbekistan, on one deal: three goods in one lot, and a plain lot.
  lot.three = await mint({ letter: 'A', zh: ZH, ru: 'клавиатура', boxes: 3, dealId: dealMixed, warehouseId: whUz.id, status: 'ready_for_pickup' });
  lot.plain = await mint({ letter: 'B', zh: `线${RUN}`, ru: PLAIN_RU, boxes: 2, dealId: dealMixed, warehouseId: whUz.id, status: 'ready_for_pickup' });
  // Still in China: a tarkib whose FIRST line is not the alphabetically first, and one with a long first name.
  lot.swapped = await mint({ letter: 'C', zh: `鼠标${RUN}`, ru: null, boxes: 1, dealId: dealOne, warehouseId: whCn.id, status: 'in_stock' });
  lot.long = await mint({ letter: 'D', zh: `长${RUN}`, ru: 'клавиатура', boxes: 1, warehouseId: whCn.id, status: 'in_stock' });
  // Already collected, and one with a carton lost on the way.
  lot.handed = await mint({ letter: 'E', zh: ZH, ru: 'клавиатура', boxes: 2, warehouseId: whUz.id, status: 'issued' });
  lot.lost = await mint({ letter: 'F', zh: ZH, ru: 'клавиатура', boxes: 2, warehouseId: whCn.id, status: 'in_stock' });
  await db.update(boxes).set({ status: 'lost' }).where(eq(boxes.id, lot.lost.boxIds[0]!));

  await compose(lot.three.lotId, THREE);
  await compose(lot.swapped.lotId, ['Мышь', 'Клавиатура']);
  await compose(lot.long.lotId, [LONG_FIRST, 'Мышь', 'Наушники']);
  await compose(lot.handed.lotId, THREE);
  await compose(lot.lost.lotId, THREE);

  // The composed lot landed first, so it is the one that has waited longest.
  await land(lot.three.boxIds, new Date(NOW - 9 * DAY));
  await land(lot.plain.boxIds, new Date(NOW - 2 * DAY));

  // The truck the collected cartons rode, and the handover that took them.
  await db.insert(batches).values({
    id: batchId,
    code: batchCode,
    originWarehouseId: whCn.id,
    destWarehouseId: whUz.id,
    status: 'closed',
    departedAt: new Date(NOW - 20 * DAY),
    createdBy: actorId,
  });
  await db.insert(boxMovements).values(
    lot.handed.boxIds.map((boxId) => ({
      boxId,
      fromWarehouseId: whCn.id,
      toWarehouseId: whUz.id,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batchId,
      actorId,
      createdAt: new Date(NOW - 20 * DAY),
    })),
  );
  const [h] = await db
    .insert(handovers)
    .values({
      clientId,
      warehouseId: whUz.id,
      kind: 'issued_to_client',
      personName: `Oluvchi ${RUN}`,
      personPhone: '+998900000000',
      createdBy: actorId,
    })
    .returning({ id: handovers.id });
  handoverId = h!.id;
  await db.insert(boxMovements).values(
    lot.handed.boxIds.map((boxId) => ({
      boxId,
      fromWarehouseId: whUz.id,
      toWarehouseId: null,
      fromStatus: 'ready_for_pickup',
      toStatus: 'issued',
      cause: 'issued',
      refType: 'handover',
      refId: handoverId,
      actorId,
    })),
  );
  await db.insert(scanEvents).values(
    lot.handed.boxIds.map((boxId) => ({
      clientEventUuid: uuidv4(),
      boxId,
      handoverId,
      type: 'issue',
      method: 'qr',
      scannedBy: actorId,
      scannedAt: new Date(),
    })),
  );

  // A cost on the waiting cargo, so the landed-cost report has lots to list.
  // Dated in a year no report window reaches.
  const [type] = await db.select({ id: costTypes.id }).from(costTypes).where(eq(costTypes.active, true)).limit(1);
  const [entry] = await db
    .insert(costEntries)
    .values({
      scope: 'receipt',
      receiptId: lot.three.receiptId,
      costTypeId: type!.id,
      amount: '50.00',
      currency: 'USD',
      amountUsd: '50.00',
      fxRateUsed: '1',
      costDate: '1583-03-03',
      enteredBy: actorId,
    })
    .returning({ id: costEntries.id });
  costEntryId = entry!.id;
  await db
    .insert(costAllocations)
    .values(
      [...lot.three.boxIds, ...lot.plain.boxIds].map((boxId) => ({ costEntryId, boxId, clientId, amountUsd: '10.0000' })),
    );
});

afterAll(async () => {
  const lots = Object.values(lot).filter((l) => l.lotId);
  const boxIds = lots.flatMap((l) => l.boxIds);
  if (costEntryId) {
    await db.delete(costAllocations).where(eq(costAllocations.costEntryId, costEntryId));
    await db.delete(costEntries).where(eq(costEntries.id, costEntryId));
  }
  if (boxIds.length > 0) {
    await db.delete(scanEvents).where(inArray(scanEvents.boxId, boxIds));
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
  }
  if (handoverId) await db.delete(handovers).where(eq(handovers.id, handoverId));
  await db.delete(batches).where(eq(batches.id, batchId));
  if (lots.length > 0) {
    await db.delete(lotCompositions).where(
      inArray(
        lotCompositions.lotId,
        lots.map((l) => l.lotId),
      ),
    );
  }
  await removeStamped(lots.map((l) => l.receiptId));
  if (clientId) {
    await db.delete(deals).where(eq(deals.clientId, clientId));
    await db.delete(clients).where(eq(clients.id, clientId));
  }
});

describe('a deal’s cargo — ONE count, over goods kinds', () => {
  it('the picker’s label counts the tarkib’s goods with the other lots’: «Клавиатура +3», never «Клавиатура +2 +1»', async () => {
    const cargo = (await dealCargoFor([dealMixed, dealOne])).get(dealMixed)!;
    // Three goods in the composed lot and the plain lot's one: four kinds.
    expect({ goods: cargo.goods, goodsExtra: cargo.goodsExtra }).toEqual({ goods: 'Клавиатура', goodsExtra: 3 });
    const label = dealCargoLabel({ ...cargo, quotedVolumeM3: null, quotedWeightKg: null });
    expect(label.endsWith('· Клавиатура +3')).toBe(true);
    expect(label.match(/\+\d/g)).toHaveLength(1);
  });

  it('a deal of ONE composed lot reads as that lot’s label — the tarkib’s first line, not the alphabet’s', async () => {
    const cargo = (await dealCargoFor([dealOne])).get(dealOne)!;
    // «Клавиатура» sorts before «Мышь»; the tarkib says «Мышь» first.
    expect({ goods: cargo.goods, goodsExtra: cargo.goodsExtra }).toEqual({ goods: 'Мышь', goodsExtra: 1 });
  });

  it('a deal with no tarkib reads exactly what the statement before this round read', async () => {
    await db.delete(lotCompositions).where(eq(lotCompositions.lotId, lot.three.lotId));
    try {
      const cargo = (await dealCargoFor([dealMixed])).get(dealMixed)!;
      // The oracle is the shipped expression, verbatim — whichever of the two
      // names this database's collation sorts first.
      const [before] = (await db.execute(sql`
        SELECT (array_agg(DISTINCT coalesce(nullif(l.product_name_ru, ''), l.product_name_zh)))[1] AS first,
               count(DISTINCT coalesce(nullif(l.product_name_ru, ''), l.product_name_zh))::int AS n
          FROM receipts r JOIN receipt_lots l ON l.receipt_id = r.id
         WHERE r.deal_id = ${dealMixed}::uuid AND r.voided_at IS NULL
      `)) as unknown as { first: string; n: number }[];
      expect(before!.n).toBe(2);
      expect({ goods: cargo.goods, goodsExtra: cargo.goodsExtra }).toEqual({ goods: before!.first, goodsExtra: 1 });
    } finally {
      await compose(lot.three.lotId, THREE);
    }
  });

  it('the deal card’s linked prixods and the «not on a deal yet» picker name each lot as the screens do', async () => {
    const card = await dealById(dealMixed);
    const goods = new Map(card!.receipts.map((r) => [r.id, r.goods]));
    expect(goods.get(lot.three.receiptId)).toBe(LABEL);
    expect(goods.get(lot.plain.receiptId)).toBe(PLAIN_RU);
    const unlinked = new Map((await unlinkedReceipts(clientId)).map((r) => [r.id, r.goods]));
    expect(unlinked.get(lot.long.receiptId)).toBe(LONG_LABEL);
  });
});

describe('the office’s lists', () => {
  it('the lenta’s cargo line', async () => {
    const feed = await clientFeed(clientId, { money: false, limit: 200 });
    const goods = new Map(feed.filter((i) => i.kind === 'cargo').map((i) => [i.id, i.meta.goods]));
    expect(goods.get(`rc-${lot.three.receiptId}`)).toBe(LABEL);
    expect(goods.get(`rc-${lot.plain.receiptId}`)).toBe(PLAIN_RU);
  });

  it('the reports: landed cost by lot, client history and stock aging (its page cell gets the two halves apart)', async () => {
    const landed = new Map((await landedCostByLot(clientId)).map((r) => [r.lotId, r]));
    expect(landed.get(lot.three.lotId)).toMatchObject({ productNameZh: ZH, productNameRu: LABEL, boxCount: 3, totalUsd: 30 });
    expect(landed.get(lot.plain.lotId)).toMatchObject({ productNameRu: PLAIN_RU, boxCount: 2 });

    const history = new Map((await clientHistory(clientId)).map((r) => [r.lotId, r]));
    expect(history.get(lot.three.lotId)).toMatchObject({ productNameZh: ZH, productNameRu: LABEL });
    expect(history.get(lot.plain.lotId)).toMatchObject({ productNameRu: PLAIN_RU });
    // No Russian name of its own: the label stands where there was none.
    expect(history.get(lot.swapped.lotId)).toMatchObject({ productNameRu: 'Мышь +1' });

    const aging = (await stockAging([whUz.id])).filter((r) => r.code.startsWith(`${clientCode}-`));
    expect(aging.map((r) => [r.code, r.product, r.productNameZh, r.productNameRu]).sort()).toEqual([
      [`${clientCode}-A`, `${ZH} (${LABEL})`, ZH, LABEL],
      [`${clientCode}-B`, `线${RUN} (${PLAIN_RU})`, `线${RUN}`, PLAIN_RU],
    ]);
  });

  it('the freight split’s rows and held lines (`boxMeasures` → `lotIdentityOf`)', async () => {
    const measures = await boxMeasures([...lot.three.boxIds, ...lot.plain.boxIds]);
    const goods = new Map(measures.map((m) => [m.lotId, lotIdentityOf(m).goods]));
    expect(goods.get(lot.three.lotId)).toBe(LABEL);
    expect(goods.get(lot.plain.lotId)).toBe(PLAIN_RU);
  });

  it('the unpriced list, the compensation form’s lost cargo and the factory checker’s prixod line', async () => {
    const unpriced = await unpricedReceiptsOn(
      db,
      { kind: 'receipts', receiptIds: [lot.three.receiptId, lot.plain.receiptId] },
      GATE_OFF,
    );
    const byReceipt = new Map(unpriced.map((r) => [r.receiptId, r.goods]));
    expect(byReceipt.get(lot.three.receiptId)).toBe(LABEL);
    expect(byReceipt.get(lot.plain.receiptId)).toBe(PLAIN_RU);

    const lost = await lostCargoForClient(clientId);
    expect(lost.rows.map((r) => [r.receiptId, r.goods])).toEqual([[lot.lost.receiptId, LABEL]]);

    const facts = await receiptFacts([lot.three.receiptId, lot.plain.receiptId]);
    expect(facts.get(lot.three.receiptId)!.goods).toBe(LABEL);
    expect(facts.get(lot.plain.receiptId)!.goods).toBe(PLAIN_RU);
  });

  it('the uncollected list: the longest-waiting lot’s first good and ONE count of the rest', async () => {
    const list = await uncollectedCargo(db, {
      asOf: new Date(NOW),
      minDays: 0,
      ownerId: undefined,
      warehouseIds: undefined,
      clientIds: [clientId],
    });
    expect(list.rows).toHaveLength(1);
    // «Мышь», «Наушники» and the plain lot beside «Клавиатура»: three more.
    expect(list.rows[0]).toMatchObject({ warehouseId: whUz.id, boxes: 5, goods: 'Клавиатура', moreKinds: 3, days: 9 });
  });

  it('the uncollected list without a tarkib: the first lot’s name and the further LOTS, as before', async () => {
    await db.delete(lotCompositions).where(eq(lotCompositions.lotId, lot.three.lotId));
    try {
      const list = await uncollectedCargo(db, {
        asOf: new Date(NOW),
        minDays: 0,
        ownerId: undefined,
        warehouseIds: undefined,
        clientIds: [clientId],
      });
      expect(list.rows[0]).toMatchObject({ goods: 'клавиатура', moreKinds: 1 });
    } finally {
      await compose(lot.three.lotId, THREE);
    }
  });

  it('the three reports’ XLSX print what their screens print', async () => {
    const named = (sheets: string[][]) => sheets.flat().filter((cell) => cell.startsWith(ZH));
    expect(named(await cellsOf(await buildLandedCostXlsx(clientId)))).toEqual([`${ZH} (${LABEL})`]);
    expect(named(await cellsOf(await buildClientHistoryXlsx(clientId)))).toEqual(
      // `three`, `handed` and `lost` carry this Chinese name and the same tarkib.
      [`${ZH} (${LABEL})`, `${ZH} (${LABEL})`, `${ZH} (${LABEL})`],
    );
    expect(named(await cellsOf(await buildStockAgingXlsx([whUz.id])))).toEqual([`${ZH} (${LABEL})`]);
  });

  it('the manifest prints the live label beside the Chinese name, on both sheets', async () => {
    const [summary, detail] = await cellsOf((await buildManifestXlsx(batchId))!);
    const products = (cells: string[]) => cells.filter((cell) => cell.startsWith(ZH));
    expect(products(summary!)).toEqual([`${ZH} (${LABEL})`]);
    expect(products(detail!)).toEqual([`${ZH} (${LABEL})`, `${ZH} (${LABEL})`]);
  });
});

describe('what the customer reads', () => {
  it('the cabinet’s cargo — the Mini App’s field and the bot’s «📦 Yuklarim»', async () => {
    const lots = new Map((await cargoOverview(clientId)).map((l) => [l.lotId, l]));
    expect(lots.get(lot.three.lotId)).toMatchObject({ productNameZh: ZH, productNameRu: LABEL });
    expect(lots.get(lot.plain.lotId)).toMatchObject({ productNameRu: PLAIN_RU });
    expect(productName(lots.get(lot.swapped.lotId)!)).toBe('Мышь +1');
    const text = cargoMessages({ clientCode, name: '' }, [...lots.values()], 'uz').join('\n');
    expect(text).toContain(`<b>A · ${LABEL}</b>`);
    expect(text).toContain(`<b>B · ${PLAIN_RU}</b>`);
  });

  it('a 📷 button keeps the count when its 40 characters cut the name; the caption keeps it at 200', async () => {
    const long = (await cargoOverview(clientId)).find((l) => l.lotId === lot.long.lotId)!;
    expect(long.productNameRu).toBe(LONG_LABEL);
    const button = photoButtonRows([{ ...long, hasPhotos: true }])[0]![0]!;
    // Telegram counts a button in UTF-16 units, and 📷 is two of them.
    expect(button.text.length).toBe(MAX_BUTTON_CHARS);
    expect(button.text.startsWith('📷 D · Клавиатура провод')).toBe(true);
    expect(button.text.endsWith('… +2')).toBe(true);
    // A short name is the button it always was.
    const plain = (await cargoOverview(clientId)).find((l) => l.lotId === lot.plain.lotId)!;
    expect(photoButtonRows([{ ...plain, hasPhotos: true }])[0]![0]!.text).toBe(`📷 B · ${PLAIN_RU}`);

    const caption = photoCaption({ clientCode, letter: 'D', name: `${'я'.repeat(230)} +2`, boxes: 1 }, 'uz');
    expect(caption).toContain(`${'я'.repeat(196)}… +2 · `);
  });

  it('the cabinet’s map', async () => {
    const places = await cabinetMap([clientId]);
    const names = new Map(places.flatMap((p) => p.lots).map((l) => [l.lotId, l.productNameRu]));
    expect(names.get(lot.three.lotId)).toBe(LABEL);
    expect(names.get(lot.plain.lotId)).toBe(PLAIN_RU);
  });

  it('«yukingiz qabul qilindi» reads the label at SEND time, and the push’s clip keeps the count', async () => {
    const received = await receivedFacts(clientId, lot.three.receiptId);
    if ('skip' in received) throw new Error(`skipped: ${received.skip}`);
    expect(received.summary.lines.map((l) => l.name)).toEqual([LABEL]);

    const long = await receivedFacts(clientId, lot.long.receiptId);
    if ('skip' in long) throw new Error(`skipped: ${long.skip}`);
    expect(long.summary.lines[0]!.name).toBe(LONG_LABEL);
    // The push's own line builder: 80 characters, the «+2» among them.
    const [line] = lotLines(long.summary.lines, 'uz');
    const name = /· (.*) — /.exec(line!)![1]!;
    expect(Array.from(name)).toHaveLength(PUSH_NAME_CHARS);
    expect(splitLabelCount(name)).toEqual({ name: `${LONG_FIRST.slice(0, 76)}…`, count: '+2' });
  });

  it('«yukingiz yetib keldi» — the arrival off a truck', async () => {
    const summary = await arrivedSummary(clientId, batchId, whUz.id);
    expect(summary!.lines.map((l) => [l.lotId, l.name])).toEqual([
      [lot.three.lotId, LABEL],
      [lot.plain.lotId, PLAIN_RU],
    ]);
  });

  it('«yukingiz berildi» and the cabinet’s «Tarix»', async () => {
    const issued = await issuedFacts(clientId, handoverId);
    if ('skip' in issued) throw new Error(`skipped: ${issued.skip}`);
    expect(issued.lines.map((l) => [l.lotId, l.name, l.boxCount])).toEqual([[lot.handed.lotId, LABEL, 2]]);

    const [history] = (await issuedHandovers(clientId)).filter((h) => h.id === handoverId);
    expect(history!.lots.map((l) => [l.productNameZh, l.productNameRu])).toEqual([[ZH, LABEL]]);
    expect(history!.legs.map((g) => g.batchCode)).toEqual([batchCode]);
  });

  it('the handover act reads the label in its own select — the font is subset from these strings', async () => {
    const rows = await handoverActRows(handoverId);
    expect(rows.map((r) => [r.letter, r.productNameZh, r.productNameRu])).toEqual([
      ['E', ZH, LABEL],
      ['E', ZH, LABEL],
    ]);
    // …and the paper itself is built from them (looked at through pdfium, not parsed here).
    expect((await buildHandoverAct(handoverId))!.byteLength).toBeGreaterThan(1000);
  });

  it('an act row wider than the sheet gives up the NAME, never the count', () => {
    // The sheet's own measure, stood in by a character budget.
    const fits = (text: string) => Array.from(text).length <= 70;
    const head = 'KP0001-1   GS777-D';
    const row = actRowText(head, '键盘', LONG_LABEL, fits);
    expect(Array.from(row)).toHaveLength(70);
    expect(row.startsWith(`${head}   键盘 (Клавиатура провод`)).toBe(true);
    expect(row.endsWith('… +2)')).toBe(true);
    // A row that fits is the row it always was — with a label or without.
    expect(actRowText(head, '键盘', LABEL, fits)).toBe(`${head}   键盘 (${LABEL})`);
    expect(actRowText(head, '键盘', null, fits)).toBe(`${head}   键盘`);
    // A long name with NO count is cut at its end, as any name always was.
    expect(actRowText(head, '键盘', LONG_FIRST, fits).endsWith('…)')).toBe(true);
  });
});

// LAST on purpose: every reader above has run by now.
describe('the stored name is the lot’s own word — no reader above moved it', () => {
  it('a three-line tarkib, read through every list of this file, leaves `product_name_ru` as the warehouse typed it', async () => {
    expect(await storedRu(lot.three.lotId)).toBe('клавиатура');
    expect(await storedRu(lot.plain.lotId)).toBe(PLAIN_RU);
    expect(await storedRu(lot.swapped.lotId)).toBeNull();
    expect(await storedRu(lot.long.lotId)).toBe('клавиатура');
  });
});
