import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clientNotices,
  clientTransactions,
  clients,
  dealStages,
  deals,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';
import { batchLots } from '@/modules/wms/batches/lots';
import { addTransaction, batchCharges, batchTripCoverage } from '@/modules/wms/finance/service';
import { pricingChargesOf, pricingView, tripPriced, tripPricedCount } from '@/modules/wms/finance/pricing-view';
import { tripCoverageOn } from '@/modules/wms/finance/unpriced';
import { clientCargo } from '@/modules/wms/finance/client-cargo';

/**
 * «Narx qo'yilgan N / M» on the truck card and the «Narx» tab (owner's 1a,
 * 2026-09-28): a client whose cargo aboard is priced on ANOTHER truck, or on
 * the deal, counts as priced — the way the handover gate already lets that
 * cargo out. One truck carries five clients, each a different answer:
 *
 *   A — a price on this truck                         → priced
 *   B — the same prixod, split, priced on the other   → priced (answer 7)
 *   C — priced on the deal, no truck named            → priced (clause 1),
 *       although another prixod of C in Yiwu has no price — not aboard
 *   D — nothing                                       → not priced
 *   E — one prixod on a priced deal, one on nothing   → not priced (in part)
 *
 * The count must equal the CLIENT card's trip chip read from the other end
 * (`clientCargo` → `uncoveredTripsOn`), which walks the uncovered cartons to
 * their trucks instead of the truck's riders to their clients — the same
 * rule asked a different way, so a second writer of «priced» would show.
 *
 * Every step goes through the real doors (confirmReceipt, the plan, the
 * loading scans, departBatch, addTransaction). Money lives in 1661 (no other
 * file's year); warehouses are deactivated in cleanup, never deleted.
 */

const S = String(Date.now()).slice(-6);
const DAY = '1661-03-14';
let actorId: string;
let stageId: string;
const W: Record<'yw' | 'tas', string> = { yw: '', tas: '' };
const madeClients: string[] = [];
const madeDeals: string[] = [];
const ctx = () => ({ actorId });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Narx N/M ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let clientSeq = 0;
async function mkClient(tag: string) {
  clientSeq += 1;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `P${clientSeq}${tag}${S}`.slice(0, 10).toUpperCase(), name: `Narx N/M ${tag} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(row!.id);
  return row!.id;
}

let dealSeq = 0;
async function mkDeal(clientId: string) {
  dealSeq += 1;
  const [row] = await db
    .insert(deals)
    .values({ code: `PN${S}-${dealSeq}`, clientId, stageId, title: `Narx N/M bitim ${dealSeq}`, createdBy: actorId })
    .returning({ id: deals.id });
  madeDeals.push(row!.id);
  return row!.id;
}

async function mkLot(clientId: string, boxCount: number, dealId: string | null = null) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `narx-nm/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: W.yw,
      clientId,
      dealId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '定价',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 50,
          boxWidthCm: 40,
          boxHeightCm: 30,
          boxWeightKg: 20,
        },
      ],
      extraCosts: [],
    } as never,
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(boxes.seqInLot);
  return { receiptId, lotId, codes: rows.map((b) => b.shortCode) };
}

const scan = (batchId: string, code: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

/** Plan + approve + scan — a truck loading out of YW, not yet gone. */
async function loadTruck(lines: { lotId: string; take: number }[], codes: string[]) {
  const sub = await submitPlan(
    { originWarehouseId: W.yw, destWarehouseId: W.tas, lines: lines.map((l) => ({ lotId: l.lotId, boxCount: l.take })) } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  for (const code of codes) {
    const [ack] = await ingestLoadScans([scan(batch!.id, code)], ctx());
    if (ack!.result !== 'ok') throw new Error(`load ${code}: ${ack!.result} ${ack!.detail ?? ''}`);
  }
  return batch!;
}

async function truck(lines: { lotId: string; take: number }[], codes: string[]) {
  const batch = await loadTruck(lines, codes);
  await finishLoading(batch.id, ctx());
  await sleep(15);
  await departBatch(batch.id, ctx());
  return batch;
}

async function charge(clientId: string, amount: number, where: { batchId?: string; dealId?: string }) {
  return addTransaction(
    { clientId, type: 'charge', amount, currency: 'USD', txDate: DAY, batchId: where.batchId, dealId: where.dealId },
    ctx(),
  );
}

/** What the truck card and the «Narx» tab print: `pricingView` over the riders, counted through the rule. */
async function countOn(batchId: string) {
  const [lots, charges, coverage] = await Promise.all([batchLots(batchId), batchCharges(batchId), tripCoverageOn(db, batchId)]);
  const view = pricingView(lots, new Map(), pricingChargesOf(charges));
  return { view, coverage, priced: tripPricedCount(view.clients, coverage) };
}

const who: Record<'a' | 'b' | 'c' | 'd' | 'e' | 'g', string> = { a: '', b: '', c: '', d: '', e: '', g: '' };
let tripId = '';
let loadingId = '';

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  W.yw = await mintWarehouse(`QY${S}`, 'CN', 'origin');
  W.tas = await mintWarehouse(`QT${S}`, 'UZ', 'distribution');

  who.a = await mkClient('A');
  who.b = await mkClient('B');
  who.c = await mkClient('C');
  who.d = await mkClient('D');
  who.e = await mkClient('E');
  const la = await mkLot(who.a, 2);
  const lb = await mkLot(who.b, 4);
  const dealC = await mkDeal(who.c);
  const lc = await mkLot(who.c, 2, dealC);
  // …and C's OTHER prixod, on no deal, still standing in Yiwu: unpriced, but
  // not aboard — the count is per truck, as the trip chip is.
  await mkLot(who.c, 1);
  const ld = await mkLot(who.d, 1);
  const dealE = await mkDeal(who.e);
  const le1 = await mkLot(who.e, 1, dealE);
  const le2 = await mkLot(who.e, 1);

  // B's prixod goes in two halves: the first on truck P, priced there.
  const p = await truck([{ lotId: lb.lotId, take: 2 }], lb.codes.slice(0, 2));
  const t = await truck(
    [
      { lotId: la.lotId, take: 2 },
      { lotId: lb.lotId, take: 2 },
      { lotId: lc.lotId, take: 2 },
      { lotId: ld.lotId, take: 1 },
      { lotId: le1.lotId, take: 1 },
      { lotId: le2.lotId, take: 1 },
    ],
    [...la.codes, ...lb.codes.slice(2), ...lc.codes, ...ld.codes, ...le1.codes, ...le2.codes],
  );
  tripId = t.id;
  await charge(who.a, 300, { batchId: t.id });
  await charge(who.b, 500, { batchId: p.id });
  await charge(who.c, 400, { dealId: dealC });
  await charge(who.e, 100, { dealId: dealE });

  // G: a truck still LOADING, priced before it leaves.
  who.g = await mkClient('G');
  const lg = await mkLot(who.g, 1);
  const l = await loadTruck([{ lotId: lg.lotId, take: 1 }], lg.codes);
  loadingId = l.id;
  await charge(who.g, 150, { batchId: l.id });
});

afterAll(async () => {
  if (madeClients.length) {
    await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
    await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
  }
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('«Narx qo‘yilgan N / M» — the unpriced rule, counted per truck (1a)', () => {
  it('counts the price on this truck, on the other half of the prixod and on the deal; not the unpriced or the part-priced', async () => {
    const { view, coverage, priced } = await countOn(tripId);
    expect(view.clients.map((group) => group.clientId).sort()).toEqual(
      [who.a, who.b, who.c, who.d, who.e].sort(),
    );
    const pricedIds = view.clients.filter((group) => tripPriced(group, coverage)).map((group) => group.clientId);
    expect(pricedIds.sort()).toEqual([who.a, who.b, who.c].sort());
    // A literal, not a recount: three of five.
    expect(priced).toBe(3);
    // The charge-only count this replaces said one.
    expect(view.clients.filter((group) => group.chargedUsd > 0)).toHaveLength(1);
  });

  it('agrees with the client card’s trip chip, which asks the same rule from the other end', async () => {
    const { view, coverage } = await countOn(tripId);
    for (const group of view.clients) {
      const trip = (await clientCargo(group.clientId)).trips.find((row) => row.batchId === tripId)!;
      expect(trip, group.code).toBeDefined();
      // The chip: «narx qo'yilmagan» when the rule finds an uncovered carton,
      // «narx boshqa reysda yoki bitimda» when it does not and nothing is
      // charged here, the price itself when something is.
      const chipPriced = trip.chargedUsd > 0 || !trip.unpriced;
      expect(tripPriced(group, coverage), group.code).toBe(chipPriced);
    }
  });

  it('keeps a price typed before departure counted, though the rule does not let it cover yet (Q21)', async () => {
    const { coverage, priced, view } = await countOn(loadingId);
    expect(view.clients.map((group) => group.clientId)).toEqual([who.g]);
    // The live pointer never covers — the rule still calls G's carton unpriced…
    expect(coverage.unpriced.has(who.g)).toBe(true);
    // …and the accountant's own price on the screen above reads as a price.
    expect(priced).toBe(1);
  });

  it('the cached read the card and the tab share answers the rule itself', async () => {
    const [cached, direct] = await Promise.all([batchTripCoverage(tripId), tripCoverageOn(db, tripId)]);
    expect([...cached.unpriced].sort()).toEqual([...direct.unpriced].sort());
    expect([...cached.covered].sort()).toEqual([...direct.covered].sort());
    expect([...direct.unpriced].sort()).toEqual([who.d, who.e].sort());
    expect([...direct.covered].sort()).toEqual([who.a, who.b, who.c, who.e].sort());
  });
});
