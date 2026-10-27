import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The routes' door is `authorize('ved.docs')` and a test has no session, so
 * the gate is swapped for a switch — everything behind it is the code that
 * runs in production (import-stats.integration's own idiom).
 */
const gate = vi.hoisted(() => ({ actorId: '' }));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    authorize: async () =>
      ({ id: gate.actorId, permissions: new Set(['ved.docs']), roles: [], warehouseIds: [] }) as unknown as Awaited<
        ReturnType<typeof real.authorize>
      >,
  };
});

/**
 * The candidate read is WATCHED and, when a test asks, given a 1 ms ceiling
 * — the real function always runs. The routes and the pick both import it
 * from this one module, so one wrapper sees every caller.
 */
const spy = vi.hoisted(() => ({ calls: [] as { name: string; code: string }[], ceilingMs: undefined as number | undefined }));
vi.mock('@/modules/wms/customs/import-baza', async (original) => {
  const real = await original<typeof import('@/modules/wms/customs/import-baza')>();
  return {
    ...real,
    suggestImportBaza: (
      input: Parameters<typeof real.suggestImportBaza>[0],
      opts: Parameters<typeof real.suggestImportBaza>[1] = {},
    ) => {
      spy.calls.push({ name: input.name, code: input.tnvedCode });
      return real.suggestImportBaza(input, spy.ceilingMs === undefined ? opts : { ...opts, ceilingMs: spy.ceilingMs });
    },
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRates,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  customsImportBatches,
  deals,
  dealStages,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { onDate } from '@/modules/wms/calc/dictionaries';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { confirmAllGroups, loadWorkspace, saveTable, sealCalc } from '@/modules/wms/calc/workspace';
import { pickBazas } from '@/modules/wms/calc/prefill-steps';
import type { PickOutcome, PickRequest } from '@/modules/wms/calc/prefill-ai';
import { AI_RECODE_PREFIX } from '@/modules/wms/calc/warnings';
import { normalizeName } from '@/modules/wms/customs/import-parse';
import { GET as listRoute } from '@/app/api/calc/import-baza/route';
import { GET as statsRoute } from '@/app/api/calc/import-baza/stats/route';

/**
 * Import search by a HEADING (docs/SAKKIZ-R2.md §7.4).
 *
 * A row coded «6403» used to find nothing: the file is keyed on ten digits.
 * Now a heading lists its subheadings' declarations — each with its own code
 * — for the AI pick and the VED's 📥 list, and a pick RECODES the row. The
 * auto-fill and the statistics stay exact.
 *
 * The codes are chapter 98, which PP-3818 does not use, so this file's own
 * laws are the only ones that answer them:
 *   H   — the heading, a plain 10 % advalor law;
 *   TK  — a subheading at 15 % advalor (a kg row is at home there);
 *   TJ  — a subheading at «20 %, kamida $3/juft» (its law counts in juft);
 *   H2… — the NEXT heading, which a range on H must never reach.
 *
 * CONFIGURATION WARNING (#183): the laws and the ready batch answer every
 * later save of these codes; all of it is deleted in `afterAll`.
 */
const SUFFIX = String(Date.now()).slice(-6);
const D2 = SUFFIX.slice(-2);
const H = `98${D2}`;
const H2 = `98${String((Number(D2) + 1) % 100).padStart(2, '0')}`;
const TK = `${H}110000`;
const TJ = `${H}991000`;
const OTHER = `${H2}190000`;
const NAME = `Charm poyabzal erkaklar uchun ${SUFFIX}`;

let actorId = '';
let clientId = '';
let dealId = '';
let batchId = '';
const madeRates: string[] = [];
const madeRequests: string[] = [];
const ctx = () => ({ actorId });
/** The main declarations' ids, by what they are. */
const rowIds: Record<'tkKg' | 'tjKg' | 'tjM2' | 'other', string> = { tkKg: '', tjKg: '', tjM2: '', other: '' };

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99895${String(Date.now()).slice(-7)}`, fullName: `Heading fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  gate.actorId = actorId;
  const [client] = await db.insert(clients).values({ clientCode: `HS${SUFFIX}`, name: `Heading fixture ${SUFFIX}` }).returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `HS-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Heading fixture', createdBy: actorId })
    .returning();
  dealId = deal!.id;

  const laws = await db
    .insert(calcRates)
    .values([
      { tnvedCode: H, dutyPct: '10.000', vatPct: '12.000', effectiveDate: onDate(), source: 'manual' },
      { tnvedCode: TK, dutyPct: '15.000', vatPct: '12.000', effectiveDate: onDate(), source: 'manual' },
      {
        tnvedCode: TJ,
        dutyPct: '20.000',
        vatPct: '12.000',
        dutyMode: 'max',
        dutySpecific: '3.0000',
        dutyUnit: 'juft',
        effectiveDate: onDate(),
        source: 'manual',
      },
    ])
    .returning({ id: calcRates.id });
  madeRates.push(...laws.map((l) => l.id));

  const [batch] = await db.execute<{ id: string }>(sql`
    INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to)
    VALUES (${`heading-${SUFFIX}.xlsx`}, ${actorId}::uuid, 'ready', ${onDate()}::date, ${onDate()}::date)
    RETURNING id::text AS id`);
  batchId = batch!.id;
  const add = async (code: string, unit: string, price: number) => {
    const [r] = await db.execute<{ id: string }>(sql`
      INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
      VALUES (${batchId}::uuid, ${code}, ${NAME}, ${normalizeName(NAME)}, ${unit}, ${String(price)}::numeric, '156-КИТАЙ')
      RETURNING id::text AS id`);
    return r!.id;
  };
  rowIds.tkKg = await add(TK, 'kg', 8);
  rowIds.tjKg = await add(TJ, 'kg', 9);
  rowIds.tjM2 = await add(TJ, 'm2', 4);
  rowIds.other = await add(OTHER, 'kg', 7);
  // Three thousand other declarations under the heading, per piece and named
  // nothing like the row: the scan a heading pays is real, and a 1 ms ceiling
  // is certain to cut it (test f).
  await db.execute(sql`
    INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
    SELECT ${batchId}::uuid, ${H} || '5' || lpad((g % 100000)::text, 5, '0'),
           'Прочие изделия из пластмасс партия ' || g, 'прочие изделия из пластмасс партия ' || g,
           'dona', (1 + g % 7)::numeric, '156-КИТАЙ'
      FROM generate_series(1, 3000) g`);
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  // Raw, because the service refuses to delete a batch something priced off.
  if (batchId) await db.delete(customsImportBatches).where(eq(customsImportBatches.id, batchId));
  if (madeRates.length > 0) await db.delete(calcRates).where(inArray(calcRates.id, madeRates));
  await db.execute(sql`DELETE FROM tnved_assignments WHERE product_key = ${NAME.toLowerCase()}`);
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(items: { name: string; tnvedCode: string; weightKg?: number | null; quantity?: number | null }[]) {
  const result = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items,
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(result.id);
  // The first save groups the coded rows — the shape the pick meets.
  await saveTable(result.id, { items: [], adds: [] }, ctx());
  return result.id;
}

const rowsOf = (requestId: string) =>
  db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId)).orderBy(calcRequestItems.seq);

/** An injected pick choosing, for every row, the declaration `which` names. */
const choose =
  (which: (c: PickRequest['candidates'][number]) => boolean) =>
  async (rows: PickRequest[]): Promise<PickOutcome> => ({
    answers: rows.map((r) => ({ seq: r.seq, candidate: r.candidates.findIndex(which), reason: 'charm poyabzal' })),
    usage: null,
  });

type ListAnswer = {
  state: string;
  candidates: { id: string; tnvedCode: string; unit: string; pickable: boolean; lawUnit: string | null }[];
  named: unknown;
  namedState: string | null;
};
const list = async (itemId: string) =>
  (await (await listRoute(new Request(`http://t/api/calc/import-baza?item=${itemId}`))).json()) as ListAnswer;

describe('a heading lists its own subheadings and nothing else', () => {
  it('(a) a row coded with the heading is offered only that heading’s declarations', async () => {
    const id = await open([{ name: NAME, tnvedCode: H, weightKg: 40 }]);
    const [row] = await rowsOf(id);
    const answer = await list(row!.id);
    expect(answer.state).toBe('ok');
    const codes = answer.candidates.map((c) => c.tnvedCode);
    expect(codes).toContain(TK);
    expect(codes).toContain(TJ);
    expect(codes.every((c) => c.startsWith(H) && c.length === 10), codes.join(',')).toBe(true);
    expect(answer.candidates.map((c) => c.id)).not.toContain(rowIds.other);
  });

  it('(b) the model-free auto-fill never fills a heading row', async () => {
    // The name is the declarations' own — a full code would auto-fill at 1.0.
    const id = await open([{ name: NAME, tnvedCode: H, weightKg: 40 }]);
    const out = await saveTable(id, { items: [], adds: [] }, ctx());
    expect(out.importFilled).toEqual([]);
    expect((await rowsOf(id))[0]!.bazaUsd).toBeNull();
  });
});

describe('the AI pick recodes the row, and says so', () => {
  let recodedRequest = '';

  it('(c) a pick from the heading’s list lands the declaration’s code, the FILE’s price, and ai_recode', async () => {
    const id = await open([{ name: NAME, tnvedCode: H, weightKg: 40 }]);
    recodedRequest = id;
    const out = await pickBazas(id, ctx(), choose((c) => c.tnvedCode === TK && c.unit === 'kg'), null);
    expect(out.picked).toBe(1);
    const [row] = await rowsOf(id);
    expect(row!.tnvedCode).toBe(TK);
    expect(row).toMatchObject({ bazaUsd: '8.0000', bazaBasis: 'kg', bazaSource: 'import', importRowId: BigInt(rowIds.tkKg) });
    expect(row!.bazaReason!.startsWith(AI_RECODE_PREFIX)).toBe(true);
    expect(row!.bazaReason).toContain(`${H} → ${TK}`);
    const ws = await loadWorkspace(id);
    expect(ws!.groups).toHaveLength(1);
    expect(ws!.groups[0]!.tnvedCode).toBe(TK);
    expect(ws!.groups[0]!.warnings).toContain('ai_recode');
  });

  it('(c2) a same-code pick raises no ai_recode — only the import’s own warning', async () => {
    const id = await open([{ name: NAME, tnvedCode: TK, weightKg: 40 }]);
    // The full code auto-fills at 1.0 on the save in `open`; clear it so the
    // pick has an empty baza to answer.
    const [filled] = await rowsOf(id);
    await saveTable(id, { items: [{ id: filled!.id, seq: filled!.seq, bazaUsd: null, bazaBasis: null }], adds: [] }, ctx());
    const out = await pickBazas(id, ctx(), choose((c) => c.tnvedCode === TK && c.unit === 'kg'), null);
    expect(out.picked).toBe(1);
    const [row] = await rowsOf(id);
    expect(row!.tnvedCode).toBe(TK);
    expect(row!.bazaReason!.startsWith(AI_RECODE_PREFIX)).toBe(false);
    const ws = await loadWorkspace(id);
    expect(ws!.groups[0]!.warnings).toContain('baza_from_import');
    expect(ws!.groups[0]!.warnings).not.toContain('ai_recode');
  });

  it('(d) a declaration whose TARGET law counts in juft is refused on a row stating only kg', async () => {
    const id = await open([{ name: NAME, tnvedCode: H, weightKg: 40 }]);
    const out = await pickBazas(id, ctx(), choose((c) => c.tnvedCode === TJ && c.unit === 'kg'), null);
    expect(out.refused).toBe(1);
    expect(out.picked).toBe(0);
    const [row] = await rowsOf(id);
    expect(row!.bazaUsd).toBeNull();
    expect(row!.tnvedCode).toBe(H);
  });

  it('(d2) the 📥 list judges each candidate by ITS OWN law', async () => {
    const id = await open([{ name: NAME, tnvedCode: H, weightKg: 40 }]);
    const [row] = await rowsOf(id);
    const answer = await list(row!.id);
    const m2 = answer.candidates.find((c) => c.id === rowIds.tjM2)!;
    const kg = answer.candidates.find((c) => c.id === rowIds.tkKg)!;
    // Per m² under a juft law: a second pair unit the law cannot hold.
    expect(m2).toMatchObject({ pickable: false, lawUnit: 'juft' });
    // Per kg under its own advalor law: a fine choice.
    expect(kg).toMatchObject({ pickable: true, lawUnit: null });
  });

  it('(e) a heading gets no statistics and no named series — the list still answers', async () => {
    const id = await open([{ name: NAME, tnvedCode: H, weightKg: 40 }]);
    const [row] = await rowsOf(id);
    const stats = (await (await statsRoute(new Request(`http://t/api/calc/import-baza/stats?item=${row!.id}`))).json()) as {
      state: string;
    };
    expect(stats.state).toBe('short_code');
    const answer = await list(row!.id);
    expect(answer.state).toBe('ok');
    expect(answer.namedState).toBe('short_code');
    expect(answer.named).toBeNull();
  });

  it('(f) a heading read over its ceiling is a sentence on the list and a counted skip in the pick', async () => {
    const id = await open([{ name: NAME, tnvedCode: H, weightKg: 40 }]);
    const [row] = await rowsOf(id);
    spy.ceilingMs = 1;
    try {
      const answer = await list(row!.id);
      expect(answer.state).toBe('timeout');
      const out = await pickBazas(id, ctx(), choose(() => true), null);
      expect(out.timedOut).toBe(1);
      expect(out.picked).toBe(0);
    } finally {
      spy.ceilingMs = undefined;
    }
  });

  it('(g) ten identical heading rows cost ONE candidate read', async () => {
    const twin = `Charm tufli ${SUFFIX}`;
    const id = await open(Array.from({ length: 10 }, () => ({ name: twin, tnvedCode: H, weightKg: 12 })));
    spy.calls.length = 0;
    await pickBazas(id, ctx(), async () => ({ answers: null, usage: null }), null);
    expect(spy.calls.filter((c) => c.name === twin)).toHaveLength(1);
  });

  // LAST in the file on purpose: the seal TEACHES the memory, and every later
  // job named like this one would then be priced by it before the pick asks.
  it('(c3) E1 counts a sealed group minted by a recode as the AI’s', async () => {
    expect(recodedRequest).not.toBe('');
    await confirmAllGroups(recodedRequest, ctx());
    await sealCalc(
      recodedRequest,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    const [version] = await db.select().from(calcVersions).where(eq(calcVersions.requestId, recodedRequest));
    // The group was minted by the recode's regroup with `ai_proposed` false.
    const [group] = await db.select().from(calcGroups).where(eq(calcGroups.requestId, recodedRequest));
    expect(group!.aiProposed).toBe(false);
    expect(version!.aiGroupsSealed).toBe(1);
  });
});
