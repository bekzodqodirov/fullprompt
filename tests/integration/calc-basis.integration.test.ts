import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcBazas,
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
  tnvedAssignments,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { saveBaza } from '@/modules/wms/calc/dictionaries';
import { itemNameNorm } from '@/modules/wms/calc/memory';
import { isBehindOnBasisCheck } from '@/modules/wms/calc/basis';
import { groupsByCodeOf, liveMembership } from '@/modules/wms/calc/screen-row';
import { normalizeName } from '@/modules/wms/customs/import-parse';
import { productKey } from '@/modules/wms/tnved/service';
import {
  confirmAllGroups,
  loadWorkspace,
  pullBazasFromDictionary,
  saveTable,
  sealCalc,
  setFreightZone,
  setItemBaza,
  type TableItemEdit,
  type TableNewItem,
} from '@/modules/wms/calc/workspace';

/**
 * 0125 — the baza unit widened, against a real database (his 18a/19a/20a).
 *
 * The rules this file holds: a unit CHOSEN on an unpriced row stands across
 * Saqlash (the snap-back's second costume); «avto» is stamped from the FINAL
 * group — never from the pre-tx dictionary read; the measure pair follows
 * the law first and the BASIS second (an m² baza on an advalor code keeps
 * its m² count, and moving off m² clears and names it); a unit the law
 * cannot hold is named, never rewritten; A2's «birlikni tekshiring» looks at
 * priced rows this save re-lawed and at nothing else; every fill (memory,
 * file, dictionary) answers a chosen unit in that unit or not at all; an m³
 * declaration prices an m³ row; a retried save never writes a goods line
 * twice; and a 23514 on a widened CHECK reads «server behind» by NAME.
 *
 * Fixtures are this file's own (#183). The customs batch, the dictionary
 * baza and the sealed memory are CONFIGURATION for every later save, so all
 * three are removed in afterAll, and their names and codes appear nowhere
 * else in the suite.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
// Digits, not a random base-36 token: word_similarity can score two random
// tokens over the memory's threshold (#1250).
const tag = () => `B${SUFFIX}${String((seq += 1)).padStart(3, '0')}`;

let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const madeNames: string[] = [];
const madeBatches: string[] = [];
const madeBazaKeys: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99894${String(Date.now()).slice(-7)}`,
      fullName: `VED basis fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `VB${SUFFIX}`, name: `VED basis fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `VB-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'VED basis fixture',
      createdBy: actorId,
    })
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
  // CONFIGURATION (#183): a ready batch fills every later save's empty bazas,
  // a dictionary baza answers every later pull, and the seal taught the
  // exact-key code book.
  if (madeBatches.length > 0) {
    await db.delete(customsImportBatches).where(inArray(customsImportBatches.id, madeBatches));
  }
  if (madeBazaKeys.length > 0) {
    await db.delete(calcBazas).where(inArray(calcBazas.productKey, madeBazaKeys));
  }
  if (madeNames.length > 0) {
    await db
      .delete(tnvedAssignments)
      .where(inArray(tnvedAssignments.productKey, madeNames.map((n) => itemNameNorm(n))));
  }
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(
  items: {
    name: string;
    quantity?: number | null;
    tnvedCode?: string | null;
    weightKg?: number | null;
  }[],
) {
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

const itemRows = (requestId: string) =>
  db
    .select()
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId))
    .orderBy(calcRequestItems.seq);

async function editOf(requestId: string, seqNo: number, patch: Omit<TableItemEdit, 'id' | 'seq'>) {
  const items = await itemRows(requestId);
  const item = items.find((i) => i.seq === seqNo)!;
  return { id: item.id, seq: item.seq, ...patch };
}
const save = (requestId: string, input: { items?: TableItemEdit[]; adds?: TableNewItem[] }) =>
  saveTable(requestId, { items: input.items ?? [], adds: input.adds ?? [] }, ctx());
const rowOf = async (requestId: string, seqNo: number) =>
  (await itemRows(requestId)).find((i) => i.seq === seqNo)!;

describe('a unit CHOSEN on an unpriced row stands', () => {
  it('survives Saqlash, an unrelated save and the reload — and a price typed later keeps it', async () => {
    const id = await open([{ name: `monitor ${tag()}`, quantity: 10, tnvedCode: '8528520000' }]);
    await save(id, {});
    await save(id, { items: [await editOf(id, 1, { bazaUsd: null, bazaBasis: 'kg' })] });
    let row = await rowOf(id, 1);
    expect(row).toMatchObject({ bazaUsd: null, bazaBasis: 'kg', bazaSource: null });

    // An unrelated save does not wash it away.
    await save(id, { items: [await editOf(id, 1, { name: `monitor qayta ${tag()}` })] });
    row = await rowOf(id, 1);
    expect(row.bazaBasis).toBe('kg');
    const ws = await loadWorkspace(id);
    expect(ws!.groups[0]!.items[0]!.bazaBasis).toBe('kg');

    // A price typed with the select untouched («avto») keeps the CHOICE —
    // never the law's default over it.
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 2, bazaBasis: null })] });
    row = await rowOf(id, 1);
    expect(row).toMatchObject({ bazaUsd: '2.0000', bazaBasis: 'kg', bazaSource: 'typed' });
  });

  it('clearing the price keeps a posted unit, and null with null clears the whole pair', async () => {
    const id = await open([{ name: `televizor ${tag()}`, quantity: 5, tnvedCode: '8528520000' }]);
    await save(id, {});
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 4, bazaBasis: 'm3' })] });
    await save(id, { items: [await editOf(id, 1, { bazaUsd: null, bazaBasis: 'm3' })] });
    expect(await rowOf(id, 1)).toMatchObject({ bazaUsd: null, bazaBasis: 'm3', bazaSource: null });
    await save(id, { items: [await editOf(id, 1, { bazaUsd: null, bazaBasis: null })] });
    expect(await rowOf(id, 1)).toMatchObject({ bazaUsd: null, bazaBasis: null });
  });
});

describe('«avto» is stamped from the FINAL group', () => {
  it('an ADD with an untouched unit takes its new block’s law — kg on 5701, m² on 6907', async () => {
    const id = await open([{ name: `bor ${tag()}`, tnvedCode: '8528520000' }]);
    await save(id, {});
    const result = await save(id, {
      adds: [
        { name: `gilam ${tag()}`, tnvedCode: '5701', weightKg: 40, bazaUsd: 3, bazaBasis: null },
        { name: `kafel ${tag()}`, tnvedCode: '6907', measureQty: 100, bazaUsd: 2, bazaBasis: null },
      ],
    });
    expect(await rowOf(id, 2)).toMatchObject({ tnvedCode: '5701', bazaBasis: 'kg' });
    expect(await rowOf(id, 3)).toMatchObject({
      tnvedCode: '6907',
      bazaBasis: 'm2',
      measureUnit: 'm2',
      measureQty: '100.0000',
    });
    // The stamp IS the law's unit, so A2 has nothing to say about it.
    expect(result.basisSuspect).toEqual([]);
  });

  it('an EXISTING row recoded and priced in one save follows its new code too', async () => {
    const id = await open([{ name: `kovrik ${tag()}`, weightKg: 12 }]);
    await save(id, {
      items: [await editOf(id, 1, { tnvedCode: '5701', bazaUsd: 2, bazaBasis: null })],
    });
    expect(await rowOf(id, 1)).toMatchObject({ tnvedCode: '5701', bazaBasis: 'kg' });
  });

  it('a code that joins a group whose law a PERSON typed is stamped from that group, not the book', async () => {
    // The code is unknown to PP-3818 — the pre-tx dictionary read answers
    // nothing for it, so a stamp taken from there would say 'unit'.
    const code = `9999${SUFFIX}`;
    const id = await open([{ name: `noma'lum ${tag()}`, quantity: 3, tnvedCode: code }]);
    await save(id, {});
    const [g] = await db.select().from(calcGroups).where(eq(calcGroups.requestId, id));
    // A typed law on the block: max 10 % / min $0.5 per kg.
    await db
      .update(calcGroups)
      .set({ dutyMode: 'max', dutySpecific: '0.5000', dutyUnit: 'kg', rateSource: 'typed' })
      .where(eq(calcGroups.id, g!.id));
    await save(id, {
      adds: [{ name: `noma'lum ikki ${tag()}`, tnvedCode: code, weightKg: 8, bazaUsd: 5, bazaBasis: null }],
    });
    expect(await rowOf(id, 2)).toMatchObject({ groupId: g!.id, bazaBasis: 'kg' });
  });
});

describe('the measure pair follows the law first, then the BASIS', () => {
  it('an m² baza on an advalor code keeps its m² count and prices', async () => {
    const id = await open([{ name: `linoleum ${tag()}`, tnvedCode: '8528520000' }]);
    await save(id, {});
    const result = await save(id, {
      items: [await editOf(id, 1, { bazaUsd: 2, bazaBasis: 'm2', measureQty: 30 })],
    });
    expect(result.measuresDropped).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ measureUnit: 'm2', measureQty: '30.0000' });
    const ws = await loadWorkspace(id);
    // value 30 m² × $2 = 60; advalor 10 % = 6; VAT 12 % of 66 = 7.92.
    expect(ws!.groups[0]!.customs).toMatchObject({ ok: true, valueUsd: 60, dutyUsd: 6 });
  });

  it('moving the basis off m² clears the count and NAMES the row', async () => {
    const id = await open([{ name: `parket ${tag()}`, tnvedCode: '8528520000', weightKg: 90 }]);
    await save(id, {});
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 2, bazaBasis: 'm2', measureQty: 30 })] });
    const result = await save(id, { items: [await editOf(id, 1, { bazaUsd: 2, bazaBasis: 'kg' })] });
    expect(result.measuresCleared).toEqual([1]);
    expect(await rowOf(id, 1)).toMatchObject({ bazaBasis: 'kg', measureUnit: null, measureQty: null });
  });

  it('a recode under an m² basis to a JUFT code is a named conflict — never rewritten', async () => {
    const id = await open([{ name: `tufli ${tag()}`, tnvedCode: '8528520000' }]);
    await save(id, {});
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 9, bazaBasis: 'm2', measureQty: 40 })] });
    const result = await save(id, { items: [await editOf(id, 1, { tnvedCode: '6403' })] });
    expect(result.basisConflict).toEqual([1]);
    // The law's own pair stands: «40 m²» was a statement in m², not in juft.
    expect(result.measuresCleared).toEqual([1]);
    const row = await rowOf(id, 1);
    expect(row).toMatchObject({ tnvedCode: '6403', bazaBasis: 'm2', measureUnit: null });
    // …and the engine refuses NAMING the row until a unit that fits is picked.
    const ws = await loadWorkspace(id);
    const g = ws!.groups.find((x) => x.tnvedCode === '6403')!;
    expect(g.customs).toMatchObject({ ok: false, reason: 'measure_missing', itemLabel: row.name });
  });
});

describe('a pair the row STATES survives every unrelated Saqlash (2026-10-09, judge TT-3/MR-3/S2)', () => {
  // This file opens more requests than one requester may hold open
  // (MAX_OPEN_PER_REQUESTER); the block closes its own when it is done so the
  // files after it are not refused `too_many_open` by this one.
  const opened: string[] = [];
  afterEach(async () => {
    const mine = madeRequests.filter((r) => !opened.includes(r));
    if (mine.length === 0) return;
    opened.push(...mine);
    await db.update(calcRequests).set({ completedAt: new Date() }).where(inArray(calcRequests.id, mine));
  });
  beforeAll(() => {
    opened.push(...madeRequests);
  });
  /** What the seller's door writes for «Kafel 120 m²» — the pair, no count. */
  const statePair = (requestId: string, seqNo: number, unit: 'm2' | 'litr' | 'sm3', qty: number) =>
    db
      .update(calcRequestItems)
      .set({ measureUnit: unit, measureQty: qty.toFixed(4), quantity: null })
      .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, seqNo)));

  it('an UNCODED «Kafel 120 m²» waits for its code untouched — then prices per m² by itself', async () => {
    const id = await open([{ name: `kafel ${tag()}` }]);
    await statePair(id, 1, 'm2', 120);
    const first = await save(id, {});
    await save(id, { adds: [{ name: `boshqa ${tag()}`, quantity: 3 }] });
    expect(first.measuresCleared).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ measureUnit: 'm2', measureQty: '120.0000' });

    // Coded onto an ADVALOR law and priced with the select untouched: «avto»
    // is the unit the row states, and the value is 120 m² × $2.
    const coded = await save(id, {
      items: [await editOf(id, 1, { tnvedCode: '8528520000', bazaUsd: 2, bazaBasis: null })],
    });
    expect(coded.measuresCleared).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ bazaBasis: 'm2', measureUnit: 'm2', measureQty: '120.0000' });
    const ws = await loadWorkspace(id);
    const g = ws!.groups.find((x) => x.tnvedCode === '8528520000')!;
    expect(g.customs).toMatchObject({ ok: true, valueUsd: 240 });
  });

  it('an uncoded car’s «1500 sm³» waits for its code — sm³ is no baza, so only «no law yet» keeps it', async () => {
    // `autoBasisFor` never answers sm³ (nobody VALUES a car by displacement,
    // #868), so the stated-pair reading cannot hold this one: the row with no
    // group must keep its pair because its law is simply not known yet.
    const id = await open([{ name: `avtomobil ${tag()}`, quantity: 1 }]);
    await statePair(id, 1, 'sm3', 1500);
    await db.update(calcRequestItems).set({ quantity: '1.000' }).where(eq(calcRequestItems.requestId, id));
    const first = await save(id, {});
    expect(first.measuresCleared).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ measureUnit: 'sm3', measureQty: '1500.0000' });
    // Coded onto a law that counts in sm³: the statement IS the law's figure.
    const coded = await save(id, { items: [await editOf(id, 1, { tnvedCode: '8701299090' })] });
    expect(coded.measuresCleared).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ measureUnit: 'sm3', measureQty: '1500.0000' });
  });

  it('«Lak 50 litr» on an advalor code survives two presses with no price on it', async () => {
    const id = await open([{ name: `lak ${tag()}`, tnvedCode: '8528520000' }]);
    await save(id, {});
    await statePair(id, 1, 'litr', 50);
    const a = await save(id, {});
    const b = await save(id, { items: [await editOf(id, 1, { name: `lak qayta ${tag()}` })] });
    expect([...a.measuresCleared, ...b.measuresCleared]).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ measureUnit: 'litr', measureQty: '50.0000' });
  });

  it('a law that counts in ANOTHER pair unit still clears and names it — a statement in m² is not juft', async () => {
    const id = await open([{ name: `poyabzal ${tag()}`, tnvedCode: '8528520000' }]);
    await save(id, {});
    await statePair(id, 1, 'm2', 40);
    const result = await save(id, { items: [await editOf(id, 1, { tnvedCode: '6403' })] });
    expect(result.measuresCleared).toEqual([1]);
    expect(await rowOf(id, 1)).toMatchObject({ measureUnit: null, measureQty: null });
  });

  it('a VED’s CHOSEN unit outranks the statement — the old named clear still holds', async () => {
    const id = await open([{ name: `gilamcha ${tag()}`, tnvedCode: '8528520000', weightKg: 30 }]);
    await save(id, {});
    await statePair(id, 1, 'm2', 25);
    const result = await save(id, { items: [await editOf(id, 1, { bazaUsd: 4, bazaBasis: 'kg' })] });
    expect(result.measuresCleared).toEqual([1]);
    expect(await rowOf(id, 1)).toMatchObject({ bazaBasis: 'kg', measureUnit: null });
  });
});

describe('the screen’s units reach the row (2026-10-09, P3: S2, UX12, MR-17) and old rows heal (P3.4)', () => {
  // Same reason as the block above: this file outgrows one requester's open
  // cap, so each test closes the request it opened.
  const opened: string[] = [];
  afterEach(async () => {
    const mine = madeRequests.filter((r) => !opened.includes(r));
    if (mine.length === 0) return;
    opened.push(...mine);
    await db.update(calcRequests).set({ completedAt: new Date() }).where(inArray(calcRequests.id, mine));
  });
  beforeAll(() => {
    opened.push(...madeRequests);
  });
  /** A row as the doors stored it BEFORE they learned units: the number in
   * the piece column, the seller's word beside it. */
  const storeOldShape = (requestId: string, seqNo: number, quantity: number, unit: string) =>
    db
      .update(calcRequestItems)
      .set({ quantity: quantity.toFixed(3), unit, measureUnit: null, measureQty: null, weightKg: null })
      .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, seqNo)));

  it('a pasted uncoded «Kafel 120 m²» is STORED in m² — the unit rides the add', async () => {
    const id = await open([{ name: `bor ${tag()}`, quantity: 1 }]);
    const result = await save(id, { adds: [{ name: `kafel ${tag()}`, measureQty: 120, measureUnit: 'm2' }] });
    expect(result.measuresDropped).toEqual([]);
    expect(await rowOf(id, 2)).toMatchObject({ measureUnit: 'm2', measureQty: '120.0000', quantity: null });
  });

  it('a pair the code contradicts is dropped and NAMED — 40 m² is not 40 juft', async () => {
    const id = await open([{ name: `bor ${tag()}`, quantity: 1 }]);
    const result = await save(id, {
      adds: [{ name: `tufli ${tag()}`, tnvedCode: '6403', measureQty: 40, measureUnit: 'm2' }],
    });
    expect(result.measuresDropped).toEqual([2]);
    expect(await rowOf(id, 2)).toMatchObject({ measureUnit: null, measureQty: null });
  });

  it('an old row with «120» under «m2» in the piece column moves to the pair on the next Saqlash', async () => {
    const id = await open([{ name: `plitka ${tag()}`, quantity: 1 }]);
    await storeOldShape(id, 1, 120, 'm2');
    const result = await save(id, {});
    expect(result.unitsMoved).toEqual([{ seq: 1, to: 'm2', note: 'sotuvchi: 120 m2' }]);
    const row = await rowOf(id, 1);
    expect(row).toMatchObject({ quantity: null, unit: null, measureUnit: 'm2', measureQty: '120.0000' });
    expect(row.note).toContain('sotuvchi: 120 m2');
    // Once moved, the word is gone — a second press moves nothing.
    expect((await save(id, {})).unitsMoved).toEqual([]);
  });

  /**
   * The heal is decided on the row AS STORED — the row the screen's sentence
   * described (UX7). A count the VED types in that save stays his, and the
   * seller's figure still leaves the piece column: the first build skipped
   * the heal on such a row, which left «300» under «kg» and moved the VED's
   * 300 pieces into the weight on the NEXT press (judge MR-4's own shape,
   * deferred by one save).
   */
  it('«500» under «kg» moves to the weight; a count typed in the same save stays the VED’s — and the next save moves nothing', async () => {
    const id = await open([{ name: `kurtka ${tag()}`, quantity: 1 }, { name: `shim ${tag()}`, quantity: 1 }]);
    await storeOldShape(id, 1, 500, 'kg');
    await storeOldShape(id, 2, 500, 'kg');
    const result = await save(id, { items: [await editOf(id, 2, { quantity: 300 })] });
    expect(result.unitsMoved.map((m) => m.seq)).toEqual([1, 2]);
    expect(await rowOf(id, 1)).toMatchObject({ quantity: null, weightKg: '500.000', unit: null });
    expect(await rowOf(id, 2)).toMatchObject({ quantity: '300.000', weightKg: '500.000', unit: null });
    expect((await save(id, {})).unitsMoved).toEqual([]);
    expect(await rowOf(id, 2)).toMatchObject({ quantity: '300.000', weightKg: '500.000' });
  });

  it('a weight the VED typed over a pending «500 kg» stands, and the seller’s figure goes to the note', async () => {
    const id = await open([{ name: `palto ${tag()}`, quantity: 1 }]);
    await storeOldShape(id, 1, 500, 'kg');
    await save(id, { items: [await editOf(id, 1, { weightKg: 480 })] });
    const row = await rowOf(id, 1);
    expect(row).toMatchObject({ quantity: null, weightKg: '480.000', unit: null });
    expect(row.note).toContain('sotuvchi: 500 kg (qatorda 480 kg)');
  });

  it('«Bu karobka» empties the count: the word answers for good and the seller’s figure is kept in the note', async () => {
    const id = await open([{ name: `ko‘ylak ${tag()}`, quantity: 1 }]);
    await storeOldShape(id, 1, 12, 'karobka');
    const answered = await save(id, { items: [await editOf(id, 1, { quantity: null })] });
    expect(answered.sellerUnitUnresolved).toEqual([]);
    const row = await rowOf(id, 1);
    expect(row).toMatchObject({ quantity: null, unit: null });
    expect(row.note).toContain('sotuvchi: 12 karobka');
    // The real count typed afterwards is just a count.
    await save(id, { items: [await editOf(id, 1, { quantity: 240 })] });
    expect(await rowOf(id, 1)).toMatchObject({ quantity: '240.000', unit: null });
  });

  it('a carton count is never guessed: named, and «Bu dona» dismisses the word for good', async () => {
    const id = await open([{ name: `futbolka ${tag()}`, quantity: 1 }]);
    await storeOldShape(id, 1, 20, 'karobka');
    const first = await save(id, {});
    expect(first.unitsMoved).toEqual([]);
    expect(first.sellerUnitUnresolved).toEqual([{ seq: 1, word: 'karobka' }]);
    expect(await rowOf(id, 1)).toMatchObject({ quantity: '20.000', unit: 'karobka' });
    const dismissed = await save(id, { items: [await editOf(id, 1, { unit: null })] });
    expect(dismissed.sellerUnitUnresolved).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ quantity: '20.000', unit: null });
    expect((await save(id, {})).sellerUnitUnresolved).toEqual([]);
  });

  it('«Bu dona» on a pending «300 kg» keeps 300 as the count — a dismissed word is never moved', async () => {
    const id = await open([{ name: `stul ${tag()}`, quantity: 1 }]);
    await storeOldShape(id, 1, 300, 'kg');
    const result = await save(id, { items: [await editOf(id, 1, { unit: null })] });
    expect(result.unitsMoved).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ quantity: '300.000', weightKg: null, unit: null });
  });

  /**
   * Review heal-server: the heal moved a number into a pair the measure pass
   * then CLEARED — «120 m2» under a per-kg code (9403, «15 %, kamida
   * $0.4/kg») left the piece column and vanished. Such a row is asked now:
   * the number stays where it is and the row is named.
   */
  it('«120 m2» under a per-kg code is ASKED, never moved into a pair the pass clears', async () => {
    const id = await open([{ name: `stol plitasi ${tag()}`, tnvedCode: '9403200000', quantity: 1 }]);
    await save(id, {});
    await storeOldShape(id, 1, 120, 'm2');
    const result = await save(id, {});
    expect(result.unitsMoved).toEqual([]);
    expect(result.measuresCleared).toEqual([]);
    expect(result.sellerUnitUnresolved).toEqual([{ seq: 1, word: 'm2' }]);
    expect(await rowOf(id, 1)).toMatchObject({ quantity: '120.000', unit: 'm2', measureQty: null });
  });

  /**
   * Review heal-server: a count typed on a PRICED old row left the seller's
   * word standing, so the row turned «pending» the moment the price was
   * cleared and the next save moved the VED's count under the seller's name.
   * The count retires the word; the seller's figure goes to the note.
   */
  it('a count typed on a priced old row retires the word — clearing the price later moves nothing', async () => {
    const id = await open([{ name: `stakan ${tag()}`, quantity: 1 }]);
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 2, bazaBasis: 'unit' })] });
    await storeOldShape(id, 1, 120, 'm2');
    await save(id, { items: [await editOf(id, 1, { quantity: 300 })] });
    const row = await rowOf(id, 1);
    expect(row).toMatchObject({ quantity: '300.000', unit: null, measureQty: null });
    expect(row.note).toContain('sotuvchi: 120 m2');
    const cleared = await save(id, { items: [await editOf(id, 1, { bazaUsd: null, bazaBasis: null })] });
    expect(cleared.unitsMoved).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ quantity: '300.000', measureQty: null });
  });

  it('a priced or confirmed row is never healed', async () => {
    const id = await open([{ name: `oyna ${tag()}`, quantity: 1, tnvedCode: '8528520000' }]);
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 3, bazaBasis: 'unit' })] });
    await storeOldShape(id, 1, 120, 'm2');
    expect((await save(id, {})).unitsMoved).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ quantity: '120.000', unit: 'm2' });
  });

  /**
   * P3.8's invariant (#886): the blocks the live bar prices are the blocks
   * the save produces — asked of the real saveTable + loadWorkspace, not of
   * a restated rule.
   */
  it('the live membership of a drafted re-code is what the save then stores', async () => {
    const id = await open([
      { name: `stol ${tag()}`, tnvedCode: '9403600000', quantity: 2 },
      { name: `kreslo ${tag()}`, tnvedCode: '9401610000', quantity: 3 },
      { name: `lampa ${tag()}`, quantity: 1 },
    ]);
    await save(id, {});
    const before = (await loadWorkspace(id))!;
    const all = [...before.groups.flatMap((g) => g.items), ...before.ungrouped];
    const second = all.find((i) => i.seq === 2)!;
    const third = all.find((i) => i.seq === 3)!;
    const drafts = { [second.id]: { tnvedCode: '9403600000' }, [third.id]: { tnvedCode: '9401610000' } };
    const live = liveMembership(all, drafts, new Map(before.groups.map((g) => [g.id, g])), groupsByCodeOf(before.groups));
    expect(live.unsavedCode).toBe(false);

    await save(id, {
      items: [
        { id: second.id, seq: 2, tnvedCode: '9403600000' },
        { id: third.id, seq: 3, tnvedCode: '9401610000' },
      ],
    });
    const after = (await loadWorkspace(id))!;
    const saved = new Map(after.groups.map((g) => [g.tnvedCode, g.items.map((i) => i.id).sort()]));
    for (const g of before.groups) {
      const predicted = (live.members.get(g.id) ?? []).map((i) => i.id).sort();
      if (predicted.length === 0) expect(saved.has(g.tnvedCode)).toBe(false);
      else expect(saved.get(g.tnvedCode)).toEqual(predicted);
    }
    expect(after.ungrouped.length).toBe(live.ungrouped.length);
  });

  it('«avto» stores the unit the screen SHOWED; with none shown the stamp is named', async () => {
    const id = await open([
      { name: `sim ${tag()}`, tnvedCode: '8528520000', weightKg: 40 },
      { name: `sim ikki ${tag()}`, tnvedCode: '8528520000', weightKg: 40 },
    ]);
    await save(id, {});
    // A weight-only advalor row: «avto» by the figures is kg. The screen
    // showed «dona» — the price was typed against dona, so it stays dona.
    const shown = await save(id, {
      items: [await editOf(id, 1, { bazaUsd: 5, bazaBasis: null, shownBasis: 'unit' })],
    });
    expect(shown.basisStamped).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ bazaBasis: 'unit' });
    const silent = await save(id, { items: [await editOf(id, 2, { bazaUsd: 5, bazaBasis: null })] });
    expect(silent.basisStamped).toEqual([{ seq: 2, basis: 'kg' }]);
    expect(await rowOf(id, 2)).toMatchObject({ bazaBasis: 'kg' });
  });

  it('a shown unit the final law cannot hold is refused naming the row', async () => {
    const id = await open([{ name: `etik ${tag()}`, tnvedCode: '6403', quantity: 10 }]);
    await save(id, {});
    await expect(
      save(id, { items: [await editOf(id, 1, { bazaUsd: 5, bazaBasis: null, shownBasis: 'm2' })] }),
    ).rejects.toMatchObject({ code: 'basis_shown_changed', seq: 1 });
    expect(await rowOf(id, 1)).toMatchObject({ bazaUsd: null });
  });
});

describe('A2: «birlikni tekshiring» — priced rows this save re-lawed, and nothing else', () => {
  it('names a priced row recoded onto a law that counts in another unit, once', async () => {
    const id = await open([{ name: `stul ${tag()}`, quantity: 4, weightKg: 20, tnvedCode: '8528520000' }]);
    await save(id, {});
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 10, bazaBasis: null })] });
    // Stamped per dona under the advalor code.
    expect((await rowOf(id, 1)).bazaBasis).toBe('unit');
    const recode = await save(id, { items: [await editOf(id, 1, { tnvedCode: '5701' })] });
    // A2: the price was typed per dona and stays per dona — named.
    expect(recode.basisSuspect).toEqual([1]);
    expect((await rowOf(id, 1)).bazaBasis).toBe('unit');
    // A later save that does not touch the law is not news.
    const later = await save(id, { items: [await editOf(id, 1, { note: 'tekshirildi' })] });
    expect(later.basisSuspect).toEqual([]);
  });

  it('an UNPRICED row recoded is never named — it follows the new code at its first price', async () => {
    const id = await open([{ name: `stol ${tag()}`, weightKg: 30, tnvedCode: '8528520000' }]);
    await save(id, {});
    const recode = await save(id, { items: [await editOf(id, 1, { tnvedCode: '5701' })] });
    expect(recode.basisSuspect).toEqual([]);
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 1, bazaBasis: null })] });
    expect((await rowOf(id, 1)).bazaBasis).toBe('kg');
  });
});

describe('every fill answers a CHOSEN unit in that unit or not at all', () => {
  const code = `9998${SUFFIX}`;
  let batchId = '';
  const fileName = (what: string) => `kub tovar ${SUFFIX} ${what}`;

  beforeAll(async () => {
    // A ready quarter, newest by upload time — CONFIGURATION, removed in
    // afterAll. One code, one name, priced per m³ AND per kg.
    const [batch] = await db
      .insert(customsImportBatches)
      .values({ fileName: `basis-${SUFFIX}.xlsx`, uploadedBy: actorId, status: 'ready' })
      .returning({ id: customsImportBatches.id });
    batchId = batch!.id;
    madeBatches.push(batchId);
    const name = fileName('vaza');
    await db.insert(customsImportRows).values([
      { batchId, tnvedCode: code, name, nameNorm: normalizeName(name), unit: 'm3', pricePerUnitUsd: '40.0000' },
      { batchId, tnvedCode: code, name, nameNorm: normalizeName(name), unit: 'kg', pricePerUnitUsd: '3.0000' },
    ]);
  });

  it('an m³ declaration prices a row priced per m³ — chosen, or stating only its kub', async () => {
    const id = await open([
      // Chosen m³, though the row also states a weight (kg would come first).
      { name: fileName('vaza'), tnvedCode: code, weightKg: 10 },
      // No choice, no weight, no count — only a kub.
      { name: fileName('vaza'), tnvedCode: code },
      // No choice, a weight and a kub: kilograms first.
      { name: fileName('vaza'), tnvedCode: code, weightKg: 10 },
    ]);
    await save(id, {
      items: [
        await editOf(id, 1, { volumeM3: 2, bazaUsd: null, bazaBasis: 'm3' }),
        await editOf(id, 2, { volumeM3: 2 }),
        await editOf(id, 3, { volumeM3: 2 }),
      ],
    });
    expect(await rowOf(id, 1)).toMatchObject({ bazaUsd: '40.0000', bazaBasis: 'm3', bazaSource: 'import' });
    expect(await rowOf(id, 2)).toMatchObject({ bazaUsd: '40.0000', bazaBasis: 'm3', bazaSource: 'import' });
    expect(await rowOf(id, 3)).toMatchObject({ bazaUsd: '3.0000', bazaBasis: 'kg', bazaSource: 'import' });
    // The code is unknown to the book, so its block carries no rates — type
    // them, and the m³ rows PRICE from their own kub.
    const [g] = await db.select().from(calcGroups).where(eq(calcGroups.requestId, id));
    await db
      .update(calcGroups)
      .set({ dutyPct: '10.000', vatPct: '12.000', rateSource: 'typed' })
      .where(eq(calcGroups.id, g!.id));
    const ws = await loadWorkspace(id);
    // 2 m³ × $40 = 80 for each m³ row; 10 kg × $3 = 30 for the kg one.
    expect(ws!.groups[0]!.customs).toMatchObject({ ok: true, valueUsd: 190 });
  });

  it('a chosen unit the file does not hold is left EMPTY for the VED', async () => {
    const id = await open([{ name: fileName('vaza'), tnvedCode: code, quantity: 5, weightKg: 10 }]);
    // Chosen per dona: the file has m³ and kg only.
    const result = await save(id, { items: [await editOf(id, 1, { bazaUsd: null, bazaBasis: 'unit' })] });
    expect(result.importFilled).toEqual([]);
    expect(await rowOf(id, 1)).toMatchObject({ bazaUsd: null, bazaBasis: 'unit' });
  });

  it('the sealed memory answers a chosen unit only in that unit', async () => {
    const name = `pechenye ${tag()}`;
    // One sealed, confirmed job about this product — per dona at $22.
    const sealed = await open([{ name, quantity: 100 }]);
    await save(sealed, { items: [await editOf(sealed, 1, { tnvedCode: '8528520000' })] });
    await save(sealed, { items: [await editOf(sealed, 1, { bazaUsd: 22, bazaBasis: 'unit' })] });
    await setFreightZone(sealed, 'cn', ctx());
    await confirmAllGroups(sealed, ctx());
    await sealCalc(
      sealed,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );

    // A later job: one row per KG by the VED's choice, one with no choice.
    const later = await open([
      { name, quantity: 10, weightKg: 4 },
      { name, quantity: 10, weightKg: 4 },
    ]);
    await save(later, { items: [await editOf(later, 1, { bazaUsd: null, bazaBasis: 'kg' })] });
    await save(later, {});
    expect(await rowOf(later, 1)).toMatchObject({ bazaUsd: null, bazaBasis: 'kg' });
    expect(await rowOf(later, 2)).toMatchObject({ bazaUsd: '22.0000', bazaBasis: 'unit', bazaSource: 'memory' });
  });

  it('the dictionary pull skips a row whose chosen unit the book does not price in', async () => {
    const name = `dict tovar ${tag()}`;
    madeBazaKeys.push(productKey(name));
    const id = await open([
      { name, quantity: 3, weightKg: 6 },
      { name, quantity: 3, weightKg: 6 },
    ]);
    await save(id, { items: [await editOf(id, 1, { bazaUsd: null, bazaBasis: 'kg' })] });
    // The book row is written AFTER the save (round 2, docs/SAKKIZ-R2.md
    // §7.2): every save now fills a baza-less row from the book by itself, so
    // a book row standing before it would have filled row 2 already and left
    // the PULL nothing to do — and this test is about the pull's own rule.
    await saveBaza(
      { name, label: name, tnvedCode: null, bazaUsd: 5, basis: 'unit', effectiveDate: '2026-01-01', note: null },
      ctx(),
    );
    const out = await pullBazasFromDictionary(id, ctx());
    expect(out).toEqual({ filled: 1, skipped: 1 });
    expect(await rowOf(id, 1)).toMatchObject({ bazaUsd: null, bazaBasis: 'kg' });
    expect(await rowOf(id, 2)).toMatchObject({ bazaUsd: '5.0000', bazaBasis: 'unit', bazaSource: 'dictionary' });
  });
});

describe('setItemBaza — the fifth writer, on the table’s rule', () => {
  it('a price with no unit is «avto» from the group; a unit with no price is a choice', async () => {
    const id = await open([{ name: `gilam ${tag()}`, weightKg: 7, tnvedCode: '5701' }]);
    await save(id, {});
    await setItemBaza(id, 1, { bazaUsd: 4, basis: null, source: 'typed' }, ctx());
    expect(await rowOf(id, 1)).toMatchObject({ bazaUsd: '4.0000', bazaBasis: 'kg' });
    await setItemBaza(id, 1, { bazaUsd: null, basis: 'm3', source: 'typed' }, ctx());
    expect(await rowOf(id, 1)).toMatchObject({ bazaUsd: null, bazaBasis: 'm3', bazaSource: null });
  });
});

describe('phase 0: a retried save never writes a goods line twice', () => {
  it('the same client id twice is ONE row, and the retry reads as a save', async () => {
    const id = await open([{ name: `bor ${tag()}` }]);
    const clientId = crypto.randomUUID();
    const add: TableNewItem = { clientId, name: `qayta ${tag()}`, quantity: 2 };
    const first = await save(id, { adds: [add] });
    expect(first).toMatchObject({ added: 1, alreadySaved: 0 });
    // The answer was «lost» — the screen presses again with the same row.
    const second = await save(id, { adds: [add] });
    expect(second).toMatchObject({ added: 0, alreadySaved: 1 });
    const rows = await itemRows(id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.seq === 2)!.id).toBe(clientId);
    // And twice inside ONE post is one row too.
    const twin = crypto.randomUUID();
    const both = await save(id, {
      adds: [
        { clientId: twin, name: `egizak ${tag()}` },
        { clientId: twin, name: `egizak ${tag()}` },
      ],
    });
    expect(both).toMatchObject({ added: 1, alreadySaved: 1 });
    expect(await itemRows(id)).toHaveLength(3);
  });

  it('a retry carrying a CORRECTION applies it; an empty price on a retry means «nothing typed» (review units-1)', async () => {
    // ONE request, closed at the end: this file opens up to the requester's
    // open-request cap, and a test that leaves one more open breaks the last.
    const id = await open([{ name: `bor ${tag()}` }]);
    const clientId = crypto.randomUUID();
    const add: TableNewItem = { clientId, name: `kurtka ${tag()}`, quantity: 4, bazaUsd: 10, bazaBasis: 'kg' };
    await save(id, { adds: [add] });
    // The answer was lost; the VED fixes the price before pressing again —
    // the row is EDITED, never skipped with the correction dropped.
    const retry = await save(id, { adds: [{ ...add, bazaUsd: 12 }] });
    expect(retry).toMatchObject({ added: 0, alreadySaved: 0 });
    expect(await itemRows(id)).toHaveLength(2);
    expect(await rowOf(id, 2)).toMatchObject({ id: clientId, bazaUsd: '12.0000', bazaBasis: 'kg', bazaSource: 'typed' });
    // An unchanged retry still writes nothing and reads as a save.
    expect(await save(id, { adds: [{ ...add, bazaUsd: 12 }] })).toMatchObject({ added: 0, alreadySaved: 1 });

    // A machine-filled price (the first save's memory fill) is not wiped by
    // a retry whose cell was simply never typed in.
    const filled = crypto.randomUUID();
    const plain: TableNewItem = { clientId: filled, name: `xotira ${tag()}`, quantity: 3 };
    await save(id, { adds: [plain] });
    await db
      .update(calcRequestItems)
      .set({ bazaUsd: '7.5000', bazaBasis: 'unit', bazaSource: 'memory' })
      .where(eq(calcRequestItems.id, filled));
    expect(await save(id, { adds: [plain] })).toMatchObject({ added: 0, alreadySaved: 1 });
    expect(await rowOf(id, 3)).toMatchObject({ bazaUsd: '7.5000', bazaBasis: 'unit', bazaSource: 'memory' });
    // …while a price the PERSON typed and emptied before the retry goes.
    await save(id, { adds: [{ ...add, bazaUsd: null, bazaBasis: null }] });
    expect(await rowOf(id, 2)).toMatchObject({ bazaUsd: null, bazaBasis: null });
    await db.update(calcRequests).set({ completedAt: new Date() }).where(eq(calcRequests.id, id));
  });

  it('another request’s row id is refused, and so is a string that is no id at all', async () => {
    const mine = await open([{ name: `meniki ${tag()}` }]);
    const theirs = await open([{ name: `boshqaniki ${tag()}` }]);
    const [foreign] = await itemRows(theirs);
    await expect(save(mine, { adds: [{ clientId: foreign!.id, name: `teleport ${tag()}` }] })).rejects.toMatchObject({
      code: 'not_found',
      seq: -1,
    });
    await expect(save(mine, { adds: [{ clientId: 'not-a-uuid', name: `buzuq ${tag()}` }] })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await itemRows(mine)).toHaveLength(1);
  });
});

describe('a 23514 on a widened CHECK is «server behind» — by name, from a real refusal', () => {
  it('the basis CHECK’s own refusal matches; the pair CHECK’s does not', async () => {
    const id = await open([{ name: `cheklov ${tag()}` }]);
    const [row] = await itemRows(id);
    // A value the WIDENED list still refuses stands in for «m³ on the old
    // CHECK» — same constraint, same code, same driver shape.
    const basisErr = await db
      .update(calcRequestItems)
      .set({ bazaBasis: 'm4' })
      .where(eq(calcRequestItems.id, row!.id))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(basisErr).not.toBeNull();
    expect(isBehindOnBasisCheck(basisErr)).toBe(true);

    const pairErr = await db
      .update(calcRequestItems)
      .set({ measureUnit: 'm2' })
      .where(eq(calcRequestItems.id, row!.id))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(pairErr).not.toBeNull();
    expect(isBehindOnBasisCheck(pairErr)).toBe(false);
  });
});
