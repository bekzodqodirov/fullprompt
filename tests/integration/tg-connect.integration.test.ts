import 'dotenv/config';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { tgAccounts, users } from '@/modules/platform/db/schema';
import { phoneHolder } from '@/modules/wms/crm/telegram-accounts';
import { beginTgLogin } from '@/modules/wms/crm/telegram-connect';

/**
 * One Telegram number belongs to one person here (0038's unique index). The
 * connect screen used to find that out at the END of a login: the insert
 * refused, the screen said «Bo'lmadi», and the code the manager had typed was
 * spent — with nothing to say whose number it was. It is asked before
 * Telegram is asked for anything now.
 *
 * The file gives its own process a throwaway API pair and session key so
 * `beginTgLogin` gets past its configuration check. The refusal must come
 * BEFORE the network: this container has no route to Telegram, so a begin
 * that reached `client.connect()` would outlive the test's timeout — which
 * is the red this file turns without the check.
 *
 * The rows are `signed_out` with no session: nothing that lists live
 * accounts (the listener's scan, the quiet-listener sweep another file runs
 * in parallel) may see them.
 */
const stamp = String(Date.now()).slice(-7);
const madeUsers: string[] = [];
const env = {
  TELEGRAM_API_ID: process.env.TELEGRAM_API_ID,
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
  TG_SESSION_KEY: process.env.TG_SESSION_KEY,
};

async function user(name: string) {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${stamp}${madeUsers.length}`, fullName: name, passwordHash: 'x' })
    .returning();
  madeUsers.push(u!.id);
  return u!;
}

beforeAll(() => {
  process.env.TELEGRAM_API_ID = '1';
  process.env.TELEGRAM_API_HASH = 'test';
  process.env.TG_SESSION_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterAll(async () => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (madeUsers.length) {
    await db.delete(tgAccounts).where(inArray(tgAccounts.managerUserId, madeUsers));
    // No service wrote an audit row about these people; they carry nothing.
    await db.delete(users).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

describe('a Telegram number another manager already holds', () => {
  it('is refused before any code is sent, naming the holder', async () => {
    const holder = await user('Ulangan Hodim');
    const newcomer = await user('Yangi Hodim');
    const phone = `+99897${stamp}1`;
    await db.insert(tgAccounts).values({ managerUserId: holder.id, tgPhone: phone, status: 'signed_out' });

    // Typed with the spaces people type; the check compares the number.
    const typed = `${phone.slice(0, 4)} ${phone.slice(4, 6)} ${phone.slice(6)}`;
    expect(await beginTgLogin(newcomer.id, typed)).toEqual({
      ok: false,
      error: 'phone_taken',
      holder: 'Ulangan Hodim',
    });
  }, 8_000);

  it('is found in the shape the CLI stored it in, and a manager’s own row is not «somebody else»', async () => {
    const cli = await user('CLI Hodim');
    const other = await user('Boshqa Hodim');
    const digits = `99896${stamp}2`;
    await db.insert(tgAccounts).values({ managerUserId: cli.id, tgPhone: digits, status: 'signed_out' });

    expect(await phoneHolder(`+${digits}`, other.id)).toEqual({ name: 'CLI Hodim' });
    // Reconnecting one's own number REPLACES the row (`saveAccount`), so the
    // check must not refuse the person it belongs to.
    expect(await phoneHolder(`+${digits}`, cli.id)).toBeNull();
  });
});
