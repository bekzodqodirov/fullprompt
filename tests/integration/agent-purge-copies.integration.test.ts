import 'dotenv/config';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/modules/platform/db/client';
import { notifications, tgChatRules, users } from '@/modules/platform/db/schema';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { purgeAgentChat, PURGED_CARD_TEXT } from '@/modules/wms/agent/purge';

/**
 * The purge's Telegram half runs OFF the request (review I5): the web tray's
 * «Qo'shma» awaits `purgeAgentChat` before it deletes the customer's
 * messages, and editing every sent card copy one by one — each with a
 * 10-second deadline — on a day Telegram is slow was a button that hung
 * while the text it was meant to remove was still stored.
 *
 * The transport is a fake that HOLDS every call until released, so «did the
 * purge wait for Telegram» is a deterministic question. Everything is this
 * file's own: one user, one peer, chat ids starting `97<stamp>`.
 */

const STAMP = String(Date.now()).slice(-7);
const PEER = BigInt(`97${STAMP}`);
const CHAT = Number(`97${STAMP}1`);
let userId = '';
let ruleId = '';
const savedToken = process.env.TELEGRAM_BOT_TOKEN;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99897${STAMP}11`, fullName: `Tozalash ${STAMP}`, passwordHash: 'x' })
    .returning({ id: users.id });
  userId = u!.id;
  const [r] = await db
    .insert(tgChatRules)
    .values({ managerUserId: userId, peerId: PEER, peerTitle: 'Notanish', peerPhone: '+998901112233' })
    .returning({ id: tgChatRules.id });
  ruleId = r!.id;
  process.env.TELEGRAM_BOT_TOKEN = '7000003:TEST';
});

afterAll(async () => {
  __setTelegramTransport(null);
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await db.delete(tgChatRules).where(eq(tgChatRules.id, ruleId));
  await db.update(users).set({ active: false }).where(eq(users.id, userId));
});

describe('the purge never waits on Telegram (review I5)', () => {
  it('returns while the copies’ edits are still in flight — and the edits, once through, carry no buttons', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const edits: Record<string, unknown>[] = [];
    __setTelegramTransport(async (url, init) => {
      if (url.endsWith('/editMessageText')) edits.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      await gate;
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    for (const messageId of [101, 102]) {
      await db.insert(notifications).values({
        userId,
        channel: 'telegram',
        type: 'AgentStranger',
        status: 'sent',
        sentAt: new Date(),
        payload: { text: `Mijoz: «yukim qayerda» ${STAMP}`, ruleId, tg: { chatId: CHAT, messageId } },
      });
    }

    const outcome = await Promise.race([
      purgeAgentChat(userId, PEER).then(() => 'returned' as const),
      new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 3_000)),
    ]);
    expect(outcome).toBe('returned');
    // The database half is done by then: the cards are blank.
    const rows = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), sql`${notifications.payload}->>'ruleId' = ${ruleId}`));
    expect(rows.map((r) => (r.payload as { text: string }).text)).toEqual([PURGED_CARD_TEXT, PURGED_CARD_TEXT]);

    release();
    await vi.waitFor(() => expect(edits).toHaveLength(2), { timeout: 5_000 });
    for (const body of edits) {
      expect(String(body.text)).toContain('Suhbat shaxsiy deb o‘chirildi');
      expect(body.reply_markup).toBeUndefined();
    }
  });
});
