import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Lot tarkibi against a real database (docs/LOT-TARKIBI.md §11.2): the owner's
 * case — a lot of 100 cartons received as «klaviatura» that the client's
 * papers say is 50 keyboards + 50 mice — through the writer, its doors and
 * locks, every paper that reads it, the Bojxona tab, the frozen tick and the
 * price history.
 *
 * Written straight to the tables (the `truck-card` shape), every name
 * run-suffixed. Service calls take PLAIN actors — no role rows minted (#183).
 * The two action doors that read a session (the tick, the TNVED saves) get a
 * stand-in session (the seeded VED) or a stand-in actor, and nothing else is
 * mocked: what `revalidatePath` would invalidate is not this file's question.
 *
 * Trucks, created in this order: INTERNAL (CN→CN, departed first, all 100 of
 * lot A — it must stay OUT of the population), CROSS (CN→UZ, departed second,
 * 33 of A), CROSS2 (CN→UZ, forming, the other 67 of A). Lines are 50/50 —
 * with 33/67 a per-truck largest remainder declares 51/49 and the cumulative
 * rule 50/50, which is what makes the red proofs bite (a 70/30 split divides
 * 40/60 evenly and keeps both green — #166).
 *
 * Cleanup is the FINAL test, not `afterAll` (round 57's lie): an in-transit
 * leftover is the next spec's dashboard (#154). Warehouses are DEACTIVATED
 * (audit_log FK); the TNVED memory rows must equal the snapshot.
 */

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
const override = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }));

vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => session.user,
  requestMeta: async () => ({ ip: null, userAgent: 'lot-composition.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
/**
 * A half-applied deploy (0122 not migrated yet) for test 12g: the copy's
 * table is missing, so the freeze and the thaw fail as postgres would.
 * Everything else is the real module.
 */
const behind = vi.hoisted(() => ({ on: false }));
vi.mock('@/modules/wms/receipts/lot-composition', async (original) => {
  const real = await original<typeof import('@/modules/wms/receipts/lot-composition')>();
  const missing = () => Object.assign(new Error('relation "batch_sent_compositions" does not exist'), { code: '42P01' });
  return {
    ...real,
    freezeCompositionsInTx: async (...args: Parameters<typeof real.freezeCompositionsInTx>) => {
      if (behind.on) throw missing();
      return real.freezeCompositionsInTx(...args);
    },
    thawCompositionsInTx: async (...args: Parameters<typeof real.thawCompositionsInTx>) => {
      if (behind.on) throw missing();
      return real.thawCompositionsInTx(...args);
    },
  };
});
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    requireActor: async () => (override.actor ?? (await real.requireActor())) as Awaited<ReturnType<typeof real.requireActor>>,
  };
});

import { db } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  batchSentCompositions,
  batches,
  boxMovements,
  boxes,
  clientTransactions,
  clients,
  crates,
  loadPlanLines,
  loadPlans,
  loadPlanVersions,
  lotCompositionLines,
  lotCompositions,
  receiptLots,
  receipts,
  tnvedAssignments,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { AttachmentDeleteError, deleteAttachment } from '@/modules/platform/files/service';
import { setSentToAgentAction } from '@/app/(protected)/batches/batch-actions-server';
import { saveLineCodesAction, saveTnvedAction } from '@/app/(protected)/batches/[id]/tnved/actions';
import { clearLotCompositionAction, saveLotCompositionAction } from '@/app/(protected)/receipts/[id]/composition-actions';
import { buildAgentXlsx } from '@/modules/wms/documents/agent-xlsx';
import { buildPackingPhotosXlsx } from '@/modules/wms/documents/packing-photos-xlsx';
import { buildInvoiceXlsx, buildPackingXlsx } from '@/modules/wms/documents/ved-xlsx';
import { pricePairs } from '@/modules/wms/finance/price-history';
import { growLotInTx } from '@/modules/wms/receipts/grow-lot';
import { isStale } from '@/modules/wms/receipts/composition-math';
import {
  clearComposition,
  compositionDoor,
  compositionsFor,
  CompositionError,
  lotTrucksFor,
  paperStampFor,
  saveComposition,
  setLineCodes,
  type CompositionActor,
} from '@/modules/wms/receipts/lot-composition';
import { batchTnvedProducts, missingTnvedCount } from '@/modules/wms/tnved/batch-lots';
import { productKey } from '@/modules/wms/tnved/service';

const SFX = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
const ctx = (id: string) => ({ actorId: id, ip: null, userAgent: 'lot-composition.integration' });

let vedId = '';
let logistId = '';
const wh: Record<'CN1' | 'CN2' | 'UZ' | 'NOC' | 'OTHER', string> = { CN1: '', CN2: '', UZ: '', NOC: '', OTHER: '' };
let clientId = '';
const rc: Record<'R1' | 'R2' | 'R3', string> = { R1: '', R2: '', R3: '' };
const LOTS = ['A', 'B', 'C', 'D', 'F', 'G', 'H', 'K', 'L'] as const;
type LotKey = (typeof LOTS)[number];
const lot = Object.fromEntries(LOTS.map((k) => [k, ''])) as Record<LotKey, string>;
const doc: Record<string, string> = {};
const truck: Record<string, string> = {};
const crateIds: string[] = [];
const planIds: string[] = [];
let chargeId = '';
const boxesOf: Record<string, string[]> = {};
let memorySnapshot: string[] = [];

const NAME_A = `键盘${SFX}`;
const NAME_G = `计划${SFX}`;
const LINE_NAMES = ['Клавиатура', 'Мышь', `Принтер${SFX}`, `Сканер${SFX}`, `Наушники${SFX}`, `Кабель${SFX}`];

/** The VED, unscoped (the seeded ved_manager's shape). */
const ved = (): CompositionActor & { roles: string[] } => ({
  id: vedId,
  permissions: new Set(['ved.docs']),
  warehouseScoped: false,
  warehouseIds: [],
  roles: [],
});
/** The logist — the other writer. */
const logist = (): CompositionActor & { roles: string[] } => ({
  id: logistId,
  permissions: new Set(['plans.manage', 'receipts.edit']),
  warehouseScoped: false,
  warehouseIds: [],
  roles: [],
});

async function mintWarehouse(code: string, country: string) {
  const [w] = await db
    .insert(warehouses)
    .values({
      code,
      name: `Tarkib ${code}`,
      country,
      type: country === 'CN' ? 'origin' : 'distribution',
      timezone: country === 'CN' ? 'Asia/Shanghai' : 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning({ id: warehouses.id });
  return w!.id;
}

async function mintReceipt(key: 'R1' | 'R2' | 'R3') {
  const [r] = await db
    .insert(receipts)
    .values({
      number: `LT-${SFX}-${key}`,
      warehouseId: wh.CN1,
      clientId,
      status: 'confirmed',
      createdBy: vedId,
      confirmedAt: ago(48),
      confirmedBy: vedId,
      createdAt: ago(48),
    })
    .returning({ id: receipts.id });
  rc[key] = r!.id;
}

async function mintLot(key: LotKey, receipt: 'R1' | 'R2' | 'R3', seq: number, name: string, n: number, kg: string, m3: string) {
  const [row] = await db
    .insert(receiptLots)
    .values({
      receiptId: rc[receipt],
      seq,
      letter: String.fromCharCode(64 + seq),
      cycleNo: 1,
      productNameZh: name,
      boxCount: n,
      dimsMode: 'mixed',
      totalWeightKg: kg,
      totalVolumeM3: m3,
    })
    .returning({ id: receiptLots.id });
  lot[key] = row!.id;
  const made = await db
    .insert(boxes)
    .values(
      Array.from({ length: n }, (_, i) => ({
        lotId: row!.id,
        seqInLot: i + 1,
        shortCode: `LT${SFX}${key}${i + 1}`,
        status: 'in_stock',
        currentWarehouseId: wh.CN1,
      })),
    )
    .returning({ id: boxes.id });
  boxesOf[key] = made.map((b) => b.id);
}

async function mintTruck(key: string, from: string, to: string, values: Partial<typeof batches.$inferInsert> = {}) {
  const [b] = await db
    .insert(batches)
    .values({ code: `LTT${key}-${SFX}`, originWarehouseId: from, destWarehouseId: to, createdBy: vedId, ...values })
    .returning({ id: batches.id });
  truck[key] = b!.id;
}

/** These cartons rode `truckKey`: a departure movement, and (optionally) the live pointer still on it. */
async function ride(ids: string[], truckKey: string, at: Date, live: boolean, crate?: (i: number) => string | null) {
  if (ids.length === 0) return;
  await db.insert(boxMovements).values(
    ids.map((boxId) => ({
      boxId,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: truck[truckKey]!,
      actorId: vedId,
      createdAt: at,
    })),
  );
  if (live) {
    for (const [i, boxId] of ids.entries()) {
      await db
        .update(boxes)
        .set({ status: 'in_transit', currentBatchId: truck[truckKey]!, currentWarehouseId: null, crateId: crate?.(i) ?? null })
        .where(eq(boxes.id, boxId));
    }
  }
}

async function mintDoc(key: string, receipt: 'R1' | 'R2' | 'R3', kind: 'file' | 'photo', createdAt?: Date) {
  const [a] = await db
    .insert(attachments)
    .values({
      entityType: 'receipt',
      entityId: rc[receipt],
      kind,
      storageKey: `receipt/${rc[receipt]}/lt-${SFX}-${key}`,
      fileName: `${key}-${SFX}.${kind === 'file' ? 'pdf' : 'jpg'}`,
      contentType: kind === 'file' ? 'application/pdf' : 'image/jpeg',
      sizeBytes: 10,
      uploadedBy: vedId,
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: attachments.id });
  doc[key] = a!.id;
}

const totalsOf = async (key: LotKey) => {
  const row = (await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lot[key]) }))!;
  return { boxCount: row.boxCount, kg: row.totalWeightKg, m3: row.totalVolumeM3 };
};

const line = (name: string, cartons: string, kg: string, m3: string, pieces = '', tnved = '') => ({
  name,
  pieces,
  cartons,
  kg,
  m3,
  tnved,
});

async function save(key: LotKey, lines: ReturnType<typeof line>[], opts: { actor?: CompositionActor; docKey?: string | null; seenRev?: number } = {}) {
  const totals = await totalsOf(key);
  const current = (await compositionsFor([lot[key]])).get(lot[key]);
  const actor = opts.actor ?? ved();
  return saveComposition(
    {
      lotId: lot[key],
      seenRev: opts.seenRev ?? current?.rev ?? 0,
      seenBoxCount: totals.boxCount,
      seenKg: totals.kg,
      seenM3: totals.m3,
      attachmentId: opts.docKey === null ? null : doc[opts.docKey ?? 'DOC'],
      lines,
    },
    actor,
    ctx(actor.id),
  );
}

const OWNER_CASE = () => [
  line('Клавиатура', '50', '600', '1.5', '500'),
  line('Мышь', '50', '400', '1.0', '1000'),
];

async function refusal(press: Promise<unknown>): Promise<CompositionError> {
  try {
    await press;
  } catch (err) {
    if (err instanceof CompositionError) return err;
    throw err;
  }
  throw new Error('the press went through');
}

/** The invoice's table rows: № … amount, plus the product cell's note. */
async function invoiceRows(batchKey: string) {
  const buf = await buildInvoiceXlsx(truck[batchKey]!);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf! as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0]!;
  const out: { product: string; code: string; unit: string; quantity: number; places: unknown; kg: number; note: string | null }[] = [];
  for (let r = 21; r < 400; r += 1) {
    const row = sheet.getRow(r);
    if (typeof row.getCell(1).value !== 'number') break;
    const note = row.getCell(2).note;
    out.push({
      product: String(row.getCell(2).value),
      code: String(row.getCell(3).value ?? ''),
      unit: String(row.getCell(4).value),
      quantity: Number(row.getCell(5).value),
      places: row.getCell(6).value,
      kg: Number(row.getCell(8).value),
      note: note ? (typeof note === 'string' ? note : JSON.stringify(note)) : null,
    });
  }
  return out;
}

/**
 * Every invoice row's amount cell (J) as the sheet stores it: the price the
 * VED types (I) times the row's quantity (E), live — so a composed line's
 * «шт» or «кг» is what the amount multiplies, never a figure written in.
 */
async function invoiceAmounts(batchKey: string) {
  const buf = await buildInvoiceXlsx(truck[batchKey]!);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf! as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0]!;
  const out: { row: number; formula: string | null }[] = [];
  for (let r = 21; r < 400; r += 1) {
    const row = sheet.getRow(r);
    if (typeof row.getCell(1).value !== 'number') break;
    const value = row.getCell(10).value;
    out.push({ row: r, formula: value && typeof value === 'object' && 'formula' in value ? String(value.formula) : null });
  }
  return out;
}

const sum1 = (values: number[]) => Math.round(values.reduce((s, v) => s + v, 0) * 10) / 10;
const ofLines = <T extends { product: string }>(rows: T[]) => rows.filter((r) => ['Клавиатура', 'Мышь'].includes(r.product));

async function memoryRows(): Promise<string[]> {
  const keys = [productKey(NAME_A), ...LINE_NAMES.map(productKey)];
  const rows = await db
    .select({ key: tnvedAssignments.productKey, code: tnvedAssignments.tnvedCode, at: tnvedAssignments.updatedAt })
    .from(tnvedAssignments)
    .where(inArray(tnvedAssignments.productKey, keys));
  return rows.map((r) => `${r.key}|${r.code}|${r.at.toISOString()}`).sort();
}

const baseline: Record<string, Awaited<ReturnType<typeof invoiceRows>>> = {};
let baselinePrice: { kg: number; kinds: number } | null = null;
let baselinePacking: { boxes: number; kg: number; m3: number } | null = null;
let baselineDraftFooter: unknown[] = [];

beforeAll(async () => {
  vedId = (await db.query.users.findFirst({ where: eq(users.phone, '+998900000004') }))!.id;
  logistId = (await db.query.users.findFirst({ where: eq(users.phone, '+998900000003') }))!.id;
  const s3 = SFX.slice(0, 3);
  wh.CN1 = await mintWarehouse(`LTA${s3}`, 'CN');
  wh.CN2 = await mintWarehouse(`LTB${s3}`, 'CN');
  wh.UZ = await mintWarehouse(`LTU${s3}`, 'UZ');
  wh.NOC = await mintWarehouse(`LTN${s3}`, '');
  wh.OTHER = await mintWarehouse(`LTO${s3}`, 'UZ');
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `LT${SFX}`, name: `Tarkib ${SFX}` })
    .returning({ id: clients.id });
  clientId = c!.id;
  await mintReceipt('R1');
  await mintReceipt('R2');
  await mintReceipt('R3');
  await mintLot('A', 'R1', 1, NAME_A, 100, '1000.000', '2.5000');
  await mintLot('B', 'R1', 2, `其他${SFX}`, 3, '30.000', '0.0300');
  await mintLot('C', 'R2', 1, `打印${SFX}`, 10, '100.000', '0.5000');
  await mintLot('D', 'R2', 2, `托盘${SFX}`, 100, '1000.000', '2.5000');
  await mintLot('F', 'R2', 3, `单箱${SFX}`, 10, '100.000', '0.5000');
  await mintLot('G', 'R2', 4, NAME_G, 10, '100.000', '0.5000');
  await mintLot('H', 'R2', 5, `混合${SFX}`, 10, '100.000', '0.5000');
  await mintLot('K', 'R3', 1, `作废${SFX}`, 2, '20.000', '0.1000');
  await mintLot('L', 'R3', 2, `光${SFX}`, 1, '10.000', '0.0500');

  // The documents: the client's packing list, a carton photo from receive
  // time (BEFORE the confirmation), one uploaded after it, a file on the
  // OTHER prixod, and the ones the other lots cite.
  await mintDoc('DOC', 'R1', 'file');
  await mintDoc('DOC_B', 'R1', 'file');
  await mintDoc('DOC_C', 'R1', 'file');
  await mintDoc('PHOTO_EARLY', 'R1', 'photo', ago(49));
  await mintDoc('DOC2', 'R2', 'file');
  await mintDoc('PHOTO_LATE', 'R2', 'photo');
  await mintDoc('DOC3', 'R3', 'file');

  // The trucks, in creation order.
  await mintTruck('INTERNAL', wh.CN1, wh.CN2, { status: 'arrived', departedAt: ago(72), arrivedAt: ago(60), createdAt: ago(80) });
  await mintTruck('CROSS', wh.CN2, wh.UZ, { status: 'in_transit', departedAt: ago(24), createdAt: ago(30) });
  await mintTruck('CROSS2', wh.CN2, wh.UZ, { status: 'loading', createdAt: ago(12) });
  await mintTruck('NOC', wh.CN1, wh.NOC, { status: 'in_transit', departedAt: ago(20), createdAt: ago(21) });
  await mintTruck('PAL', wh.CN1, wh.UZ, { status: 'in_transit', departedAt: ago(20), createdAt: ago(21) });
  await mintTruck('ONE', wh.CN1, wh.UZ, { status: 'in_transit', departedAt: ago(19), createdAt: ago(20) });
  await mintTruck('BARE', wh.CN1, wh.UZ, { status: 'loading', createdAt: ago(5) });

  // Lot A: all 100 rode the internal leg, 33 then crossed, 67 are being loaded.
  await ride(boxesOf.A!, 'INTERNAL', ago(72), false);
  await db.update(boxes).set({ currentWarehouseId: wh.CN2 }).where(inArray(boxes.id, boxesOf.A!));
  await ride(boxesOf.A!.slice(0, 33), 'CROSS', ago(24), true);
  await db
    .update(boxes)
    .set({ status: 'loading', currentBatchId: truck.CROSS2! })
    .where(inArray(boxes.id, boxesOf.A!.slice(33)));
  await ride(boxesOf.B!, 'CROSS', ago(24), true);
  await ride(boxesOf.C!, 'NOC', ago(20), true);
  for (let p = 0; p < 4; p += 1) {
    const [cr] = await db
      .insert(crates)
      .values({ code: `CR-LT${SFX}-${p}`, warehouseId: wh.CN1, clientId, kind: 'palet', createdBy: vedId })
      .returning({ id: crates.id });
    crateIds.push(cr!.id);
  }
  await ride(boxesOf.D!, 'PAL', ago(20), true, (i) => crateIds[Math.floor(i / 25)]!);
  await ride(boxesOf.F!.slice(0, 1), 'ONE', ago(19), true);
  await db.update(boxes).set({ status: 'loading', currentBatchId: truck.BARE! }).where(inArray(boxes.id, boxesOf.L!));

  // The money CTE of «Oldingi narx» inner-joins a live charge.
  const [ch] = await db
    .insert(clientTransactions)
    .values({
      clientId,
      type: 'charge',
      amount: '100.00',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '100.00',
      txDate: '2026-09-01',
      batchId: truck.CROSS!,
      createdBy: vedId,
    })
    .returning({ id: clientTransactions.id });
  chargeId = ch!.id;
  memorySnapshot = await memoryRows();
});

const pricePair = async () =>
  (await db.transaction((tx) => pricePairs(tx, [{ clientId, batchId: truck.CROSS! }]))).get(`${clientId}:${truck.CROSS!}`)!;

async function packingPhotoRows(batchKey: string) {
  const buf = await buildPackingPhotosXlsx(truck[batchKey]!);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf! as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0]!;
  const out: { code: string; product: string; boxes: unknown; kg: number; m3: number }[] = [];
  for (let r = 3; r < 400; r += 1) {
    const row = sheet.getRow(r);
    if (!row.getCell(1).value) break;
    out.push({
      code: String(row.getCell(1).value),
      product: String(row.getCell(2).value),
      boxes: row.getCell(3).value,
      kg: Number(row.getCell(4).value),
      m3: Number(row.getCell(5).value),
    });
  }
  return out;
}

async function draftPacking(batchKey: string) {
  const buf = await buildPackingXlsx(truck[batchKey]!);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf! as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0]!;
  const rows: unknown[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  const footer = rows.find((r) => String(r[1] ?? '').includes('ИТОГО'))!;
  return { rows, footer };
}

describe('lot tarkibi — the papers BEFORE any composition (the oracle)', () => {
  it('captures the single rows every later sum is held to', async () => {
    for (const key of ['CROSS', 'CROSS2', 'NOC', 'PAL', 'ONE']) baseline[key] = await invoiceRows(key);
    const a = baseline.CROSS!.find((r) => r.product === NAME_A)!;
    expect(a).toMatchObject({ unit: 'кг', kg: 330, places: 33 });
    expect(baseline.CROSS2!.find((r) => r.product === NAME_A)!.kg).toBe(670);
    baselinePrice = await pricePair();
    expect(baselinePrice).toMatchObject({ kg: 360, kinds: 2 });
    const photos = await packingPhotoRows('CROSS');
    const row = photos.find((r) => r.code.endsWith('-A'))!;
    baselinePacking = { boxes: Number(row.boxes), kg: row.kg, m3: row.m3 };
    baselineDraftFooter = (await draftPacking('CROSS')).footer;
  });
});

describe('lot tarkibi — the writer', () => {
  it('1. saves a separate composition: header, lines, an opaque rev and an audit row on the prixod', async () => {
    const { rev } = await save('A', OWNER_CASE());
    const view = (await compositionsFor([lot.A]))!.get(lot.A)!;
    expect(view.lines.map((l) => [l.seq, l.name, l.cartons, l.pieces, l.kg, l.m3])).toEqual([
      [1, 'Клавиатура', 50, 500, '600.000', '1.5000'],
      [2, 'Мышь', 50, 1000, '400.000', '1.0000'],
    ]);
    expect(view.rev).toBe(rev);
    expect(view.attachment.id).toBe(doc.DOC);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, rc.R1)))
      .orderBy(sql`${auditLog.createdAt} DESC`)
      .limit(1);
    expect((audit!.before as { lotComposition: unknown }).lotComposition).toBeNull();
    const after = (audit!.after as { lotComposition: { lines: string[]; document: string } }).lotComposition;
    expect(after.lines).toHaveLength(2);
    expect(after.lines[0]).toBe('Клавиатура — 50 kar, 500 шт, 600.000 kg, 1.5000 m³');

    const again = await save('A', OWNER_CASE());
    expect(again.rev).not.toBe(rev);
    const [second] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, rc.R1)))
      .orderBy(sql`${auditLog.createdAt} DESC`)
      .limit(1);
    expect((second!.before as { lotComposition: { lines: string[] } }).lotComposition.lines).toEqual(after.lines);
  });

  it('2. every refusal, named by row, field and sums', async () => {
    const r = async (lines: ReturnType<typeof line>[], opts?: Parameters<typeof save>[2]) => refusal(save('A', lines, opts));
    expect((await r([line('Клавиатура', '100', '1000', '2.5')])).code).toBe('lines_count');
    expect(await r([line('Клавиатура', '50', '600', '1.5'), line('x', '50', '400', '1')])).toMatchObject({ code: 'bad_line', seq: 2 });
    expect(await r([line('Клавиатура', '50', 'abc', '1.5'), line('Мышь', '50', '400', '1')])).toMatchObject({
      code: 'bad_number',
      seq: 1,
      field: 'kg',
    });
    expect(await r([line('Клавиатура', '50', '600', '1.5', '', '847'), line('Мышь', '50', '400', '1')])).toMatchObject({
      code: 'bad_tnved',
      seq: 1,
    });
    expect(await r([line('Мышь', '50', '600', '1.5'), line(' мышь ', '50', '400', '1')])).toMatchObject({
      code: 'duplicate_name',
      seq: 2,
    });
    expect((await r([line('Клавиатура', '50', '600', '1.5'), line('Мышь', '', '400', '1')])).code).toBe('cartons_partial');
    expect(await r([line('Клавиатура', '50', '600', '1.5'), line('Мышь', '49', '400', '1')])).toMatchObject({
      code: 'cartons_sum',
      sums: { sum: '99', lot: '100' },
    });
    expect(await r([line('Клавиатура', '50', '600.001', '1.5'), line('Мышь', '50', '400', '1')])).toMatchObject({
      code: 'kg_sum',
      sums: { sum: '1000.001', lot: '1000.000' },
    });
    expect(await r([line('Клавиатура', '50', '600', '1.5001'), line('Мышь', '50', '400', '1')])).toMatchObject({
      code: 'm3_sum',
      sums: { sum: '2.5001', lot: '2.5000' },
    });
    expect((await r(OWNER_CASE(), { docKey: null })).code).toBe('document_required');
    expect((await r(OWNER_CASE(), { docKey: 'DOC2' })).code).toBe('document_not_on_receipt');
    expect((await r(OWNER_CASE(), { docKey: 'PHOTO_EARLY' })).code).toBe('document_is_photo');
    // A photo uploaded AFTER the confirmation is somebody's document.
    await save('H', [line('Мышь', '', '60', '0.3', '10'), line('Клавиатура', '', '40', '0.2', '5')], { docKey: 'PHOTO_LATE' });
    expect((await compositionsFor([lot.H])).get(lot.H)!.attachment.id).toBe(doc.PHOTO_LATE);
  });

  it('3. the door: the warehouse, a VED scoped elsewhere and a lot that does not exist all say «forbidden»', async () => {
    const operator = { ...ved(), permissions: new Set(['receipts.create', 'receipts.edit', 'scan.load']), warehouseScoped: true, warehouseIds: [wh.CN1] };
    expect((await refusal(save('A', OWNER_CASE(), { actor: operator }))).code).toBe('forbidden');
    const elsewhere = { ...ved(), warehouseScoped: true, warehouseIds: [wh.OTHER] };
    expect((await refusal(save('A', OWNER_CASE(), { actor: elsewhere }))).code).toBe('forbidden');
    expect((await refusal(compositionDoor(ved(), randomUUID(), { requireConfirmed: true }))).code).toBe('forbidden');
    // Scoped to the destination while cartons ride there: the receipt card's own rule.
    const atDestination = { ...ved(), warehouseScoped: true, warehouseIds: [wh.UZ] };
    await expect(compositionDoor(atDestination, lot.A, { requireConfirmed: true })).resolves.toBeTruthy();
  });

  it('4. ABA: a clear and a colleague’s new composition never let the OLD token through', async () => {
    const lines = () => [line('Клавиатура', '5', '50', '0.25', '10'), line('Мышь', '5', '50', '0.25', '20')];
    const { rev: r1 } = await save('F', lines(), { docKey: 'DOC2' });
    await clearComposition({ lotId: lot.F, seenRev: r1 }, ved(), ctx(vedId));
    await save('F', lines(), { docKey: 'DOC2', actor: logist(), seenRev: 0 });
    const err = await refusal(save('F', lines(), { docKey: 'DOC2', seenRev: r1 }));
    expect(err.code).toBe('composition_changed');
  });

  it('5. lot_changed on posted totals, composition_changed on a stale rev, receipt_not_confirmed on a voided prixod', async () => {
    const totals = await totalsOf('A');
    const current = (await compositionsFor([lot.A])).get(lot.A)!;
    const press = (over: Record<string, unknown>) =>
      refusal(
        saveComposition(
          { lotId: lot.A, seenRev: current.rev, seenBoxCount: totals.boxCount, seenKg: totals.kg, seenM3: totals.m3, attachmentId: doc.DOC, lines: OWNER_CASE(), ...over },
          ved(),
          ctx(vedId),
        ),
      );
    expect((await press({ seenKg: '999.000' })).code).toBe('lot_changed');
    expect((await press({ seenRev: current.rev - 1 })).code).toBe('composition_changed');
    const self = await press({ seenRev: current.rev + 1000 });
    expect(self.bySelf).toBe(true);

    // K is composed, then its prixod is voided: no more saves, but a clear.
    await save('K', [line('Клавиатура', '1', '10', '0.05'), line('Мышь', '1', '10', '0.05')], { docKey: 'DOC3' });
    await db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: vedId, voidReason: `tarkib ${SFX}` })
      .where(eq(receipts.id, rc.R3));
    expect((await refusal(save('K', [line('Клавиатура', '1', '10', '0.05'), line('Мышь', '1', '10', '0.05')], { docKey: 'DOC3' }))).code).toBe(
      'receipt_not_confirmed',
    );
    const k = (await compositionsFor([lot.K])).get(lot.K)!;
    await clearComposition({ lotId: lot.K, seenRev: k.rev }, ved(), ctx(vedId));
    expect((await compositionsFor([lot.K])).has(lot.K)).toBe(false);
  });
});

/** A second connection, its transaction left open while the press runs. */
async function withHolder<T>(fn: (held: postgres.ReservedSql) => Promise<T>): Promise<T> {
  const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', { max: 1, onnotice: () => {} });
  const held = await helper.reserve();
  try {
    return await fn(held);
  } finally {
    held.release();
    await helper.end();
  }
}

async function waitForLock(like: string) {
  for (let i = 0; i < 250; i += 1) {
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE ${like} AND pid <> pg_backend_pid()`);
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe('lot tarkibi — concurrency, deterministic', () => {
  it('6a. the count press (lot, then truck) and a save both commit — no deadlock', async () => {
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`SELECT pg_advisory_xact_lock(hashtext(${'lt-' + SFX}))`;
      await held`SELECT id FROM receipt_lots WHERE id = ${lot.A} FOR UPDATE`;
      const saving = save('A', OWNER_CASE());
      expect(await waitForLock('%receipt_lots%')).toBe(true);
      await held`UPDATE batches SET status = 'loading' WHERE id = ${truck.CROSS2!}`;
      await held`COMMIT`;
      await expect(saving).resolves.toMatchObject({ rev: expect.any(Number) });
    });
  });

  it('6b. a void in flight on the prixod answers «busy» at once (NOWAIT)', async () => {
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`SELECT id FROM receipts WHERE id = ${rc.R1} FOR UPDATE`;
      await expect(save('A', OWNER_CASE())).rejects.toMatchObject({ code: '55P03' });
      await held`ROLLBACK`;
    });
  });

  it('6c. a delete of the document in flight: the save waits, the delete rolls back, the save commits', async () => {
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`DELETE FROM attachments WHERE id = ${doc.DOC_C!}`;
      const saving = save('A', OWNER_CASE(), { docKey: 'DOC_C' });
      expect(await waitForLock('%attachments%')).toBe(true);
      await held`ROLLBACK`;
      await expect(saving).resolves.toMatchObject({ rev: expect.any(Number) });
    });
    expect((await compositionsFor([lot.A])).get(lot.A)!.attachment.id).toBe(doc.DOC_C);
  });
});

describe('lot tarkibi — the papers', () => {
  it('7. the invoice: cumulative cartons and pieces, the single figure kept, the old rows untouched', async () => {
    // The population: every truck that carries or carried a carton of the
    // lot, the internal leg named as not crossing.
    const population = (await lotTrucksFor(db, [lot.A])).get(lot.A)!;
    const byId = new Map(population.map((t) => [t.batchId, t]));
    expect(byId.get(truck.INTERNAL!)).toMatchObject({ crosses: false, n: 100 });
    expect(byId.get(truck.CROSS!)).toMatchObject({ crosses: true, n: 33 });
    expect(byId.get(truck.CROSS2!)).toMatchObject({ crosses: true, n: 67, departedAt: null });
    await save('C', [line(`Принтер${SFX}`, '6', '60', '0.3', '6'), line(`Сканер${SFX}`, '4', '40', '0.2', '4')], { docKey: 'DOC2' });
    await save('D', [line('Клавиатура', '50', '600', '1.5'), line('Мышь', '50', '400', '1.0')], { docKey: 'DOC2' });
    const cross = await invoiceRows('CROSS');
    const cross2 = await invoiceRows('CROSS2');
    const a1 = ofLines(cross);
    const a2 = ofLines(cross2);
    expect(a1.map((r) => r.places)).toEqual([17, 16]);
    expect(a2.map((r) => r.places)).toEqual([33, 34]);
    expect(sum1(a1.map((r) => r.kg))).toBe(baseline.CROSS!.find((r) => r.product === NAME_A)!.kg);
    expect(sum1(a2.map((r) => r.kg))).toBe(baseline.CROSS2!.find((r) => r.product === NAME_A)!.kg);
    expect(a1.every((r) => r.note?.includes('33 из 100'))).toBe(true);
    // Σ over the lot's two crossing trucks = what was typed (R13, R1).
    expect([a1[0]!.places, a2[0]!.places].reduce((s, v) => Number(s) + Number(v), 0)).toBe(50);
    expect([a1[1]!.places, a2[1]!.places].reduce((s, v) => Number(s) + Number(v), 0)).toBe(50);
    expect(a1[0]!.quantity + a2[0]!.quantity).toBe(500);
    expect(a1[1]!.quantity + a2[1]!.quantity).toBe(1000);
    expect(a1.every((r) => r.unit === 'шт' && r.code === '')).toBe(true);
    // The uncomposed lot on the same truck prints exactly its old row.
    const b = (rows: typeof cross) => rows.find((r) => r.product.startsWith('其他'));
    expect(b(cross)).toEqual(b(baseline.CROSS!));

    // A departed truck's paper never moves because another truck's count did.
    const off = boxesOf.A!.slice(95);
    await db.update(boxes).set({ currentBatchId: null, status: 'in_stock' }).where(inArray(boxes.id, off));
    expect(ofLines(await invoiceRows('CROSS'))).toEqual(a1);
    await db.update(boxes).set({ currentBatchId: truck.CROSS2!, status: 'loading' }).where(inArray(boxes.id, off));

    // The whole lot on one truck: the typed figures, no note.
    const noc = await invoiceRows('NOC');
    expect(noc.map((r) => [r.product, r.kg, r.places, r.quantity, r.unit, r.note])).toEqual([
      [`Принтер${SFX}`, 60, 6, 6, 'шт', null],
      [`Сканер${SFX}`, 40, 4, 4, 'шт', null],
    ]);
    // Four pallets of 25 on a 50/50 lot: 2 / 2 places, said to be split.
    const pal = await invoiceRows('PAL');
    expect(pal.map((r) => r.places)).toEqual([2, 2]);
    expect(pal.every((r) => r.note?.includes('поддоне'))).toBe(true);
    // The owner's 3a: lot D states no pieces, so each line prints «кг» and
    // its quantity IS its kg — as an uncomposed lot always has.
    expect(pal.map((r) => [r.product, r.unit, r.quantity, r.kg])).toEqual([
      ['Клавиатура', 'кг', 600, 600],
      ['Мышь', 'кг', 400, 400],
    ]);
    // A one-carton truck of a separate lot: the one line it carries.
    const one = await invoiceRows('ONE');
    expect(one).toHaveLength(1);
    expect(one[0]!.product).toBe('Клавиатура');
    expect(one[0]!.kg).toBe(baseline.ONE![0]!.kg);
    // …and its stated pieces (10 over 5 cartons) land 2 on that one carton: «шт».
    expect([one[0]!.unit, one[0]!.quantity]).toEqual(['шт', 2]);
    // Every row's amount stays the live I×E, on composed and plain rows alike.
    for (const key of ['CROSS', 'CROSS2', 'NOC', 'PAL', 'ONE']) {
      const amounts = await invoiceAmounts(key);
      expect(amounts.length, key).toBeGreaterThan(0);
      expect(amounts.map((a) => a.formula), key).toEqual(amounts.map((a) => `I${a.row}*E${a.row}`));
    }
  });

  it('8. both packing lists: line rows summing to what the same builder printed before, the draft footer unchanged', async () => {
    const photos = await packingPhotoRows('CROSS');
    const lines = photos.filter((r) => r.code.endsWith('-A'));
    expect(lines.map((r) => r.product)).toEqual(['Клавиатура — 170 шт', 'Мышь — 320 шт']);
    expect(lines.map((r) => r.boxes)).toEqual([17, 16]);
    expect(sum1(lines.map((r) => r.kg))).toBe(baselinePacking!.kg);
    expect(Math.round(lines.reduce((s, r) => s + r.m3, 0) * 1000) / 1000).toBe(baselinePacking!.m3);
    const draft = await draftPacking('CROSS');
    expect(draft.footer).toEqual(baselineDraftFooter);
    const draftLines = draft.rows.filter((r) => String(r[2] ?? '').startsWith('Клавиатура') || String(r[2] ?? '').startsWith('Мышь'));
    expect(draftLines).toHaveLength(2);
    expect(sum1(draftLines.map((r) => Number(r[5])))).toBe(baselinePacking!.kg);
  });

  it('9. the agent file: a fully planned lot (loose + crated) prints its contents once, a partial plan says ≈', async () => {
    await save('G', [line('Клавиатура', '5', '60', '0.3', '50'), line('Мышь', '5', '40', '0.2', '100')], { docKey: 'DOC2' });
    const [crate] = await db
      .insert(crates)
      .values({ code: `CR-LTG${SFX}`, warehouseId: wh.CN1, clientId, kind: 'yashik', createdBy: vedId })
      .returning({ id: crates.id });
    crateIds.push(crate!.id);
    const plan = async (rows: { lotKey: LotKey; crateId: string | null; n: number; kg: string; m3: string }[]) => {
      const [p] = await db
        .insert(loadPlans)
        .values({ originWarehouseId: wh.CN1, destWarehouseId: wh.UZ, createdBy: vedId, status: 'pending_agent', currentVersionNo: 1 })
        .returning({ id: loadPlans.id });
      planIds.push(p!.id);
      const [v] = await db
        .insert(loadPlanVersions)
        .values({ planId: p!.id, versionNo: 1, submittedBy: vedId, totalBoxes: 10, totalKg: '100', totalM3: '0.5' })
        .returning({ id: loadPlanVersions.id });
      await db.insert(loadPlanLines).values(
        rows.map((r) => ({ versionId: v!.id, lotId: lot[r.lotKey], crateId: r.crateId, plannedBoxCount: r.n, plannedKg: r.kg, plannedM3: r.m3 })),
      );
      const buf = await buildAgentXlsx(p!.id, 1);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf! as unknown as ExcelJS.Buffer);
      const cells: { value: string; note: string | null }[] = [];
      wb.worksheets[0]!.eachRow((row) => {
        const cell = row.getCell(2);
        if (cell.value) cells.push({ value: String(cell.value), note: cell.note ? JSON.stringify(cell.note) : null });
      });
      return cells;
    };
    const full = await plan([
      { lotKey: 'G', crateId: null, n: 5, kg: '50.000', m3: '0.2500' },
      { lotKey: 'G', crateId: crate!.id, n: 5, kg: '50.000', m3: '0.2500' },
    ]);
    const fullPlanId = planIds.at(-1)!;
    // The owner's 2a: the lot's OWN Chinese name stays in front, the contents
    // follow on the next line; the lot's other (crated) row is the bare name.
    // The sheet keeps the plan lines' order (uuidv7 ids, the loose line first).
    const gRows = full.filter((c) => c.value.startsWith(NAME_G));
    expect(gRows).toHaveLength(2);
    expect(gRows[0]!.value.startsWith(`${NAME_G}\nСостав лота (весь план) / Lot contents (whole plan): `)).toBe(true);
    expect(gRows[1]!.value).toBe(NAME_G);
    const gLines = await db
      .select({ crateId: loadPlanLines.crateId })
      .from(loadPlanLines)
      .innerJoin(loadPlanVersions, eq(loadPlanLines.versionId, loadPlanVersions.id))
      .where(and(eq(loadPlanVersions.planId, fullPlanId), eq(loadPlanLines.lotId, lot.G)))
      .orderBy(asc(loadPlanLines.id));
    expect(gLines.map((l) => l.crateId)).toEqual([null, crate!.id]);
    const withContents = full.filter((c) => c.value.includes('Lot contents'));
    expect(withContents).toHaveLength(1);
    expect(withContents[0]!.value).toContain('Клавиатура — 5 кор. · 60.0 кг · 0.300 м³ · 50 шт');
    expect(withContents[0]!.value).toContain('Мышь — 5 кор. · 40.0 кг · 0.200 м³ · 100 шт');
    expect(withContents[0]!.value).not.toContain('≈');
    expect(withContents[0]!.note).toBeNull();
    const partial = await plan([{ lotKey: 'F', crateId: null, n: 4, kg: '40.000', m3: '0.2000' }]);
    const fCell = partial.find((c) => c.value.includes('Lot contents'))!;
    expect(fCell.value).toContain('≈');
    expect(fCell.note).toContain('Estimate');
  });
});

describe('lot tarkibi — the Bojxona tab', () => {
  it('10. line rows instead of the lot’s product row, line codes stored on the line and never in the memory', async () => {
    const rows = await batchTnvedProducts(truck.CROSS!, true);
    const lineRows = rows.filter((r) => r.line);
    expect(lineRows.map((r) => r.nameZh)).toEqual(['Клавиатура', 'Мышь']);
    expect(rows.some((r) => !r.line && r.nameZh === NAME_A)).toBe(false);
    // A product row keeps the lot's own box_count; the line figures are «on this truck».
    expect(rows.find((r) => !r.line)!.boxCount).toBe(3);
    expect(lineRows.map((r) => [r.line!.cartons, r.boxCount])).toEqual([
      [17, 100],
      [16, 100],
    ]);
    const missing = missingTnvedCount(rows);
    const mouse = lineRows[1]!.line!;
    await setLineCodes({ lotId: lot.A, seenRev: mouse.rev, codes: [{ lineId: mouse.lineId!, code: '8471607000' }] }, ved(), ctx(vedId));
    const after = await batchTnvedProducts(truck.CROSS!, true);
    expect(missingTnvedCount(after)).toBe(missing - 1);
    expect(after.find((r) => r.line?.seq === 2)!.code).toBe('8471607000');
    expect((await invoiceRows('CROSS')).find((r) => r.product === 'Мышь')!.code).toBe('8471607000');

    // The action door: a line's name is not a product row of the truck.
    override.actor = { ...ved(), fullName: 'VED', phone: null, username: null, locale: 'uz', active: true, sessionId: randomUUID() };
    // A forged id is a refusal in words, never a 22P02 error page; a forged
    // clear is «validation», never a TypeError (the review's nits).
    expect(await saveLineCodesAction('not-a-uuid', [{ lotId: lot.A, lineId: mouse.lineId!, rev: mouse.rev, code: '1234' }])).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    expect(await saveLineCodesAction(truck.CROSS!, [{ lotId: 'x', lineId: mouse.lineId!, rev: mouse.rev, code: '1234' }])).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    expect(await saveTnvedAction('not-a-uuid', [{ nameZh: NAME_A, nameRu: null, code: '8471607000', source: 'manual' }])).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    expect(await clearLotCompositionAction(null as never)).toMatchObject({ ok: false, error: 'validation' });
    expect(
      await saveTnvedAction(truck.CROSS!, [{ nameZh: 'Мышь', nameRu: null, code: '8471607000', source: 'manual' }]),
    ).toMatchObject({ ok: false, error: 'not_on_truck' });
    // The truck's card door (Access-5): a scoped holder outside its ends.
    override.actor = { ...override.actor, warehouseScoped: true, warehouseIds: [wh.OTHER] };
    expect(
      await saveTnvedAction(truck.CROSS!, [{ nameZh: `其他${SFX}`, nameRu: null, code: '8471607000', source: 'manual' }]),
    ).toMatchObject({ ok: false, error: 'forbidden' });
    expect(
      await saveLineCodesAction(truck.CROSS!, [{ lotId: lot.A, lineId: mouse.lineId!, rev: 0, code: '1234' }]),
    ).toMatchObject({ ok: false, error: 'forbidden' });
    override.actor = null;
    expect(await memoryRows()).toEqual(memorySnapshot);
  });
});

function signInVed() {
  session.user = { id: vedId, phone: '+998900000004', username: null, fullName: 'VED', locale: 'uz', active: true, sessionId: randomUUID() };
}
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
async function tick(batchKey: string, fields: Record<string, string>) {
  try {
    await setSentToAgentAction(form({ batchId: truck[batchKey]!, ...fields }));
    return 'ok';
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? '';
    if (digest.startsWith('NEXT_REDIRECT')) return digest;
    throw err;
  }
}
const sentAt = async (batchKey: string) =>
  (await db.query.batches.findFirst({ where: eq(batches.id, truck[batchKey]!) }))!.sentToAgentAt;

describe('lot tarkibi — the freeze (7a)', () => {
  it('12. the tick copies every lot on the truck; later saves reach only the unsent trucks; the un-tick thaws', async () => {
    signInVed();
    expect(await tick('CROSS', { want: 'sent', paperStamp: await paperStampFor(truck.CROSS!) })).toBe('ok');
    expect(await sentAt('CROSS')).not.toBeNull();
    const frozen = await db.select().from(batchSentCompositions).where(eq(batchSentCompositions.batchId, truck.CROSS!));
    expect(frozen.map((r) => r.lotId).sort()).toEqual([lot.A, lot.B].sort());
    expect(frozen.find((r) => r.lotId === lot.B)!.lines).toBeNull();
    const sentRows = ofLines(await invoiceRows('CROSS'));

    // A correction after the papers went: it saves, and only CROSS2 hears it.
    const c2Before = ofLines(await invoiceRows('CROSS2'));
    await save('A', [line('Клавиатура', '50', '550', '1.5', '500'), line('Мышь', '50', '450', '1.0', '1000')], { docKey: 'DOC_C' });
    expect(ofLines(await invoiceRows('CROSS'))).toEqual(sentRows);
    const c2 = ofLines(await invoiceRows('CROSS2'));
    expect(sum1(c2.map((r) => r.kg))).toBe(670);
    expect(c2[0]!.kg).not.toBe(c2Before[0]!.kg);
    // A lot composed AFTER the tick stays one row on the sent truck.
    await save('B', [line(`Наушники${SFX}`, '2', '20', '0.02'), line(`Кабель${SFX}`, '1', '10', '0.01')], { docKey: 'DOC_B' });
    expect((await invoiceRows('CROSS')).filter((r) => r.product.startsWith('其他'))).toHaveLength(1);
    const [rowsOnTab] = [(await batchTnvedProducts(truck.CROSS!, true)).filter((r) => r.line)];
    expect(rowsOnTab.every((r) => r.line!.frozen && r.line!.lineId === null)).toBe(true);

    // The un-tick: the truck's papers read the live compositions again.
    expect(await tick('CROSS', { want: 'unsent' })).toBe('ok');
    expect(await sentAt('CROSS')).toBeNull();
    // The audit counts the COMPOSED lots both ways: A only — B was frozen
    // uncomposed (the review's nit: the un-tick counted every row, 2).
    const ticks = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'batch'), eq(auditLog.entityId, truck.CROSS!)))
      .orderBy(desc(auditLog.createdAt))
      .limit(2);
    expect(ticks.map((r) => r.after)).toEqual([
      { sentToAgent: false, frozenLots: 1 },
      { sentToAgent: true, frozenLots: 1 },
    ]);
    expect(await db.select().from(batchSentCompositions).where(eq(batchSentCompositions.batchId, truck.CROSS!))).toHaveLength(0);
    const live = await invoiceRows('CROSS');
    expect(ofLines(live)).toHaveLength(2);
    expect(live.filter((r) => r.product === `Наушники${SFX}` || r.product === `Кабель${SFX}`)).toHaveLength(2);
  });

  it('12b. a stamp drawn before a save refuses the tick: nothing frozen, nothing sent', async () => {
    signInVed();
    const stale = await paperStampFor(truck.CROSS!);
    await save('A', [line('Клавиатура', '50', '600', '1.5', '500'), line('Мышь', '50', '400', '1.0', '1000')], { docKey: 'DOC_C' });
    const answer = await tick('CROSS', { want: 'sent', paperStamp: stale });
    expect(answer).toContain('tarkib=yangilandi');
    expect(await sentAt('CROSS')).toBeNull();
    expect(await db.select().from(batchSentCompositions).where(eq(batchSentCompositions.batchId, truck.CROSS!))).toHaveLength(0);
  });

  it('12c. a bare post on a truck with no composed lot still toggles, as it always has', async () => {
    signInVed();
    expect(await tick('BARE', {})).toBe('ok');
    expect(await sentAt('BARE')).not.toBeNull();
    expect(await tick('BARE', {})).toBe('ok');
    expect(await sentAt('BARE')).toBeNull();
  });

  it('12d. the freeze holds the POSITIONS: a sibling forming, departing or dialled after the tick never moves the sent paper', async () => {
    // EARLY, created before CROSS2, takes 11 of the 67 and one carton waits
    // on the shelf: the lot's order is CROSS [0,33) · EARLY [33,44) · CROSS2
    // [44,99) — the review's case, CROSS2 ticked while EARLY still forms. The
    // odd 11 and 55 are the point: on a 50/50 lot a run's lines depend only
    // on the parity of its start and length, and [44,99) prints 28/27 where
    // [33,88) prints 27/28 (with 10 and 57 both runs print 28/29 — #166).
    await mintTruck('EARLY', wh.CN2, wh.UZ, { status: 'loading', createdAt: ago(13) });
    const early = boxesOf.A!.slice(33, 44);
    const shelf = boxesOf.A!.slice(99);
    await db.update(boxes).set({ currentBatchId: truck.EARLY! }).where(inArray(boxes.id, early));
    await db.update(boxes).set({ currentBatchId: null, status: 'in_stock' }).where(inArray(boxes.id, shelf));
    signInVed();
    const lines = async () => ofLines(await invoiceRows('CROSS2'));
    const tabRows = async () =>
      (await batchTnvedProducts(truck.CROSS2!, (await db.query.batches.findFirst({ where: eq(batches.id, truck.CROSS2!) }))!.departedAt !== null))
        .filter((r) => r.line)
        .map((r) => [r.nameZh, r.line!.cartons, r.line!.pieces, r.line!.kg]);

    // A stamp drawn before a sibling moved refuses the tick: the positions are in it.
    const stale = await paperStampFor(truck.CROSS2!);
    await db.update(boxes).set({ currentBatchId: null, status: 'in_stock' }).where(inArray(boxes.id, early.slice(0, 2)));
    expect(await tick('CROSS2', { want: 'sent', paperStamp: stale })).toContain('tarkib=yangilandi');
    expect(await sentAt('CROSS2')).toBeNull();
    await db.update(boxes).set({ currentBatchId: truck.EARLY!, status: 'loading' }).where(inArray(boxes.id, early.slice(0, 2)));

    const sent = await lines();
    const sentTab = await tabRows();
    expect(sent.map((r) => r.places)).toEqual([28, 27]);
    expect(await tick('CROSS2', { want: 'sent', paperStamp: await paperStampFor(truck.CROSS2!) })).toBe('ok');
    const frozen = await db
      .select({ segments: batchSentCompositions.segments })
      .from(batchSentCompositions)
      .where(and(eq(batchSentCompositions.batchId, truck.CROSS2!), eq(batchSentCompositions.lotId, lot.A)));
    expect(frozen[0]!.segments).toEqual([[44, 99]]);

    // CROSS2 leaves Kashgar while EARLY still forms: the departed-first
    // order would put it straight after CROSS — [33,88), 27/28.
    await db.update(batches).set({ status: 'in_transit', departedAt: new Date() }).where(eq(batches.id, truck.CROSS2!));
    expect(await lines()).toEqual(sent);
    expect(await tabRows()).toEqual(sentTab);
    // EARLY dialled down, then EARLY departing too: still the sent paper.
    await db.update(boxes).set({ currentBatchId: null, status: 'in_stock' }).where(inArray(boxes.id, early.slice(0, 5)));
    expect(await lines()).toEqual(sent);
    await db.update(batches).set({ status: 'in_transit', departedAt: new Date() }).where(eq(batches.id, truck.EARLY!));
    expect(await lines()).toEqual(sent);
    // …and EARLY takes the positions the sent truck left free.
    const population = (await lotTrucksFor(db, [lot.A])).get(lot.A)!;
    expect(population.find((t) => t.batchId === truck.CROSS2)).toMatchObject({ frozen: true, frozenSegments: [[44, 99]] });
    expect(population.find((t) => t.batchId === truck.EARLY)).toMatchObject({ frozen: false, frozenSegments: null });

    // Back as the file found it: CROSS2 forming and unsent with its 67.
    expect(await tick('CROSS2', { want: 'unsent' })).toBe('ok');
    await db.update(batches).set({ status: 'loading', departedAt: null }).where(eq(batches.id, truck.CROSS2!));
    await db.update(batches).set({ status: 'cancelled', departedAt: null }).where(eq(batches.id, truck.EARLY!));
    await db.update(boxes).set({ currentBatchId: truck.CROSS2!, status: 'loading' }).where(inArray(boxes.id, [...early, ...shelf]));
    expect((await lotTrucksFor(db, [lot.A])).get(lot.A)!.find((t) => t.batchId === truck.CROSS2)).toMatchObject({ n: 67 });
  });

  it('12e. a truck ticked before 0122: the backfill freezes it as sent, and a later save says so honestly', async () => {
    // The state on deploy morning: no composition existed when CROSS's
    // papers went, and the tick left no copy.
    const current = (await compositionsFor([lot.A])).get(lot.A)!;
    await clearComposition({ lotId: lot.A, seenRev: current.rev }, ved(), ctx(vedId));
    await db.update(batches).set({ sentToAgentAt: '2026-09-30' }).where(inArray(batches.id, [truck.CROSS!, truck.CROSS2!]));
    expect((await invoiceRows('CROSS')).filter((r) => r.product === NAME_A)).toHaveLength(1);

    // The migration's OWN backfill statement, scoped to CROSS: CROSS2 stands
    // for a truck the lot boarded after its tick — no copy, reads live.
    const migration = readFileSync('src/modules/platform/db/migrations/0122_lot_composition.sql', 'utf8');
    const backfill = migration.split('--> statement-breakpoint').at(-1)!;
    expect(backfill).toContain('INSERT INTO "batch_sent_compositions"');
    const scope = `WHERE t.sent_to_agent_at IS NOT NULL AND t.status <> 'cancelled'`;
    expect(backfill.split(scope)).toHaveLength(3);
    await db.execute(sql.raw(backfill.split(scope).join(`${scope} AND t.id = '${truck.CROSS!}'`)));
    const rows = await db.select().from(batchSentCompositions).where(eq(batchSentCompositions.batchId, truck.CROSS!));
    expect(rows.map((r) => [r.lotId, r.lines, r.rev, r.segments]).sort()).toEqual(
      [
        [lot.A, null, null, null],
        [lot.B, null, null, null],
      ].sort(),
    );
    // As sent: every lot ONE row — B, composed after the tick, included.
    const asSent = await invoiceRows('CROSS');
    expect(asSent.filter((r) => r.product === NAME_A || r.product.startsWith('其他'))).toHaveLength(2);

    // A composition saved now: the sent truck keeps its one row, and ✅ names
    // only the truck whose papers hold a copy of THIS lot.
    override.actor = { ...ved(), fullName: 'VED', phone: null, username: null, locale: 'uz', active: true, sessionId: randomUUID() };
    const totals = await totalsOf('A');
    const answer = await saveLotCompositionAction({
      lotId: lot.A,
      seenRev: 0,
      seenBoxCount: totals.boxCount,
      seenKg: totals.kg,
      seenM3: totals.m3,
      attachmentId: doc.DOC_C,
      lines: OWNER_CASE(),
    });
    override.actor = null;
    expect(answer).toMatchObject({ ok: true, frozen: [`LTTCROSS-${SFX}`] });
    expect(await invoiceRows('CROSS')).toEqual(asSent);
    expect((await batchTnvedProducts(truck.CROSS!, true)).some((r) => r.line)).toBe(false);
    const population = (await lotTrucksFor(db, [lot.A])).get(lot.A)!;
    expect(population.filter((t) => t.frozen).map((t) => t.batchId)).toEqual([truck.CROSS]);
    expect(ofLines(await invoiceRows('CROSS2'))).toHaveLength(2);

    signInVed();
    expect(await tick('CROSS', { want: 'unsent' })).toBe('ok');
    await db.update(batches).set({ sentToAgentAt: null }).where(eq(batches.id, truck.CROSS2!));
    expect(await db.select().from(batchSentCompositions).where(eq(batchSentCompositions.batchId, truck.CROSS!))).toHaveLength(0);
  });

  it('12f. the tick against an unload press holding the truck (truck, then lot): both commit — no deadlock', async () => {
    signInVed();
    const stamp = await paperStampFor(truck.CROSS!);
    await withHolder(async (held) => {
      await held`BEGIN`;
      // count-accept's order: the truck row, then the lot row.
      await held`SELECT id FROM batches WHERE id = ${truck.CROSS!} FOR NO KEY UPDATE`;
      const ticking = tick('CROSS', { want: 'sent', paperStamp: stamp });
      expect(await waitForLock('%batches%')).toBe(true);
      await held`SELECT id FROM receipt_lots WHERE id = ${lot.A} FOR UPDATE`;
      await held`COMMIT`;
      expect(await ticking).toBe('ok');
    });
    expect(await sentAt('CROSS')).not.toBeNull();
    expect(await tick('CROSS', { want: 'unsent' })).toBe('ok');
    expect(await sentAt('CROSS')).toBeNull();
  });

  it('12g. a half-applied deploy: the tick is the plain toggle it was, both ways — never the error page', async () => {
    signInVed();
    behind.on = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await tick('BARE', { want: 'sent', paperStamp: '' })).toBe('ok');
      expect(await sentAt('BARE')).not.toBeNull();
      expect(await tick('BARE', { want: 'unsent' })).toBe('ok');
      expect(await sentAt('BARE')).toBeNull();
      // …and says so where an operator reads it.
      expect(warn.mock.calls.filter(([line]) => String(line).startsWith('[tick] server behind'))).toHaveLength(2);
    } finally {
      behind.on = false;
      warn.mockRestore();
    }
    expect(await db.select().from(batchSentCompositions).where(eq(batchSentCompositions.batchId, truck.BARE!))).toHaveLength(0);
  });
});

describe('lot tarkibi — the price history and the stale lot', () => {
  it('13. a composed lot counts as its lines; the kg the per-cube figure divides by does not move', async () => {
    const now = await pricePair();
    expect(now.kg).toBe(baselinePrice!.kg);
    expect(now.kinds).toBe(4); // A's two lines + B's two lines
    expect(now.kinds).toBeGreaterThan(baselinePrice!.kinds);
    // B stated with A's own two goods: two kinds, not four (counted by line
    // ID they read «aralash · 4 xil» — the review's nit).
    await save('B', [line('Клавиатура', '2', '20', '0.02'), line('Мышь', '1', '10', '0.01')], { docKey: 'DOC_B' });
    expect((await pricePair()).kinds).toBe(2);
    // B back to its own goods: test 11 reads CROSS's «Клавиатура» rows as A's.
    await save('B', [line(`Наушники${SFX}`, '2', '20', '0.02'), line(`Кабель${SFX}`, '1', '10', '0.01')], { docKey: 'DOC_B' });
  });

  it('11. stale: the lot grows → ⚠ and «taxminiy» papers summing to the new figure; a count change alone is stale too', async () => {
    await db.transaction((tx) =>
      growLotInTx(tx, { lotId: lot.A, add: 2, warehouseId: wh.CN2, actorId: vedId, reason: 'tarkib test', batchId: truck.CROSS2!, side: 'load' }),
    );
    const grown = await totalsOf('A');
    expect(grown.boxCount).toBe(102);
    const comp = (await compositionsFor([lot.A])).get(lot.A)!;
    expect(isStale(comp, grown)).toBe(true);
    const rows = ofLines(await invoiceRows('CROSS'));
    expect(rows.every((r) => r.note?.includes('лот изменён'))).toBe(true);
    expect(sum1(rows.map((r) => r.kg))).toBe(Math.round(((33 * Number(grown.kg)) / 102) * 10) / 10);
    // Saving again against the new totals clears it.
    await save('A', [line('Клавиатура', '51', '612', '1.53', '510'), line('Мышь', '51', '408', '1.02', '1020')], { docKey: 'DOC_C' });
    expect(isStale((await compositionsFor([lot.A])).get(lot.A)!, await totalsOf('A'))).toBe(false);

    // (b) the count clause ALONE (R9's anchor): an aralash lot, kg/m³ untouched.
    await db.update(receiptLots).set({ boxCount: sql`${receiptLots.boxCount} + 1` }).where(eq(receiptLots.id, lot.H));
    expect(isStale((await compositionsFor([lot.H])).get(lot.H)!, await totalsOf('H'))).toBe(true);
  });
});

describe('lot tarkibi — the document and the clear', () => {
  it('14/15. a cited document is in use; the clear frees it and the invoice prints one row again', async () => {
    const actor = { id: vedId, permissions: new Set(['receipts.edit']) };
    await expect(deleteAttachment(doc.DOC_C!, actor)).rejects.toMatchObject({ code: 'in_use' });
    await expect(deleteAttachment(doc.DOC_C!, actor)).rejects.toBeInstanceOf(AttachmentDeleteError);
    const comp = (await compositionsFor([lot.A])).get(lot.A)!;
    await clearComposition({ lotId: lot.A, seenRev: comp.rev }, ved(), ctx(vedId));
    expect(await db.select().from(lotCompositionLines).where(eq(lotCompositionLines.lotId, lot.A))).toHaveLength(0);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, rc.R1)))
      .orderBy(sql`${auditLog.createdAt} DESC`)
      .limit(1);
    expect((audit!.after as { lotComposition: unknown }).lotComposition).toBeNull();
    const rows = await invoiceRows('CROSS');
    expect(rows.filter((r) => r.product === NAME_A)).toHaveLength(1);
    await expect(deleteAttachment(doc.DOC_C!, actor)).resolves.toBeUndefined();
    delete doc.DOC_C;
  });
});

describe('lot tarkibi — cleanup', () => {
  it('16. leaves nothing of this file behind, and the TNVED memory as it found it', async () => {
    const lotIds = Object.values(lot);
    await db.delete(batchSentCompositions).where(inArray(batchSentCompositions.lotId, lotIds));
    await db.delete(lotCompositions).where(inArray(lotCompositions.lotId, lotIds));
    await db.delete(clientTransactions).where(eq(clientTransactions.id, chargeId));
    const versions = planIds.length
      ? await db.select({ id: loadPlanVersions.id }).from(loadPlanVersions).where(inArray(loadPlanVersions.planId, planIds))
      : [];
    if (versions.length) {
      await db.delete(loadPlanLines).where(
        inArray(
          loadPlanLines.versionId,
          versions.map((v) => v.id),
        ),
      );
      await db.delete(loadPlanVersions).where(inArray(loadPlanVersions.planId, planIds));
    }
    if (planIds.length) await db.delete(loadPlans).where(inArray(loadPlans.id, planIds));
    await db.delete(attachments).where(inArray(attachments.entityId, Object.values(rc)));
    const boxIds = (await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))).map((b) => b.id);
    if (boxIds.length) {
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
      await db.delete(boxes).where(inArray(boxes.id, boxIds));
    }
    await db.delete(crates).where(inArray(crates.id, crateIds));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    await db.delete(receipts).where(inArray(receipts.id, Object.values(rc)));
    await db.delete(batches).where(inArray(batches.id, Object.values(truck)));
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(wh)));

    const left = await db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM receipts WHERE number LIKE ${`LT-${SFX}-%`})
           + (SELECT count(*) FROM batches WHERE code LIKE ${`%-${SFX}`})
           + (SELECT count(*) FROM boxes WHERE short_code LIKE ${`LT${SFX}%`})
           + (SELECT count(*) FROM attachments WHERE storage_key LIKE ${`%lt-${SFX}-%`})
           + (SELECT count(*) FROM clients WHERE client_code = ${`LT${SFX}`}) AS n`);
    expect(Number(left[0]!.n)).toBe(0);
    expect(await memoryRows()).toEqual(memorySnapshot);
  });
});
