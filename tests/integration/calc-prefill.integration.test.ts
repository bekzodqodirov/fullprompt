import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
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
import { CalcError, openCalcRequest, returnCalcRequest, storedRequestFacts } from '@/modules/wms/calc/service';
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
import { sawRevOfGroup } from '../fixtures/calc-saw-rev';
import { AI_CODE_NOTE } from '@/modules/wms/calc/code-source';
import { CODE_SOURCE_WORDS } from '@/modules/wms/calc/ai-note';
import { AI_NOTE_HEAD, AI_REPLY_HEAD } from '@/modules/wms/calc/reply-heads';
import { CODING_FAILED_LINE, SELLER_ASKS_HEAD, WHAT_ANSWER_LINE } from '@/modules/wms/calc/ai-reply';
import { recordAiPass } from '@/modules/wms/calc/ai-cost';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { askedSeqsOf, lawAsksInputOfStored, sellerAsksOf } from '@/modules/wms/calc/law-asks';
import type { IntakeDoor } from '@/modules/wms/calc/intake';
import type { PickRequest } from '@/modules/wms/calc/prefill-ai';

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
/** The request's hands-off stamp (0139) — moved only by the machine's chained saves. */
const handsOffOf = async (id: string) =>
  (await db.select({ h: calcRequests.handsoffRev }).from(calcRequests).where(eq(calcRequests.id, id)))[0]?.h ?? null;

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
      intakeDoor: null,
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
      intakeDoor: null,
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
    // One fact a line (review product-fit-13): route, band, figure.
    expect(out.text).toContain('Xitoy → O‘zbekiston\n50 kg/m³ · ');
    expect(out.text).toContain(`× 10 m³\nYo‘lkira: ≈ $${list.toFixed(2)}`);
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
    // Re-anchored for round 3 (docs/SAKKIZ-R3.md §2.5): `out.text` is the
    // CHAT, whose seller tail points at «➕» under the message; the card's
    // copy keeps R2's words.
    expect(out.text).toContain(
      'Yo‘lkira: ⚠️ yo‘nalish (zona) tanlanmagan — qaysi shahardan ekani yozilmagan — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring',
    );
    expect(out.lentaText).toContain(
      'Yo‘lkira: ⚠️ yo‘nalish (zona) tanlanmagan — qaysi shahardan ekani yozilmagan — mijozdan so‘rab, kartadagi lentaga yozing',
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
    await confirmGroup(group!.id, ctx(), 'single', await sawRevOfGroup(group!.id));
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
    // Round 3 (docs/SAKKIZ-R3.md §10.3): the hands-off stamp stays where the
    // landing left it — behind the person's revision, i.e. «started».
    expect(await handsOffOf(id)).toBe(checked);
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
    const name = `nomsiz mol ${Date.now()}`;
    const id = await open([{ name }]);
    const out = await aiPrefill(id, ctx(), { configured: false });

    const ws = await loadWorkspace(id);
    expect(ws!.groups, 'the premise: nothing is classified').toHaveLength(0);
    expect(ws!.customsUsd, 'and the engine refuses rather than printing 0').toBeNull();

    expect(out.customsUsd, 'the pass must read it as «nothing priced»').toBeNull();
    expect(out.text).not.toContain('$0');
    expect(out.text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
    // …and the row is NAMED rather than counted, so the seller can supply
    // what is missing without opening the card. Re-anchored for
    // docs/AI-SORAYDI.md §3.4 A3 (PA-3): named IN ITS PLACE by its own
    // number — the old «⚠️ Kod topilmadi: …» list under the lines is gone,
    // and with no key nothing failed, so the VED codes it as before.
    expect(out.text.split('\n')).toContain(`1. ${name} — kod yo‘q — VED xodimi qo‘yadi`);
    expect(out.text).not.toContain('Kod topilmadi');
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

    const stampBefore = await handsOffOf(id);
    await expect(proposeGroups(id, ctx(), { expectRev: stale, handsOff: true })).rejects.toMatchObject({ code: 'conflict' });
    expect(await prefillTicket(id)).toBe(afterPerson);
    // Round 3 (§10.3): a refused claim moves no hands-off stamp either.
    expect(await handsOffOf(id)).toBe(stampBefore);
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
    // Re-anchored for round 3 (§10.2.3): the pass no longer starts a chain
    // from a fresh read of its own — it starts at the ticket the worker
    // checked, so this case hands it the one the worker would.
    const ticket = (await prefillTicket(id))!;
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
    }, { expectRev: ticket });
    expect(afterPerson, 'the premise: the person saved inside the tail').not.toBeNull();
    expect(out.overtaken).toBe('step 1');
    expect(picks).toBe(0);
    expect(await prefillTicket(id), 'nothing written after the person').toBe(afterPerson);
  });

  it('a grouping that FAILS after a person saved keeps the chain’s revision — the sweep is refused, never adopted (review P1-R7)', async () => {
    const row = await importRow();
    const id = await openLate([{ name: row.name, tnvedCode: row.tnvedCode, weightKg: 100 }]);
    // Re-anchored for round 3 (§10.2.3): the worker's ticket, not a fresh read.
    const ticket = (await prefillTicket(id))!;
    let picks = 0;
    let calls = 0;
    let afterPerson: number | null = null;
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: async (requestId) => {
        calls += 1;
        // A person's save lands while the machine's call is failing.
        await saveTable(requestId, { items: [], adds: [] }, ctx());
        afterPerson = await prefillTicket(requestId);
        throw new Error('model down after the person saved');
      },
      pick: async () => {
        picks += 1;
        return { answers: null, usage: null };
      },
    }, { expectRev: ticket });
    expect(afterPerson).not.toBeNull();
    // Re-anchored for docs/AI-SORAYDI.md §3.4 A6: a failed grouping is asked
    // once more — and the retry asks the clock first, against the revision the
    // chain KEPT, so the person's save stops the machine one step sooner than
    // the sweep did: the same rule (never adopt), met at the first check after
    // the failure. The retry itself never ran over the person.
    expect(out.overtaken).toBe('step 1 retry');
    expect(calls, 'no second call over a person’s save').toBe(1);
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

/**
 * The two bot doors through the REAL pass (docs/IKKI-ESHIK.md §2.4, §3.5),
 * the door read off the row by `aiPrefill` itself — what the worker then
 * sends nowhere on the plain door (calc-pass-settle pins who hears it).
 */
describe('the pass by the door the request came in through', () => {
  // Its own requester: one person holds at most MAX_OPEN_PER_REQUESTER open jobs.
  let doorActor = '';
  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ phone: `+99891${String(Date.now()).slice(-7)}`, fullName: `Prefill door ${SUFFIX}`, passwordHash: 'x' })
      .returning();
    doorActor = u!.id;
  });
  afterAll(async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, doorActor));
  });
  async function openDoor(
    door: IntakeDoor | null,
    section: 'rastamojka' | 'podklyuch' | 'yolkira',
    items: { name: string; tnvedCode?: string | null; weightKg?: number | null; note?: string | null }[],
    extra: { freightZone?: string | null; fromCity?: string | null; weightKg?: number | null } = {},
  ) {
    const r = await openCalcRequest(
      {
        intakeDoor: door,
        entityType: 'deal',
        entityId: dealId,
        section,
        fromCity: extra.fromCity === undefined ? 'Yiwu' : extra.fromCity,
        toCity: 'Toshkent',
        weightKg: extra.weightKg === undefined ? 500 : extra.weightKg,
        volumeM3: 10,
        freightZone: extra.freightZone ?? null,
        items,
        source: 'card',
      },
      { actorId: doorActor },
    );
    madeRequests.push(r.id);
    return r.id;
  }
  const MONEY = ['≈', 'Rastamojka jami', 'Taxminiy', 'Aniq', 'JAMI', 'Rasmiy emas', 'Yo‘lkira: ≈'];

  it('«🧮»: the note is for the VED — codes and where from, the law, the bazas — and carries NO money (his 3a)', async () => {
    const row = await importRow();
    const id = await openDoor('plain', 'podklyuch', [{ name: row.name, weightKg: 100 }], { freightZone: 'cn' });
    const out = await aiPrefill(id, ctx(), {
      propose: proposeAs(row.tnvedCode),
      pick: async () => ({ answers: [], usage: null }),
      configured: true,
    });
    // The pass still did its work — the workspace is half done for the VED.
    const ws = await loadWorkspace(id);
    expect(ws!.groups[0]!.tnvedCode).toBe(row.tnvedCode);
    expect(out.customsUsd).not.toBeNull();
    // ONE rendering, for the claim and the card alike.
    expect(out.text).toBe(out.lentaText);
    expect(out.lentaUnasked).toBeUndefined();
    expect(out.text.split('\n')[0]).toBe(`${AI_NOTE_HEAD} · PF${SUFFIX} · PF-${SUFFIX}`);
    expect(out.text.startsWith(AI_REPLY_HEAD)).toBe(false);
    expect(out.text).toContain(`· 1-qator «${row.name.replace(/\s+/g, ' ').trim().slice(0, 59)}`);
    // The model coded it in this pass (no code landed, the memory had none).
    expect(out.text).toContain(`${row.tnvedCode} · ${CODE_SOURCE_WORDS.model}`);
    expect(out.text).toContain('stavka 📖 lug‘atdan');
    expect(out.text).toContain('baza: 1 ta 📥 bojxona faylidan (taxmin)');
    for (const money of MONEY) expect(out.text, money).not.toContain(money);
    expect(out.text).not.toMatch(/\$\d+\.\d{2}\b/);
  });

  it('«🧮» with no city: the road’s gap is the VED’s to get, named first — no figure, nothing asked', async () => {
    const row = await importRow();
    const id = await openDoor('plain', 'podklyuch', [{ name: row.name, weightKg: 100 }], { fromCity: null });
    const out = await aiPrefill(id, ctx(), { propose: proposeAs(row.tnvedCode), pick: async () => ({ answers: [], usage: null }), configured: true });
    expect(out.text.split('\n')[1]).toBe('⚠️ VED uchun: yo‘nalish (zona) tanlanmagan — qaysi shahardan ekani yozilmagan.');
    for (const ask of ['mijozdan so‘rab', '«➕', 'to‘ldiring', ...MONEY]) expect(out.text, ask).not.toContain(ask);
  });

  it('a code the model proposed while READING wears «(AI taklifi)»: the plain note and the AI answer alike (§3.1)', async () => {
    const row = await importRow();
    for (const door of ['plain', 'ai'] as const) {
      const id = await openDoor(door, 'rastamojka', [
        { name: `${row.name} ${door}`, tnvedCode: row.tnvedCode, weightKg: 100, note: AI_CODE_NOTE },
      ]);
      const out = await aiPrefill(id, ctx(), { propose: idle, pick: async () => ({ answers: [], usage: null }), configured: true });
      expect(out.text, door).toContain(`${row.tnvedCode} (AI taklifi)`);
      if (door === 'plain') expect(out.text).toContain(CODE_SOURCE_WORDS.reading);
      else expect(out.lentaText).toContain(`${row.tnvedCode} (AI taklifi)`);
    }
    // A code the request landed with and nobody's model proposed wears nothing.
    const id = await openDoor('ai', 'rastamojka', [{ name: `${row.name} typed`, tnvedCode: row.tnvedCode, weightKg: 100 }]);
    const out = await aiPrefill(id, ctx(), { propose: idle, pick: async () => ({ answers: [], usage: null }), configured: true });
    expect(out.text).not.toContain('(AI taklifi)');
  });

  it('an addition’s re-run names the landing pass’s model code the model’s — never the file’s (review PP-SPEC-2 / ADV-1)', async () => {
    const row = await importRow();
    const id = await openDoor('plain', 'rastamojka', [{ name: `${row.name} rerun ${SUFFIX}`, weightKg: 100 }]);
    const landing = await aiPrefill(id, ctx(), {
      propose: proposeAs(row.tnvedCode),
      pick: async () => ({ answers: [], usage: null }),
      configured: true,
    });
    expect(landing.text).toContain(`${row.tnvedCode} · ${CODE_SOURCE_WORDS.model}`);
    // The re-run starts from the codes the landing pass's model left; the
    // workspace still says whose they are (`ai_proposed`).
    expect((await loadWorkspace(id))!.groups[0]!.aiProposed).toBe(true);
    const rerun = await aiPrefill(
      id,
      ctx(),
      { propose: idle, pick: async () => ({ answers: [], usage: null }), configured: true },
      { pass: `amend:${randomUUID()}` },
    );
    expect(rerun.text).toContain(`${row.tnvedCode} · ${CODE_SOURCE_WORDS.model}`);
    expect(rerun.text).not.toContain(CODE_SOURCE_WORDS.row);
  });

  it('a code a PERSON typed while the pass ran is not the model’s — overtaken, it is the code alone (review ADV-1)', async () => {
    const row = await importRow();
    const id = await openDoor('plain', 'rastamojka', [
      { name: `${row.name} mashina ${SUFFIX}`, weightKg: 100 },
      { name: `Odam yozgan ${SUFFIX}`, weightKg: 50 },
    ]);
    const ticket = (await prefillTicket(id))!;
    const out = await aiPrefill(
      id,
      ctx(),
      {
        configured: true,
        // The model codes row 1 only; then a person codes row 2 — after the
        // machine wrote, so the pass is overtaken at the sweep and still speaks.
        propose: async (requestId, c, o = {}) => {
          const items = await db
            .select({ id: calcRequestItems.id, seq: calcRequestItems.seq })
            .from(calcRequestItems)
            .where(eq(calcRequestItems.requestId, requestId))
            .orderBy(calcRequestItems.seq);
          const applied = await applyProposal(
            requestId,
            [{ label: 'AI guruh', tnvedCode: row.tnvedCode, itemSeqs: [items[0]!.seq], aiProposed: true, confidence: 'high', aiDutyPct: null, note: null }],
            c,
            o,
          );
          const priced = await priceProposedGroups(requestId, c, o.expectRev === undefined ? {} : { expectRev: applied.rev });
          await saveTable(requestId, { items: [{ id: items[1]!.id, seq: items[1]!.seq, tnvedCode: '9503007000' }], adds: [] }, ctx());
          return { groups: 1, batches: 1, failed: 0, ...priced };
        },
        pick: async () => ({ answers: [], usage: null }),
      },
      { expectRev: ticket },
    );
    expect(out.overtaken).toBe('step 2');
    expect(out.text).toContain(`${row.tnvedCode} · ${CODE_SOURCE_WORDS.model}`);
    expect(out.text).toMatch(new RegExp(`· 2-qator «Odam yozgan ${SUFFIX}» — 9503007000$`, 'm'));
  });

  it('the file’s own code is named so on the landing pass only — on a re-run it is the code alone', async () => {
    // A code no memory explains: the exact-key book knows no such name, and
    // no seal carries this code.
    const name = `Sinov tovari ${SUFFIX}`;
    const id = await openDoor('plain', 'rastamojka', [{ name, tnvedCode: '9503007000', weightKg: 100 }]);
    const noModel = { propose: idle, pick: async () => ({ answers: [], usage: null }), configured: true };
    const landing = await aiPrefill(id, ctx(), noModel);
    expect(landing.text).toContain(`· 1-qator «${name}» — 9503007000 · ${CODE_SOURCE_WORDS.row}`);
    // Between the passes a VED could have typed it — the re-run cannot tell,
    // so it names no source rather than a wrong one.
    const rerun = await aiPrefill(id, ctx(), noModel, { pass: `amend:${randomUUID()}` });
    expect(rerun.text).toMatch(new RegExp(`· 1-qator «${name}» — 9503007000$`, 'm'));
  });

  /**
   * The AI door ASKS AGAIN (docs/AI-SORAYDI.md §3.4 A1, his 4a of 2026-11-11,
   * review JR-13 — re-anchored from IKKI-ESHIK's 5a, «nothing is asked»): the
   * figure goes out, a seller's gap keeps the NULL door's tail, and never
   * «VED xodimi sizdan so‘raydi» about a fact only the seller has.
   */
  it('«🤖»: the figure goes out — the seller’s gap is his to send, in the NULL door’s words (A1)', async () => {
    const row = await importRow();
    const id = await openDoor('ai', 'podklyuch', [{ name: row.name, weightKg: 100 }], { fromCity: null });
    const out = await aiPrefill(id, ctx(), { propose: proposeAs(row.tnvedCode), pick: async () => ({ answers: [], usage: null }), configured: true });
    expect(out.text).toContain('Rastamojka jami');
    expect(out.text).toContain(
      'Yo‘lkira: ⚠️ yo‘nalish (zona) tanlanmagan — qaysi shahardan ekani yozilmagan — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring',
    );
    expect(out.text).toContain('JAMI: hozircha hisoblab bo‘lmadi — yuqoridagi ⚠️ ni to‘ldiring.');
    for (const w of ['sizdan so‘raydi', 'VED xodimi hisoblaydi.', 'VED uchun']) expect(out.text, w).not.toContain(w);
    // The card's copy keeps the money (2a, the AI door), its tail the lenta's own.
    expect(out.lentaText).toContain('Rastamojka jami');
    expect(out.lentaText).toContain('qaysi shahardan ekani yozilmagan — mijozdan so‘rab, kartadagi lentaga yozing');
    expect(out.lentaText).not.toContain('VED uchun');
    // Nothing on its rows or totals is owed: no ❓ block, no «unasked» copy.
    expect(out.text).not.toContain('❓');
    expect(out.lentaUnasked).toBeUndefined();
  });

  it('«🤖»: an uncoded row and a row with no figure are ASKED (A2); on a request from before the doors, as today, not', async () => {
    const goods = (tag: string) => [
      { name: `Zapchast XJ-200 ${tag} ${SUFFIX}`, weightKg: 50 },
      { name: `Ryukzak ${tag} ${SUFFIX}` },
    ];
    const noModel = { propose: idle, pick: async () => ({ answers: [], usage: null }), configured: true };
    const id = await openDoor('ai', 'rastamojka', goods('ai'));
    // With its ticket, as the worker runs it: only while nobody but the machine
    // has written is the seller asked anything (`lawAsksInputOf`).
    const out = await aiPrefill(id, ctx(), noModel, { expectRev: (await prefillTicket(id))! });
    const [zap, ryu] = goods('ai').map((g) => g.name);
    // The row with no figure first (review JS-25's order), then «what is it» for each uncoded row.
    expect(out.text).toContain(
      [
        SELLER_ASKS_HEAD,
        `· 2-qator «${ryu}»: soni (dona) yoki sof og‘irligi (kg)`,
        `· 1-qator «${zap}»: bu nima — nimadan qilingan, nima uchun ishlatiladi?`,
        `· 2-qator «${ryu}»: bu nima — nimadan qilingan, nima uchun ishlatiladi?`,
        '✍️ Shu xabarga reply qilib yozing: «2: 300 dona» — yoki «➕ Shu so‘rovga qo‘shish» ni bosing.',
      ].join('\n'),
    );
    // The card's copy says who was asked; the copy for a seller nobody reached asks nobody.
    expect(out.lentaText.split('\n')[1]).toBe('❓ Sotuvchidan so‘raldi: 1-2-qator.');
    expect(out.lentaUnasked).toBeDefined();
    for (const w of ['❓', 'Sotuvchidan so‘raldi', 'reply qilib']) expect(out.lentaUnasked!, w).not.toContain(w);

    // NULL (the card form, the thread, a request from before 0141): today's words exactly — the law's block alone, here empty.
    const legacy = await openDoor(null, 'rastamojka', goods('null'));
    const before = await aiPrefill(legacy, ctx(), noModel, { expectRev: (await prefillTicket(legacy))! });
    for (const w of ['❓', 'AI so‘raydi', 'bu nima', 'reply qilib']) expect(before.text, w).not.toContain(w);
    expect(before.lentaUnasked).toBeUndefined();
  });

  it('a yo‘lkira answer by door: the AI door sends the seller for the brutto, the plain door still says the VED asks (A1)', async () => {
    const said = async (door: IntakeDoor) => {
      const id = await openDoor(door, 'yolkira', [{ name: `Mebel ${door} ${SUFFIX}`, weightKg: 100 }], { freightZone: 'cn', weightKg: null });
      return aiPrefill(id, ctx(), { propose: idle, pick: async () => ({ answers: [], usage: null }), configured: true });
    };
    const ai = await said('ai');
    expect(ai.text).toContain('Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring');
    expect(ai.text).not.toContain('sizdan so‘raydi');
    // The plain door is unchanged (IKKI-ESHIK §2.4): nobody asks the seller.
    const plain = await said('plain');
    expect(plain.text).toContain('Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q — VED xodimi sizdan so‘raydi');
  });

  it('«🤖» podklyuch with no brutto: the road’s total is asked, the card copy for nobody names it for the VED (A2)', async () => {
    const row = await importRow();
    // Coded at the landing, so only the machine's own saves run (under the ticket).
    const id = await openDoor('ai', 'podklyuch', [{ name: `${row.name} brutto`, tnvedCode: row.tnvedCode, weightKg: 100 }], {
      freightZone: 'cn',
      weightKg: null,
    });
    const out = await aiPrefill(
      id,
      ctx(),
      { propose: idle, pick: async () => ({ answers: [], usage: null }), configured: true },
      { expectRev: (await prefillTicket(id))! },
    );
    expect(out.text).toContain(
      [
        SELLER_ASKS_HEAD,
        '· umumiy brutto og‘irligi (kg, qadoq bilan) — yo‘lkira shunga bog‘liq',
        '✍️ Shu xabarga reply qilib yozing: «jami 3500 kg» — yoki «➕ Shu so‘rovga qo‘shish» ni bosing.',
      ].join('\n'),
    );
    expect(out.text).toContain('Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring');
    expect(out.lentaText).toContain('❓ Sotuvchidan so‘raldi: umumiy brutto.');
    expect(out.lentaUnasked).toContain('⚠️ VED uchun: umumiy brutto og‘irlik (kg) yo‘q.');
    expect(out.lentaUnasked).toContain('umumiy brutto og‘irlik (kg) yo‘q — VED xodimi so‘raydi');
  });
});

/**
 * The right ADDRESS and true words, through the REAL pass (docs/AI-SORAYDI.md
 * §3.4 A3, A6 and the add door's asked rows; reviews JR-13, JS-15). The model
 * is injected at its one boundary; the sweep, the book's laws and the engine
 * are the real ones.
 */
describe('one numbering, a failed coding call, and the add door’s asked rows (A3, A6)', () => {
  // Its own requester: one person holds at most MAX_OPEN_PER_REQUESTER open jobs.
  let numActor = '';
  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ phone: `+99890${String(Date.now()).slice(-7)}`, fullName: `Prefill numbering ${SUFFIX}`, passwordHash: 'x' })
      .returning();
    numActor = u!.id;
  });
  afterAll(async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, numActor));
  });
  async function openAs(
    door: IntakeDoor | null,
    items: { name: string; tnvedCode?: string | null; weightKg?: number | null }[],
  ): Promise<string> {
    const r = await openCalcRequest(
      {
        intakeDoor: door,
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
      { actorId: numActor },
    );
    madeRequests.push(r.id);
    return r.id;
  }
  const noPick = async () => ({ answers: [], usage: null });
  /** A grouping call the model never answers — every batch failed (`proposeGroups`' own word). */
  const neverAnswers = (calls: { n: number }) => async () => {
    calls.n += 1;
    throw new CalcError('ai_failed');
  };

  it('PA-3: the jacket is NOT line «2.» — every line opens with its rows’ numbers, the uncoded row in its place, the ❓ block and the add door the same rows', async () => {
    // Rows 1 and 3 share a code the seeded book prices «20 %, kamida $1/dona»
    // (the sweater of calc-pass-settle); row 2 is a part nobody can code.
    const [a, part, b] = [`Sviter A ${SUFFIX}`, `Zapchast XJ-200 ${SUFFIX}`, `Sviter B ${SUFFIX}`];
    const id = await openAs('ai', [
      { name: a, tnvedCode: '6110200000', weightKg: 150 },
      { name: part, weightKg: 5 },
      { name: b, tnvedCode: '6110200000', weightKg: 100 },
    ]);
    const out = await aiPrefill(id, ctx(), { propose: idle, pick: noPick, configured: true }, { expectRev: (await prefillTicket(id))! });
    const lines = out.text.split('\n');
    const heads = lines.filter((l) => /^[\d, -]+\. /.test(l));
    // The group of rows 1 and 3 is ONE line, opened by both numbers; row 2 after it.
    expect(heads.map((l) => l.slice(0, l.indexOf('. ') + 1))).toEqual(['1, 3.', '2.']);
    expect(heads[0]!.startsWith(`1, 3. ${a}, ${b} · 6110200000`)).toBe(true);
    // Asked what it is in the block below — so no «VED xodimi qo‘yadi» on its line.
    expect(heads[1]).toBe(`2. ${part} — kod yo‘q`);
    expect(out.text).not.toContain('Kod topilmadi');
    // The refusal under the line names the row the engine stopped on by ITS
    // number — never the group's label first (A9).
    const under = lines[lines.indexOf(heads[0]!) + 1]!;
    expect(under).toMatch(new RegExp(`^   ⚠️ (baza yo‘q — )?1-qator «${a}»`));
    // The block asks by the same numbers, and its example is row 1's.
    expect(lines).toContain(`· 1-qator «${a}»: soni (dona) — boj kamida $1/dona`);
    expect(lines).toContain(`· 3-qator «${b}»: soni (dona) — boj kamida $1/dona`);
    expect(lines).toContain(`· 2-qator «${part}»: bu nima — nimadan qilingan, nima uchun ishlatiladi?`);
    expect(out.text).toContain('✍️ Shu xabarga reply qilib yozing: «1: 300 dona; 3: 300 dona»');
    // The add table opened from this answer prefers exactly the rows it asked a
    // figure for (review JR-13: ONE list per door), read the way the add door
    // reads it — off the stored request.
    const stored = (await storedRequestFacts(id))!;
    expect(stored.door).toBe('ai');
    expect(askedSeqsOf(sellerAsksOf(lawAsksInputOfStored(stored)))).toEqual([1, 3]);
  });

  it('…while the plain door’s note is FROZEN: its group by its index, the uncoded row by its name (review ask-break-5)', async () => {
    // Re-anchored: the round leaves the plain door exactly as it was (the
    // task's hard limit, JR-13 «plain → unchanged»). Its note is the VED's —
    // nobody addresses an answer by its numbers — so A3 does not reach it.
    const [a, part, b] = [`Sviter A plain ${SUFFIX}`, `Zapchast plain ${SUFFIX}`, `Sviter B plain ${SUFFIX}`];
    const id = await openAs('plain', [
      { name: a, tnvedCode: '6110200000', weightKg: 150 },
      { name: part, weightKg: 5 },
      { name: b, tnvedCode: '6110200000', weightKg: 100 },
    ]);
    const note = await aiPrefill(id, ctx(), { propose: idle, pick: noPick, configured: true });
    const lines = note.text.split('\n');
    // ONE group (rows 1 and 3), the note's first: «1.», as before the round.
    expect(lines.some((l) => l.startsWith(`1. ${a}, ${b} · 6110200000 · `))).toBe(true);
    expect(lines.some((l) => l.startsWith('1, 3.'))).toBe(false);
    // The «Kodlar:» list names each row by number (it always did), and the
    // VED's line names the uncoded row by its name alone, as before.
    expect(lines).toContain(`· 2-qator «${part}» — kod yo‘q`);
    expect(note.text).toContain(`⚠️ Kod topilmadi: ${part} — VED xodimi qo‘yadi`);
  });

  it('A6: a grouping call that fails is asked once more inside the pass — and when it answers, nothing says it failed', async () => {
    const row = await importRow();
    const id = await openAs('ai', [{ name: `${row.name} retry`, weightKg: 100 }]);
    let calls = 0;
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      pick: noPick,
      propose: async (requestId, c, o) => {
        calls += 1;
        if (calls === 1) throw new CalcError('ai_failed');
        return proposeAs(row.tnvedCode)(requestId, c, o);
      },
    });
    expect(calls).toBe(2);
    expect((await loadWorkspace(id))!.groups[0]!.tnvedCode).toBe(row.tnvedCode);
    expect(out.text).not.toContain(CODING_FAILED_LINE);
    expect(out.text).not.toContain('kod yo‘q');
  });

  it('A6: a call that never answers says what is TRUE, once — never «Kod topilmadi» about a jacket, never «🔄», and «bu nima?» is not asked', async () => {
    const jacket = `Куртка мужская зимняя ${SUFFIX}`;
    const id = await openAs('ai', [{ name: jacket, weightKg: 120 }]);
    const calls = { n: 0 };
    const out = await aiPrefill(
      id,
      ctx(),
      { configured: true, pick: noPick, propose: neverAnswers(calls) },
      { expectRev: (await prefillTicket(id))! },
    );
    expect(calls.n, 'the call and its one retry').toBe(2);
    for (const text of [out.text, out.lentaText]) {
      const lines = text.split('\n');
      expect(lines.filter((l) => l === CODING_FAILED_LINE)).toHaveLength(1);
      expect(lines).toContain(`1. ${jacket} — kod yo‘q`);
      for (const w of ['Kod topilmadi', '🔄', 'qayta urinib', 'bu nima']) expect(text, w).not.toContain(w);
    }
    // Nothing else is owed — the row has its weight — so no block at all.
    expect(out.text).not.toContain(SELLER_ASKS_HEAD);
    // Re-anchored (review ask-break-5): the plain door is FROZEN — its pass
    // asks the model ONCE, as it always did (a retry is a second bill on the
    // door this round leaves alone), and its note keeps its words.
    const plainId = await openAs('plain', [{ name: `${jacket} plain`, weightKg: 120 }]);
    const plainCalls = { n: 0 };
    const note = await aiPrefill(plainId, ctx(), { configured: true, pick: noPick, propose: neverAnswers(plainCalls) });
    expect(plainCalls.n, 'the plain door: one call, no retry').toBe(1);
    expect(note.text).toContain(`⚠️ Kod topilmadi: ${jacket} plain — VED xodimi qo‘yadi`);
    expect(note.text).not.toContain(CODING_FAILED_LINE);
  });

  it('A6: a call that answered for only SOME batches is a failure too — its unanswered rows are asked once more', async () => {
    // `proposeGroups` survives a batch that failed and reports it in `failed`
    // (eight hundred classified beats a thousand left); the rows of that
    // batch are still uncoded, and the retry asks only them.
    const row = await importRow();
    const id = await openAs('ai', [{ name: `${row.name} yarim`, weightKg: 100 }]);
    let calls = 0;
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      pick: noPick,
      propose: async (requestId, c, o) => {
        calls += 1;
        // The first call: one batch of one, unanswered — nothing coded.
        if (calls === 1) return { ...(await idle(requestId, c, o)), batches: 1, failed: 1 };
        return proposeAs(row.tnvedCode)(requestId, c, o);
      },
    });
    expect(calls).toBe(2);
    expect((await loadWorkspace(id))!.groups[0]!.tnvedCode).toBe(row.tnvedCode);
    expect(out.text).not.toContain(CODING_FAILED_LINE);
    // Unanswered twice: said as a failure, never «Kod topilmadi».
    const again = await openAs('ai', [{ name: `${row.name} yarim ikki`, weightKg: 100 }]);
    const twice = await aiPrefill(again, ctx(), {
      configured: true,
      pick: noPick,
      propose: async (requestId, c, o) => ({ ...(await idle(requestId, c, o)), batches: 1, failed: 1 }),
    });
    expect(twice.text).toContain(CODING_FAILED_LINE);
  });

  it('A6: the retry waits on the clock — a first call that ran past the deadline is not asked again', async () => {
    const id = await openAs('ai', [{ name: `Kepka sekin ${SUFFIX}`, weightKg: 20 }]);
    let calls = 0;
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      pick: noPick,
      deadline: Date.now() + 300,
      propose: async () => {
        calls += 1;
        // The model hangs past the pass's deadline, then fails.
        await new Promise((r) => setTimeout(r, 600));
        throw new CalcError('ai_failed');
      },
    });
    expect(calls).toBe(1);
    expect(out.pastDeadline).toBe(true);
    expect(out.text).toContain(CODING_FAILED_LINE);
  });

  it('A6: a grouping refused for something that is not the model’s (a ✅’d group) is neither retried nor called a failure', async () => {
    const id = await openAs('ai', [{ name: `Shim tasdiqli ${SUFFIX}`, weightKg: 20 }]);
    let calls = 0;
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      pick: noPick,
      propose: async () => {
        calls += 1;
        throw new CalcError('groups_confirmed');
      },
    });
    expect(calls).toBe(1);
    expect(out.text).not.toContain(CODING_FAILED_LINE);
  });

  it('A6: no key behind the model is a fact about the server — said as that, not asked twice, and the row is the VED’s', async () => {
    // Re-anchored (review ask-spec-5): the call found no key, so no model was
    // asked — «javob bermadi» (CODING_FAILED_LINE) would be untrue. The
    // answer says «AI sozlanmagan», as a server with no key always has, and
    // the uncoded row's line names who codes it; «bu nima?» is not asked of a
    // row no machine will code (review ask-break-2).
    const name = `Shapka kalitsiz ${SUFFIX}`;
    const id = await openAs('ai', [{ name, weightKg: 20 }]);
    let calls = 0;
    const out = await aiPrefill(
      id,
      ctx(),
      {
        configured: true,
        pick: noPick,
        propose: async () => {
          calls += 1;
          throw new CalcError('ai_not_configured');
        },
      },
      { expectRev: (await prefillTicket(id))! },
    );
    expect(calls).toBe(1);
    expect(out.text).not.toContain(CODING_FAILED_LINE);
    expect(out.text).toContain('AI sozlanmagan — faqat yozilganidan o‘qildi.');
    expect(out.text.split('\n')).toContain(`1. ${name} — kod yo‘q — VED xodimi qo‘yadi`);
    expect(out.text).not.toContain('bu nima');
  });

  /**
   * Review ask-break-2: with no key on the server, or today's budget spent
   * (`configured` false either way), no coder ran and none will on a re-run —
   * yet the AI door asked «bu nima?» under «❓ AI so‘raydi» and the uncoded
   * line dropped its «— VED xodimi qo‘yadi». The row is the VED's to code,
   * said on its line; the figures the seller owes are still asked.
   */
  it('no coder at all — no key, or the day’s budget spent: an uncoded row is not asked «bu nima?», its line names the VED', async () => {
    const part = `Zapchast koder yo‘q ${SUFFIX}`;
    const jacket = `Sviter koder yo‘q ${SUFFIX}`;
    const items = [
      // The law (20 %, kamida $1/dona) pins a count this row lacks.
      { name: jacket, tnvedCode: '6110200000', weightKg: 150 },
      { name: part, weightKg: 5 },
    ];
    const check = (text: string, server: string) => {
      const lines = text.split('\n');
      expect(lines, server).toContain(`2. ${part} — kod yo‘q — VED xodimi qo‘yadi`);
      expect(text, server).not.toContain('bu nima');
      expect(text, server).not.toContain(WHAT_ANSWER_LINE);
      // Row 1's count is the seller's still — asked, with the judge's head.
      expect(lines, server).toContain(`· 1-qator «${jacket}»: soni (dona) — boj kamida $1/dona`);
      expect(text, server).toContain(SELLER_ASKS_HEAD);
    };
    const noKey = await openAs('ai', items);
    const a = await aiPrefill(noKey, ctx(), { configured: false, propose: idle, pick: noPick }, { expectRev: (await prefillTicket(noKey))! });
    expect(a.text).toContain('AI sozlanmagan');
    check(a.text, 'no key');

    // Today's budget spent: the ledger holds one pass more than the limit
    // allows (the ai-cost file's own way to reach zero), restored after.
    const before = await getSetting('ai_calc_daily_limit');
    const spent = await openAs('ai', items.map((i) => ({ ...i, name: `${i.name} limit` })));
    await recordAiPass({ requestId: spent, staffId: numActor, kind: 'pick', model: 'scripted' });
    const [used] = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM ai_calc_passes
       WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'
         AND kind IN ('intake', 'grouping', 'pick', 'invoice')`);
    await setSetting('ai_calc_daily_limit', Number(used!.n), numActor);
    try {
      const b = await aiPrefill(spent, ctx(), { configured: true, propose: idle, pick: noPick }, { expectRev: (await prefillTicket(spent))! });
      expect(b.text).toContain('AI kunlik limiti tugadi');
      const lines = b.text.split('\n');
      expect(lines).toContain(`2. ${part} limit — kod yo‘q — VED xodimi qo‘yadi`);
      expect(b.text).not.toContain('bu nima');
    } finally {
      await setSetting('ai_calc_daily_limit', before as never, numActor);
    }
  });
});

/**
 * What the AI door's answer says where nobody but the seller can act, and
 * where the seller's copy reached nobody (review ask-break-3, -4, -8): the
 * road's gap on a yo‘lkira job, a figureless row's refusal, a figureless
 * uncoded row on the card's copy, and the Taxminiy block over an asked
 * uncoded row. Every literal is the fixture's figures put through the rule by
 * hand; the NULL door beside each reads as before.
 */
describe('the asking door’s words where the seller acts, and where nobody reached him (ask-break-3, -4, -8)', () => {
  let actor = '';
  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ phone: `+99891${String(Date.now()).slice(-7)}`, fullName: `Prefill asks review ${SUFFIX}`, passwordHash: 'x' })
      .returning();
    actor = u!.id;
  });
  afterAll(async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, actor));
  });
  const noPick = async () => ({ answers: [], usage: null });
  async function land(
    door: IntakeDoor | null,
    section: 'rastamojka' | 'yolkira',
    items: { name: string; tnvedCode?: string | null; weightKg?: number | null; quantity?: number | null }[],
    totals: { weightKg: number | null; volumeM3: number | null } = { weightKg: 500, volumeM3: 10 },
  ): Promise<string> {
    const r = await openCalcRequest(
      { intakeDoor: door, entityType: 'deal', entityId: dealId, section, fromCity: 'Yiwu', toCity: 'Toshkent', ...totals, items, source: 'card' },
      { actorId: actor },
    );
    madeRequests.push(r.id);
    return r.id;
  }
  /** The pass as the queue runs it — under the request's ticket, so the
   * answer may ask (`lawAsksInputOf` asks only while the machine alone wrote). */
  const run = async (id: string) =>
    aiPrefill(id, ctx(), { configured: true, propose: idle, pick: noPick }, { expectRev: (await prefillTicket(id))! });

  it('a yo‘lkira job with no cube: the AI door’s card copy for a seller nobody reached says the VED asks, and names the gap', async () => {
    // A road priced on the cube with no cube stored and no line stating one:
    // the road's own refusal, «umumiy hajm (m³) yo‘q», the SELLER's fact.
    const items = [{ name: `Kurtka yo‘lkira ${SUFFIX}`, quantity: 10 }];
    const totals = { weightKg: 500, volumeM3: null };
    const ai = await run(await land('ai', 'yolkira', items, totals));
    // The chat asks him, in the NULL door's words (A1).
    expect(ai.text).toContain('Yo‘lkira: ⚠️ umumiy hajm (m³) yo‘q — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring');
    // The card's copy where his copy reached nobody: the VED's line first
    // (`vedGapsLine` over no law row and the road's seller gap), and the tail
    // that the VED asks — never «kartadagi lentaga yozing» to a reader who
    // is not the one who can ask the customer.
    expect(ai.lentaUnasked).toBeDefined();
    expect(ai.lentaUnasked!.split('\n')[1]).toBe('⚠️ VED uchun: umumiy hajm (m³) yo‘q.');
    expect(ai.lentaUnasked).toContain('Yo‘lkira: ⚠️ umumiy hajm (m³) yo‘q — VED xodimi so‘raydi');
    // A road with nothing for the seller to send carries no second copy.
    const priced = await aiPrefill(
      await land('ai', 'yolkira', items, { weightKg: 500, volumeM3: 3 }),
      ctx(),
      { configured: true, propose: idle, pick: noPick },
    );
    expect(priced.lentaUnasked).toBeUndefined();
    // The NULL door and the plain door: as before — no second copy.
    for (const door of [null, 'plain'] as const) {
      const out = await run(await land(door, 'yolkira', items, totals));
      expect(out.lentaUnasked, String(door)).toBeUndefined();
    }
  });

  it('a coded row stating no figure: its line says the missing figure as the seller’s — on the card’s unasked copy, that the VED asks', async () => {
    // 4202… pins no unit (20 %): the row is asked «soni yoki og‘irligi»
    // (`measure`), and the engine's refusal for it is «baza yo‘q» — no baza
    // can be chosen for a row with no figure.
    const bag = `Ryukzak raqamsiz ${SUFFIX}`;
    const ai = await run(await land('ai', 'rastamojka', [{ name: bag, tnvedCode: '4202921100' }]));
    const chat = ai.text.split('\n');
    const head = chat.findIndex((l) => l.startsWith(`1. ${bag} · 4202921100`));
    expect(head).toBeGreaterThanOrEqual(0);
    // The line opens with row 1 alone, so its refusal names no row (A3).
    expect(chat[head + 1]).toBe('   ⚠️ soni (dona) yoki sof og‘irligi (kg) kiritilmagan — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring');
    expect(ai.lentaUnasked).toContain('   ⚠️ soni (dona) yoki sof og‘irligi (kg) kiritilmagan — VED xodimi so‘raydi');
    // The NULL door: «baza yo‘q — VED xodimi qo‘yadi», as before.
    const nul = await run(await land(null, 'rastamojka', [{ name: `${bag} null`, tnvedCode: '4202921100' }]));
    const lines = nul.text.split('\n');
    expect(lines[lines.findIndex((l) => l.startsWith(`1. ${bag} null`)) + 1]).toBe('   ⚠️ baza yo‘q — VED xodimi qo‘yadi');
  });

  it('an UNCODED row stating no figure: on the card’s unasked copy its count is named for the VED — its own line says only «kod yo‘q»', async () => {
    const part = `Zapchast raqamsiz ${SUFFIX}`;
    const ai = await run(await land('ai', 'rastamojka', [{ name: part }]));
    // The chat asks both: its figure and what it is.
    expect(ai.text.split('\n')).toContain(`· 1-qator «${part}»: soni (dona) yoki sof og‘irligi (kg)`);
    expect(ai.text.split('\n')).toContain(`· 1-qator «${part}»: bu nima — nimadan qilingan, nima uchun ishlatiladi?`);
    const quiet = ai.lentaUnasked!.split('\n');
    expect(quiet[1]).toBe(`⚠️ VED uchun: 1-qator «${part}»: soni (dona) yoki sof og‘irligi (kg).`);
    expect(quiet).toContain(`1. ${part} — kod yo‘q — VED xodimi qo‘yadi`);
  });

  it('the Taxminiy block over an ASKED uncoded row points at the question and names the one fixer (ask-break-4)', async () => {
    // Row 1: a declaration of the READY import by its own name, so the
    // auto-fill prices it exactly; row 2: a part nobody coded. The total is
    // blocked by row 2 (no partial sum), and only row 1 is «Aniq».
    const row = await importRow();
    const part = `Zapchast taxmin ${SUFFIX}`;
    const items = [
      { name: row.name, tnvedCode: row.tnvedCode, weightKg: 100 },
      { name: part, weightKg: 5 },
    ];
    const ai = await run(await land('ai', 'rastamojka', items));
    // Row 2 is asked what it is, and the VED codes it: one fixer, said twice
    // in the same words — never «kodsiz qator bor» beside a question to him.
    expect(ai.text).toContain('  Taxminiy: hisoblab bo‘lmadi — 2-qator kodsiz — yuqoridagi ❓ (kodni VED xodimi qo‘yadi)');
    expect(ai.text).toContain(WHAT_ANSWER_LINE);
    // Where nobody asked (the unasked copy, the NULL door): today's words.
    expect(ai.lentaUnasked).toContain('  Taxminiy: hisoblab bo‘lmadi — kodsiz qator bor (VED kod qo‘yadi)');
    const nul = await aiPrefill(
      await land(null, 'rastamojka', items.map((i, k) => (k === 1 ? { ...i, name: `${part} null` } : i))),
      ctx(),
      { configured: true, propose: idle, pick: noPick },
    );
    expect(nul.text).toContain('  Taxminiy: hisoblab bo‘lmadi — kodsiz qator bor (VED kod qo‘yadi)');
    expect(nul.text).not.toContain('yuqoridagi ❓');
  });
});

/**
 * The pass's PICK call as the pass reads it (docs/AI-SORAYDI.md §3.4 A12,
 * PR-9): the row's note reaches the model the way it reaches the grouping,
 * and a call that came back with nothing — cut at max_tokens above all, the
 * 4096 trap — is SAID, in A6's words, where it used to leave «baza yo‘q» for
 * rows that had declarations to choose from. The model is injected at its
 * boundary; the candidate read, the sweep and the reply are the real ones.
 */
describe('the pick: the note it reads and the answer it did not give (A12)', () => {
  it('the row’s note is in what the pick is asked; a cut call is «javob bermadi», on the chat and the card alike', async () => {
    const kg = (await db.select().from(customsImportRows).where(eq(customsImportRows.batchId, batchId))).find((r) => r.unit === 'kg')!;
    // A name nothing like the declarations', so the auto-fill leaves the baza
    // empty and the pick is asked (the «VED types meanwhile» case's trick).
    const note = 'rasmda: qora ofis stuli, metall oyoq';
    const r = await openCalcRequest(
      {
        intakeDoor: null,
        entityType: 'deal',
        entityId: dealId,
        section: 'rastamojka',
        fromCity: 'Yiwu',
        toCity: 'Toshkent',
        weightKg: 500,
        volumeM3: 10,
        items: [{ name: `Boshqa nom A12 ${SUFFIX}`, tnvedCode: kg.tnvedCode, weightKg: 100, note }],
        source: 'card',
      },
      ctx(),
    );
    madeRequests.push(r.id);
    let asked: PickRequest[] = [];
    const out = await aiPrefill(r.id, ctx(), {
      configured: true,
      propose: idle,
      pick: async (rows) => {
        asked = rows;
        // What `pickImportRows` hands back for an answer cut at max_tokens.
        return { answers: null, usage: { model: 'scripted', inputTokens: 900, outputTokens: 16_000 }, failed: 'cut' };
      },
    });
    expect(asked, 'the premise: the row had declarations and the pick was asked').toHaveLength(1);
    expect(asked[0]!.note).toBe(note);
    expect(out.picked).toBe(0);
    // One row asked, no answer: A6's words, under the totals — on both copies.
    for (const text of [out.text, out.lentaText]) {
      expect(text).toContain('⚠️ AI bazasini qo‘ymadi: 1 tasiga javob bermadi — VED to‘ldiradi');
    }
  });

  it('a stand-in that names no failure (no key behind it, nothing asked) is said as before — nothing', async () => {
    const kg = (await db.select().from(customsImportRows).where(eq(customsImportRows.batchId, batchId))).find((r) => r.unit === 'kg')!;
    const id = await open([{ name: `Boshqa nom A12 jim ${SUFFIX}`, tnvedCode: kg.tnvedCode, weightKg: 100 }]);
    const out = await aiPrefill(id, ctx(), { configured: true, propose: idle, pick: async () => ({ answers: null, usage: null }) });
    expect(out.text).not.toContain('javob bermadi');
  });
});
