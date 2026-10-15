import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { eq, inArray, sql, TransactionRollbackError } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clientNotices,
  clients,
  costEntries,
  costTypes,
  pickupLineReceipts,
  pickups,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt, voidReceipt } from '@/modules/wms/receipts/service';
import { addCostEntry, voidCostEntry } from '@/modules/wms/costing/service';
import {
  cancelPickup,
  closePickup,
  collectStop,
  createPickup,
  isOpenStatus,
  linkReceiptToStop,
  loadPickup,
  resolveLineOwners,
  saveFactory,
  setFactoryActive,
  setPickupNoCost,
} from '@/modules/wms/pickups/service';
import {
  answeredTwice,
  costWithoutCargo,
  openAnswered,
  owedLines,
  receivedAgain,
  unansweringLinks,
  zavodCheck,
} from '@/modules/wms/pickups/double-received';

/**
 * The owner's item 7 (docs/ZAVOD-YOPISH.md §7): the read-only checker that
 * lists factory cargo received twice, and what an open trip still owes. Each
 * list is driven to its own fixture through the REAL doors — the receive
 * door with its stop, the card's link and detach, a void — and raw SQL only
 * for the two states no door reaches any more: a prixod the OLD code linked
 * with no memory row (the migrate window), and an answer older than the
 * window (a backdated confirm).
 *
 * The lists read the WHOLE database, so every assertion is about this file's
 * own rows; a clean control trip must appear in none of them. Everything is
 * this file's own — a CN warehouse, one factory, seven clients — and is put out
 * of every other spec's sight at the end: prixods VOIDED, open trips
 * CANCELLED, closed ones marked «xarajat yo'q» (or the home row's «cost
 * owed» counts them), costs voided, warehouse/factory/clients DEACTIVATED
 * (the audit log's FK allows nothing else).
 */

const S = String(Date.now()).slice(-6);
let actorId = '';
let whId = '';
let whCode = '';
let factoryId = '';
let costTypeId = '';
const code: Record<'A' | 'B' | 'G' | 'C' | 'D' | 'E' | 'H', string> = { A: '', B: '', G: '', C: '', D: '', E: '', H: '' };
const clientId: Record<keyof typeof code, string> = { A: '', B: '', G: '', C: '', D: '', E: '', H: '' };
const made = { receipts: [] as string[], lots: [] as string[], pickups: [] as string[], costs: [] as string[] };
const ctx = () => ({ actorId });

type Owner = { client: keyof typeof code } | { marking: string };

/** A prixod through the real door, its photo pre-bound as the wizard does it. */
async function receive(owner: Owner, opts: { stopId?: string; lineIds?: string[]; boxes?: number } = {}) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `zavod-tekshir/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  made.receipts.push(receiptId);
  made.lots.push(lotId);
  await confirmReceipt(
    {
      receiptId,
      warehouseId: whId,
      clientId: 'client' in owner ? clientId[owner.client] : null,
      unclaimedMarking: 'marking' in owner ? owner.marking : '',
      lots: [
        {
          id: lotId,
          productNameZh: `货${S}`,
          productNameRu: `Tekshir ${S}`,
          boxCount: opts.boxes ?? 2,
          dimsMode: 'mixed',
          totalWeightKg: 40,
          totalVolumeM3: 0.5,
          note: '',
        },
      ],
      extraCosts: [],
      pickupStopId: opts.stopId ?? null,
      pickupLineIds: opts.lineIds,
    },
    ctx(),
  );
  return receiptId;
}

/** A one-stop trip to this file's warehouse; lines found again by their goods. */
async function trip(lines: { owner: string; goods: string; factoryBoxes: number }[]) {
  const resolved = await resolveLineOwners(lines);
  const created = await createPickup(
    { destWarehouseId: whId, vehiclePlate: `T${S}`, stops: [{ factoryId, lines: resolved }] },
    ctx(),
  );
  made.pickups.push(created.id);
  const stop = (await loadPickup(created.id))!.stops[0]!;
  const line = (goods: string) => stop.lines.find((l) => l.goods === goods)!.id;
  return { id: created.id, code: created.code, stopId: stop.id, line };
}

const statusOf = async (pickupId: string) =>
  (await db.query.pickups.findFirst({ where: eq(pickups.id, pickupId) }))!.status;

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  whCode = `ZK${S}`;
  whId = (
    await db
      .insert(warehouses)
      .values({ code: whCode, batchPrefix: whCode, name: `Tekshir ${S}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' })
      .returning({ id: warehouses.id })
  )[0]!.id;
  for (const key of Object.keys(code) as (keyof typeof code)[]) {
    code[key] = `ZK${key}${S}`;
    clientId[key] = (
      await db.insert(clients).values({ clientCode: code[key], name: `Tekshir ${key} ${S}` }).returning({ id: clients.id })
    )[0]!.id;
  }
  factoryId = (await saveFactory({ name: `Tekshir zavod ${S}` }, ctx())).id;
});

afterAll(async () => {
  for (const id of made.costs) {
    const entry = await db.query.costEntries.findFirst({ where: eq(costEntries.id, id) });
    if (entry && !entry.voidedAt) await voidCostEntry(id, 'test', ctx(), { mayMoveTill: true });
  }
  if (made.lots.length) await db.update(boxes).set({ status: 'void' }).where(inArray(boxes.lotId, made.lots));
  if (made.receipts.length) {
    await db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' })
      .where(inArray(receipts.id, made.receipts));
  }
  // A trip left open is on /receive and the logist's home; a closed one with
  // no cost and no mark is «xarajat yo'q owed» on the home row.
  for (const id of made.pickups) {
    const trip = await db.query.pickups.findFirst({ where: eq(pickups.id, id) });
    if (!trip) continue;
    if (isOpenStatus(trip.status)) await cancelPickup(id, 'test tozalash', ctx());
    else if (trip.status === 'closed' && !trip.noCostAt) await setPickupNoCost(id, 'test tozalash', ctx());
  }
  await db.delete(clientNotices).where(inArray(clientNotices.clientId, Object.values(clientId).filter(Boolean)));
  if (factoryId) await setFactoryActive(factoryId, false, ctx());
  await db.update(clients).set({ active: false }).where(inArray(clients.id, Object.values(clientId).filter(Boolean)));
  if (whId) await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
  await pgClient.end();
});

describe('the checker reads, and reads through the screens’ own sentences', () => {
  it('writes nothing and restates neither «answered» nor the owner rule', () => {
    // Comments stripped first: a fence must not match the sentence that
    // explains it (#725).
    const source = readFileSync('src/modules/wms/pickups/double-received.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(source).not.toMatch(/\.(insert|update|delete)\(/);
    for (const shared of ['lineAnsweredSql', 'ownerLooselyMatchesSql', 'candidateReceiptSql', 'costWithoutCargoSql', 'OPEN_STATUSES']) {
      expect(source).toContain(shared);
    }
    // The owner rule's own text lives in pickups/service, never here.
    expect(source).not.toContain('unclaimed_marking))');
    expect(source).not.toMatch(/'planned',\s*'on_road'/);
  });

  it('the deploy-window heal in docs/UPDATE.md is the migration’s own statements plus the window clause', () => {
    const doc = readFileSync('docs/UPDATE.md', 'utf8');
    const migration = readFileSync('src/modules/platform/db/migrations/0133_pickup_close.sql', 'utf8');
    const between = (text: string, begin: string, end: string) => text.slice(text.indexOf(begin) + begin.length, text.indexOf(end));
    const code = (text: string) =>
      text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('--'))
        .join(' ')
        .replace(/\s+/g, ' ');
    const heal = code(between(doc, '-- ZAVOD-HEAL-MEMORY-BEGIN', '-- ZAVOD-HEAL-MEMORY-END'));
    const backfill = code(between(migration, '-- BACKFILL-MEMORY-BEGIN', '-- BACKFILL-MEMORY-END'));
    const window =
      'AND r."voided_at" IS NULL AND NOT EXISTS (SELECT 1 FROM "pickup_line_receipts" had WHERE had."receipt_id" = r."id") ';
    expect(heal).toContain(window);
    expect(heal.replace(window, '')).toBe(backfill);
    const close = code(between(doc, '-- ZAVOD-HEAL-CLOSE-BEGIN', '-- ZAVOD-HEAL-CLOSE-END'));
    expect(close).toBe(code(between(migration, '-- BACKFILL-CLOSE-BEGIN', '-- BACKFILL-CLOSE-END')));
  });
});

describe('zavod tekshiruvi', () => {
  let t1: Awaited<ReturnType<typeof trip>>;
  let t6: Awaited<ReturnType<typeof trip>>;
  let r0 = '';
  let r1 = '';
  let r2 = '';

  it('(4) the same owner\'s unlinked prixods inside the stop\'s window, BEFORE the answer as well as after — never an old trip\'s', async () => {
    // A trip from a month ago: the regular client's later cargo must not
    // light up every trip they ever had (probe S5) — the window is the
    // STOP's (from its «Olindi», here the trip's creation), never «ever».
    t6 = await trip([{ owner: code.A, goods: `Eski ${S}`, factoryBoxes: 10 }]);
    const r6 = await receive({ client: 'A' }, { stopId: t6.stopId, lineIds: [t6.line(`Eski ${S}`)] });
    await db.execute(sql`UPDATE receipts SET confirmed_at = now() - interval '30 days' WHERE id = ${r6}`);
    await db.execute(sql`UPDATE pickups SET created_at = now() - interval '31 days' WHERE id = ${t6.id}`);

    t1 = await trip([{ owner: code.A, goods: `Oyinchoq ${S}`, factoryBoxes: 50 }]);
    // The old code's commonest double (the judge's money-7): the plain form
    // FIRST (S6 — nothing linked, the line still «waiting»), then «Qabul
    // qilish» on the stale list (S2), which links and answers.
    r0 = await receive({ client: 'A' });
    r1 = await receive({ client: 'A' }, { stopId: t1.stopId, lineIds: [t1.line(`Oyinchoq ${S}`)], boxes: 50 });
    expect(await statusOf(t1.id)).toBe('closed');
    r2 = await receive({ client: 'A' }, { boxes: 48 });

    const rows = (await receivedAgain()).rows.filter((r) => r.line.pickupId === t1.id || r.line.pickupId === t6.id);
    expect(rows.map((r) => [r.line.pickupCode, r.receipt.id, r.answeredBy.id])).toEqual([
      [t1.code, r2, r1],
      [t1.code, r0, r1],
    ]);
    const row = rows[0]!;
    expect(row.line).toMatchObject({ clientCode: code.A, goods: `Oyinchoq ${S}`, factoryBoxes: 50, destCode: whCode });
    expect(row.receipt).toMatchObject({ boxes: 48, warehouseCode: whCode, clientCode: code.A, voided: false });
    expect(row.receipt.number).toBeTruthy();
    expect(row.answeredBy.boxes).toBe(50);
  });

  it('(1) attached to the same line, it is the line answered twice — and a voided one answers nothing', async () => {
    // The card's per-line button may add a second prixod to an answered line
    // (one line delivered in two parts) — a person's act, reachable today.
    await linkReceiptToStop(r2, t1.stopId, ctx(), [t1.line(`Oyinchoq ${S}`)]);
    const twice = (await answeredTwice()).rows.filter((r) => r.line.pickupId === t1.id || r.line.pickupId === t6.id);
    expect(twice).toHaveLength(1);
    expect(twice[0]!.line).toMatchObject({ pickupCode: t1.code, factoryName: `Tekshir zavod ${S}`, factoryBoxes: 50 });
    expect(twice[0]!.receipts.map((r) => [r.id, r.boxes])).toEqual([
      [r1, 50],
      [r2, 48],
    ]);
    // Linked now, so no longer «round the trip».
    expect((await receivedAgain()).rows.some((r) => r.receipt.id === r2)).toBe(false);

    await voidReceipt(r2, 'test', ctx());
    expect((await answeredTwice()).rows.some((r) => r.line.pickupId === t1.id)).toBe(false);
  });

  it('(2) an open trip’s unanswered lines, each with ITS owner’s prixods already on the shelf', async () => {
    const mark = `MK${S}`;
    const t2 = await trip([
      { owner: code.B, goods: `Bolalar ${S}`, factoryBoxes: 20 },
      { owner: code.G, goods: `Gilam ${S}`, factoryBoxes: 7 },
      { owner: mark, goods: `Markali ${S}`, factoryBoxes: 5 },
    ]);
    await collectStop(t2.stopId, {}, ctx());
    // The marking line is received through the truck — derived, no ids.
    await receive({ marking: mark }, { stopId: t2.stopId });
    expect(await statusOf(t2.id)).toBe('arrived');
    const rb = await receive({ client: 'B' });
    const rg = await receive({ client: 'G' });

    const rows = (await owedLines()).rows.filter((r) => r.line.pickupId === t2.id);
    const byGoods = new Map(rows.map((r) => [r.line.goods, r]));
    expect([...byGoods.keys()].sort()).toEqual([`Bolalar ${S}`, `Gilam ${S}`]);
    expect(byGoods.get(`Bolalar ${S}`)!.candidates.map((r) => r.id)).toEqual([rb]);
    expect(byGoods.get(`Gilam ${S}`)!.candidates.map((r) => r.id)).toEqual([rg]);
    expect(byGoods.get(`Bolalar ${S}`)!.collectedAt).toBeInstanceOf(Date);
    expect(byGoods.get(`Bolalar ${S}`)!.line).toMatchObject({ pickupStatus: 'arrived', clientCode: code.B });
    expect((await openAnswered()).rows.some((t) => t.pickupId === t2.id)).toBe(false);
  });

  it('(3) linked and answering nothing, told apart: extra cargo, a memory never written, a second receive', async () => {
    const t3 = await trip([{ owner: code.C, goods: `Choynak ${S}`, factoryBoxes: 12 }]);
    // Extra cargo: a marking no line names, received through the truck.
    const extra = await receive({ marking: `XTRA${S}` }, { stopId: t3.stopId });
    // The migrate window: the OLD code linked it, and wrote no memory.
    const windowLink = await receive({ client: 'C' });
    await db.execute(sql`UPDATE receipts SET pickup_stop_id = ${t3.stopId} WHERE id = ${windowLink}`);

    const t4 = await trip([{ owner: code.E, goods: `Eshik ${S}`, factoryBoxes: 9 }]);
    const r4 = await receive({ client: 'E' }, { stopId: t4.stopId, lineIds: [t4.line(`Eshik ${S}`)] });
    // A second receive of an answered line, attached from the card with no
    // line chosen: the card links it as extra and it answers nothing.
    const again = await receive({ client: 'E' });
    await linkReceiptToStop(again, t4.stopId, ctx());
    // A prixod that remembers ONE of its owner's two lines: the heal must
    // leave it alone, or it would answer the line the person did not choose.
    const t7 = await trip([
      { owner: code.H, goods: `Hovli ${S}`, factoryBoxes: 6 },
      { owner: code.H, goods: `Hammom ${S}`, factoryBoxes: 4 },
    ]);
    const remembered = await receive({ client: 'H' }, { stopId: t7.stopId, lineIds: [t7.line(`Hovli ${S}`)] });

    const rows = (await unansweringLinks()).rows.filter((r) => r.pickupId === t3.id || r.pickupId === t4.id);
    const kinds = new Map(rows.map((r) => [r.receipt.id, r.ownerLine]));
    expect(kinds.get(extra)).toBe('none');
    expect(kinds.get(windowLink)).toBe('open');
    expect(kinds.get(again)).toBe('answered');
    expect(kinds.has(r4)).toBe(false);
    expect(rows.find((r) => r.receipt.id === extra)!.receipt.marking).toBe(`XTRA${S}`);
    // Still open with its line unanswered: list (2) carries it too.
    expect((await owedLines()).rows.some((r) => r.line.pickupId === t3.id)).toBe(true);

    // docs/UPDATE.md's heal, run as written in a rolled-back transaction: the
    // window's prixod gets its line, extra cargo gets nothing, a prixod that
    // already remembers its line is left alone, a second run writes nothing,
    // and the trip whose last line it answered closes.
    const doc = readFileSync('docs/UPDATE.md', 'utf8');
    const block = (begin: string, end: string) => doc.slice(doc.indexOf(begin), doc.indexOf(end));
    const healMemory = block('-- ZAVOD-HEAL-MEMORY-BEGIN', '-- ZAVOD-HEAL-MEMORY-END');
    const healClose = block('-- ZAVOD-HEAL-CLOSE-BEGIN', '-- ZAVOD-HEAL-CLOSE-END');
    let seen: {
      window: number;
      extra: number;
      remembered: number;
      secondRun: number;
      status: string;
      kind: string | null;
    } | null = null;
    await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(healMemory));
        const count = async (receiptId: string) =>
          Number(
            (
              (await tx.execute(
                sql`SELECT count(*)::int AS n FROM pickup_line_receipts WHERE receipt_id = ${receiptId}`,
              )) as unknown as { n: number }[]
            )[0]!.n,
          );
        const before = Number(
          ((await tx.execute(sql`SELECT count(*)::int AS n FROM pickup_line_receipts`)) as unknown as { n: number }[])[0]!.n,
        );
        await tx.execute(sql.raw(healMemory));
        const after = Number(
          ((await tx.execute(sql`SELECT count(*)::int AS n FROM pickup_line_receipts`)) as unknown as { n: number }[])[0]!.n,
        );
        await tx.execute(sql.raw(healClose));
        const [trip3] = (await tx.execute(
          sql`SELECT status, close_kind FROM pickups WHERE id = ${t3.id}`,
        )) as unknown as { status: string; close_kind: string | null }[];
        seen = {
          window: await count(windowLink),
          extra: await count(extra),
          remembered: await count(remembered),
          secondRun: after - before,
          status: trip3!.status,
          kind: trip3!.close_kind,
        };
        tx.rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof TransactionRollbackError)) throw err;
      });
    expect(seen).toEqual({ window: 1, extra: 0, remembered: 1, secondRun: 0, status: 'closed', kind: 'auto' });

    // The healed state, committed: the trip every line of which is answered
    // and is still open is named, and the prixod leaves list (3).
    await db.insert(pickupLineReceipts).values({ lineId: t3.line(`Choynak ${S}`), receiptId: windowLink });
    expect((await openAnswered()).rows.filter((t) => t.pickupId === t3.id).map((t) => t.lines)).toEqual([1]);
    expect((await unansweringLinks()).rows.some((r) => r.receipt.id === windowLink)).toBe(false);
    expect((await owedLines()).rows.some((r) => r.line.pickupId === t3.id)).toBe(false);
  });

  it('(5) a closed truck whose bill sits on no carton — closed by hand with nothing; a detach that would leave it so is refused', async () => {
    const mark = `M5${S}`;
    const t5 = await trip([{ owner: mark, goods: `Beshinchi ${S}`, factoryBoxes: 4 }]);
    const r5 = await receive({ marking: mark }, { stopId: t5.stopId });
    expect(await statusOf(t5.id)).toBe('closed');
    const entry = await addCostEntry(
      {
        scope: 'pickup',
        pickupId: t5.id,
        costTypeId,
        amount: 120,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'volume',
      },
      ctx(),
    );
    made.costs.push(entry.id);
    expect((await costWithoutCargo()).rows.some((r) => r.pickupId === t5.id)).toBe(false);

    // Taking the closed truck's only cargo off it would leave the bill on
    // nothing — refused since the judge's money-1, naming the trip.
    await expect(linkReceiptToStop(r5, null, ctx())).rejects.toMatchObject({ code: 'shared_cost_orphaned' });
    expect((await costWithoutCargo()).rows.some((r) => r.pickupId === t5.id)).toBe(false);

    // What still reaches the list: a costed truck that brought nothing,
    // closed by hand — the money on no carton is the truth there.
    const t5b = await trip([{ owner: `${mark}B`, goods: `Bo‘sh ${S}`, factoryBoxes: 2 }]);
    const empty = await addCostEntry(
      {
        scope: 'pickup',
        pickupId: t5b.id,
        costTypeId,
        amount: 120,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'volume',
      },
      ctx(),
    );
    made.costs.push(empty.id);
    await closePickup(t5b.id, { reason: 'zavod yuk bermadi' }, ctx(), { mayMarkNoCost: false });
    const rows = (await costWithoutCargo()).rows.filter((r) => r.pickupId === t5b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pickupCode: expect.stringMatching(/^ZR-/), destCode: whCode, closeKind: 'manual', voidedLinked: 0 });
    expect(rows[0]!.costs).toEqual(['120.00 USD']);
    expect(rows[0]!.factories).toBe(`Tekshir zavod ${S}`);
  });

  it('a trip received once, through the truck, appears in no list', async () => {
    const clean = await trip([{ owner: code.D, goods: `Toza ${S}`, factoryBoxes: 3 }]);
    const rd = await receive({ client: 'D' }, { stopId: clean.stopId, lineIds: [clean.line(`Toza ${S}`)], boxes: 3 });
    expect(await statusOf(clean.id)).toBe('closed');
    const all = await zavodCheck();
    const lines = [
      ...all.answeredTwice.rows.map((r) => r.line.pickupId),
      ...all.owedLines.rows.map((r) => r.line.pickupId),
      ...all.receivedAgain.rows.map((r) => r.line.pickupId),
      ...all.unansweringLinks.rows.map((r) => r.pickupId),
      ...all.openAnswered.rows.map((r) => r.pickupId),
      ...all.costWithoutCargo.rows.map((r) => r.pickupId),
    ];
    expect(lines).not.toContain(clean.id);
    const receiptsSeen = [
      ...all.answeredTwice.rows.flatMap((r) => r.receipts.map((x) => x.id)),
      ...all.owedLines.rows.flatMap((r) => r.candidates.map((x) => x.id)),
      ...all.receivedAgain.rows.flatMap((r) => [r.receipt.id, r.answeredBy.id]),
      ...all.unansweringLinks.rows.map((r) => r.receipt.id),
    ];
    expect(receiptsSeen).not.toContain(rd);
  });
});
