import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  clientNotices,
  clientTransactions,
  clients,
  tnvedAssignments,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';
import { addTransaction, voidTransaction } from '@/modules/wms/finance/service';
import { batchLots, type BatchLot } from '@/modules/wms/batches/lots';
import {
  historyPairsSql,
  HINT_STATEMENT_MS,
  priceHistoryForLots,
  pricedRowsForLots,
  underCeiling,
  type Needle,
  type PriceHistory,
} from '@/modules/wms/finance/price-history';
import { productKey, productKeySql } from '@/modules/wms/tnved/service';

/**
 * «📈 Oldingi narx» (0119, his 16a/17a/28a) against a real ledger: every truck
 * goes through the real doors (receipt, plan, scans, departure) because the
 * price is divided by the RIDERS of that truck and nothing else may decide who
 * rode. Product names are random words per run, so no other file's lot and no
 * earlier run of this one can be «the same goods» by accident.
 *
 * Money is dated in 1619 (no other file's year); only the trucks' departure
 * clock matters to the icon, and it is set per truck.
 */

const S = String(Date.now()).slice(-6);
const DAY = '1619-04-10';
const hex = () => uuidv4().replace(/-/g, '').slice(0, 14);
const P = {
  mouse: `q${hex()}`,
  other: `q${hex()}`,
  codeNeedle: `q${hex()}`,
  codePast: `q${hex()}`,
  headNeedle: `q${hex()}`,
  headPast: `q${hex()}`,
  jacketW: `q${hex()}`,
  jacketM: `q${hex()}`,
  excl: `q${hex()}`,
};
const CODE10 = '8471300000';
const HEADING = '8471';

let actorId: string;
const ctx = () => ({ actorId });
const W = { yw: '', tas: '', gz: '', and: '' };
const madeClients: string[] = [];
const madeBatches: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const UNSCOPED = { warehouseScoped: false, warehouseIds: [] as string[] };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Narx tarixi ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

async function mkClient(tag: string) {
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `PH${tag}${S}`.slice(0, 10).toUpperCase(), name: `Narx tarixi ${tag} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(row!.id);
  return row!.id;
}

type Lot = { lotId: string; codes: string[] };

/** One receipt of `lots` for `clientId`, each lot `boxes` cartons of 50×40×30 cm / 20 kg. */
async function receive(
  clientId: string,
  warehouseId: string,
  lots: { zh: string; ru?: string; boxes: number }[],
): Promise<Lot[]> {
  const receiptId = uuidv4();
  const ids = lots.map(() => uuidv4());
  for (const lotId of ids) {
    await db.insert(attachments).values({
      entityType: 'receipt_lot',
      entityId: lotId,
      kind: 'photo',
      storageKey: `narx-tarixi/${lotId}`,
      fileName: 'x.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: actorId,
    });
  }
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      dealId: null,
      unclaimedMarking: '',
      lots: lots.map((lot, i) => ({
        id: ids[i],
        productNameZh: lot.zh,
        productNameRu: lot.ru ?? '',
        boxCount: lot.boxes,
        dimsMode: 'uniform',
        boxLengthCm: 50,
        boxWidthCm: 40,
        boxHeightCm: 30,
        boxWeightKg: 20,
      })),
      extraCosts: [],
    } as never,
    ctx(),
  );
  const out: Lot[] = [];
  for (const lotId of ids) {
    const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(boxes.seqInLot);
    out.push({ lotId, codes: rows.map((b) => b.shortCode) });
  }
  return out;
}

const scan = (batchId: string, code: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

/**
 * A truck carrying `lots` whole (or, with `load`, only the first N cartons of
 * a lot — the short-load that makes a price «partial»), departed or not, its
 * departure clock set to `departedAt`.
 */
async function truck(
  lots: (Lot & { load?: number })[],
  opts: {
    origin?: string;
    dest?: string;
    depart?: boolean;
    departedAt?: Date;
    priceBefore?: (batchId: string) => Promise<unknown>;
  } = {},
) {
  const origin = opts.origin ?? W.yw;
  const dest = opts.dest ?? W.tas;
  const sub = await submitPlan(
    {
      originWarehouseId: origin,
      destWarehouseId: dest,
      lines: lots.map((l) => ({ lotId: l.lotId, boxCount: l.codes.length })),
    } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  madeBatches.push(batch!.id);
  for (const lot of lots) {
    for (const code of lot.codes.slice(0, lot.load ?? lot.codes.length)) {
      const [ack] = await ingestLoadScans([scan(batch!.id, code)], ctx());
      if (ack!.result !== 'ok') throw new Error(`load ${code}: ${ack!.result}`);
    }
  }
  if (opts.priceBefore) await opts.priceBefore(batch!.id);
  if (opts.depart !== false) {
    await finishLoading(batch!.id, ctx());
    await sleep(15);
    await departBatch(batch!.id, ctx());
    if (opts.departedAt) {
      await db.update(batches).set({ departedAt: opts.departedAt }).where(eq(batches.id, batch!.id));
    }
  }
  return batch!;
}

const charge = (clientId: string, batchId: string, amount: number) =>
  addTransaction({ clientId, type: 'charge', amount, currency: 'USD', txDate: DAY, batchId }, ctx());

const F = {} as {
  a: string;
  b: string;
  t0: { id: string };
  pageLots: BatchLot[];
  t: Record<string, { id: string; code: string }>;
};

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  W.yw = await mintWarehouse(`HY${S}`, 'CN', 'origin');
  W.tas = await mintWarehouse(`HT${S}`, 'UZ', 'distribution');
  W.gz = await mintWarehouse(`HG${S}`, 'CN', 'origin');
  W.and = await mintWarehouse(`HA${S}`, 'UZ', 'distribution');
  await db.insert(tnvedAssignments).values([
    { productKey: productKey(P.codeNeedle), productNameZh: P.codeNeedle, tnvedCode: CODE10, source: 'manual' },
    { productKey: productKey(P.codePast), productNameZh: P.codePast, tnvedCode: CODE10, source: 'manual' },
    { productKey: productKey(P.headNeedle), productNameZh: P.headNeedle, tnvedCode: HEADING, source: 'manual' },
    { productKey: productKey(P.headPast), productNameZh: P.headPast, tnvedCode: HEADING, source: 'manual' },
  ] as never);

  F.a = await mkClient('A');
  F.b = await mkClient('B');
  F.t = {};

  // The needle's own client (A): two past trucks, one carrying a second kind of goods.
  const [a1, a1other] = await receive(F.a, W.yw, [
    { zh: P.mouse, boxes: 1 },
    { zh: P.other, boxes: 1 },
  ]);
  F.t.a1 = await truck([a1!, a1other!], { departedAt: daysAgo(10) });
  await charge(F.a, F.t.a1.id, 1000);
  const [a2] = await receive(F.a, W.yw, [{ zh: P.mouse, boxes: 2 }]);
  F.t.a2 = await truck([a2!], { departedAt: daysAgo(5) });
  await charge(F.a, F.t.a2.id, 600);

  // Another client (B): four trucks of the same goods, so the cap of five bites.
  for (const [name, age, usd] of [
    ['b3', 40, 300],
    ['b9', 30, 310],
    ['b10', 20, 320],
    ['b11', 50, 330],
  ] as const) {
    const [lot] = await receive(F.b, W.yw, [{ zh: P.mouse, boxes: 1 }]);
    F.t[name] = await truck([lot!], { departedAt: daysAgo(age) });
    await charge(F.b, F.t[name].id, usd);
  }

  // The same 10-digit declaration code under a different name; a heading shared by two names.
  const [codePast] = await receive(F.b, W.yw, [{ zh: P.codePast, boxes: 1 }]);
  F.t.code = await truck([codePast!], { departedAt: daysAgo(15) });
  await charge(F.b, F.t.code.id, 200);
  const [headPast] = await receive(F.b, W.yw, [{ zh: P.headPast, boxes: 1 }]);
  F.t.head = await truck([headPast!], { departedAt: daysAgo(15) });
  await charge(F.b, F.t.head.id, 200);

  // Men's jackets, priced (#934/#936).
  const [jm] = await receive(F.b, W.yw, [{ zh: P.jacketM, ru: 'Erkaklar kurtkasi', boxes: 1 }]);
  F.t.jacketM = await truck([jm!], { departedAt: daysAgo(15) });
  await charge(F.b, F.t.jacketM.id, 200);

  // The exclusions, all client B, all the same goods as the needle «excl».
  const [old] = await receive(F.b, W.yw, [{ zh: P.excl, boxes: 1 }]);
  F.t.old = await truck([old!], { departedAt: daysAgo(400) });
  await charge(F.b, F.t.old.id, 111);
  const [voided] = await receive(F.b, W.yw, [{ zh: P.excl, boxes: 1 }]);
  F.t.voided = await truck([voided!], { departedAt: daysAgo(12) });
  const voidMe = await charge(F.b, F.t.voided.id, 112);
  await voidTransaction(voidMe.id, 'test', ctx(), { mayMoveTill: true });
  const [parked] = await receive(F.b, W.yw, [{ zh: P.excl, boxes: 1 }]);
  F.t.parked = await truck([parked!], { depart: false });
  await charge(F.b, F.t.parked.id, 113);
  const [far] = await receive(F.b, W.gz, [{ zh: P.excl, boxes: 1 }]);
  F.t.far = await truck([far!], { origin: W.gz, dest: W.and, departedAt: daysAgo(8) });
  await charge(F.b, F.t.far.id, 114);
  // Priced while three cartons were planned and only two went: «partial».
  const [short] = await receive(F.b, W.yw, [{ zh: P.excl, boxes: 3 }]);
  F.t.short = await truck([{ ...short!, load: 2 }], {
    departedAt: daysAgo(9),
    priceBefore: (batchId) => charge(F.b, batchId, 115),
  });

  // THIS truck: the needles, and B's own lot of the same goods (a page lot is never its own precedent).
  const [nA, nCode, nHead, nJacket, nExcl] = await receive(F.a, W.yw, [
    { zh: P.mouse, boxes: 1 },
    { zh: P.codeNeedle, boxes: 1 },
    { zh: P.headNeedle, boxes: 1 },
    { zh: P.jacketW, ru: 'Ayollar kurtkasi', boxes: 1 },
    { zh: P.excl, boxes: 1 },
  ]);
  const [nB] = await receive(F.b, W.yw, [{ zh: P.mouse, boxes: 1 }]);
  F.t0 = await truck([nA!, nCode!, nHead!, nJacket!, nExcl!, nB!], { depart: false });
  await charge(F.b, F.t0.id, 999);
  F.pageLots = await batchLots(F.t0.id);
}, 240_000);

afterAll(async () => {
  // Money first, then the claims the loads wrote; the cargo stays and the
  // warehouses are DEACTIVATED (an audited action touched them). CI hands
  // this ONE database to Playwright next (#154): a dozen trucks left «in
  // transit» would ride the transit strip and the map of every later spec,
  // and two active clients the client book — so the trucks go to a terminal
  // state and the clients are retired, as money-doors' fixtures are.
  if (madeClients.length) {
    await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
    await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
    await db.update(clients).set({ active: false }).where(inArray(clients.id, madeClients));
  }
  if (madeBatches.length) {
    await db.update(batches).set({ status: 'cancelled' }).where(inArray(batches.id, madeBatches));
  }
  await db
    .delete(tnvedAssignments)
    .where(inArray(tnvedAssignments.productKey, [P.codeNeedle, P.codePast, P.headNeedle, P.headPast].map(productKey)));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

const lotOf = (zh: string, clientId: string) =>
  F.pageLots.find((lot) => lot.productNameZh === zh && lot.clientId === clientId)!;

async function historyFor(zh: string, clientId: string, actor = UNSCOPED): Promise<PriceHistory> {
  const all = await priceHistoryForLots(F.pageLots, F.t0.id, actor);
  return all.get(lotOf(zh, clientId).lotId)!;
}

describe('the list a person reads', () => {
  it('the page carries all six needles', () => {
    expect(F.pageLots).toHaveLength(6);
  });

  it('own client first, newest first, then the others newest first — five in all (16a, 28a)', async () => {
    const h = await historyFor(P.mouse, F.a);
    expect(h.failed).toBe(false);
    expect(h.rows.map((r) => r.batchId)).toEqual([
      F.t.a2!.id,
      F.t.a1!.id,
      F.t.b10!.id,
      F.t.b9!.id,
      F.t.b3!.id,
    ]);
    expect(h.rows.map((r) => r.own)).toEqual([true, true, false, false, false]);
    expect(h.rows.every((r) => r.match === 'exact')).toBe(true);
  });

  it('«own» is the NEEDLE\'s client: the same goods asked for B put B first', async () => {
    const h = await historyFor(P.mouse, F.b);
    expect(h.rows.map((r) => r.batchId)).toEqual([F.t.b10!.id, F.t.b9!.id, F.t.b3!.id, F.t.b11!.id, F.t.a2!.id]);
  });

  it('the price is the client\'s whole charge over the client\'s whole load aboard; two kinds = aralash', async () => {
    const h = await historyFor(P.mouse, F.a);
    const a1 = h.rows.find((r) => r.batchId === F.t.a1!.id)!;
    // Two cartons of 0.06 m³ / 20 kg (the mouse and the other goods), $1000.
    expect(a1.m3).toBe(0.12);
    expect(a1.kg).toBe(40);
    expect(a1.usdPerM3).toBe(8333.33);
    expect(a1.usdPerKg).toBe(25);
    expect(a1.kgPerM3).toBe(333);
    expect(a1.goodsKinds).toBe(2);
    const a2 = h.rows.find((r) => r.batchId === F.t.a2!.id)!;
    expect(a2.usdPerM3).toBe(5000);
    expect(a2.goodsKinds).toBe(1);
  });
});

describe('which trucks may lend a price', () => {
  it('not a 13-month-old truck, not this truck, not a void charge, not a truck that never left', async () => {
    const h = await historyFor(P.excl, F.a);
    const ids = h.rows.map((r) => r.batchId);
    for (const gone of [F.t.old!.id, F.t0.id, F.t.voided!.id, F.t.parked!.id]) expect(ids).not.toContain(gone);
    expect(ids.sort()).toEqual([F.t.far!.id, F.t.short!.id].sort());
  });

  it('a warehouse-scoped reader sees only trucks whose card they could open', async () => {
    const scoped = { warehouseScoped: true, warehouseIds: [W.yw, W.tas] };
    const h = await historyFor(P.excl, F.a, scoped);
    expect(h.rows.map((r) => r.batchId)).toEqual([F.t.short!.id]);
  });

  it('a price whose cargo was short-loaded after it was set is marked «partial»', async () => {
    const h = await historyFor(P.excl, F.a);
    const short = h.rows.find((r) => r.batchId === F.t.short!.id)!;
    expect(short.cargoMoved).toBe('partial');
    expect(h.rows.find((r) => r.batchId === F.t.far!.id)!.cargoMoved).toBeNull();
  });
});

describe('«the same goods»', () => {
  it('the same FULL 10-digit declaration code matches under another name', async () => {
    const h = await historyFor(P.codeNeedle, F.a);
    expect(h.rows.map((r) => [r.batchId, r.match])).toEqual([[F.t.code!.id, 'code']]);
  });

  it('a 4-digit heading shared by two names is NOT the same goods', async () => {
    const h = await historyFor(P.headNeedle, F.a);
    expect(h.rows.map((r) => r.batchId)).not.toContain(F.t.head!.id);
  });

  it('women\'s jackets never borrow men\'s price (#934/#936 — similarity, never word_similarity)', async () => {
    const h = await historyFor(P.jacketW, F.a);
    expect(h.rows.map((r) => r.batchId)).not.toContain(F.t.jacketM!.id);
  });
});

describe('the read the page runs', () => {
  it('productKeySql is productKey, whitespace and case (0119\'s index expression)', async () => {
    const samples = ['　鼠标\t 无线 ', ' 鼠标 ', '﻿鼠标', 'a b', 'Куртка  ЖЕН.', ' X Y Z '];
    for (const s of samples) {
      const [row] = await db.execute<{ k: string }>(sql`SELECT ${productKeySql(sql`${s}::text`)} AS k`);
      expect(row!.k, JSON.stringify(s)).toBe(productKey(s));
    }
  });

  it('EXPLAIN of the very statement reads the key index and both trigram indexes', async () => {
    const needles: Needle[] = [
      { key: productKey(P.jacketW), zh: P.jacketW, ru: 'Ayollar kurtkasi', code: CODE10, clientId: F.a },
    ];
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SELECT set_config('pg_trgm.similarity_threshold', '0.6', true)`);
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN ${historyPairsSql({ needles, pageLotIds: [F.pageLots[0]!.lotId], minSim: 0.6, batchId: F.t0.id, actor: UNSCOPED })}`,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('receipt_lots_product_key_idx');
    expect(plan).toContain('receipt_lots_ru_trgm_idx');
    expect(plan).toContain('receipt_lots_zh_trgm_idx');
  });
});

describe('the hint never holds the page (review, 2026-09-29)', () => {
  it('every statement under the ceiling is cut at it, not only the first', async () => {
    // Two statements in one ceiling: the first is quick, the SECOND is where a
    // wide truck spends its time (the riders walk, the off-truck read), and
    // the second is what the first version left unbounded.
    const started = Date.now();
    await expect(
      underCeiling(async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await tx.execute(sql`SELECT pg_sleep(${(HINT_STATEMENT_MS * 3) / 1000})`);
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(HINT_STATEMENT_MS * 2);
  });

  it('the ceiling is the transaction\'s, never the pooled connection\'s', async () => {
    await underCeiling(async (tx) => tx.execute(sql`SELECT 1`));
    const [row] = await db.execute<{ t: string }>(sql`SELECT current_setting('statement_timeout') AS t`);
    expect(row!.t).not.toBe(`${HINT_STATEMENT_MS}ms`);
  });

  it('the AI\'s rows name which picked lots reached THIS reader', async () => {
    // One lot on an in-scope truck, one on the Guangzhou→Andijan truck a
    // Yiwu-scoped reader cannot open: only the first may carry a reason.
    const [a1Lot] = await batchLots(F.t.a2!.id);
    const [farLot] = await batchLots(F.t.far!.id);
    const all = await pricedRowsForLots([a1Lot!.lotId, farLot!.lotId], F.t0.id, UNSCOPED, F.a);
    expect(all.failed).toBe(false);
    expect(new Set(all.reachedLotIds)).toEqual(new Set([a1Lot!.lotId, farLot!.lotId]));
    const scoped = { warehouseScoped: true, warehouseIds: [W.yw] };
    const some = await pricedRowsForLots([a1Lot!.lotId, farLot!.lotId], F.t0.id, scoped, F.a);
    expect(some.reachedLotIds).toEqual([a1Lot!.lotId]);
    expect(some.rows.map((r) => r.batchId)).toEqual([F.t.a2!.id]);
  });
});
