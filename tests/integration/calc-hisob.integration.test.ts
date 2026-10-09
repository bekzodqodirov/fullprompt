import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRates,
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
import { itemNameNorm } from '@/modules/wms/calc/memory';
import {
  confirmAllGroups,
  loadWorkspace,
  saveTable,
  sealCalc,
  setGroupRates,
  type TableItemEdit,
} from '@/modules/wms/calc/workspace';

/**
 * Package P2 «Hisob» (docs/RASTAMOJKA-TUZATISH.md §2, §7.2) against a real
 * database: the law's shape through every writer, the book moving under a
 * group, the excise, the fee, the seal's own refusals and the lgota memory.
 *
 * Fixtures are this file's own (#183). The dictionaries are GLOBAL, so every
 * rate row this file writes is deleted by id in `afterAll`, every product name
 * carries the run tag (a SEAL is configuration for any later spec about the
 * same product, #935), and the codes it seals are run-unique under a heading
 * the book already answers — the lgota memory is keyed on the CODE, and a
 * shared code would read a stranger's seal.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `HISOB-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const madeRates: string[] = [];
const madeNames: string[] = [];
const ctx = () => ({ actorId });
const SEAL = { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null };

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99894${String(Date.now()).slice(-7)}`,
      fullName: `Hisob fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `HB${SUFFIX}`, name: `Hisob fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `HB-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'Hisob fixture',
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
    // A correction points at the request it supersedes — children first.
    for (const id of [...madeRequests].reverse()) {
      await db.delete(calcRequests).where(eq(calcRequests.id, id));
    }
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeRates.length > 0) await db.delete(calcRates).where(inArray(calcRates.id, madeRates));
  // The seal TEACHES the exact-key code book (0096) — configuration for every
  // later spec that happens to use the same product name.
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

type Section = 'rastamojka' | 'podklyuch' | 'yolkira';

async function open(
  items: { name: string; quantity?: number | null; weightKg?: number | null; tnvedCode?: string | null }[],
  section: Section = 'rastamojka',
) {
  for (const i of items) madeNames.push(i.name);
  const result = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section,
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
const groupRows = (requestId: string) =>
  db.select().from(calcGroups).where(eq(calcGroups.requestId, requestId)).orderBy(calcGroups.seq);

async function editOf(requestId: string, seqNo: number, patch: Omit<TableItemEdit, 'id' | 'seq'>) {
  const items = await itemRows(requestId);
  const item = items.find((i) => i.seq === seqNo)!;
  return { id: item.id, seq: item.seq, ...patch };
}
const save = (requestId: string, items: TableItemEdit[] = []) =>
  saveTable(requestId, { items, adds: [] }, ctx());

/** A one-row rastamojka job coded and priced through the table — the book's
 * law minted onto its group, a per-dona baza on the row. */
async function priced(code: string, opts: { quantity?: number; weightKg?: number | null; bazaUsd?: number } = {}) {
  const id = await open([{ name: `tovar ${tag()}`, quantity: opts.quantity ?? 100, weightKg: opts.weightKg ?? 50 }]);
  await save(id, [await editOf(id, 1, { tnvedCode: code, bazaUsd: opts.bazaUsd ?? 20, bazaBasis: 'unit' })]);
  return id;
}

describe('the lgota memory offers the LAST decision, not the last exemption (P2.10b)', () => {
  it('a later seal WITHOUT a lgota retires the earlier exemption', async () => {
    // A run-unique code under heading 9618 (advalor 10 % in the book): the
    // memory is keyed on the code, and a shared one would read a stranger's.
    const code = `9618${SUFFIX}`;
    const first = await priced(code);
    const [g1] = await groupRows(first);
    await setGroupRates(
      g1!.id,
      { tnvedCode: code, dutyPct: 10, vatPct: 12, dutyFree: true, vatFree: false },
      ctx(),
    );
    await confirmAllGroups(first, ctx());
    await sealCalc(first, SEAL, ctx());

    // Sealed again, later, as an ordinary job: the last decision is «no lgota».
    const second = await priced(code);
    await confirmAllGroups(second, ctx());
    await sealCalc(second, SEAL, ctx());

    const third = await priced(code);
    const ws = await loadWorkspace(third);
    expect(ws!.groups[0]!.lgotaLast).toBeNull();
  });

  it('the newest decision IS an exemption — offered, with the date it was sealed', async () => {
    const code = `9618${String(Number(SUFFIX) + 1).padStart(6, '0').slice(-6)}`;
    const first = await priced(code);
    const [g1] = await groupRows(first);
    await setGroupRates(
      g1!.id,
      { tnvedCode: code, dutyPct: 10, vatPct: 12, dutyFree: false, vatFree: true },
      ctx(),
    );
    await confirmAllGroups(first, ctx());
    await sealCalc(first, SEAL, ctx());

    const next = await priced(code);
    const ws = await loadWorkspace(next);
    expect(ws!.groups[0]!.lgotaLast).toMatchObject({ dutyFree: false, vatFree: true });
    expect(ws!.groups[0]!.lgotaLast!.sealedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

describe('the seal refuses what the section does not have (P2.8)', () => {
  it('a band override on a rastamojka-only job is refused — it moves no money', async () => {
    const id = await priced('9618000000');
    await confirmAllGroups(id, ctx());
    await expect(
      sealCalc(id, { ...SEAL, bandOverrideMin: 300, bandOverrideReason: 'zich yuk' }, ctx()),
    ).rejects.toMatchObject({ code: 'band_no_freight' });
  });
});
