import 'dotenv/config';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The warehouse and cost ACTIONS read a session; this file stands in for it
// (and for Next's cache and the job queue) and for nothing else — the
// batch-reroute shape: a service-level test of a form-fed path proves the
// service, not the system (#531).
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => session.user,
  requestMeta: async () => ({ ip: null, userAgent: 'freight-basis.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: async () => {},
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  boxes,
  boxMovements,
  calcFreightTariffs,
  clients,
  costEntries,
  costEntryTariffs,
  costTypes,
  events,
  receiptLots,
  receipts,
  roles,
  settings,
  userRoles,
  users,
  warehouses,
  warehouseTariffColumns,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { addCostEntry, boxMeasures, CostError, recomputeEntry } from '@/modules/wms/costing/service';
import { prepareFreightCopy } from '@/modules/wms/costing/freight-copy';
import { mappableZones, setTariffColumnInTx, tariffColumnOf } from '@/modules/wms/costing/tariff-column';
import { setBoxStatus } from '@/modules/wms/boxes/status';
import { editLot } from '@/modules/wms/receipts/edit';
import { CUSTOMS_CODES_SETTING, parseCustomsCodes } from '@/modules/wms/calc/customs-codes';
import { updateWarehouseAction } from '@/app/(protected)/admin/warehouses/actions';
import { addCostEntryAction } from '@/app/(protected)/costs/actions';

/**
 * docs/YOLKIRA-TAQSIMOT.md §11 — the yo'lkira-tarifi split against a real
 * database: his example's shares, the freeze (3a), his rule 6 (a light
 * client HOLDS the bill, fixing the lot heals it), the void guard, the
 * refusals in words, and the warehouse form keeping its column (#171).
 *
 * Money parked in 1637 (a private year: void-resplit's too, different
 * zones), tariff columns under ONE private run prefix `t_<n><run>_…`, swept
 * before and deleted as a FINAL TEST (#824 — never afterAll, whose failure
 * nobody sees). A warehouse column is CONFIGURATION (#183); the private
 * warehouses are deactivated, never deleted (audit FK).
 */
const RUN = String(Date.now()).slice(-6);
let counter = 0;
const zone = (name: string) => `t_${(counter += 1)}${RUN}_${name}`;
const ZONE = { main: zone('main'), alt: zone('alt'), gap: zone('gap'), frz: zone('frz'), long: '' };
ZONE.long = `t_${(counter += 1)}${RUN}_long_${'x'.repeat(80)}`;
const SWEEP = /^t_[0-9a-z]+_(main|alt|gap|frz|long_x+)$/;
const TARIFF_DAY = '1637-01-01';
const DAY = '1637-03-14';
const PRIVATE_CUSTOMS = `t_frc_${RUN}`;

let actorId = '';
let adminId = '';
let freightType = '';
let customsType = '';
let privateCustomsType = '';
let whW = '';
let whU = '';
let whD = '';
const made = { receipts: [] as string[], batches: [] as string[], costs: [] as string[], clients: [] as string[] };
let seq = 0;
let customsBefore: string | null = null;

const ctx = () => ({ actorId, ip: null, userAgent: null });
const manager = () =>
  ({
    id: actorId,
    fullName: `FB manager ${RUN}`,
    roles: ['warehouse_manager'],
    permissions: new Set(['receipts.edit', 'receipts.void']),
  }) as unknown as Actor;

async function mintWarehouse(code: string, country: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, name: `FB ${code}`, country, type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
    .returning();
  return row!.id;
}

async function mintClient(label: string) {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `F${label}${RUN}`.slice(0, 10), name: `FB ${label} ${RUN}` })
    .returning();
  made.clients.push(c!.id);
  return c!.id;
}

/**
 * A confirmed prixod with one lot of `count` cartons. Mixed (totals) unless
 * `dims` is given — then uniform, with the carton's own dims and weight.
 */
async function mintLot(opts: {
  client: string | null;
  count?: number;
  kg?: number;
  m3?: number;
  dims?: [number, number, number];
  boxKg?: string;
  marking?: string;
}) {
  const count = opts.count ?? 1;
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: whW,
      clientId: opts.client,
      unclaimedMarking: opts.client ? null : (opts.marking ?? `FBMARK${RUN}`),
      status: 'confirmed',
      confirmedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  made.receipts.push(receipt!.id);
  const uniform = Boolean(opts.dims);
  const totalKg = uniform ? Number(opts.boxKg) * count : opts.kg!;
  const totalM3 = uniform ? Math.round((opts.dims![0] * opts.dims![1] * opts.dims![2] * count) / 100) / 10000 : opts.m3!;
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      letter: 'A',
      dimsMode: uniform ? 'uniform' : 'mixed',
      productNameZh: '测试货',
      boxCount: count,
      boxLengthCm: opts.dims?.[0] ?? null,
      boxWidthCm: opts.dims?.[1] ?? null,
      boxHeightCm: opts.dims?.[2] ?? null,
      boxWeightKg: opts.boxKg ?? null,
      totalWeightKg: totalKg.toFixed(3),
      totalVolumeM3: totalM3.toFixed(4),
    })
    .returning();
  const rows = await db
    .insert(boxes)
    .values(
      Array.from({ length: count }, (_, i) => ({
        lotId: lot!.id,
        shortCode: `FB${RUN}-${(seq += 1)}`,
        seqInLot: i + 1,
        status: 'in_stock',
        currentWarehouseId: whW,
      })),
    )
    .returning();
  return { receiptId: receipt!.id, lotId: lot!.id, boxIds: rows.map((b) => b.id) };
}

/** A truck from `from` the given cartons departed on (the ledger is the membership). */
async function mintTruck(boxIds: string[], from = whW) {
  const [batch] = await db
    .insert(batches)
    .values({
      code: `FBT${RUN}-${made.batches.length}`,
      originWarehouseId: from,
      destWarehouseId: whD,
      status: 'unloaded',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  made.batches.push(batch!.id);
  if (boxIds.length) {
    await db.insert(boxMovements).values(
      boxIds.map((boxId) => ({
        boxId,
        fromWarehouseId: from,
        toWarehouseId: whD,
        fromStatus: 'loading',
        toStatus: 'in_transit',
        cause: 'batch_departed',
        refType: 'batch',
        refId: batch!.id,
        actorId,
      })),
    );
  }
  return batch!.id;
}

async function mapColumn(warehouseId: string, z: string | null) {
  await db.transaction((tx) => setTariffColumnInTx(tx, warehouseId, z));
}

async function bill(batchId: string, amount: number, over: Partial<Parameters<typeof addCostEntry>[0]> = {}) {
  const entry = await addCostEntry(
    {
      scope: 'batch',
      batchId,
      costTypeId: freightType,
      amount,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'freight',
      ...over,
    },
    ctx(),
  );
  made.costs.push(entry.id);
  return entry;
}

/** Each client's (or the unclaimed prixod's) share of one bill, to the cent. */
async function byClient(entryId: string): Promise<Record<string, number>> {
  const rows = await db.execute<{ k: string; usd: string }>(sql`
    SELECT coalesce(ca.client_id::text, 'unclaimed') AS k, sum(ca.amount_usd) AS usd
      FROM cost_allocations ca WHERE ca.cost_entry_id = ${entryId}::uuid GROUP BY 1
  `);
  return Object.fromEntries(rows.map((r) => [r.k, Math.round(Number(r.usd) * 100) / 100]));
}

async function tariffRows(z: string, rows: [number, number | null, number, boolean][], date = TARIFF_DAY) {
  await db.insert(calcFreightTariffs).values(
    rows.map(([min, max, price, perKg]) => ({
      zone: z,
      minDensity: min.toFixed(2),
      maxDensity: max === null ? null : max.toFixed(2),
      priceUsd: String(price),
      perKg,
      effectiveDate: date,
    })),
  );
}

async function sweepPrivateZones() {
  const zones = (await db.selectDistinct({ zone: calcFreightTariffs.zone }).from(calcFreightTariffs))
    .map((r) => r.zone)
    .filter((z) => SWEEP.test(z));
  const mapped = (await db.select({ zone: warehouseTariffColumns.tariffZone }).from(warehouseTariffColumns))
    .map((r) => r.zone)
    .filter((z) => SWEEP.test(z));
  const all = [...new Set([...zones, ...mapped])];
  if (all.length) {
    await db.delete(warehouseTariffColumns).where(inArray(warehouseTariffColumns.tariffZone, all));
    await db.delete(calcFreightTariffs).where(inArray(calcFreightTariffs.zone, all));
  }
}

beforeAll(async () => {
  await sweepPrivateZones();
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${RUN}7`, fullName: `FB manager ${RUN}`, passwordHash: 'x', active: true })
    .returning();
  actorId = u!.id;
  const [a] = await db
    .insert(users)
    .values({ phone: `+99891${RUN}8`, fullName: `FB admin ${RUN}`, passwordHash: 'x', active: true })
    .returning();
  adminId = a!.id;
  const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, 'admin'));
  await db.insert(userRoles).values({ userId: adminId, roleId: adminRole!.id });
  whW = await mintWarehouse(`FW${RUN}`.slice(0, 8), 'CN');
  whU = await mintWarehouse(`FU${RUN}`.slice(0, 8), 'CN');
  whD = await mintWarehouse(`FD${RUN}`.slice(0, 8), 'UZ');
  const typeId = async (code: string) => (await db.query.costTypes.findFirst({ where: eq(costTypes.code, code) }))!.id;
  freightType = await typeId('freight');
  customsType = await typeId('customs');
  const [pc] = await db.insert(costTypes).values({ code: PRIVATE_CUSTOMS, name: `FB customs ${RUN}` }).returning();
  privateCustomsType = pc!.id;
  // The setting's EXACT jsonb text, restored byte for byte (#183).
  const cs = await db.execute<{ v: string }>(
    sql`SELECT value::text AS v FROM settings WHERE key = ${CUSTOMS_CODES_SETTING}`,
  );
  customsBefore = cs[0]?.v ?? null;

  // A private column whose rows give round numbers: 1-100 $110, 101-500 $200,
  // 501-999 $300, 1000+ $0.55/kg.
  await tariffRows(ZONE.main, [
    [1, 100, 110, false],
    [101, 500, 200, false],
    [501, 999, 300, false],
    [1000, null, 0.55, true],
  ]);
  await tariffRows(ZONE.alt, [[1, null, 50, false]]);
  await tariffRows(ZONE.frz, [
    [1, 500, 100, false],
    [501, null, 300, false],
  ]);
  // A hole at 501-999.
  await tariffRows(ZONE.gap, [
    [1, 500, 100, false],
    [1000, null, 0.5, true],
  ]);
  await tariffRows(ZONE.long, [[1, null, 100, false]]);
  await mapColumn(whW, ZONE.main);
});

afterAll(async () => {
  await pgClient.end();
});

describe('his example on a real truck', () => {
  it('1 — a freight bill splits A 600 / B 200 / unclaimed 55 of $855, freezes its column and records it', async () => {
    // A: two lots, 100 and 1100 kg/m³ → combined 1200 kg / 2 m³ = 600 → $300 × 2 = 600.
    // B: 1 m³ at 160 → $200. Unclaimed: 0.5 m³ at 100 → $110 × 0.5 = 55. Σ 855.
    const A = await mintClient('A');
    const B = await mintClient('B');
    const a1 = await mintLot({ client: A, kg: 100, m3: 1 });
    const a2 = await mintLot({ client: A, kg: 1100, m3: 1 });
    const b = await mintLot({ client: B, kg: 160, m3: 1 });
    const u = await mintLot({ client: null, kg: 50, m3: 0.5 });
    const truck = await mintTruck([...a1.boxIds, ...a2.boxIds, ...b.boxIds, ...u.boxIds]);

    const entry = await bill(truck, 855);
    expect(entry.id).toBeTruthy();
    expect(entry.verdict).toEqual({ kind: 'split' });
    expect(await byClient(entry.id)).toEqual({ [A]: 600, [B]: 200, unclaimed: 55 });

    const [copy] = await db.select().from(costEntryTariffs).where(eq(costEntryTariffs.costEntryId, entry.id));
    expect(copy).toMatchObject({ warehouseId: whW, tariffZone: ZONE.main, tariffFrom: TARIFF_DAY, lightBelow: 10 });
    expect((copy!.bands as unknown[]).length).toBe(4);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, entry.id), eq(auditLog.action, 'create')));
    expect(audit!.after).toMatchObject({ allocationBasis: 'freight', tariffZone: ZONE.main, tariffFrom: TARIFF_DAY });
  });

  it('2 — the freeze (3a): a same-date overwrite, a back-dated row and a remap move NOTHING', async () => {
    const A = await mintClient('FA');
    const B = await mintClient('FB');
    const a = await mintLot({ client: A, kg: 600, m3: 1 }); // 600 → $300
    const b = await mintLot({ client: B, kg: 200, m3: 1 }); // 200 → $100
    const W2 = await mintWarehouse(`FZ${RUN}`.slice(0, 8), 'CN');
    await mapColumn(W2, ZONE.frz);
    const truck = await mintTruck([...a.boxIds, ...b.boxIds], W2);
    const entry = await bill(truck, 400);
    expect(await byClient(entry.id)).toEqual({ [A]: 300, [B]: 100 });

    await db
      .update(calcFreightTariffs)
      .set({ priceUsd: '100' })
      .where(and(eq(calcFreightTariffs.zone, ZONE.frz), eq(calcFreightTariffs.minDensity, '501.00')));
    await tariffRows(ZONE.frz, [[1, 500, 1, false]], '1636-06-01');
    await mapColumn(W2, ZONE.alt);
    await recomputeEntry(entry.id);
    expect(await byClient(entry.id)).toEqual({ [A]: 300, [B]: 100 });
    await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, W2));
  });
});

describe('his rule 6 — a light client holds the bill, and the lot door heals it', () => {
  it('3 — a client under 10 kg/m³ HOLDS the bill; correcting the lot splits it with no other call', async () => {
    const A = await mintClient('LA');
    const C = await mintClient('LC');
    const a = await mintLot({ client: A, kg: 600, m3: 1 });
    const c = await mintLot({ client: C, kg: 10, m3: 2 }); // 5 kg/m³
    const truck = await mintTruck([...a.boxIds, ...c.boxIds]);
    const entry = await bill(truck, 500);
    expect(entry.verdict?.kind).toBe('held');
    if (entry.verdict?.kind !== 'held' || entry.verdict.held.reason !== 'cargo') throw new Error('expected a cargo hold');
    expect(entry.verdict.held.tooLight.map((g) => [g.key, g.density])).toEqual([[`c:${C}`, 5]]);
    expect(await byClient(entry.id)).toEqual({});

    await editLot(
      {
        lotId: c.lotId,
        productNameZh: '测试货',
        productNameRu: '',
        boxCount: 1,
        totalWeightKg: 200,
        totalVolumeM3: 2,
        note: null,
      } as Parameters<typeof editLot>[0],
      manager(),
      ctx(),
    );
    // A 600 kg/m³ → $300 · 1 = 300; C 100 kg/m³ → $110 · 2 = 220.
    expect(await byClient(entry.id)).toEqual({ [A]: 288.46, [C]: 211.54 });
  });

  it('3b — a DIMS-only correction heals it although the stored totals do not move (T3)', async () => {
    const C2 = await mintClient('LD');
    // One uniform 0.020 kg carton of 22×12×8 = 2112 cm³ → 9.47 → 9 kg/m³.
    const c = await mintLot({ client: C2, dims: [22, 12, 8], boxKg: '0.020' });
    const truck = await mintTruck(c.boxIds);
    const entry = await bill(truck, 50);
    expect(entry.verdict?.kind).toBe('held');
    const [before] = await db.select().from(receiptLots).where(eq(receiptLots.id, c.lotId));

    // 21×10×10 = 2100 cm³ → 9.52 → 10 kg/m³: priced, while the totals stay 0.020 / 0.0021.
    await editLot(
      {
        lotId: c.lotId,
        productNameZh: '测试货',
        productNameRu: '',
        boxCount: 1,
        boxLengthCm: 21,
        boxWidthCm: 10,
        boxHeightCm: 10,
        boxWeightKg: 0.02,
        note: null,
      } as Parameters<typeof editLot>[0],
      manager(),
      ctx(),
    );
    const [after] = await db.select().from(receiptLots).where(eq(receiptLots.id, c.lotId));
    expect([after!.totalWeightKg, after!.totalVolumeM3]).toEqual([before!.totalWeightKg, before!.totalVolumeM3]);
    expect(await byClient(entry.id)).toEqual({ [C2]: 50 });
  });
});

describe('the void guard asks «is the money somewhere», not «did it split»', () => {
  it('4 — voiding the carton that made a client heavy is ALLOWED; the bill becomes held', async () => {
    const D = await mintClient('VD');
    const heavy = await mintLot({ client: D, kg: 300, m3: 1 });
    const light = await mintLot({ client: D, kg: 5, m3: 1 });
    const truck = await mintTruck([...heavy.boxIds, ...light.boxIds]);
    const entry = await bill(truck, 100);
    expect(entry.verdict).toEqual({ kind: 'split' });

    await setBoxStatus({ boxId: heavy.boxIds[0]!, to: 'void', reason: 'counted twice by mistake' }, ctx());
    const verdict = await recomputeEntry(entry.id);
    expect(verdict?.kind).toBe('held');
    expect(await byClient(entry.id)).toEqual({});
  });

  it('4b — voiding the truck’s ONLY cargo is refused as before (no box to hold the money)', async () => {
    const E = await mintClient('VE');
    const only = await mintLot({ client: E, kg: 300, m3: 1 });
    const truck = await mintTruck(only.boxIds);
    await bill(truck, 100);
    await expect(
      setBoxStatus({ boxId: only.boxIds[0]!, to: 'void', reason: 'counted twice by mistake' }, ctx()),
    ).rejects.toMatchObject({ code: 'shared_cost_orphaned' });
  });

  it('4c — a freight bill whose type later became customs: held, and its LAST carton cannot be voided', async () => {
    const F = await mintClient('VF');
    const only = await mintLot({ client: F, kg: 300, m3: 1 });
    const truck = await mintTruck(only.boxIds);
    const entry = await bill(truck, 100, { costTypeId: privateCustomsType });
    const codes = parseCustomsCodes(customsBefore === null ? null : JSON.parse(customsBefore));
    // The setting stores a JSON TEXT inside jsonb (what /admin/settings writes).
    const widened = JSON.stringify([...codes, PRIVATE_CUSTOMS]);
    await db.execute(sql`
      INSERT INTO settings (key, value) VALUES (${CUSTOMS_CODES_SETTING}, to_jsonb(${widened}::text))
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    try {
      expect((await recomputeEntry(entry.id))?.kind).toBe('held');
      await expect(
        setBoxStatus({ boxId: only.boxIds[0]!, to: 'void', reason: 'counted twice by mistake' }, ctx()),
      ).rejects.toMatchObject({ code: 'shared_cost_orphaned' });
    } finally {
      // The setting is CONFIGURATION every customs reader asks (#183).
      if (customsBefore === null) await db.delete(settings).where(eq(settings.key, CUSTOMS_CODES_SETTING));
      else {
        await db.execute(sql`UPDATE settings SET value = ${customsBefore}::jsonb WHERE key = ${CUSTOMS_CODES_SETTING}`);
      }
    }
  });
});

describe('refusals name what to fix (tariff CONFIGURATION only)', () => {
  const freightInput = (batchId: string, over: Partial<Parameters<typeof prepareFreightCopy>[0]> = {}) => ({
    scope: 'batch',
    batchId,
    costTypeId: freightType,
    costDate: DAY,
    allocationBasis: 'freight',
    ...over,
  });
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      if (error instanceof CostError) return { code: error.code, params: error.params };
      throw error;
    }
    return null;
  };

  it('6 — no column, a date before the column, a hole, a customs type, a receipt scope', async () => {
    const truckU = await mintTruck([], whU);
    const wh = (await db.query.warehouses.findFirst({ where: eq(warehouses.id, whU) }))!;
    expect(await refusal(prepareFreightCopy(freightInput(truckU)))).toEqual({
      code: 'freight_no_column',
      params: { warehouse: `${wh.code} — ${wh.name}` },
    });

    const truck = await mintTruck([]);
    expect(await refusal(prepareFreightCopy(freightInput(truck, { costDate: '1636-12-31' })))).toMatchObject({
      code: 'freight_zone_unpriced',
      params: { column: ZONE.main, date: '1636-12-31' },
    });

    const Wg = await mintWarehouse(`FG${RUN}`.slice(0, 8), 'CN');
    await mapColumn(Wg, ZONE.gap);
    const truckG = await mintTruck([], Wg);
    expect(await refusal(prepareFreightCopy(freightInput(truckG)))).toEqual({
      code: 'freight_tariff_gap',
      params: { column: ZONE.gap, from: 501, to: 999 },
    });
    await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, Wg));

    expect(await refusal(prepareFreightCopy(freightInput(truck, { costTypeId: customsType })))).toEqual({
      code: 'freight_on_customs',
      params: undefined,
    });
    expect(await refusal(prepareFreightCopy(freightInput(truck, { scope: 'receipt' })))).toEqual({
      code: 'freight_batch_only',
      params: undefined,
    });
  });

  it('6b — a long zone name the tariff writer allows is a legal column (no cap in 0132)', async () => {
    const Wl = await mintWarehouse(`FL${RUN}`.slice(0, 8), 'CN');
    await mapColumn(Wl, ZONE.long);
    const G = await mintClient('LG');
    const g = await mintLot({ client: G, kg: 300, m3: 1 });
    const truck = await mintTruck(g.boxIds, Wl);
    const entry = await bill(truck, 70);
    expect(await byClient(entry.id)).toEqual({ [G]: 70 });
    await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, Wl));
  });
});

describe('the doors as the buttons press them', () => {
  async function signIn(id: string) {
    const row = (await db.query.users.findFirst({ where: eq(users.id, id) }))!;
    session.user = {
      id: row.id,
      phone: row.phone,
      username: row.username,
      fullName: row.fullName,
      locale: row.locale,
      active: true,
      sessionId: '00000000-0000-4000-8000-0000000f8b00',
    };
  }
  const post = (wh: typeof warehouses.$inferSelect, extra: Record<string, string>) => {
    const fd = new FormData();
    const fields: Record<string, string> = {
      code: wh.code,
      name: wh.name,
      country: wh.country,
      type: wh.type,
      timezone: wh.timezone,
      batchPrefix: wh.batchPrefix,
      address: wh.address ?? '',
      capacityM3: '',
      lat: '',
      lon: '',
      issuesToClients: 'off',
      allowsQuickBatch: 'off',
      ...extra,
    };
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  };
  const press = async (fd: FormData) => {
    try {
      return await updateWarehouseAction(whU, {}, fd);
    } catch (error) {
      if (String((error as { digest?: string }).digest ?? error).includes('NEXT_REDIRECT')) return 'redirected';
      throw error;
    }
  };

  it('W — the form sets the column, an address-only post KEEPS it, «—» deletes it, an unknown one is refused', async () => {
    await signIn(adminId);
    const wh = (await db.query.warehouses.findFirst({ where: eq(warehouses.id, whU) }))!;
    expect((await mappableZones(null)).some((z) => z.zone === ZONE.main && z.priced)).toBe(true);

    expect(await press(post(wh, { tariffZone: ` ${ZONE.main.toUpperCase()} ` }))).toBe('redirected');
    expect(await tariffColumnOf(whU)).toBe(ZONE.main);

    // A page drawn one migration behind posts no field at all: leave it alone.
    expect(await press(post(wh, { address: 'new address' }))).toBe('redirected');
    expect(await tariffColumnOf(whU)).toBe(ZONE.main);

    const refused = await press(post(wh, { tariffZone: 'no_such_column', address: 'kept' }));
    expect(refused).toMatchObject({ error: 'zone_unknown', values: { address: 'kept', tariffZone: 'no_such_column' } });
    expect(await tariffColumnOf(whU)).toBe(ZONE.main);

    expect(await press(post(wh, { tariffZone: '' }))).toBe('redirected');
    expect(await tariffColumnOf(whU)).toBeNull();

    const history = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, whU), eq(auditLog.action, 'update')));
    expect(history.some((h) => (h.after as { tariffZone?: string })?.tariffZone === ZONE.main)).toBe(true);
    session.user = null;
  });

  it('8 — the cost action says «saved, not split» for a held bill, and refuses a stale preview (M6)', async () => {
    await signIn(adminId);
    const H = await mintClient('AH');
    const h = await mintLot({ client: H, kg: 1, m3: 3 });
    const truck = await mintTruck(h.boxIds);
    const base = {
      scope: 'batch',
      batchId: truck,
      costTypeId: freightType,
      amount: 90,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'freight',
    };
    const stale = await addCostEntryAction({ ...base, freightSeen: 'a'.repeat(64) });
    expect(stale).toMatchObject({ ok: false, error: 'freight_changed', params: { column: ZONE.main, from: TARIFF_DAY } });

    const saved = await addCostEntryAction(base);
    expect(saved.ok).toBe(true);
    expect(saved.unsplit?.held.reason).toBe('cargo');
    const [row] = await db
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(and(eq(costEntries.batchId, truck), eq(costEntries.allocationBasis, 'freight')));
    made.costs.push(row!.id);
    session.user = null;
  });
});

describe('the measures the split reads', () => {
  it('9 — a DRIFT lot: the old bases read its totals, the freight basis its carton', async () => {
    const K = await mintClient('DK');
    // 4×4×3 cm, 0.100 kg: the stored total rounds to 0.0000 m³.
    const k = await mintLot({ client: K, dims: [4, 4, 3], boxKg: '0.100' });
    const [m] = await boxMeasures(k.boxIds);
    expect([m!.totalVolumeM3, m!.volumeM3, m!.boxLengthCm, m!.boxWeightKg]).toEqual(['0.0000', 0, 4, '0.100']);
    const truck = await mintTruck(k.boxIds);
    const entry = await bill(truck, 10);
    expect(entry.verdict).toEqual({ kind: 'split' });
    expect(await byClient(entry.id)).toEqual({ [K]: 10 });
  });
});

describe('cleanup', () => {
  it('FINAL — deletes the run’s private columns and costs, deactivates its warehouses, and leaves no prefixed zone', async () => {
    await db.transaction(async (tx) => {
      await tx.delete(warehouseTariffColumns).where(like(warehouseTariffColumns.tariffZone, `t\\_%${RUN}\\_%`));
      await tx.delete(warehouseTariffColumns).where(inArray(warehouseTariffColumns.warehouseId, [whW, whU]));
      if (made.costs.length) await tx.delete(costEntries).where(inArray(costEntries.id, made.costs));
      await tx.delete(calcFreightTariffs).where(like(calcFreightTariffs.zone, `t\\_%${RUN}\\_%`));
    });
    const lotIds = (
      await db.select({ id: receiptLots.id }).from(receiptLots).where(inArray(receiptLots.receiptId, made.receipts))
    ).map((r) => r.id);
    if (lotIds.length) {
      const boxIds = (await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))).map((b) => b.id);
      if (boxIds.length) {
        await db.delete(events).where(inArray(events.entityId, boxIds));
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
        await db.delete(boxes).where(inArray(boxes.id, boxIds));
      }
      await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    }
    await db.delete(receipts).where(inArray(receipts.id, made.receipts));
    if (made.batches.length) await db.delete(batches).where(inArray(batches.id, made.batches));
    await db.update(clients).set({ active: false }).where(inArray(clients.id, made.clients));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whW, whU, whD]));
    await db.update(costTypes).set({ active: false }).where(eq(costTypes.id, privateCustomsType));
    await db.update(users).set({ active: false }).where(inArray(users.id, [actorId, adminId]));
    const left = await db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM calc_freight_tariffs WHERE zone LIKE ${`t\\_%${RUN}\\_%`})
           + (SELECT count(*) FROM warehouse_tariff_columns WHERE tariff_zone LIKE ${`t\\_%${RUN}\\_%`}) AS n
    `);
    expect(Number(left[0]!.n)).toBe(0);
    const cs = await db.execute<{ v: string }>(
      sql`SELECT value::text AS v FROM settings WHERE key = ${CUSTOMS_CODES_SETTING}`,
    );
    expect(cs[0]?.v ?? null).toBe(customsBefore);
  });
});
