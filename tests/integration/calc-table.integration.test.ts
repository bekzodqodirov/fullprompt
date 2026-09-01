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
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import {
  addItems,
  applyTableEdits,
  confirmGroup,
  deleteItem,
  loadWorkspace,
} from '@/modules/wms/calc/workspace';

/**
 * VED 2.0 phase 2 — the table's one write door, against a real database.
 *
 * The auto-grouping rules live here: a typed TNVED code finds-or-creates its
 * group with the PP-3818 dictionary rates pulled at mint; the SWEEP places
 * intake-prefilled codes on any save; both ends of a move lose their ✅
 * (all FOUR confirm columns — the pair CHECK sees only two of them, so the
 * asserts must name the other two); an emptied group dies.
 *
 * Fixtures are this file's own (#183); no dictionary rows are written — the
 * rates assertions lean on the SEEDED PP-3818 book deliberately, because
 * that book is what production's auto-pull will answer from.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `VEDT-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99893${String(Date.now()).slice(-7)}`,
      fullName: `VED table fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `VT${SUFFIX}`, name: `VED table fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `VT-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'VED table fixture',
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
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(items: { name: string; quantity?: number | null; tnvedCode?: string | null }[]) {
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
  // The cap test needs many opens; keep this file under the per-requester
  // limit by closing nothing — the fixture actor opens ~12 requests total.
  return result.id;
}

// ORDER BY, always — an unordered read consumed positionally is #525's own
// find (210 of 1,166 multi-row entities already come back out of insertion
// order on real data).
const groupRows = (requestId: string) =>
  db.select().from(calcGroups).where(eq(calcGroups.requestId, requestId)).orderBy(calcGroups.seq);
const itemRows = (requestId: string) =>
  db
    .select()
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId))
    .orderBy(calcRequestItems.seq);

describe('auto-grouping by typed code', () => {
  it('a typed code mints the group WITH the PP-3818 rates, and a twin joins it', async () => {
    const id = await open([{ name: `monitor ${tag()}` }, { name: `televizor ${tag()}` }]);
    const first = await applyTableEdits(
      id,
      { items: [{ seq: 1, tnvedCode: '8528520000' }], groupBazas: [] },
      ctx(),
    );
    expect(first.minted).toEqual(['8528520000']);

    const groups = await groupRows(id);
    expect(groups).toHaveLength(1);
    // The book answers via the 8528 heading: advalor 10 %, VAT 12 — grey
    // (dictionary) numbers, and NEVER a per-code fee.
    expect(groups[0]).toMatchObject({
      tnvedCode: '8528520000',
      dutyPct: '10.000',
      vatPct: '12.000',
      feeUsd: null,
      rateSource: 'dictionary',
      dutyMode: null,
    });

    const second = await applyTableEdits(
      id,
      { items: [{ seq: 2, tnvedCode: '8528520000' }], groupBazas: [] },
      ctx(),
    );
    // The twin JOINS — no second group, nothing newly minted.
    expect(second.minted).toEqual([]);
    expect(await groupRows(id)).toHaveLength(1);
    const items = await itemRows(id);
    expect(items.map((i) => i.groupId)).toEqual([groups[0]!.id, groups[0]!.id]);
  });

  it('a code the book has never heard of mints with NULL rates and NULL source', async () => {
    const id = await open([{ name: `nomalum ${tag()}` }]);
    await applyTableEdits(id, { items: [{ seq: 1, tnvedCode: '9977001122' }], groupBazas: [] }, ctx());
    const [group] = await groupRows(id);
    // 'dictionary' over nulls is a provenance lie — the rates_missing
    // blocker must stand instead.
    expect(group).toMatchObject({ dutyPct: null, vatPct: null, rateSource: null });
    const ws = await loadWorkspace(id);
    expect(ws!.blockers.some((b) => b.kind === 'customs' && b.reason === 'rates_missing')).toBe(true);
  });

  it('moving a coded item unconfirms BOTH ends — all four columns — and the emptied group dies', async () => {
    // The losing group keeps a member, or its unconfirm is unobservable and
    // the red proof stays green (#166 — this fixture's first version had
    // exactly that hole: the emptied loser was deleted before anyone could
    // ask about its ✅).
    const id = await open([
      { name: `kurtka A ${tag()}` },
      { name: `kurtka B ${tag()}` },
      { name: `shim ${tag()}` },
    ]);
    await applyTableEdits(
      id,
      {
        items: [
          { seq: 1, tnvedCode: '6102' },
          { seq: 2, tnvedCode: '6102' },
          { seq: 3, tnvedCode: '6103' },
        ],
        groupBazas: [],
      },
      ctx(),
    );
    const before = await groupRows(id);
    expect(before).toHaveLength(2);
    for (const g of before) await confirmGroup(g.id, ctx());

    // Item 1 re-codes 6102 → 6103: BOTH groups' numbers moved, so BOTH lose
    // their ✅ — and all four columns clear, because the pair CHECK sees only
    // two of them.
    await applyTableEdits(id, { items: [{ seq: 1, tnvedCode: '6103' }], groupBazas: [] }, ctx());
    const after = await groupRows(id);
    expect(after).toHaveLength(2);
    for (const g of after) {
      expect(g).toMatchObject({
        confirmedAt: null,
        confirmedBy: null,
        confirmVia: null,
        confirmedWarnings: null,
      });
    }

    // And when the loser's LAST member leaves, the group dies with it.
    await applyTableEdits(id, { items: [{ seq: 2, tnvedCode: '6103' }], groupBazas: [] }, ctx());
    const final = await groupRows(id);
    expect(final).toHaveLength(1);
    expect(final[0]!.tnvedCode).toBe('6103');
  });

  it('THE SWEEP: intake-prefilled codes group on a save with nothing dirty', async () => {
    // The commonest real request: the TNVED memory (or the seller) filled
    // the codes at intake, so every item arrives coded and ungrouped — and
    // an empty save must heal the whole backlog (the judge's blocker: the
    // old flow's group ceremony must not survive as «retype every code»).
    const id = await open([
      { name: `gilam A ${tag()}`, tnvedCode: '5703' },
      { name: `gilam B ${tag()}`, tnvedCode: '5703' },
      { name: `idish ${tag()}`, tnvedCode: '3924' },
    ]);
    const result = await applyTableEdits(id, { items: [], groupBazas: [] }, ctx());
    expect(result.swept).toBe(3);
    expect(result.minted.sort()).toEqual(['3924', '5703']);
    const items = await itemRows(id);
    expect(items.every((i) => i.groupId !== null)).toBe(true);
    // 5703 is a MAX row — the law's shape rides the mint.
    const gilam = (await groupRows(id)).find((g) => g.tnvedCode === '5703')!;
    expect(gilam).toMatchObject({ dutyMode: 'max', dutySpecific: '0.7000', dutyUnit: 'kg' });
  });

  it('a measure edit unconfirms; a rename does not', async () => {
    const id = await open([{ name: `stol ${tag()}`, quantity: 5, tnvedCode: '9403' }]);
    await applyTableEdits(id, { items: [], groupBazas: [] }, ctx());
    const [group] = await groupRows(id);
    await confirmGroup(group!.id, ctx());

    await applyTableEdits(id, { items: [{ seq: 1, name: `stol yangi ${tag()}` }], groupBazas: [] }, ctx());
    let [g] = await groupRows(id);
    // A name is words, not one of the numbers the ✅ was about.
    expect(g!.confirmedAt).not.toBeNull();

    await applyTableEdits(id, { items: [{ seq: 1, quantity: 7 }], groupBazas: [] }, ctx());
    [g] = await groupRows(id);
    expect(g!.confirmedAt).toBeNull();
    expect(g!.confirmedWarnings).toBeNull();
  });
});

describe('the table refuses by ROW', () => {
  it('a malformed code names its seq', async () => {
    const id = await open([{ name: `x ${tag()}` }]);
    await expect(
      applyTableEdits(id, { items: [{ seq: 1, tnvedCode: '85AB' }], groupBazas: [] }, ctx()),
    ).rejects.toMatchObject({ code: 'bad_code', seq: 1 });
  });

  it('a zero measure names its seq, and nothing half-applies', async () => {
    const id = await open([{ name: `a ${tag()}` }, { name: `b ${tag()}` }]);
    await expect(
      applyTableEdits(
        id,
        {
          items: [
            { seq: 1, name: 'yangilangan nom' },
            { seq: 2, quantity: 0 },
          ],
          groupBazas: [],
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'measure_positive', seq: 2 });
    const items = await itemRows(id);
    // The refusal happened at validation, BEFORE the transaction — row 1's
    // rename must not have landed.
    expect(items[0]!.name).not.toBe('yangilangan nom');
  });

  it('an AI proposal in flight refuses the save', async () => {
    const id = await open([{ name: `y ${tag()}` }]);
    await db
      .update(calcRequests)
      .set({ aiProposalStartedAt: new Date() })
      .where(eq(calcRequests.id, id));
    await expect(
      applyTableEdits(id, { items: [{ seq: 1, tnvedCode: '8528' }], groupBazas: [] }, ctx()),
    ).rejects.toMatchObject({ code: 'ai_running' });
    // A claim a crashed pass left behind must NOT brick the table for ever.
    await db
      .update(calcRequests)
      .set({ aiProposalStartedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(calcRequests.id, id));
    await expect(
      applyTableEdits(id, { items: [{ seq: 1, tnvedCode: '8528' }], groupBazas: [] }, ctx()),
    ).resolves.toBeTruthy();
  });
});

describe('the group baza cell', () => {
  it('fans one number over every member as typed, and clears the ✅', async () => {
    const id = await open([
      { name: `krujka ${tag()}`, quantity: 100, tnvedCode: '3924' },
      { name: `likop ${tag()}`, quantity: 50, tnvedCode: '3924' },
    ]);
    await applyTableEdits(id, { items: [], groupBazas: [] }, ctx());
    const [group] = await groupRows(id);
    await confirmGroup(group!.id, ctx());

    await applyTableEdits(
      id,
      {
        items: [],
        groupBazas: [{ code: '3924', bazaUsd: 2.5, basis: 'unit', sawBazaUsd: null, sawMixed: false }],
      },
      ctx(),
    );
    const items = await itemRows(id);
    expect(items.map((i) => ({ b: i.bazaUsd, s: i.bazaSource }))).toEqual([
      { b: '2.5000', s: 'typed' },
      { b: '2.5000', s: 'typed' },
    ]);
    const [g] = await groupRows(id);
    expect(g!.confirmedAt).toBeNull();
  });

  it('refuses a fanout over per-item bazas the screen never showed', async () => {
    const id = await open([
      { name: `arzon ${tag()}`, quantity: 10, tnvedCode: '3926' },
      { name: `qimmat ${tag()}`, quantity: 10, tnvedCode: '3926' },
    ]);
    await applyTableEdits(id, { items: [], groupBazas: [] }, ctx());
    // A colleague sets law-5 per-item bazas…
    await db
      .update(calcRequestItems)
      .set({ bazaUsd: '3.0000', bazaBasis: 'unit', bazaSource: 'typed' })
      .where(and2(id, 1));
    await db
      .update(calcRequestItems)
      .set({ bazaUsd: '9.0000', bazaBasis: 'unit', bazaSource: 'typed' })
      .where(and2(id, 2));
    // …and a browser opened BEFORE that posts a uniform cell.
    await expect(
      applyTableEdits(
        id,
        {
          items: [],
          groupBazas: [{ code: '3926', bazaUsd: 5, basis: 'unit', sawBazaUsd: null, sawMixed: false }],
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'stale_baza' });
    // A screen that SAW the mix and confirmed is allowed through.
    await applyTableEdits(
      id,
      {
        items: [],
        groupBazas: [{ code: '3926', bazaUsd: 5, basis: 'unit', sawBazaUsd: null, sawMixed: true }],
      },
      ctx(),
    );
    const items = await itemRows(id);
    expect(items.every((i) => i.bazaUsd === '5.0000')).toBe(true);
  });

  it('a code with no group refuses group_gone', async () => {
    const id = await open([{ name: `z ${tag()}` }]);
    await expect(
      applyTableEdits(
        id,
        {
          items: [],
          groupBazas: [{ code: '4242', bazaUsd: 1, basis: 'unit', sawBazaUsd: null, sawMixed: false }],
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'group_gone' });
  });
});

describe('adding and deleting rows', () => {
  it('appends with fresh seqs, fills codes from the TNVED memory shape, auto-groups, and recounts', async () => {
    const id = await open([{ name: `bor ${tag()}`, tnvedCode: '8528' }]);
    await applyTableEdits(id, { items: [], groupBazas: [] }, ctx());
    const result = await addItems(
      id,
      [
        { name: `yana bir ${tag()}`, quantity: 3, tnvedCode: '8528' },
        { name: `kodsiz ${tag()}` },
      ],
      ctx(),
    );
    expect(result.added).toBe(2);
    const items = await itemRows(id);
    expect(items.map((i) => i.seq)).toEqual([1, 2, 3]);
    // Same code → same group; the codeless row waits ungrouped (a blocker).
    expect(items[1]!.groupId).toBe(items[0]!.groupId);
    expect(items[2]!.groupId).toBeNull();
    const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(request!.itemCount).toBe(3);
  });

  it('deleting the last member prunes the group and recounts', async () => {
    const id = await open([{ name: `bitta ${tag()}`, tnvedCode: '6403120000' }]);
    await applyTableEdits(id, { items: [], groupBazas: [] }, ctx());
    expect(await groupRows(id)).toHaveLength(1);
    await deleteItem(id, 1, ctx());
    expect(await groupRows(id)).toHaveLength(0);
    expect(await itemRows(id)).toHaveLength(0);
    const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(request!.itemCount).toBe(0);
  });
});

// Tiny where-helper: the (requestId, seq) address the module uses everywhere.
import { and } from 'drizzle-orm';
const and2 = (requestId: string, seqNo: number) =>
  and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, seqNo));
