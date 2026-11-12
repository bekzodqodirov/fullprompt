import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * docs/AI-SORAYDI.md §3.1, phase 4 (d) — a typed carton line on the «🤖 AI
 * rastamojka» door with the model SILENT (no key), through the SAME handler
 * chain the server runs (bot-harness) and the real reading job.
 *
 * His sentence 3 — «razmerlari berilgan bo‘lsa hajmni o‘zi chiqara
 * olmayapti» — on the path that runs when the model cannot answer: «Stul 20
 * karobka 60x40x50 sm 15 kg/karobka» was «Tovarlar (0)» with one carton's 15
 * kg the shipment's (DIM-4, MP-2); and «jami 5 cbm» typed at the table was no
 * total — with the model silent it became a PRODUCT «cbm» (dg2-10). Now the
 * row's cube and weight are the carton arithmetic's, marked «*» with ONE
 * legend line, and the shipment's 5 m³ is the answer's.
 *
 * The figures, by hand: one carton is 0.6 × 0.4 × 0.5 = 0.12 m³, twenty are
 * 2.4 m³; twenty cartons of 15 kg are 300 kg.
 */
vi.mock('@/modules/platform/ai/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/ai/model')>()),
  // No key: the reading's model answers nothing, the typed readers are all there is.
  aiConfigured: () => false,
}));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import { db, pgClient } from '@/modules/platform/db/client';
import { roles, telegramLinks, userRoles, users } from '@/modules/platform/db/schema';
import { activeIntake, endIntake, markIntakesHydrated } from '@/modules/platform/telegram/calc-store';
import { runIntakeRead } from '@/modules/platform/telegram/calc-read';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { readingsEnqueued, resetReadingDrive } from '../fixtures/calc-read-drive';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-6);
let h: BotHarness;
let sellerId = '';
let chat = 0;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99895${STAMP}4`, fullName: `Karton ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  sellerId = u!.id;
  const role = await db.query.roles.findFirst({ where: eq(roles.code, 'sales_manager') });
  await db.insert(userRoles).values({ userId: sellerId, roleId: role!.id });
  chat = Number(`95${STAMP}4`);
  await db.insert(telegramLinks).values({ userId: sellerId, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  h = botHarness();
});

beforeEach(() => {
  __resetLifecycle();
  __resetPresses();
  __resetBacklog();
  markBoot(new Date(Date.now() - 60_000));
  markIntakesHydrated();
  resetReadingDrive();
  endIntake(BigInt(chat));
});

afterAll(async () => {
  endIntake(BigInt(chat));
  h?.restore();
  await db.execute(sql`DELETE FROM telegram_calc_intakes WHERE chat_id = ${String(chat)}::bigint`);
  await db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id = ${String(chat)}::bigint`);
  if (sellerId) {
    await db.update(telegramLinks).set({ status: 'revoked' }).where(inArray(telegramLinks.userId, [sellerId]));
    // DEACTIVATED, not deleted: audit_log may point at the seller (round 107's rule).
    await db.update(users).set({ active: false }).where(eq(users.id, sellerId));
  }
  await pgClient.end();
});

/** Every text the bot sent or edited into the chat after a mark, both senders. */
function saidSince(m: ReturnType<BotHarness['mark']>): string[] {
  const since = h.since(m);
  const says = (method: string) => method === 'sendMessage' || method === 'editMessageText';
  return [
    ...since.api.filter((c) => says(c.method) && Number(c.payload.chat_id) === chat).map((c) => String(c.payload.text)),
    ...since.sent.filter((c) => says(c.method) && Number(c.body.chat_id) === chat).map((c) => String(c.body.text)),
  ];
}

function lastMessageIdWith(m: ReturnType<BotHarness['mark']>, data: string): number | null {
  for (const call of [...h.since(m).api, ...h.since(m).sent.map((s) => ({ method: s.method, payload: s.body, messageId: undefined }))].reverse()) {
    if (call.method === 'sendMessage' && JSON.stringify(call.payload.reply_markup ?? '').includes(data)) return call.messageId ?? null;
  }
  return null;
}

/** The AI door → «🔑 Podklyuch» (the cube is asked there) → «🇨🇳 Xitoydan» → GS777 → the typed line → «Bo‘ldi» → the reading job. */
async function readTyped(line: string): Promise<string> {
  let m = h.mark();
  await h.handle(tg.text(chat, '🤖 AI rastamojka'));
  await h.settle();
  const section = lastMessageIdWith(m, 'c:aipk');
  expect(section, 'the section question').not.toBeNull();
  m = h.mark();
  await h.handle(tg.callback(chat, section!, 'c:aipk'));
  await h.settle();
  // «Yuk qayerdan chiqadi?» — the zone is a press, never typed.
  const zone = lastMessageIdWith(m, 'c:zone_cn') ?? section!;
  await h.handle(tg.callback(chat, zone, 'c:zone_cn'));
  await h.settle();
  await h.handle(tg.text(chat, 'GS777'));
  await h.settle();
  m = h.mark();
  await h.handle(tg.text(chat, line));
  await h.settle();
  const prompt = lastMessageIdWith(m, 'c:done') ?? activeIntake(BigInt(chat))!.promptMessageId!;
  m = h.mark();
  await h.handle(tg.callback(chat, prompt, 'c:done'));
  await h.settle();
  const [job] = readingsEnqueued(BigInt(chat));
  expect(job, '«Bo‘ldi» enqueued the reading').toBeDefined();
  // The job the press enqueued, run here — its messages go through send.ts to the harness.
  await runIntakeRead(job!.data, 0);
  await h.settle();
  return saidSince(m).join('\n');
}

describe('a typed carton line on the AI door, the model silent (phase 4 (d))', () => {
  it('the row’s cube and weight are the carton arithmetic’s, marked «*» with one legend line; «jami 5 cbm» is the shipment’s cube', async () => {
    const table = await readTyped('Stul 20 karobka 60x40x50 sm 15 kg/karobka');
    // 20 × 0.6 × 0.4 × 0.5 = 2.4 m³ and 20 × 15 = 300 kg, both the bot's own.
    expect(table).toContain('Stul');
    expect(table).toContain('2.4 m³*');
    expect(table).toContain('300 kg*');
    // ONE legend line for every «*» on the table.
    expect(table.match(/\* — bot hisoblagan/gu) ?? []).toHaveLength(1);
    const read = activeIntake(BigInt(chat))!;
    expect((read.facts?.goods ?? []).map((g) => [g.name, g.volumeM3, g.weightKg])).toEqual([['Stul', 2.4, 300]]);
    // One carton's 15 kg is no total (DIM-4, MP-2).
    expect(read.facts?.weightKg ?? null).not.toBe(15);

    const m = h.mark();
    await h.handle(tg.text(chat, 'jami 5 cbm'));
    await h.settle();
    const answered = saidSince(m).join('\n');
    const state = activeIntake(BigInt(chat))!;
    // The shipment's cube, from the answer — «cbm» the unit, never a product.
    expect(state.facts?.volumeM3).toBe(5);
    expect((state.facts?.goods ?? []).map((g) => g.name)).toEqual(['Stul']);
    // The table says the shipment's cube in its own word, and echoes the answer.
    expect(answered).toContain('✅ Hajm: 5 kub');
    expect(answered).toContain('✍️ Oxirgi javob: umumiy hajm — 5 kub');
    expect(answered).not.toMatch(/jadvalda bunday qator yo‘q/u);
    // …and the row is still drawn with the bot's own cube, the one legend line under it.
    expect(answered).toContain('1. Stul — 300 kg* · 2.4 m³*');
    expect(answered.match(/\* — bot hisoblagan/gu) ?? []).toHaveLength(1);
    // The row keeps its own computed cube beside the shipment's.
    expect(state.facts?.goods?.[0]).toMatchObject({ volumeM3: 2.4 });
  });
});
