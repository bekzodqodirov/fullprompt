import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
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
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { runCustomsImport } from '@/modules/wms/customs/import-service';
import { CalcError, openCalcRequest, returnCalcRequest } from '@/modules/wms/calc/service';
import { pickBazas } from '@/modules/wms/calc/prefill-steps';
import {
  applyProposal,
  confirmGroup,
  loadWorkspace,
  priceProposedGroups,
  proposeGroups,
  saveTable,
} from '@/modules/wms/calc/workspace';
import { aiPrefill, prefillStanding, prefillTicket } from '@/modules/wms/calc/prefill';

/**
 * The AI VED hodimi, end to end, with the MODEL INJECTED.
 *
 * This container has no key and no Telegram, so the two places the model
 * speaks are function arguments: `propose` (the grouping) and `pick` (which
 * declaration prices a row). Everything between them is the real machinery —
 * `proposeGroups`'s pricing tail, `saveTable`'s sweep, 0094's import fill and
 * the engine — so what these tests measure is the SYSTEM, not a mock of it.
 *
 * CONFIGURATION WARNING (#183): a READY import fills the baza of every coded
 * row with an empty one, in every later save. The batch is deleted in
 * `afterAll`; `fileParallelism: false` means nothing else runs meanwhile.
 */
const SUFFIX = String(Date.now()).slice(-6);
let actorId = '';
let clientId = '';
let dealId = '';
let batchId = '';
const madeRequests: string[] = [];
const madeKeys: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99893${String(Date.now()).slice(-7)}`,
      fullName: `Prefill fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `PF${SUFFIX}`, name: `Prefill fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `PF-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'Prefill fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;

  // A real quarter, parsed by the real parser.
  const bytes = readFileSync('tests/fixtures/customs-import-sample.xlsx');
  const key = `customs-import/prefill-${randomUUID()}.xlsx`;
  await getStorage().put(
    key,
    bytes,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  madeKeys.push(key);
  const [batch] = await db
    .insert(customsImportBatches)
    .values({ fileName: 'prefill.xlsx', uploadedBy: actorId, status: 'processing' })
    .returning({ id: customsImportBatches.id });
  batchId = batch!.id;
  await runCustomsImport({ batchId, storageKey: key, fileName: 'prefill.xlsx' });
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
    const ids = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (ids.length > 0) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(tasks).where(inArray(tasks.id, ids));
    }
  }
  if (batchId) await db.delete(customsImportBatches).where(eq(customsImportBatches.id, batchId));
  for (const k of madeKeys) await getStorage().delete(k).catch(() => {});
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(
  items: { name: string; tnvedCode?: string | null; quantity?: number | null; weightKg?: number | null }[],
  as: { actorId: string } = ctx(),
) {
  const r = await openCalcRequest(
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
    as,
  );
  madeRequests.push(r.id);
  return r.id;
}

async function openSection(
  section: 'yolkira' | 'rastamojka' | 'podklyuch',
  items: { name: string; tnvedCode?: string | null; quantity?: number | null; weightKg?: number | null }[],
  extra: { freightZone?: string | null; fromCity?: string | null } = {},
) {
  const r = await openCalcRequest(
    {
      ...extra,
      entityType: 'deal',
      entityId: dealId,
      section,
      fromCity: extra.fromCity === undefined ? 'Yiwu' : extra.fromCity,
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items,
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(r.id);
  return r.id;
}

const importRow = async () => {
  const rows = await db
    .select()
    .from(customsImportRows)
    .where(eq(customsImportRows.batchId, batchId))
    .orderBy(customsImportRows.id);
  return rows.find((r) => r.unit === 'kg')!;
};

/**
 * A grouping that wrote nothing: the revision chain comes back as it went in
 * (review P1-R2 — the pass carries the chain, it no longer re-reads it).
 */
const idle = async (_requestId: string, _c: unknown, opts: { expectRev?: number } = {}) => ({
  groups: 0,
  batches: 0,
  failed: 0,
  ratesPulled: 0,
  codesStamped: 0,
  importFilled: 0,
  memoryFilled: 0,
  dictionaryFilled: 0,
  rev: opts.expectRev ?? null,
});

/** The model's grouping, scripted: it names ONE code for every item — and,
 * like the real one, carries the pass's revision chain through its writes. */
const proposeAs = (code: string) => async (requestId: string, c: { actorId: string | null }, opts: { expectRev?: number } = {}) => {
  const items = await db
    .select({ seq: calcRequestItems.seq })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId));
  const applied = await applyProposal(
    requestId,
    [
      {
        label: 'AI guruh',
        tnvedCode: code,
        itemSeqs: items.map((i) => i.seq),
        aiProposed: true,
        confidence: 'high',
        aiDutyPct: null,
        note: null,
      },
    ],
    c,
    opts,
  );
  const { priceProposedGroups } = await import('@/modules/wms/calc/workspace');
  const priced = await priceProposedGroups(requestId, c, opts.expectRev === undefined ? {} : { expectRev: applied.rev });
  return { groups: 1, batches: 1, failed: 0, ...priced };
};

describe('the machine carries a job as far as it honestly can', () => {
  it('codes from the model, rates from the book, baza from the file', async () => {
    const row = await importRow();
    const id = await open([{ name: row.name, weightKg: 100 }]);

    const out = await aiPrefill(id, ctx(), {
      propose: proposeAs(row.tnvedCode),
      pick: async () => ({ answers: [], usage: null }),
      configured: true,
    });

    const ws = await loadWorkspace(id);
    const g = ws!.groups[0]!;
    expect(g.tnvedCode).toBe(row.tnvedCode);
    // The MODEL's provenance survives, so `ai_low_confidence` and the ✅'s
    // record still have something to say.
    expect(g.aiProposed).toBe(true);
    // …and the price came from the file, not from the model.
    const [item] = await db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, id));
    expect(item!.bazaSource).toBe('import');
    expect(Number(item!.bazaUsd)).toBe(Number(row.pricePerUnitUsd));
    expect(out.aiUsed).toBe(true);
    // The reply is the AI-VED's per-line breakdown now (sub-round C): the
    // heading, the line's own figure and the caveat that travels with it.
    expect(out.text).toContain('🤖 AI-VED · taxminiy rastamojka');
    expect(out.text).toContain('📥');
    expect(out.text).toContain('Rastamojka jami');
    expect(out.text).toContain('Rasmiy emas');
  });

  it('a podklyuch job prices the road at the tariff LIST price and sums a JAMI (item 13)', async () => {
    const row = await importRow();
    const id = await openSection('podklyuch', [{ name: row.name, weightKg: 100 }], {
      freightZone: 'cn',
    });
    // The zone the seller pressed is on the row from the INSERT — the pass
    // is queued by the landing and must not race a later UPDATE.
    const [req] = await db.select().from(calcRequests).where(eq(calcRequests.id, id));
    expect(req!.freightZone).toBe('cn');

    const out = await aiPrefill(id, ctx(), {
      propose: proposeAs(row.tnvedCode),
      pick: async () => ({ answers: [], usage: null }),
      configured: true,
    });
    const ws = await loadWorkspace(id);
    expect(ws!.freight?.ok).toBe(true);
    const list = ws!.freight!.ok ? ws!.freight!.listUsd : NaN;
    expect(out.text).toContain('taxminiy podklyuch (rastamojka + yo‘lkira)');
    expect(out.text).toContain(`Yo‘lkira (Xitoy → O‘zbekiston, 50 kg/m³ · `);
    expect(out.text).toContain(`× 10 m³): ≈ $${list.toFixed(2)}`);
    // The list price, never a discount — and the sum of the two halves.
    expect(out.freightUsd).toBe(list);
    expect(out.customsUsd).not.toBeNull();
    expect(out.text).toContain(
      `JAMI (rastamojka + yo‘lkira): ≈ $${(out.customsUsd! + list).toFixed(2)}`,
    );
  });

  // Re-anchored (docs/SAKKIZ-R2.md §6.9): «no zone» alone no longer refuses —
  // his 2.5 b has the city guess it (customs-estimate's (6) is that case).
  // The refusal stands where nothing CAN be guessed: no zone AND no city, and
  // it is the SELLER's to fix — he asks the customer where the cargo leaves.
  it('a podklyuch job with no zone and no city refuses the road in words, and sums nothing', async () => {
    const row = await importRow();
    const id = await openSection('podklyuch', [{ name: row.name, weightKg: 100 }], {
      // A zone the tariff does not have is dropped, never stored.
      freightZone: 'mars',
      fromCity: null,
    });
    const [req] = await db.select().from(calcRequests).where(eq(calcRequests.id, id));
    expect(req!.freightZone).toBeNull();
    const out = await aiPrefill(id, ctx(), {
      propose: proposeAs(row.tnvedCode),
      pick: async () => ({ answers: [], usage: null }),
      configured: true,
    });
    expect(out.text).toContain(
      'Yo‘lkira: ⚠️ yo‘nalish (zona) tanlanmagan — qaysi shahardan yozilmagan — mijozdan so‘rab, kartadagi lentaga yozing',
    );
    expect(out.text).toContain('JAMI: hozircha hisoblab bo‘lmadi');
    expect(out.text).not.toContain('$0.00');
  });

  it('the request STAYS in the queue — nothing is confirmed or sealed', async () => {
    const row = await importRow();
    const id = await open([{ name: row.name, weightKg: 100 }]);
    await aiPrefill(id, ctx(), { propose: proposeAs(row.tnvedCode), pick: async () => ({ answers: [], usage: null }), configured: true });

    const ws = await loadWorkspace(id);
    expect(ws!.groups.every((g) => g.confirmedAt === null)).toBe(true);
    expect(ws!.sealedVersion).toBeNull();
    // The unconfirmed groups are themselves a seal blocker: a machine can
    // never close this loop on its own.
    expect(ws!.blockers.some((b) => b.kind === 'groups_unconfirmed')).toBe(true);
  });

  it('with NO model it still sweeps and prices what the memory already coded', async () => {
    const row = await importRow();
    // The intake prefills codes from the TNVED memory: the commonest request
    // arrives already coded, and that half needs no key at all.
    const id = await open([{ name: row.name, tnvedCode: row.tnvedCode, weightKg: 100 }]);

    const out = await aiPrefill(id, ctx(), { configured: false });
    expect(out.aiUsed).toBe(false);
    expect(out.text).toContain('sozlanmagan');

    const ws = await loadWorkspace(id);
    expect(ws!.groups).toHaveLength(1);
    expect(ws!.groups[0]!.dutyPct).not.toBeNull();
    const [item] = await db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, id));
    expect(item!.bazaSource).toBe('import');
  });

  it('the model picks a ROW; the NUMBER is the file’s', async () => {
    const rows = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    // A name nothing in the file matches, so the auto-fill leaves it empty
    // and the pick is the only thing that can answer it.
    const kg = rows.find((r) => r.unit === 'kg')!;
    const id = await open([{ name: 'Qandaydir boshqa nom', tnvedCode: kg.tnvedCode, weightKg: 100 }]);

    let offered = 0;
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: idle,
      pick: async (asking) => {
        offered = asking.length;
        // The model answers with an INDEX, never a price.
        return { answers: asking.map((a) => ({ seq: a.seq, candidate: 0, reason: 'shu tovar' })), usage: null };
      },
    });

    expect(offered).toBe(1);
    expect(out.picked).toBe(1);
    const [item] = await db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, id));
    expect(item!.bazaSource).toBe('import');
    expect(item!.importRowId).not.toBeNull();
  });

  it('a per-kg declaration may not price a per-dona row', async () => {
    // The candidate list is built by TNVED CODE and deliberately INCLUDES
    // unit mismatches, labelled — a matching unit merely sorts first. So a
    // model that answers with the wrong index is a real event, and the
    // number it would write is off by the weight of the goods.
    const row = await importRow();
    // Quantity and NO weight, so the row is asked about per-DONA while
    // every declaration under this code is per-KG.
    const id = await open([{ name: row.name, tnvedCode: row.tnvedCode, quantity: 10 }]);

    let asked: { unit: string; unitMatches: boolean }[] = [];
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: proposeAs(row.tnvedCode),
      pick: async (rows) => {
        asked = rows[0]?.candidates ?? [];
        return { answers: rows.map((a) => ({ seq: a.seq, candidate: 0, reason: 'shu' })), usage: null };
      },
    });

    // The fixture states its own premise: if these ever match, the test is
    // not reaching the fence and must be rewritten, not believed (#166).
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => c.unit === 'kg' && !c.unitMatches)).toBe(true);

    expect(out.picked).toBe(0);
    const [item] = await db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, id));
    expect(item!.bazaUsd).toBeNull();
    expect(out.text).not.toContain('$0');
  });

  it('«none of these» leaves the baza EMPTY for the VED', async () => {
    const kg = await importRow();
    const id = await open([{ name: 'Yana boshqa nom', tnvedCode: kg.tnvedCode, weightKg: 100 }]);
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: idle,
      pick: async (asking) => ({
        answers: asking.map((a) => ({ seq: a.seq, candidate: null, reason: 'mos emas' })),
        usage: null,
      }),
    });
    expect(out.picked).toBe(0);
    const [item] = await db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, id));
    expect(item!.bazaUsd).toBeNull();
    // …and the reply says so rather than printing a zero (law 6).
    expect(out.text).not.toContain('$0');
    expect(out.text).toContain('baza yo‘q');
  });

  it('the machine stands down once a person has been here', async () => {
    // The pass moved to pg-boss so a deploy could not lose it — and pg-boss
    // drains when it drains and re-delivers up to five times. `applyProposal`
    // DELETES every group and re-inserts, and the import fill clears the ✅ of
    // every group it touches, so a late job could destroy an evening of the
    // VED's typing. The rev the job was queued at is what says «somebody has
    // been here since».
    const row = await importRow();
    const id = await open([{ name: row.name, weightKg: 100 }]);
    const rev = await prefillTicket(id);
    expect(rev).not.toBeNull();
    expect(await prefillStanding(id, rev)).toBe('ok');

    // Any ordinary save moves the clock — which is exactly a person working.
    await saveTable(id, { items: [], adds: [] }, ctx());
    expect(await prefillStanding(id, rev)).toBe('touched');

    // A confirmed group says it louder, whatever the clock reads.
    const fresh = await open([{ name: row.name, tnvedCode: row.tnvedCode, quantity: 2 }]);
    await saveTable(fresh, { items: [], adds: [] }, ctx());
    const [group] = await db
      .select({ id: calcGroups.id })
      .from(calcGroups)
      .where(eq(calcGroups.requestId, fresh));
    // Through the real door: a hand-written confirm invents a `confirm_via`
    // the 0089 CHECK refuses, and a fixture that cannot reach the state is
    // evidence about the fixture (#166).
    await confirmGroup(group!.id, ctx());
    expect(await prefillStanding(fresh, await prefillTicket(fresh))).toBe('confirmed');
  });

  it('a save landing AFTER the job was checked is never grouped over — the chain starts at the checked revision', async () => {
    // The review's P1-R2. The worker checks the job's revision
    // (`prefillStanding`) and the pass used to start its chain from a FRESH
    // read — so a person's save in the gap became the machine's own base,
    // `applyProposal` (whose claim tests no revision) deleted and re-made the
    // groups under it, and the sweep and the pick then compared against a
    // revision that already held the lost write.
    const id = await open([{ name: `nomsiz tovar ${Date.now()}` }]);
    const checked = await prefillTicket(id);
    expect(checked).not.toBeNull();
    // A person saves between the worker's check and the pass's first write.
    await saveTable(id, { items: [], adds: [] }, ctx());
    const afterPerson = await prefillTicket(id);
    expect(afterPerson, 'the premise: the save moved the clock').not.toBe(checked);

    let proposed = 0;
    const out = await aiPrefill(
      id,
      ctx(),
      {
        configured: true,
        propose: async (requestId, c, o) => {
          proposed += 1;
          return idle(requestId, c, o);
        },
        pick: async () => ({ answers: null, usage: null }),
      },
      { expectRev: checked },
    );
    expect(proposed, 'the grouping must not run over a person’s save').toBe(0);
    expect(await prefillTicket(id), 'and the machine wrote nothing after it').toBe(afterPerson);
    // Re-anchored (R2 late pass, review CONC-5): the pass used to answer
    // anyway — the reply rendered from the VED's half-typed state under the
    // AI's heading — while a save one moment EARLIER got the worker's
    // stand-down sentence. Overtaken before any machine write, it now stands
    // down the same way, and says at which step.
    expect(out.stood).toBe('touched');
    expect(out.overtaken).toBe('step 1');
    expect(out.text).toBe('');
  });

  it('a freight-only job is left ALONE — no groups, no model call, no $0', async () => {
    // The pass never asked what section the job was. On a yolkira request —
    // the freight-only one, and the FIRST the bot offers — it ran the whole
    // customs half anyway: `applyProposal` COMMITTED customs groups onto a
    // quote that has no customs, and `blockersFor` then raised
    // `customs_on_yolkira`, a blocker no screen can clear because nothing
    // offers to delete those groups. The machine could make a freight quote
    // permanently unsealable, and bill an Opus call for doing it.
    const row = await importRow();
    const id = await openSection('yolkira', [{ name: row.name, weightKg: 100 }]);

    let asked = 0;
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: async () => {
        asked += 1;
        throw new Error('the model must not be asked about a freight quote');
      },
      pick: async () => {
        asked += 1;
        return { answers: null, usage: null };
      },
    });

    expect(asked, 'no model call belongs on a freight-only job').toBe(0);
    const ws = await loadWorkspace(id);
    expect(ws!.groups, 'no customs group may be minted here').toHaveLength(0);
    expect(ws!.blockers.some((b) => b.kind === 'customs_on_yolkira')).toBe(false);
    // …and the reply says nothing about customs, least of all a zero.
    expect(out.text).not.toContain('rastamojka');
    expect(out.text).not.toContain('$0.00');
  });

  it('a baza the VED types WHILE the model thinks is left alone', async () => {
    // The rows are read before a model call that can take a minute, and a VED
    // opening the request meanwhile is not a race — it is how this queue is
    // worked. The deterministic auto-fill has re-checked «still empty» since
    // 0094; the pick did not, because it writes through `saveTable`'s
    // ORDINARY edit branch, which is right for a person and wrong for a
    // machine answering a question it asked a minute ago. So the VED's number
    // was replaced and `baza_source` flipped to 'import' — their figure gone,
    // and the chip claiming the file had supplied it.
    const rows = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    const kg = rows.find((r) => r.unit === 'kg')!;
    const id = await open([{ name: 'Boshqa nom butunlay', tnvedCode: kg.tnvedCode, weightKg: 100 }]);

    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: idle,
      pick: async (asking) => {
        // THE VED TYPES, right here — inside the model's own window.
        const [item] = await db
          .select({ id: calcRequestItems.id, seq: calcRequestItems.seq })
          .from(calcRequestItems)
          .where(eq(calcRequestItems.requestId, id));
        await saveTable(
          id,
          {
            items: [{ id: item!.id, seq: item!.seq, bazaUsd: 7.77, bazaBasis: 'kg' }],
            adds: [],
          },
          ctx(),
        );
        return { answers: asking.map((a) => ({ seq: a.seq, candidate: 0, reason: 'shu' })), usage: null };
      },
    });

    expect(out.picked, 'the machine must not have written').toBe(0);
    const [item] = await db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, id));
    expect(Number(item!.bazaUsd), 'the VED’s own number stands').toBe(7.77);
    expect(item!.bazaSource, 'and it is still THEIR number, not the file’s').toBe('typed');
    expect(item!.importRowId).toBeNull();
  });

  it('a customs job with NOTHING classified refuses in words, never «~$0.00»', async () => {
    // The section gate is not enough on its own: a rastamojka job that
    // produced no groups must not read as «priced, at zero». That is the
    // ORDINARY way this ships — no key, or a model that refused, and nothing
    // the TNVED memory already knew.
    //
    // The round's two existing `$0` assertions do NOT cover it: their
    // fixtures have a group that EXISTS and REFUSES, so `allOk` is false and
    // `customsUsd` is already null. The uncovered branch is the EMPTY list —
    // a test passing on the neighbouring case is not evidence about this one
    // (#166).
    //
    // The engine used to answer 0 here, because `[].every(ok)` is vacuously
    // TRUE; audit A17 moved the refusal INTO `requestCustomsFor`, so the
    // screen, the seal gate and this reply now refuse in one place. This
    // assertion follows the engine — the premise it states is the point.
    const id = await open([{ name: `nomsiz mol ${Date.now()}` }]);
    const out = await aiPrefill(id, ctx(), { configured: false });

    const ws = await loadWorkspace(id);
    expect(ws!.groups, 'the premise: nothing is classified').toHaveLength(0);
    expect(ws!.customsUsd, 'and the engine refuses rather than printing 0').toBeNull();

    expect(out.customsUsd, 'the pass must read it as «nothing priced»').toBeNull();
    expect(out.text).not.toContain('$0');
    expect(out.text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
    // …and the row is NAMED rather than counted, so the seller can supply
    // what is missing without opening the card.
    expect(out.text).toContain('Kod topilmadi');
  });

  it('a model that fails costs a sentence, never the job', async () => {
    const kg = await importRow();
    const id = await open([{ name: kg.name, tnvedCode: kg.tnvedCode, weightKg: 100 }]);
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: async () => {
        throw new Error('model down');
      },
      pick: async () => ({ answers: null, usage: null }),
    });
    // The sweep still ran: the memory's code found its group and the file
    // answered its baza.
    const ws = await loadWorkspace(id);
    expect(ws!.groups).toHaveLength(1);
    expect(out.text).toContain('🤖 AI-VED · taxminiy rastamojka');
    expect(out.text).toContain('Rastamojka jami');
  });
});

/**
 * R2 late pass — the pass stands down when a person or a close says so.
 *
 * Every case here drives the REAL machinery under an injected model, and
 * each states its premise first: a stand-down that never had anything to
 * stand down from is evidence about the fixture (#166).
 */
describe('the pass stands down when a person or a close says so (R2 late pass)', () => {
  // Its own requester: the file already holds this many open requests for
  // `actorId`, and the door caps one person at MAX_OPEN_PER_REQUESTER.
  let lateActorId = '';
  beforeAll(async () => {
    const [late] = await db
      .insert(users)
      .values({ phone: `+99894${String(Date.now()).slice(-7)}`, fullName: `Prefill late ${SUFFIX}`, passwordHash: 'x' })
      .returning();
    lateActorId = late!.id;
  });
  afterAll(async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, lateActorId));
  });
  const openLate = (items: Parameters<typeof open>[0]) => open(items, { actorId: lateActorId });
  /** The hand-back's own seller task, which the door opens — swept so no
   * later file reads a stranger's to-do (#154). */
  const sweepHandBacks = async () => {
    const made = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.entityId, dealId), like(tasks.title, '↩️%')));
    const ids = made.map((t) => t.id);
    if (ids.length > 0) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(tasks).where(inArray(tasks.id, ids));
    }
  };
  // Handed back by the requester himself, so the door's «qaytarildi» ping
  // excludes him and nothing wakes the drain in the test process.
  const handBack = (id: string) => returnCalcRequest(id, 'VED qaytardi — test', { actorId: lateActorId });

  it('a request the VED closes while the grouping runs gets no reply, no sweep and no pick (review CONC-1)', async () => {
    const row = await importRow();
    const id = await openLate([{ name: row.name, weightKg: 100 }]);
    let picks = 0;
    try {
      const out = await aiPrefill(id, ctx(), {
        configured: true,
        propose: async () => {
          // «Готово» or a hand-back lands while the model is thinking; the
          // grouping's own next write is then refused the way the door refuses.
          await handBack(id);
          throw new CalcError('already_closed');
        },
        pick: async () => {
          picks += 1;
          return { answers: null, usage: null };
        },
      });
      expect(out.stood).toBe('closed');
      expect(out.text).toBe('');
      expect(out.lentaText).toBe('');
      expect(picks, 'no paid model call on a closed request').toBe(0);
      const ws = await loadWorkspace(id);
      expect(ws!.groups, 'the sweep wrote nothing after the close').toHaveLength(0);
    } finally {
      await sweepHandBacks();
    }
  });

  it('a request closed before the grouping is asked makes no model call at all (review CONC-1)', async () => {
    const row = await importRow();
    const id = await openLate([{ name: row.name, weightKg: 100 }]);
    // Closed in the gap after the worker's own check — the clock is asked
    // before every model step, so nothing is billed for a closed request.
    await handBack(id);
    let calls = 0;
    try {
      const out = await aiPrefill(id, ctx(), {
        configured: true,
        propose: async (requestId, c, o) => {
          calls += 1;
          return idle(requestId, c, o);
        },
        pick: async () => {
          calls += 1;
          return { answers: null, usage: null };
        },
      });
      expect(calls).toBe(0);
      expect(out.stood).toBe('closed');
    } finally {
      await sweepHandBacks();
    }
  });

  it('…and a close landing inside the pick’s own call stands the reply down too', async () => {
    const kg = await importRow();
    const id = await openLate([{ name: 'Yopilgan nom butunlay', tnvedCode: kg.tnvedCode, weightKg: 100 }]);
    try {
      const out = await aiPrefill(id, ctx(), {
        configured: true,
        propose: idle,
        pick: async (asking) => {
          expect(asking.length, 'the premise: the pick is reached').toBeGreaterThan(0);
          await handBack(id);
          return { answers: asking.map((a) => ({ seq: a.seq, candidate: 0, reason: 'shu' })), usage: null };
        },
      });
      expect(out.stood).toBe('closed');
      expect(out.text).toBe('');
      const [item] = await db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, id));
      expect(item!.bazaUsd, 'the pick’s save was refused').toBeNull();
    } finally {
      await sweepHandBacks();
    }
  });

  it('the grouping’s CLAIM carries the revision: a stale one is `conflict`, writes nothing and leaves no claim (review P1-R2)', async () => {
    const row = await importRow();
    // Fully coded: `proposeGroups` makes no model call, so the real door runs here.
    const id = await openLate([{ name: row.name, tnvedCode: row.tnvedCode, weightKg: 100 }]);
    const stale = (await prefillTicket(id))!;
    await saveTable(id, { items: [], adds: [] }, ctx());
    const afterPerson = await prefillTicket(id);
    expect(afterPerson, 'the premise: the person’s save moved the clock').not.toBe(stale);

    await expect(proposeGroups(id, ctx(), { expectRev: stale })).rejects.toMatchObject({ code: 'conflict' });
    expect(await prefillTicket(id)).toBe(afterPerson);
    const [req] = await db.select().from(calcRequests).where(eq(calcRequests.id, id));
    expect(req!.aiProposalStartedAt, 'a refused claim holds nothing').toBeNull();

    // The control: at the revision it stands at, the door runs and hands the
    // chain back — the revision its own last write left.
    const out = await proposeGroups(id, ctx(), { expectRev: afterPerson! });
    expect(out.rev).toBe(await prefillTicket(id));
  });

  it('…and its pricing tail compares at every write: a person’s save after the claim is released is `conflict`', async () => {
    const row = await importRow();
    const id = await openLate([{ name: row.name, weightKg: 100 }]);
    const start = (await prefillTicket(id))!;
    const items = await db
      .select({ seq: calcRequestItems.seq })
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, id));
    // The proposal lands under the chain — the group carries a code and no rates.
    const applied = await applyProposal(
      id,
      [
        {
          label: 'AI guruh',
          tnvedCode: row.tnvedCode,
          itemSeqs: items.map((i) => i.seq),
          aiProposed: true,
          confidence: 'high',
          aiDutyPct: null,
          note: null,
        },
      ],
      ctx(),
      { expectRev: start },
    );
    expect(applied.rev).toBe(start + 1);
    // A PERSON saves in the unclaimed seconds between the release and the tail.
    await saveTable(id, { items: [], adds: [] }, ctx());
    const afterPerson = await prefillTicket(id);

    await expect(priceProposedGroups(id, ctx(), { expectRev: applied.rev })).rejects.toMatchObject({ code: 'conflict' });
    const [group] = await db.select().from(calcGroups).where(eq(calcGroups.requestId, id));
    expect(group!.dutyPct, 'no rate was pulled over the person').toBeNull();
    expect(await prefillTicket(id)).toBe(afterPerson);
  });

  it('the pass: a person saving inside the grouping’s tail stops the sweep and the pick (review P1-R2)', async () => {
    const row = await importRow();
    const id = await openLate([{ name: row.name, weightKg: 100 }]);
    let picks = 0;
    let afterPerson: number | null = null;
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: async (requestId, c, o = {}) => {
        const items = await db
          .select({ seq: calcRequestItems.seq })
          .from(calcRequestItems)
          .where(eq(calcRequestItems.requestId, requestId));
        const applied = await applyProposal(
          requestId,
          [
            {
              label: 'AI guruh',
              tnvedCode: row.tnvedCode,
              itemSeqs: items.map((i) => i.seq),
              aiProposed: true,
              confidence: 'high',
              aiDutyPct: null,
              note: null,
            },
          ],
          c,
          o,
        );
        // The person, between the claim's release and the pricing tail.
        await saveTable(requestId, { items: [], adds: [] }, ctx());
        afterPerson = await prefillTicket(requestId);
        const priced = await priceProposedGroups(requestId, c, o.expectRev === undefined ? {} : { expectRev: applied.rev });
        return { groups: 1, batches: 1, failed: 0, ...priced };
      },
      pick: async () => {
        picks += 1;
        return { answers: null, usage: null };
      },
    });
    expect(afterPerson, 'the premise: the person saved inside the tail').not.toBeNull();
    expect(out.overtaken).toBe('step 1');
    expect(picks).toBe(0);
    expect(await prefillTicket(id), 'nothing written after the person').toBe(afterPerson);
  });

  it('a grouping that FAILS after a person saved keeps the chain’s revision — the sweep is refused, never adopted (review P1-R7)', async () => {
    const row = await importRow();
    const id = await openLate([{ name: row.name, tnvedCode: row.tnvedCode, weightKg: 100 }]);
    let picks = 0;
    let afterPerson: number | null = null;
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: async (requestId) => {
        // A person's save lands while the machine's call is failing.
        await saveTable(requestId, { items: [], adds: [] }, ctx());
        afterPerson = await prefillTicket(requestId);
        throw new Error('model down after the person saved');
      },
      pick: async () => {
        picks += 1;
        return { answers: null, usage: null };
      },
    });
    expect(afterPerson).not.toBeNull();
    expect(out.overtaken).toBe('step 2');
    // Nothing the machine wrote before the person: the stand-down sentence (CONC-5).
    expect(out.stood).toBe('touched');
    expect(picks).toBe(0);
    expect(await prefillTicket(id), 'the sweep wrote nothing over the person').toBe(afterPerson);
  });

  it('a person’s own ✨ holding the claim is «a person is working», not a failure — no model call is paid (review CONC-3)', async () => {
    const row = await importRow();
    const id = await openLate([{ name: row.name, weightKg: 100 }]);
    // The person's ✨, mid-call: the claim the screen's button takes.
    await db.update(calcRequests).set({ aiProposalStartedAt: new Date() }).where(eq(calcRequests.id, id));
    let calls = 0;
    try {
      const out = await aiPrefill(id, ctx(), {
        configured: true,
        propose: async () => {
          calls += 1;
          throw new CalcError('ai_running');
        },
        pick: async () => {
          calls += 1;
          return { answers: null, usage: null };
        },
      });
      expect(calls, 'neither the grouping nor the pick is asked').toBe(0);
      expect(out.overtaken).toBe('step 1');
      expect(out.stood).toBe('touched');
    } finally {
      await db.update(calcRequests).set({ aiProposalStartedAt: null }).where(eq(calcRequests.id, id));
    }
  });

  it('the pick’s save refused by a person’s ✨ is overtaken, never «pick failed» (review CONC-3)', async () => {
    const kg = await importRow();
    const id = await openLate([{ name: 'Klaim nomi butunlay', tnvedCode: kg.tnvedCode, weightKg: 100 }]);
    await saveTable(id, { items: [], adds: [] }, ctx());
    const rev = await prefillTicket(id);
    try {
      const out = await pickBazas(
        id,
        { actorId: null },
        async (asking) => {
          expect(asking.length, 'the premise: the pick is reached').toBeGreaterThan(0);
          // A person presses ✨ while the model thinks.
          await db.update(calcRequests).set({ aiProposalStartedAt: new Date() }).where(eq(calcRequests.id, id));
          return { answers: asking.map((a) => ({ seq: a.seq, candidate: 0, reason: 'shu' })), usage: null };
        },
        rev,
      );
      expect(out.picked).toBe(0);
      expect(out.overtaken).toBe(1);
    } finally {
      await db.update(calcRequests).set({ aiProposalStartedAt: null }).where(eq(calcRequests.id, id));
    }
  });
});
