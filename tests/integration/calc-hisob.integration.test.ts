import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
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
import { onDate, saveRates } from '@/modules/wms/calc/dictionaries';
import {
  confirmAllGroups,
  loadWorkspace,
  recalcFromSealed,
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
/** A run-unique ten-digit code under `heading` (the book answers the heading;
 * the memory and the lgota are keyed on the full code). */
let codeSeq = 10;
const codeUnder = (heading: string) =>
  `${heading}${String((Number(SUFFIX) + (codeSeq += 1)) % 1_000_000).padStart(10 - heading.length, '0')}`;

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
async function priced(
  code: string,
  opts: { quantity?: number; weightKg?: number | null; bazaUsd?: number; measureQty?: number; name?: string } = {},
) {
  const id = await open([
    { name: opts.name ?? `tovar ${tag()}`, quantity: opts.quantity ?? 100, weightKg: opts.weightKg ?? 50 },
  ]);
  await save(id, [
    await editOf(id, 1, {
      tnvedCode: code,
      bazaUsd: opts.bazaUsd ?? 20,
      bazaBasis: 'unit',
      ...(opts.measureQty !== undefined ? { measureQty: opts.measureQty } : {}),
    }),
  ]);
  return id;
}

/** A book row this file writes — through the service, so the carry runs. */
async function teach(input: Parameters<typeof saveRates>[0]) {
  const id = await saveRates(input, ctx());
  madeRates.push(id);
  return db.query.calcRates.findFirst({ where: eq(calcRates.id, id) });
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

describe('the law\'s SHAPE survives every writer (P2.1)', () => {
  it('a percentage taught under a MAX heading keeps the floor, and the next job prices it', async () => {
    // Heading 6403 is «20 %, kamida $3/juft» in the book. The commonest
    // correction there is — «lug'atga yozish» posting 15 % for a full code
    // with no row of its own — used to mint a PURE advalor row that from then
    // on out-prefixed the heading and dropped the floor for ever.
    const code = codeUnder('6403');
    const row = await teach({ tnvedCode: code, dutyPct: 15, vatPct: 12, effectiveDate: onDate() });
    expect(row).toMatchObject({ dutyMode: 'max', dutySpecific: '3.0000', dutyUnit: 'juft', dutyPct: '15.000' });

    // The next job under the code: 100 juft at $10 a piece = $1 000 of value;
    // 15 % is $150, the floor is 100 × $3 = $300, so the duty is $300; VAT
    // 12 % of $1 300 = $156; customs $456 — the floor's money, by hand.
    const id = await priced(code, { quantity: 100, bazaUsd: 10, measureQty: 100 });
    const ws = await loadWorkspace(id);
    const g = ws!.groups[0]!;
    expect(g).toMatchObject({ dutyMode: 'max', dutySpecific: 3, dutyUnit: 'juft', dutyPct: 15 });
    expect(g.customs).toMatchObject({ ok: true, dutyUsd: 300, vatUsd: 156, customsUsd: 456 });
  });

  it('a RatesForm-shaped post with no mode keeps the floor; only «foiz» removes it (MR-14)', async () => {
    const kept = await teach({ tnvedCode: codeUnder('6403'), dutyPct: 20, vatPct: 12, effectiveDate: onDate() });
    expect(kept).toMatchObject({ dutyMode: 'max', dutySpecific: '3.0000', dutyUnit: 'juft' });
    const plain = await teach({
      tnvedCode: codeUnder('6403'),
      dutyPct: 20,
      vatPct: 12,
      effectiveDate: onDate(),
      dutyMode: 'advalor',
    });
    expect(plain).toMatchObject({ dutyMode: 'advalor', dutySpecific: null, dutyUnit: null });
  });
});

describe('a group says when the book moved, and the correction re-reads it (P2.2)', () => {
  it('a ⚙ save that keeps the law keeps «lug‘atdan»; a changed rate is typed (TT-6)', async () => {
    const id = await priced(codeUnder('9618'));
    const [g] = await groupRows(id);
    expect(g!.rateSource).toBe('dictionary');
    await setGroupRates(
      g!.id,
      { tnvedCode: g!.tnvedCode, dutyPct: 10, vatPct: 12, dutyFree: true, vatFree: false },
      ctx(),
    );
    expect((await groupRows(id))[0]!.rateSource).toBe('dictionary');
    await setGroupRates(
      g!.id,
      { tnvedCode: g!.tnvedCode, dutyPct: 7, vatPct: 12, dutyFree: false, vatFree: false },
      ctx(),
    );
    expect((await groupRows(id))[0]!.rateSource).toBe('typed');
  });

  it('dictionary_moved names today’s law; the recalc pulls it and SAYS so', async () => {
    const code = codeUnder('9618');
    const id = await priced(code);
    expect((await loadWorkspace(id))!.groups[0]!.warnings).not.toContain('dictionary_moved');

    // The book moves under the open job: the code gets a row of its own.
    await teach({ tnvedCode: code, dutyPct: 15, vatPct: 12, effectiveDate: onDate() });
    const moved = (await loadWorkspace(id))!.groups[0]!;
    expect(moved.dutyPct).toBe(10);
    expect(moved.dictionaryRates).toMatchObject({ dutyPct: 15, matchedCode: code });
    expect(moved.warnings).toContain('dictionary_moved');
    expect(moved.warnings).not.toContain('rate_off_dictionary');

    // Sealed as it stood — then corrected: the dictionary group is re-read.
    await confirmAllGroups(id, ctx());
    await sealCalc(id, SEAL, ctx());
    const fresh = await recalcFromSealed(id, ctx());
    madeRequests.push(fresh.id);
    expect(fresh.relawed).toEqual([code]);
    expect(fresh.remeasure).toEqual([]);
    const [g] = await groupRows(fresh.id);
    expect(g).toMatchObject({ dutyPct: '15.000', rateSource: 'dictionary' });
    expect(g!.confirmedAt).toBeNull();
  });

  it('a TYPED group is never re-pulled by a recalc — a person’s word stands', async () => {
    const code = codeUnder('9618');
    const id = await priced(code);
    const [g] = await groupRows(id);
    await setGroupRates(
      g!.id,
      { tnvedCode: code, dutyPct: 7, vatPct: 12, dutyFree: false, vatFree: false },
      ctx(),
    );
    await confirmAllGroups(id, ctx());
    await sealCalc(id, SEAL, ctx());
    await teach({ tnvedCode: code, dutyPct: 15, vatPct: 12, effectiveDate: onDate() });
    const fresh = await recalcFromSealed(id, ctx());
    madeRequests.push(fresh.id);
    expect(fresh.relawed).toEqual([]);
    expect((await groupRows(fresh.id))[0]).toMatchObject({ dutyPct: '7.000', rateSource: 'typed' });
  });
});

describe('a re-pulled law that moves the unit names its rows (MR-15, TT-8)', () => {
  it('advalor → «kamida $3/juft» on the correction: the row is named, its pair waits for Saqlash', async () => {
    const code = codeUnder('9618');
    const id = await priced(code);
    await confirmAllGroups(id, ctx());
    await sealCalc(id, SEAL, ctx());
    await teach({
      tnvedCode: code,
      dutyPct: 10,
      vatPct: 12,
      effectiveDate: onDate(),
      dutyMode: 'max',
      dutySpecific: 3,
      dutyUnit: 'juft',
    });
    const fresh = await recalcFromSealed(id, ctx());
    madeRequests.push(fresh.id);
    expect(fresh.relawed).toEqual([code]);
    expect(fresh.remeasure).toEqual([1]);
    expect((await groupRows(fresh.id))[0]).toMatchObject({ dutyMode: 'max', dutyUnit: 'juft' });
  });
});

describe('a short code says what its heading hides (P2.3)', () => {
  it('8528 typed alone: the deeper MAX rows are named, recorded as code_heading', async () => {
    const id = await priced('8528');
    const g = (await loadWorkspace(id))!.groups[0]!;
    expect(g.warnings).toContain('code_heading');
    expect(g.codeHeading!.code.startsWith('852872')).toBe(true);
    expect(g.codeHeading).toMatchObject({ dutyMode: 'max', dutyUnit: 'dona' });
  });

  it('a full code answered by its heading is INFORMATION, never the warning (UX8)', async () => {
    const g = (await loadWorkspace(await priced(codeUnder('9618'))))!.groups[0]!;
    expect(g.dictionaryRates!.matchedCode).toBe('9618');
    expect(g.warnings).not.toContain('code_heading');
    expect(g.codeHeading).toBeNull();
  });
});

describe('the excise can be entered, in one shape (P2.4)', () => {
  it('a specific excise prices per unit, in the VAT base, and the recalc carries it', async () => {
    const id = await priced(codeUnder('9618'));
    const [g] = await groupRows(id);
    await setGroupRates(
      g!.id,
      {
        tnvedCode: g!.tnvedCode,
        dutyPct: 10,
        vatPct: 12,
        dutyFree: false,
        vatFree: false,
        exciseSpecific: 0.5,
        exciseUnit: 'dona',
      },
      ctx(),
    );
    // 100 × $20 = $2 000; duty $200; excise 100 dona × $0.50 = $50; VAT 12 %
    // of $2 250 = $270; customs $520.
    const ws = (await loadWorkspace(id))!.groups[0]!;
    expect(ws).toMatchObject({ excisePct: null, exciseSpecific: 0.5, exciseUnit: 'dona' });
    expect(ws.customs).toMatchObject({ ok: true, exciseUsd: 50, vatUsd: 270, customsUsd: 520 });

    await confirmAllGroups(id, ctx());
    await sealCalc(id, SEAL, ctx());
    const fresh = await recalcFromSealed(id, ctx());
    madeRequests.push(fresh.id);
    expect((await groupRows(fresh.id))[0]).toMatchObject({ exciseSpecific: '0.5000', exciseUnit: 'dona' });
  });

  it('two shapes at once, a half pair, or a unit beside the law are refused in words', async () => {
    const id = await priced(codeUnder('9618'));
    const [g] = await groupRows(id);
    const base = { tnvedCode: g!.tnvedCode, dutyPct: 10, vatPct: 12, dutyFree: false, vatFree: false };
    await expect(
      setGroupRates(g!.id, { ...base, excisePct: 5, exciseSpecific: 0.5, exciseUnit: 'dona' }, ctx()),
    ).rejects.toMatchObject({ code: 'excise_shape' });
    await expect(setGroupRates(g!.id, { ...base, exciseSpecific: 0.5 }, ctx())).rejects.toMatchObject({
      code: 'excise_shape',
    });
    // An advalor law pins no pair, so a per-litre excise would need a second
    // measure pair on the row (judge S4).
    await expect(
      setGroupRates(g!.id, { ...base, exciseSpecific: 0.5, exciseUnit: 'litr' }, ctx()),
    ).rejects.toMatchObject({ code: 'excise_unit' });
    // And the table says the same, whatever writer forgets (0131).
    await expect(
      db.execute(
        sql`UPDATE calc_groups SET excise_pct = 5, excise_specific = 1, excise_unit = 'kg' WHERE id = ${g!.id}`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('an excisable code with the excise unanswered says so; «yo‘q» is an answer', async () => {
    const id = await priced(codeUnder('2203'));
    const [g] = await groupRows(id);
    expect(g!.dutyPct, 'the seeded book answers heading 2203').not.toBeNull();
    expect((await loadWorkspace(id))!.groups[0]!.warnings).toContain('excise_unanswered');
    await setGroupRates(
      g!.id,
      {
        tnvedCode: g!.tnvedCode,
        dutyPct: Number(g!.dutyPct),
        vatPct: Number(g!.vatPct),
        dutyFree: false,
        vatFree: false,
        excisePct: 0,
      },
      ctx(),
    );
    expect((await loadWorkspace(id))!.groups[0]!.warnings).not.toContain('excise_unanswered');
  });
});

describe('the seal locks the fee the screen showed (P2.6)', () => {
  it('a moved fee is a conflict, null against a figure too; the receipt keeps the inputs', async () => {
    const id = await priced(codeUnder('9618'));
    await confirmAllGroups(id, ctx());
    const ws = await loadWorkspace(id);
    expect(ws!.fee).toMatchObject({ ok: true });
    const fee = ws!.fee!.ok ? ws!.fee!.feeUsd : 0;
    await expect(sealCalc(id, { ...SEAL, sawFeeUsd: fee + 1 }, ctx())).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(sealCalc(id, { ...SEAL, sawFeeUsd: null }, ctx())).rejects.toMatchObject({ code: 'conflict' });
    await sealCalc(id, { ...SEAL, sawFeeUsd: fee }, ctx());
    const [v] = await db.select().from(calcVersions).where(eq(calcVersions.requestId, id));
    const receipt = (v!.breakdown as { fee?: Record<string, unknown> }).fee!;
    expect(receipt).toMatchObject({ ok: true, feeUsd: fee, bhmUzs: ws!.bhmUzs, fxUzsPerUsd: ws!.fxUzsPerUsd });
    expect(receipt.fxDate).toBe(ws!.fxDate);
    expect(String(receipt.fxDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the reconcile compares cubic metres only (MR-8)', () => {
  it('netto under brutto is not a mismatch; a volume gap still is', async () => {
    // The request declares 500 kg / 10 m³ (open()); the line is 50 kg netto.
    const id = await priced(codeUnder('9618'));
    await save(id, [await editOf(id, 1, { volumeM3: 10 })]);
    expect((await loadWorkspace(id))!.reconcile.mismatch).toBe(false);
    await save(id, [await editOf(id, 1, { volumeM3: 5 })]);
    expect((await loadWorkspace(id))!.reconcile.mismatch).toBe(true);
  });
});

describe('a baza says when its source is old, whatever the source (TT-19)', () => {
  it('a baza the sealed memory supplied ages with the seal it came from', async () => {
    const name = `memory etik ${tag()} ${Math.random().toString(36).slice(2, 8)}`;
    const code = codeUnder('9618');
    const first = await priced(code, { name, bazaUsd: 33 });
    await confirmAllGroups(first, ctx());
    await sealCalc(first, SEAL, ctx());

    const next = await open([{ name, quantity: 10, weightKg: 5 }]);
    await save(next, []);
    const fresh = (await loadWorkspace(next))!;
    const item = [...fresh.groups.flatMap((g) => g.items), ...fresh.ungrouped][0]!;
    expect(item.bazaSource, 'the memory answers its own name').toBe('memory');
    expect(item.bazaStale).toBe(false);

    await db
      .update(calcVersions)
      .set({ sealedAt: new Date('2025-01-01T09:00:00Z') })
      .where(eq(calcVersions.requestId, first));
    const aged = (await loadWorkspace(next))!;
    const again = [...aged.groups.flatMap((g) => g.items), ...aged.ungrouped][0]!;
    expect(again.bazaStale).toBe(true);
  });
});
