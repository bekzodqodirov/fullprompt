import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
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
import { openCalcRequest } from '@/modules/wms/calc/service';
import { applyProposal, loadWorkspace } from '@/modules/wms/calc/workspace';
import { aiPrefill } from '@/modules/wms/calc/prefill';

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

async function open(items: { name: string; tnvedCode?: string | null; quantity?: number | null; weightKg?: number | null }[]) {
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

/** The model's grouping, scripted: it names ONE code for every item. */
const proposeAs = (code: string) => async (requestId: string, c: { actorId: string }) => {
  const items = await db
    .select({ seq: calcRequestItems.seq })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId));
  await applyProposal(
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
  );
  const { priceProposedGroups } = await import('@/modules/wms/calc/workspace');
  const priced = await priceProposedGroups(requestId, c);
  return { groups: 1, batches: 1, failed: 0, ...priced };
};

describe('the machine carries a job as far as it honestly can', () => {
  it('codes from the model, rates from the book, baza from the file', async () => {
    const row = await importRow();
    const id = await open([{ name: row.name, weightKg: 100 }]);

    const out = await aiPrefill(id, ctx(), {
      propose: proposeAs(row.tnvedCode),
      pick: async () => [],
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
    expect(out.text).toContain('Tahminiy');
    expect(out.text).toContain('Rasmiy emas');
  });

  it('the request STAYS in the queue — nothing is confirmed or sealed', async () => {
    const row = await importRow();
    const id = await open([{ name: row.name, weightKg: 100 }]);
    await aiPrefill(id, ctx(), { propose: proposeAs(row.tnvedCode), pick: async () => [], configured: true });

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
      propose: async () => ({ groups: 0, batches: 0, failed: 0, ratesPulled: 0, codesStamped: 0, importFilled: 0 }),
      pick: async (asking) => {
        offered = asking.length;
        // The model answers with an INDEX, never a price.
        return asking.map((a) => ({ seq: a.seq, candidate: 0, reason: 'shu tovar' }));
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
        return rows.map((a) => ({ seq: a.seq, candidate: 0, reason: 'shu' }));
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
      propose: async () => ({ groups: 0, batches: 0, failed: 0, ratesPulled: 0, codesStamped: 0, importFilled: 0 }),
      pick: async (asking) => asking.map((a) => ({ seq: a.seq, candidate: null, reason: 'mos emas' })),
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

  it('a model that fails costs a sentence, never the job', async () => {
    const kg = await importRow();
    const id = await open([{ name: kg.name, tnvedCode: kg.tnvedCode, weightKg: 100 }]);
    const out = await aiPrefill(id, ctx(), {
      configured: true,
      propose: async () => {
        throw new Error('model down');
      },
      pick: async () => null,
    });
    // The sweep still ran: the memory's code found its group and the file
    // answered its baza.
    const ws = await loadWorkspace(id);
    expect(ws!.groups).toHaveLength(1);
    expect(out.text).toContain('Tahminiy');
  });
});
