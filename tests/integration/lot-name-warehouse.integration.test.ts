import 'dotenv/config';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The warehouse screens and the searches print the tarkib's name (the owner's
 * items 3-4, 2026-11-10; docs/TARKIB-TUZATISH.md §3 and §9.2): one lot with a
 * three-line tarkib and one without, read back through the REAL readers the
 * round swapped — each its own exported function, or the route a screen
 * fetches — so a reader that goes back to the stored column turns red here.
 * No test before this one seeded a tarkib and read it through a list.
 *
 * What each must say: «Клавиатура +2» for the composed lot, the warehouse's
 * own word for the other, and the STORED name unmoved — the readers that use
 * it as the lot's identity (the price history's needle) still get it.
 * The searches find the composed lot by its SECOND line («мышь», which no
 * stored name says) and by a label pasted off a row («Клавиатура +2»).
 *
 * Written straight to the tables, like lot-name.integration: its own two
 * warehouses, client, two trucks and two prixod lots, every name carrying the
 * run's digits, all of it deleted at the end. The composed lot stands in
 * three places at once — the shelf, a truck being loaded, a truck on the
 * road — because that is what the readers split by.
 */

const override = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: async () => ({ ip: null, userAgent: 'lot-name-warehouse.integration' }),
}));
// The three routes below ask for their person through these two; everything
// else the module exports stays real.
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  type Actor = Awaited<ReturnType<typeof real.requireActor>>;
  return {
    ...real,
    requireActor: async () => (override.actor ?? (await real.requireActor())) as Actor,
    authorize: async (...args: Parameters<typeof real.authorize>) =>
      (override.actor ?? (await real.authorize(...args))) as Actor,
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  clientTelegramLinks,
  clients,
  lotCompositionLines,
  lotCompositions,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { GET as stockXlsx } from '@/app/api/reports/stock/route';
import { GET as issueList } from '@/app/api/issue/list/route';
import { GET as cratableBoxes } from '@/app/api/crates/boxes/route';
import { audienceChats } from '@/modules/platform/broadcast/service';
import { batchLots } from '@/modules/wms/batches/lots';
import { botLookup, type BotActor } from '@/modules/wms/bot/lookup';
import { clientCargoRows } from '@/modules/wms/inventory/client-cargo-now';
import { stockTextWhere } from '@/modules/wms/inventory/stock-filter';
import { plannableStock, roadStock } from '@/modules/wms/planning/stock';
import { reportLabels } from '@/modules/wms/reports/labels';
import { countAcceptPanel } from '@/modules/wms/scanning/count-accept';
import { countLoadPanel, countableLotsAt } from '@/modules/wms/scanning/count-load';
import { missingLotLines } from '@/modules/wms/scanning/unload';
import { globalSearch, type SearchActor } from '@/modules/wms/search/service';
import { placeCargo } from '@/modules/wms/tracking/place-cargo';

const RUN = String(Date.now()).slice(-6);
/** The client's code — «PA123456-A» is the lot as the warehouse says it aloud. */
const CODE = `PA${RUN}`;
const ZH_K = `键盘P2A${RUN}`;
const ZH_P = `鼠标垫P2A${RUN}`;
/** What the warehouse typed for the composed lot: no word of it is in the tarkib. */
const OWN_K = `складское имя ${RUN}`;
const OWN_P = `Коврик ${RUN}`;
const SECOND = `Мышь ${RUN}`;
const LINES = ['Клавиатура', SECOND, 'Наушники'];
const LABEL = 'Клавиатура +2';
const CHAT = BigInt(`7${RUN}1`);

let actorId = '';
let clientId = '';
let receiptId = '';
const wh = { origin: '', dest: '' };
const truck = { loading: '', road: '' };
const lot = { K: '', P: '' };
/** K1-K2 and P1-P2 stand on the shelf, K3-K4 and P3 are being loaded, K5-K6 are on the road. */
const box: Record<string, string> = {};

const person = () => ({
  id: actorId,
  permissions: new Set(['plans.manage', 'scan.issue', 'crates.manage']),
  roles: [] as string[],
  roleGrants: new Map<string, Set<string>>(),
  warehouseScoped: false,
  warehouseIds: [] as string[],
});
const asPerson = async <T>(run: () => Promise<T>): Promise<T> => {
  override.actor = { ...person(), fullName: 'P2a', locale: 'uz' };
  try {
    return await run();
  } finally {
    override.actor = null;
  }
};

async function mintWarehouse(code: string, country: string, type: string) {
  const [w] = await db
    .insert(warehouses)
    .values({ code, name: `Tarkib nomi ${code}`, country, type, timezone: 'Asia/Tashkent', batchPrefix: code })
    .returning({ id: warehouses.id });
  return w!.id;
}

async function mintLot(seq: number, letter: string, zh: string, ru: string, boxCount: number) {
  const [row] = await db
    .insert(receiptLots)
    .values({
      receiptId,
      seq,
      letter,
      productNameZh: zh,
      productNameRu: ru,
      boxCount,
      totalWeightKg: (boxCount * 10).toFixed(3),
      totalVolumeM3: (boxCount * 0.1).toFixed(4),
    })
    .returning({ id: receiptLots.id });
  return row!.id;
}

async function mintBox(
  key: string,
  lotId: string,
  seq: number,
  at: { status: string; warehouseId: string | null; batchId: string | null },
) {
  const [row] = await db
    .insert(boxes)
    .values({
      lotId,
      shortCode: `P2A${RUN}${key}`,
      seqInLot: seq,
      status: at.status,
      currentWarehouseId: at.warehouseId,
      currentBatchId: at.batchId,
    })
    .returning({ id: boxes.id });
  box[key] = row!.id;
}

/** The one row of a reader's answer that is this lot's. */
const of = <T extends object>(rows: readonly T[], key: keyof T, lotId: string): T => {
  const hit = rows.filter((row) => row[key] === lotId);
  expect(hit, `one row for the lot under «${String(key)}»`).toHaveLength(1);
  return hit[0]!;
};

beforeAll(async () => {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1);
  actorId = u!.id;
  wh.origin = await mintWarehouse(`TNO${RUN}`, 'CN', 'origin');
  wh.dest = await mintWarehouse(`TND${RUN}`, 'UZ', 'distribution');
  const [c] = await db
    .insert(clients)
    .values({ clientCode: CODE, name: `Tarkib nomi ${RUN}` })
    .returning({ id: clients.id });
  clientId = c!.id;
  await db.insert(clientTelegramLinks).values({ clientId, telegramChatId: CHAT, status: 'linked' });
  const [r] = await db
    .insert(receipts)
    .values({
      warehouseId: wh.origin,
      number: `TN-${RUN}`,
      clientId,
      status: 'confirmed',
      createdBy: actorId,
      confirmedAt: new Date(),
      confirmedBy: actorId,
    })
    .returning({ id: receipts.id });
  receiptId = r!.id;
  const [loading] = await db
    .insert(batches)
    .values({
      code: `TN${RUN}-1`,
      originWarehouseId: wh.origin,
      destWarehouseId: wh.dest,
      status: 'loading',
      createdBy: actorId,
    })
    .returning({ id: batches.id });
  const [road] = await db
    .insert(batches)
    .values({
      code: `TN${RUN}-2`,
      originWarehouseId: wh.origin,
      destWarehouseId: wh.dest,
      status: 'in_transit',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning({ id: batches.id });
  truck.loading = loading!.id;
  truck.road = road!.id;

  lot.K = await mintLot(1, 'A', ZH_K, OWN_K, 6);
  lot.P = await mintLot(2, 'B', ZH_P, OWN_P, 3);
  const shelf = { status: 'in_stock', warehouseId: wh.origin, batchId: null };
  const beingLoaded = { status: 'loading', warehouseId: wh.origin, batchId: truck.loading };
  const onRoad = { status: 'in_transit', warehouseId: null, batchId: truck.road };
  await mintBox('K1', lot.K, 1, shelf);
  await mintBox('K2', lot.K, 2, shelf);
  await mintBox('K3', lot.K, 3, beingLoaded);
  await mintBox('K4', lot.K, 4, beingLoaded);
  await mintBox('K5', lot.K, 5, onRoad);
  await mintBox('K6', lot.K, 6, onRoad);
  await mintBox('P1', lot.P, 1, shelf);
  await mintBox('P2', lot.P, 2, shelf);
  await mintBox('P3', lot.P, 3, beingLoaded);

  // The tarkib, as lot-name.integration writes one: a header and its lines.
  await db.insert(lotCompositions).values({ lotId: lot.K, seenBoxCount: 6, savedBy: actorId });
  await db
    .insert(lotCompositionLines)
    .values(LINES.map((name, i) => ({ lotId: lot.K, seq: i + 1, name, weightKg: '20.000', volumeM3: '0.2000' })));
});

afterAll(async () => {
  const lotIds = Object.values(lot).filter(Boolean);
  if (lotIds.length > 0) {
    await db.delete(lotCompositions).where(inArray(lotCompositions.lotId, lotIds));
    await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  if (receiptId) await db.delete(receipts).where(eq(receipts.id, receiptId));
  const truckIds = Object.values(truck).filter(Boolean);
  if (truckIds.length > 0) await db.delete(batches).where(inArray(batches.id, truckIds));
  if (clientId) {
    await db.delete(clientTelegramLinks).where(eq(clientTelegramLinks.clientId, clientId));
    await db.delete(clients).where(eq(clients.id, clientId));
  }
  const whIds = Object.values(wh).filter(Boolean);
  if (whIds.length > 0) await db.delete(warehouses).where(inArray(warehouses.id, whIds));
  await pgClient.end();
});

describe('the lists print the tarkib’s name; a lot with no tarkib keeps its own', () => {
  it('the plan editor’s shelf list (plannableStock) and its road half (roadStock)', async () => {
    const shelf = await plannableStock(wh.origin);
    expect(of(shelf.lots, 'lotId', lot.K)).toMatchObject({ productNameZh: ZH_K, productNameRu: LABEL, available: 2 });
    expect(of(shelf.lots, 'lotId', lot.P)).toMatchObject({ productNameZh: ZH_P, productNameRu: OWN_P, available: 2 });
    const road = await roadStock(wh.dest);
    expect(of(road.lots, 'lotId', lot.K)).toMatchObject({ productNameRu: LABEL });
  });

  it('the truck card, the cost grid and the «Narx» tab (batchLots): a SECOND field — the stored name stays the price history’s needle', async () => {
    const lots = await batchLots(truck.loading);
    const k = of(lots, 'lotId', lot.K);
    expect(k.shownNameRu).toBe(LABEL);
    // Rule 2: this row is display AND identity, so the own name is not swapped.
    expect(k.productNameRu).toBe(OWN_K);
    // …and the list that already prints «first +N» over a deal's lots counts
    // goods KINDS: three here, one for the plain lot — one number, never «+2 +1».
    expect(k.goodsKinds).toEqual(LINES);
    const p = of(lots, 'lotId', lot.P);
    expect(p.shownNameRu).toBe(OWN_P);
    expect(p.productNameRu).toBe(OWN_P);
    expect(p.goodsKinds).toEqual([OWN_P]);
  });

  it('the count-load panel and its picker (countLoadPanel, countableLotsAt)', async () => {
    const panel = await countLoadPanel({ id: truck.loading, originWarehouseId: wh.origin });
    expect(of(panel.rows, 'lotId', lot.K)).toMatchObject({ product: LABEL, aboard: 2, spare: 2 });
    expect(of(panel.rows, 'lotId', lot.P)).toMatchObject({ product: OWN_P, aboard: 1, spare: 2 });
    // The picker lists what does NOT touch the truck yet — asked for a truck
    // neither lot is on.
    const other = { id: randomUUID(), originWarehouseId: wh.origin };
    const picker = await countableLotsAt(other);
    expect(of(picker.lots, 'lotId', lot.K).product).toBe(LABEL);
    expect(of(picker.lots, 'lotId', lot.P).product).toBe(OWN_P);
  });

  it('the count-accept panel (countAcceptPanel): the Chinese name beside the SHOWN Russian one', async () => {
    const panel = await countAcceptPanel(truck.road);
    expect(of(panel.lots, 'lotId', lot.K)).toMatchObject({ product: ZH_K, productRu: LABEL, awaiting: 2 });
  });

  it('the unload’s missing-lot lines (missingLotLines), inside a transaction', async () => {
    const lines = await db.transaction((tx) =>
      missingLotLines(tx, [{ lotId: lot.K }, { lotId: lot.K }, { lotId: lot.P }]),
    );
    expect(lines).toEqual([
      { label: `${CODE}-A`, product: LABEL, n: 2 },
      { label: `${CODE}-B`, product: OWN_P, n: 1 },
    ]);
  });

  it('the map’s popup (placeCargo): a warehouse, and a truck on the road', async () => {
    const standing = await placeCargo({ warehouseId: wh.origin });
    expect(of(standing.lots, 'lotId', lot.K)).toMatchObject({ goods: LABEL, boxes: 4 });
    expect(of(standing.lots, 'lotId', lot.P)).toMatchObject({ goods: OWN_P, boxes: 3 });
    const riding = await placeCargo({ batchId: truck.road });
    expect(of(riding.lots, 'lotId', lot.K)).toMatchObject({ goods: LABEL, boxes: 2 });
  });

  it('the client card’s «Yuklar» rows and the staff bot (clientCargoRows, botLookup)', async () => {
    const rows = await clientCargoRows([clientId]);
    const k = rows.filter((row) => row.lotId === lot.K);
    // One row per place the lot stands in: the shelf, the loading truck, the road.
    expect(k).toHaveLength(3);
    expect(new Set(k.map((row) => row.productRu))).toEqual(new Set([LABEL]));
    expect(new Set(rows.filter((row) => row.lotId === lot.P).map((row) => row.productRu))).toEqual(new Set([OWN_P]));

    const bot: BotActor = person();
    const byBox = await botLookup(bot, `P2A${RUN}K1`);
    expect(byBox).toContain(`· ${LABEL}\n`);
    expect(byBox).not.toContain(OWN_K);
    const byClient = await botLookup(bot, CODE);
    expect(byClient).toContain(`: ${LABEL} — `);
    expect(byClient).toContain(`: ${OWN_P} — `);
    expect(byClient).not.toContain(OWN_K);
  });

  it('the Ostatka XLSX, through the route the download really runs', async () => {
    const product = await asPerson(async () => {
      const res = await stockXlsx(new Request(`http://local/api/reports/stock?q=${CODE}`));
      expect(res.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer);
      const sheet = wb.worksheets[0]!;
      const header = sheet.getRow(1).values as unknown[];
      const column = header.indexOf(reportLabels('uz').product);
      expect(column).toBeGreaterThan(0);
      const cells: string[] = [];
      for (let r = 2; r <= sheet.rowCount; r += 1) cells.push(String(sheet.getRow(r).getCell(column).value ?? ''));
      return cells.filter(Boolean).sort();
    });
    // Plain text, the whole name: no clip in a sheet's cell.
    expect(product).toEqual([`${ZH_K} (${LABEL})`, `${ZH_P} (${OWN_P})`].sort());
  });

  it('the handover screen’s boxes and the crate builder’s (their two routes)', async () => {
    const names = async (res: Response) => {
      expect(res.status).toBe(200);
      const body = (await res.json()) as { boxes: { lotId: string; productNameRu: string | null }[] };
      return {
        K: new Set(body.boxes.filter((b) => b.lotId === lot.K).map((b) => b.productNameRu)),
        P: new Set(body.boxes.filter((b) => b.lotId === lot.P).map((b) => b.productNameRu)),
      };
    };
    const query = `warehouseId=${wh.origin}&clientId=${clientId}`;
    const issue = await asPerson(async () => names(await issueList(new Request(`http://local/api/issue/list?${query}`))));
    expect(issue).toEqual({ K: new Set([LABEL]), P: new Set([OWN_P]) });
    const crate = await asPerson(async () => names(await cratableBoxes(new Request(`http://local/api/crates/boxes?${query}`))));
    expect(crate).toEqual({ K: new Set([LABEL]), P: new Set([OWN_P]) });
  });

  it('⌘K: a lot found by its code-letter and by its goods reads like the row it leads to', async () => {
    const seeker: SearchActor = person();
    const byCode = await globalSearch(seeker, `${CODE}-a`);
    expect(byCode).toEqual([
      { kind: 'lot', id: lot.K, code: `${CODE}-A`, label: `${ZH_K} · ${LABEL}`, href: `/stock?lot=${lot.K}` },
    ]);
    const plain = await globalSearch(seeker, `${CODE}-B`);
    expect(plain.map((hit) => hit.label)).toEqual([`${ZH_P} · ${OWN_P}`]);
    const byGoods = (await globalSearch(seeker, ZH_K)).filter((hit) => hit.kind === 'lot');
    expect(byGoods.map((hit) => [hit.id, hit.label])).toEqual([[lot.K, `${ZH_K} · ${LABEL}`]]);
  });

  it('…and the stored name of neither lot moved', async () => {
    const stored = await db
      .select({ id: receiptLots.id, ru: receiptLots.productNameRu })
      .from(receiptLots)
      .where(inArray(receiptLots.id, [lot.K, lot.P]));
    expect(new Map(stored.map((row) => [row.id, row.ru]))).toEqual(
      new Map([
        [lot.K, OWN_K],
        [lot.P, OWN_P],
      ]),
    );
  });
});

describe('the searches find a composed lot by ANY line of its tarkib, and by a label pasted off a row', () => {
  /** /stock's own predicate over this prixod's cartons — the lots it matches. */
  const stockBox = async (q: string): Promise<string[]> => {
    const rows = await db
      .selectDistinct({ lotId: receiptLots.id })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .leftJoin(clients, eq(receipts.clientId, clients.id))
      .where(and(eq(receipts.id, receiptId), stockTextWhere(q)));
    return rows.map((row) => row.lotId).sort();
  };
  const both = () => [lot.K, lot.P].sort();

  it('no stored name of the composed lot says «мышь» or «клавиатура» — the lines alone do', async () => {
    const [k] = await db
      .select({ zh: receiptLots.productNameZh, ru: receiptLots.productNameRu })
      .from(receiptLots)
      .where(eq(receiptLots.id, lot.K));
    expect(`${k!.zh} ${k!.ru}`.toLowerCase()).not.toMatch(/мышь|клавиатура/);
  });

  it('/stock’s box (stockTextWhere)', async () => {
    expect(await stockBox('мышь')).toEqual([lot.K]);
    expect(await stockBox(`  ${LABEL} `)).toEqual([lot.K]);
    // The warehouse's own words go on finding their lots, and the code both.
    expect(await stockBox(OWN_K)).toEqual([lot.K]);
    expect(await stockBox('коврик')).toEqual([lot.P]);
    expect(await stockBox(CODE)).toEqual(both());
    expect(await stockBox(`нет такого ${RUN}`)).toEqual([]);
  });

  it('the count door’s picker (countableLotsAt)', async () => {
    const other = { id: randomUUID(), originWarehouseId: wh.origin };
    const found = async (q: string) => (await countableLotsAt(other, q)).lots.map((l) => l.lotId).sort();
    expect(await found('мышь')).toEqual([lot.K]);
    expect(await found(LABEL)).toEqual([lot.K]);
    expect(await found('коврик')).toEqual([lot.P]);
    expect(await found(CODE)).toEqual(both());
  });

  it('⌘K’s lots (globalSearch)', async () => {
    const seeker: SearchActor = person();
    const lots = async (q: string) =>
      (await globalSearch(seeker, q)).filter((hit) => hit.kind === 'lot').map((hit) => hit.id);
    expect(await lots(SECOND.toLowerCase())).toEqual([lot.K]);
    // The newest prixod with a «клавиатура» in it is this one, so it is among
    // the six a group shows — and nothing at all says «+2».
    expect(await lots(LABEL)).toContain(lot.K);
  });

  it('the broadcast’s goods filter (audienceChats) — platform code, by dynamic import', async () => {
    const base = { sectors: [], cargoKinds: [], locales: [], codes: [] };
    const chats = async (query: string) => (await audienceChats({ ...base, query })).map((c) => c.chatId);
    expect(await chats(SECOND.toLowerCase())).toEqual([CHAT]);
    expect(await chats(LABEL)).toContain(CHAT);
    expect(await chats(`нет такого ${RUN}`)).toEqual([]);
  });
});
