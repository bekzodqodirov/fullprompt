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
 *
 * `afterRead` runs once, right after a pre-transaction read of the save has
 * answered (the fill's candidate read, or a pick's row check): the moment
 * an admin's delete can land before the save's transaction opens (review
 * concurrency-10).
 */
const spy = vi.hoisted(() => ({
  calls: [] as { name: string; code: string }[],
  ceilingMs: undefined as number | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@/modules/wms/customs/import-baza', async (original) => {
  const real = await original<typeof import('@/modules/wms/customs/import-baza')>();
  const after = async () => {
    const hook = spy.afterRead;
    spy.afterRead = undefined;
    if (hook) await hook();
  };
  return {
    ...real,
    suggestImportBaza: async (
      input: Parameters<typeof real.suggestImportBaza>[0],
      opts: Parameters<typeof real.suggestImportBaza>[1] = {},
    ) => {
      spy.calls.push({ name: input.name, code: input.tnvedCode });
      const answer = await real.suggestImportBaza(
        input,
        spy.ceilingMs === undefined ? opts : { ...opts, ceilingMs: spy.ceilingMs },
      );
      await after();
      return answer;
    },
    importRowForCode: async (...args: Parameters<typeof real.importRowForCode>) => {
      const row = await real.importRowForCode(...args);
      await after();
      return row;
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
import { deleteImportBatch } from '@/modules/wms/customs/import-service';
import { CalcError } from '@/modules/wms/calc/service';
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
 *   H2… — the NEXT heading, which a range on H must never reach;
 *   HJ  — a second heading whose OWN law counts in juft («20 %, kamida
 *         $3/juft», 6403's shape), with HJK under it at a plain 5 % advalor
 *         (6403120000's) — the spec's own example, review P2-1.
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
const HJ = `98${String((Number(D2) + 50) % 100).padStart(2, '0')}`;
const HJK = `${HJ}120000`;
const NAME_J = `Bolalar rezina etigi ${SUFFIX}`;

let actorId = '';
let clientId = '';
let dealId = '';
let batchId = '';
const madeRates: string[] = [];
const madeRequests: string[] = [];
const ctx = () => ({ actorId });
/** The main declarations' ids, by what they are. */
const rowIds: Record<'tkKg' | 'tjKg' | 'tjM2' | 'other' | 'hjkKg', string> = {
  tkKg: '',
  tjKg: '',
  tjM2: '',
  other: '',
  hjkKg: '',
};

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
      {
        tnvedCode: HJ,
        dutyPct: '20.000',
        vatPct: '12.000',
        dutyMode: 'max',
        dutySpecific: '3.0000',
        dutyUnit: 'juft',
        effectiveDate: onDate(),
        source: 'manual',
      },
      { tnvedCode: HJK, dutyPct: '5.000', vatPct: '12.000', effectiveDate: onDate(), source: 'manual' },
    ])
    .returning({ id: calcRates.id });
  madeRates.push(...laws.map((l) => l.id));

  const [batch] = await db.execute<{ id: string }>(sql`
    INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to)
    VALUES (${`heading-${SUFFIX}.xlsx`}, ${actorId}::uuid, 'ready', ${onDate()}::date, ${onDate()}::date)
    RETURNING id::text AS id`);
  batchId = batch!.id;
  const add = async (code: string, unit: string, price: number, name = NAME) => {
    const [r] = await db.execute<{ id: string }>(sql`
      INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
      VALUES (${batchId}::uuid, ${code}, ${name}, ${normalizeName(name)}, ${unit}, ${String(price)}::numeric, '156-КИТАЙ')
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
  // HJ: ONE exact-name kg declaration under HJK, and 120 per-pair ones under
  // the heading's own law, named nothing like the row — more than the
  // dialog's fifty and the pick's ten, so a ranking by the heading's law
  // alone (juft first) puts the right one off both lists.
  rowIds.hjkKg = await add(HJK, 'kg', 6, NAME_J);
  await db.execute(sql`
    INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
    SELECT ${batchId}::uuid, ${HJ} || '99' || lpad(g::text, 4, '0'),
           'Обувь прочая партия ' || g, 'обувь прочая партия ' || g,
           'juft', (2 + g % 5)::numeric, '156-КИТАЙ'
      FROM generate_series(1, 120) g`);
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
  candidates: {
    id: string;
    tnvedCode: string;
    unit: string;
    pickable: boolean;
    unitMatches: boolean;
    lawUnit: string | null;
  }[];
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

  it('(b2) a full code the file cannot fill is scanned ONCE, not on every save (review perf-4)', async () => {
    // A pass saves up to four times and a VED presses «Saqlash» again and
    // again; a ready batch's rows never change, so the same row of the same
    // batch has the same answer — asked once, remembered across saves.
    const stranger = `Zzqx yorliq qog‘ozi ${SUFFIX}`;
    spy.calls.length = 0;
    const id = await open([{ name: stranger, tnvedCode: TK, weightKg: 40 }]);
    expect(spy.calls.filter((c) => c.name === stranger).length).toBeGreaterThan(0);
    expect((await rowsOf(id))[0]!.bazaUsd, 'nothing in the file is called that').toBeNull();
    spy.calls.length = 0;
    await saveTable(id, { items: [], adds: [] }, ctx());
    await saveTable(id, { items: [], adds: [] }, ctx());
    expect(spy.calls.filter((c) => c.name === stranger)).toHaveLength(0);
  });

  /** A ready file of its OWN holding one declaration of `code` named
   * `name` — the chooser's only answer for that code. */
  async function ownFile(code: string, name: string): Promise<{ batch: string; row: string }> {
    const [batch] = await db.execute<{ id: string }>(sql`
      INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to)
      VALUES (${`heading-own-${code}.xlsx`}, ${actorId}::uuid, 'ready', ${onDate()}::date, ${onDate()}::date)
      RETURNING id::text AS id`);
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
      VALUES (${batch!.id}::uuid, ${code}, ${name}, ${normalizeName(name)}, 'kg', 5::numeric, '156-КИТАЙ')
      RETURNING id::text AS id`);
    return { batch: batch!.id, row: row!.id };
  }

  it('(b3) a file deleted between the fill’s read and the write costs that fill, never the save (review concurrency-10)', async () => {
    const code = `${H}770000`;
    const name = `Charm kalish ${SUFFIX}`;
    const own = await ownFile(code, name);
    try {
      const id = await open([{ name: `Boshqa narsa ${SUFFIX}`, tnvedCode: code, weightKg: 10 }]);
      const [row] = await rowsOf(id);
      expect(row!.bazaUsd).toBeNull();
      // The rename makes the save ask the file again — and the admin deletes
      // it right after the read answered, before the transaction opens.
      spy.afterRead = () => deleteImportBatch(own.batch);
      const out = await saveTable(id, { items: [{ id: row!.id, seq: row!.seq, name }], adds: [] }, ctx());
      expect(spy.afterRead, 'the hook never ran — the save did not read the file').toBeUndefined();
      expect(out.importFilled).toEqual([]);
      const [after] = await rowsOf(id);
      expect(after).toMatchObject({ name, bazaUsd: null, importRowId: null });
    } finally {
      spy.afterRead = undefined;
      await db.delete(customsImportBatches).where(eq(customsImportBatches.id, own.batch));
    }
  });

  it('(b4) a person’s pick whose file was deleted before the write is refused by its row, never a raw 23503', async () => {
    const code = `${H}880000`;
    const name = `Charm tapochka ${SUFFIX}`;
    const own = await ownFile(code, name);
    try {
      const id = await open([{ name: `Yana boshqa ${SUFFIX}`, tnvedCode: code, weightKg: 10 }]);
      const [row] = await rowsOf(id);
      spy.afterRead = () => deleteImportBatch(own.batch);
      const refused = await saveTable(
        id,
        { items: [{ id: row!.id, seq: row!.seq, bazaUsd: 5, bazaBasis: 'kg', importRowId: own.row }], adds: [] },
        ctx(),
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refused).toBeInstanceOf(CalcError);
      expect(refused).toMatchObject({ code: 'import_row_missing', seq: row!.seq });
      expect((await rowsOf(id))[0]!.bazaUsd).toBeNull();
    } finally {
      spy.afterRead = undefined;
      await db.delete(customsImportBatches).where(eq(customsImportBatches.id, own.batch));
    }
  });

  it('(b) the model-free auto-fill never fills a heading row', async () => {
    // The name is the declarations' own — a full code would auto-fill at 1.0.
    const id = await open([{ name: NAME, tnvedCode: H, weightKg: 40 }]);
    const out = await saveTable(id, { items: [], adds: [] }, ctx());
    expect(out.importFilled).toEqual([]);
    expect((await rowsOf(id))[0]!.bazaUsd).toBeNull();
  });
});

describe('a heading whose own law pins a unit ranks every candidate by ITS law (review P2-1)', () => {
  it('the 📥 list carries the exact-name kg declaration of an advalor subheading — first, and pickable', async () => {
    const id = await open([{ name: NAME_J, tnvedCode: HJ, weightKg: 40 }]);
    const [row] = await rowsOf(id);
    const answer = await list(row!.id);
    expect(answer.state).toBe('ok');
    const kg = answer.candidates.find((c) => c.id === rowIds.hjkKg);
    expect(kg, 'ranked by the heading’s juft law, the kg declaration fell off the list').toBeDefined();
    expect(kg).toMatchObject({ tnvedCode: HJK, lawUnit: null, unitMatches: true, pickable: true });
    expect(answer.candidates[0]!.id).toBe(rowIds.hjkKg);
    // A per-pair declaration under the heading's own law is listed as what it
    // is: its law counts in juft, so juft is the unit it matches.
    expect(answer.candidates.find((c) => c.unit === 'juft')).toMatchObject({ lawUnit: 'juft', unitMatches: true });
  });

  it('the AI pick is offered it, marked as fitting, and recodes the row to the subheading', async () => {
    const id = await open([{ name: NAME_J, tnvedCode: HJ, weightKg: 40 }]);
    let offered: PickRequest['candidates'][number] | undefined;
    const out = await pickBazas(
      id,
      ctx(),
      async (rows) => {
        offered = rows[0]!.candidates.find((c) => c.id === rowIds.hjkKg);
        return choose((c) => c.id === rowIds.hjkKg)(rows);
      },
      null,
    );
    expect(offered, 'the pick’s ten never held the kg declaration').toBeDefined();
    expect(offered!.unitMatches).toBe(true);
    expect(out.picked).toBe(1);
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({ tnvedCode: HJK, bazaUsd: '6.0000', bazaBasis: 'kg', bazaSource: 'import' });
    expect(row!.bazaReason).toContain(`${HJ} → ${HJK}`);
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
    // …and the model was TOLD so before it answered (review P2-1): the
    // «единица не совпадает» it reads is the refusal's own judgement.
    let shown: boolean | undefined;
    const out = await pickBazas(
      id,
      ctx(),
      async (rows) => {
        shown = rows[0]!.candidates.find((c) => c.id === rowIds.tjKg)?.unitMatches;
        return choose((c) => c.tnvedCode === TJ && c.unit === 'kg')(rows);
      },
      null,
    );
    expect(shown).toBe(false);
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
    expect(kg).toMatchObject({ pickable: true, lawUnit: null, unitMatches: true });
    // Per kg under a juft law: a PERSON may choose the unit (pickable), the
    // machine may not — the row states kilograms and the law counts pairs
    // (review P2-8: the per-candidate `unitMatches`, not the heading's).
    const tjKg = answer.candidates.find((c) => c.id === rowIds.tjKg)!;
    expect(tjKg).toMatchObject({ lawUnit: 'juft', unitMatches: false });
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

  it('(g2) a heading over its ceiling is not read again for another NAME (review perf-2)', async () => {
    // The heading read scores every row of the range whatever the name, so
    // one timeout makes every later read of that heading a certain one —
    // three names under one heading were three full ceilings.
    const names = ['Charm botinka', 'Charm etik', 'Charm shippak'].map((n) => `${n} ${SUFFIX}`);
    const id = await open(names.map((name) => ({ name, tnvedCode: H, weightKg: 12 })));
    spy.calls.length = 0;
    spy.ceilingMs = 1;
    let asked = false;
    try {
      const out = await pickBazas(
        id,
        ctx(),
        async () => {
          asked = true;
          return { answers: null, usage: null };
        },
        null,
      );
      expect(out.timedOut).toBe(3);
    } finally {
      spy.ceilingMs = undefined;
    }
    expect(spy.calls.filter((c) => c.code === H)).toHaveLength(1);
    expect(asked, 'nothing was read, so nothing goes to the model').toBe(false);
  });

  it('(g3) past the pass deadline the pick issues no candidate read at all (review perf-2)', async () => {
    const id = await open([{ name: `Charm sandal ${SUFFIX}`, tnvedCode: H, weightKg: 12 }]);
    spy.calls.length = 0;
    let asked = false;
    const out = await pickBazas(
      id,
      ctx(),
      async () => {
        asked = true;
        return { answers: null, usage: null };
      },
      null,
      { deadline: Date.now() - 1 },
    );
    expect(out.pastDeadline).toBe(1);
    expect(out.picked).toBe(0);
    expect(spy.calls).toHaveLength(0);
    expect(asked).toBe(false);
  });

  it('(c4) the recode mark follows the CODE: a person re-pricing keeps ai_recode for the ✅, recoding takes it off', async () => {
    // Review P2-LAW-2. The mark rides in the price's column; a retype, a
    // clear or a 📖 pull used to null it with the price, so the warning
    // vanished with no ✅ while the model's code stayed.
    const id = await open([{ name: NAME, tnvedCode: H, weightKg: 40 }]);
    await pickBazas(id, ctx(), choose((c) => c.tnvedCode === TK && c.unit === 'kg'), null);
    const [row] = await rowsOf(id);
    const mark = `${AI_RECODE_PREFIX}${H} → ${TK}`;

    await saveTable(id, { items: [{ id: row!.id, seq: row!.seq, bazaUsd: 9.5, bazaBasis: 'kg' }], adds: [] }, ctx());
    const [repriced] = await rowsOf(id);
    expect(repriced).toMatchObject({ tnvedCode: TK, bazaUsd: '9.5000', bazaSource: 'typed', bazaReason: mark });
    expect((await loadWorkspace(id))!.groups[0]!.warnings).toContain('ai_recode');
    await confirmAllGroups(id, ctx());
    const [confirmed] = await db.select().from(calcGroups).where(eq(calcGroups.requestId, id));
    expect(confirmed!.confirmedWarnings).toContain('ai_recode');

    // A clear keeps it too — the model's code is still the row's.
    await saveTable(id, { items: [{ id: row!.id, seq: row!.seq, bazaUsd: null, bazaBasis: null }], adds: [] }, ctx());
    expect((await rowsOf(id))[0]!.bazaReason).toBe(mark);

    // A PERSON recoding the row takes it off: the code is theirs now.
    await saveTable(id, { items: [{ id: row!.id, seq: row!.seq, tnvedCode: TJ }], adds: [] }, ctx());
    const [recoded] = await rowsOf(id);
    expect(recoded!.tnvedCode).toBe(TJ);
    expect(recoded!.bazaReason).toBeNull();
    expect((await loadWorkspace(id))!.groups.flatMap((g) => g.warnings)).not.toContain('ai_recode');
  });

  // LAST in the file on purpose: the seal TEACHES the memory, and every later
  // job named like this one would then be priced by it before the pick asks.
  it('(c3) E1 counts a sealed group minted by a recode as the AI’s — after a person re-priced it, too', async () => {
    expect(recodedRequest).not.toBe('');
    // A person's price over the model's code (review P2-LAW-2): the group is
    // still the AI's, because the CODE is.
    const [row] = await rowsOf(recodedRequest);
    await saveTable(
      recodedRequest,
      { items: [{ id: row!.id, seq: row!.seq, bazaUsd: 8.5, bazaBasis: 'kg' }], adds: [] },
      ctx(),
    );
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
