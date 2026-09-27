import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  batches,
  boxes,
  clientNotices,
  clients,
  crates,
  receiptLots,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { CrateError, createCrate } from '@/modules/wms/crates/service';
import { buildInvoiceXlsx, invoicePlaces } from '@/modules/wms/documents/ved-xlsx';

/**
 * A pallet is a crate (0112, the owner's Q10 d). The office says «N ta» of a
 * lot and the SERVICE picks the cartons inside its own transaction — lowest
 * seq, in stock, uncrated, at the crate's warehouse, skipping a carton a
 * colleague is holding. On the customs invoice ONLY a pallet is one place
 * (Q2 = b). Own warehouses, DEACTIVATED at the end (audit_log FK); the crates
 * and cargo stay, they are data.
 */

const S = String(Date.now()).slice(-7);
const W = { a: '', b: '' };
let actorId = '';
let clientId = '';
const ctx = () => ({ actorId });

async function mintWarehouse(tag: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code: `PL${tag}${S}`, batchPrefix: `PL${tag}${S}`, name: `Palet ${tag} ${S}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' })
    .returning({ id: warehouses.id });
  return row!.id;
}

/** One prixod of `counts.length` lots at A; returns each lot with its boxes by seq. */
async function receive(counts: number[]) {
  const lots = counts.map(() => uuidv4());
  for (const id of lots) {
    await db.insert(attachments).values({
      entityType: 'receipt_lot',
      entityId: id,
      kind: 'photo',
      storageKey: `palet/${id}`,
      fileName: 'x.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: actorId,
    });
  }
  await confirmReceipt(
    {
      receiptId: uuidv4(),
      warehouseId: W.a,
      clientId,
      dealId: null,
      unclaimedMarking: '',
      lots: lots.map((id, i) => ({
        id,
        productNameZh: `托盘货${i}`,
        boxCount: counts[i]!,
        dimsMode: 'uniform',
        boxLengthCm: 40,
        boxWidthCm: 30,
        boxHeightCm: 20,
        boxWeightKg: 5,
      })),
      extraCosts: [],
    } as never,
    ctx(),
  );
  return Promise.all(
    lots.map(async (lotId) => {
      const [lot] = await db.select({ letter: receiptLots.letter }).from(receiptLots).where(eq(receiptLots.id, lotId));
      const rows = await db
        .select({ id: boxes.id, seq: boxes.seqInLot, code: boxes.shortCode })
        .from(boxes)
        .where(eq(boxes.lotId, lotId))
        .orderBy(boxes.seqInLot);
      return { lotId, letter: lot!.letter!, boxes: rows };
    }),
  );
}

const pallet = (lotCounts: { lotId: string; count: number }[], boxIds: string[] = [], warehouseId = W.a) =>
  createCrate({ crateId: uuidv4(), warehouseId, boxIds, lotCounts, kind: 'palet', logistApproved: true }, ctx());

async function refusal(promise: Promise<unknown>): Promise<{ code: string; detail?: string }> {
  try {
    await promise;
    return { code: 'no refusal' };
  } catch (err) {
    if (err instanceof CrateError) return { code: err.code, detail: err.detail };
    throw err;
  }
}

async function membersOf(crateId: string) {
  return (
    await db.select({ seq: boxes.seqInLot }).from(boxes).where(eq(boxes.crateId, crateId)).orderBy(boxes.seqInLot)
  ).map((r) => r.seq);
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  W.a = await mintWarehouse('A');
  W.b = await mintWarehouse('B');
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `PL${S}`, name: `Palet mijoz ${S}` })
    .returning({ id: clients.id });
  clientId = client!.id;
});

afterAll(async () => {
  if (clientId) await db.delete(clientNotices).where(eq(clientNotices.clientId, clientId));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('a pallet by count', () => {
  it('takes the lowest free cartons of the lot, as a crate of kind palet, and records which', async () => {
    const [lot] = await receive([5]);
    const crate = await pallet([{ lotId: lot!.lotId, count: 3 }]);
    expect(crate.kind).toBe('palet');
    expect(await membersOf(crate.id)).toEqual([1, 2, 3]);
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, crate.id), eq(auditLog.action, 'create')));
    expect(audit!.after).toMatchObject({
      kind: 'palet',
      boxCount: 3,
      lotCounts: [{ lotId: lot!.lotId, count: 3 }],
      shortCodes: lot!.boxes.slice(0, 3).map((b) => b.code),
    });

    // Only two are free now: refused in words, naming the lot's letter (read
    // through the transaction's own handle — the pool is off-limits there).
    expect(await refusal(pallet([{ lotId: lot!.lotId, count: 3 }]))).toEqual({
      code: 'not_enough_boxes',
      detail: `${lot!.letter}:2`,
    });
  });

  it('picks only cartons standing at the crate’s warehouse', async () => {
    const [lot] = await receive([4]);
    // Two cartons have been moved to B.
    await db.update(boxes).set({ currentWarehouseId: W.b }).where(inArray(boxes.id, [lot!.boxes[0]!.id, lot!.boxes[1]!.id]));
    const crate = await pallet([{ lotId: lot!.lotId, count: 2 }]);
    expect(await membersOf(crate.id)).toEqual([3, 4]);
  });

  it('skips a carton a colleague is holding instead of waiting for it', async () => {
    const [lot] = await receive([4]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM boxes WHERE id IN (${sql.join([lot!.boxes[0]!.id, lot!.boxes[1]!.id].map((id) => sql`${id}::uuid`), sql`, `)}) FOR UPDATE`,
      );
      held();
      await gate;
    });
    await holding;
    try {
      const outcome = await Promise.race([
        pallet([{ lotId: lot!.lotId, count: 2 }]).then((crate) => crate.id),
        new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 4000)),
      ]);
      expect(outcome, 'the pick did not wait for the held cartons').not.toBe('waited');
      expect(await membersOf(outcome)).toEqual([3, 4]);
    } finally {
      release();
      await holder;
    }
  });

  it('refuses a lot both ticked and counted, nothing at all, and too many', async () => {
    const [lot] = await receive([3]);
    expect((await refusal(pallet([{ lotId: lot!.lotId, count: 1 }], [lot!.boxes[2]!.id]))).code).toBe('lot_twice');
    expect(
      (await refusal(pallet([{ lotId: lot!.lotId, count: 1 }, { lotId: lot!.lotId, count: 1 }]))).code,
    ).toBe('lot_twice');
    expect((await refusal(pallet([]))).code).toBe('validation');
    expect((await refusal(pallet([{ lotId: lot!.lotId, count: 500 }], [lot!.boxes[0]!.id]))).code).toBe(
      'too_many_boxes',
    );
    // …and nothing was crated by any of them.
    const crated = await db.select({ id: boxes.id }).from(boxes).where(and(eq(boxes.lotId, lot!.lotId), sql`${boxes.crateId} IS NOT NULL`));
    expect(crated).toHaveLength(0);
  });

  it('still takes ticked cartons of another lot beside a count', async () => {
    const [counted, ticked] = await receive([3, 2]);
    const crate = await pallet([{ lotId: counted!.lotId, count: 2 }], [ticked!.boxes[1]!.id]);
    const members = await db.select({ lotId: boxes.lotId }).from(boxes).where(eq(boxes.crateId, crate.id));
    expect(members.filter((m) => m.lotId === counted!.lotId)).toHaveLength(2);
    expect(members.filter((m) => m.lotId === ticked!.lotId)).toHaveLength(1);
  });
});

describe('the customs invoice counts a pallet as ONE place', () => {
  it('assigns each pallet to the lot holding most of it; yashik stays per carton', async () => {
    // Lot A: 4 cartons, lot B: 3 cartons, lot C: 2 cartons — one client.
    const [a, b, c] = await receive([4, 3, 2]);
    // A pallet of 2 from A and 1 from B → A's place.
    await pallet([
      { lotId: a!.lotId, count: 2 },
      { lotId: b!.lotId, count: 1 },
    ]);
    // A yashik of C's two cartons → still two places (Q2 = b).
    await createCrate(
      { crateId: uuidv4(), warehouseId: W.a, boxIds: c!.boxes.map((x) => x.id), kind: 'yashik', logistApproved: true },
      ctx(),
    );
    const [truck] = await db
      .insert(batches)
      .values({ code: `PLT${S}`, originWarehouseId: W.a, destWarehouseId: W.b, status: 'forming', createdBy: actorId })
      .returning({ id: batches.id });
    const all = [a!, b!, c!].flatMap((lot) => lot.boxes.map((x) => x.id));
    await db.update(boxes).set({ currentBatchId: truck!.id }).where(inArray(boxes.id, all));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildInvoiceXlsx(truck!.id))! as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    const places = new Map<string, number>();
    for (let r = 21; r < 21 + 3; r += 1) {
      const row = sheet.getRow(r);
      places.set(String(row.getCell(2).value), Number(row.getCell(6).value));
    }
    // Loose cartons: A 2, B 2; one pallet; C's yashik counted by cartons: 2.
    expect([...places.values()].reduce((sum, n) => sum + n, 0)).toBe(2 + 2 + 1 + 2);
    expect(places.get('托盘货0')).toBe(3); // 2 loose + the pallet
    expect(places.get('托盘货1')).toBe(2); // 2 loose, its one carton rides A's pallet
    expect(places.get('托盘货2')).toBe(2); // the yashik, per carton
    await db.update(boxes).set({ currentBatchId: null }).where(inArray(boxes.id, all));
    await db.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, truck!.id));
  });

  it('breaks a tie by the earlier letter', () => {
    const rows = [
      { lotId: 'b', letter: 'B', crateId: 'p', crateKind: 'palet' },
      { lotId: 'a', letter: 'A', crateId: 'p', crateKind: 'palet' },
      { lotId: 'a', letter: 'A', crateId: null, crateKind: null },
    ];
    expect(Object.fromEntries(invoicePlaces(rows))).toEqual({ a: 2, b: 0 });
    // A karkas is not a pallet: every carton is a place.
    expect(
      Object.fromEntries(invoicePlaces(rows.map((r) => ({ ...r, crateKind: r.crateId ? 'karkas' : null })))),
    ).toEqual({ a: 2, b: 1 });
  });
});

describe('the label of a pallet', () => {
  it('is a crate the label route can render', async () => {
    const [lot] = await receive([2]);
    const crate = await pallet([{ lotId: lot!.lotId, count: 2 }]);
    const [row] = await db.select({ kind: crates.kind }).from(crates).where(eq(crates.id, crate.id));
    expect(row!.kind).toBe('palet');
    const { renderCrateLabel } = await import('@/modules/wms/labels/renderer');
    const pdf = await renderCrateLabel({
      warehouseCode: 'PL',
      dateLocal: '27.09.2026',
      code: crate.code,
      clientCode: `PL${S}`,
      kind: 'palet',
      boxCount: 2,
      contents: `${lot!.letter}×2`,
      weightKg: null,
      dimsCm: null,
    });
    expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe('%PDF');
  });
});
