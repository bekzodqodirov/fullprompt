import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { loginAttempts } from '@/modules/platform/db/schema';
import { isRateLimited, recordLoginAttempt } from '@/modules/platform/auth/rate-limit';

/**
 * The fence has to hold when the attacker controls the address — which they
 * do, because it comes from `X-Forwarded-For`.
 */
// A counter as well as the clock: two calls in the same millisecond returned
// the SAME number, so «the victim» and «the colleague» were one person and the
// test proved the opposite of what it says.
let seq = 0;
const who = () => `+99890${String(Date.now()).slice(-5)}${String((seq += 1)).padStart(2, '0')}`;

afterAll(async () => {
  await pgClient.end();
});

describe('login attempts are counted on the account', () => {
  it('five failures lock it however many addresses they came from', async () => {
    const identifier = who();
    // Every attempt from a DIFFERENT address, which is exactly what rotating
    // one header buys. Under the old (identifier, ip) pairing this left five
    // buckets of one and the sixth guess sailed through.
    for (let i = 0; i < 5; i++) {
      await recordLoginAttempt(identifier, `203.0.113.${i + 1}`, false);
      expect(await isRateLimited(identifier, `203.0.113.${i + 2}`)).toBe(i >= 4);
    }
    expect(await isRateLimited(identifier, '198.51.100.77')).toBe(true);
  });

  it('a successful sign-in is not an attempt against anybody', async () => {
    const identifier = who();
    for (let i = 0; i < 8; i++) await recordLoginAttempt(identifier, '203.0.113.1', true);
    expect(await isRateLimited(identifier, '203.0.113.1')).toBe(false);
  });

  it('locks one account, not the colleague who shares the office address', async () => {
    const victim = who();
    const colleague = who();
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 5; i++) await recordLoginAttempt(victim, ip, false);
    expect(await isRateLimited(victim, ip)).toBe(true);
    // Under the account count alone the colleague is untouched; the wider
    // per-address net only trips at twenty.
    expect(await isRateLimited(colleague, ip)).toBe(false);
  });

  afterAll(async () => {
    await db.delete(loginAttempts).where(sql`identifier LIKE '+99890%'`);
  });
});
