import 'dotenv/config';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { notifications, telegramLinks, users } from '@/modules/platform/db/schema';
import { __resetTelegramPause, sendPendingTelegram } from '@/modules/platform/notifications/service';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';

/**
 * The advert lead's push arrives SILENTLY at night — as Telegram receives it
 * (0113, the design judge's finding 1).
 *
 * The push ends in our own card link, so the drain lifts that link into a
 * «↗️ Ochish» button and sends the message BY HAND through `botCall`, not
 * through `sendText` — the one path where a `silent` flag used to be lost. A
 * test of `sendText` alone stays green while the seller's phone rings at
 * three in the morning, so this one reads the body the transport was handed.
 *
 * The staff queue is shared: before each drain every foreign pending row is
 * parked and afterwards put back exactly as found (#713, #730).
 */

const APP = 'https://test.gsrwms.uz';
const STAMP = String(Date.now()).slice(-7);
const CHAT = 720_000_000 + Number(STAMP);
const LEAD = '123e4567-e89b-12d3-a456-4266141740aa';

let calls: { method: string; body: Record<string, unknown> }[] = [];
const mine: string[] = [];
const parked = new Set<string>();
let sellerId = '';
const savedEnv = { token: process.env.TELEGRAM_BOT_TOKEN, app: process.env.APP_URL };

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ phone: `+99876${STAMP}0`, fullName: `Tungi sotuvchi ${STAMP}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  sellerId = user!.id;
  await db
    .insert(telegramLinks)
    .values({ userId: sellerId, telegramChatId: BigInt(CHAT), status: 'linked', linkedAt: new Date() });
});

beforeEach(() => {
  calls = [];
  __resetTelegramPause();
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  process.env.APP_URL = APP;
  __setTelegramTransport(async (url, init) => {
    calls.push({ method: url.slice(url.lastIndexOf('/') + 1), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  });
});

afterEach(async () => {
  __setTelegramTransport(null);
  if (mine.length) await db.delete(notifications).where(inArray(notifications.id, mine));
  mine.length = 0;
});

afterAll(async () => {
  if (parked.size) {
    await db
      .update(notifications)
      .set({ status: 'pending', claimedAt: null })
      .where(and(inArray(notifications.id, [...parked]), eq(notifications.status, 'sending')));
  }
  await db.delete(notifications).where(eq(notifications.userId, sellerId));
  await db.delete(telegramLinks).where(eq(telegramLinks.userId, sellerId));
  await db.delete(users).where(eq(users.id, sellerId));
  process.env.TELEGRAM_BOT_TOKEN = savedEnv.token;
  process.env.APP_URL = savedEnv.app;
  await pgClient.end();
});

async function queueLead(): Promise<void> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId: sellerId,
      channel: 'telegram',
      type: 'InboundLeadArrived',
      payload: {
        text: `🆕 Yangi lid · Instagram\nAziz · +998 90 123 45 67\n${APP}/crm/leads/${LEAD}`,
        leadId: LEAD,
        intakeId: LEAD,
      },
      status: 'pending',
    })
    .returning({ id: notifications.id });
  mine.push(row!.id);
}

async function drain(now: Date): Promise<Record<string, unknown>> {
  const others = await db
    .update(notifications)
    .set({ status: 'sending', claimedAt: new Date() })
    .where(and(eq(notifications.channel, 'telegram'), eq(notifications.status, 'pending'), notInArray(notifications.id, mine)))
    .returning({ id: notifications.id });
  for (const row of others) parked.add(row.id);
  await sendPendingTelegram(now);
  const sends = calls.filter((c) => c.method === 'sendMessage');
  expect(sends).toHaveLength(1);
  return sends[0]!.body;
}

describe('the advert lead’s push at night', () => {
  it('goes silently on the link-button path — decided when it is SENT', async () => {
    await queueLead();
    const body = await drain(new Date('2026-09-01T23:30:00+05:00'));
    expect(body.disable_notification).toBe(true);
    // It IS the hand-made path: the card is a button beside «📞 Bog'landim».
    const rows = (body.reply_markup as { inline_keyboard: { url?: string; callback_data?: string }[][] }).inline_keyboard;
    expect(rows[0]![0]!.callback_data).toBe(`lc:${LEAD}`);
    expect(rows.at(-1)![0]!.url).toBe(`${APP}/crm/leads/${LEAD}`);
  });

  it('rings by day', async () => {
    await queueLead();
    const body = await drain(new Date('2026-09-01T11:00:00+05:00'));
    expect(body.disable_notification).toBeUndefined();
  });
});
