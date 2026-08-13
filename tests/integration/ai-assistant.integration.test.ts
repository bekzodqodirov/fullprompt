import 'dotenv/config';
import { eq, sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, settings, users } from '@/modules/platform/db/schema';
import { askAssistant } from '@/modules/platform/ai/assistant';
import type { CallModel, ModelResponse } from '@/modules/platform/ai/model';
import type { AssistantActor } from '@/modules/platform/ai/tools';
import { botLookup } from '@/modules/wms/bot/lookup';

/**
 * The assistant loop with a SCRIPTED model — the tests drive the tool loop
 * deterministically, so every branch is provable in CI where no API key
 * exists (which is itself the branch the not-configured test pins).
 *
 * Red proofs run for this file (#166):
 *  - the isAnalyst gate stripped from buildTools (run_sql pushed for all) →
 *    «a staff actor's run_sql call executes nothing» goes red;
 *  - lookup.ts's round-91 balance gate reverted to the two-permission check
 *    → «no balance line for an unassigned client» goes red.
 */

const STAMP = String(Date.now()).slice(-7);
let staffUserId: string;
let ownClientId: string;
let foreignClientId: string;
const OWN_CODE = `QB${STAMP.slice(-4)}`;
const FOREIGN_CODE = `QC${STAMP.slice(-4)}`;

function scripted(responses: ModelResponse[]): CallModel {
  let i = 0;
  return async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return next;
  };
}

function staffActor(overrides: Partial<AssistantActor> = {}): AssistantActor {
  return {
    id: staffUserId,
    fullName: `ai-test ${STAMP}`,
    locale: 'uz',
    roles: ['sales_manager'],
    permissions: new Set(['crm.leads']),
    warehouseScoped: false,
    warehouseIds: [],
    ...overrides,
  };
}

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({
      phone: `+9989${STAMP}9`,
      fullName: `ai-test ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning({ id: users.id });
  staffUserId = user!.id;
  const [own] = await db
    .insert(clients)
    .values({ clientCode: OWN_CODE, name: `ai own ${STAMP}`, salesManagerId: staffUserId })
    .returning({ id: clients.id });
  ownClientId = own!.id;
  const [foreign] = await db
    .insert(clients)
    .values({ clientCode: FOREIGN_CODE, name: `ai foreign ${STAMP}` })
    .returning({ id: clients.id });
  foreignClientId = foreign!.id;
});

afterAll(async () => {
  await db.execute(dsql`DELETE FROM ai_questions WHERE user_id = ${staffUserId}`);
  await db.delete(settings).where(eq(settings.key, 'ai_daily_limit'));
  await db.delete(clients).where(eq(clients.id, ownClientId));
  await db.delete(clients).where(eq(clients.id, foreignClientId));
  await db.delete(users).where(eq(users.id, staffUserId));
  await pgClient.end();
});

async function questionRows() {
  const rows = await db.execute(dsql`
    SELECT question, answer, ok, tool_log FROM ai_questions
    WHERE user_id = ${staffUserId} ORDER BY created_at
  `);
  return rows as unknown as {
    question: string;
    answer: string | null;
    ok: boolean | null;
    tool_log: { tool: string; ok: boolean }[];
  }[];
}

describe('askAssistant', () => {
  it('runs a tool round and records the ledger row', async () => {
    const outcome = await askAssistant(
      { actor: staffActor(), question: `bugun nima bor ${STAMP}`, surface: 'bot' },
      {
        callModel: scripted([
          {
            stopReason: 'tool_use',
            content: [{ type: 'tool_use', id: 't1', name: 'my_day', input: {} }],
          },
          { stopReason: 'end_turn', content: [{ type: 'text', text: 'Bugun ishlar yo‘q.' }] },
        ]),
      },
    );
    expect(outcome).toEqual({ status: 'ok', answer: 'Bugun ishlar yo‘q.' });
    const rows = await questionRows();
    const mine = rows.find((row) => row.question.includes(STAMP));
    expect(mine?.ok).toBe(true);
    expect(mine?.answer).toBe('Bugun ishlar yo‘q.');
    expect(mine?.tool_log[0]?.tool).toBe('my_day');
    expect(mine?.tool_log[0]?.ok).toBe(true);
  });

  it('a staff actor’s run_sql call executes nothing — the tool is not in the map', async () => {
    const outcome = await askAssistant(
      { actor: staffActor(), question: `sql urinish ${STAMP}`, surface: 'web' },
      {
        callModel: scripted([
          {
            stopReason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'run_sql',
                input: { sql: 'SELECT count(*) FROM clients' },
              },
            ],
          },
          { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
        ]),
      },
    );
    expect(outcome.status).toBe('ok');
    const rows = await questionRows();
    const mine = rows.find((row) => row.question.includes(`sql urinish ${STAMP}`));
    // The ledger says the call was REFUSED, not executed.
    expect(mine?.tool_log[0]?.tool).toBe('run_sql');
    expect(mine?.tool_log[0]?.ok).toBe(false);
  });

  it('an analyst’s run_sql runs under the fence and comes back as rows', async () => {
    const outcome = await askAssistant(
      {
        actor: staffActor({ roles: ['admin'] }),
        question: `mijozlar soni ${STAMP}`,
        surface: 'web',
      },
      {
        callModel: scripted([
          {
            stopReason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'run_sql',
                input: { sql: `SELECT client_code FROM clients WHERE id = '${ownClientId}'` },
              },
            ],
          },
          { stopReason: 'end_turn', content: [{ type: 'text', text: `Bitta: ${OWN_CODE}` }] },
        ]),
      },
    );
    expect(outcome.status).toBe('ok');
    const rows = await questionRows();
    const mine = rows.find((row) => row.question.includes(`mijozlar soni ${STAMP}`));
    expect(mine?.tool_log[0]?.ok).toBe(true);
  });

  it('the daily cap refuses atomically and counts every attempt', async () => {
    // This user already spent slots above; the cap must count THOSE too —
    // set the limit to what is already spent and the next ask must refuse.
    const spent = (await questionRows()).length;
    await db
      .insert(settings)
      .values({ key: 'ai_daily_limit', value: spent })
      .onConflictDoUpdate({ target: settings.key, set: { value: spent } });
    const refused = await askAssistant(
      { actor: staffActor(), question: `cap ${STAMP}`, surface: 'bot' },
      { callModel: scripted([{ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }]) },
    );
    expect(refused).toEqual({ status: 'limit' });
    expect((await questionRows()).length).toBe(spent);
    await db.delete(settings).where(eq(settings.key, 'ai_daily_limit'));
  });

  it('unconfigured (no key, no scripted model) answers honestly and writes nothing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const before = (await questionRows()).length;
      const outcome = await askAssistant({
        actor: staffActor(),
        question: `konfiguratsiyasiz ${STAMP}`,
        surface: 'web',
      });
      expect(outcome).toEqual({ status: 'not_configured' });
      expect((await questionRows()).length).toBe(before);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('a model that never stops asking for tools is cut at the round budget', async () => {
    const outcome = await askAssistant(
      { actor: staffActor(), question: `cheksiz ${STAMP}`, surface: 'bot' },
      {
        callModel: scripted([
          {
            stopReason: 'tool_use',
            content: [{ type: 'tool_use', id: 'loop', name: 'my_day', input: {} }],
          },
        ]),
      },
    );
    expect(outcome.status).toBe('gave_up');
    const rows = await questionRows();
    const mine = rows.find((row) => row.question.includes(`cheksiz ${STAMP}`));
    expect(mine?.ok).toBe(false);
    expect(mine?.tool_log).toHaveLength(6);
  });
});

describe('botLookup balance line under round-91 money scope', () => {
  it('shows a seller their own client’s balance and refuses an unassigned one', async () => {
    const seller = staffActor({
      permissions: new Set(['finance.view']),
    });
    const own = await botLookup(seller, OWN_CODE);
    expect(own).toContain('💰');
    const foreign = await botLookup(seller, FOREIGN_CODE);
    expect(foreign).not.toBeNull();
    expect(foreign).not.toContain('💰');
  });

  it('finance.manage keeps the whole book, as /finance does', async () => {
    const accountant = staffActor({ permissions: new Set(['finance.manage']) });
    const foreign = await botLookup(accountant, FOREIGN_CODE);
    expect(foreign).toContain('💰');
  });
});
