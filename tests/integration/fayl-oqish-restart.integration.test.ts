import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
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
import { roles, telegramLinks, userRoles, users } from '@/modules/platform/db/schema';
import { __forgetIntakeMemory, activeIntake, endIntake, markIntakesHydrated, setDurableIntakes, updateIntake } from '@/modules/platform/telegram/calc-store';
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
  await db.execute(sql`DELETE FROM telegram_once WHERE chat_id = ${String(chat)}::bigint`).catch(() => {});
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
