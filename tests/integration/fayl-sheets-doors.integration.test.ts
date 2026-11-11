import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every mapped sheet of a workbook is judged — at every door (docs/FAYL-OQISH.md
 * §4.1, §4.7, sheets-06): the judgement lives in `readIntakeFile`, so the
 * fresh collection, the burst take (`cf:`) and the ➕ media reply share one
 * rule. Through the SAME handler chain the server runs (bot-harness): the
 * real download, the real store, the real reader and, on the fresh door, the
 * reading job itself. Only the model is a stand-in — `analyzeIntake` as a
 * whole, so what it is asked and how it is called are the model package's,
 * and what is under test is what the bot did with the sheets.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
vi.mock('@/modules/wms/calc/prefill-queue', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/prefill-queue')>()),
  ticketStanding: vi.fn(async () => 'none' as const),
  queueCalcPrefill: vi.fn(async () => true),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcAmendments,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  dealStages,
  notifications,
  roles,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { activeIntake, endIntake, markIntakesHydrated } from '@/modules/platform/telegram/calc-store';
import { __resetAddOffers } from '@/modules/platform/telegram/calc-amend';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { runIntakeRead } from '@/modules/platform/telegram/calc-read';
import { nowSec } from '@/modules/platform/telegram/waits';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { readingsEnqueued, resetReadingDrive } from '../fixtures/calc-read-drive';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';
import * as B from '../fixtures/fayl-books';

const STAMP = String(Date.now()).slice(-6);
let h: BotHarness;
let sellerId = '';
let clientId = '';
let stageId = '';
let baseChat = 0;
let chatSeq = 0;
const usedChats: number[] = [];
const madeDeals: string[] = [];
const madeRequests: string[] = [];
let press = 80_000;
let fileSeq = 0;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${STAMP}4`, fullName: `Fayl varaq ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  sellerId = u!.id;
  const role = await db.query.roles.findFirst({ where: eq(roles.code, 'sales_manager') });
  await db.insert(userRoles).values({ userId: sellerId, roleId: role!.id });
  const [client] = await db.insert(clients).values({ clientCode: `FV${STAMP}`, name: `Fayl varaq mijoz ${STAMP}` }).returning();
  clientId = client!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  baseChat = Number(`96${STAMP}`);
  h = botHarness();
  markIntakesHydrated();
});

beforeEach(() => {
  model.analyze.mockReset();
  resetReadingDrive();
  __resetAddOffers();
  __resetPresses();
});

afterEach(async () => {
  await h.settle();
});

afterAll(async () => {
  for (const c of usedChats) endIntake(BigInt(c));
  h.restore();
  await db.delete(notifications).where(eq(notifications.userId, sellerId));
  if (madeRequests.length) {
    await db.delete(calcAmendments).where(inArray(calcAmendments.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.execute(sql`DELETE FROM crm_activities WHERE calc_request_id IN (${sql.join(madeRequests.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  }
  if (madeDeals.length) await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeDeals));
  await db.update(telegramLinks).set({ status: 'revoked' }).where(eq(telegramLinks.userId, sellerId));
  // DEACTIVATED, not deleted: audit_log points at them (round 107's rule).
  await db.update(users).set({ active: false }).where(eq(users.id, sellerId));
  await pgClient.end();
});

/** A fresh chat linked to the seller (one link at a time: the previous one moved). */
async function freshChat(): Promise<number> {
  chatSeq += 1;
  const chat = baseChat * 10 + chatSeq;
  const had = await db.query.telegramLinks.findFirst({ where: eq(telegramLinks.userId, sellerId) });
  if (had) await db.update(telegramLinks).set({ telegramChatId: BigInt(chat), status: 'linked' }).where(eq(telegramLinks.userId, sellerId));
  else await db.insert(telegramLinks).values({ userId: sellerId, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  usedChats.push(chat);
  return chat;
}

/** The message (sent or edited) that last carried a button with this callback data. */
function buttonMessage(chat: number, data: string): number | null {
  const has = (markup: unknown) =>
    ((markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat().some((b) => b.callback_data === data);
  for (const c of [...h.api].reverse()) {
    if (Number(c.payload.chat_id) !== chat) continue;
    if (c.method === 'sendMessage' && has(c.payload.reply_markup)) return c.messageId ?? null;
    if (c.method === 'editMessageText' && has(c.payload.reply_markup)) return Number(c.payload.message_id);
  }
  return null;
}

/** Every text this chat was sent or had edited since `m`, both senders. */
function saidSince(chat: number, m: ReturnType<BotHarness['mark']>): string[] {
  const since = h.since(m);
  const out: string[] = [];
  for (const c of since.api) {
    if (Number(c.payload.chat_id) === chat && (c.method === 'sendMessage' || c.method === 'editMessageText')) out.push(String(c.payload.text));
  }
  for (const c of since.sent) {
    if (Number(c.body.chat_id) === chat && (c.method === 'sendMessage' || c.method === 'editMessageText')) out.push(String(c.body.text));
  }
  return out;
}

/** A workbook served for download, and its id. */
function served(body: Buffer): string {
  fileSeq += 1;
  const fileId = `fv-${STAMP}-${fileSeq}`;
  h.serveFile(fileId, body);
  return fileId;
}

/** A landed request on a deal, and the AI answer under it that carries ➕ (its message id). */
async function landed(chat: number): Promise<{ requestId: string; answerId: number }> {
  const [deal] = await db
    .insert(deals)
    .values({ code: `FV-${STAMP}-${madeDeals.length}`, clientId, stageId, title: 'Fayl varaq', createdBy: sellerId })
    .returning();
  madeDeals.push(deal!.id);
  const r = await openCalcRequest(
    {
      intakeDoor: null,
      entityType: 'deal',
      entityId: deal!.id,
      section: 'rastamojka',
      fromCity: null,
      toCity: null,
      weightKg: null,
      volumeM3: null,
      items: [{ name: 'Sumka', quantity: 10 }, { name: 'Krossovka', quantity: 20 }],
      source: 'card',
    },
    { actorId: sellerId },
  );
  madeRequests.push(r.id);
  const answerId = (press += 1);
  await db.insert(notifications).values({
    userId: sellerId,
    channel: 'telegram',
    type: 'CalcPrefilled',
    status: 'sent',
    sentAt: new Date(),
    payload: { text: 'x', add: true, requestId: r.id, tg: { chatId: String(chat), messageId: answerId } },
  });
  return { requestId: r.id, answerId };
}

/** The fresh AI door up to its files: «🤖 AI rastamojka» → «Faqat rastamojka» → GS777. */
async function aiDoor(chat: number): Promise<void> {
  await h.handle(tg.text(chat, '🤖 AI rastamojka'));
  await h.settle();
  await h.handle(tg.callback(chat, (press += 1), 'c:ai'));
  await h.settle();
  await h.handle(tg.text(chat, 'GS777'));
  await h.settle();
}

/** «Bo‘ldi», and the reading job it queued — the model a stand-in that answers `goods`. */
async function readNow(chat: number, goods: unknown[] = []): Promise<string[]> {
  model.analyze.mockResolvedValue({
    ok: true,
    facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods },
    steps: [],
    usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
  });
  const m = h.mark();
  await h.handle(tg.callback(chat, buttonMessage(chat, 'c:done') ?? (press += 1), 'c:done'));
  await h.settle();
  const job = readingsEnqueued(BigInt(chat)).at(-1);
  expect(job, 'the reading was queued').toBeDefined();
  await runIntakeRead(job!.data, 0);
  await h.settle();
  return saidSince(chat, m);
}

const LATIN_A: B.Row[] = [
  { name: 'Ladies jacket', pcs: 300, nw: 150, gw: 165, cbm: 1.8, price: 6.5 },
  { name: 'Mens trousers', pcs: 200, nw: 80, gw: 88, cbm: 0.72, price: 4.2 },
];
const LATIN_B: B.Row[] = [
  { name: 'Power bank 10000mAh', pcs: 500, nw: 110, gw: 117.5, cbm: 0.35, price: 4.6 },
  { name: 'USB cable 1m', pcs: 1500, nw: 48, gw: 51, cbm: 0.15, price: 0.35 },
];
const names = (chat: number) => (activeIntake(BigInt(chat))?.invoiceGoods ?? []).map((g) => g.name);

describe('the fresh AI door (§4.7)', () => {
  it('K10: «Zavod B» folded in, said on the prompt, and the table carries all five', async () => {
    const chat = await freshChat();
    await aiDoor(chat);
    const fileId = served(await B.twoFactoryBook([B.A_KURTKA, B.A_SHIM, B.A_SUMKA], [B.B_KROSS, B.B_KEPKA]));
    const m = h.mark();
    await h.handle(tg.document(chat, fileId, { fileName: 'GS777_invoice.xlsx', mime: B.XLSX }));
    await h.settle();
    expect(names(chat)).toEqual(['Куртка женская', 'Брюки мужские', 'Сумка женская PU', 'Кроссовки мужские', 'Кепка бейсболка']);
    expect(saidSince(chat, m).join('\n')).toContain('📄 «GS777_invoice.xlsx», «Zavod B» varag‘idan 2 ta yangi tovar qo‘shildi.');
    // The model DOES list factory B's goods (J2): carried by the folded rows, never a second time.
    const said = await readNow(chat, [
      { name: 'Кроссовки мужские', quantity: 120, weightKg: 96 },
      { name: 'Кепка бейсболка', quantity: 800, weightKg: 56 },
    ]);
    const after = activeIntake(BigInt(chat))!;
    expect(after.facts.goods?.map((g) => g.name)).toEqual(names(chat));
    expect(after.notes.join(' ')).not.toContain('Excel’da yo‘q');
    // …nor named as a line the model found beside the Excel (§4.6's words): the fold carries it.
    expect(after.notes.join(' ')).not.toContain('AI fayldan yana');
    expect(said.join('\n')).toContain('Кепка бейсболка');
  }, 60_000);

  it('R1: 12 rows, and the brutto and cube are the packing list’s — ✅ with no model figure', async () => {
    const chat = await freshChat();
    await aiDoor(chat);
    const fileId = served(
      await B.bookOf((wb) => {
        B.englishInvoice(wb.addWorksheet('INVOICE'));
        B.chinesePacking(wb.addWorksheet('PACKING'), B.GOODS, { net: true });
      }),
    );
    await h.handle(tg.document(chat, fileId, { fileName: 'CI-PL.xlsx', mime: B.XLSX }));
    await h.settle();
    await readNow(chat);
    const after = activeIntake(BigInt(chat))!;
    expect(after.facts.goods).toHaveLength(12);
    expect([after.facts.weightKg, after.facts.volumeM3]).toEqual([1592, 13.58]);
    // …and every row's netto, by its place on the Chinese list.
    expect(after.facts.goods?.map((g) => g.weightKg)).toEqual(B.GOODS.map((g) => B.r2(g.nw * g.ctns)));
  }, 60_000);
});

describe('a model line read off a header-less sheet is named, never dropped (§4.6, the wire)', () => {
  it('a one-line invoice beside a header-less list: the model’s goods are NAMED on the table, the invoice’s row stands', async () => {
    const chat = await freshChat();
    await aiDoor(chat);
    const fileId = served(
      await B.bookOf((wb) => {
        B.plainSheet(wb.addWorksheet('Invoice'), ['Description', 'Qty', 'Amount'], [['Garments', 500, 2500]]);
        wb.addWorksheet('List').addRows([['Ayollar kurtkasi', '300 dona', '150 kg'], ['Erkaklar shimi', '200 dona', '100 kg']]);
      }),
    );
    await h.handle(tg.document(chat, fileId, { fileName: 'D4.xlsx', mime: B.XLSX }));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.invoiceTexts.map((t) => t.unmapped)).toEqual([true]);
    const said = await readNow(chat, [
      { name: 'Ayollar kurtkasi', quantity: 300, weightKg: 150 },
      { name: 'Erkaklar shimi', quantity: 200, weightKg: 100 },
    ]);
    const after = activeIntake(BigInt(chat))!;
    expect(after.facts.goods?.map((g) => g.name)).toEqual(['Garments']);
    expect(after.notes).toContain('AI fayldan yana «Ayollar kurtkasi», «Erkaklar shimi» ni topdi — ro‘yxatga qo‘shilmadi, VED ko‘radi');
    expect(said.join('\n')).toContain('AI fayldan yana «Ayollar kurtkasi»');
  }, 60_000);
});

describe('the burst take (`cf:`, takeParts) shares the rule (§4.1)', () => {
  it('a workbook forwarded with no collection running, taken by «➕ … so‘roviga qo‘shish»: «Zavod B» folded in', async () => {
    const chat = await freshChat();
    const { requestId } = await landed(chat);
    const fileId = served(await B.twoFactoryBook(LATIN_A, LATIN_B));
    const original = {
      message_id: (press += 1),
      date: nowSec() - 30,
      chat: { id: chat, type: 'private' },
      from: { id: chat, is_bot: false, first_name: 'T' },
      document: { file_id: fileId, file_unique_id: `u${fileId}`, file_name: 'factories.xlsx', mime_type: B.XLSX, file_size: 100 },
    };
    await h.handle(tg.callback(chat, (press += 1), `cf:${requestId}`, { message: { reply_to_message: original } }));
    await h.settle();
    const s = activeIntake(BigInt(chat))!;
    expect(s.amend?.requestId).toBe(requestId);
    expect(names(chat)).toEqual([...LATIN_A, ...LATIN_B].map((g) => g.name));
    expect(s.fileNotes).toContain('📄 «factories.xlsx», «Zavod B» varag‘idan 2 ta yangi tovar qo‘shildi.');
    // One FILE: the door counts it once, whatever its sheets.
    expect(s.fileCount).toBe(1);
  }, 60_000);
});

describe('the ➕ media reply (openAmendFromMedia) shares the rule (§4.1)', () => {
  it('a workbook sent as a reply to the answer’s ➕: «Zavod B» folded in', async () => {
    const chat = await freshChat();
    const { requestId, answerId } = await landed(chat);
    const fileId = served(await B.twoFactoryBook(LATIN_A, LATIN_B));
    await h.handle(tg.document(chat, fileId, { replyTo: answerId, fileName: 'factories.xlsx', mime: B.XLSX }));
    await h.settle();
    const s = activeIntake(BigInt(chat))!;
    expect(s.amend?.requestId).toBe(requestId);
    expect(names(chat)).toEqual([...LATIN_A, ...LATIN_B].map((g) => g.name));
    expect(s.fileNotes).toContain('📄 «factories.xlsx», «Zavod B» varag‘idan 2 ta yangi tovar qo‘shildi.');
    expect(s.fileCount).toBe(1);
  }, 60_000);

  it('…and the stored rows are held against too: a «Zavod B» line that may be a stored row is not proven other', async () => {
    // The request stores «Sumka» and «Krossovka»; «Krossovka sport» names nothing the stored
    // «Krossovka» lacks the other way round — it may be that row, so nothing is folded, and
    // today's reading stands (FILES-2's priced-twice fence, held at the sheet as at the file).
    const chat = await freshChat();
    const { answerId } = await landed(chat);
    const b: B.Row[] = [{ ...LATIN_B[0]! }, { name: 'Krossovka sport', pcs: 20, nw: 16, gw: 17, cbm: 0.2, price: 8 }];
    const fileId = served(await B.twoFactoryBook(LATIN_A, b));
    await h.handle(tg.document(chat, fileId, { replyTo: answerId, fileName: 'factories.xlsx', mime: B.XLSX }));
    await h.settle();
    const s = activeIntake(BigInt(chat))!;
    expect(names(chat)).toEqual(LATIN_A.map((g) => g.name));
    expect(s.fileNotes).toContain(
      '📄 «factories.xlsx», «Zavod B» varag‘i — o‘sha tovarlar deb olindi (faqat jami uchun o‘qildi); boshqa tovar bo‘lsa, alohida fayl qilib yuboring.',
    );
  }, 60_000);
});
