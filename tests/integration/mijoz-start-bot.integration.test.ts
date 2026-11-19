import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { telegramLinks, users } from '@/modules/platform/db/schema';
import { adVisitFor } from '@/modules/platform/telegram/ad-intake';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

/**
 * `t.me/<bot>?start=mijoz` — the link the new-client card carries (0151),
 * through the bot the server runs (the harness: the real handler chain, the
 * Bot API a recorder).
 *
 * A stranger is greeted and asked for the number — never «Havola eskirgan»,
 * which is what an unknown payload is answered with, and never an advert
 * visit (a stranger's contact would then land as an inbound LEAD). A chat
 * that is already somebody's gets the ordinary greeting: asking a connected
 * person for their number again takes their keyboard away (CONV-5).
 */

const RUN = String(Date.now()).slice(-6);
const CHAT_STRANGER = 8_510_000_000 + Number(RUN) * 10 + 1;
const CHAT_STAFF = 8_510_000_000 + Number(RUN) * 10 + 2;

let h: BotHarness;
let staffId = '';

beforeAll(async () => {
  h = botHarness();
  const [staff] = await db
    .insert(users)
    .values({ phone: `+99893${RUN.padStart(7, '0')}`, fullName: `Mijoz start ${RUN}`, passwordHash: 'x', locale: 'uz' })
    .returning({ id: users.id });
  staffId = staff!.id;
  await db
    .insert(telegramLinks)
    .values({ userId: staffId, telegramChatId: BigInt(CHAT_STAFF), status: 'linked', linkedAt: new Date() });
});

afterAll(async () => {
  h.restore();
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, [staffId]));
  // Never deleted: a user row is referenced by audit and notification history.
  await db.update(users).set({ active: false }).where(eq(users.id, staffId));
  await pgClient.end();
});

describe('?start=mijoz', () => {
  it('greets a stranger and asks for the number — no «link expired», no advert visit', async () => {
    const mark = h.mark();
    await h.handle(tg.command(CHAT_STRANGER, 'start', 'mijoz'));
    await h.settle();
    const sent = h.since(mark).api.filter((c) => c.method === 'sendMessage' && Number(c.payload.chat_id) === CHAT_STRANGER);
    expect(sent).toHaveLength(1);
    const t = clientLabels(null);
    const text = String(sent[0]!.payload.text);
    expect(text).toBe(`${t.mijozStart}\n\n${t.askPhone}`);
    expect(text).not.toContain(t.linkExpired);
    // The one-time phone keyboard — the self-service door's only proof.
    const markup = sent[0]!.payload.reply_markup as { keyboard?: { request_contact?: boolean }[][] };
    expect(markup.keyboard?.[0]?.[0]?.request_contact).toBe(true);
    expect(adVisitFor(CHAT_STRANGER)).toBeNull();
  });

  it('a chat that is already a colleague’s gets the ordinary greeting, not the phone request', async () => {
    const mark = h.mark();
    await h.handle(tg.command(CHAT_STAFF, 'start', 'mijoz'));
    await h.settle();
    const texts = h.textsTo(CHAT_STAFF, mark);
    expect(texts).toContain(`👋 Mijoz start ${RUN}`);
    expect(texts.some((one) => one.includes(clientLabels(null).askPhone))).toBe(false);
  });

  it('an unknown payload still reads as an expired link — only the exact word is the card’s', async () => {
    const mark = h.mark();
    await h.handle(tg.command(CHAT_STRANGER, 'start', 'mijozz'));
    await h.settle();
    expect(h.textsTo(CHAT_STRANGER, mark).join('\n')).toContain(clientLabels(null).linkExpired);
  });
});
