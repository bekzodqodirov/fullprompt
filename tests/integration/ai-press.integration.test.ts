import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { ANALYST_MODEL, STAFF_MODEL } from '@/modules/platform/ai/model';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { aiCalcBudgetLeft } from '@/modules/wms/calc/ai-cost';
import { pressToday, reservePress, settlePress, type PressKind } from '@/modules/wms/calc/ai-press';
import { companyMoneySight } from '@/modules/wms/finance/scope';

/**
 * The pressed-AI ledger (0144, docs/TARKIB-TAKLIFLAR.md §1.3): a person's
 * press on an AI button that belongs to no calculation request is COUNTED
 * before it spends and BILLED after — and the count is a real ceiling, held
 * under a lock, because twenty people hold these buttons at once.
 *
 * Everything here goes through the module's own three functions; the rows are
 * read back by this file's own lot ids (random — `lot_id` is a loose pointer),
 * and the day's count is always read with the module's predicate, never
 * assumed to start at zero: the ledger belongs to every file on this database.
 * Both limits are snapshotted once and put back at the end (#183 — a setting
 * left behind is the next file's configuration).
 */

let staffId = '';
const LOT = { a: randomUUID(), b: randomUUID(), burst: randomUUID(), old: randomUUID(), money: randomUUID() };
const TRUCK = randomUUID();
const before: Partial<Record<'tnved_ai_daily_limit' | 'tarkib_ai_daily_limit', unknown>> = {};

const rowsOf = async (lotId: string) =>
  (await db.execute(sql`
    SELECT kind, outcome, model, input_tokens, output_tokens, staff_id::text AS staff_id, batch_id::text AS batch_id
      FROM ai_calc_passes WHERE lot_id = ${lotId}::uuid ORDER BY created_at, id
  `)) as unknown as {
    kind: string;
    outcome: string | null;
    model: string;
    input_tokens: number;
    output_tokens: number;
    staff_id: string | null;
    batch_id: string | null;
  }[];

/** Today's count, by the module's own word. */
const used = async (kind: PressKind) => (await pressToday(kind, null)).used;

const limitKey = (kind: PressKind): 'tnved_ai_daily_limit' | 'tarkib_ai_daily_limit' =>
  kind === 'tnved' ? 'tnved_ai_daily_limit' : 'tarkib_ai_daily_limit';
const setLimit = (kind: PressKind, n: number) => setSetting(limitKey(kind), n, staffId);

beforeAll(async () => {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1);
  staffId = u!.id;
  before.tnved_ai_daily_limit = await getSetting('tnved_ai_daily_limit');
  before.tarkib_ai_daily_limit = await getSetting('tarkib_ai_daily_limit');
});

afterAll(async () => {
  for (const lotId of Object.values(LOT)) await db.execute(sql`DELETE FROM ai_calc_passes WHERE lot_id = ${lotId}::uuid`);
  await setSetting('tnved_ai_daily_limit', before.tnved_ai_daily_limit as number, staffId);
  await setSetting('tarkib_ai_daily_limit', before.tarkib_ai_daily_limit as number, staffId);
  await pgClient.end();
});

describe('a press is one row: reserved, then settled with what happened', () => {
  it('reserve → «reserved», naming the lot, the truck and the person; settle → the outcome and the tokens', async () => {
    await setLimit('tnved', (await used('tnved')) + 5);
    const pass = await reservePress({ kind: 'tnved', staffId, lotId: LOT.a, batchId: TRUCK });
    expect(pass.ok).toBe(true);
    expect(await rowsOf(LOT.a)).toEqual([
      { kind: 'tnved', outcome: 'reserved', model: ANALYST_MODEL, input_tokens: 0, output_tokens: 0, staff_id: staffId, batch_id: TRUCK },
    ]);
    if (!pass.ok) return;
    // The model that ANSWERED is written over the one the reservation assumed.
    await settlePress(pass.id, { outcome: 'ok', usage: { model: STAFF_MODEL, inputTokens: 812, outputTokens: 2044 } });
    expect(await rowsOf(LOT.a)).toEqual([
      { kind: 'tnved', outcome: 'ok', model: STAFF_MODEL, input_tokens: 812, output_tokens: 2044, staff_id: staffId, batch_id: TRUCK },
    ]);
  });

  it('a second settle moves nothing — only a row still «reserved» is closed', async () => {
    const pass = await reservePress({ kind: 'tnved', staffId, lotId: LOT.b, batchId: null });
    if (!pass.ok) throw new Error('reservation refused');
    await settlePress(pass.id, { outcome: 'failed', usage: { model: STAFF_MODEL, inputTokens: 10, outputTokens: 20 } });
    await settlePress(pass.id, { outcome: 'ok', usage: { model: ANALYST_MODEL, inputTokens: 999, outputTokens: 999 } });
    expect(await rowsOf(LOT.b)).toEqual([
      { kind: 'tnved', outcome: 'failed', model: STAFF_MODEL, input_tokens: 10, output_tokens: 20, staff_id: staffId, batch_id: null },
    ]);
  });

  it('a tarkib reading is its own kind with its own limit', async () => {
    await setLimit('tarkib', (await used('tarkib')) + 1);
    const tnvedBefore = await used('tnved');
    const pass = await reservePress({ kind: 'tarkib', staffId, lotId: LOT.a, batchId: null });
    expect(pass.ok).toBe(true);
    expect((await rowsOf(LOT.a)).map((row) => row.kind)).toEqual(['tnved', 'tarkib']);
    // …and it spent none of the 🤖's day.
    expect(await used('tnved')).toBe(tnvedBefore);
    expect(await reservePress({ kind: 'tarkib', staffId, lotId: LOT.a, batchId: null })).toEqual({ ok: false, error: 'ai_limit' });
  });
});

describe('the day’s limit is a ceiling, not a hope', () => {
  it('ten presses at once against three left: exactly three are granted', async () => {
    await setLimit('tnved', (await used('tnved')) + 3);
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => reservePress({ kind: 'tnved', staffId, lotId: LOT.burst, batchId: TRUCK })),
    );
    expect(answers.filter((a) => a.ok)).toHaveLength(3);
    expect(answers.filter((a) => !a.ok).every((a) => !a.ok && a.error === 'ai_limit')).toBe(true);
    expect(await rowsOf(LOT.burst)).toHaveLength(3);
  });

  it('a press the model never answered gives its place back; one left «reserved» by a dead process does not', async () => {
    const rows = (await db.execute(sql`
      SELECT id::text AS id FROM ai_calc_passes WHERE lot_id = ${LOT.burst}::uuid ORDER BY created_at, id
    `)) as unknown as { id: string }[];
    const at = await used('tnved');
    // No usage came back — a timeout, a dead key: written down, not counted.
    await settlePress(rows[0]!.id, { outcome: 'no_answer' });
    expect(await used('tnved')).toBe(at - 1);
    // The second stays reserved (its process died): it goes on being counted.
    // An answer that was no good was paid for: it counts.
    await settlePress(rows[2]!.id, { outcome: 'failed', usage: { model: STAFF_MODEL, inputTokens: 1, outputTokens: 1 } });
    expect(await used('tnved')).toBe(at - 1);
    // So exactly ONE press is free again.
    const again = await Promise.all(
      Array.from({ length: 4 }, () => reservePress({ kind: 'tnved', staffId, lotId: LOT.burst, batchId: TRUCK })),
    );
    expect(again.filter((a) => a.ok)).toHaveLength(1);
  });

  it('0 is «switched off», and so is anything that is not a number of presses', async () => {
    for (const typed of [0, -5, Number.NaN]) {
      await setLimit('tnved', typed);
      expect(await reservePress({ kind: 'tnved', staffId, lotId: LOT.b, batchId: null }), String(typed)).toEqual({
        ok: false,
        error: 'ai_off',
      });
    }
    // A fraction is a whole number of presses, rounded down.
    await setLimit('tnved', (await used('tnved')) + 1.9);
    expect((await reservePress({ kind: 'tnved', staffId, lotId: LOT.b, batchId: null })).ok).toBe(true);
    expect(await reservePress({ kind: 'tnved', staffId, lotId: LOT.b, batchId: null })).toEqual({ ok: false, error: 'ai_limit' });
    expect((await rowsOf(LOT.b)).filter((row) => row.outcome === 'reserved')).toHaveLength(1);
  });

  it('yesterday’s presses are not today’s', async () => {
    await db.execute(sql`
      INSERT INTO ai_calc_passes (kind, staff_id, lot_id, model, outcome, input_tokens, output_tokens, created_at)
      VALUES ('tnved', ${staffId}::uuid, ${LOT.old}::uuid, ${ANALYST_MODEL}, 'ok', 1000000, 0, now() - interval '36 hours')
    `);
    const at = await used('tnved');
    await db.execute(sql`
      INSERT INTO ai_calc_passes (kind, staff_id, lot_id, model, outcome, created_at)
      VALUES ('tnved', ${staffId}::uuid, ${LOT.old}::uuid, ${ANALYST_MODEL}, 'ok', now() - interval '30 hours')
    `);
    expect(await used('tnved')).toBe(at);
  });

  it('the calculation half’s budget and «Oldingi narx»’s never move with a press', async () => {
    await setLimit('tnved', (await used('tnved')) + 2);
    const calc = await aiCalcBudgetLeft();
    const similar = await aiCalcBudgetLeft('similar');
    expect((await reservePress({ kind: 'tnved', staffId, lotId: LOT.a, batchId: TRUCK })).ok).toBe(true);
    expect(await aiCalcBudgetLeft()).toBe(calc);
    expect(await aiCalcBudgetLeft('similar')).toBe(similar);
  });

  it('a ledger that cannot be written refuses the press — closed, in words, never a throw', async () => {
    await setLimit('tnved', (await used('tnved')) + 5);
    const at = (await rowsOf(LOT.a)).length;
    // A server one migration behind: the columns this module names are not there.
    const behind = vi.spyOn(db, 'transaction').mockRejectedValueOnce(Object.assign(new Error('column "lot_id" does not exist'), { code: '42703' }));
    expect(await reservePress({ kind: 'tnved', staffId, lotId: LOT.a, batchId: null })).toEqual({ ok: false, error: 'server_behind' });
    behind.mockRejectedValueOnce(
      Object.assign(new Error('violates check constraint'), { code: '23514', constraint_name: 'ai_calc_passes_anchor_check' }),
    );
    expect(await reservePress({ kind: 'tnved', staffId, lotId: LOT.a, batchId: null })).toEqual({ ok: false, error: 'server_behind' });
    // Any other fault is not «behind» — and still spends nothing.
    behind.mockRejectedValueOnce(new Error('connection reset'));
    expect(await reservePress({ kind: 'tnved', staffId, lotId: LOT.a, batchId: null })).toEqual({ ok: false, error: 'failed' });
    behind.mockRestore();
    expect((await rowsOf(LOT.a)).length).toBe(at);
  });
});

describe('what a day cost — shown only to a reader of the company’s money', () => {
  const reader = { permissions: new Set(['finance.manage', 'finance.reports']) };
  const ved = { permissions: new Set(['ved.docs', 'finance.manage']) };

  it('the count is for everyone; the dollars need the sight', async () => {
    expect(companyMoneySight(ved as never)).toBeNull();
    const plain = await pressToday('tnved', companyMoneySight(ved as never));
    expect(plain.usd).toBeNull();
    expect(plain.usd30).toBeNull();
    expect(plain.used).toBe(await used('tnved'));
    expect(plain.limit).toBe(Math.floor(Number(await getSetting('tnved_ai_daily_limit'))));
  });

  it('list price × tokens of the answered calls: today, and the thirty days', async () => {
    const sight = companyMoneySight(reader as never);
    expect(sight).not.toBeNull();
    const start = await pressToday('tnved', sight);
    // Every row so far names a priced model, so both sums are numbers — a
    // null here would make the differences below read 0 and prove nothing.
    expect(start.usd).not.toBeNull();
    expect(start.usd30).not.toBeNull();
    await setLimit('tnved', (await used('tnved')) + 2);
    const one = await reservePress({ kind: 'tnved', staffId, lotId: LOT.money, batchId: TRUCK });
    const two = await reservePress({ kind: 'tnved', staffId, lotId: LOT.money, batchId: TRUCK });
    if (!one.ok || !two.ok) throw new Error('reservation refused');
    // 1 000 000 in + 200 000 out on the analyst model = $5 + $5; 500 000 in on the staff model = $1.
    await settlePress(one.id, { outcome: 'ok', usage: { model: ANALYST_MODEL, inputTokens: 1_000_000, outputTokens: 200_000 } });
    await settlePress(two.id, { outcome: 'failed', usage: { model: STAFF_MODEL, inputTokens: 500_000, outputTokens: 0 } });
    const after = await pressToday('tnved', sight);
    expect(Math.round((after.usd! - start.usd!) * 100)).toBe(1100);
    expect(Math.round((after.usd30! - start.usd30!) * 100)).toBe(1100);
    // The 36-hour-old row of the test above is in the thirty days and not in today.
    expect(after.usd30! - after.usd!).toBeGreaterThanOrEqual(5);
  });

  it('a model nobody has priced prints no dollars — never a guess', async () => {
    const sight = companyMoneySight(reader as never);
    await setLimit('tnved', (await used('tnved')) + 1);
    const pass = await reservePress({ kind: 'tnved', staffId, lotId: LOT.money, batchId: null });
    if (!pass.ok) throw new Error('reservation refused');
    await settlePress(pass.id, { outcome: 'ok', usage: { model: 'a-model-with-no-price', inputTokens: 10, outputTokens: 10 } });
    const today = await pressToday('tnved', sight);
    expect(today.usd).toBeNull();
    expect(today.usd30).toBeNull();
    expect(today.used).toBeGreaterThan(0);
  });
});

describe('the ledger’s own rules (0144’s CHECKs), by raw insert', () => {
  const tryInsert = async (cols: string, vals: ReturnType<typeof sql>) => {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO ai_calc_passes (${sql.raw(cols)}) VALUES (${vals})`);
        throw new Error('rollback');
      });
    } catch (err) {
      const e = err as { message?: string; constraint_name?: string; cause?: { constraint_name?: string } };
      return e.message === 'rollback' ? 'ok' : (e.constraint_name ?? e.cause?.constraint_name ?? e.message);
    }
    return 'ok';
  };

  it('a pressed kind stands on a lot and on nothing else', async () => {
    for (const kind of ['tnved', 'tarkib']) {
      expect(await tryInsert('kind, model, lot_id', sql`${kind}, 'm', ${LOT.a}::uuid`), kind).toBe('ok');
      expect(await tryInsert('kind, model', sql`${kind}, 'm'`), kind).toBe('ai_calc_passes_anchor_check');
      expect(await tryInsert('kind, model, lot_id, intake_note_id', sql`${kind}, 'm', ${LOT.a}::uuid, ${randomUUID()}::uuid`), kind).toBe(
        'ai_calc_passes_anchor_check',
      );
    }
  });

  it('the old kinds keep their anchors, and the outcome is one of four words or nothing', async () => {
    expect(await tryInsert('kind, model', sql`'similar', 'm'`)).toBe('ok');
    expect(await tryInsert('kind, model, lot_id', sql`'pick', 'm', ${LOT.a}::uuid`)).toBe('ai_calc_passes_anchor_check');
    // (With a request named the anchor's ELSE arm is satisfied, so the kind
    // CHECK is the one that speaks: postgres reports CHECKs in name order,
    // and «anchor» sorts before «kind».)
    expect(await tryInsert('kind, model, request_id', sql`'nonsense', 'm', ${randomUUID()}::uuid`)).toBe('ai_calc_passes_kind_check');
    expect(await tryInsert('kind, model', sql`'nonsense', 'm'`)).toBe('ai_calc_passes_anchor_check');
    expect(await tryInsert('kind, model, lot_id, outcome', sql`'tnved', 'm', ${LOT.a}::uuid, 'maybe'`)).toBe('ai_calc_passes_outcome_check');
    expect(await tryInsert('kind, model, lot_id, outcome', sql`'tnved', 'm', ${LOT.a}::uuid, 'no_answer'`)).toBe('ok');
  });
});
