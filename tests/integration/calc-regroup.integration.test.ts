import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { itemNameNorm } from '@/modules/wms/calc/memory';
import {
  confirmAllGroups,
  loadWorkspace,
  saveTable,
  sealCalc,
  type TableItemEdit,
} from '@/modules/wms/calc/workspace';
import { aiPrefill } from '@/modules/wms/calc/prefill';
import type { ProposedGroup } from '@/modules/wms/calc/grouping';

/**
 * The ✨ regroup against the company's own memory (P2.10d — the critic's
 * unverified finding, reproduced here before it was fixed).
 *
 * The MODEL is the one thing replaced: `proposeGoodsGrouping` is mocked for
 * this whole file (`vi.mock` is file-wide, which is why it is a file of its
 * own), and everything around it — `proposeGroups`, `applyProposal`, the
 * pricing tail, `saveTable`'s sweep and the sealed memory — is the real
 * machinery. The mock RECORDS what it was asked, so a test can say which
 * rows the model was shown.
 */
const asked: { name: string }[][] = [];
let answer: (goods: { name: string }[]) => ProposedGroup[] = () => [];

vi.mock('@/modules/wms/tnved/service', async (original) => {
  const real = await original<typeof import('@/modules/wms/tnved/service')>();
  return {
    ...real,
    proposeGoodsGrouping: async (goods: { name: string; quantity: number | null; unit: string | null }[]) => {
      asked.push(goods.map((g) => ({ name: g.name })));
      return { groups: answer(goods) };
    },
  };
});
vi.mock('@/modules/platform/ai/model', async (original) => ({
  ...(await original<typeof import('@/modules/platform/ai/model')>()),
  aiConfigured: () => true,
}));

const SUFFIX = String(Date.now()).slice(-6);
/**
 * A name nobody else's memory can answer. NOT a shared run tag: the memory is
 * a trigram match (`word_similarity`), and two names sharing «REGRP-123456»
 * would answer each other — the very confusion this file is about.
 */
const tag = () =>
  Array.from({ length: 12 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
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
      phone: `+99895${String(Date.now()).slice(-7)}`,
      fullName: `Regroup fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `RG${SUFFIX}`, name: `Regroup fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `RG-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Regroup fixture', createdBy: actorId })
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

async function open(items: { name: string; quantity?: number | null; tnvedCode?: string | null }[]) {
  for (const i of items) madeNames.push(i.name);
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

const itemRows = (requestId: string) =>
  db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId)).orderBy(calcRequestItems.seq);

async function editOf(requestId: string, seqNo: number, patch: Omit<TableItemEdit, 'id' | 'seq'>) {
  const item = (await itemRows(requestId)).find((i) => i.seq === seqNo)!;
  return { id: item.id, seq: item.seq, ...patch };
}

/** One SEALED, confirmed job about `name` — what the memory answers from. */
async function sealOne(name: string, code: string) {
  const id = await open([{ name, quantity: 10 }]);
  await saveTable(id, { items: [await editOf(id, 1, { tnvedCode: code, bazaUsd: 20, bazaBasis: 'unit' })], adds: [] }, ctx());
  await confirmAllGroups(id, ctx());
  await sealCalc(id, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx());
}

describe('the model is asked only about what nobody has coded (P2.10d)', () => {
  it('a memory-coded line keeps its code; an unplaced line stays ungrouped, never a code-less block', async () => {
    const remembered = `etik ${tag()}`;
    await sealOne(remembered, '9618000000');

    const id = await open([
      { name: remembered, quantity: 10 },
      { name: `sumka ${tag()}`, quantity: 5 },
      { name: `noma'lum ${tag()}`, quantity: 3 },
    ]);
    asked.length = 0;
    // The model, scripted: it recodes the FIRST line it is shown to a
    // neighbouring heading, returns the second with a blank (invalid) code
    // and does not place the third at all.
    answer = (goods) => [
      { tnved_code: '6402990000', name_ru: 'Обувь', item_indexes: [0], confidence: 'high', reasoning: '', duty_rate_pct: 20 },
      ...(goods.length > 1
        ? [{ tnved_code: '', name_ru: '—', item_indexes: [1], confidence: 'low' as const, reasoning: '', duty_rate_pct: null }]
        : []),
    ];

    await aiPrefill(id, ctx(), { pick: async () => [], configured: true });

    // Only the two lines nobody had coded were shown to the model.
    expect(asked.flat().map((g) => g.name)).not.toContain(remembered);

    const items = await itemRows(id);
    // The memory's code — this company's sealed answer — survived the pass.
    expect(items[0]!.tnvedCode).toBe('9618000000');
    const ws = await loadWorkspace(id);
    // No block was minted without a code: a code-less block prices nothing
    // and no save could ever re-home its rows.
    expect(ws!.groups.every((g) => g.tnvedCode !== null)).toBe(true);
    expect(ws!.groups.find((g) => g.tnvedCode === '9618000000')?.items.map((i) => i.seq)).toContain(1);
  });

  it('a row whose code differs from its block is re-homed by the next Saqlash', async () => {
    const id = await open([{ name: `kostyum ${tag()}`, quantity: 4 }]);
    await saveTable(id, { items: [await editOf(id, 1, { tnvedCode: '6203420000' })], adds: [] }, ctx());
    const [item] = await itemRows(id);
    // A stale shape the ✨ pass used to leave behind: the row's own code says
    // one thing, the block it stands in says another.
    await db.update(calcRequestItems).set({ tnvedCode: '6204620000' }).where(eq(calcRequestItems.id, item!.id));
    const out = await saveTable(id, { items: [], adds: [] }, ctx());
    expect(out.swept).toBe(1);
    const ws = await loadWorkspace(id);
    expect(ws!.groups.map((g) => g.tnvedCode)).toEqual(['6204620000']);
  });
});
