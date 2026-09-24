import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/modules/platform/db/client';
import { clients, clientTransactions, users } from '@/modules/platform/db/schema';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { futureDatedEntries } from '@/modules/wms/finance/service';

/**
 * R5: the ageing report's «future-dated» count and its default `asOf` are ONE
 * day, Tashkent's. The count used to ask the database's `CURRENT_DATE` — UTC
 * — so from midnight to 05:00 in the office a row dated the office's today
 * was called «future» by the very page that ages it as today.
 *
 * The clock is faked (Date only — the driver's timers stay real) and set in
 * the year 3000: a fixture that far out collides with nothing else in the
 * shared database, and the server's real `CURRENT_DATE` is centuries earlier,
 * so reading it instead of the bound day would count BOTH rows below.
 */
const STAMP = String(Date.now()).slice(-6);
let clientId = '';
let actorId = '';

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `TD${STAMP}`, name: `Tashkent day ${STAMP}` })
    .returning();
  clientId = client!.id;
});

afterAll(async () => {
  vi.useRealTimers();
  if (!clientId) return;
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  await db.delete(clients).where(eq(clients.id, clientId));
});

describe("futureDatedEntries in Tashkent's first five hours", () => {
  it("counts only what is after Tashkent's today — not today itself", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 20:00 UTC on 31 December = 01:00 on 1 January in Tashkent.
    vi.setSystemTime(new Date('3000-12-31T20:00:00Z'));
    try {
      expect(tashkentDay()).toBe('3001-01-01');
      const before = await futureDatedEntries();
      const row = (txDate: string) => ({
        clientId,
        type: 'charge',
        amount: '10.00',
        currency: 'USD',
        rateToUsd: '1',
        amountUsd: '10.00',
        txDate,
        createdBy: actorId,
      });
      // Today in Tashkent (still yesterday in UTC), and tomorrow.
      await db.insert(clientTransactions).values([row('3001-01-01'), row('3001-01-02')]);
      const after = await futureDatedEntries();
      expect(after.count - before.count).toBe(1);
      expect(Math.round((after.usd - before.usd) * 100) / 100).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
