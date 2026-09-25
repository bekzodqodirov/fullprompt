import { eq, inArray } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { db } from '../../platform/db/client';
import { businessTargets } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';

/**
 * The owner's monthly plan (0102, his answer 5a): «har oy maqsad kiritasiz,
 * dashboard reja-fakt ko'rsatadi».
 *
 * Two figures per month — what it should bring in (revenue, the P&L's
 * charges) and what it should earn (the P&L's NET profit, the only profit
 * that has a month; a truck's profit belongs to its departure, not to a
 * calendar). Either may be absent, and absent is «reja yo'q», never a $0 plan
 * that every month beats.
 */

export class TargetError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface MonthTarget {
  revenueUsd: number | null;
  netProfitUsd: number | null;
}

/** The audit log keys rows by uuid; a month is keyed by its date. */
const AUDIT_NS = '9b1f6a52-3c7e-4d0f-8a61-2e5b7c9d4f10';
const auditIdFor = (month: string) => uuidv5(`business_target:${month}`, AUDIT_NS);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const toNumber = (value: string | null) => (value === null ? null : Number(value));

/** Plans for these months ('YYYY-MM'), keyed the same way; a month with no row is absent. */
export async function targetsFor(months: string[]): Promise<Map<string, MonthTarget>> {
  const days = months.filter((month) => MONTH.test(month)).map((month) => `${month}-01`);
  if (days.length === 0) return new Map();
  const rows = await db.select().from(businessTargets).where(inArray(businessTargets.month, days));
  return new Map(
    rows.map((row) => [
      row.month.slice(0, 7),
      { revenueUsd: toNumber(row.revenueUsd), netProfitUsd: toNumber(row.netProfitUsd) },
    ]),
  );
}

/**
 * A figure typed on the form: empty = no plan, anything else must be a real
 * number. `Number('1 000')` is NaN and NaN answers false to every guard, so the
 * check is `Number.isFinite`, not a comparison (round 110).
 */
function figure(value: number | null | undefined, allowNegative: boolean): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) throw new TargetError('bad_number');
  if (!allowNegative && value < 0) throw new TargetError('negative');
  if (Math.abs(value) >= 1e12) throw new TargetError('too_large');
  return Math.round(value * 100) / 100;
}

/**
 * Set (or clear) one month's plan. Both figures empty removes the row, so a
 * cleared month reads «reja yo'q» again rather than keeping a husk.
 */
export async function setTarget(
  input: { month: string; revenueUsd?: number | null; netProfitUsd?: number | null },
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new TargetError('unauthenticated');
  if (!MONTH.test(input.month)) throw new TargetError('bad_month');
  const revenueUsd = figure(input.revenueUsd, false);
  const netProfitUsd = figure(input.netProfitUsd, true);
  const day = `${input.month}-01`;

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(businessTargets)
      .where(eq(businessTargets.month, day))
      .for('update');
    const beforeValues = before
      ? { revenueUsd: toNumber(before.revenueUsd), netProfitUsd: toNumber(before.netProfitUsd) }
      : null;
    const afterValues = { revenueUsd, netProfitUsd };
    if (
      beforeValues &&
      beforeValues.revenueUsd === revenueUsd &&
      beforeValues.netProfitUsd === netProfitUsd
    ) {
      return;
    }
    if (revenueUsd === null && netProfitUsd === null) {
      if (!before) return;
      await tx.delete(businessTargets).where(eq(businessTargets.month, day));
      await writeAudit(tx, ctx, {
        entityType: 'business_target',
        entityId: auditIdFor(input.month),
        action: 'delete',
        before: { month: input.month, ...beforeValues },
      });
      return;
    }
    await tx
      .insert(businessTargets)
      .values({
        month: day,
        revenueUsd: revenueUsd === null ? null : String(revenueUsd),
        netProfitUsd: netProfitUsd === null ? null : String(netProfitUsd),
        updatedBy: ctx.actorId!,
      })
      .onConflictDoUpdate({
        target: businessTargets.month,
        set: {
          revenueUsd: revenueUsd === null ? null : String(revenueUsd),
          netProfitUsd: netProfitUsd === null ? null : String(netProfitUsd),
          updatedBy: ctx.actorId!,
          updatedAt: new Date(),
        },
      });
    await writeAudit(tx, ctx, {
      entityType: 'business_target',
      entityId: auditIdFor(input.month),
      action: before ? 'update' : 'create',
      before: beforeValues ? { month: input.month, ...beforeValues } : null,
      after: { month: input.month, ...afterValues },
    });
  });
}
