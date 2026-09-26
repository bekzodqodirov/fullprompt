import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { auditLog, businessTargets, users } from '@/modules/platform/db/schema';
import { setTarget, targetsFor } from '@/modules/wms/accounting/targets';

/**
 * The owner's monthly plan (0102, his 5a). Months in 1666 — a year no other
 * file and no dashboard reads — so the rows cannot be anybody else's input.
 */

const MONTHS = ['1666-01', '1666-02', '1666-03', '1666-04'];
let actorId = '';
const ctx = () => ({ actorId });

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  await db.delete(businessTargets).where(inArray(businessTargets.month, MONTHS.map((m) => `${m}-01`)));
});

afterAll(async () => {
  await db.delete(businessTargets).where(inArray(businessTargets.month, MONTHS.map((m) => `${m}-01`)));
  await pgClient.end();
});

const auditRows = async () =>
  db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'business_target'), eq(auditLog.actorId, actorId)));

describe('the monthly plan', () => {
  it('stores both figures for a month and reads them back by month', async () => {
    await setTarget({ month: '1666-01', revenueUsd: 50_000, netProfitUsd: 8_000 }, ctx());
    await setTarget({ month: '1666-02', revenueUsd: 60_000 }, ctx());
    const plans = await targetsFor(['1666-01', '1666-02', '1666-03']);
    expect(plans.get('1666-01')).toEqual({ revenueUsd: 50_000, netProfitUsd: 8_000 });
    // A month with only a revenue plan has NO profit plan — null, never $0.
    expect(plans.get('1666-02')).toEqual({ revenueUsd: 60_000, netProfitUsd: null });
    expect(plans.has('1666-03')).toBe(false);
  });

  it('an unchanged save writes nothing; a change writes one audit row', async () => {
    const before = (await auditRows()).length;
    await setTarget({ month: '1666-01', revenueUsd: 50_000, netProfitUsd: 8_000 }, ctx());
    expect((await auditRows()).length).toBe(before);
    await setTarget({ month: '1666-01', revenueUsd: 55_000, netProfitUsd: 8_000 }, ctx());
    expect((await auditRows()).length).toBe(before + 1);
    expect((await targetsFor(['1666-01'])).get('1666-01')?.revenueUsd).toBe(55_000);
  });

  it('clearing both figures removes the month, so it reads «no plan» again', async () => {
    await setTarget({ month: '1666-04', revenueUsd: 1_000 }, ctx());
    await setTarget({ month: '1666-04', revenueUsd: null, netProfitUsd: null }, ctx());
    expect((await targetsFor(['1666-04'])).has('1666-04')).toBe(false);
  });

  it('a planned loss is a plan; a negative revenue, a NaN or a bad month is refused', async () => {
    await setTarget({ month: '1666-03', netProfitUsd: -2_000 }, ctx());
    expect((await targetsFor(['1666-03'])).get('1666-03')?.netProfitUsd).toBe(-2_000);
    await expect(setTarget({ month: '1666-03', revenueUsd: -1 }, ctx())).rejects.toMatchObject({
      code: 'negative',
    });
    await expect(setTarget({ month: '1666-03', revenueUsd: Number('1 000') }, ctx())).rejects.toMatchObject({
      code: 'bad_number',
    });
    await expect(setTarget({ month: '1666-13', revenueUsd: 1 }, ctx())).rejects.toMatchObject({
      code: 'bad_month',
    });
  });
});
