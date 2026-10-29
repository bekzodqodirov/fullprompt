import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The model is the one thing replaced: the SDK's `messages.create` answers
 * whatever the test scripts — a refusal, a cut-off answer — with the usage a
 * real response carries. Everything that decides what to COUNT is the code
 * that runs in production.
 */
const model = vi.hoisted(() => ({ next: null as null | (() => unknown) }));
vi.mock('@anthropic-ai/sdk', async (original) => {
  const real = await original<typeof import('@anthropic-ai/sdk')>();
  class Scripted extends real.default {
    constructor(opts?: ConstructorParameters<typeof real.default>[0]) {
      super({ ...opts, apiKey: 'test-key' });
      (this as unknown as { messages: unknown }).messages = { create: async () => model.next!() };
    }
  }
  return { ...real, default: Scripted };
});

/**
 * The ledger write is DELAYED (and then made for real): an insert that is
 * awaited is in the table when its caller returns, and one that is not is
 * still on its way. That is the race the `void` this round removed could
 * lose — forced, so the test does not depend on a lucky schedule.
 */
const delay = vi.hoisted(() => ({ ms: 0 }));
vi.mock('@/modules/wms/calc/ai-cost', async (original) => {
  const real = await original<typeof import('@/modules/wms/calc/ai-cost')>();
  return {
    ...real,
    recordAiPass: async (...args: Parameters<typeof real.recordAiPass>) => {
      if (delay.ms > 0) await new Promise((resolve) => setTimeout(resolve, delay.ms));
      return real.recordAiPass(...args);
    },
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  aiCalcPasses,
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  customsImportBatches,
  deals,
  dealStages,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { onDate } from '@/modules/wms/calc/dictionaries';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { proposeGroups, saveTable } from '@/modules/wms/calc/workspace';
import { pickBazas } from '@/modules/wms/calc/prefill-steps';
import { normalizeName } from '@/modules/wms/customs/import-parse';

/**
 * The AI COUNT, 2.9 c (docs/SAKKIZ-R2.md §7.5): a call counts when the model
 * ANSWERED it, whatever was made of the answer — a refusal, a cut-off, an
 * unreadable one. A call with no answer (a timeout, the network) is not
 * counted: it cost nothing or an unknown amount, and a dead key must not
 * spend the day's cap as «budget». And the pick's row is written BEFORE the
 * pass returns, so the soft budget the next pass reads already counts it.
 */
const SUFFIX = String(Date.now()).slice(-6);
const CODE = `96${SUFFIX}11`;
let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const madeBatches: string[] = [];
const ctx = () => ({ actorId });
const keyBefore = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99897${String(Date.now()).slice(-7)}`, fullName: `Count fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  const [client] = await db.insert(clients).values({ clientCode: `GC${SUFFIX}`, name: `Count fixture ${SUFFIX}` }).returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `GC-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Count fixture', createdBy: actorId })
    .returning();
  dealId = deal!.id;
});

afterAll(async () => {
  if (keyBefore === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = keyBefore;
  if (madeRequests.length > 0) {
    await db.delete(aiCalcPasses).where(inArray(aiCalcPasses.requestId, madeRequests));
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
  if (madeBatches.length > 0) await db.delete(customsImportBatches).where(inArray(customsImportBatches.id, madeBatches));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(items: { name: string; tnvedCode?: string | null; weightKg?: number | null }[]) {
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

const passes = (requestId: string, kind: string) =>
  db
    .select({ id: aiCalcPasses.id })
    .from(aiCalcPasses)
    .where(and(eq(aiCalcPasses.requestId, requestId), eq(aiCalcPasses.kind, kind)));

/** A response the SDK would hand back, with the usage a real one carries. */
const answered = (stopReason: string, text = '') => () => ({
  stop_reason: stopReason,
  usage: { input_tokens: 120, output_tokens: 40 },
  content: text ? [{ type: 'text', text }] : [],
});

describe('a grouping call the model answered counts, however it answered', () => {
  it('a REFUSAL with usage → one grouping row', async () => {
    const id = await open([{ name: `Noma’lum tovar ${SUFFIX} 1` }]);
    model.next = answered('refusal');
    await expect(proposeGroups(id, ctx())).rejects.toMatchObject({ code: 'ai_failed' });
    expect(await passes(id, 'grouping')).toHaveLength(1);
  });

  it('an answer cut at max_tokens → one grouping row', async () => {
    const id = await open([{ name: `Noma’lum tovar ${SUFFIX} 2` }]);
    model.next = answered('max_tokens', '{"groups": [{"tnved_code": "6201');
    await expect(proposeGroups(id, ctx())).rejects.toMatchObject({ code: 'ai_failed' });
    expect(await passes(id, 'grouping')).toHaveLength(1);
  });

  it('a call with NO answer (the network) → no row', async () => {
    const id = await open([{ name: `Noma’lum tovar ${SUFFIX} 3` }]);
    model.next = () => {
      throw new Error('socket hang up');
    };
    await expect(proposeGroups(id, ctx())).rejects.toMatchObject({ code: 'ai_failed' });
    expect(await passes(id, 'grouping')).toHaveLength(0);
  });
});

describe('the pick’s call is on the ledger when pickBazas RETURNS', () => {
  let requestId = '';

  beforeAll(async () => {
    // One ready quarter with declarations of CODE named nothing like the row,
    // so the auto-fill leaves the baza empty and the pick is asked.
    const [batch] = await db.execute<{ id: string }>(sql`
      INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to)
      VALUES (${`count-${SUFFIX}.xlsx`}, ${actorId}::uuid, 'ready', ${onDate()}::date, ${onDate()}::date)
      RETURNING id::text AS id`);
    madeBatches.push(batch!.id);
    const declared = 'Детали машин прочие';
    await db.execute(sql`
      INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
      VALUES (${batch!.id}::uuid, ${CODE}, ${declared}, ${normalizeName(declared)}, 'kg', 3::numeric, '156-КИТАЙ')`);
  });

  /** A fresh request with one coded, baza-less row the pick will be asked about. */
  const pickable = async (n: number) => {
    const id = await open([{ name: `Zapchast ${SUFFIX} ${n}`, tnvedCode: CODE, weightKg: 30 }]);
    await saveTable(id, { items: [], adds: [] }, ctx());
    return id;
  };

  it('an answered-but-refused pick → one pick row, already there at return', async () => {
    requestId = await pickable(1);
    delay.ms = 300;
    try {
      await pickBazas(
        requestId,
        ctx(),
        async () => ({ answers: null, usage: { model: 'scripted', inputTokens: 50, outputTokens: 5 } }),
        null,
      );
      // No wait and no poll: the row must exist the moment the call returns.
      expect(await passes(requestId, 'pick')).toHaveLength(1);
    } finally {
      delay.ms = 0;
    }
  });

  it('a pick that got no answer (usage null) → no row', async () => {
    const id = await pickable(2);
    await pickBazas(id, ctx(), async () => ({ answers: null, usage: null }), null);
    expect(await passes(id, 'pick')).toHaveLength(0);
  });
});
