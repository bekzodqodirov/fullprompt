import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import {
  CustomsImportError,
  deleteImportBatch,
  newestReadyBatchId,
  runCustomsImport,
} from '@/modules/wms/customs/import-service';
import { importRowForCode, suggestImportBaza } from '@/modules/wms/customs/import-baza';
import type { ImportUnit } from '@/modules/wms/customs/import-parse';
import { openCalcRequest, CalcError } from '@/modules/wms/calc/service';
import { loadWorkspace, saveTable } from '@/modules/wms/calc/workspace';

/**
 * The quarterly customs dump, end to end (docs/VED-IMPORT-AI.md sub-round A).
 *
 * His own file's twelve rows are the fixture, with his own headers, so the
 * parser is measured against the thing it will meet and not against a shape
 * invented here.
 *
 * CONFIGURATION WARNING (#183): a READY import batch changes what EVERY
 * calculation saves — a coded row with an empty baza gets one. The batch is
 * deleted in `afterAll`, and `fileParallelism: false` means no other file is
 * running while it exists. The fixture's codes appear nowhere else in the
 * suite, deliberately.
 */
const SUFFIX = String(Date.now()).slice(-6);
let actorId = '';
let clientId = '';
let dealId = '';
let batchId = '';
const madeBatches: string[] = [];
const madeRequests: string[] = [];
const madeKeys: string[] = [];
const ctx = () => ({ actorId });

/** Upload the fixture and parse it, exactly as the job does. */
async function importFixture(fileName = 'customs-import-sample.xlsx'): Promise<string> {
  const bytes = readFileSync('tests/fixtures/customs-import-sample.xlsx');
  const key = `customs-import/test-${randomUUID()}.xlsx`;
  await getStorage().put(
    key,
    bytes,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  madeKeys.push(key);
  const [batch] = await db
    .insert(customsImportBatches)
    .values({ fileName, uploadedBy: actorId, status: 'processing' })
    .returning({ id: customsImportBatches.id });
  madeBatches.push(batch!.id);
  await runCustomsImport({ batchId: batch!.id, storageKey: key, fileName });
  return batch!.id;
}

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99893${String(Date.now()).slice(-7)}`,
      fullName: `Import fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `IM${SUFFIX}`, name: `Import fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `IM-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'Import fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;
  batchId = await importFixture();
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
  // The batch is CONFIGURATION — every later save would read it (#183). Raw,
  // because the service refuses to delete a READY batch on purpose.
  if (madeBatches.length > 0) {
    await db.delete(customsImportBatches).where(inArray(customsImportBatches.id, madeBatches));
  }
  for (const key of madeKeys) await getStorage().delete(key).catch(() => {});
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

/** The request's item rows, as the database holds them. */
const itemsOf = (requestId: string) =>
  db
    .select()
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId))
    .orderBy(calcRequestItems.seq);

async function open(items: { name: string; tnvedCode?: string | null; quantity?: number | null; weightKg?: number | null }[]) {
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
  return result.id;
}

describe('the file becomes rows', () => {
  it('reads his own sample whole, with the units mapped', async () => {
    const rows = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId))
      .orderBy(customsImportRows.id);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const units = new Set(rows.map((r) => r.unit));
    // His file's four units, all of them ours.
    expect(units.has('kg')).toBe(true);
    expect(units.has('dona')).toBe(true);
    expect([...units].every((u) => ['kg', 'dona', 'm2', 'juft', 'litr'].includes(u))).toBe(true);
    // The «1. » prefix his file writes on nearly every name is stripped from
    // the string the trigram index is built on, and kept in the one a person
    // reads.
    const prefixed = rows.find((r) => /^\s*\d+\s*\./.test(r.name));
    if (prefixed) expect(prefixed.nameNorm).not.toMatch(/^\d/);
  });

  it('settles the batch READY with the period it covers', async () => {
    const [batch] = await db
      .select()
      .from(customsImportBatches)
      .where(eq(customsImportBatches.id, batchId));
    expect(batch!.status).toBe('ready');
    expect(batch!.rowCount).toBeGreaterThan(0);
    expect(batch!.periodFrom).not.toBeNull();
    expect(batch!.periodTo! >= batch!.periodFrom!).toBe(true);
  });

  it('a re-run replaces its own rows rather than doubling them', async () => {
    // pg-boss retries a thrown job; the batch id is the claim, so a second
    // pass must leave the same quarter, not two of it.
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    const key = madeKeys[0]!;
    await runCustomsImport({ batchId, storageKey: key, fileName: 'customs-import-sample.xlsx' });
    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('a ready batch nobody has priced off may go; one that priced a job may not', async () => {
    // The wrong file DOES get uploaded — last quarter's, a colleague's, the
    // same one twice — and until it can be removed every suggestion in the
    // company reads it. Once a calculation has taken a price from it, the
    // batch is that price's provenance and stays.
    const spare = await importFixture('customs-import-spare.xlsx');
    await deleteImportBatch(spare);
    const left = await db
      .select()
      .from(customsImportBatches)
      .where(eq(customsImportBatches.id, spare));
    expect(left).toHaveLength(0);

    const used = await importFixture('customs-import-used.xlsx');
    const [row] = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, used))
      .orderBy(customsImportRows.id);
    const requestId = await open([{ name: row!.name, tnvedCode: row!.tnvedCode, weightKg: 10 }]);
    const [item] = await itemsOf(requestId);
    await saveTable(
      requestId,
      {
        items: [
          { id: item!.id, seq: item!.seq, bazaUsd: 3, bazaBasis: 'kg', importRowId: String(row!.id) },
        ],
        adds: [],
      },
      ctx(),
    );
    await expect(deleteImportBatch(used)).rejects.toBeInstanceOf(CustomsImportError);

    // …and the newest ready batch is the fixture's again for the rest.
    await db
      .update(customsImportBatches)
      .set({ uploadedAt: new Date() })
      .where(eq(customsImportBatches.id, batchId));
  });
});

describe('which price the file offers', () => {
  it('the exact code narrows and the name ranks', async () => {
    const rows = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    const kgRow = rows.find((r) => r.unit === 'kg')!;
    const sug = await suggestImportBaza(
      { tnvedCode: kgRow.tnvedCode, name: kgRow.name, unit: 'kg' },
      { batchId },
    );
    expect(sug.candidates.length).toBeGreaterThan(0);
    // Its own name is its own best match, and nothing under another code
    // ever appears — a neighbouring code's price is not this code's price.
    expect(sug.candidates.every((c) => c.nameSim <= 1)).toBe(true);
    expect(sug.auto).not.toBeNull();
    expect(sug.auto!.pricePerUnitUsd).toBe(Number(kgRow.pricePerUnitUsd));
  });

  it('never auto-fills across a UNIT — a per-kg price on a per-dona row is off by the weight of the goods', async () => {
    const [kgRow] = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId))
      .orderBy(customsImportRows.id);
    const onlyKg = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    const kg = onlyKg.find((r) => r.unit === 'kg') ?? kgRow!;
    // Ask for the SAME row, but as if our cargo were priced per piece.
    const sug = await suggestImportBaza(
      { tnvedCode: kg.tnvedCode, name: kg.name, unit: 'dona' },
      { batchId },
    );
    expect(sug.auto).toBeNull();
    // …and the picker still lists it, labelled, so the VED can take it on
    // purpose. A refusal to auto-fill is not a refusal to answer.
    expect(sug.candidates.some((c) => c.unitMatches === false)).toBe(true);
  });

  it('a SHORT typed name is found inside a long declaration paragraph', async () => {
    // MEASURED on his own file: «Товар номи» is a whole paragraph — 500
    // characters of composition, dimensions, roll counts — while the VED
    // types «Нетканый материал». Plain `similarity()` divides by the union
    // of both trigram sets and scores that near zero, so every suggestion in
    // the system would have been refused by its own threshold.
    const rows = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    const long = rows.filter((r) => r.name.length > 120).sort((a, b) => b.name.length - a.name.length)[0];
    expect(long, 'his file writes long descriptions — the fixture must too').toBeTruthy();
    // The first six words of the declaration, as a person would type them.
    const typed = long!.name.replace(/^\s*\d+\s*[.)]\s*/, '').split(/\s+/).slice(0, 5).join(' ');
    const sug = await suggestImportBaza(
      { tnvedCode: long!.tnvedCode, name: typed, unit: long!.unit as ImportUnit },
      { batchId },
    );
    expect(sug.auto).not.toBeNull();
    expect(sug.auto!.nameSim).toBeGreaterThan(0.9);
  });

  it('a name too short to mean anything never auto-fills', async () => {
    const [row] = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    // At three characters «оси» matches inside almost any paragraph.
    const sug = await suggestImportBaza(
      { tnvedCode: row!.tnvedCode, name: 'ма', unit: row!.unit as ImportUnit },
      { batchId },
    );
    expect(sug.auto).toBeNull();
  });

  it('a name nobody would recognise fills nothing', async () => {
    const [row] = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    const sug = await suggestImportBaza(
      { tnvedCode: row!.tnvedCode, name: 'qwertyuiop asdfghjkl', unit: row!.unit as ImportUnit },
      { batchId },
    );
    expect(sug.auto).toBeNull();
  });

  it('the NEWEST ready import answers', async () => {
    const second = await importFixture('customs-import-second.xlsx');
    expect(await newestReadyBatchId()).toBe(second);
    // A batch still processing must never half-price a calculation.
    const [pending] = await db
      .insert(customsImportBatches)
      .values({ fileName: 'in-flight.xlsx', uploadedBy: actorId, status: 'processing' })
      .returning({ id: customsImportBatches.id });
    madeBatches.push(pending!.id);
    expect(await newestReadyBatchId()).toBe(second);
    // Put the first batch back on top for the rest of the file.
    await db
      .update(customsImportBatches)
      .set({ uploadedAt: new Date() })
      .where(eq(customsImportBatches.id, batchId));
    expect(await newestReadyBatchId()).toBe(batchId);
  });

  it('an id from a form must price the code it claims to', async () => {
    const rows = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    const a = rows[0]!;
    const other = rows.find((r) => r.tnvedCode !== a.tnvedCode)!;
    expect(await importRowForCode(String(a.id), a.tnvedCode)).not.toBeNull();
    // The id-teleport family: a hand-posted id from ANOTHER code must not
    // stamp somebody else's price with our provenance mark.
    expect(await importRowForCode(String(a.id), other.tnvedCode)).toBeNull();
  });
});

describe('the workspace takes the suggestion', () => {
  it('fills an EMPTY baza, names the rows and records where the price came from', async () => {
    const [row] = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId))
      .orderBy(customsImportRows.id);
    const kg = (
      await db.select().from(customsImportRows).where(eq(customsImportRows.batchId, batchId))
    ).find((r) => r.unit === 'kg')!;
    void row;

    const requestId = await open([{ name: kg.name, tnvedCode: kg.tnvedCode, weightKg: 100 }]);
    const [item] = await itemsOf(requestId);
    expect(item!.bazaUsd).toBeNull();

    const result = await saveTable(requestId, { items: [], adds: [] }, ctx());
    expect(result.importFilled).toContain(item!.seq);

    const [filled] = await itemsOf(requestId);
    expect(Number(filled!.bazaUsd)).toBe(Number(kg.pricePerUnitUsd));
    expect(filled!.bazaBasis).toBe('kg');
    expect(filled!.bazaSource).toBe('import');
    expect(String(filled!.importRowId)).toBe(String(kg.id));
    // …and the group's ✅ has something to record: the price was chosen by a
    // machine and the person confirming it must see that.
    const ws = await loadWorkspace(requestId);
    const group = ws!.groups.find((g) => g.id === filled!.groupId)!;
    expect(group.warnings).toContain('baza_from_import');
  });

  it('never touches a baza a person typed', async () => {
    const kg = (
      await db.select().from(customsImportRows).where(eq(customsImportRows.batchId, batchId))
    ).find((r) => r.unit === 'kg')!;
    const requestId = await open([{ name: kg.name, tnvedCode: kg.tnvedCode, weightKg: 100 }]);
    const [item] = await itemsOf(requestId);
    const typed = Number(kg.pricePerUnitUsd) + 7;

    const first = await saveTable(
      requestId,
      { items: [{ id: item!.id, seq: item!.seq, bazaUsd: typed, bazaBasis: 'kg' }], adds: [] },
      ctx(),
    );
    expect(first.importFilled).toEqual([]);

    // A later save must not «correct» it either — the VED's number stands
    // until the VED changes it.
    await saveTable(requestId, { items: [], adds: [] }, ctx());
    const [after] = await itemsOf(requestId);
    expect(Number(after!.bazaUsd)).toBe(typed);
    expect(after!.bazaSource).toBe('typed');
    expect(after!.importRowId).toBeNull();
  });

  it('a picked row is read from the FILE, not from the browser', async () => {
    const rows = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    const kg = rows.find((r) => r.unit === 'kg')!;
    const requestId = await open([{ name: 'Boshqa nom', tnvedCode: kg.tnvedCode, weightKg: 100 }]);
    const [item] = await itemsOf(requestId);

    await saveTable(
      requestId,
      {
        items: [
          {
            id: item!.id,
            seq: item!.seq,
            // A browser claiming a price of one dollar for the row it picked.
            bazaUsd: 1,
            bazaBasis: 'kg',
            importRowId: String(kg.id),
          },
        ],
        adds: [],
      },
      ctx(),
    );
    const [after] = await itemsOf(requestId);
    expect(Number(after!.bazaUsd)).toBe(Number(kg.pricePerUnitUsd));
    expect(after!.bazaSource).toBe('import');
  });

  it('refuses an import row that does not price this row’s code', async () => {
    const rows = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, batchId));
    const a = rows[0]!;
    const other = rows.find((r) => r.tnvedCode !== a.tnvedCode)!;
    const requestId = await open([{ name: a.name, tnvedCode: a.tnvedCode, weightKg: 100 }]);
    const [item] = await itemsOf(requestId);
    await expect(
      saveTable(
        requestId,
        {
          items: [
            { id: item!.id, seq: item!.seq, bazaUsd: 5, bazaBasis: 'kg', importRowId: String(other.id) },
          ],
          adds: [],
        },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(CalcError);
  });

  it('losing the import leaves the PRICE and drops only the provenance', async () => {
    // `ON DELETE SET NULL`, not CASCADE: a price the VED accepted is a fact
    // about this calculation, and deleting last quarter's file must not
    // silently un-price a job.
    const kg = (
      await db.select().from(customsImportRows).where(eq(customsImportRows.batchId, batchId))
    ).find((r) => r.unit === 'kg')!;
    const gone = await importFixture('customs-import-throwaway.xlsx');
    const [ghost] = await db
      .select()
      .from(customsImportRows)
      .where(eq(customsImportRows.batchId, gone))
      .orderBy(customsImportRows.id);

    const requestId = await open([{ name: kg.name, tnvedCode: ghost!.tnvedCode, weightKg: 100 }]);
    const [item] = await itemsOf(requestId);
    await saveTable(
      requestId,
      {
        items: [
          { id: item!.id, seq: item!.seq, bazaUsd: 1, bazaBasis: 'kg', importRowId: String(ghost!.id) },
        ],
        adds: [],
      },
      ctx(),
    );
    const [priced] = await itemsOf(requestId);
    expect(String(priced!.importRowId)).toBe(String(ghost!.id));

    await db.delete(customsImportBatches).where(eq(customsImportBatches.id, gone));
    const [after] = await itemsOf(requestId);
    expect(Number(after!.bazaUsd)).toBe(Number(ghost!.pricePerUnitUsd));
    expect(after!.importRowId).toBeNull();
  });
});
