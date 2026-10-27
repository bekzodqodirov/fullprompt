import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The candidate read is WATCHED, never replaced: the wrapper below counts
 * every `suggestImportBaza` call by the row name it was asked about and then
 * runs the real one. That is how (i) can say «the import was not even asked»
 * — a fact no row in the database records.
 */
const spy = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('@/modules/wms/customs/import-baza', async (original) => {
  const real = await original<typeof import('@/modules/wms/customs/import-baza')>();
  return {
    ...real,
    suggestImportBaza: (...args: Parameters<typeof real.suggestImportBaza>) => {
      spy.asked.push(args[0].name);
      return real.suggestImportBaza(...args);
    },
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  calcBazas,
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  customsImportBatches,
  deals,
  dealStages,
  events,
  tasks,
  tnvedAssignments,
  users,
} from '@/modules/platform/db/schema';
import { onDate, saveBaza } from '@/modules/wms/calc/dictionaries';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { itemNameNorm } from '@/modules/wms/calc/memory';
import { normalizeName } from '@/modules/wms/customs/import-parse';
import { productKey } from '@/modules/wms/tnved/service';
import {
  confirmAllGroups,
  loadWorkspace,
  saveTable,
  sealCalc,
  type TableItemEdit,
} from '@/modules/wms/calc/workspace';

/**
 * `calc_bazas` SECOND, inside `saveTable`'s fill (docs/SAKKIZ-R2.md §7.2).
 *
 * The book the VED keeps at /hisoblash/lugatlar now answers on every
 * Saqlash, in the owner's order: what this company SEALED, then the BOOK,
 * then the customs file. Every assertion is about rows in a real database —
 * which source a row ends wearing, and what a person's clear means.
 *
 * Code 3924100000 is plastic tableware: heading 3924 in the seeded PP-3818 is
 * a plain 20 % advalor law that pins no baza unit, so the ROW's own figures
 * decide which units may price it — the case the book's unit rule is about.
 *
 * CONFIGURATION WARNING (#183): a book row answers every later save of the
 * same name, and a ready import batch answers every later save of its codes.
 * Names carry this run's digits, the batch is deleted in `afterAll`, and the
 * book rows with it.
 */
const SUFFIX = String(Date.now()).slice(-6);
const CODE = '3924100000';
let seq = 0;
const name = (what: string) => `${what} ${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const madeNames: string[] = [];
const madeBatches: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99894${String(Date.now()).slice(-7)}`, fullName: `Book fill fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `DF${SUFFIX}`, name: `Book fill fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `DF-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Book fill fixture', createdBy: actorId })
    .returning();
  dealId = deal!.id;
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
  // The book and the memory's code book are CONFIGURATION (#183).
  if (madeNames.length > 0) {
    await db.delete(calcBazas).where(inArray(calcBazas.productKey, madeNames.map((n) => productKey(n))));
    await db.delete(tnvedAssignments).where(inArray(tnvedAssignments.productKey, madeNames.map((n) => itemNameNorm(n))));
  }
  if (madeBatches.length > 0) await db.delete(customsImportBatches).where(inArray(customsImportBatches.id, madeBatches));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(items: { name: string; tnvedCode?: string | null; quantity?: number | null; weightKg?: number | null }[]) {
  for (const i of items) madeNames.push(i.name);
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

const rowsOf = (requestId: string) =>
  db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId)).orderBy(calcRequestItems.seq);

async function editOf(requestId: string, seqNo: number, patch: Omit<TableItemEdit, 'id' | 'seq'>): Promise<TableItemEdit> {
  const item = (await rowsOf(requestId)).find((i) => i.seq === seqNo)!;
  return { id: item.id, seq: item.seq, ...patch };
}

const save = (requestId: string, items: TableItemEdit[] = [], adds: Parameters<typeof saveTable>[1]['adds'] = []) =>
  saveTable(requestId, { items, adds }, ctx());

/** A book row in force from today. */
const book = (product: string, bazaUsd: number, basis: 'kg' | 'unit') =>
  saveBaza({ name: product, label: product, tnvedCode: null, bazaUsd, basis, effectiveDate: onDate(), note: null }, ctx());

/** A READY quarter, newest, holding `rows` of CODE under `product`'s name. */
async function importBatch(product: string, rows: { price: number; unit: 'kg' | 'dona' }[]): Promise<string> {
  const [batch] = await db.execute<{ id: string }>(sql`
    INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to)
    VALUES (${`book-fill-${SUFFIX}.xlsx`}, ${actorId}::uuid, 'ready', ${onDate()}::date, ${onDate()}::date)
    RETURNING id::text AS id`);
  madeBatches.push(batch!.id);
  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
      VALUES (${batch!.id}::uuid, ${CODE}, ${product}, ${normalizeName(product)}, ${r.unit}, ${String(r.price)}::numeric, '156-КИТАЙ')`);
  }
  return batch!.id;
}

/** One priced, confirmed, SEALED job about `product` at `bazaUsd` per kg —
 * the memory's raw material (calc-memory.integration's own recipe). */
async function sealOne(product: string, bazaUsd: number) {
  const id = await open([{ name: product, tnvedCode: CODE, weightKg: 100 }]);
  await save(id);
  await save(id, [await editOf(id, 1, { bazaUsd, bazaBasis: 'kg' })]);
  await confirmAllGroups(id, ctx());
  await sealCalc(id, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx());
  return id;
}

describe('the book fills a baza-less row on every save, second after the memory', () => {
  it('(a) a book row in kg fills a coded row stating its kg — 📖, with both pointers null', async () => {
    const product = name('Plastik idish');
    await book(product, 2, 'kg');
    const id = await open([{ name: product, tnvedCode: CODE, weightKg: 100 }]);
    const out = await save(id);
    expect(out.dictionaryFilled).toEqual([1]);
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({ bazaUsd: '2.0000', bazaBasis: 'kg', bazaSource: 'dictionary', importRowId: null, memoryItemId: null, bazaReason: null });
  });

  it('(b) the memory and the book both answer → the memory', async () => {
    const product = name('Plastik kosa');
    await sealOne(product, 5);
    await book(product, 2, 'kg');
    const id = await open([{ name: product, tnvedCode: CODE, weightKg: 40 }]);
    const out = await save(id);
    expect(out.memoryFilled).toEqual([1]);
    expect(out.dictionaryFilled).toEqual([]);
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({ bazaUsd: '5.0000', bazaSource: 'memory' });
  });

  it('(c) the book and the import both answer → the book', async () => {
    const product = name('Plastik laganlar');
    await importBatch(product, [{ price: 7, unit: 'kg' }]);
    await book(product, 2, 'kg');
    const id = await open([{ name: product, tnvedCode: CODE, weightKg: 40 }]);
    const out = await save(id);
    expect(out.dictionaryFilled).toEqual([1]);
    expect(out.importFilled).toEqual([]);
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({ bazaUsd: '2.0000', bazaSource: 'dictionary', importRowId: null });
    await db.delete(customsImportBatches).where(inArray(customsImportBatches.id, madeBatches));
    madeBatches.length = 0;
  });

  it('(d) a NEW row typed with a book name is filled on its first save', async () => {
    const product = name('Plastik stakan');
    await book(product, 3, 'kg');
    const id = await open([{ name: name('boshqa tovar'), tnvedCode: CODE, weightKg: 1 }]);
    madeNames.push(product);
    const out = await save(id, [], [{ name: product, tnvedCode: CODE, weightKg: 12 }]);
    expect(out.dictionaryFilled).toEqual([2]);
    const added = (await rowsOf(id)).find((r) => r.seq === 2)!;
    expect(added).toMatchObject({ bazaUsd: '3.0000', bazaBasis: 'kg', bazaSource: 'dictionary' });
  });

  it('(e) a book price per dona on a WEIGHT-only row stays empty — the row never offers dona', async () => {
    // The 📖 button's broader rule would land it (a row's basis is free since
    // 18a); the AUTO-fill asks `unitsForRow`, which offers dona only to a row
    // stating a count. A price per piece on a row with no pieces is a number
    // nobody can multiply.
    const product = name('Plastik ilgak');
    await book(product, 4, 'unit');
    const id = await open([{ name: product, tnvedCode: CODE, weightKg: 30 }]);
    const out = await save(id);
    expect(out.dictionaryFilled).toEqual([]);
    const [row] = await rowsOf(id);
    expect(row!.bazaUsd).toBeNull();
  });

  it('(f) the VED clears a 📖 baza and saves → still empty after that save', async () => {
    const product = name('Plastik qopqoq');
    await book(product, 2, 'kg');
    const id = await open([{ name: product, tnvedCode: CODE, weightKg: 10 }]);
    await save(id);
    expect((await rowsOf(id))[0]!.bazaSource).toBe('dictionary');
    // The screen's own clear: no price, no unit.
    const out = await save(id, [await editOf(id, 1, { bazaUsd: null, bazaBasis: null })]);
    expect(out.dictionaryFilled).toEqual([]);
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({ bazaUsd: null, bazaBasis: null, bazaSource: null });
  });

  it('(f2) a unit CHOSEN on a row with no baza is not a clear — the book fills it in that unit, same save', async () => {
    // Exactly what items-table posts when only the unit select moved on an
    // unpriced row: `{ bazaUsd: null, bazaBasis: 'kg' }`.
    const product = name('Plastik tarelka');
    const id = await open([{ name: product, tnvedCode: CODE, weightKg: 10 }]);
    await save(id);
    expect((await rowsOf(id))[0]!.bazaUsd).toBeNull();
    await book(product, 6, 'kg');
    const out = await save(id, [await editOf(id, 1, { bazaUsd: null, bazaBasis: 'kg' })]);
    expect(out.dictionaryFilled).toEqual([1]);
    expect((await rowsOf(id))[0]).toMatchObject({ bazaUsd: '6.0000', bazaBasis: 'kg', bazaSource: 'dictionary' });
  });

  it('(g) the book moves under a 📖 row → baza_dictionary_moved on its group', async () => {
    const product = name('Plastik vaza');
    await book(product, 2, 'kg');
    const id = await open([{ name: product, tnvedCode: CODE, weightKg: 10 }]);
    await save(id);
    let ws = await loadWorkspace(id);
    expect(ws!.groups[0]!.warnings).not.toContain('baza_dictionary_moved');
    // Today's book row corrected (the same day's correction is the same row).
    await book(product, 3, 'kg');
    ws = await loadWorkspace(id);
    expect(ws!.groups[0]!.items[0]!.bazaUsd).toBe(2);
    expect(ws!.groups[0]!.warnings).toContain('baza_dictionary_moved');
  });

  it('(h) the audit row carries what the book filled', async () => {
    const product = name('Plastik idishcha');
    await book(product, 2, 'kg');
    const id = await open([{ name: product, tnvedCode: CODE, weightKg: 10 }]);
    await save(id);
    const audits = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.entityId, id))
      .orderBy(auditLog.id);
    const last = audits.at(-1)!.after as { dictionaryFilled?: number[] };
    expect(last.dictionaryFilled).toEqual([1]);
  });

  it('(i) a row the memory answers before the transaction is not asked of the import', async () => {
    const product = name('Plastik choynak');
    await sealOne(product, 9);
    await importBatch(product, [{ price: 7, unit: 'kg' }]);
    const id = await open([{ name: product, tnvedCode: CODE, weightKg: 20 }]);
    spy.asked.length = 0;
    const out = await save(id);
    expect(out.memoryFilled).toEqual([1]);
    expect(spy.asked, 'the file was scanned for a row the memory already answered').not.toContain(product);
    // The control: a row nobody above answers IS asked of the same file.
    const other = name('Sovun idishi');
    const id2 = await open([{ name: other, tnvedCode: CODE, weightKg: 20 }]);
    spy.asked.length = 0;
    await save(id2);
    expect(spy.asked).toContain(other);
    await db.delete(customsImportBatches).where(inArray(customsImportBatches.id, madeBatches));
    madeBatches.length = 0;
  });
});
