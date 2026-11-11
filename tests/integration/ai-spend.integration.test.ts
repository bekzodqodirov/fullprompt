import 'dotenv/config';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { askAssistant } from '@/modules/platform/ai/assistant';
import { ANALYST_MODEL, STAFF_MODEL, type CallModel, type ModelResponse } from '@/modules/platform/ai/model';
import { actorGrants } from '@/modules/platform/rbac/authorize';
import { aiSpend } from '@/modules/wms/reports/ai-spend';
import { composeOwnerSummary } from '@/modules/wms/reports/owner-summary';
import { ownerSummarySight } from '@/modules/wms/reports/owner-summary-door';

/**
 * The evening summary's «🤖 AI» line against the three ledgers' real rows
 * (the owner's «8 ha», 2026-11-11; docs/PRIXOD-XABARI.md §B).
 *
 * The figure is a sum over three tables that know different things, and each
 * of its mistakes is silent: a ledger left out is a smaller bill, an errored
 * run dropped is a smaller count, a row from outside the window is somebody
 * else's day. Every number asserted is typed here.
 *
 * The rows live in a private week of 2019 — no other file writes there — so
 * the totals are this file's own on any database.
 */

const STAMP = String(Date.now()).slice(-7);
const DAY = '2019-03-05';
const FROM = new Date(`${DAY}T00:00:00+05:00`);
const TO = new Date('2019-03-06T00:00:00+05:00');
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00+05:00`;
let userId = '';

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ phone: `+9987${STAMP}5`, fullName: `ai-spend ${STAMP}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  userId = user!.id;
  await sweep();
});

async function sweep() {
  await db.execute(sql`DELETE FROM ai_calc_passes WHERE created_at >= '2019-03-01' AND created_at < '2019-03-14'`);
  await db.execute(sql`DELETE FROM agent_runs WHERE created_at >= '2019-03-01' AND created_at < '2019-03-14'`);
  await db.execute(sql`DELETE FROM ai_questions WHERE created_at >= '2019-03-01' AND created_at < '2019-03-14'`);
}

afterAll(async () => {
  await sweep();
  await db.execute(sql`DELETE FROM ai_questions WHERE user_id = ${userId}::uuid`);
  await db.execute(sql`UPDATE users SET active = false WHERE id = ${userId}::uuid`);
  await pgClient.end();
});

describe('three ledgers, one figure', () => {
  it('each ledger is priced by what IT knows, and what cannot be priced is counted apart', async () => {
    // --- the calculation side -------------------------------------------
    // A calc pass priced from its tokens: 100k in + 20k out on Opus = $0.50 + $0.50.
    await db.execute(sql`INSERT INTO ai_calc_passes (kind, model, input_tokens, output_tokens, created_at)
      VALUES ('similar', ${ANALYST_MODEL}, 100000, 20000, ${at('10:00')}::timestamptz)`);
    // A settled press: its dollars are FROZEN on the row and win over any
    // re-pricing of its tokens (which would say $5.00).
    await db.execute(sql`INSERT INTO ai_calc_passes (kind, model, input_tokens, output_tokens, lot_id, outcome, cost_usd, created_at)
      VALUES ('tnved', ${ANALYST_MODEL}, 1000000, 0, gen_random_uuid(), 'ok', 0.25, ${at('10:05')}::timestamptz)`);
    // A press that never reached the model, and one still reserved: not requests.
    await db.execute(sql`INSERT INTO ai_calc_passes (kind, model, lot_id, outcome, created_at)
      VALUES ('tnved', ${ANALYST_MODEL}, gen_random_uuid(), 'no_answer', ${at('10:06')}::timestamptz),
             ('tarkib', ${ANALYST_MODEL}, gen_random_uuid(), 'reserved', ${at('10:07')}::timestamptz)`);
    // A model nobody prices: counted, said, never a $0 in the sum.
    await db.execute(sql`INSERT INTO ai_calc_passes (kind, model, input_tokens, output_tokens, created_at)
      VALUES ('similar', 'claude-retired-1', 5000, 5000, ${at('10:08')}::timestamptz)`);

    // --- the AI sotuvchi ------------------------------------------------
    // A run with its cache: 10k in + 1k out + 500k cache hit + 100k cache write
    // on Sonnet = 0.02 + 0.01 + 0.10 + 0.25 = $0.38.
    await db.execute(sql`INSERT INTO agent_runs
      (manager_user_id, peer_id, trigger, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, outcome, created_at)
      VALUES (${userId}::uuid, 1, 'style', ${STAFF_MODEL}, 10000, 1000, 500000, 100000, 'draft', ${at('23:30')}::timestamptz)`);
    // An errored run with no usage recorded: it may have reached the model.
    await db.execute(sql`INSERT INTO agent_runs (manager_user_id, peer_id, trigger, outcome, error, created_at)
      VALUES (${userId}::uuid, 2, 'style', 'error', 'boom', ${at('23:31')}::timestamptz)`);
    // Runs that never called anything.
    await db.execute(sql`INSERT INTO agent_runs (manager_user_id, peer_id, trigger, outcome, created_at)
      VALUES (${userId}::uuid, 3, 'style', 'refused', ${at('23:32')}::timestamptz),
             (${userId}::uuid, 4, 'style', 'capped', ${at('23:33')}::timestamptz),
             (${userId}::uuid, 5, 'style', 'reserved', ${at('23:34')}::timestamptz)`);

    // --- the staff assistant ---------------------------------------------
    // A question with its usage (0145): 50k in + 5k out on Sonnet = $0.10 + $0.05.
    await db.execute(sql`INSERT INTO ai_questions (user_id, surface, question, answer, ok, model, input_tokens, output_tokens, created_at)
      VALUES (${userId}::uuid, 'bot', 'q1', 'a', true, ${STAFF_MODEL}, 50000, 5000, ${at('12:00')}::timestamptz)`);
    // Answered before 0145 held any tokens: a request, unpriced.
    await db.execute(sql`INSERT INTO ai_questions (user_id, surface, question, answer, ok, created_at)
      VALUES (${userId}::uuid, 'web', 'q2', 'a', true, ${at('12:01')}::timestamptz)`);
    // Reserved and never answered, with no usage: the model was not reached.
    await db.execute(sql`INSERT INTO ai_questions (user_id, surface, question, created_at)
      VALUES (${userId}::uuid, 'web', 'q3', ${at('12:02')}::timestamptz)`);

    // --- outside the window: the day before and the midnight after --------
    await db.execute(sql`INSERT INTO ai_calc_passes (kind, model, input_tokens, output_tokens, created_at)
      VALUES ('similar', ${ANALYST_MODEL}, 9000000, 0, ${at('23:59', '2019-03-04')}::timestamptz),
             ('similar', ${ANALYST_MODEL}, 9000000, 0, ${at('00:00', '2019-03-06')}::timestamptz)`);

    const spend = await aiSpend(FROM, TO);
    expect(spend.unread).toEqual([]);
    expect(spend.calc).toEqual({ calls: 3, usd: 1.25, unpriced: 1 });
    expect(spend.agent).toEqual({ calls: 2, usd: 0.38, unpriced: 1 });
    expect(spend.assistant).toEqual({ calls: 2, usd: 0.15, unpriced: 1 });
    expect(spend.total).toEqual({ calls: 7, usd: 1.78, unpriced: 3 });
  });

  it('the window is [from, to): the same rows, asked an hour at a time, are each said once', async () => {
    const morning = await aiSpend(new Date(at('09:00')), new Date(at('11:00')));
    expect(morning.total.calls).toBe(3); // the calculation side only
    const night = await aiSpend(new Date(at('23:00')), new Date(at('23:59')));
    expect(night.agent.calls).toBe(2);
    expect(night.calc.calls).toBe(0);
    // The evening hours ARE in a rolling window that ends after them — the
    // reason the daily line is «the last 24 hours» and not «today until 20:00».
    const lastDay = await aiSpend(new Date(at('20:00', '2019-03-04')), new Date(at('20:00')));
    expect(lastDay.agent.calls).toBe(0);
    const nextDay = await aiSpend(new Date(at('20:00')), new Date(at('20:00', '2019-03-06')));
    expect(nextDay.agent.calls).toBe(2);
  });
});

describe('on the message itself — the wire no unit test can see', () => {
  // `aiSpend` is proven above and `aiLine` in the unit file; what joins them
  // is two lines of `composeOwnerSummary` (the window, and which field goes
  // where). Mapped wrong — the count for the unpriced, Monday's label over
  // a day's figures — typecheck, lint and every other test stayed green.
  const plain = (text: string) => text.replace(/\u00a0/g, ' ');
  async function summaryAt(now: string) {
    const [owner] = (await db.execute(sql`
      SELECT u.id FROM users u WHERE u.phone = '+998900000001' AND u.active
    `)) as unknown as { id: string }[];
    const actor = { id: owner!.id, ...(await actorGrants(owner!.id)) };
    const sight = ownerSummarySight(actor);
    expect(sight, 'the demo owner reads the company’s money').not.toBeNull();
    return composeOwnerSummary(actor, sight!, new Date(now));
  }

  it('a daily message: the last 24 hours of all three ledgers, the same total as the read above', async () => {
    // Wednesday 06.03 00:00 — the 24 hours behind it are exactly Tuesday.
    const summary = await summaryAt('2019-03-06T00:00:00+05:00');
    expect(summary.window).toBe('bugun');
    expect(summary.facts.ai).toEqual({ usd: 1.78, calls: 7, unpriced: 3, unread: [] });
    expect(summary.facts.aiDay).toBeNull();
    const line = plain(summary.text)
      .split('\n')
      .filter((l) => l.startsWith('🤖'));
    expect(line).toEqual(['🤖 AI (oxirgi 24 soat): ≈ $1.78 · 7 murojaat (3 tasining narxi noma’lum)']);
  });

  it('Monday: the closed week, AND the last 24 hours under it — Monday’s own working hours are said that evening', async () => {
    // Monday 11.03, 10:00: one calculation ($1.00). It is after the closed
    // week (04.03-10.03), and Tuesday's line starts at Monday 20:00 — so with
    // the week line alone it was on NO evening's message.
    await db.execute(sql`INSERT INTO ai_calc_passes (kind, model, input_tokens, output_tokens, created_at)
      VALUES ('similar', ${ANALYST_MODEL}, 100000, 20000, '2019-03-11T10:00:00+05:00'::timestamptz)`);
    const monday = await summaryAt('2019-03-11T20:00:00+05:00');
    expect(monday.window).toBe('hafta');
    // The week: Tuesday's seven, plus the two rows this file wrote on either
    // side of Tuesday (9M input tokens each on Opus = $45.00 each).
    expect(monday.facts.ai).toEqual({ usd: 91.78, calls: 9, unpriced: 3, unread: [] });
    expect(monday.facts.aiDay).toEqual({ usd: 1, calls: 1, unpriced: 0, unread: [] });
    const lines = plain(monday.text)
      .split('\n')
      .filter((l) => l.startsWith('🤖'));
    expect(lines).toEqual([
      '🤖 AI (hafta): ≈ $91.78 · 9 murojaat (3 tasining narxi noma’lum)',
      '🤖 AI (oxirgi 24 soat): ≈ $1.00 · 1 murojaat',
    ]);
    // …and Tuesday evening does not say it again.
    const tuesday = await summaryAt('2019-03-12T20:00:00+05:00');
    expect(tuesday.facts.ai).toEqual({ usd: 0, calls: 0, unpriced: 0, unread: [] });
    expect(plain(tuesday.text)).not.toContain('🤖');
  });
});

describe('what cannot be read or written is SAID — never a smaller bill in silence', () => {
  const dialect = new PgDialect();
  const textOf = (query: unknown) => dialect.sqlToQuery(query as SQL).sql;
  /** `db.execute` with ONE statement refused — the one `refuse` recognises; every other goes to postgres. */
  function refusing(refuse: (text: string) => boolean, error: Error) {
    const real = db.execute.bind(db) as (query: SQL) => Promise<unknown>;
    const seen: string[] = [];
    const spy = vi.spyOn(db, 'execute').mockImplementation(((query: SQL) => {
      const text = textOf(query);
      seen.push(text);
      return refuse(text) ? Promise.reject(error) : real(query);
    }) as unknown as typeof db.execute);
    return { seen, restore: () => spy.mockRestore() };
  }

  it('a ledger that cannot be read is NAMED on the line, and the other two are still counted', async () => {
    const down = refusing((text) => /FROM agent_runs/.test(text), new Error('relation "agent_runs" does not exist'));
    try {
      const spend = await aiSpend(FROM, TO);
      expect(spend.unread).toEqual(['agent']);
      expect(spend.calc).toEqual({ calls: 3, usd: 1.25, unpriced: 1 });
      expect(spend.assistant).toEqual({ calls: 2, usd: 0.15, unpriced: 1 });
      expect(spend.total).toEqual({ calls: 5, usd: 1.4, unpriced: 2 });
      // …and on the message: without the catch around each ledger the whole
      // read rejects, the summary swallows it, and the line is simply gone.
      const [owner] = (await db.execute(sql`SELECT id FROM users WHERE phone = '+998900000001' AND active`)) as unknown as { id: string }[];
      const actor = { id: owner!.id, ...(await actorGrants(owner!.id)) };
      const summary = await composeOwnerSummary(actor, ownerSummarySight(actor)!, new Date('2019-03-06T00:00:00+05:00'));
      const line = summary.text.replace(/\u00a0/g, ' ').split('\n').filter((l) => l.startsWith('🤖'));
      expect(line).toEqual(['🤖 AI (oxirgi 24 soat): ≈ $1.40 · 5 murojaat (2 tasining narxi noma’lum) · ⚠ o‘qilmadi: sotuvchi AI']);
    } finally {
      down.restore();
    }
  });

  it('the assistant’s ledger names NO 0145 column: every one is read through the row’s json', async () => {
    // A server one migration behind has no `model` / token columns on
    // `ai_questions`. Named directly, the statement is a 42703 there and the
    // line reads «⚠ o‘qilmadi: yordamchi AI» instead of counting the
    // questions; through `to_jsonb(q)->>` a missing column is NULL.
    const all = refusing(() => false, new Error('unused'));
    try {
      await aiSpend(FROM, TO);
      const assistant = all.seen.find((text) => /FROM ai_questions q/.test(text));
      expect(assistant, 'the statement that reads the assistant’s ledger').toBeDefined();
      // The aliases carry the names, and `model` is read as a json KEY;
      // nothing else may name one (the token names travel as parameters).
      const body = assistant!
        .replace(/\bAS (model|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens)\b/g, '')
        .replace(/to_jsonb\(q\)->>'model'/g, '');
      expect(body).not.toMatch(/\b(model|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens)\b/);
      expect(body).toMatch(/to_jsonb\(q\)->>/);
    } finally {
      all.restore();
    }
  });

  it('a server that refuses the usage write still ANSWERS: the bill is not the question', async () => {
    // The usage UPDATE names 0145's columns. One migration behind it is a
    // 42703 — and uncaught it lands in the question's own failure branch,
    // which writes `answer = NULL, ok = false` over the answer just stored:
    // every question to the assistant would fail on such a server.
    const behind = refusing(
      (text) => /UPDATE ai_questions/.test(text) && /input_tokens/.test(text),
      Object.assign(new Error('column "model" of relation "ai_questions" does not exist'), { code: '42703' }),
    );
    try {
      const callModel: CallModel = async () => ({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Javob.' }],
        usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
      const outcome = await askAssistant(
        {
          actor: {
            id: userId,
            fullName: `ai-spend ${STAMP}`,
            locale: 'uz',
            roles: ['sales_manager'],
            permissions: new Set(['crm.leads']),
            warehouseScoped: false,
            warehouseIds: [],
          },
          question: `eski baza ${STAMP}`,
          surface: 'bot',
        },
        { callModel },
      );
      expect(outcome).toEqual({ status: 'ok', answer: 'Javob.' });
      // The refusal was really met — or this test proved nothing about it.
      expect(behind.seen.some((text) => /UPDATE ai_questions/.test(text) && /input_tokens/.test(text))).toBe(true);
    } finally {
      behind.restore();
    }
    const [row] = (await db.execute(sql`
      SELECT answer, ok, input_tokens FROM ai_questions WHERE user_id = ${userId}::uuid AND question = ${`eski baza ${STAMP}`}
    `)) as unknown as { answer: string | null; ok: boolean | null; input_tokens: number | null }[];
    // Answered, and no usage on the row (the column's own default): the bill
    // is what was lost, and the summary counts this question as unpriced.
    expect(row).toEqual({ answer: 'Javob.', ok: true, input_tokens: 0 });
  });
});

describe('the assistant records what a question cost', () => {
  it('summed over its rounds, on the question’s own row — the ledger the line could count and not price', async () => {
    const answers: ModelResponse[] = [
      {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'my_day', input: {} }],
        usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Bugun ishlar yo‘q.' }],
        usage: { inputTokens: 1500, outputTokens: 40, cacheReadTokens: 300, cacheWriteTokens: 0 },
      },
    ];
    let round = 0;
    const callModel: CallModel = async () => answers[round++]!;
    const outcome = await askAssistant(
      {
        actor: {
          id: userId,
          fullName: `ai-spend ${STAMP}`,
          locale: 'uz',
          roles: ['sales_manager'],
          permissions: new Set(['crm.leads']),
          warehouseScoped: false,
          warehouseIds: [],
        },
        question: `xarajat ${STAMP}`,
        surface: 'bot',
      },
      { callModel },
    );
    expect(outcome).toEqual({ status: 'ok', answer: 'Bugun ishlar yo‘q.' });
    const [row] = (await db.execute(sql`
      SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
        FROM ai_questions WHERE user_id = ${userId}::uuid AND question = ${`xarajat ${STAMP}`}
    `)) as unknown as Record<string, unknown>[];
    expect(row).toEqual({ model: STAFF_MODEL, input_tokens: 2700, output_tokens: 120, cache_read_tokens: 300, cache_write_tokens: 0 });
  });
});
