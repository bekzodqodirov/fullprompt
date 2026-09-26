import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  notifications,
  partners,
  partnerTransactions,
  partnerTypes,
  users,
} from '@/modules/platform/db/schema';
import { addDays, tashkentDay } from '@/modules/platform/time/tashkent';
import {
  alertPartnerTerms,
  setPartnerTerms,
  termStates,
} from '@/modules/wms/partners/terms-service';

/**
 * The owner's 8a (2026-09-26): a counterparty's debt is due N days after it
 * was written, paid oldest first, and we let ourselves owe up to a limit —
 * reminders three days ahead, when it passes, and at 80 % of the limit, each
 * ONCE, to the people who read the company's money.
 */
const SUFFIX = `${Date.now()}`.slice(-7);
const NAME = `Terms firm ${SUFFIX}`;
let actorId = '';
let partnerId = '';
const today = tashkentDay();
const ctx = () => ({ actorId });

async function move(type: 'charge' | 'offset', amount: number, txDate: string) {
  await db.insert(partnerTransactions).values({
    partnerId,
    type,
    amount: amount.toFixed(2),
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: amount.toFixed(2),
    txDate,
    createdBy: actorId,
  });
}

// One row per recipient: the set of distinct texts is what was SAID.
const reminders = async () => [
  ...new Set(
    (
      await db
        .select({ id: notifications.id, text: sql<string>`${notifications.payload}->>'text'` })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'PartnerDebtDue'),
            sql`${notifications.payload}->>'text' LIKE ${`%${NAME}%`}`,
          ),
        )
    ).map((row) => row.text),
  ),
];

const rowCount = async () =>
  Number(
    (
      await db
        .select({ n: sql<string>`count(*)` })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'PartnerDebtDue'),
            sql`${notifications.payload}->>'text' LIKE ${`%${NAME}%`}`,
          ),
        )
    )[0]!.n,
  );

beforeAll(async () => {
  actorId = (
    await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1)
  )[0]!.id;
  const [type] = await db.select({ id: partnerTypes.id }).from(partnerTypes).limit(1);
  const [p] = await db
    .insert(partners)
    .values({ name: NAME, typeId: type!.id, createdBy: actorId })
    .returning();
  partnerId = p!.id;
  // 1000 eighteen days ago, 500 five days ago, 700 paid three days ago: the
  // payment closes 700 of the OLDEST debt, so 300 of it is what is due next.
  await move('charge', 1000, addDays(today, -18));
  await move('charge', 500, addDays(today, -5));
  await move('offset', 700, addDays(today, -3));
});

afterAll(async () => {
  const ids = (await reminders()).length
    ? await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'PartnerDebtDue'),
            sql`${notifications.payload}->>'text' LIKE ${`%${NAME}%`}`,
          ),
        )
    : [];
  if (ids.length)
    await db.delete(notifications).where(
      inArray(
        notifications.id,
        ids.map((r) => r.id),
      ),
    );
  await db.delete(partnerTransactions).where(eq(partnerTransactions.partnerId, partnerId));
  await db.update(partners).set({ active: false }).where(eq(partners.id, partnerId));
  await pgClient.end();
});

describe('a counterparty’s payment terms', () => {
  it('no terms: nothing to read, nothing to send', async () => {
    expect((await termStates([partnerId])).size).toBe(0);
    await alertPartnerTerms(today);
    expect(await reminders()).toEqual([]);
  });

  it('20 days and a $1000 limit: due in two days, at 80 % of the limit', async () => {
    await setPartnerTerms(partnerId, { payWithinDays: 20, debtLimitUsd: 1000 }, ctx());
    const state = (await termStates([partnerId])).get(partnerId)!;
    expect(state).toMatchObject({
      balanceUsd: 800,
      limitPct: 80,
      due: { dueDate: addDays(today, 2), dueUsd: 300, overdueUsd: 0 },
    });
  });

  it('each reminder goes once', async () => {
    await alertPartnerTerms(today);
    const first = await reminders();
    expect(first.some((text) => text.startsWith(`⏰ ${NAME}`))).toBe(true);
    expect(first.some((text) => text.startsWith(`💳 ${NAME}`))).toBe(true);
    const rowsBefore = await rowCount();
    await alertPartnerTerms(today);
    expect((await reminders()).length).toBe(first.length);
    // …and not one more ROW: a second send of the same words is still a send.
    expect(await rowCount()).toBe(rowsBefore);
    const row = await db.query.partners.findFirst({ where: eq(partners.id, partnerId) });
    expect(row!.dueSoonAlertedFor).toBe(addDays(today, 2));
    expect(row!.limitAlertedAt).not.toBeNull();
  });

  it('when the day passes it is said again, as overdue', async () => {
    const before = (await reminders()).length;
    await alertPartnerTerms(addDays(today, 3));
    const after = await reminders();
    expect(after.length).toBe(before + 1);
    expect(after.some((text) => text.startsWith(`⚠️ ${NAME}`))).toBe(true);
  });

  it('paying below 80 % re-arms the limit reminder', async () => {
    await move('offset', 300, today);
    await alertPartnerTerms(today);
    const row = await db.query.partners.findFirst({ where: eq(partners.id, partnerId) });
    expect(row!.limitAlertedAt).toBeNull();
  });
});
