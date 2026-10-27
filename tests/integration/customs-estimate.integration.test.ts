import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  customsImportBatches,
  customsImportRows,
  deals,
  dealStages,
  events,
  roles,
  tasks,
  tnvedAssignments,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import {
  confirmAllGroups,
  loadWorkspace,
  saveTable,
  sealCalc,
  setFeeOverride,
  setFreightZone,
} from '@/modules/wms/calc/workspace';
import { landingItems } from '@/modules/wms/calc/intake';
import { itemNameNorm } from '@/modules/wms/calc/memory';
import { aiPrefill } from '@/modules/wms/calc/prefill';
import { rowMediansFor } from '@/modules/wms/calc/estimate-read';
import { bandKeyOf } from '@/modules/wms/calc/estimate';
import { readCodeMedians } from '@/modules/wms/customs/import-median';
import { readImportStats } from '@/modules/wms/customs/import-stats';
import { underCeiling } from '@/modules/wms/finance/price-history';
import { TARIFF_REPLY_HEAD, VED_ESTIMATE_MARK } from '@/modules/wms/calc/reply-heads';

/**
 * The 📊 estimate end to end (docs/SAKKIZ-R2.md §6.9): his 2.1 b (the median
 * of real China declarations stands in for a missing baza), 2.2 b (two
 * totals), 2.5 b (a yolkira job answered from the tariff), 2.6 b (the zone
 * guessed and said, never stored) and 2.7 b (the cube summed and labelled).
 *
 * The declarations are written straight into a READY batch so every median
 * is a number computed by hand below. The PP-3818 seed supplies the law:
 * 3916 → 10 %, 3924 → 20 %, 3926 → 10 %, VAT 12 % on all three; the fee is
 * 1 BHM = 412 000 so‘m ÷ 12 500 = $32.96 (the seed's setting and UZS rate).
 *
 * CONFIGURATION WARNING (#183): a READY import is read by every later save
 * in this database — the batch is deleted in `afterAll`, and the declaration
 * names are Cyrillic while the goods are Latin, so the import AUTO-fill
 * (name similarity ≥ 0.45) never fills a row here and the shadow is the only
 * thing that can answer them.
 */
const SUFFIX = String(Date.now()).slice(-6);
const CODE_A = '3916100000'; // exact, a typed baza
const CODE_B = '3924100000'; // per kg: six Chinese declarations, six Turkish
const CODE_C = '3926100000'; // per piece: six in the ±25 % band, six outside it
// 20 % with a floor of $3 a piece (PP-3818's seeded row) — a row stating only
// kilos is refused `measure_missing`, the customer's fact.
const CODE_FLOOR = '4203100001';
// The SEALED memory's product (0096): long words, so the six-digit suffix the
// other rows share cannot carry a `similarity` of 0.6 on its own.
const MEMORY_NAME = `Alyuminiy profil derazabop ${SUFFIX}`;
let actorId = '';
let clientId = '';
let dealId = '';
let memoryDealId = '';
let batchId = '';
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99894${String(Date.now()).slice(-7)}`, fullName: `Estimate fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  // `ved.docs`, so the chat's reply carries its «Karta:» link (8).
  const [ved] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, 'ved_manager'));
  await db.insert(userRoles).values({ userId: actorId, roleId: ved!.id });
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `ES${SUFFIX}`, name: `Estimate fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `ES-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Estimate fixture', createdBy: actorId })
    .returning();
  dealId = deal!.id;
  // The memory's seal sits on a card of its own: a seal LOCKS its card's
  // quote, and the shared card above is every other case's.
  const [memoryDeal] = await db
    .insert(deals)
    .values({ code: `ES-${SUFFIX}-M`, clientId, stageId: stage!.id, title: 'Estimate memory fixture', createdBy: actorId })
    .returning();
  memoryDealId = memoryDeal!.id;

  const today = new Date().toISOString().slice(0, 10);
  const [batch] = await db
    .insert(customsImportBatches)
    .values({ fileName: `estimate-${SUFFIX}.xlsx`, uploadedBy: actorId, status: 'ready', periodFrom: today, periodTo: today, rowCount: 24 })
    .returning({ id: customsImportBatches.id });
  batchId = batch!.id;
  const row = (code: string, unit: string, price: string, origin: string, weight: string | null = null) => ({
    batchId,
    tnvedCode: code,
    name: 'Посуда пластиковая хозяйственная',
    nameNorm: 'посуда пластиковая хозяйственная',
    unit,
    pricePerUnitUsd: price,
    weightPerUnitKg: weight,
    originCountry: origin,
  });
  await db.insert(customsImportRows).values([
    // CODE_B per kg — China 2.0…3.0 (median, disc: the 3rd of 6 = 2.40),
    // Turkey 9.0…10.0 (with them the 6th of 12 = 3.00).
    ...['2.0', '2.2', '2.4', '2.6', '2.8', '3.0'].map((p) => row(CODE_B, 'kg', p, '156-КИТАЙ')),
    ...['9.0', '9.2', '9.4', '9.6', '9.8', '10.0'].map((p) => row(CODE_B, 'kg', p, '792-ТУРЦИЯ')),
    // CODE_C per piece — a 0.5 kg piece's band is 0.375…0.625 kg: inside it
    // 1.0…1.5 (disc median 1.20); outside it, at 2 kg a piece, 5…10 (with
    // them the 6th of 12 = 1.50).
    ...[['1.0', '0.5'], ['1.1', '0.45'], ['1.2', '0.55'], ['1.3', '0.6'], ['1.4', '0.4'], ['1.5', '0.52']].map(([p, w]) =>
      row(CODE_C, 'dona', p!, '156-КИТАЙ', w!),
    ),
    ...['5', '6', '7', '8', '9', '10'].map((p) => row(CODE_C, 'dona', p, '156-КИТАЙ', '2')),
  ]);
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const ids = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (ids.length > 0) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(tasks).where(inArray(tasks.id, ids));
    }
  }
  // The seal TEACHES the exact-key code book, and a `tnved_assignments` row
  // is CONFIGURATION for every later file (#183).
  await db.delete(tnvedAssignments).where(eq(tnvedAssignments.productKey, itemNameNorm(MEMORY_NAME)));
  if (batchId) await db.delete(customsImportBatches).where(eq(customsImportBatches.id, batchId));
  await db.delete(userRoles).where(eq(userRoles.userId, actorId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

type Item = Parameters<typeof openCalcRequest>[0]['items'][number];
async function open(
  section: 'yolkira' | 'rastamojka' | 'podklyuch',
  items: Item[],
  extra: Partial<Parameters<typeof openCalcRequest>[0]> = {},
): Promise<string> {
  const r = await openCalcRequest(
    { entityType: 'deal', entityId: dealId, section, fromCity: 'Yiwu', toCity: 'Toshkent', items, source: 'card', ...extra },
    ctx(),
  );
  madeRequests.push(r.id);
  return r.id;
}

/**
 * One priced, confirmed, SEALED job about `MEMORY_NAME` — what the memory
 * (0096) answers a later row from, through the real seal (calc-memory's
 * `sealOne`, per kg).
 */
async function sealMemory(): Promise<void> {
  const r = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: memoryDealId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      items: [{ name: MEMORY_NAME, tnvedCode: CODE_A, weightKg: 100 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(r.id);
  await typeBaza(r.id, MEMORY_NAME, 4);
  await setFreightZone(r.id, 'cn', ctx());
  await confirmAllGroups(r.id, ctx());
  await sealCalc(r.id, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx());
}

/** A person types a baza on the row named so — the exact half of a reply. */
async function typeBaza(requestId: string, name: string, bazaUsd: number): Promise<void> {
  await saveTable(requestId, { items: [], adds: [] }, ctx());
  const all = await db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId));
  const row = all.find((r) => r.name === name);
  if (!row) throw new Error(`no row named ${name}`);
  await saveTable(requestId, { items: [{ id: row.id, seq: row.seq, bazaUsd, bazaBasis: 'kg' }], adds: [] }, ctx());
}

describe('(1)(8) two totals in the chat, the estimate never written, the VED told on the lenta', () => {
  let requestId = '';
  let out: Awaited<ReturnType<typeof aiPrefill>>;

  it('(1) Aniq over the 🧠 row, Taxminiy with the median — and the row stays baza-less', async () => {
    // §6.9(1) as written: the exact group is priced by the SEALED MEMORY, so
    // the 🧠 mark beside «Aniq» and the two-mark legend run end to end.
    await sealMemory();
    requestId = await open('rastamojka', [
      { name: MEMORY_NAME, tnvedCode: CODE_A, weightKg: 100 },
      { name: `Idish ${SUFFIX}`, tnvedCode: CODE_B, weightKg: 50 },
    ]);
    out = await aiPrefill(requestId, { actorId: null }, { configured: false, replyTo: actorId });

    // The premise: nobody typed it — the memory answered the row.
    const [memo] = await db
      .select({ bazaSource: calcRequestItems.bazaSource })
      .from(calcRequestItems)
      .where(sql`${calcRequestItems.requestId} = ${requestId} AND ${calcRequestItems.name} = ${MEMORY_NAME}`);
    expect(memo!.bazaSource).toBe('memory');
    expect(out.text).toContain(`1. ${MEMORY_NAME} · ${CODE_A} · 100 kg × $4/kg 🧠\n`);
    expect(out.text).toContain('\n🧠 avvalgi muhrdan · 📊 deklaratsiyalar medianasi (taxminiy)\n');

    // A: 100 kg × $4 = 400; duty 10 % = 40; VAT 12 % of 440 = 52.80 → 92.80.
    expect(out.text).toContain('  Aniq: $92.80 (2 tadan 1 qator, yig‘imsiz)');
    // B: 50 kg × $2.40 (the China median) = 120; duty 20 % = 24; VAT 12 % of 144 = 17.28 → 41.28.
    // Value 520 → 1 BHM = 32.96. 92.80 + 41.28 + 32.96 = 167.04.
    expect(out.text).toContain('  Taxminiy ≈ $167.04 (yig‘im 1 BHM ≈ $32.96 bilan)');
    expect(out.text).toContain('→ ≈ $41.28 (taxminiy, 6 ta deklaratsiyadan)');
    expect(out.taxminiyUsd).toBe(167.04);
    // The workspace's EXACT total is still none — the estimate is chat only.
    expect(out.customsUsd).toBeNull();

    const [row] = await db
      .select({ bazaUsd: calcRequestItems.bazaUsd, bazaSource: calcRequestItems.bazaSource })
      .from(calcRequestItems)
      .where(sql`${calcRequestItems.requestId} = ${requestId} AND ${calcRequestItems.name} = ${`Idish ${SUFFIX}`}`);
    expect(row).toEqual({ bazaUsd: null, bazaSource: null });
  });

  it('(8) the lenta copy: the chat text minus «Karta:», plus ONE «🔎 VED uchun:» line as line 2', () => {
    const chat = out.text.split('\n');
    const lenta = out.lentaText.split('\n');
    // The card the reader is admitted to wins (`calcJobHrefFor` 1-2): the
    // VED holds `ved.docs`, which is on the deal-write list.
    expect(chat.at(-1)).toBe(`Karta: ${(process.env.APP_URL ?? '').replace(/\/$/, '')}/bitimlar/${dealId}`);
    expect(lenta[1]!.startsWith(VED_ESTIMATE_MARK)).toBe(true);
    expect(lenta.filter((l) => l.includes(VED_ESTIMATE_MARK))).toHaveLength(1);
    expect([lenta[0], ...lenta.slice(2)]).toEqual(chat.slice(0, -1));
  });
});

describe('(2)(3)(4) the median: the dialog’s own number, China only, the row’s own band', () => {
  it('(2) equals the 📥 dialog’s «50 % (mediana)» — per kg and per piece in the band', async () => {
    const band = bandKeyOf(0.5)!;
    const [kg, dona] = await underCeiling(async (tx) => [
      await readCodeMedians(tx, { batchId, tnvedCode: CODE_B, bands: [] }),
      await readCodeMedians(tx, { batchId, tnvedCode: CODE_C, bands: [band] }),
    ]);
    const statsKg = await underCeiling((tx) =>
      readImportStats(tx, { batchId, prevBatchId: null, tnvedCode: CODE_B, units: ['kg'], dutyUnit: null, perPieceKg: null }),
    );
    const statsDona = await underCeiling((tx) =>
      readImportStats(tx, { batchId, prevBatchId: null, tnvedCode: CODE_C, units: ['dona'], dutyUnit: null, perPieceKg: 0.5 }),
    );
    // A second surface computed a different way: the dialog's 99-step ladder
    // read at index 49, against one direct `percentile_disc(0.5)` (#1116).
    const kgStats = statsKg.units.find((u) => u.unit === 'kg')!;
    expect(kg.find((u) => u.unit === 'kg')!.p50).toBe(kgStats.all.p50);
    const donaStats = statsDona.units.find((u) => u.unit === 'dona')!;
    const weight = donaStats.weight;
    if (!weight || weight === 'no_row_weight') throw new Error('the dialog drew no band series');
    expect(dona.find((u) => u.unit === 'dona')!.bands.get(band.key)!.p50).toBe(weight.p50);
  });

  it('(3) China only: six Turkish declarations at $9-10 do not move the median', async () => {
    const [kg] = await underCeiling((tx) => readCodeMedians(tx, { batchId, tnvedCode: CODE_B, bands: [] }));
    expect(kg).toMatchObject({ unit: 'kg', n: 6, p50: 2.4 });
  });

  it('(4) a piece is priced off pieces of ITS weight — the 2 kg declarations change nothing', async () => {
    const id = await open('rastamojka', [{ name: `Qopqoq ${SUFFIX}`, tnvedCode: CODE_C, quantity: 100, weightKg: 50 }]);
    await saveTable(id, { items: [], adds: [] }, ctx());
    const ws = await loadWorkspace(id);
    const medians = await rowMediansFor(ws!, { deadline: Date.now() + 60_000 });
    const item = ws!.groups[0]!.items[0]!;
    // 50 kg ÷ 100 pieces = 0.5 kg → the band's six: disc median 1.20, per piece.
    expect(medians.get(item.id)).toMatchObject({ ok: true, bazaUsd: 1.2, basis: 'unit', n: 6, stale: false });
  });
});

describe('(5)(6)(7) the road: the tariff at once, the guess said and never stored, the cube labelled', () => {
  it('(5) a yolkira job is answered from the tariff — no customs, no model, no billed pass', async () => {
    const id = await open('yolkira', [{ name: `Yuk ${SUFFIX}` }], { freightZone: 'cn', weightKg: 500, volumeM3: 10 });
    const out = await aiPrefill(id, { actorId: null }, { configured: true });
    // 500 kg ÷ 10 m³ = 50 kg/m³ → the cn 1-100 band, $110 × 10 m³ = $1100.
    expect(out.text.startsWith(`${TARIFF_REPLY_HEAD} (tarif bo‘yicha) · taxminiy`)).toBe(true);
    expect(out.text).toContain('50 kg/m³ · $110/m³ × 10 m³');
    expect(out.text).toContain('Yo‘lkira: ≈ $1100.00');
    expect(out.text).not.toContain('rastamojka');
    const [billed] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ai_calc_passes WHERE request_id = ${id}::uuid`);
    expect(Number(billed!.n)).toBe(0);
  });

  it('(6) podklyuch with no zone: «Yiwu» guessed, said, JAMI taxminiy — and the zone still null after', async () => {
    const id = await open('podklyuch', [{ name: `Profil ${SUFFIX} b`, tnvedCode: CODE_A, weightKg: 100 }], {
      weightKg: 500,
      volumeM3: 10,
    });
    await typeBaza(id, `Profil ${SUFFIX} b`, 4);
    const out = await aiPrefill(id, { actorId: null }, { configured: false });
    // Customs exact: 92.80 + the fee 32.96 = 125.76; the road $1100 on the guess.
    expect(out.text).toContain('Yo‘lkira (Xitoy → O‘zbekiston — zona «Yiwu»dan taxmin, 50 kg/m³ · $110/m³ × 10 m³): ≈ $1100.00');
    expect(out.text).toContain('JAMI taxminiy (rastamojka + yo‘lkira): ≈ $1225.76');
    const [req] = await db.select({ freightZone: calcRequests.freightZone }).from(calcRequests).where(eq(calcRequests.id, id));
    expect(req!.freightZone).toBeNull();
  });

  it('(7) landed through the real door with lines 1.2 + 1.6 m³ and no total: × 2.8 m³ (qatorlardan)', async () => {
    const id = await open(
      'yolkira',
      [
        { name: `Quti ${SUFFIX} a`, volumeM3: 1.2 },
        { name: `Quti ${SUFFIX} b`, volumeM3: 1.6 },
      ],
      { freightZone: 'cn', weightKg: 504 },
    );
    const out = await aiPrefill(id, { actorId: null }, { configured: false });
    // 504 ÷ 2.8 = 180 kg/m³ → the 151-200 band, $160 × 2.8 = $448.
    expect(out.text).toContain('180 kg/m³ · $160/m³ × 2.8 m³ (qatorlardan)');
    expect(out.text).toContain('Yo‘lkira: ≈ $448.00');
  });

  it('(7b) the same lines with a typed total of 5 m³: the total prices it, unlabelled', async () => {
    const id = await open(
      'yolkira',
      [
        { name: `Quti ${SUFFIX} c`, volumeM3: 1.2 },
        { name: `Quti ${SUFFIX} d`, volumeM3: 1.6 },
      ],
      { freightZone: 'cn', weightKg: 504, volumeM3: 5 },
    );
    const out = await aiPrefill(id, { actorId: null }, { configured: false });
    // 504 ÷ 5 = 100.8 → band density 101 → the 101-150 band, $130 × 5 = $650.
    expect(out.text).toContain('× 5 m³');
    expect(out.text).toContain('Yo‘lkira: ≈ $650.00');
    expect(out.text).not.toContain('qatorlardan');
  });
});

describe('(7c) a road on a cube the request does NOT hold is never summed as the exact «JAMI» (review law-money-R2-1)', () => {
  it('the typed cube was ambiguous: no Σ stored, the screen refuses the road, the reply says «JAMI taxminiy»', async () => {
    // The P3-R2 landing: the seller typed the cube two ways, so the INSERT
    // stores no Σ and the checklist keeps asking — while every line carries
    // its own m³ and the zone is STORED (the AI podklyuch «qayerdan?» button).
    const id = await open(
      'podklyuch',
      [{ name: `Profil ${SUFFIX} kub`, tnvedCode: CODE_A, weightKg: 100, volumeM3: 2.8 }],
      { freightZone: 'cn', weightKg: 504, volumeM3: null, volumeAmbiguous: true },
    );
    await typeBaza(id, `Profil ${SUFFIX} kub`, 4);
    const ws = await loadWorkspace(id);
    // The premise: the request holds no cube, and the VED's own road refuses it.
    expect(ws!.volumeM3).toBeNull();
    expect(ws!.freight).toMatchObject({ ok: false, reason: 'measure_missing' });

    const out = await aiPrefill(id, { actorId: null }, { configured: false });
    // Customs exact: 92.80 + 1 BHM 32.96 = 125.76; the road 504 ÷ 2.8 = 180 →
    // $160 × 2.8 = $448, priced on the lines' Σ and labelled so.
    expect(out.text).toContain('Rastamojka jami: ≈ $125.76');
    expect(out.text).toContain('180 kg/m³ · $160/m³ × 2.8 m³ (qatorlardan)): ≈ $448.00');
    expect(out.text).toContain('JAMI taxminiy (rastamojka + yo‘lkira): ≈ $573.76');
    expect(out.text).not.toContain('JAMI (');
    // …and the VED reading the card is told why, under the heading.
    expect(out.lentaText.split('\n')[1]).toContain('yo‘lkira hajmi qatorlardan — so‘rovda umumiy hajm yo‘q');
  });
});

describe('(13) an exact line on an OLD 📥 baza says so (review law-money-R2-2)', () => {
  it('a declaration from a quarter long ended: the figure stands, the head says «⚠ eski baza»', async () => {
    // A quarter two years gone — past BAZA_STALE_DAYS by any clock — holding
    // the one declaration the VED picks through the 📥 door (`saveTable`'s
    // `importRowId`: the file answers the price, the browser only the row).
    const year = Number(new Date().toISOString().slice(0, 4)) - 2;
    const [old] = await db
      .insert(customsImportBatches)
      .values({
        fileName: `estimate-old-${SUFFIX}.xlsx`,
        uploadedBy: actorId,
        status: 'ready',
        periodFrom: `${year}-01-01`,
        periodTo: `${year}-03-31`,
        rowCount: 1,
      })
      .returning({ id: customsImportBatches.id });
    try {
      const [row] = await db
        .insert(customsImportRows)
        .values({
          batchId: old!.id,
          tnvedCode: CODE_A,
          name: 'Профиль алюминиевый оконный',
          nameNorm: 'профиль алюминиевый оконный',
          unit: 'kg',
          pricePerUnitUsd: '4',
          originCountry: '156-КИТАЙ',
        })
        .returning({ id: customsImportRows.id });
      const name = `Profil ${SUFFIX} eski`;
      const id = await open('rastamojka', [{ name, tnvedCode: CODE_A, weightKg: 100 }]);
      await saveTable(id, { items: [], adds: [] }, ctx());
      const [item] = await db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, id));
      await saveTable(id, { items: [{ id: item!.id, seq: item!.seq, importRowId: String(row!.id) }], adds: [] }, ctx());
      const ws = await loadWorkspace(id);
      // The premise: the screen wears its ⚠ on this very row.
      expect(ws!.groups[0]!.items[0]).toMatchObject({ bazaSource: 'import', bazaStale: true });

      const out = await aiPrefill(id, { actorId: null }, { configured: false });
      // 100 kg × $4 = 400; duty 10 % = 40; VAT 12 % of 440 = 52.80 → 92.80.
      expect(out.text).toContain(`1. ${name} · ${CODE_A} · 100 kg × $4/kg 📥 · ⚠ eski baza\n`);
      expect(out.text).toContain('   boj 10% · QQS 12% → $92.80');
    } finally {
      await db.delete(customsImportBatches).where(eq(customsImportBatches.id, old!.id));
    }
  });
});

describe('(9) the pass deadline', () => {
  it('past it: no pick, every median «budget», and the reply says so in words', async () => {
    const id = await open('rastamojka', [
      { name: `Profil ${SUFFIX} c`, tnvedCode: CODE_A, weightKg: 100 },
      { name: `Idish ${SUFFIX} c`, tnvedCode: CODE_B, weightKg: 50 },
    ]);
    await typeBaza(id, `Profil ${SUFFIX} c`, 4);
    let picks = 0;
    let groupings = 0;
    const out = await aiPrefill(id, { actorId: null }, {
      configured: true,
      deadline: Date.now() - 1,
      propose: async (_id, _c, o) => {
        groupings += 1;
        return { groups: 0, batches: 0, failed: 0, ratesPulled: 0, codesStamped: 0, importFilled: 0, memoryFilled: 0, dictionaryFilled: 0, rev: o?.expectRev ?? null };
      },
      pick: async () => {
        picks += 1;
        return { answers: null, usage: null };
      },
    });
    expect(picks).toBe(0);
    // The grouping is asked the clock too (R2 late pass, review perf-3): five
    // calls of two minutes each, started past the deadline, outlive the
    // job's expiry and are re-delivered beside themselves.
    expect(groupings).toBe(0);
    expect(out.pastDeadline).toBe(true);
    expect(out.text).toContain('  Aniq: $92.80 (2 tadan 1 qator, yig‘imsiz)');
    expect(out.text).toContain('  Taxminiy: hisoblab bo‘lmadi — vaqt yetmadi, statistika o‘qilmadi');
    expect(out.text).toContain('📊 taxmin yo‘q: 2-qator — vaqt yetmadi — statistika o‘qilmadi');
  });
});

describe('(10) «(og‘irlik bruttodan)» wherever the measure is printed (⭐ of his Question 4)', () => {
  /**
   * A one-line job whose weight is the shipment's BRUTTO total, landed the
   * way the bot and the thread land it: through `landingItems`, which copies
   * the total onto the single line and says so in the row note
   * (`LONE_WEIGHT_NOTE`). Never a hand-written note (#1116).
   */
  async function loneLine(name: string, code: string): Promise<string> {
    const facts = { weightKg: 300, goods: [{ name, tnvedCode: code }] };
    const id = await open('rastamojka', landingItems(facts), { weightKg: facts.weightKg });
    await typeBaza(id, name, 4);
    return id;
  }

  it('(a) an exact group: the mark sits between the measure and the baza', async () => {
    const id = await loneLine(`Profil ${SUFFIX} brutto`, CODE_A);
    const out = await aiPrefill(id, { actorId: null }, { configured: false });
    // 300 kg × $4 = 1200; duty 10 % = 120; VAT 12 % of 1320 = 158.40 → 278.40.
    expect(out.text).toContain(`1. Profil ${SUFFIX} brutto · ${CODE_A} · 300 kg (og‘irlik bruttodan) × $4/kg\n`);
    expect(out.text).toContain('   boj 10% · QQS 12% → $278.40');
  });

  it('(b) the same row REFUSED by a $/dona floor still prints its measure — and the mark — and sends the count to the seller', async () => {
    // The line that ASKS the seller for a fact is the one that most needs to
    // say the kilos it priced are brutto; the first build hid the mark here.
    const id = await loneLine(`Charm kurtka ${SUFFIX}`, CODE_FLOOR);
    const out = await aiPrefill(id, { actorId: null }, { configured: false });
    expect(out.text).toContain(`1. Charm kurtka ${SUFFIX} · ${CODE_FLOOR} · 300 kg (og‘irlik bruttodan) × $4/kg\n`);
    const refusal = out.text.split('\n').find((l) => l.startsWith('   ⚠️ '));
    expect(refusal, 'the refused line').toBeDefined();
    // One fact, one fixer: the count is the customer's (§0.1(7)), on the line
    // as in the Taxminiy sentence below it.
    expect(refusal!.endsWith('— mijozdan so‘rab, kartadagi lentaga yozing')).toBe(true);
    expect(refusal).not.toContain('VED xodimi');
  });
});

describe('(11) the per-code band slots go where a band decides (MAX_BANDS_PER_CODE)', () => {
  it('ten kg-first rows of one code at ten weights a piece all answer from the kilos; a dona-first row is never starved', async () => {
    // CODE_B: ten sizes of one product, each stating kilos and a count — the
    // ordinary invoice. Their kilos have a China median (2.40), so no band
    // can change their answer; the first build gave rows 9-10 `capped` and
    // took the whole Taxminiy with them.
    const kgFirst = Array.from({ length: 10 }, (_, k) => ({
      name: `Idish ${SUFFIX} o‘lcham ${k + 1}`,
      tnvedCode: CODE_B,
      quantity: 100,
      weightKg: 50 + 20 * k,
    }));
    // CODE_C: nine kg-first rows at 1.0…1.8 kg a piece (the code has no kilo
    // declarations, so their bands DO decide), and LAST a row whose unit the
    // VED chose per piece, at 0.5 kg — the six declarations in its band.
    const sizes = Array.from({ length: 9 }, (_, k) => ({
      name: `Qopqoq ${SUFFIX} o‘lcham ${k + 1}`,
      tnvedCode: CODE_C,
      quantity: 100,
      weightKg: 100 + 10 * k,
    }));
    const chosen = { name: `Qopqoq ${SUFFIX} dona`, tnvedCode: CODE_C, quantity: 100, weightKg: 50 };
    const id = await open('rastamojka', [...kgFirst, ...sizes, chosen]);
    await saveTable(id, { items: [], adds: [] }, ctx());
    const [row] = await db
      .select({ id: calcRequestItems.id, seq: calcRequestItems.seq })
      .from(calcRequestItems)
      .where(sql`${calcRequestItems.requestId} = ${id} AND ${calcRequestItems.name} = ${chosen.name}`);
    // A unit CHOSEN with no price yet (0125's third state) — `unitsForItem`
    // then answers ['dona'] alone.
    await saveTable(id, { items: [{ id: row!.id, seq: row!.seq, bazaUsd: null, bazaBasis: 'unit' }], adds: [] }, ctx());

    const ws = await loadWorkspace(id);
    const medians = await rowMediansFor(ws!, { deadline: Date.now() + 60_000 });
    const byName = new Map(ws!.groups.flatMap((g) => g.items).map((i) => [i.label, medians.get(i.id)]));
    for (const r of kgFirst) {
      expect(byName.get(r.name), r.name).toMatchObject({ ok: true, bazaUsd: 2.4, basis: 'kg', n: 6 });
    }
    expect(byName.get(chosen.name), 'the dona-first row takes a slot before any kg-first one').toMatchObject({
      ok: true,
      bazaUsd: 1.2,
      basis: 'unit',
      n: 6,
    });
  });
});

describe('(12) a typed fee override: the Taxminiy carries ITS figure, never a BHM tier', () => {
  it('«(yig‘im ≈ $50.00 bilan)», and no «BHM» anywhere in the reply', async () => {
    const id = await open('rastamojka', [
      { name: `Profil ${SUFFIX} e`, tnvedCode: CODE_A, weightKg: 100 },
      { name: `Idish ${SUFFIX} e`, tnvedCode: CODE_B, weightKg: 50 },
    ]);
    await typeBaza(id, `Profil ${SUFFIX} e`, 4);
    await setFeeOverride(id, 50, ctx());
    const out = await aiPrefill(id, { actorId: null }, { configured: false });
    // 92.80 (exact) + 41.28 (the median's) + the typed $50 = 184.08.
    expect(out.text).toContain('  Taxminiy ≈ $184.08 (yig‘im ≈ $50.00 bilan)\n');
    expect(out.text).not.toContain('BHM');
  });
});
