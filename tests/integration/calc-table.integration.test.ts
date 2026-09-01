import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
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
  confirmGroup,
  deleteItem,
  loadWorkspace,
  saveTable,
  type TableItemEdit,
  type TableNewItem,
} from '@/modules/wms/calc/workspace';

/**
 * VED 2.0 phase 3 — the table's ONE write door, against a real database.
 *
 * The rules live here: a typed TNVED code finds-or-creates its group with
 * the PP-3818 dictionary rates pulled at mint; the SWEEP places
 * intake-prefilled codes on any save; both ends of a move lose their ✅
 * (all FOUR confirm columns); an emptied group dies; the baza is PER ROW
 * and clears as a triple; the MEASURE pair is written and cleared only
 * together, by the save's own pass, in the unit the code's law asks; and
 * legacy same-code duplicate groups merge only when their rates are
 * identical.
 *
 * Phase 2's law-5 fan-out fence (`stale_baza`) is RETIRED with the group
 * cell itself: a per-row baza is its own address, so there is no fan-out
 * left to flatten a colleague's per-item work (recorded, DECISIONS).
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

/** Edits are addressed by the immutable item id (seqs are re-minted after a
 * delete); the tests speak in seqs, so this resolves them. */
async function editOf(requestId: string, seqNo: number, patch: Omit<TableItemEdit, 'id' | 'seq'>) {
  const items = await itemRows(requestId);
  const item = items.find((i) => i.seq === seqNo)!;
  return { id: item.id, seq: item.seq, ...patch };
}
const save = (
  requestId: string,
  input: { items?: TableItemEdit[]; adds?: TableNewItem[] },
) => saveTable(requestId, { items: input.items ?? [], adds: input.adds ?? [] }, ctx());

describe('auto-grouping by typed code', () => {
  it('a typed code mints the group WITH the PP-3818 rates, and a twin joins it', async () => {
    const id = await open([{ name: `monitor ${tag()}` }, { name: `televizor ${tag()}` }]);
    const first = await save(id, { items: [await editOf(id, 1, { tnvedCode: '8528520000' })] });
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

    const second = await save(id, { items: [await editOf(id, 2, { tnvedCode: '8528520000' })] });
    // The twin JOINS — no second group, nothing newly minted.
    expect(second.minted).toEqual([]);
    expect(await groupRows(id)).toHaveLength(1);
    const items = await itemRows(id);
    expect(items.map((i) => i.groupId)).toEqual([groups[0]!.id, groups[0]!.id]);
  });

  it('a code the book has never heard of mints with NULL rates and NULL source', async () => {
    const id = await open([{ name: `nomalum ${tag()}` }]);
    await save(id, { items: [await editOf(id, 1, { tnvedCode: '9977001122' })] });
    const [group] = await groupRows(id);
    // 'dictionary' over nulls is a provenance lie — the rates_missing
    // blocker must stand instead.
    expect(group).toMatchObject({ dutyPct: null, vatPct: null, rateSource: null });
    const ws = await loadWorkspace(id);
    expect(ws!.blockers.some((b) => b.kind === 'customs' && b.reason === 'rates_missing')).toBe(true);
  });

  it('moving a coded item unconfirms BOTH ends — all four columns — and the emptied group dies', async () => {
    // The losing group keeps a member, or its unconfirm is unobservable and
    // the red proof stays green (#166).
    const id = await open([
      { name: `kurtka A ${tag()}` },
      { name: `kurtka B ${tag()}` },
      { name: `shim ${tag()}` },
    ]);
    await save(id, {
      items: [
        await editOf(id, 1, { tnvedCode: '6102' }),
        await editOf(id, 2, { tnvedCode: '6102' }),
        await editOf(id, 3, { tnvedCode: '6103' }),
      ],
    });
    const before = await groupRows(id);
    expect(before).toHaveLength(2);
    for (const g of before) await confirmGroup(g.id, ctx());

    // Item 1 re-codes 6102 → 6103: BOTH groups' numbers moved, so BOTH lose
    // their ✅ — and all four columns clear, because the pair CHECK sees only
    // two of them.
    await save(id, { items: [await editOf(id, 1, { tnvedCode: '6103' })] });
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
    await save(id, { items: [await editOf(id, 2, { tnvedCode: '6103' })] });
    const final = await groupRows(id);
    expect(final).toHaveLength(1);
    expect(final[0]!.tnvedCode).toBe('6103');
  });

  it('THE SWEEP: intake-prefilled codes group on a save with nothing dirty', async () => {
    const id = await open([
      { name: `gilam A ${tag()}`, tnvedCode: '5703' },
      { name: `gilam B ${tag()}`, tnvedCode: '5703' },
      { name: `idish ${tag()}`, tnvedCode: '3924' },
    ]);
    const result = await save(id, {});
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
    await save(id, {});
    const [group] = await groupRows(id);
    await confirmGroup(group!.id, ctx());

    await save(id, { items: [await editOf(id, 1, { name: `stol yangi ${tag()}` })] });
    let [g] = await groupRows(id);
    // A name is words, not one of the numbers the ✅ was about.
    expect(g!.confirmedAt).not.toBeNull();

    await save(id, { items: [await editOf(id, 1, { quantity: 7 })] });
    [g] = await groupRows(id);
    expect(g!.confirmedAt).toBeNull();
    expect(g!.confirmedWarnings).toBeNull();
  });
});

describe('the table refuses by ROW', () => {
  it('a malformed code names its seq', async () => {
    const id = await open([{ name: `x ${tag()}` }]);
    await expect(
      save(id, { items: [await editOf(id, 1, { tnvedCode: '85AB' })] }),
    ).rejects.toMatchObject({ code: 'bad_code', seq: 1 });
  });

  it('a zero measure names its seq, and nothing half-applies', async () => {
    const id = await open([{ name: `a ${tag()}` }, { name: `b ${tag()}` }]);
    await expect(
      save(id, {
        items: [
          await editOf(id, 1, { name: 'yangilangan nom' }),
          await editOf(id, 2, { quantity: 0 }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'measure_positive', seq: 2 });
    const items = await itemRows(id);
    // The refusal happened at validation, BEFORE the transaction — row 1's
    // rename must not have landed.
    expect(items[0]!.name).not.toBe('yangilangan nom');
  });

  it('a value past the numeric(12,3) ceiling refuses instead of a 22003 white page', async () => {
    const id = await open([{ name: `katta ${tag()}` }]);
    await expect(
      save(id, { items: [await editOf(id, 1, { quantity: 1_000_000_000 })] }),
    ).rejects.toMatchObject({ code: 'bad_number', seq: 1 });
  });

  it('an AI proposal in flight refuses the save', async () => {
    const id = await open([{ name: `y ${tag()}` }]);
    await db
      .update(calcRequests)
      .set({ aiProposalStartedAt: new Date() })
      .where(eq(calcRequests.id, id));
    await expect(
      save(id, { items: [await editOf(id, 1, { tnvedCode: '8528' })] }),
    ).rejects.toMatchObject({ code: 'ai_running' });
    // A claim a crashed pass left behind must NOT brick the table for ever.
    await db
      .update(calcRequests)
      .set({ aiProposalStartedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(calcRequests.id, id));
    await expect(save(id, { items: [await editOf(id, 1, { tnvedCode: '8528' })] })).resolves.toBeTruthy();
  });
});

describe('the per-row baza', () => {
  it('lands as an atomic triple, and clears as one', async () => {
    const id = await open([{ name: `krujka ${tag()}`, quantity: 100, tnvedCode: '3924' }]);
    await save(id, {});
    const [group] = await groupRows(id);
    await confirmGroup(group!.id, ctx());

    await save(id, { items: [await editOf(id, 1, { bazaUsd: 2.5, bazaBasis: 'unit' })] });
    let [item] = await itemRows(id);
    expect(item).toMatchObject({ bazaUsd: '2.5000', bazaBasis: 'unit', bazaSource: 'typed' });
    // A baza is one of the numbers the ✅ was about.
    const [g] = await groupRows(id);
    expect(g!.confirmedAt).toBeNull();

    // Null clears amount, basis and source TOGETHER — the schema has no pair
    // CHECK, so the writer restates the old setItemBaza rule.
    await save(id, { items: [await editOf(id, 1, { bazaUsd: null })] });
    [item] = await itemRows(id);
    expect(item).toMatchObject({ bazaUsd: null, bazaBasis: null, bazaSource: null });
  });

  it('an unchanged baza pair diffs to nothing — no re-stamp, no unconfirm', async () => {
    const id = await open([{ name: `chashka ${tag()}`, quantity: 10, tnvedCode: '3924' }]);
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 4, bazaBasis: 'unit' })] });
    const [group] = await groupRows(id);
    await confirmGroup(group!.id, ctx());
    // Re-posting the identical pair (what a full-row save does) must not
    // clear the ✅ — a no-op edit is not an edit.
    await save(id, { items: [await editOf(id, 1, { bazaUsd: 4, bazaBasis: 'unit' })] });
    const [g] = await groupRows(id);
    expect(g!.confirmedAt).not.toBeNull();
  });
});

describe('the measure pair (the law’s own unit)', () => {
  it('a m² code takes its measure, prices, and the pair is stamped together', async () => {
    // 6907 — the ONE m² row in PP-3818: max 15 % / min $1/m².
    const id = await open([{ name: `plitka ${tag()}`, tnvedCode: '6907' }]);
    await save(id, {});
    const [group] = await groupRows(id);
    expect(group).toMatchObject({ dutyMode: 'max', dutyUnit: 'm2' });

    await save(id, {
      items: [await editOf(id, 1, { measureQty: 200, bazaUsd: 1, bazaBasis: 'm2' })],
    });
    const [item] = await itemRows(id);
    expect(item!).toMatchObject({ measureUnit: 'm2', measureQty: '200.0000', bazaBasis: 'm2' });

    // value 200 × $1/m² = 200; advalor 30; specific 200 → MAX 200; VAT 48.
    const ws = await loadWorkspace(id);
    const g = ws!.groups[0]!;
    expect(g.customs).toMatchObject({ ok: true, valueUsd: 200, dutyUsd: 200, customsUsd: 248 });
  });

  it('a recode that changes the required unit CLEARS the pair and NAMES the row', async () => {
    const id = await open([{ name: `plitka ${tag()}`, tnvedCode: '6907' }]);
    await save(id, {});
    await save(id, { items: [await editOf(id, 1, { measureQty: 200 })] });
    // 2203 (pivo) prices per LITR — «200» was a statement in m², and
    // re-stamping it as litres would price a number nobody measured.
    const result = await save(id, { items: [await editOf(id, 1, { tnvedCode: '2203' })] });
    expect(result.measuresCleared).toEqual([1]);
    const [item] = await itemRows(id);
    expect(item).toMatchObject({ measureUnit: null, measureQty: null, tnvedCode: '2203' });
  });

  it('a measure posted for a code that needs none is DROPPED with a named note, never a refusal', async () => {
    const id = await open([{ name: `monitor ${tag()}`, tnvedCode: '8528520000' }]);
    await save(id, {});
    const result = await save(id, {
      items: [await editOf(id, 1, { measureQty: 50, name: `monitor yangi ${tag()}` })],
    });
    // The rename LANDED — a good-faith box must not refuse the whole save.
    expect(result.measuresDropped).toEqual([1]);
    const [item] = await itemRows(id);
    expect(item!.name).toContain('monitor yangi');
    expect(item!).toMatchObject({ measureUnit: null, measureQty: null });
  });
});

describe('one transaction for edits AND adds', () => {
  it('a new row born with code + baza + measure prices on its FIRST save', async () => {
    const id = await open([{ name: `bor ${tag()}`, tnvedCode: '8528' }]);
    await save(id, {});
    const result = await save(id, {
      adds: [
        { name: `kafel ${tag()}`, tnvedCode: '6907', measureQty: 100, bazaUsd: 2, bazaBasis: 'm2' },
      ],
    });
    expect(result.added).toBe(1);
    expect(result.minted).toEqual(['6907']);
    const items = await itemRows(id);
    const added = items.find((i) => i.seq === 2)!;
    // The whole statement landed in ONE tx: code grouped with dictionary
    // rates, baza typed, measure stamped in the law's unit.
    expect(added).toMatchObject({
      tnvedCode: '6907',
      bazaUsd: '2.0000',
      bazaBasis: 'm2',
      bazaSource: 'typed',
      measureUnit: 'm2',
      measureQty: '100.0000',
    });
    const ws = await loadWorkspace(id);
    const kafel = ws!.groups.find((g) => g.tnvedCode === '6907')!;
    // value 100 × $2 = 200; advalor 30; specific 100 × $1 = 100 → MAX 100.
    expect(kafel.customs).toMatchObject({ ok: true, valueUsd: 200, dutyUsd: 100 });
    const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(request!.itemCount).toBe(2);
  });
});

describe('legacy duplicate same-code groups', () => {
  it('merges duplicates whose rates are IDENTICAL, and announces the code', async () => {
    const id = await open([{ name: `eski A ${tag()}` }, { name: `eski B ${tag()}` }]);
    // A phase-B leftover: two groups carrying one code with the same rates.
    const [g1] = await db
      .insert(calcGroups)
      .values({ requestId: id, seq: 1, label: '9403', tnvedCode: '9403', dutyPct: '10.000', vatPct: '12.000' })
      .returning();
    const [g2] = await db
      .insert(calcGroups)
      .values({ requestId: id, seq: 2, label: '9403', tnvedCode: '9403', dutyPct: '10.000', vatPct: '12.000' })
      .returning();
    const items = await itemRows(id);
    await db.update(calcRequestItems).set({ groupId: g1!.id, tnvedCode: '9403' }).where(eq(calcRequestItems.id, items[0]!.id));
    await db.update(calcRequestItems).set({ groupId: g2!.id, tnvedCode: '9403' }).where(eq(calcRequestItems.id, items[1]!.id));

    const result = await save(id, {});
    expect(result.merged).toEqual(['9403']);
    const groups = await groupRows(id);
    expect(groups).toHaveLength(1);
    const after = await itemRows(id);
    expect(after.map((i) => i.groupId)).toEqual([groups[0]!.id, groups[0]!.id]);
  });

  it('duplicates whose rates DIFFER are left alone — a typed lgota must not die under a merge', async () => {
    const id = await open([{ name: `lgotali ${tag()}` }, { name: `oddiy ${tag()}` }]);
    const [g1] = await db
      .insert(calcGroups)
      .values({ requestId: id, seq: 1, label: '9403', tnvedCode: '9403', dutyPct: '10.000', vatPct: '12.000' })
      .returning();
    const [g2] = await db
      .insert(calcGroups)
      .values({
        requestId: id,
        seq: 2,
        label: '9403',
        tnvedCode: '9403',
        dutyPct: '10.000',
        vatPct: '12.000',
        dutyFree: true,
        rateSource: 'typed',
      })
      .returning();
    const items = await itemRows(id);
    await db.update(calcRequestItems).set({ groupId: g1!.id, tnvedCode: '9403' }).where(eq(calcRequestItems.id, items[0]!.id));
    await db.update(calcRequestItems).set({ groupId: g2!.id, tnvedCode: '9403' }).where(eq(calcRequestItems.id, items[1]!.id));

    const result = await save(id, {});
    expect(result.merged).toEqual([]);
    expect(await groupRows(id)).toHaveLength(2);
  });
});

describe('adding and deleting rows', () => {
  it('appends with fresh seqs, fills codes from the TNVED memory shape, auto-groups, and recounts', async () => {
    const id = await open([{ name: `bor ${tag()}`, tnvedCode: '8528' }]);
    await save(id, {});
    const result = await save(id, {
      adds: [{ name: `yana bir ${tag()}`, quantity: 3, tnvedCode: '8528' }, { name: `kodsiz ${tag()}` }],
    });
    expect(result.added).toBe(2);
    const items = await itemRows(id);
    expect(items.map((i) => i.seq)).toEqual([1, 2, 3]);
    // Same code → same group; the codeless row waits ungrouped (a blocker).
    expect(items[1]!.groupId).toBe(items[0]!.groupId);
    expect(items[2]!.groupId).toBeNull();
    const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(request!.itemCount).toBe(3);
  });

  it('deleting the last member (by ID — seqs are re-mintable) prunes the group and recounts', async () => {
    const id = await open([{ name: `bitta ${tag()}`, tnvedCode: '6403120000' }]);
    await save(id, {});
    expect(await groupRows(id)).toHaveLength(1);
    const [item] = await itemRows(id);
    await deleteItem(id, item!.id, ctx());
    expect(await groupRows(id)).toHaveLength(0);
    expect(await itemRows(id)).toHaveLength(0);
    const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(request!.itemCount).toBe(0);
  });
});

describe('the revision clock', () => {
  beforeAll(async () => {
    // This file opens more requests than the per-requester cap allows open at
    // once — everything before this block is finished with its request, so
    // close them (the fixture actor is this file's own, #183).
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(), completedVia: 'returned' })
      .where(inArray(calcRequests.id, madeRequests));
  });

  it('every save moves it, and the confirm doors capture-and-compare through it', async () => {
    const id = await open([{ name: `soat ${tag()}`, tnvedCode: '9403' }]);
    const before = (await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) }))!.rev;
    await save(id, {});
    const after = (await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) }))!.rev;
    expect(after).toBeGreaterThan(before);
  });

  it('a re-press of ✅ is a no-op, never a re-stamp — the first record is the record E1 reads', async () => {
    const id = await open([{ name: `qulf ${tag()}`, tnvedCode: '9403' }]);
    await save(id, {});
    const [group] = await groupRows(id);
    await confirmGroup(group!.id, ctx());
    const [first] = await groupRows(id);

    // A SECOND user re-presses: identity is the oracle (a timestamp can
    // collide within a millisecond and turn the red proof green — #166).
    const [other] = await db
      .insert(users)
      .values({
        phone: `+99894${String(Date.now()).slice(-7)}`,
        fullName: `VED table second ${SUFFIX}`,
        passwordHash: 'x',
      })
      .returning();
    await confirmGroup(group!.id, { actorId: other!.id });
    const [second] = await groupRows(id);
    expect(second!.confirmedBy).toBe(first!.confirmedBy);
    expect(second!.confirmedBy).toBe(actorId);
    expect(second!.confirmedAt!.getTime()).toBe(first!.confirmedAt!.getTime());
    await db.update(users).set({ active: false }).where(eq(users.id, other!.id));
  });
});

// The (requestId, seq) helper survives for raw fixture writes above.
void and;
