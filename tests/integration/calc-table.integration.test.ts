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
  applyProposal,
  priceProposedGroups,
  saveTable,
  setCargoFacts,
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

async function open(
  items: {
    name: string;
    quantity?: number | null;
    tnvedCode?: string | null;
    weightKg?: number | null;
  }[],
) {
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

  it('the kg reconcile waits until both sides measure the same cargo', async () => {
    // `groupMeasure` sums whatever carries a figure and returns null only
    // when nothing does, so a HALF-weighed request produces a partial Σ that
    // looks like a total — and the warning then fires on the shortfall. That
    // is the normal state of every request the VED is mid-way through
    // coding, and the AI prefill made it the normal state of a landed one
    // too, since the model reads a weight off some packing-list lines and
    // not others.
    const half = await open([
      { name: `a ${tag()}`, quantity: 1, tnvedCode: '3924', weightKg: 100 },
      { name: `b ${tag()}`, quantity: 1, tnvedCode: '3924' },
    ]);
    await save(half, {});
    const partial = await loadWorkspace(half);
    // 100 kg of a 500 kg request — a 80 % «gap» that is not a gap at all.
    expect(partial!.reconcile.groupKg).toBe(100);
    expect(partial!.reconcile.mismatch).toBe(false);

    // Fully weighed and honestly disagreeing: 100 + 100 against 500.
    const whole = await open([
      { name: `c ${tag()}`, quantity: 1, tnvedCode: '3924', weightKg: 100 },
      { name: `d ${tag()}`, quantity: 1, tnvedCode: '3924', weightKg: 100 },
    ]);
    await save(whole, {});
    const full = await loadWorkspace(whole);
    expect(full!.reconcile.groupKg).toBe(200);
    expect(full!.reconcile.mismatch).toBe(true);

    // …and an UNGROUPED row is the other way to be partial: nothing is
    // wrong with the numbers, the Σ simply is not over the same cargo.
    const loose = await open([
      { name: `e ${tag()}`, quantity: 1, tnvedCode: '3924', weightKg: 100 },
      { name: `f ${tag()}`, quantity: 1, weightKg: 100 },
    ]);
    await save(loose, {});
    const mixed = await loadWorkspace(loose);
    expect(mixed!.ungrouped).toHaveLength(1);
    expect(mixed!.reconcile.mismatch).toBe(false);

    // This test needs THREE requests and the cap is 20 OPEN per requester
    // (`MAX_OPEN_PER_REQUESTER`), which the file was already close to: a
    // test that eats a shared budget starves the ones after it, and the
    // first version of this one did exactly that — three later tests failed
    // `too_many_open` and blamed their own code. #183 wearing a budget's
    // clothes.
    await db
      .update(calcRequests)
      .set({ completedAt: new Date() })
      .where(inArray(calcRequests.id, [half, whole, loose]));
  });

  it('the proposal’s pricing tail is an ORDINARY writer, claim and all', async () => {
    // The trap a design judge found and my own test could not see: the tail
    // runs INSIDE `proposeGroups`, which holds `ai_proposal_started_at` until
    // its `finally` — and both doors it uses (`pullRatesFromDictionary`,
    // `saveTable`) go through `lockRequestInTx`, which refuses on exactly
    // that claim. So the whole pricing half was dead in production while its
    // integration test called the tail DIRECTLY with no claim held: a
    // condition production never has (#531, a third time in this module).
    //
    // The fix is that `proposeGroups` RELEASES before calling the tail — the
    // claim's stated job is to stop two people spending a model call on the
    // same goods, and by then that call is spent. So this asserts both
    // halves of the contract: the tail behaves like every other writer, and
    // `proposal-wire.test.ts` pins that its caller lets go first.
    const { priceProposedGroups } = await import('@/modules/wms/calc/workspace');
    const id = await open([{ name: `plitka ${tag()}`, quantity: 5, tnvedCode: '6907' }]);
    await save(id, {});
    // Strip the rates the mint pulled, so the tail has real work to do.
    await db
      .update(calcGroups)
      .set({ dutyPct: null, vatPct: null, rateSource: null })
      .where(eq(calcGroups.requestId, id));
    await db
      .update(calcRequestItems)
      .set({ tnvedCode: null })
      .where(eq(calcRequestItems.requestId, id));

    // Under a live claim it is refused, exactly like a person's save…
    await db
      .update(calcRequests)
      .set({ aiProposalStartedAt: new Date() })
      .where(eq(calcRequests.id, id));
    await expect(priceProposedGroups(id, ctx())).rejects.toMatchObject({ code: 'ai_running' });

    // …and with the claim released it prices, which is the state
    // `proposeGroups` now hands it.
    await db
      .update(calcRequests)
      .set({ aiProposalStartedAt: null })
      .where(eq(calcRequests.id, id));
    const priced = await priceProposedGroups(id, ctx());
    expect(priced.ratesPulled).toBe(1);
    expect(priced.codesStamped).toBe(1);
    const [group] = await groupRows(id);
    expect(group!.dutyPct).not.toBeNull();
    expect(group!.vatPct).not.toBeNull();

    await db
      .update(calcRequests)
      .set({ completedAt: new Date() })
      .where(eq(calcRequests.id, id));
  });

  it('and the CLAIM heals on the same clock the lock does', async () => {
    // The lock healed and the claim did not, so a pass killed mid-flight —
    // a deploy, with the bot dispatching it in the background — answered
    // `ai_running` to that request FOR EVER: the release lives in a
    // `finally`, and there is no sweep anywhere that clears the column.
    const { proposeGroups } = await import('@/modules/wms/calc/workspace');
    const id = await open([{ name: `z ${tag()}` }]);
    await db
      .update(calcRequests)
      .set({ aiProposalStartedAt: new Date() })
      .where(eq(calcRequests.id, id));
    await expect(proposeGroups(id, ctx())).rejects.toMatchObject({ code: 'ai_running' });

    await db
      .update(calcRequests)
      .set({ aiProposalStartedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(calcRequests.id, id));
    // It gets PAST the claim — this container has no key, so the model half
    // then refuses honestly. Any code but `ai_running` is the claim granted,
    // which is the whole assertion.
    await expect(proposeGroups(id, ctx())).rejects.not.toMatchObject({ code: 'ai_running' });
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

describe('the VED can type the cargo facts the bot could not read', () => {
  /**
   * The owner's report: «agar AI kub kilolarni bermagan bo'lsa lekin
   * materiallarda bo'lsa, ularni VED hodimi o'zi kirgiza olmayabti». The
   * screen accused and offered nothing; the request's weight, volume and
   * route arrived from the bot's reading and nowhere else.
   */
  it('writes them, moves the clock, and clears the checklist', async () => {
    const id = await open([{ name: 'plitka', quantity: 10 }]);
    const before = await loadWorkspace(id);
    expect(before!.weightKg).toBe(500);

    await setCargoFacts(
      id,
      { fromCity: 'Guangzhou', toCity: 'Andijon', weightKg: 812.5, volumeM3: 4.25 },
      ctx(),
    );
    const after = await loadWorkspace(id);
    expect(after!.weightKg).toBe(812.5);
    expect(after!.volumeM3).toBe(4.25);
    expect(after!.fromCity).toBe('Guangzhou');
    // The freight band is looked up at the density, so this moves what a
    // seal would seal — the clock must move with it.
    expect(after!.rev).toBeGreaterThan(before!.rev);
    expect(after!.density).toBeCloseTo(812.5 / 4.25, 3);
  });

  it('an empty box CLEARS the fact rather than writing zero', async () => {
    const id = await open([{ name: 'plitka' }]);
    await setCargoFacts(id, { fromCity: null, toCity: null, weightKg: null, volumeM3: null }, ctx());
    const ws = await loadWorkspace(id);
    expect(ws!.weightKg).toBeNull();
    expect(ws!.volumeM3).toBeNull();
    expect(ws!.fromCity).toBeNull();
  });

  it('refuses the numbers that are not numbers', async () => {
    const id = await open([{ name: 'plitka' }]);
    // Zero is not a weight, it is a blank somebody typed over.
    await expect(
      setCargoFacts(id, { fromCity: null, toCity: null, weightKg: 0, volumeM3: null }, ctx()),
    ).rejects.toMatchObject({ code: 'measure_positive' });
    await expect(
      setCargoFacts(id, { fromCity: null, toCity: null, weightKg: NaN, volumeM3: null }, ctx()),
    ).rejects.toMatchObject({ code: 'bad_number' });
    // numeric(12,3) holds nine whole digits; past it the UPDATE would 22003
    // as a white page instead of as a sentence.
    await expect(
      setCargoFacts(id, { fromCity: null, toCity: null, weightKg: 1e9, volumeM3: null }, ctx()),
    ).rejects.toMatchObject({ code: 'bad_number' });
  });
});

describe('an AI proposal lands as a CALCULATION, not as an empty shell', () => {
  /**
   * MEASURED before this was written, on a real request: `applyProposal`
   * leaves the group carrying the code and nothing else — duty and VAT null,
   * so `customsFor` refuses `rates_missing` — and never stamps the item's own
   * `tnved_code`, so phase 2's grain and 0094's import fill both stay asleep.
   * Pressing ✨ produced a request nobody could price, over a seeded book of
   * 1,489 PP-3818 rates that answers for nearly every code.
   */
  it('pulls the BOOK rate for the proposed code and puts the code on the row', async () => {
    const id = await open([{ name: 'Plitka keramik', quantity: 100 }]);
    const ws0 = await loadWorkspace(id);
    const seq = ws0!.ungrouped[0]!.seq;

    await applyProposal(
      id,
      [
        {
          label: 'Plitka',
          tnvedCode: '6907',
          itemSeqs: [seq],
          aiProposed: true,
          confidence: 'high',
          aiDutyPct: 20,
          note: null,
        },
      ],
      ctx(),
    );

    // What the proposal alone leaves behind: a code, and no way to price it.
    const mid = await loadWorkspace(id);
    expect(mid!.groups[0]!.dutyPct).toBeNull();
    expect((await itemRows(id))[0]!.tnvedCode).toBeNull();

    const out = await priceProposedGroups(id, ctx());
    expect(out.ratesPulled).toBe(1);
    expect(out.codesStamped).toBe(1);

    const after = await loadWorkspace(id);
    const g = after!.groups[0]!;
    // The book's own answer for 6907 — «15 %, min $1/m²» (0091's seed).
    expect(g.dutyPct).toBe(15);
    expect(g.vatPct).toBe(12);
    expect(g.rateSource).toBe('dictionary');
    // …and the MODEL's provenance survives, so `ai_low_confidence` and the
    // ✅'s record still have something to say.
    expect(g.aiProposed).toBe(true);
    // The item carries the code: phase 2's grain, and what the customs
    // import keys on.
    expect((await itemRows(id))[0]!.tnvedCode).toBe('6907');
    // The only thing left is the price a person or the import supplies.
    expect(g.customs).toMatchObject({ ok: false, reason: 'baza_missing' });
  });

  it('a code the dictionary never heard of costs its own group, not the others', async () => {
    const id = await open([{ name: 'A' }, { name: 'B' }]);
    const ws0 = await loadWorkspace(id);
    const [a, b] = ws0!.ungrouped;
    await applyProposal(
      id,
      [
        { label: 'real', tnvedCode: '6907', itemSeqs: [a!.seq], aiProposed: true, confidence: 'high', aiDutyPct: null, note: null },
        { label: 'invented', tnvedCode: '9999999999', itemSeqs: [b!.seq], aiProposed: true, confidence: 'low', aiDutyPct: null, note: null },
      ],
      ctx(),
    );
    const out = await priceProposedGroups(id, ctx());
    // One priced, one skipped — never a refusal that costs both.
    expect(out.ratesPulled).toBe(1);
    const after = await loadWorkspace(id);
    const real = after!.groups.find((g) => g.tnvedCode === '6907')!;
    const invented = after!.groups.find((g) => g.tnvedCode === '9999999999')!;
    expect(real.dutyPct).toBe(15);
    expect(invented.dutyPct).toBeNull();
  });
});

