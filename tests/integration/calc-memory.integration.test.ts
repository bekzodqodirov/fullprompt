import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  deals,
  dealStages,
  events,
  tasks,
  tnvedAssignments,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { itemNameNorm, sealedMemoryFor, NO_REQUEST } from '@/modules/wms/calc/memory';
import {
  confirmAllGroups,
  loadWorkspace,
  saveTable,
  sealCalc,
  setFreightZone,
  type TableItemEdit,
} from '@/modules/wms/calc/workspace';

/**
 * The AI-VED's memory: what this company has SEALED answers the next job
 * (0096, the owner's «shu muhrlangan datani AI xotirasiga qo'yish kerak»).
 *
 * Everything here is measured against a real database, because every rule
 * this round adds is a rule about rows: which seals count as memory, what a
 * memory-filled row is wearing afterwards, and what the seal teaches the
 * exact-key code book.
 *
 * Fixtures are this file's own (#183) and the seal path leans on the SEEDED
 * PP-3818 rates, exactly as `calc-seal` does — that book is what production
 * prices from.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `MEM-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const madeNames: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99893${String(Date.now()).slice(-7)}`,
      fullName: `VED memory fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `MM${SUFFIX}`, name: `VED memory fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `MM-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'VED memory fixture',
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
  // The seal TEACHES the exact-key code book, and a `tnved_assignments` row
  // is CONFIGURATION for every later spec (#183) — it prefills codes at
  // intake for anybody who happens to use the same product name.
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

async function open(items: { name: string; quantity?: number | null }[]) {
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

const save = (requestId: string, items: TableItemEdit[] = []) =>
  saveTable(requestId, { items, adds: [] }, ctx());

/** One priced, confirmed, SEALED job about `name` — the memory's raw material. */
async function sealOne(name: string, bazaUsd: number) {
  const id = await open([{ name, quantity: 100 }]);
  await save(id, [await editOf(id, 1, { tnvedCode: '8528520000' })]);
  await save(id, [await editOf(id, 1, { bazaUsd, bazaBasis: 'unit' })]);
  await setFreightZone(id, 'cn', ctx());
  await confirmAllGroups(id, ctx());
  await sealCalc(
    id,
    { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
    ctx(),
  );
  return id;
}

describe('what the company sealed is what the machine reads first', () => {
  it('a sealed, confirmed row answers a later job by name — code AND baza', async () => {
    const name = `pechenye ${tag()}`;
    const sealedId = await sealOne(name, 22);

    const hits = await sealedMemoryFor([name], { excludeRequestId: NO_REQUEST });
    const hit = hits.get(itemNameNorm(name));
    expect(hit, 'the sealed row must be findable by its own name').toBeTruthy();
    expect(hit!.tnvedCode).toBe('8528520000');
    expect(hit!.bazaUsd).toBe(22);
    expect(hit!.bazaBasis).toBe('unit');
    expect(hit!.sealedByName).toContain('VED memory fixture');
    // It excludes what it is asked to exclude — the request's own rows must
    // never answer about themselves.
    const none = await sealedMemoryFor([name], { excludeRequestId: sealedId });
    expect(none.size).toBe(0);
  });

  it('an UNSEALED job of the same name is not memory', async () => {
    const name = `konfet ${tag()}`;
    const open1 = await open([{ name, quantity: 10 }]);
    await save(open1, [await editOf(open1, 1, { tnvedCode: '8528520000' })]);
    await save(open1, [await editOf(open1, 1, { bazaUsd: 44, bazaBasis: 'unit' })]);

    const hits = await sealedMemoryFor([name], { excludeRequestId: NO_REQUEST });
    expect(hits.size, 'a price nobody sealed is nobody’s answer').toBe(0);
  });

  it('the save fills a baza-less row from the seal and wears the 🧠 provenance', async () => {
    const name = `choynak ${tag()}`;
    const sealedId = await sealOne(name, 17);
    const [sealedItem] = await itemRows(sealedId);

    // A second job about the same product. The code is typed (the memory's
    // code half is the prefill's job); the BAZA is what the save must find.
    const second = await open([{ name, quantity: 5 }]);
    const out = await save(second, [await editOf(second, 1, { tnvedCode: '8528520000' })]);
    expect(out.memoryFilled).toEqual([1]);

    const [row] = await itemRows(second);
    expect(Number(row!.bazaUsd)).toBe(17);
    expect(row!.bazaBasis).toBe('unit');
    expect(row!.bazaSource).toBe('memory');
    expect(row!.memoryItemId).toBe(sealedItem!.id);
    expect(row!.importRowId).toBeNull();

    // And the ✅ records that a person looked at a price they did not state.
    const ws = await loadWorkspace(second);
    expect(ws!.groups[0]!.warnings).toContain('baza_from_memory');
    expect(ws!.groups[0]!.items[0]!.memoryFrom!.sealedByName).toContain('VED memory fixture');
  });

  it('a price the VED types wins over the memory, and drops its provenance', async () => {
    const name = `damlama ${tag()}`;
    await sealOne(name, 31);

    const second = await open([{ name, quantity: 5 }]);
    await save(second, [await editOf(second, 1, { tnvedCode: '8528520000' })]);
    const filled = (await itemRows(second))[0]!;
    expect(filled.bazaSource).toBe('memory');

    await save(second, [await editOf(second, 1, { bazaUsd: 99, bazaBasis: 'unit' })]);
    const typed = (await itemRows(second))[0]!;
    expect(Number(typed.bazaUsd)).toBe(99);
    expect(typed.bazaSource).toBe('typed');
    // #896's rule: the provenance goes with the price it explained.
    expect(typed.memoryItemId).toBeNull();
    const ws = await loadWorkspace(second);
    expect(ws!.groups[0]!.warnings).not.toContain('baza_from_memory');
  });

  it('the seal teaches the exact-key code book', async () => {
    const name = `Sovun   ${tag()}`;
    await sealOne(name, 12);
    const [row] = await db
      .select()
      .from(tnvedAssignments)
      .where(eq(tnvedAssignments.productKey, itemNameNorm(name)));
    expect(row, 'a sealed code must be remembered by its normalised name').toBeTruthy();
    expect(row!.tnvedCode).toBe('8528520000');
    // 'manual', never 'ai': a person sealed it, whatever proposed it.
    expect(row!.source).toBe('manual');
  });
});
