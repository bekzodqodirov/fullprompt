import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, clientTelegramLinks, tgAccounts, users } from '@/modules/platform/db/schema';
import { chatLocaleFor, setChatLocale } from '@/modules/platform/telegram/cabinet-locale';
import { managersFor } from '@/modules/wms/client-cabinet/service';

/**
 * Round C's two shared reads: who a customer writes to, and what language a
 * chat speaks. Both have more than one consumer (the bot, the Mini App, the
 * pushes), which is exactly why each is one function with one test.
 */
const stamp = String(Date.now()).slice(-7);
const madeClients: string[] = [];
const madeUsers: string[] = [];

async function user(name: string, over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99890${stamp}${madeUsers.length}`, fullName: name, passwordHash: 'x', ...over })
    .returning();
  madeUsers.push(u!.id);
  return u!;
}

async function client(code: string, over: Partial<typeof clients.$inferInsert> = {}) {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `${code}${stamp.slice(-4)}`, name: `Contact ${code}`, phones: [], ...over })
    .returning();
  madeClients.push(c!.id);
  return c!;
}

afterAll(async () => {
  if (madeClients.length) {
    await db.delete(clientTelegramLinks).where(inArray(clientTelegramLinks.clientId, madeClients));
    await db.delete(clients).where(inArray(clients.id, madeClients));
  }
  if (madeUsers.length) {
    await db.delete(tgAccounts).where(inArray(tgAccounts.managerUserId, madeUsers));
    // A user may be referenced by an audit row a service wrote; none here, so
    // the rows go (they carry no history of their own).
    await db.delete(users).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

describe('managersFor — who the customer writes to', () => {
  it('a FRESH verified handle wins, then the typed one, then a phone link; a departed manager is nobody', async () => {
    const verified = await user('Verified Mgr', { telegramUsername: 'typed_one' });
    await db.insert(tgAccounts).values({
      managerUserId: verified.id,
      tgPhone: `+99899${stamp}1`,
      status: 'active',
      lastSeenAt: new Date(),
      tgUsername: 'real_handle',
      tgUsernameCheckedAt: new Date(),
    });
    const typed = await user('Typed Mgr', { telegramUsername: 'only_typed' });
    const phoneOnly = await user('Phone Mgr');
    const departed = await user('Gone Mgr', { active: false, telegramUsername: 'gone_one' });

    const a = await client('MA', { salesManagerId: verified.id });
    const b = await client('MB', { salesManagerId: typed.id });
    const c = await client('MC', { salesManagerId: phoneOnly.id });
    const d = await client('MD', { salesManagerId: departed.id });
    const e = await client('ME');

    const map = await managersFor([a.id, b.id, c.id, d.id, e.id]);
    // The offer PDF's number (the owner's «standart»), never the connected
    // account's personal Telegram number.
    expect(map.get(a.id)).toEqual({
      name: 'Verified Mgr',
      phone: verified.phone,
      telegramUrl: 'https://t.me/real_handle',
    });
    expect(map.get(b.id)?.telegramUrl).toBe('https://t.me/only_typed');
    expect(map.get(c.id)?.telegramUrl).toBe(`https://t.me/+${phoneOnly.phone!.replace(/\D/g, '')}`);
    expect(map.has(d.id)).toBe(false);
    expect(map.has(e.id)).toBe(false);
  });

  it('a verified handle nobody has re-read for two hours is not trusted (round 113’s rule)', async () => {
    // A released handle can be registered by a stranger; a customer who owes
    // money must never be sent to one (judge PRIV-1).
    const m = await user('Stale Mgr', { telegramUsername: 'fallback_typed' });
    await db.insert(tgAccounts).values({
      managerUserId: m.id,
      tgPhone: `+99899${stamp}2`,
      status: 'active',
      lastSeenAt: new Date(),
      tgUsername: 'stale_handle',
      tgUsernameCheckedAt: new Date(Date.now() - 2 * 3600_000),
    });
    const k = await client('MF', { salesManagerId: m.id });
    const got = (await managersFor([k.id])).get(k.id)!;
    expect(got.telegramUrl).toBe('https://t.me/fallback_typed');
    expect(got.phone).toBe(m.phone);
  });

  it('what reaches a customer carries exactly three keys — no staff id (judge PRIV-13)', async () => {
    const m = await user('Shape Mgr');
    const k = await client('MG', { salesManagerId: m.id });
    expect(Object.keys((await managersFor([k.id])).get(k.id)!).sort()).toEqual(['name', 'phone', 'telegramUrl']);
  });

  it('asks nothing for nobody', async () => {
    expect((await managersFor([])).size).toBe(0);
  });
});

describe('a chat’s language — one writer', () => {
  it('sets every code in the chat, and a new code reads the person’s choice', async () => {
    const chatId = BigInt(`7${stamp}33`);
    const first = await client('LA');
    const second = await client('LB');
    const elsewhere = await client('LC');
    await db.insert(clientTelegramLinks).values([
      { clientId: first.id, telegramChatId: chatId, status: 'linked', linkedAt: new Date(Date.now() - 60_000) },
      { clientId: second.id, telegramChatId: chatId, status: 'linked', linkedAt: new Date() },
      { clientId: elsewhere.id, telegramChatId: BigInt(`6${stamp}44`), status: 'linked', linkedAt: new Date() },
    ]);
    expect(await chatLocaleFor(chatId)).toBeNull();

    const ids = await setChatLocale(chatId, 'uz');
    expect(ids.sort()).toEqual([first.id, second.id].sort());
    const rows = await db.select().from(clients).where(inArray(clients.id, [first.id, second.id, elsewhere.id]));
    expect(rows.find((r) => r.id === first.id)?.locale).toBe('uz');
    expect(rows.find((r) => r.id === second.id)?.locale).toBe('uz');
    expect(rows.find((r) => r.id === elsewhere.id)?.locale).toBeNull();

    // A third code joins the chat with no language of its own.
    const third = await client('LD');
    await db.insert(clientTelegramLinks).values({ clientId: third.id, telegramChatId: chatId, status: 'linked', linkedAt: new Date() });
    expect(await chatLocaleFor(chatId)).toBe('uz');
    const [t] = await db.select().from(clients).where(eq(clients.id, third.id));
    expect(t!.locale).toBeNull();
  });

  it('a chat holding nobody changes nothing', async () => {
    expect(await setChatLocale(BigInt(`5${stamp}55`), 'ru')).toEqual([]);
  });
});
