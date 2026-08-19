import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, deals, notifications, users } from '@/modules/platform/db/schema';
import { decidedLeadCounts } from '@/modules/wms/crm/analytics';
import { salesSnapshot } from '@/modules/wms/reports/overview';
import { createDeal, openDealsSummary } from '@/modules/wms/deals/service';
import { notificationProblemCount } from '@/modules/platform/notifications/service';

/**
 * The admin home's numbers (round 107, item 4). Every cell reuses a screen's
 * own function; what belongs here is the three places the design review
 * found lies waiting: the decided CLOCK shared across screens, the
 * mixed-currency deal sum, and a «problems» count that would never read
 * zero if `muted` were in it.
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId: string;
let clientId: string;
const madeDeals: string[] = [];
const madeNotifications: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `AD${SUFFIX.slice(-5)}`, name: `Dash mijoz ${SUFFIX}` })
      .returning({ id: clients.id })
  )[0]!.id;
});

afterAll(async () => {
  if (madeNotifications.length) {
    await db.delete(notifications).where(inArray(notifications.id, madeNotifications));
  }
  if (madeDeals.length) await db.delete(deals).where(inArray(deals.id, madeDeals));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe('one decided clock across screens', () => {
  it('decidedLeadCounts and salesSnapshot count the month with the SAME clock', async () => {
    // Both read the same table on the same closed_at predicate now — two
    // screens printing different «bu oy yutilgan» was the review's #513 find.
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const [decided, snapshot] = await Promise.all([decidedLeadCounts(from, to), salesSnapshot()]);
    expect(decided.won).toBe(snapshot.wonMonth);
    expect(decided.lost).toBe(snapshot.lostMonth);
  });
});

describe('the open-deals sum refuses to add som to dollars', () => {
  it('counts every open deal, sums only the USD quotes, names the rest', async () => {
    const before = await openDealsSummary();
    const usdDeal = await createDeal(
      { clientId, quotedAmount: 700, quotedCurrency: 'USD' },
      ctx(),
    );
    madeDeals.push(usdDeal);
    const cnyDeal = await createDeal(
      { clientId, quotedAmount: 5000, quotedCurrency: 'CNY' },
      ctx(),
    );
    madeDeals.push(cnyDeal);
    const after = await openDealsSummary();
    expect(after.count).toBe(before.count + 2);
    expect(after.usdSum).toBeCloseTo(before.usdSum + 700, 2);
    expect(after.otherCurrency).toBe(before.otherCurrency + 1);
  });
});

describe('the «yuborilmagan» signal', () => {
  it('counts failures, never the by-design muted settlements', async () => {
    const before = await notificationProblemCount(7);
    const mint = async (status: string, error: string | null) =>
      (
        await db
          .insert(notifications)
          .values({
            userId: actorId,
            channel: 'telegram',
            type: 'TaskAssigned',
            payload: { test: SUFFIX },
            status,
            error,
          })
          .returning({ id: notifications.id })
      )[0]!.id;
    madeNotifications.push(await mint('failed', 'boom'));
    madeNotifications.push(await mint('muted', 'telegram not linked'));
    madeNotifications.push(await mint('sent', null));
    const after = await notificationProblemCount(7);
    expect(after).toBe(before + 1);
  });
});
