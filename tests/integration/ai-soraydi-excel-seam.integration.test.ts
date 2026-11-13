import 'dotenv/config';
import ExcelJS from 'exceljs';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «AI so‘raydi», package P-excel, phase 4 — THE SEAM (docs/AI-SORAYDI.md
 * §3.2 X2-X4), end to end through the SAME handler chain the server runs
 * (bot-harness): the «🤖 AI rastamojka» door, the section press, the
 * customer, a real .xlsx built with exceljs (served bytes → the real
 * `saveIntakeFile` + `readIntakeFile`), «✅ Bo‘ldi» (the reading job run as
 * pg-boss would run it, its messages through the harness's own transport),
 * the TABLE the seller is shown, «✅ Tasdiqlash», and the request's items as
 * the database holds them.
 *
 * A row's packing — 20 cartons of 60×40×50 sm at 15 kg each — is copied by the
 * reader (`parseGoods` → `GoodsRow.packing`), multiplied once by the kernel
 * (`invoiceFacts` → `applyPacking`), carried through the collection
 * (`invoiceGoods` → `state.facts.goods`, packing AND `derived`), drawn by the
 * table with its «*» and the legend, and landed with the arithmetic on the
 * item's note. Any hop that drops `packing` or `derived` turns one of the
 * assertions below red: the table's «*» and «♻️» read `derived`, the note
 * renderer at the landing reads both.
 *
 * The model is stood in for and answers NOTHING (every figure is the sheet's
 * or the kernel's product); the pass's queue is a spy.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  aiCalcAvailable: async () => true,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/ai/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/ai/model')>()),
  aiConfigured: () => true,
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
vi.mock('@/modules/wms/calc/prefill-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/prefill-queue')>()),
  ticketStanding: vi.fn(async () => 'none' as const),
  queueCalcPrefill: vi.fn(async () => true),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  calcRequestItems,
  calcRequests,
  crmActivities,
  events,
  leads,
  notifications,
  roles,
  tasks,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { activeIntake, endIntake, markIntakesHydrated } from '@/modules/platform/telegram/calc-store';
import { runIntakeRead } from '@/modules/platform/telegram/calc-read';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { readingsEnqueued, resetReadingDrive } from '../fixtures/calc-read-drive';
import { botHarness, tg, type ApiCall, type BotHarness, type SentCall } from '../fixtures/bot-harness';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STAMP = String(Date.now()).slice(-6);
let h: BotHarness;
let sellerId = '';
let chat = 0;
let fileSeq = 0;
/** Every collection this file opened — its request, card and stored file go in `afterAll`. */
const notes: string[] = [];

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99895${STAMP}4`, fullName: `AS seam ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
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
  model.analyze.mockReset();
  // The model answers NOTHING: no goods, no totals, no codes.
  model.analyze.mockImplementation(async () => ({
    ok: true,
    facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods: [] },
    steps: [],
    usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
    answered: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
    knownCodes: [],
  }));
});

afterAll(async () => {
  endIntake(BigInt(chat));
  h?.restore();
  await db.execute(sql`DELETE FROM telegram_calc_intakes WHERE chat_id = ${String(chat)}::bigint`);
  const rows = notes.length
    ? await db.select({ id: calcRequests.id, taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.noteId, notes))
    : [];
  const ids = rows.map((r) => r.id);
  const cards = notes.length
    ? (await db.select({ entityId: crmActivities.entityId }).from(crmActivities).where(inArray(crmActivities.id, notes))).map((r) => r.entityId)
    : [];
  if (ids.length) {
    await db.execute(sql`DELETE FROM calc_amendments WHERE request_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, ids));
    await db.execute(sql`DELETE FROM crm_activities WHERE calc_request_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(calcRequests).where(inArray(calcRequests.id, ids));
  }
  const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
  if (taskIds.length) {
    await db.delete(events).where(inArray(events.entityId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  // The stored workbooks (the REAL save kept them against the collection's note).
  if (notes.length) {
    const stored = await db.select({ key: attachments.storageKey }).from(attachments).where(inArray(attachments.entityId, notes));
    for (const row of stored) await getStorage().delete(row.key).catch(() => {});
    await db.delete(attachments).where(inArray(attachments.entityId, notes));
  }
  if (cards.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, cards));
    await db.delete(leads).where(inArray(leads.id, cards));
  }
  if (sellerId) {
    await db.delete(notifications).where(eq(notifications.userId, sellerId));
    await db.update(telegramLinks).set({ status: 'revoked' }).where(eq(telegramLinks.userId, sellerId));
    // DEACTIVATED, not deleted: audit_log points at them (round 107's rule).
    await db.update(users).set({ active: false }).where(eq(users.id, sellerId));
  }
  await pgClient.end();
});

async function xlsxOf(rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The newest text the bot sent or edited into this chat after a mark whose keyboard carries `data` — both senders. */
function textWith(m: ReturnType<BotHarness['mark']>, data: string): string | null {
  const since = h.since(m);
  const says = (method: string) => method === 'sendMessage' || method === 'editMessageText';
  const carries = (markup: unknown) => JSON.stringify(markup ?? '').includes(data);
  const found = [
    ...since.api.filter((c: ApiCall) => says(c.method) && Number(c.payload.chat_id) === chat && carries(c.payload.reply_markup)).map((c) => String(c.payload.text)),
    ...since.sent.filter((c: SentCall) => says(c.method) && Number(c.body.chat_id) === chat && carries(c.body.reply_markup)).map((c) => String(c.body.text)),
  ];
  return found.at(-1) ?? null;
}

/** The newest message carrying this callback — its id, as Telegram would hand it back on a press. */
function lastWith(m: ReturnType<BotHarness['mark']>, data: string): number | null {
  for (const call of [...h.since(m).api].reverse()) {
    const sends = call.method === 'sendMessage' || call.method === 'editMessageText';
    if (!sends || Number(call.payload.chat_id) !== chat || !JSON.stringify(call.payload.reply_markup ?? '').includes(data)) continue;
    return call.method === 'editMessageText' ? Number(call.payload.message_id) : (call.messageId ?? null);
  }
  return null;
}

/**
 * The AI door → «🛃 Faqat rastamojka» → a stranger → the workbook → «✅ Bo‘ldi»
 * → the reading job → the table → «✅ Tasdiqlash»: the table the seller read,
 * and the request's one item as the database holds it.
 */
async function sendAndLand(rows: (string | number | null)[][]) {
  let m = h.mark();
  await h.handle(tg.text(chat, '🤖 AI rastamojka'));
  await h.settle();
  const section = lastWith(m, 'c:ai');
  expect(section, 'the section question').not.toBeNull();
  await h.handle(tg.callback(chat, section!, 'c:ai'));
  await h.settle();
  await h.handle(tg.text(chat, `Seam mijoz ${STAMP}-${fileSeq + 1} +99893${STAMP}${(fileSeq + 1) % 10}`));
  await h.settle();
  const opened = activeIntake(BigInt(chat));
  expect(opened?.stage, 'the customer was taken — the collection waits for material').toBe('material');
  notes.push(opened!.noteId);

  const fileId = `as-seam-${STAMP}-${(fileSeq += 1)}`;
  h.serveFile(fileId, await xlsxOf(rows));
  m = h.mark();
  await h.handle(tg.document(chat, fileId, { fileName: 'packing.xlsx', mime: XLSX }));
  await h.settle();
  const done = lastWith(m, 'c:done');
  expect(done, 'the file prompt carries «✅ Bo‘ldi»').not.toBeNull();

  // «✅ Bo‘ldi» only enqueues; the job is run here as pg-boss runs it, so its
  // messages go through the harness's transport like every other send.
  m = h.mark();
  await h.handle(tg.callback(chat, done!, 'c:done'));
  await h.settle();
  const job = readingsEnqueued(BigInt(chat)).at(-1);
  expect(job, '«✅ Bo‘ldi» enqueued the reading').toBeTruthy();
  await runIntakeRead(job!.data, 0);
  await h.settle();
  const table = textWith(m, 'c:save');
  expect(table, 'the table, with «✅ Tasdiqlash»').not.toBeNull();
  const read = activeIntake(BigInt(chat))!;
  expect(read.stage).toBe('review');

  // «✅ Tasdiqlash» on the table's own message.
  const tableId = read.tableMessageId ?? null;
  expect(tableId, 'the collection knows its table message').not.toBeNull();
  m = h.mark();
  await h.handle(tg.callback(chat, tableId!, 'c:save'));
  await h.settle();
  const [request] = (await db.execute(sql`
    SELECT id, weight_kg::float8 AS kg, volume_m3::float8 AS m3 FROM calc_requests WHERE note_id = ${read.noteId}::uuid`)) as unknown as {
    id: string;
    kg: number | null;
    m3: number | null;
  }[];
  expect(request, '«✅ Tasdiqlash» landed a request').toBeTruthy();
  const items = (await db.execute(sql`
    SELECT name, quantity::float8 AS quantity, weight_kg::float8 AS kg, volume_m3::float8 AS m3, note
    FROM calc_request_items WHERE request_id = ${request!.id}::uuid ORDER BY seq`)) as unknown as {
    name: string;
    quantity: number | null;
    kg: number | null;
    m3: number | null;
    note: string | null;
  }[];
  return { table: table!, facts: read.facts.goods ?? [], items, request: request! };
}

describe('the seam: a sheet’s packing from the reader to the landed item (docs/AI-SORAYDI.md §3.2 X2-X4)', () => {
  it('«CTNS» × «CTN SIZE (CM)» and «G.W./CTN (KG)»: the table draws 2.4 m³* and 300 kg* with the legend, the item lands them with the arithmetic', async () => {
    const { table, facts, items, request } = await sendAndLand([
      ['Description', 'QTY', 'CTNS', 'CTN SIZE (CM)', 'G.W./CTN (KG)'],
      ['Office chair', 40, 20, '60*40*50', 15],
    ]);
    // By hand: one carton 0.6 × 0.4 × 0.5 = 0.12 m³, × 20 cartons = 2.4 m³;
    // 20 cartons × 15 kg = 300 kg. The 40 chairs are the sheet's own.
    // The collection's goods keep the packing AND the arithmetic (the hop the
    // table and the landing both read).
    expect(facts).toHaveLength(1);
    expect(facts[0]!.packing).toMatchObject({ cartons: 20, kgPerCarton: 15, size: { l: 60, w: 40, h: 50, unit: 'cm', of: 'package' }, from: 'file' });
    expect(facts[0]!.derived).toMatchObject({ volumeM3: '20 × 60×40×50 sm', weightKg: '20 × 15 kg' });
    // The table: each computed figure carries ONE «*», and the legend says whose it is.
    const row = table.split('\n').find((l) => l.includes('Office chair'));
    expect(row, 'the table draws the row').toBeTruthy();
    expect(row).toContain('2.4 m³*');
    expect(row).toContain('300 kg*');
    expect(table).toContain('* — bot hisoblagan');
    // Nothing was replaced: no «♻️» line.
    expect(table).not.toContain('♻️');
    // Landed: the products in the item's own columns, the arithmetic on its note.
    expect(items.map((i) => [i.name, i.quantity, i.kg, i.m3])).toEqual([['Office chair', 40, 300, 2.4]]);
    expect(items[0]!.note).toContain('hisoblangan');
    expect(items[0]!.note).toContain('20 × 60×40×50 sm = 2.4 m³');
    expect(items[0]!.note).toContain('20 × 15 kg = 300 kg');
    // The request's cube is the one row's: 2.4 m³ — a figure no cell of the sheet states.
    expect(request.m3).toBe(2.4);
  });

  it('the row’s own «CBM» holding ONE carton’s 0.12: the file’s figure is replaced by the product, and the table says so on its «♻️» line', async () => {
    const { table, facts, items, request } = await sendAndLand([
      ['Description', 'QTY', 'CTNS', 'CTN SIZE (CM)', 'G.W./CTN (KG)', 'CBM'],
      ['Office chair', 40, 20, '60*40*50', 15, 0.12],
    ]);
    // By hand: 0.12 m³ is exactly one 60×40×50 sm carton's (0.6 × 0.4 × 0.5),
    // and the row has 20 of them — so the line's cube is 20 × 0.12 = 2.4 m³,
    // and the file's 0.12 is kept as what was replaced.
    expect(facts[0]!.volumeM3).toBe(2.4);
    expect(facts[0]!.derived?.replaced).toEqual({ volumeM3: 0.12 });
    const row = table.split('\n').find((l) => l.includes('Office chair'));
    expect(row).toContain('2.4 m³*');
    expect(table).toContain('♻️ 1-qator: hajm 0.12 m³ bitta karobkaniki ekan — 20 × 60×40×50 sm = 2.4 m³ deb olindi.');
    expect(items.map((i) => [i.kg, i.m3])).toEqual([[300, 2.4]]);
    // The note keeps what the file said and what was done with it.
    expect(items[0]!.note).toContain('hajm bitta karobkaniki edi (0.12): 20 × 60×40×50 sm = 2.4 m³');
    // …and never the sheet's 0.12 as the request's cube.
    expect(request.m3).toBe(2.4);
  });
});
