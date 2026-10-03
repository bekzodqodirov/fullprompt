import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * «Yuk ma'lumoti tekshirildi» against a real database (docs/YUK-TEKSHIRUV.md):
 * the owner's flow — the logist asks the client «100 karobkangiz keldi,
 * klaviatura ekan, to'g'rimi?» and ticks — through the writer, its door and
 * its compare-and-set, the derived staleness (his 2b), the lot tarkibi basis
 * (his 3a), the Chinese-warehouse worklist (his 4a), and every reader: the
 * prixod card's views, the plan editor's list, the homes' count and the
 * Ostatka XLSX route (the statement the download really runs).
 *
 * Written straight to the tables, every name run-suffixed; service calls take
 * PLAIN actors. Cleanup is the FINAL test (round 57's lie): warehouses are
 * DEACTIVATED (audit_log FK), and the run's lots are deleted with their rows.
 */

const override = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: async () => ({ ip: null, userAgent: 'lot-check.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
/** A server whose migration has not landed (#472) — test 18 alone turns it off. */
const ready = vi.hoisted(() => ({ on: true }));
vi.mock('@/modules/wms/receipts/lot-check-ready', () => ({ lotChecksReady: async () => ready.on }));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    requireActor: async () => (override.actor ?? (await real.requireActor())) as Awaited<ReturnType<typeof real.requireActor>>,
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  boxes,
  clients,
  crates,
  lotChecks,
  lotCompositions,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { GET as stockXlsx } from '@/app/api/reports/stock/route';
import { checkLotAction, uncheckLotAction } from '@/app/(protected)/receipts/[id]/lot-check-actions';
import { isStale } from '@/modules/wms/receipts/composition-math';
import { clearComposition, compositionsFor, saveComposition } from '@/modules/wms/receipts/lot-composition';
import { checkLot, LotCheckError, lotCheckViewsFor, uncheckLot as uncheckRaw, type LotCheckActor } from '@/modules/wms/receipts/lot-check';
import { groupHistory } from '@/modules/platform/audit/history';
import {
  checkFilterSql,
  inCheckFilter,
  LOT_CHECK_STATES,
  lotTarkibJoinSql,
  tarkibStandsSql,
  type CheckFilter,
} from '@/modules/wms/receipts/lot-check-sql';
import { plannableStock } from '@/modules/wms/planning/stock';
import { uncheckedPrixodCount } from '@/modules/wms/inventory/lot-check-count';

const SFX = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const ctx = (id: string) => ({ actorId: id, ip: null, userAgent: 'lot-check.integration' });

let logistId = '';
let vedId = '';
const wh: Record<'CN' | 'UZ', string> = { CN: '', UZ: '' };
const cl: Record<'A' | 'B', string> = { A: '', B: '' };
const rc: Record<'R1' | 'R2' | 'R3' | 'R4', string> = { R1: '', R2: '', R3: '', R4: '' };
const LOTS = ['K', 'M', 'T', 'U', 'N', 'C1', 'C2'] as const;
type LotKey = (typeof LOTS)[number];
const lot = Object.fromEntries(LOTS.map((k) => [k, ''])) as Record<LotKey, string>;
let docId = '';
let crateId = '';
let truckId = '';

const NAME_K = `键盘${SFX}`;

/** The seeded logist's shape: `plans.manage`, unscoped. */
const logist = (): LotCheckActor => ({
  id: logistId,
  permissions: new Set(['plans.manage', 'receipts.edit']),
  warehouseScoped: false,
  warehouseIds: [],
});
/** The VED (his 1a): `ved.docs` alone may tick too. */
const ved = (): LotCheckActor => ({
  id: vedId,
  permissions: new Set(['ved.docs']),
  warehouseScoped: false,
  warehouseIds: [],
});

async function mintWarehouse(code: string, country: string) {
  const [w] = await db
    .insert(warehouses)
    .values({
      code,
      name: `Tekshiruv ${code}`,
      country,
      type: country === 'CN' ? 'origin' : 'distribution',
      timezone: country === 'CN' ? 'Asia/Shanghai' : 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning({ id: warehouses.id });
  return w!.id;
}

async function mintReceipt(key: keyof typeof rc, clientId: string | null, warehouseId: string) {
  const [r] = await db
    .insert(receipts)
    .values({
      number: `LC-${SFX}-${key}`,
      warehouseId,
      clientId,
      ...(clientId ? {} : { unclaimedMarking: `LCM${SFX}` }),
      status: 'confirmed',
      createdBy: logistId,
      confirmedAt: new Date(Date.now() - 48 * 3_600_000),
      confirmedBy: logistId,
    })
    .returning({ id: receipts.id });
  rc[key] = r!.id;
}

async function mintLot(key: LotKey, receipt: keyof typeof rc, seq: number, name: string, n: number, at: string) {
  const [row] = await db
    .insert(receiptLots)
    .values({
      receiptId: rc[receipt],
      seq,
      letter: String.fromCharCode(64 + seq),
      cycleNo: 1,
      productNameZh: name,
      productNameRu: key === 'K' ? 'Клавиатура' : null,
      boxCount: n,
      dimsMode: 'mixed',
      totalWeightKg: '1000.000',
      totalVolumeM3: '2.5000',
    })
    .returning({ id: receiptLots.id });
  lot[key] = row!.id;
  await db.insert(boxes).values(
    Array.from({ length: n }, (_, i) => ({
      lotId: row!.id,
      seqInLot: i + 1,
      shortCode: `LC${SFX}${key}${i + 1}`,
      status: 'in_stock',
      currentWarehouseId: at,
    })),
  );
}

/** What the prixod card showed, read off the lot as it stands. */
async function seenOf(key: LotKey) {
  const row = (await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lot[key]) }))!;
  const r = (await db.query.receipts.findFirst({ where: eq(receipts.id, row.receiptId) }))!;
  return { nameZh: row.productNameZh, nameRu: row.productNameRu ?? '', boxCount: row.boxCount, clientId: r.clientId ?? '' };
}

/** The person's check as a panel would draw it now — the token a press posts back. */
async function tokenOf(key: LotKey): Promise<string | null> {
  const rows = (await db.execute(
    sql`SELECT checked_at::text AS at FROM lot_checks WHERE lot_id = ${lot[key]}::uuid`,
  )) as unknown as { at: string }[];
  return rows[0]?.at ?? null;
}

/** A press drawn from the card as it stands now (the panel's own post). */
async function press(key: LotKey, actor: LotCheckActor, opts: { note?: string; seen?: Awaited<ReturnType<typeof seenOf>> } = {}) {
  return checkLot(
    { lotId: lot[key], seen: opts.seen ?? (await seenOf(key)), note: opts.note, seenCheckedAt: await tokenOf(key) },
    actor,
    ctx(actor.id),
  );
}
async function uncheckLot(input: { lotId: string }, actor: LotCheckActor, c: ReturnType<typeof ctx>) {
  const key = (Object.keys(lot) as LotKey[]).find((k) => lot[k] === input.lotId)!;
  return uncheckRaw({ lotId: input.lotId, seenCheckedAt: await tokenOf(key) }, actor, c);
}

async function stateOf(key: LotKey) {
  return (await lotCheckViewsFor([lot[key]])).get(lot[key])!;
}

async function refusal(press: Promise<unknown>): Promise<string> {
  try {
    await press;
  } catch (err) {
    if (err instanceof LotCheckError) return err.code;
    throw err;
  }
  throw new Error('the press went through');
}

async function checkAudits(receiptKey: keyof typeof rc) {
  const rows = await db
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, rc[receiptKey])));
  return rows.filter(
    (row) => row.after && typeof row.after === 'object' && Object.keys(row.after as object).some((k) => k.startsWith('lotCheck:')),
  );
}

beforeAll(async () => {
  logistId = (await db.query.users.findFirst({ where: eq(users.phone, '+998900000003') }))!.id;
  vedId = (await db.query.users.findFirst({ where: eq(users.phone, '+998900000004') }))!.id;
  const s3 = SFX.slice(0, 3);
  wh.CN = await mintWarehouse(`LCC${s3}`, 'CN');
  wh.UZ = await mintWarehouse(`LCU${s3}`, 'UZ');
  const [a] = await db.insert(clients).values({ clientCode: `LCA${SFX}`, name: `Tekshiruv A ${SFX}` }).returning({ id: clients.id });
  const [b] = await db.insert(clients).values({ clientCode: `LCB${SFX}`, name: `Tekshiruv B ${SFX}` }).returning({ id: clients.id });
  cl.A = a!.id;
  cl.B = b!.id;
  await mintReceipt('R1', cl.A, wh.CN);
  await mintReceipt('R2', cl.A, wh.CN);
  await mintReceipt('R3', null, wh.CN);
  await mintReceipt('R4', cl.A, wh.UZ);
  // K — the owner's case: 100 cartons of «klaviatura» in a Chinese warehouse.
  await mintLot('K', 'R1', 1, NAME_K, 100, wh.CN);
  // M — the same prixod's second lot, never checked.
  await mintLot('M', 'R1', 2, `鼠标${SFX}`, 10, wh.CN);
  // T — the lot tarkibi basis.
  await mintLot('T', 'R2', 1, `混合${SFX}`, 10, wh.CN);
  // U — unclaimed cargo.
  await mintLot('U', 'R3', 1, `无主${SFX}`, 5, wh.CN);
  // N — standing in Uzbekistan: never on the ❓ list (his 4a).
  await mintLot('N', 'R4', 1, `乌兹${SFX}`, 5, wh.UZ);
  // C1, C2 — two lots in one crate.
  await mintLot('C1', 'R2', 2, `箱一${SFX}`, 2, wh.CN);
  await mintLot('C2', 'R2', 3, `箱二${SFX}`, 2, wh.CN);
  const [cr] = await db
    .insert(crates)
    .values({ code: `CR-LC${SFX}`, warehouseId: wh.CN, clientId: cl.A, kind: 'yashik', createdBy: logistId })
    .returning({ id: crates.id });
  crateId = cr!.id;
  await db.update(boxes).set({ crateId }).where(inArray(boxes.lotId, [lot.C1, lot.C2]));
  const [d] = await db
    .insert(attachments)
    .values({
      entityType: 'receipt',
      entityId: rc.R2,
      kind: 'file',
      storageKey: `receipt/${rc.R2}/lc-${SFX}`,
      fileName: `packing-${SFX}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 10,
      uploadedBy: logistId,
    })
    .returning({ id: attachments.id });
  docId = d!.id;
});

describe('the person\'s check (his 2b: name + count + client)', () => {
  it('1. a lot nobody asked about reads «none»; the logist ticks it and every reader says «checked»', async () => {
    expect((await stateOf('K')).state).toBe('none');
    const before = (await uncheckedPrixodCount(logist()))!;
    const { changed } = await press('K', logist(), { note: 'mijoz: ha' });
    expect(changed).toBe(true);
    const view = await stateOf('K');
    expect(view.state).toBe('checked');
    expect(view.person?.holds).toBe(true);
    expect(view.person?.note).toBe('mijoz: ha');
    const plan = await plannableStock(wh.CN);
    expect(plan.askable).toBe(true);
    expect(plan.lots.find((l) => l.lotId === lot.K)?.check).toBe('checked');
    expect(plan.lots.find((l) => l.lotId === lot.M)?.check).toBe('none');
    // R1 still has lot M unchecked, so the prixod stays on the list — the
    // count moves only when its LAST lot is confirmed.
    expect(await uncheckedPrixodCount(logist())).toBe(before);
    await press('M', logist());
    expect(await uncheckedPrixodCount(logist())).toBe(before - 1);
  });

  it('2. a rename makes it «stale» naming the name; asking again makes it «checked»', async () => {
    await db.update(receiptLots).set({ productNameRu: 'Мышь' }).where(eq(receiptLots.id, lot.K));
    const view = await stateOf('K');
    expect(view.state).toBe('stale');
    expect(view.person?.moved).toEqual({ name: true, count: false, client: false });
    await press('K', logist());
    expect((await stateOf('K')).state).toBe('checked');
  });

  it('3. a count change makes it «stale»; taking it back heals by itself (no writer clears anything)', async () => {
    await db.update(receiptLots).set({ boxCount: 102 }).where(eq(receiptLots.id, lot.K));
    const view = await stateOf('K');
    expect(view.state).toBe('stale');
    expect(view.person?.moved).toEqual({ name: false, count: true, client: false });
    await db.update(receiptLots).set({ boxCount: 100 }).where(eq(receiptLots.id, lot.K));
    expect((await stateOf('K')).state).toBe('checked');
  });

  it('4. a new client makes it «stale» naming the client', async () => {
    await db.update(receipts).set({ clientId: cl.B }).where(eq(receipts.id, rc.R1));
    const view = await stateOf('K');
    expect(view.state).toBe('stale');
    expect(view.person?.moved).toEqual({ name: false, count: false, client: true });
    await db.update(receipts).set({ clientId: cl.A }).where(eq(receipts.id, rc.R1));
    expect((await stateOf('K')).state).toBe('checked');
  });

  it('5. a re-weigh (kg, m³) is the warehouse\'s correction and leaves the check standing', async () => {
    await db.update(receiptLots).set({ totalWeightKg: '1100.000', totalVolumeM3: '2.6000' }).where(eq(receiptLots.id, lot.K));
    expect((await stateOf('K')).state).toBe('checked');
    await db.update(receiptLots).set({ totalWeightKg: '1000.000', totalVolumeM3: '2.5000' }).where(eq(receiptLots.id, lot.K));
  });

  it('6. a press against what the lot no longer is refuses `lot_changed` and writes nothing', async () => {
    const stale = await seenOf('M');
    await db.update(receiptLots).set({ productNameZh: `鼠标改${SFX}` }).where(eq(receiptLots.id, lot.M));
    const rowBefore = await db.query.lotChecks.findFirst({ where: eq(lotChecks.lotId, lot.M) });
    expect(await refusal(press('M', logist(), { seen: stale }))).toBe('lot_changed');
    const rowAfter = await db.query.lotChecks.findFirst({ where: eq(lotChecks.lotId, lot.M) });
    expect(rowAfter?.seenNameZh).toBe(rowBefore?.seenNameZh);
    // The posted «''» for an absent Russian name is the same value as NULL.
    await press('M', logist(), { seen: { ...(await seenOf('M')), nameRu: '' } });
    expect((await stateOf('M')).state).toBe('checked');
  });

  it('7. the door: the VED may tick (his 1a); a person without either grant, unclaimed cargo, a voided prixod may not', async () => {
    await press('N', ved());
    expect((await stateOf('N')).state).toBe('checked');
    const outsider: LotCheckActor = { id: vedId, permissions: new Set(['receipts.edit']), warehouseScoped: false, warehouseIds: [] };
    expect(await refusal(press('K', outsider))).toBe('forbidden');
    const elsewhere: LotCheckActor = { ...logist(), warehouseScoped: true, warehouseIds: [wh.UZ] };
    expect(await refusal(press('K', elsewhere))).toBe('forbidden');
    expect(await refusal(press('U', logist()))).toBe('no_client');
    expect((await stateOf('U')).state).toBe('unclaimed');
    await db.update(receipts).set({ status: 'voided' }).where(eq(receipts.id, rc.R4));
    expect(await refusal(press('N', logist()))).toBe('receipt_not_confirmed');
    expect(await refusal(uncheckLot({ lotId: lot.N }, logist(), ctx(logistId)))).toBe('receipt_not_confirmed');
    await db.update(receipts).set({ status: 'confirmed' }).where(eq(receipts.id, rc.R4));
  });

  it('8. the same press twice writes ONE audit row; a new note is a second', async () => {
    const before = (await checkAudits('R1')).length;
    const seen = await seenOf('K');
    // A double tap posts the token the page drew BEFORE the first landed —
    // the same person's same press is a no-op, never «check_changed».
    const drawn = await tokenOf('K');
    const first = await checkLot({ lotId: lot.K, seen, note: 'ikkinchi', seenCheckedAt: drawn }, logist(), ctx(logistId));
    const again = await checkLot({ lotId: lot.K, seen, note: 'ikkinchi', seenCheckedAt: drawn }, logist(), ctx(logistId));
    expect(first.changed).toBe(true);
    expect(again.changed).toBe(false);
    const rows = await checkAudits('R1');
    expect(rows.length).toBe(before + 1);
    expect(JSON.stringify(rows.at(-1)!.after)).toContain(NAME_K);
  });

  it('9. «Bekor qilish» takes the person\'s check back, once', async () => {
    expect((await uncheckLot({ lotId: lot.N }, logist(), ctx(logistId))).changed).toBe(true);
    expect((await stateOf('N')).state).toBe('none');
    expect((await uncheckLot({ lotId: lot.N }, logist(), ctx(logistId))).changed).toBe(false);
  });

  it('10. the actions answer codes, never throw at the person', async () => {
    override.actor = { ...logist(), roles: [], fullName: 'Logist', locale: 'uz' };
    try {
      const ok = await checkLotAction({ lotId: lot.N, seen: await seenOf('N'), seenCheckedAt: await tokenOf('N') });
      expect(ok).toEqual({ ok: true, changed: true });
      const bad = await checkLotAction({
        lotId: lot.N,
        seen: { ...(await seenOf('N')), boxCount: 999 },
        seenCheckedAt: await tokenOf('N'),
      });
      expect(bad).toEqual({ ok: false, error: 'lot_changed' });
      expect(await checkLotAction({ lotId: 'nope' })).toEqual({ ok: false, error: 'validation' });
      expect(await uncheckLotAction({ lotId: lot.N, seenCheckedAt: 'not-the-row' })).toEqual({ ok: false, error: 'check_changed' });
      expect(await uncheckLotAction({ lotId: lot.N, seenCheckedAt: await tokenOf('N') })).toEqual({ ok: true, changed: true });
    } finally {
      override.actor = null;
    }
  });
});

describe('the document\'s check (his 3a: a lot tarkibi counts)', () => {
  const composition = () => ({
    lotId: lot.T,
    seenRev: 0,
    seenBoxCount: 10,
    seenKg: '1000.000',
    seenM3: '2.5000',
    attachmentId: docId,
    lines: [
      { name: 'Клавиатура', pieces: '', cartons: '5', kg: '500', m3: '1.25', tnved: '' },
      { name: 'Мышь', pieces: '', cartons: '5', kg: '500', m3: '1.25', tnved: '' },
    ],
  });

  it('11. a saved composition reads «checked» by document with no person row; clearing it takes it away', async () => {
    expect((await stateOf('T')).state).toBe('none');
    await saveComposition(composition(), logist(), ctx(logistId));
    const view = await stateOf('T');
    expect(view.state).toBe('checked');
    expect(view.byDocument).toBe(true);
    expect(view.person).toBeNull();
    const rev = (await compositionsFor([lot.T])).get(lot.T)!.rev;
    await clearComposition({ lotId: lot.T, seenRev: rev }, logist(), ctx(logistId));
    expect((await stateOf('T')).state).toBe('none');
    await saveComposition(composition(), logist(), ctx(logistId));
  });

  it('12. a composition the lot has outgrown reads «stale»; the SQL twin agrees with isStale on every variation', async () => {
    const variations: { boxCount: number; kg: string; m3: string }[] = [
      { boxCount: 10, kg: '1000.000', m3: '2.5000' },
      { boxCount: 11, kg: '1000.000', m3: '2.5000' },
      { boxCount: 10, kg: '1000.500', m3: '2.5000' },
      { boxCount: 10, kg: '1000.000', m3: '2.5001' },
    ];
    for (const v of variations) {
      await db
        .update(receiptLots)
        .set({ boxCount: v.boxCount, totalWeightKg: v.kg, totalVolumeM3: v.m3 })
        .where(eq(receiptLots.id, lot.T));
      const comp = (await compositionsFor([lot.T])).get(lot.T)!;
      const [row] = (await db.execute(sql`
        SELECT ${tarkibStandsSql(sql`l`)} AS stands
          FROM receipt_lots l
          LEFT JOIN ${lotTarkibJoinSql()} ON lot_tarkib.lot_id = l.id
         WHERE l.id = ${lot.T}::uuid
      `)) as unknown as { stands: boolean }[];
      expect(row!.stands, JSON.stringify(v)).toBe(!isStale(comp, { boxCount: v.boxCount, kg: v.kg, m3: v.m3 }));
      const view = await stateOf('T');
      expect(view.state, JSON.stringify(v)).toBe(row!.stands ? 'checked' : 'stale');
      expect(view.documentStale).toBe(!row!.stands);
    }
    await db
      .update(receiptLots)
      .set({ boxCount: 10, totalWeightKg: '1000.000', totalVolumeM3: '2.5000' })
      .where(eq(receiptLots.id, lot.T));
  });
});

describe('the worklist (his 4a: only cargo standing in China)', () => {
  it('13. cargo in Uzbekistan is never counted; the home count equals a direct count of the same rule', async () => {
    await uncheckLot({ lotId: lot.N }, logist(), ctx(logistId));
    const counted = await uncheckedPrixodCount(logist());
    const [direct] = (await db.execute(sql`
      SELECT count(DISTINCT r.id)::int AS n
        FROM boxes b
        JOIN receipt_lots l ON l.id = b.lot_id
        JOIN receipts r ON r.id = l.receipt_id
        JOIN warehouses w ON w.id = b.current_warehouse_id
        LEFT JOIN lot_checks lc ON lc.lot_id = l.id
        LEFT JOIN ${lotTarkibJoinSql()} ON lot_tarkib.lot_id = l.id
       WHERE b.status IN ('in_stock', 'planned', 'loading', 'ready_for_pickup')
         AND w.country = 'CN'
         AND r.client_id IS NOT NULL
         AND NOT (lot_tarkib.lot_id IS NOT NULL AND lot_tarkib.seen_box_count = l.box_count
                  AND lot_tarkib.kg = l.total_weight_kg AND lot_tarkib.m3 = l.total_volume_m3)
         AND NOT (lc.lot_id IS NOT NULL AND lc.seen_name_zh = l.product_name_zh
                  AND lc.seen_name_ru IS NOT DISTINCT FROM NULLIF(l.product_name_ru, '')
                  AND lc.seen_box_count = l.box_count AND lc.seen_client_id = r.client_id)
    `)) as unknown as { n: number }[];
    expect(counted).toBe(Number(direct!.n));
    // A scoped reader at the Uzbek warehouse has nothing on the list.
    expect(await uncheckedPrixodCount({ ...logist(), warehouseScoped: true, warehouseIds: [wh.UZ] })).toBe(0);
  });

  it('14. the SQL filter and its pure twin agree on every state × askable', async () => {
    for (const state of LOT_CHECK_STATES) {
      for (const askable of [true, false]) {
        for (const tek of ['ha', 'yoq'] as CheckFilter[]) {
          const [row] = (await db.execute(
            sql`SELECT ${checkFilterSql(tek, sql`${state}::text`, sql`${askable}::boolean`)} AS hit`,
          )) as unknown as { hit: boolean }[];
          expect(row!.hit, `${state}/${askable}/${tek}`).toBe(inCheckFilter(tek, state, askable));
        }
      }
    }
  });

  it('15. a crate is ✅ only when EVERY lot inside is; one unasked lot is counted', async () => {
    const atStart = (await plannableStock(wh.CN)).crates.find((c) => c.crateId === crateId)!;
    expect(atStart).toMatchObject({ lotsTotal: 2, lotsChecked: 0, lotsAsked: 2 });
    await press('C1', logist());
    const half = (await plannableStock(wh.CN)).crates.find((c) => c.crateId === crateId)!;
    expect(half).toMatchObject({ lotsTotal: 2, lotsChecked: 1, lotsAsked: 1 });
    await press('C2', logist());
    const all = (await plannableStock(wh.CN)).crates.find((c) => c.crateId === crateId)!;
    expect(all).toMatchObject({ lotsTotal: 2, lotsChecked: 2, lotsAsked: 0 });
    // The plan editor's Uzbek origin asks nothing.
    expect((await plannableStock(wh.UZ)).askable).toBe(false);
  });

  it('16. the Ostatka XLSX route runs the same rule: `tek=yoq` lists only the unchecked Chinese rows, with the column filled', async () => {
    await uncheckLot({ lotId: lot.M }, logist(), ctx(logistId));
    override.actor = { ...logist(), roles: [], fullName: 'Logist', locale: 'uz' };
    try {
      const read = async (tek: string) => {
        const res = await stockXlsx(new Request(`http://local/api/reports/stock?q=${SFX}&tek=${tek}`));
        expect(res.status).toBe(200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer);
        const sheet = wb.worksheets[0]!;
        const header = sheet.getRow(1).values as unknown[];
        const codeCol = header.indexOf('Kod');
        const checkCol = header.indexOf('Tekshiruv');
        expect(codeCol).toBeGreaterThan(0);
        expect(checkCol).toBeGreaterThan(0);
        const rows: { code: string; check: string }[] = [];
        for (let r = 2; r <= sheet.rowCount; r += 1) {
          const row = sheet.getRow(r);
          rows.push({ code: String(row.getCell(codeCol).value ?? ''), check: String(row.getCell(checkCol).value ?? '') });
        }
        return rows;
      };
      const yoq = await read('yoq');
      // M (unchecked again) is listed; K and the crate lots are checked; N
      // stands in Uzbekistan; U has no client — none of them is asked.
      expect(yoq.map((r) => r.code).sort()).toEqual([`LCA${SFX}-B`]);
      expect(yoq[0]!.check).toContain('tekshirilmagan');
      const ha = await read('ha');
      expect(ha.map((r) => r.code)).toContain(`LCA${SFX}-A`);
      expect(ha.every((r) => r.check.includes('tekshirilgan'))).toBe(true);
      const all = await read('');
      expect(all.length).toBeGreaterThan(yoq.length + ha.length - 1);
    } finally {
      override.actor = null;
    }
  });
});

describe('two people, one lot (the review\'s check_changed)', () => {
  it('19. a press against a check the panel did not draw is refused — undo and re-tick alike', async () => {
    // The logist's card drew K's check; the VED re-confirms meanwhile.
    const drawnByLogist = await tokenOf('K');
    await db.update(receiptLots).set({ productNameRu: 'Клавиатура USB' }).where(eq(receiptLots.id, lot.K));
    await press('K', ved(), { note: 'VED: mijoz tasdiqladi' });
    expect((await stateOf('K')).state).toBe('checked');
    // The logist's undo, posted from the old card, does not erase it.
    expect(await refusal(uncheckRaw({ lotId: lot.K, seenCheckedAt: drawnByLogist }, logist(), ctx(logistId)))).toBe(
      'check_changed',
    );
    expect((await stateOf('K')).person?.note).toBe('VED: mijoz tasdiqladi');
    // …nor does a re-tick drawn from it overwrite the VED's note.
    expect(
      await refusal(
        checkLot({ lotId: lot.K, seen: await seenOf('K'), note: 'logist', seenCheckedAt: drawnByLogist }, logist(), ctx(logistId)),
      ),
    ).toBe('check_changed');
    expect((await stateOf('K')).person?.note).toBe('VED: mijoz tasdiqladi');
  });
});

describe('the card follows 4a too', () => {
  it('20. a lot is askable while a carton is in China — on a shelf, or on a truck out of China — and not once it is in Uzbekistan', async () => {
    expect((await stateOf('K')).askable).toBe(true);
    expect((await stateOf('N')).askable).toBe(false);
    // M's cartons leave YW on a truck to Uzbekistan: still askable on the road.
    const [b] = (await db.execute(sql`
      INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
      VALUES (gen_random_uuid(), ${`LCT-${SFX}`}, ${wh.CN}::uuid, ${wh.UZ}::uuid, 'in_transit', now(), ${logistId}::uuid) RETURNING id
    `)) as unknown as { id: string }[];
    truckId = b!.id;
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentWarehouseId: null, currentBatchId: truckId })
      .where(eq(boxes.lotId, lot.M));
    expect((await stateOf('M')).askable).toBe(true);
    // The truck unloaded with these cartons declared missing (they keep the
    // truck and no warehouse): an unloaded truck carries nothing out of China.
    await db.execute(sql`UPDATE batches SET status = 'unloaded' WHERE id = ${truckId}::uuid`);
    expect((await stateOf('M')).askable).toBe(false);
    await db.execute(sql`UPDATE batches SET status = 'in_transit' WHERE id = ${truckId}::uuid`);
    // Unloaded in Uzbekistan: no longer asked about.
    await db
      .update(boxes)
      .set({ status: 'ready_for_pickup', currentWarehouseId: wh.UZ, currentBatchId: null })
      .where(eq(boxes.lotId, lot.M));
    expect((await stateOf('M')).askable).toBe(false);
    await db
      .update(boxes)
      .set({ status: 'in_stock', currentWarehouseId: wh.CN, currentBatchId: null })
      .where(eq(boxes.lotId, lot.M));
  });
});

describe('the History says which lot (the review\'s shared key)', () => {
  it('21. two lots ticked in one call read as two changes, each with its own letter, the note kept', async () => {
    await uncheckLot({ lotId: lot.C1 }, logist(), ctx(logistId));
    await uncheckLot({ lotId: lot.C2 }, logist(), ctx(logistId));
    const since = new Date(Date.now() - 1000);
    await press('C1', logist());
    await press('C2', logist(), { note: 'mijoz: ikkalasi ham' });
    const rows = await db
      .select({ id: auditLog.id, actorId: auditLog.actorId, action: auditLog.action, before: auditLog.before, after: auditLog.after, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'receipt'),
          eq(auditLog.entityId, rc.R2),
          sql`${auditLog.createdAt} >= ${since.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(auditLog.createdAt));
    const groups = groupHistory(
      rows.map((r) => ({
        id: String(r.id),
        actorId: r.actorId,
        actorName: null,
        action: r.action,
        before: (r.before ?? null) as Record<string, unknown> | null,
        after: (r.after ?? null) as Record<string, unknown> | null,
        createdAt: r.createdAt,
      })),
    );
    // ONE sitting (same person, seconds apart), and still two lots in it.
    expect(groups).toHaveLength(1);
    const keys = groups.flatMap((g) => g.changes.map((c) => c.key));
    expect(keys).toEqual(expect.arrayContaining(['lotCheck:B', 'lotCheck:C', 'lotCheckNote:C']));
  });
});

describe('a server whose migration has not landed (#472)', () => {
  it('22. the plan editor\'s list, the home count and the card read as before, with no chip and no error', async () => {
    ready.on = false;
    // Every statement sent while the server is «behind»: none may name a
    // table 0122/0123 created — on a real ledger-123 database that is the
    // 42P01 this branch exists to avoid.
    const sent: string[] = [];
    const unsafe = pgClient.unsafe.bind(pgClient);
    const spy = vi.spyOn(pgClient, 'unsafe').mockImplementation(((query: string, ...rest: unknown[]) => {
      sent.push(query);
      return (unsafe as (...a: unknown[]) => unknown)(query, ...rest);
    }) as typeof pgClient.unsafe);
    try {
      const plan = await plannableStock(wh.CN);
      expect(plan.askable).toBe(false);
      expect(plan.lots.find((l) => l.lotId === lot.K)?.check ?? null).toBeNull();
      const crate = plan.crates.find((c) => c.crateId === crateId)!;
      expect(crate.lotsTotal).toBeUndefined();
      expect(await uncheckedPrixodCount(logist())).toBeNull();
      expect((await lotCheckViewsFor([lot.K])).size).toBe(0);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.filter((q) => /lot_checks|lot_composition/.test(q))).toEqual([]);
    } finally {
      spy.mockRestore();
      ready.on = true;
    }
  });
});

describe('yuk tekshiruvi — cleanup', () => {
  it('17. leaves nothing of this file behind', async () => {
    const lotIds = Object.values(lot);
    await db.delete(lotChecks).where(inArray(lotChecks.lotId, lotIds));
    await db.delete(lotCompositions).where(inArray(lotCompositions.lotId, lotIds));
    await db.delete(attachments).where(inArray(attachments.entityId, Object.values(rc)));
    await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
    await db.delete(crates).where(eq(crates.id, crateId));
    if (truckId) await db.execute(sql`DELETE FROM batches WHERE id = ${truckId}::uuid`);
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    await db.delete(receipts).where(inArray(receipts.id, Object.values(rc)));
    await db.delete(clients).where(inArray(clients.id, Object.values(cl)));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(wh)));
    const left = await db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM receipts WHERE number LIKE ${`LC-${SFX}-%`})
           + (SELECT count(*) FROM boxes WHERE short_code LIKE ${`LC${SFX}%`})
           + (SELECT count(*) FROM lot_checks WHERE seen_name_zh LIKE ${`%${SFX}`})
           + (SELECT count(*) FROM clients WHERE client_code LIKE ${`LC_${SFX}`}) AS n`);
    expect(Number(left[0]!.n)).toBe(0);
  });
});
