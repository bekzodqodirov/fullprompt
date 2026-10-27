import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  customsImportBatches,
  customsImportRows,
  deals,
  dealStages,
  events,
  roles,
  tasks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { loadWorkspace, saveTable } from '@/modules/wms/calc/workspace';
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
let actorId = '';
let clientId = '';
let dealId = '';
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

  it('(1) Aniq over the typed row, Taxminiy with the median — and the row stays baza-less', async () => {
    requestId = await open('rastamojka', [
      { name: `Profil ${SUFFIX}`, tnvedCode: CODE_A, weightKg: 100 },
      { name: `Idish ${SUFFIX}`, tnvedCode: CODE_B, weightKg: 50 },
    ]);
    await typeBaza(requestId, `Profil ${SUFFIX}`, 4);
    out = await aiPrefill(requestId, { actorId: null }, { configured: false, replyTo: actorId });

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

describe('(9) the pass deadline', () => {
  it('past it: no pick, every median «budget», and the reply says so in words', async () => {
    const id = await open('rastamojka', [
      { name: `Profil ${SUFFIX} c`, tnvedCode: CODE_A, weightKg: 100 },
      { name: `Idish ${SUFFIX} c`, tnvedCode: CODE_B, weightKg: 50 },
    ]);
    await typeBaza(id, `Profil ${SUFFIX} c`, 4);
    let picks = 0;
    const out = await aiPrefill(id, { actorId: null }, {
      configured: true,
      deadline: Date.now() - 1,
      propose: async () => ({ groups: 0, batches: 0, failed: 0, ratesPulled: 0, codesStamped: 0, importFilled: 0, memoryFilled: 0, dictionaryFilled: 0 }),
      pick: async () => {
        picks += 1;
        return { answers: null, usage: null };
      },
    });
    expect(picks).toBe(0);
    expect(out.pastDeadline).toBe(true);
    expect(out.text).toContain('  Aniq: $92.80 (2 tadan 1 qator, yig‘imsiz)');
    expect(out.text).toContain('  Taxminiy: hisoblab bo‘lmadi — vaqt yetmadi, statistika o‘qilmadi');
    expect(out.text).toContain('📊 taxmin yo‘q: 2-qator — vaqt yetmadi — statistika o‘qilmadi');
  });
});
