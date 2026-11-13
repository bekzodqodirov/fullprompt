import 'dotenv/config';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «AI so‘raydi», package P-excel, phase 2 (docs/AI-SORAYDI.md §3.2 X2-X4) —
 * the packing a sheet's row keeps, landed: a real workbook goes through the
 * file door and the reading of the «🤖 AI rastamojka» door, the collection
 * lands, and the REQUEST'S ITEMS are read back out of the database. This is
 * the half no unit test can see: what the VED opens — the figure in the
 * item's own column, and the note that says the bot multiplied it, and from
 * what.
 *
 * The file door, the reading's merge, the landing and the INSERT are real;
 * the model is stood in for and answers nothing (every number is the sheet's
 * or the kernel's product), the pass's queue is a spy.
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
const queue = vi.hoisted(() => ({ spy: vi.fn(async () => true) }));
vi.mock('@/modules/wms/calc/prefill-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/prefill-queue')>()),
  queueCalcPrefill: queue.spy,
}));
vi.mock('@/modules/platform/telegram/send', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/send')>()),
  sendText: vi.fn(async () => ({ ok: true, status: 200, description: '', messageId: 68_001, retryAfter: null, permanent: false, botDown: false, usedFallback: false })),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequestItems, calcRequests, crmActivities, events, leads, notifications, tasks, telegramLinks, users } from '@/modules/platform/db/schema';
import { readIntakeFile } from '@/modules/platform/telegram/calc-files';
import { activeIntake, analyzeCollected, endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { landCollectedIntake } from '@/modules/platform/telegram/staff-bot';
import * as B from '../fixtures/fayl-books';

const STAMP = String(Date.now()).slice(-7);
const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
let seq = 0;
const staffIds: string[] = [];
const chats: bigint[] = [];
const notes: string[] = [];

type R = (string | number | null)[];

/** One workbook sent to a fresh AI-door collection of a linked staff chat, read, landed — and its items as stored. */
async function landedItems(section: 'rastamojka' | 'podklyuch', header: (string | null)[], rows: R[]) {
  seq += 1;
  const chat = BigInt(`-78${STAMP}${String(seq).padStart(2, '0')}`);
  chats.push(chat);
  const [u] = await db
    .insert(users)
    .values({ phone: `+99878${STAMP}${String(seq).padStart(2, '0')}`, fullName: `AS excel ${STAMP}-${seq}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  const staffId = u!.id;
  staffIds.push(staffId);
  await db.insert(telegramLinks).values({ userId: staffId, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
  const started = startIntake(chat, section, { ai: true, staffId });
  notes.push(started.noteId);
  updateIntake(chat, { stage: 'material', clientHintRaw: `AS excel ${STAMP}-${seq} +99893${STAMP}${seq % 10}` });

  const live = activeIntake(chat)!;
  const body = await B.sheetsBook([['Sheet1', header, rows]]);
  const answer = await readIntakeFile({ isPhoto: false, body, attachmentId: `as-excel-int-${seq}` }, 'pl.xlsx', B.XLSX, live);
  updateIntake(chat, { ...answer.patch, fileCount: live.fileCount + 1 });
  const read = await analyzeCollected(activeIntake(chat)!);
  updateIntake(chat, { ...read, answered: undefined, stage: 'review' } as never);

  const landed = await landCollectedIntake(chat, staffId, 'AS excel');
  expect(landed?.requestId, 'the collection landed a request').toBeTruthy();
  const items = (await db.execute(sql`
    SELECT name, quantity::float8 AS quantity, unit, weight_kg::float8 AS kg, volume_m3::float8 AS m3,
           measure_unit AS "measureUnit", measure_qty::float8 AS "measureQty", note
    FROM calc_request_items WHERE request_id = ${landed!.requestId!}::uuid ORDER BY seq`)) as unknown as {
    name: string;
    quantity: number | null;
    unit: string | null;
    kg: number | null;
    m3: number | null;
    measureUnit: string | null;
    measureQty: number | null;
    note: string | null;
  }[];
  const [request] = (await db.execute(sql`
    SELECT weight_kg::float8 AS kg, volume_m3::float8 AS m3 FROM calc_requests WHERE id = ${landed!.requestId!}::uuid`)) as unknown as {
    kg: number | null;
    m3: number | null;
  }[];
  return { items, request: request! };
}

beforeEach(() => {
  model.analyze.mockReset();
  model.analyze.mockImplementation(async () => ({ ok: true, facts: { goods: [], weightKg: null, volumeM3: null }, steps: [], usage: BILL, answered: [BILL], knownCodes: [] }));
  queue.spy.mockClear();
});

afterAll(async () => {
  for (const chat of chats) endIntake(chat);
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
    await db.delete(calcRequests).where(inArray(calcRequests.id, ids));
  }
  const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
  if (taskIds.length) {
    await db.delete(events).where(inArray(events.entityId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  if (cards.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, cards));
    await db.delete(leads).where(inArray(leads.id, cards));
  }
  if (staffIds.length) {
    await db.delete(notifications).where(inArray(notifications.userId, staffIds));
    await db.execute(sql`DELETE FROM telegram_calc_intakes WHERE staff_id IN (${sql.join(staffIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, staffIds));
    // An audited fixture is deactivated, never deleted (audit_log FK).
    await db.update(users).set({ active: false }).where(inArray(users.id, staffIds));
  }
  await pgClient.end();
});

describe('a sheet’s packages, landed on the request’s items', () => {
  it('«CTNS» × «CBM/CTN» and «G.W./CTN»: the items hold the products, their notes the factors', async () => {
    const { items, request } = await landedItems(
      'podklyuch',
      ['No.', 'Description', 'QTY(PCS)', 'CTNS', 'G.W./CTN', 'CBM/CTN'],
      [
        [1, 'Ladies jacket', 200, 10, 12, 0.05],
        [2, 'Kids toy plastic', 480, 20, 13, 0.06],
      ],
    );
    // 10 × 12 = 120 kg and 10 × 0.05 = 0.5 m³; 20 × 13 = 260 kg and 20 × 0.06 = 1.2 m³. The pieces are the sheet's.
    expect(items.map((i) => [i.name, i.quantity, i.kg, i.m3])).toEqual([
      ['Ladies jacket', 200, 120, 0.5],
      ['Kids toy plastic', 480, 260, 1.2],
    ]);
    expect(items[0]!.note).toBe(
      '📦 10 karobka · 0.05 m³/karobka · 12 kg/karobka (brutto) — fayldan · hajm hisoblangan: 10 × 0.05 m³ = 0.5 m³ · og‘irlik hisoblangan: 10 × 12 kg = 120 kg · og‘irlik brutto (karobka og‘irligidan)',
    );
    // The request's cube is the rows' Σ: 0.5 + 1.2 = 1.7 m³ — a figure the sheet states in no cell.
    expect(request.m3).toBe(1.7);
  });

  it('a size column and a carton-only count: the cube from the cartons’ size, and ten cartons never ten pieces', async () => {
    const sized = await landedItems('podklyuch', ['Description', 'QTY', 'CTNS', 'Carton size (cm)', 'G.W.'], [['Office chair', 100, 10, '60*40*50', 150]]);
    // 0.6 × 0.4 × 0.5 = 0.12 m³ a carton, × 10 = 1.2 m³.
    expect(sized.items.map((i) => [i.quantity, i.kg, i.m3, i.note])).toEqual([[100, 150, 1.2, '📦 10 karobka · 60×40×50 sm — fayldan · hajm hisoblangan: 10 × 60×40×50 sm = 1.2 m³']]);

    const cartons = await landedItems('rastamojka', ['Tovar nomi', 'Karobka soni', 'Og‘irligi (kg)', 'Kubi'], [['Ayollar kurtkasi', 10, 120, 0.5]]);
    expect(cartons.items.map((i) => [i.quantity, i.unit, i.kg, i.m3, i.note])).toEqual([[null, null, 120, 0.5, '📦 10 karobka — fayldan']]);
  });

  it('pairs a carton land as the law’s measure, never as pieces (JR-1)', async () => {
    const { items } = await landedItems('rastamojka', ['Description', 'CTNS', 'PRS/CTN', 'G.W.'], [['Sport shoes', 10, 12, 80]]);
    // 10 cartons × 12 pairs = 120 pairs: the measure pair, the piece count empty.
    expect(items.map((i) => [i.quantity, i.measureUnit, i.measureQty, i.kg])).toEqual([[null, 'juft', 120, 80]]);
    expect(items[0]!.note).toContain('📦 10 karobka · 12 juft/karobka — fayldan · o‘lchov hisoblangan: 10 × 12 juft = 120 juft');
  });
});

describe('X5 — a column the TOTAL row shows to be ONE carton’s, landed (XLS-1; review JN-12, JR-11)', () => {
  it('unmarked per-carton «G.W.» and «CBM»: the items hold the cartons’ products, the request the TOTAL row’s cube', async () => {
    const { items, request } = await landedItems(
      'podklyuch',
      ['No.', 'Description', 'QTY(PCS)', 'CTNS', 'G.W.(KGS)', 'CBM'],
      [
        [1, 'Ladies jacket', 200, 10, 12, 0.05],
        [2, 'Kids toy plastic', 480, 20, 13, 0.06],
        ['TOTAL', null, 680, 30, 380, 1.7],
      ],
    );
    // 10 × 12 = 120 kg and 10 × 0.05 = 0.5 m³; 20 × 13 = 260 kg and 20 × 0.06 = 1.2 m³ — 380 kg and 1.7 m³,
    // what the TOTAL row states, where the column's own 12 / 13 kg and 0.05 / 0.06 m³ landed before.
    expect(items.map((i) => [i.name, i.quantity, i.kg, i.m3])).toEqual([
      ['Ladies jacket', 200, 120, 0.5],
      ['Kids toy plastic', 480, 260, 1.2],
    ]);
    expect(items[0]!.note).toContain('og‘irlik hisoblangan: 10 × 12 kg = 120 kg');
    expect(items[0]!.note).toContain('hajm hisoblangan: 10 × 0.05 m³ = 0.5 m³');
    expect(request.m3).toBe(1.7);
  });

  it('the rows that HAVE a per-carton-looking figure (JS-33): the figure is on the item’s note, never in its weight', async () => {
    const { items } = await landedItems(
      'rastamojka',
      ['Description', 'QTY', 'CTNS', 'G.W.'],
      [
        ['Kurtka', 200, 20, 15],
        ['Shim', 100, 10, 18],
        ['Sumka', 50, 5, null],
        ['TOTAL', 350, 35, 530],
      ],
    );
    // 15 + 18 = 33 kg is under half of 530 (265), and 20 × 15 + 10 × 18 = 480 within 530 × 1.02 = 540.6.
    expect(items.map((i) => [i.name, i.kg])).toEqual([
      ['Kurtka', null],
      ['Shim', null],
      ['Sumka', null],
    ]);
    expect(items[0]!.note).toContain('vazn «15» — bitta karobkanikimi yoki qatornikimi, aniq emas');
  });
});

describe('X8 — the TOTAL row as the sheet’s total, landed (XLS-6; review JR-3)', () => {
  it('the cube only in the TOTAL row: the request carries the TOTAL row’s 3.8 m³ — and no brutto from the ASKED «G.W.» column', async () => {
    const { items, request } = await landedItems(
      'podklyuch',
      ['No.', 'Description', 'QTY(PCS)', 'CTNS', 'G.W.(KGS)', 'CBM'],
      [
        [1, 'Ladies jacket', 200, 10, 120, null],
        [2, 'Kids toy plastic', 480, 20, 260, null],
        [3, 'LED lamp 50W', 300, 30, 330, null],
        ['TOTAL', null, 980, 60, 710, 3.8],
      ],
    );
    // No line states a cube; 120 + 260 + 330 = 710 kg is the lines' gross and the TOTAL's — but the «G.W.» column
    // beside 10, 20, 30 cartons is asked (JN-12: its TOTAL is its own Σ), so its Σ lands as no brutto (review
    // seams-2 — re-anchored from [710, 3.8]): the request carries the TOTAL row's cube and an asked brutto.
    expect(items.map((i) => [i.name, i.kg, i.m3])).toEqual([
      ['Ladies jacket', 120, null],
      ['Kids toy plastic', 260, null],
      ['LED lamp 50W', 330, null],
    ]);
    expect([request.kg, request.m3]).toEqual([null, 3.8]);
  });
});
