import 'dotenv/config';
import ExcelJS from 'exceljs';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The column reader's rows and figures (docs/FAYL-OQISH.md §5.4, §5.5, §5.9,
 * §5.10) through the SAME handler chain the server runs — the «🤖 AI
 * rastamojka» door, the section press, the customer, the document (served
 * bytes → the real `saveIntakeFile` + `readIntakeFile`) — up to the file's
 * arrival: what the collection holds of the file's goods, and what the
 * seller is told. No model is reached before «Bo‘ldi», so none is faked
 * beyond the door's own «is AI configured».
 *
 * The four shapes the findings drove through this very chain (xlsx1-04,
 * xlsx1-05, xlsx1-06, xlsxN-07, xlsxN-08): each one landed a wrong good, lost
 * a real one, or read a figure a thousand times small — under a card that
 * then said «Ma’lumot to‘liq».
 */
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/ai/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/ai/model')>()),
  aiConfigured: () => true,
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import { db, pgClient } from '@/modules/platform/db/client';
import { roles, telegramLinks, userRoles, users } from '@/modules/platform/db/schema';
import { activeIntake, endIntake, markIntakesHydrated } from '@/modules/platform/telegram/calc-store';
import { resetReadingDrive } from '../fixtures/calc-read-drive';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STAMP = String(Date.now()).slice(-6);
let h: BotHarness;
let sellerId = '';
let chat = 0;
let fileSeq = 0;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99894${STAMP}3`, fullName: `Fayl rows ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  sellerId = u!.id;
  const role = await db.query.roles.findFirst({ where: eq(roles.code, 'sales_manager') });
  await db.insert(userRoles).values({ userId: sellerId, roleId: role!.id });
  chat = Number(`94${STAMP}3`);
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
  if (sellerId) {
    await db.update(telegramLinks).set({ status: 'revoked' }).where(inArray(telegramLinks.userId, [sellerId]));
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

/** Every text the bot sent or edited into the chat after a mark (the file prompt «Qabul qilindi …» is an edit). */
function saidSince(m: ReturnType<BotHarness['mark']>): string[] {
  const since = h.since(m);
  const says = (method: string) => method === 'sendMessage' || method === 'editMessageText';
  return [
    ...since.api.filter((c) => says(c.method) && Number(c.payload.chat_id) === chat).map((c) => String(c.payload.text)),
    ...since.sent.filter((c) => says(c.method) && Number(c.body.chat_id) === chat).map((c) => String(c.body.text)),
  ];
}

function lastMessageIdWith(m: ReturnType<BotHarness['mark']>, data: string): number | null {
  for (const call of [...h.since(m).api].reverse()) {
    if (call.method === 'sendMessage' && JSON.stringify(call.payload.reply_markup ?? '').includes(data)) return call.messageId ?? null;
  }
  return null;
}

/** The AI door → «🛃 Faqat rastamojka» → GS777 → the file; what the collection holds and what was said of the file. */
async function forward(body: Buffer, fileName: string, mime: string) {
  let m = h.mark();
  await h.handle(tg.text(chat, '🤖 AI rastamojka'));
  await h.settle();
  const section = lastMessageIdWith(m, 'c:ai');
  expect(section, 'the section question').not.toBeNull();
  await h.handle(tg.callback(chat, section!, 'c:ai'));
  await h.settle();
  await h.handle(tg.text(chat, 'GS777'));
  await h.settle();
  const fileId = `fo-rows-${STAMP}-${(fileSeq += 1)}`;
  h.serveFile(fileId, body);
  m = h.mark();
  await h.handle(tg.document(chat, fileId, { fileName, mime }));
  await h.settle();
  const state = activeIntake(BigInt(chat))!;
  return { state, said: saidSince(m).join('\n'), file: (state.goodsFiles ?? [])[0] };
}

const H = ['Description', 'Qty', 'G.W. (kg)', 'CBM'];
const names = (state: { invoiceGoods?: { name: string }[] | null }) => (state.invoiceGoods ?? []).map((g) => g.name);

describe('a file’s goods through the AI door (FAYL-OQISH §5.4, §5.5)', () => {
  it('a TOTAL Tools drill beside a jacket under a closing TOTAL: two goods, the file’s brutto 270 and cube 1.8 — the drill is not lost', async () => {
    const body = await xlsxOf([H, ['TOTAL cordless drill TDLI20012', 50, 120, 0.6], ['Ladies jacket', 300, 150, 1.2], ['TOTAL', 350, 270, 1.8]]);
    const { state, said, file } = await forward(body, 'pl.xlsx', XLSX);
    expect(names(state)).toEqual(['TOTAL cordless drill TDLI20012', 'Ladies jacket']);
    expect(file).toMatchObject({ grossKg: 270, volumeM3: 1.8, rows: 2 });
    expect(said).toContain('2 ta tovar o‘qildi');
  });

  it('«Umumiy» closing the list is a total row: one good, never a second «Umumiy» doubling the brutto', async () => {
    const body = await xlsxOf([H, ['Ayollar kurtkasi', 300, 150, 1.2], ['Umumiy', 300, 150, 1.2]]);
    const { state, file } = await forward(body, 'umumiy.xlsx', XLSX);
    expect(names(state)).toEqual(['Ayollar kurtkasi']);
    expect(file).toMatchObject({ grossKg: 150, volumeM3: 1.2, rows: 1 });
  });

  it('«Made in China» under the one good is a footer: one good, and the file’s brutto and cube survive', async () => {
    const body = await xlsxOf([['No.', 'Description', 'Qty', 'G.W. (kg)', 'CBM'], [1, 'Ladies jacket', 300, 150, 1.2], [null, 'Made in China', null, null, null]]);
    const { state, said, file } = await forward(body, 'footer.xlsx', XLSX);
    expect(names(state)).toEqual(['Ladies jacket']);
    expect(file).toMatchObject({ grossKg: 150, volumeM3: 1.2, rows: 1 });
    expect(said).toContain('1 ta tovar o‘qildi');
    // …and the footer is SAID, never dropped in silence (§5.5).
    expect(said).toContain('📄 «footer.xlsx» — ostidagi 1 ta qator tovar deb olinmadi: «Made in China».');
  });

  it('a names list with figures on its first rows only: the figure-less tail is said on the receipt, kept on the card note, and read by the model (review reader-b-break-dropped-has-no-reader)', async () => {
    const body = await xlsxOf([
      ['Наименование', 'Кол-во', 'Вес, кг'],
      ['Куртка', 100, 50],
      ['Брюки', 200, 80],
      ['Шапка', null, null],
      ['Шарф', null, null],
      ['Перчатки', null, null],
    ]);
    const { state, said } = await forward(body, 'names.xlsx', XLSX);
    expect(names(state)).toEqual(['Куртка', 'Брюки']);
    const line = '📄 «names.xlsx» — ostidagi 3 ta qator tovar deb olinmadi: «Шапка», «Шарф», «Перчатки».';
    // The seller reads it now…
    expect(said).toContain(line);
    // …the card's note carries it for the VED (a receipt-time note)…
    expect(state.fileNotes).toContain(line);
    // …and the model reads the rows beside the list on the AI door.
    const context = state.invoiceTexts.map((t) => t.text).join('\n');
    for (const name of ['Шапка', 'Шарф', 'Перчатки']) expect(context).toContain(name);
  });

  it('a closing label-only «TOTAL» is no news: nothing said of it, and nothing handed to the model for it', async () => {
    const body = await xlsxOf([H, ['Ladies jacket', 300, 150, 1.2], ['TOTAL', 300, 150, 1.2]]);
    const { state, said } = await forward(body, 'total.xlsx', XLSX);
    expect(names(state)).toEqual(['Ladies jacket']);
    expect(said).not.toContain('tovar deb olinmadi');
    expect(state.invoiceTexts).toEqual([]);
  });
});

describe('a file’s figures through the AI door (FAYL-OQISH §5.9, §5.10)', () => {
  it('an ERP «Export to Excel» (an HTML table named .xls): «1,500» pieces and «1,050» kg are 1500 and 1050 — never 1.5 and 1.05', async () => {
    const html = [
      '<html><body><table><tr><td>No.</td><td>Description</td><td>Qty</td><td>G.W.(KG)</td><td>CBM</td><td>Amount (USD)</td></tr>',
      '<tr><td>1</td><td>USB cable 1m</td><td>1,500</td><td>1,050</td><td>0.15</td><td>1,950</td></tr>',
      '<tr><td>2</td><td>Ceramic mug</td><td>480</td><td>168</td><td>0.9</td><td>432</td></tr></table></body></html>',
    ].join('\n');
    const { state, file } = await forward(Buffer.from(html), 'export.xls', 'application/vnd.ms-excel');
    expect(state.invoiceGoods?.[0]).toMatchObject({ name: 'USB cable 1m', quantity: 1500, weightKg: 1050 });
    expect(file).toMatchObject({ grossKg: 1218 });
  });

  it('«QTY/CTN | CTN QTY | TOTAL QTY»: 300 jackets, never 15', async () => {
    const body = await xlsxOf([['DESCRIPTION', 'QTY/CTN', 'CTN QTY', 'TOTAL QTY', 'N.W.(KG)'], ['Ladies jacket', 20, 15, 300, 142.5]]);
    const { state } = await forward(body, 'ctn.xlsx', XLSX);
    expect(state.invoiceGoods?.[0]).toMatchObject({ name: 'Ladies jacket', quantity: 300, weightKg: 142.5 });
  });
});
