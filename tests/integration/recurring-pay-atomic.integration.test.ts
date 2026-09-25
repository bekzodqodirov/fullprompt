import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { expenses, partnerTypes, recurringExpenses, users } from '@/modules/platform/db/schema';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { saveCategory, saveRecurring } from '@/modules/wms/accounting/service';
import { payRecurring, recurringDue } from '@/modules/wms/accounting/recurring';
import { savePartner, setPartnerActive } from '@/modules/wms/partners/service';

/**
 * «To'landi» through a firm writes the expense AND the firm's debt in ONE
 * transaction (0106, M7): the charge failing must take the expense with it,
 * so the month stays open and the press can simply be made again. After a
 * commit, a failed charge left the month «paid» on an expense that owed the
 * firm nothing — and no press could repair it.
 *
 * Its own file because `vi.mock` replaces the module for the whole file's
 * graph.
 */
vi.mock('@/modules/wms/partners/link', async (orig) => ({
  ...(await orig<typeof import('@/modules/wms/partners/link')>()),
  chargeForExpenseTx: vi.fn().mockRejectedValue(new Error('charge failed')),
}));

const SUFFIX = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const TODAY = tashkentDay();
let actorId: string;
const ctx = () => ({ actorId });
let categoryId: string;
let firm: string;
let templateId: string | undefined;

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  categoryId = (await saveCategory({ name: `Rec atomic ${SUFFIX}`, cash: true, sortOrder: 951, active: true }, ctx())).id;
  const [type] = await db.select().from(partnerTypes).limit(1);
  firm = await savePartner(null, { name: `Rec atomic firma ${SUFFIX}`, typeId: type!.id }, ctx());
});

afterAll(async () => {
  try {
    if (templateId) {
      const rows = await db.select({ id: expenses.id }).from(expenses).where(eq(expenses.recurringId, templateId));
      if (rows.length > 0) await db.delete(expenses).where(inArray(expenses.id, rows.map((row) => row.id)));
      await db.execute(sql`DELETE FROM recurring_skips WHERE recurring_id = ${templateId}::uuid`);
      await db.delete(recurringExpenses).where(eq(recurringExpenses.id, templateId));
    }
    if (categoryId) {
      await saveCategory({ id: categoryId, name: `Rec atomic ${SUFFIX}`, cash: true, sortOrder: 951, active: false }, ctx());
    }
    if (firm) await setPartnerActive(firm, false, ctx());
  } finally {
    await pgClient.end();
  }
});

describe("«To'landi» through a firm is one transaction (M7)", () => {
  it('a failed charge writes no expense and leaves the month open', async () => {
    const template = await saveRecurring(
      { categoryId, amount: 500, currency: 'USD', dayOfMonth: 1, partnerId: firm, active: true },
      ctx(),
    );
    templateId = template.id;
    await expect(
      payRecurring(
        { recurringId: template.id, month: TODAY.slice(0, 7), payer: `partner:${firm}`, amount: 500, expenseDate: TODAY },
        ctx(),
      ),
    ).rejects.toThrow('charge failed');
    const written = await db.select({ id: expenses.id }).from(expenses).where(eq(expenses.recurringId, template.id));
    expect(written).toHaveLength(0);
    const open = (await recurringDue(TODAY)).some(
      (row) => row.recurringId === template.id && row.month === `${TODAY.slice(0, 7)}-01`,
    );
    expect(open).toBe(true);
  });
});
