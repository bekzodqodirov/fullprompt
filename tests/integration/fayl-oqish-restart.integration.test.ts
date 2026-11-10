import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * docs/FAYL-OQISH.md §2.4 (dialog-03, door-restart-hold), through the REAL
 * handler chain: «Sizda tugallanmagan yig‘ish bor — boshqatdan boshlaymizmi?»
 * stands, and the file, forward and text doors refuse material in words and
 * file NOTHING — the old collection «🔄 Ha» would wipe never takes it, and
 * «▶️ Yo‘q» never reads today's file under yesterday's customer. The question
 * clears on its answer (its buttons stripped), and after 30 minutes by
 * itself.
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequestItems,
  calcRequests,
  crmActivities,
  leads,
  leadStages,
  notifications,
  roles,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import {
  __forgetIntakeMemory,
  activeIntake,
  endIntake,
  HOLD_MS,
  holdingIntake,
  markIntakesHydrated,
  setDurableIntakes,
  updateIntake,
} from '@/modules/platform/telegram/calc-store';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { RESTART_HOLD, RESTART_HOLD_MS } from '@/modules/platform/telegram/calc-dialog';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-6);
let h: BotHarness;
let staffId = '';
let chat = 0;
const QUESTION = 'Sizda tugallanmagan yig‘ish bor. Boshqatdan boshlaymizmi? Yuborilgan hamma narsa o‘chadi.';
const madeRequests: string[] = [];
const madeLeads: string[] = [];
let answerSeq = 60_000;

/** The id of the newest message the bot sent this chat with these words. */
function sentId(text: string, from: ReturnType<BotHarness['mark']>): number {
  const calls = h.since(from).api.filter((c) => c.method === 'sendMessage' && String(c.payload.text) === text);
  expect(calls.length, `«${text}» was sent`).toBeGreaterThan(0);
  return calls.at(-1)!.messageId!;
}

/** An AI collection with material in it, and the restart question standing over it. */
async function askedOver(): Promise<{ question: number; noteId: string }> {
  await h.handle(tg.callback(chat, 1, 'c:ai'));
  await h.settle();
  await h.handle(tg.text(chat, 'GS777'));
  await h.settle();
  await h.handle(tg.text(chat, 'Kurtka 300 dona'));
  await h.settle();
  const before = activeIntake(BigInt(chat))!;
  expect(before.material).toEqual(['Kurtka 300 dona']);
  const m = h.mark();
  await h.handle(tg.callback(chat, 2, 'c:ai'));
  await h.settle();
  const question = sentId(QUESTION, m);
  const live = activeIntake(BigInt(chat))!;
  expect(live.noteId).toBe(before.noteId);
  expect(live.restartAsked?.messageId).toBe(question);
  return { question, noteId: live.noteId };
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+998937${STAMP}`, fullName: `Qayta savol ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  staffId = u!.id;
  const role = await db.query.roles.findFirst({ where: eq(roles.code, 'sales_manager') });
  await db.insert(userRoles).values({ userId: staffId, roleId: role!.id });
  chat = Number(`937${STAMP}`);
  await db.insert(telegramLinks).values({ userId: staffId, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  setDurableIntakes(false);
  h = botHarness();
});

beforeEach(() => {
  endIntake(BigInt(chat));
  __forgetIntakeMemory();
  __resetLifecycle();
  __resetPresses();
  __resetBacklog();
  markBoot(new Date(Date.now() - 60_000));
  markIntakesHydrated();
});

afterAll(async () => {
  endIntake(BigInt(chat));
  h.restore();
  await db.delete(notifications).where(eq(notifications.userId, staffId));
  if (madeRequests.length) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  }
  if (madeLeads.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  await db.update(telegramLinks).set({ status: 'revoked' }).where(inArray(telegramLinks.userId, [staffId]));
  // An audited fixture is deactivated, never deleted (audit_log FK).
  await db.update(users).set({ active: false }).where(eq(users.id, staffId));
  await pgClient.end();
});

describe('the restart question holds the material (§2.4)', () => {
  it('a file, a forward and a text under it are refused in words, kept last, and filed nowhere; «▶️ Yo‘q» lets them in again', async () => {
    const { question, noteId } = await askedOver();
    const m = h.mark();
    await h.handle(tg.document(chat, 'restart-file-1', { fileName: 'invoice.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    await h.settle();
    await h.handle(tg.forward(chat, 'Sumka 20 dona'));
    await h.settle();
    await h.handle(tg.text(chat, 'Shim 10 dona'));
    await h.settle();
    const live = activeIntake(BigInt(chat))!;
    expect(live.noteId).toBe(noteId);
    expect(live.fileCount).toBe(0);
    expect(live.material).toEqual(['Kurtka 300 dona']);
    // Nothing was fetched: the file door refused before it read a byte.
    expect(h.since(m).sent.filter((s) => s.method === 'getFile')).toEqual([]);
    expect(h.textsTo(chat, m)).toContain(RESTART_HOLD);
    expect(h.textsTo(chat, m).every((t) => t === RESTART_HOLD)).toBe(true);

    const answered = h.mark();
    await h.handle(tg.callback(chat, question, 'c:resume'));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.restartAsked ?? null).toBeNull();
    // The question's buttons are stripped once it is answered.
    expect(
      h.since(answered).sent.some((s) => s.method === 'editMessageReplyMarkup' && Number(s.body.message_id) === question),
    ).toBe(true);
    await h.handle(tg.text(chat, 'Shim 10 dona'));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.material).toEqual(['Kurtka 300 dona', 'Shim 10 dona']);
  });

  it('«🔄 Ha» opens the new collection with nothing held, and the old question goes', async () => {
    const { question, noteId } = await askedOver();
    await h.handle(tg.text(chat, 'Shim 10 dona'));
    await h.settle();
    const m = h.mark();
    await h.handle(tg.callback(chat, question, 'c:go_ai'));
    await h.settle();
    const fresh = activeIntake(BigInt(chat))!;
    expect(fresh.noteId).not.toBe(noteId);
    expect(fresh.material).toEqual([]);
    expect(fresh.restartAsked ?? null).toBeNull();
    expect(h.since(m).sent.some((s) => s.method === 'editMessageReplyMarkup' && Number(s.body.message_id) === question)).toBe(true);
  });

  it('a question forgotten for 30 minutes jams nothing: the next text is taken, the question let go', async () => {
    const { noteId } = await askedOver();
    const live = activeIntake(BigInt(chat))!;
    updateIntake(BigInt(chat), { restartAsked: { ...live.restartAsked!, at: Date.now() - RESTART_HOLD_MS - 1_000 } }, { quiet: true });
    const m = h.mark();
    await h.handle(tg.text(chat, 'Shim 10 dona'));
    await h.settle();
    const after = activeIntake(BigInt(chat))!;
    expect(after.noteId).toBe(noteId);
    expect(after.material).toEqual(['Kurtka 300 dona', 'Shim 10 dona']);
    expect(after.restartAsked ?? null).toBeNull();
    expect(h.textsTo(chat, m)).not.toContain(RESTART_HOLD);
  });
});

/** The collection goes quiet past `HOLD_MS`: it no longer HOLDS the chat — the commonest case behind the question. */
function park(): void {
  updateIntake(BigInt(chat), { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
  expect(holdingIntake(BigInt(chat))).toBeNull();
}

/** The sends after `m` that carry a «▶️ Davom etamiz» which TAKES (the burst's pause line). */
function takingLines(m: ReturnType<BotHarness['mark']>) {
  return h
    .since(m)
    .api.filter(
      (c) =>
        c.method === 'sendMessage' &&
        JSON.stringify((c.payload as { reply_markup?: unknown }).reply_markup ?? null).includes('c:resume_take'),
    );
}

describe('the question over a PARKED collection holds the material too (§2.4, door-break-1)', () => {
  it('a file and a forward beside a parked collection under the question: RESTART_HOLD, no pause line, nothing filed', async () => {
    await h.handle(tg.callback(chat, 1, 'c:ai'));
    await h.settle();
    await h.handle(tg.text(chat, 'GS777'));
    await h.handle(tg.text(chat, 'Kurtka 300 dona'));
    await h.settle();
    park();
    const q = h.mark();
    await h.handle(tg.callback(chat, 2, 'c:ai'));
    await h.settle();
    const question = sentId(QUESTION, q);
    // The question's patch is quiet: the collection goes on parking under it.
    expect(holdingIntake(BigInt(chat))).toBeNull();
    expect(activeIntake(BigInt(chat))!.restartAsked?.messageId).toBe(question);

    const m = h.mark();
    await h.handle(tg.document(chat, `parked-pdf-${STAMP}`, { fileName: 'invoice.pdf', mime: 'application/pdf' }));
    await h.settle();
    await h.handle(tg.forward(chat, 'Sumka 20 dona'));
    await h.settle();
    const live = activeIntake(BigInt(chat))!;
    expect(live.fileCount).toBe(0);
    expect(live.material).toEqual(['Kurtka 300 dona']);
    expect(h.since(m).sent.filter((s) => s.method === 'getFile')).toEqual([]);
    expect(takingLines(m)).toEqual([]);
    expect(h.textsTo(chat, m)).toContain(RESTART_HOLD);
    expect(h.textsTo(chat, m).every((t) => t === RESTART_HOLD)).toBe(true);
  });

  it('«▶️ Davom etamiz» on a pause line drawn BEFORE the question answers it «continue»: taken, the question cleared and stripped, the next text taken', async () => {
    await h.handle(tg.callback(chat, 1, 'c:ai'));
    await h.settle();
    await h.handle(tg.text(chat, 'GS777'));
    await h.handle(tg.text(chat, 'Kurtka 300 dona'));
    await h.settle();
    park();
    h.serveFile(`parked-early-${STAMP}`, Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'));
    const b = h.mark();
    await h.handle(tg.document(chat, `parked-early-${STAMP}`, { fileName: 'invoice.pdf', mime: 'application/pdf' }));
    await h.settle();
    const [line] = takingLines(b);
    expect(line, 'the burst drew its pause line').toBeTruthy();
    const q = h.mark();
    await h.handle(tg.callback(chat, 2, 'c:ai'));
    await h.settle();
    const question = sentId(QUESTION, q);

    const m = h.mark();
    await h.handle(
      tg.callback(chat, line!.messageId!, 'c:resume_take', {
        text: String(line!.payload.text),
        message: { reply_to_message: (line!.payload as { reply_parameters?: unknown }).reply_parameters ?? undefined },
      }),
    );
    await h.settle();
    const live = activeIntake(BigInt(chat))!;
    expect(live.fileCount).toBe(1);
    expect(live.restartAsked ?? null).toBeNull();
    expect(h.since(m).sent.some((s) => s.method === 'editMessageReplyMarkup' && Number(s.body.message_id) === question)).toBe(true);
    const t = h.mark();
    await h.handle(tg.text(chat, 'Shim 10 dona'));
    await h.settle();
    expect(h.textsTo(chat, t)).not.toContain(RESTART_HOLD);
    expect(activeIntake(BigInt(chat))!.material).toContain('Shim 10 dona');
  });
});

describe('«Bo‘ldi» over files all refused at arrival, through the REAL file door (§2.3, door-break-2)', () => {
  it('a lone DOCX — counted by the door — is named with its reason, and no reading starts', async () => {
    await h.handle(tg.callback(chat, 1, 'c:ai'));
    await h.settle();
    await h.handle(tg.text(chat, 'GS777'));
    await h.settle();
    h.serveFile(`refused-docx-${STAMP}`, Buffer.from('PK\u0003\u0004 not really a docx'));
    await h.handle(
      tg.document(chat, `refused-docx-${STAMP}`, {
        fileName: 'invoice.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );
    await h.settle();
    const after = activeIntake(BigInt(chat))!;
    // The door counts the file it refused: the old `fileCount === 0` branch never saw this.
    expect(after.fileCount).toBe(1);
    expect(after.material).toEqual([]);
    // What P-model writes at that refusal (docs/FAYL-OQISH.md §10), as it will write it.
    updateIntake(BigInt(chat), { refusedFiles: [{ name: 'invoice.docx', why: 'Word fayl o‘qilmaydi.' }] }, { quiet: true });
    const m = h.mark();
    await h.handle(tg.callback(chat, after.promptMessageId ?? 3, 'c:done'));
    await h.settle();
    expect(h.textsTo(chat, m)).toContain('Yuborilgan fayllarning birortasi ham o‘qiladigan emas: invoice.docx — Word fayl o‘qilmaydi.');
    expect(h.textsTo(chat, m).some((t) => t.startsWith('⏳ AI o‘qiyapti'))).toBe(false);
    expect(activeIntake(BigInt(chat))!.analysing).toBeNull();
  });
});

/** An «🤖» request of this seller, returned by the VED, with its ➕-bearing answer in the chat. */
async function returnedAi(items: { name: string; quantity: number }[]): Promise<{ requestId: string; answerId: number }> {
  const stage = (await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') }))!;
  const [lead] = await db
    .insert(leads)
    .values({ name: `Qaytgan ${STAMP}-${madeLeads.length}`, stageId: stage.id, ownerId: staffId, createdBy: staffId })
    .returning();
  madeLeads.push(lead!.id);
  const r = await openCalcRequest(
    { intakeDoor: 'ai', entityType: 'lead', entityId: lead!.id, section: 'rastamojka', weightKg: 300, volumeM3: 2, items, source: 'bot' },
    { actorId: staffId },
  );
  madeRequests.push(r.id);
  await db
    .update(calcRequests)
    .set({ completedAt: new Date(), completedVia: 'returned', returnReason: 'fayl o‘qilmagan' })
    .where(eq(calcRequests.id, r.id));
  const answerId = (answerSeq += 1);
  await db.insert(notifications).values({
    userId: staffId,
    channel: 'telegram',
    type: 'CalcPrefilled',
    status: 'sent',
    sentAt: new Date(),
    payload: { text: 'x', add: true, requestId: r.id, tg: { chatId: String(chat), messageId: answerId } },
  });
  return { requestId: r.id, answerId };
}

describe('the returned door’s opening line names the press its table will draw (§1.2, critic-door-predicate)', () => {
  it('an «🤖» request that came back with no goods: «to‘ldiring yoki «👤 VED hisoblasin»», never «✅ Tasdiqlash»', async () => {
    const { requestId, answerId } = await returnedAi([]);
    const m = h.mark();
    await h.handle(tg.callback(chat, answerId, `ca:${requestId}`));
    await h.settle();
    const opening = h.textsTo(chat, m).find((t) => t.startsWith('📨 VED bu so‘rovni qaytargan'));
    expect(opening).toBe('📨 VED bu so‘rovni qaytargan: «fayl o‘qilmagan». Yetishmaganini qo‘shing — to‘ldiring yoki «👤 VED hisoblasin».');
    expect(activeIntake(BigInt(chat))!.seededFrom).toBe(requestId);
  });

  it('one that came back with its goods keeps today’s line', async () => {
    const { requestId, answerId } = await returnedAi([{ name: 'Kurtka', quantity: 300 }]);
    const m = h.mark();
    await h.handle(tg.callback(chat, answerId, `ca:${requestId}`));
    await h.settle();
    const opening = h.textsTo(chat, m).find((t) => t.startsWith('📨 VED bu so‘rovni qaytargan'));
    expect(opening).toBe('📨 VED bu so‘rovni qaytargan: «fayl o‘qilmagan». Yetishmaganini qo‘shing — «✅ Tasdiqlash» yangi so‘rov bo‘lib VED ga boradi.');
  });
});
