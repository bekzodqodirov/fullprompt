import 'dotenv/config';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxMovements,
  boxes,
  clientNotices,
  clientTransactions,
  clients,
  dealStages,
  deals,
  handovers,
  issueApprovals,
  notifications,
  roles,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';
import { finishUnload, ingestUnloadScans } from '@/modules/wms/scanning/unload';
import { acceptFoundBox } from '@/modules/wms/inventory/service';
import { IssueError, issueBoxes } from '@/modules/wms/issue/service';
import {
  ApprovalError,
  approvalRecipients,
  approvalStateFor,
  decideIssueApproval,
  lockLiveApproval,
  pendingApprovals,
  requestIssueApproval,
} from '@/modules/wms/issue/approvals';
import { approvalCovers } from '@/modules/wms/issue/approval-covers';
import { addTransaction, voidTransaction } from '@/modules/wms/finance/service';
import {
  unattachedChargesByClient,
  uncoveredBoxesOn,
  unpricedGate,
  unpricedReceiptsOn,
  type GateSince,
} from '@/modules/wms/finance/unpriced';
import { unbilledArrived } from '@/modules/wms/reports/business';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { approvalCounts } from '@/modules/wms/reports/dashboard-math';
import { withoutJit } from '@/modules/platform/db/no-jit';

/**
 * «Narx qo'yilmagan yuk» — the ONE rule behind the handover ban, the
 * accountant's list and the dashboard (the owner's 2026-09-25 answers: Q3b
 * the ban, Q4c all history, Q2 the found-back carton, Q1 the local leg,
 * answer 7 the split prixod), and the approval that answers both questions a
 * counter can ask.
 *
 * Every step goes through the real doors — confirmReceipt, the plan and its
 * verdict, the loading scans, departBatch, the unload scans, finishUnload,
 * acceptFoundBox, addTransaction, issueBoxes, the approval service — because
 * each clause here is a disagreement between two correct halves about
 * membership.
 *
 * Money lives in 1613 (no other file's year). The ban's instant is the
 * migration's own moment, so every landing here is after it and gated; a
 * carton that must sit BEFORE it has its own landing rows moved to 2020 by
 * a direct UPDATE. This file never writes a global setting (#183).
 */

const S = String(Date.now()).slice(-6);
const DAY = '1613-06-10';
let actorId: string;
let stageId: string;
let gate: GateSince;
const W: Record<'yw' | 'and' | 'tas', string> = { yw: '', and: '', tas: '' };
const madeClients: string[] = [];
const madeDeals: string[] = [];
const ctx = () => ({ actorId });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = new Date();

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Narxsiz ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let clientSeq = 0;
async function mkClient(tag: string, salesManagerId: string | null = null) {
  clientSeq += 1;
  const [row] = await db
    .insert(clients)
    .values({
      clientCode: `N${clientSeq}${tag}${S}`.slice(0, 10).toUpperCase(),
      name: `Narxsiz ${tag} ${S}`,
      salesManagerId,
    })
    .returning({ id: clients.id });
  madeClients.push(row!.id);
  return row!.id;
}

let dealSeq = 0;
async function mkDeal(clientId: string) {
  dealSeq += 1;
  const [row] = await db
    .insert(deals)
    .values({ code: `NX${S}-${dealSeq}`, clientId, stageId, title: `Narxsiz bitim ${dealSeq}`, createdBy: actorId })
    .returning({ id: deals.id });
  madeDeals.push(row!.id);
  return row!.id;
}

async function mkLot(clientId: string, boxCount: number, warehouseId: string, dealId: string | null = null) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `narxsiz/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      dealId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '无价货',
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
  return { receiptId, lotId, boxIds: rows.map((b) => b.id), codes: rows.map((b) => b.shortCode) };
}

const scan = (batchId: string, code: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

/** Plan + approve + scan `codes` — the truck is planned/loading, not yet departed. */
async function loadTruck(lines: { lotId: string; take: number }[], codes: string[], origin: string, dest: string) {
  const sub = await submitPlan(
    { originWarehouseId: origin, destWarehouseId: dest, lines: lines.map((l) => ({ lotId: l.lotId, boxCount: l.take })) } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  for (const code of codes) {
    const [ack] = await ingestLoadScans([scan(batch!.id, code)], ctx());
    if (ack!.result !== 'ok') throw new Error(`load ${code}: ${ack!.result} ${ack!.detail ?? ''}`);
  }
  return batch!;
}

async function depart(batchId: string) {
  await finishLoading(batchId, ctx());
  await sleep(15);
  await departBatch(batchId, ctx());
}

async function truck(lines: { lotId: string; take: number }[], codes: string[], origin: string, dest: string) {
  const batch = await loadTruck(lines, codes, origin, dest);
  await depart(batch.id);
  return batch;
}

async function unload(batchId: string, codes: string[]) {
  for (const code of codes) await ingestUnloadScans([scan(batchId, code)], ctx());
  await finishUnload(batchId, ctx(), { mayCloseWithMissing: true });
}

async function charge(
  clientId: string,
  amount: number,
  where: { batchId?: string; dealId?: string; txDate?: string } = {},
) {
  return addTransaction(
    {
      clientId,
      type: 'charge',
      amount,
      currency: 'USD',
      txDate: where.txDate ?? DAY,
      batchId: where.batchId,
      dealId: where.dealId,
    },
    ctx(),
  );
}

/**
 * A handover through the real door. A price is a DEBT the moment it is typed,
 * so the debt gate would answer first for every priced client here; it is its
 * own question with its own tests (finance, issue-approvals), so this file
 * ticks it by default and asks the PRICE question alone — the composition
 * case passes `debtOk: false` on purpose.
 */
async function issue(
  clientId: string,
  warehouseId: string,
  boxIds: string[],
  opts: { priceOk?: boolean; debtOk?: boolean; handoverId?: string } = {},
): Promise<string> {
  try {
    await issueBoxes(
      {
        handoverId: opts.handoverId ?? uuidv4(),
        clientId,
        warehouseId,
        boxIds,
        personName: 'Oluvchi',
        personPhone: '+998901112233',
        debtOk: opts.debtOk ?? true,
        priceOk: opts.priceOk ?? false,
      },
      ctx(),
    );
    return 'ok';
  } catch (err) {
    if (err instanceof IssueError) return err.code;
    throw err;
  }
}

async function listed(clientIds: string[]) {
  return unpricedReceiptsOn(db, { kind: 'clients', clientIds }, gate);
}

async function uncovered(clientId: string) {
  return uncoveredBoxesOn(db, { kind: 'client', clientId }, { landedOnly: true });
}

async function approve(approvalId: string) {
  await decideIssueApproval({ approvalId, verdict: 'approved' }, ctx());
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  gate = await unpricedGate();
  W.yw = await mintWarehouse(`NY${S}`, 'CN', 'origin');
  // A hub, so cargo lands `in_stock` and can be planned onward to Tashkent.
  W.and = await mintWarehouse(`NA${S}`, 'UZ', 'hub');
  W.tas = await mintWarehouse(`NT${S}`, 'UZ', 'distribution');
});

afterAll(async () => {
  // Money first (all of it this file's clients'), then the approvals, then
  // the configuration: a warehouse an audited action touched is DEACTIVATED,
  // never deleted (audit_log FK). The cargo stays, as in m4-unload.
  if (madeClients.length) {
    await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
    // Every unload here claims a «yukingiz keldi» row for a fixture client:
    // left pending they are the notice drain's input for every later file,
    // and its queue is capped (arrival-staff and client-notices read the
    // first 200). Data this file made, gone with it.
    await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
    await db
      .update(issueApprovals)
      .set({ status: 'refused', expiresAt: null, decidedBy: actorId, decidedAt: new Date() })
      .where(and(inArray(issueApprovals.clientId, madeClients), inArray(issueApprovals.status, ['pending', 'approved'])));
  }
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('the rule — which cargo has a price', () => {
  it('S1: a price on the truck covers its own client, and not a neighbour on the same truck', async () => {
    expect(gate.state).toBe('on');
    const x = await mkClient('A');
    const y = await mkClient('B');
    const a1 = await mkLot(x, 2, W.yw);
    const a2 = await mkLot(y, 3, W.yw);
    const t = await truck(
      [
        { lotId: a1.lotId, take: 2 },
        { lotId: a2.lotId, take: 3 },
      ],
      [...a1.codes, ...a2.codes],
      W.yw,
      W.tas,
    );
    await unload(t.id, [...a1.codes, ...a2.codes]);
    await charge(x, 600, { batchId: t.id });

    const rows = await listed([x, y]);
    expect(rows.map((r) => r.receiptId)).toEqual([a2.receiptId]);
    expect(rows[0]).toMatchObject({ boxes: 3, issuedBoxes: 0, gatedBoxes: 3, walkIn: false });
    expect(rows[0]!.arrivalTrucks.map((truckRow) => truckRow.batchId)).toEqual([t.id]);

    // The ban at the counter: Y's cargo has no price and landed by road.
    expect(await issue(y, W.tas, a2.boxIds)).toBe('price_block');
    // X's is priced and goes.
    expect(await issue(x, W.tas, a1.boxIds)).toBe('ok');
  });

  it('S3: a prixod split over two cross-border trucks, priced once, is covered whole (answer 7)', async () => {
    const z = await mkClient('C');
    const p = await mkLot(z, 4, W.yw);
    const t1 = await truck([{ lotId: p.lotId, take: 2 }], p.codes.slice(0, 2), W.yw, W.tas);
    const t2 = await truck([{ lotId: p.lotId, take: 2 }], p.codes.slice(2), W.yw, W.tas);
    await unload(t1.id, p.codes.slice(0, 2));
    await unload(t2.id, p.codes.slice(2));
    await charge(z, 800, { batchId: t1.id });

    expect(await listed([z])).toEqual([]);
    expect(await issue(z, W.tas, p.boxIds)).toBe('ok');
  });

  it('a charge on the prixod’s DEAL covers it', async () => {
    const c = await mkClient('D');
    const dealId = await mkDeal(c);
    const p = await mkLot(c, 2, W.yw, dealId);
    const t = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.tas);
    await unload(t.id, p.codes);
    expect(await listed([c])).toHaveLength(1);
    await charge(c, 300, { dealId });
    expect(await listed([c])).toEqual([]);
  });

  it('a card-only charge covers nothing, and is reported per client once', async () => {
    const c = await mkClient('E');
    const p = await mkLot(c, 2, W.yw);
    const q = await mkLot(c, 1, W.yw);
    const r = await mkLot(c, 1, W.yw);
    const t = await truck(
      [
        { lotId: p.lotId, take: 2 },
        { lotId: q.lotId, take: 1 },
        { lotId: r.lotId, take: 1 },
      ],
      [...p.codes, ...q.codes, ...r.codes],
      W.yw,
      W.tas,
    );
    await unload(t.id, [...p.codes, ...q.codes, ...r.codes]);
    // A storage fee typed on the card after the cargo — no truck, no deal.
    // Dated today: a card charge dated before the oldest unpriced prixod was
    // for older cargo and is not counted against this one.
    await charge(c, 50, { txDate: tashkentDay() });

    expect((await listed([c])).map((row) => row.receiptId).sort()).toEqual(
      [p.receiptId, q.receiptId, r.receiptId].sort(),
    );
    expect(await issue(c, W.tas, p.boxIds)).toBe('price_block');
    // Case 20: ONE $50, not $50 per unpriced prixod.
    expect((await unattachedChargesByClient(db, [c])).get(c)).toEqual({ cardOnlyUsd: 50, elsewhereUsd: 0 });
  });
});

describe('U25 — a carton that rode without a load scan', () => {
  it('is its truck’s cargo for the price too: the truck’s price covers it, on the list and at the counter', async () => {
    // The rider rule's second arm (`undocumented_transfer`): planned, missed
    // by the scanner, short-loaded back to the shelf — and on the truck
    // anyway, landed by the unload scan. The dashboard's old `rides` read
    // `batch_departed` only, so this truck's price never covered it there
    // while the pricing page and the client card counted it aboard.
    const u = await mkClient('Y');
    const v = await mkClient('Z');
    const lu = await mkLot(u, 1, W.yw);
    const lv = await mkLot(v, 1, W.yw);
    const e = await truck(
      [
        { lotId: lv.lotId, take: 1 },
        { lotId: lu.lotId, take: 1 },
      ],
      lv.codes,
      W.yw,
      W.tas,
    );
    for (const code of [...lv.codes, ...lu.codes]) await ingestUnloadScans([scan(e.id, code)], ctx());
    await finishUnload(e.id, ctx(), { mayCloseWithMissing: true });
    const [landing] = await db
      .select({ cause: boxMovements.cause })
      .from(boxMovements)
      .where(and(eq(boxMovements.boxId, lu.boxIds[0]!), eq(boxMovements.toWarehouseId, W.tas)));
    expect(landing!.cause).toBe('undocumented_transfer');

    // Aboard for the price door (the rider rule), so the price is taken…
    await charge(u, 90, { batchId: e.id });
    // …and it covers the carton everywhere the rule is asked.
    expect(await listed([u])).toEqual([]);
    expect((await unbilledArrived()).some((row) => row.clientId === u)).toBe(false);
    expect(await issue(u, W.tas, lu.boxIds)).toBe('ok');
  });
});

describe('Q2 — a carton scanned onto A and found back at the origin', () => {
  /** 5 cartons scanned onto A; the fifth is found back at Yiwu and rides B. */
  async function fourPlusOne(tag: string, priceA: 'before_find' | 'after_find') {
    const c = await mkClient(tag);
    const p = await mkLot(c, 5, W.yw);
    const a = await loadTruck([{ lotId: p.lotId, take: 5 }], p.codes, W.yw, W.tas);
    await depart(a.id);
    const priced = priceA === 'before_find' ? await charge(c, 600, { batchId: a.id }) : null;
    await acceptFoundBox({ warehouseId: W.yw, code: p.codes[4]! }, ctx());
    const after = priceA === 'after_find' ? await charge(c, 600, { batchId: a.id }) : null;
    await unload(a.id, p.codes.slice(0, 4));
    const b = await truck([{ lotId: p.lotId, take: 1 }], [p.codes[4]!], W.yw, W.tas);
    await unload(b.id, [p.codes[4]!]);
    return { c, p, a, b, priceTx: (priced ?? after)! };
  }

  it('(a) A priced AFTER the find: the found carton is listed and refused as unpriced — B is where it is priced', async () => {
    const { c, p, a, b } = await fourPlusOne('F', 'after_find');
    const rows = await listed([c]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ receiptId: p.receiptId, boxes: 1, gatedBoxes: 1 });
    // The price on A was typed seeing A without this carton: it is right
    // where it is, so the carton is NOT «priced on another truck».
    expect(rows[0]!.elsewhere).toEqual([]);
    expect(rows[0]!.arrivalTrucks.map((t) => t.batchId)).toEqual([b.id]);
    expect(await issue(c, W.tas, [p.boxIds[4]!])).toBe('price_block');
    // The four that rode A are covered by A's price.
    expect(await issue(c, W.tas, p.boxIds.slice(0, 4))).toBe('ok');
    // Priced on B → covered.
    await charge(c, 150, { batchId: b.id });
    expect(await listed([c])).toEqual([]);
    void a;
  });

  it('(b) A priced BEFORE the find: listed with «narx A da», refused price_elsewhere; void + re-enter clears the tag', async () => {
    const { c, p, a, b, priceTx } = await fourPlusOne('G', 'before_find');
    let rows = await listed([c]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.elsewhere).toEqual([{ batchId: a.id, code: a.code, usd: 600 }]);
    expect(await issue(c, W.tas, [p.boxIds[4]!])).toBe('price_elsewhere');
    expect((await unattachedChargesByClient(db, [c])).get(c)).toEqual({ cardOnlyUsd: 0, elsewhereUsd: 600 });

    // The accountant voids and re-enters A's price after the find: still
    // listed, no longer «on another truck».
    await voidTransaction(priceTx.id, 'qayta', ctx(), { mayMoveTill: true });
    await charge(c, 480, { batchId: a.id });
    rows = await listed([c]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.elsewhere).toEqual([]);
    expect(await issue(c, W.tas, [p.boxIds[4]!])).toBe('price_block');

    await charge(c, 120, { batchId: b.id });
    expect(await listed([c])).toEqual([]);
  });
});

describe('Q1 — a local leg’s price does not cover cargo that came from China', () => {
  it('Yiwu → Andijan unpriced, Andijan → Tashkent priced (with the deal stamp): still listed and gated', async () => {
    const l = await mkClient('H');
    const dealId = await mkDeal(l);
    const p = await mkLot(l, 2, W.yw, dealId);
    const cross = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.and);
    await unload(cross.id, p.codes);

    // A prixod received IN Uzbekistan riding the same local truck.
    const m = await mkClient('I');
    const u = await mkLot(m, 1, W.and);

    const local = await truck(
      [
        { lotId: p.lotId, take: 2 },
        { lotId: u.lotId, take: 1 },
      ],
      [...p.codes, ...u.codes],
      W.and,
      W.tas,
    );
    await unload(local.id, [...p.codes, ...u.codes]);
    const priced = await charge(l, 36, { batchId: local.id });
    // R3a stamped the prixod's deal onto the local-leg price.
    expect(priced.dealId).toBe(dealId);
    await charge(m, 20, { batchId: local.id });

    const rows = await listed([l, m]);
    expect(rows.map((r) => r.receiptId)).toEqual([p.receiptId]);
    expect(rows[0]!.elsewhere.map((e) => e.batchId)).toEqual([local.id]);
    expect(rows[0]!.arrivalTrucks.map((t) => t.batchId)).toEqual([cross.id]);
    expect(await issue(l, W.tas, p.boxIds)).toBe('price_elsewhere');
    // The Uzbek-received prixod IS covered by the same truck's price.
    expect(await issue(m, W.tas, u.boxIds)).toBe('ok');
  });
});

describe('who is gated', () => {
  it('a walk-in is listed as «reyssiz» and never gated; carried onward by a priced local truck it is covered', async () => {
    const n = await mkClient('J');
    const walk = await mkLot(n, 2, W.tas);
    let rows = await listed([n]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ walkIn: true, gatedBoxes: 0 });
    expect(await issue(n, W.tas, walk.boxIds)).toBe('ok');

    const atAnd = await mkLot(n, 1, W.and);
    const t = await truck([{ lotId: atAnd.lotId, take: 1 }], atAnd.codes, W.and, W.tas);
    await unload(t.id, atAnd.codes);
    rows = await listed([n]);
    // Received at Andijan (a walk-in there), carried by OUR truck: gated.
    expect(rows.find((r) => r.receiptId === atAnd.receiptId)).toMatchObject({ walkIn: false, gatedBoxes: 1 });
    await charge(n, 15, { batchId: t.id });
    expect((await listed([n])).find((r) => r.receiptId === atAnd.receiptId)).toBeUndefined();
  });

  it('the live pointer does not cover: a price on the truck still loading tags the landed half, departure covers it', async () => {
    const c = await mkClient('K');
    const p = await mkLot(c, 4, W.yw);
    const t1 = await truck([{ lotId: p.lotId, take: 2 }], p.codes.slice(0, 2), W.yw, W.tas);
    await unload(t1.id, p.codes.slice(0, 2));
    const t2 = await loadTruck([{ lotId: p.lotId, take: 2 }], p.codes.slice(2), W.yw, W.tas);
    await charge(c, 900, { batchId: t2.id });

    const rows = await listed([c]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ boxes: 2, gatedBoxes: 2 });
    expect(rows[0]!.elsewhere.map((e) => e.batchId)).toEqual([t2.id]);
    expect(await issue(c, W.tas, p.boxIds.slice(0, 2))).toBe('price_elsewhere');

    await depart(t2.id);
    expect(await listed([c])).toEqual([]);
  });

  it('the ban starts at its instant: the same carton landed before it goes, landed after it is refused', async () => {
    const c = await mkClient('L');
    const p = await mkLot(c, 2, W.yw);
    const t = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.tas);
    await unload(t.id, p.codes);
    // The first carton's landing moved before the instant.
    await db.execute(sql`
      UPDATE box_movements SET created_at = '2020-01-01T00:00:00Z'
       WHERE box_id = ${p.boxIds[0]!} AND to_warehouse_id = ${W.tas}
    `);
    const rows = await listed([c]);
    expect(rows[0]).toMatchObject({ boxes: 2, gatedBoxes: 1 });
    expect(await issue(c, W.tas, [p.boxIds[0]!])).toBe('ok');
    expect(await issue(c, W.tas, [p.boxIds[1]!])).toBe('price_block');
  });

  it('a replay is never refused, whatever the tick says', async () => {
    const c = await mkClient('M');
    const p = await mkLot(c, 1, W.yw);
    const t = await truck([{ lotId: p.lotId, take: 1 }], p.codes, W.yw, W.tas);
    await unload(t.id, p.codes);
    const handoverId = uuidv4();
    expect(await issue(c, W.tas, p.boxIds, { priceOk: true, handoverId })).toBe('ok');
    const [row] = await db.select().from(handovers).where(eq(handovers.id, handoverId));
    expect(row!.priceOk).toBe(true);
    expect(await issue(c, W.tas, p.boxIds, { priceOk: false, handoverId })).toBe('ok');
  });

  it('Q21 with no deal: priced while planned, every carton short-loaded, rides the next truck → «narx T da»', async () => {
    const c = await mkClient('N');
    const p = await mkLot(c, 2, W.yw);
    // Another client's carton, so the truck has something to leave with.
    const filler = await mkLot(await mkClient('O'), 1, W.yw);
    // Planned on T, priced, loaded with nothing of it: finishLoading short-loads both.
    const t = await loadTruck(
      [
        { lotId: p.lotId, take: 2 },
        { lotId: filler.lotId, take: 1 },
      ],
      filler.codes,
      W.yw,
      W.tas,
    );
    await charge(c, 600, { batchId: t.id });
    await depart(t.id);
    const t2 = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.tas);
    await unload(t2.id, p.codes);

    const rows = await listed([c]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.elsewhere).toEqual([{ batchId: t.id, code: t.code, usd: 600 }]);
    expect(await issue(c, W.tas, p.boxIds)).toBe('price_elsewhere');
    expect((await unattachedChargesByClient(db, [c])).get(c)).toEqual({ cardOnlyUsd: 0, elsewhereUsd: 600 });
  });

  it('Q21 with a deal on the prixod and none on the price: the short-loaded prixod is NOT covered (U03 money judge 1)', async () => {
    // The prixod carries a deal; the client's other prixod on the same truck
    // carries none, so R3a stamps no deal onto the price (two deals aboard,
    // `soleDealOf` answers null). The deal clause then compared a deal with
    // NULL — «true AND NULL» — and a NULL `names` fell through the CASE to
    // «covered»: the counter let the unpriced cartons out and the list never
    // showed them.
    const c = await mkClient('DN');
    const dealId = await mkDeal(c);
    const p = await mkLot(c, 2, W.yw, dealId);
    const q = await mkLot(c, 1, W.yw);
    const filler = await mkLot(await mkClient('DO'), 1, W.yw);
    const t = await loadTruck(
      [
        { lotId: p.lotId, take: 2 },
        { lotId: q.lotId, take: 1 },
        { lotId: filler.lotId, take: 1 },
      ],
      [...q.codes, ...filler.codes],
      W.yw,
      W.tas,
    );
    const priced = await charge(c, 900, { batchId: t.id });
    expect(priced.dealId).toBeNull();
    await depart(t.id);
    const t2 = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.tas);
    await unload(t2.id, p.codes);

    // The counter first: this is the door that let the cargo out.
    expect(await issue(c, W.tas, p.boxIds)).toBe('price_elsewhere');
    const rows = await listed([c]);
    expect(rows.map((r) => r.receiptId)).toEqual([p.receiptId]);
    expect(rows[0]!.elsewhere).toEqual([{ batchId: t.id, code: t.code, usd: 900 }]);
  });
});

describe('one approval, two questions', () => {
  async function landed(tag: string, n = 2) {
    const c = await mkClient(tag);
    const p = await mkLot(c, n, W.yw);
    const t = await truck([{ lotId: p.lotId, take: n }], p.codes, W.yw, W.tas);
    await unload(t.id, p.codes);
    return { c, p, t };
  }

  it('the snapshot is of CARTONS: an approval spends once, and a carton landed later is a new question', async () => {
    const { c, p } = await landed('P', 3);
    // Two of the three land; the third is still ours to land later — take it
    // out of the counter by moving it before the question is asked.
    await db.update(boxes).set({ currentWarehouseId: W.yw, status: 'in_stock' }).where(eq(boxes.id, p.boxIds[2]!));
    const { id } = await requestIssueApproval({ clientId: c, warehouseId: W.tas }, ctx());
    const [row] = await db.select().from(issueApprovals).where(eq(issueApprovals.id, id));
    expect(row!.unpricedBoxIds.sort()).toEqual(p.boxIds.slice(0, 2).sort());
    expect(Number(row!.blockingDebtUsd)).toBe(0);
    await approve(id);

    // The third carton comes back to this counter while the approval is
    // still LIVE: the decider never saw it, so the approval does not cover
    // it — alone, or riding along with the two it does name.
    await db
      .update(boxes)
      .set({ currentWarehouseId: W.tas, status: 'ready_for_pickup' })
      .where(eq(boxes.id, p.boxIds[2]!));
    expect(await issue(c, W.tas, [p.boxIds[2]!])).toBe('price_block');
    expect(await issue(c, W.tas, p.boxIds)).toBe('price_block');

    // The two it named go, once, and spend it.
    expect(await issue(c, W.tas, p.boxIds.slice(0, 2))).toBe('ok');
    const [spent] = await db.select().from(issueApprovals).where(eq(issueApprovals.id, id));
    expect(spent!.status).toBe('consumed');
    expect(await issue(c, W.tas, [p.boxIds[2]!])).toBe('price_block');
  });

  it('a stale approval does not lock the operator out, and the screen still sees it', async () => {
    const { c, p } = await landed('Q', 1);
    const first = await requestIssueApproval({ clientId: c, warehouseId: W.tas }, ctx());
    await approve(first.id);
    expect(await requestIssueApproval({ clientId: c, warehouseId: W.tas }, ctx()).catch((e: ApprovalError) => e.code)).toBe(
      'already_approved',
    );
    // A debt appears after the approval: the old row no longer covers.
    await charge(c, 40);
    const state = await approvalStateFor(c, W.tas);
    expect(state).toMatchObject({ id: first.id, status: 'approved', unpricedBoxIds: p.boxIds });
    expect(approvalCovers(state!, { debtUsd: 40, boxIds: p.boxIds })).toBe(false);
    const second = await requestIssueApproval({ clientId: c, warehouseId: W.tas }, ctx());
    expect(second.id).not.toBe(first.id);
  });

  it('debt + price compose: each tick answers its own question, one approval answers both', async () => {
    const { c, p } = await landed('R', 1);
    await charge(c, 70);
    expect(await issue(c, W.tas, p.boxIds, { debtOk: true })).toBe('price_block');
    expect(await issue(c, W.tas, p.boxIds, { debtOk: false, priceOk: true })).toBe('debt_block');
    expect(await issue(c, W.tas, p.boxIds, { debtOk: false })).toBe('debt_price_block');

    const { id } = await requestIssueApproval({ clientId: c, warehouseId: W.tas }, ctx());
    await approve(id);
    const handoverId = uuidv4();
    expect(await issue(c, W.tas, p.boxIds, { debtOk: false, handoverId })).toBe('ok');
    const [h] = await db.select().from(handovers).where(eq(handovers.id, handoverId));
    expect(h).toMatchObject({ priceOk: false, debtOk: false });
    const audit = (await db.execute<{ after: Record<string, unknown> }>(sql`
      SELECT after FROM audit_log WHERE entity_type = 'handover' AND entity_id = ${handoverId}
    `))[0]!;
    expect(audit.after).toMatchObject({ approvalId: id, unpriced: { receiptIds: [p.receiptId], boxes: 1 } });
  });

  it('nothing to ask → nothing_to_approve; a price-only ask by a client in advance stores 0, not the advance', async () => {
    const n = await mkClient('S');
    await expect(requestIssueApproval({ clientId: n, warehouseId: W.tas }, ctx())).rejects.toMatchObject({
      code: 'nothing_to_approve',
    });

    const { c } = await landed('T', 1);
    await addTransaction(
      { clientId: c, type: 'payment', amount: 300, currency: 'USD', method: 'cash', txDate: DAY },
      ctx(),
    );
    const before = approvalCounts(await pendingApprovals());
    const { id } = await requestIssueApproval({ clientId: c, warehouseId: W.tas }, ctx());
    const [row] = await db.select().from(issueApprovals).where(eq(issueApprovals.id, id));
    expect(Number(row!.blockingDebtUsd)).toBe(0);
    const after = approvalCounts(await pendingApprovals());
    expect(after.debt).toEqual(before.debt);
    expect(after.price.n).toBe(before.price.n + 1);
  });

  it('the screen’s twin and the server’s agree over a matrix of snapshots and questions', async () => {
    const { c, p } = await landed('U', 2);
    const [b1, b2] = p.boxIds as [string, string];
    const snapshots = [
      { debt: 100, boxes: [] as string[] },
      { debt: 0, boxes: [b1] },
      { debt: 0, boxes: [b1, b2] },
      { debt: 50, boxes: [b1, b2] },
      { debt: 49.995, boxes: [b2] },
      { debt: 200, boxes: [b1] },
    ];
    const questions = [
      { debtUsd: 100, boxIds: [] as string[] },
      { debtUsd: null, boxIds: [b1] },
      { debtUsd: null, boxIds: [b1, b2] },
      { debtUsd: 50, boxIds: [b2] },
      { debtUsd: 150, boxIds: [b1] },
    ];
    for (const snap of snapshots) {
      const [row] = await db
        .insert(issueApprovals)
        .values({
          clientId: c,
          warehouseId: W.tas,
          blockingDebtUsd: String(snap.debt),
          unpricedBoxIds: snap.boxes,
          requestedBy: actorId,
          status: 'approved',
          decidedBy: actorId,
          decidedAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning();
      for (const q of questions) {
        // The JS side reads the row as STORED (numeric(14,2) rounds 49.995).
        const js = approvalCovers(
          {
            status: row!.status,
            expiresAt: row!.expiresAt,
            blockingDebtUsd: Number(row!.blockingDebtUsd),
            unpricedBoxIds: row!.unpricedBoxIds,
          },
          q,
        );
        const sqlSide = await db.transaction(async (tx) => {
          const found = await lockLiveApproval(tx, { clientId: c, warehouseId: W.tas, question: q });
          return found === row!.id;
        });
        expect([snap, q, sqlSide]).toEqual([snap, q, js]);
      }
      await db.update(issueApprovals).set({ status: 'refused', expiresAt: null }).where(eq(issueApprovals.id, row!.id));
    }
  });

  it('cargo with no price that went out is told to the accountant — once, not on a replay', async () => {
    const { c, p } = await landed('V', 1);
    const handoverId = uuidv4();
    expect(await issue(c, W.tas, p.boxIds, { priceOk: true, handoverId })).toBe('ok');
    const code = (await db.query.clients.findFirst({ where: eq(clients.id, c) }))!.clientCode;
    const told = async () =>
      (
        await db
          .select({ payload: notifications.payload })
          .from(notifications)
          .where(and(eq(notifications.type, 'UnpricedIssued'), gte(notifications.createdAt, startedAt)))
      ).filter((n) => String((n.payload as { text?: string }).text ?? '').includes(code));
    const first = (await told()).length;
    expect(first).toBeGreaterThan(0);
    expect(await issue(c, W.tas, p.boxIds, { priceOk: true, handoverId })).toBe('ok');
    expect((await told()).length).toBe(first);
  });

  it('the ask reaches the client’s own seller and the accountant, and not a seller of another client', async () => {
    const seller = (
      await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(roles.code, 'sales_manager'), eq(users.active, true)))
        .limit(1)
    )[0]!.id;
    const accountant = (
      await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(roles.code, 'accountant'), eq(users.active, true)))
        .limit(1)
    )[0]!.id;
    const own = await mkClient('W', seller);
    const foreign = await mkClient('X', null);
    expect(await approvalRecipients(own)).toEqual(expect.arrayContaining([seller, accountant]));
    const forForeign = await approvalRecipients(foreign);
    expect(forForeign).toContain(accountant);
    expect(forForeign).not.toContain(seller);
  });
});

describe('one predicate (#513)', () => {
  it('the dashboard’s list is the accountant’s list grouped by client, and the gate refuses exactly its gated cartons', async () => {
    const all = await unpricedReceiptsOn(
      db,
      { kind: 'company', warehouseIds: undefined, ownerId: undefined, landedFrom: undefined },
      gate,
    );
    const mine = new Set(madeClients);
    const perClient = new Map<string, { receipts: number; boxes: number; issued: number }>();
    for (const r of all.filter((row) => mine.has(row.clientId))) {
      const prev = perClient.get(r.clientId) ?? { receipts: 0, boxes: 0, issued: 0 };
      perClient.set(r.clientId, {
        receipts: prev.receipts + 1,
        boxes: prev.boxes + r.boxes,
        issued: prev.issued + r.issuedBoxes,
      });
    }
    const dashboard = (await unbilledArrived()).filter((row) => mine.has(row.clientId));
    // Not vacuous: this runs after the cases above left their cargo behind.
    expect(perClient.size).toBeGreaterThan(3);
    expect(dashboard.length).toBe(perClient.size);
    for (const row of dashboard) {
      expect({ receipts: row.receipts, boxes: row.boxes, issued: row.issuedBoxes }).toEqual(
        perClient.get(row.clientId),
      );
    }

    // Every listed, still-issuable carton behind the ban is refused at the
    // counter, and every refusal names a listed carton. The permissions the
    // earlier cases recorded are withdrawn first: a live approval is exactly
    // what lets a gated carton through, and this is about the rule alone.
    await db
      .update(issueApprovals)
      .set({ status: 'refused', expiresAt: null, decidedBy: actorId, decidedAt: new Date() })
      .where(and(inArray(issueApprovals.clientId, madeClients), inArray(issueApprovals.status, ['pending', 'approved'])));
    for (const clientId of madeClients) {
      const boxesHere = (await uncovered(clientId)).filter(
        (b) => b.warehouseId === W.tas && (b.status === 'ready_for_pickup' || b.status === 'in_stock'),
      );
      for (const box of boxesHere) {
        const gated = box.roadLandedAt !== null && gate.state === 'on' && box.roadLandedAt >= gate.since;
        const answer = await issue(clientId, W.tas, [box.boxId], { debtOk: true });
        expect([box.boxId, answer === 'price_block' || answer === 'price_elsewhere']).toEqual([box.boxId, gated]);
      }
    }
  });

  it('the company-wide reads ask their question with JIT off — and the answer is the same one', async () => {
    const company = { kind: 'company', warehouseIds: undefined, ownerId: undefined, landedFrom: undefined } as const;
    const [before] = (await db.execute(sql`SHOW jit`)) as unknown as { jit: string }[];
    const [seen] = (await withoutJit((exec) => exec.execute(sql`SHOW jit`))) as unknown as { jit: string }[];
    expect(seen!.jit).toBe('off');
    const plain = (await unpricedReceiptsOn(db, company, gate)).map((r) => r.receiptId).sort();
    const noJit = (await withoutJit((exec) => unpricedReceiptsOn(exec, company, gate))).map((r) => r.receiptId).sort();
    expect(noJit).toEqual(plain);
    // …and the session it borrowed is not left changed (SET LOCAL).
    const [after] = (await db.execute(sql`SHOW jit`)) as unknown as { jit: string }[];
    expect(after!.jit).toBe(before!.jit);
  });
});
