import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { withoutJit } from '../../platform/db/no-jit';
import { getSetting } from '../../platform/settings/service';
import { tashkentDay } from '../../platform/time/tashkent';
import { rateFor } from '../costing/service';
import { upsaleScopeFor } from '../calc/upsale-scope';
import { earnedOf, upsaleRows } from '../calc/upsale-service';
import { stampedCargoByMonth } from './cargo';
import { kpiFor, earnedOnPaid, type KpiRefusal } from './kpi-engine';
import { kpiVersions, versionFor } from './kpi-table';
import { paidM3ByMonth } from './kpi-paid';
import { monthRange } from './month';
import { staffTemplates, type SalaryState } from './salary';

/**
 * «Bu oy» on the profile (0117, his 9 and 10a): the SESSION user's own month
 * and nothing else — «a seller sees their own salary and KPI in dollars, only
 * their own».
 *
 * The loader takes the ACTOR and no id: there is no parameter a URL or a
 * forged post could fill with a colleague's id (round 91 / #790's shape —
 * `my-month-shape.test.ts` pins it). And the shape carries AGGREGATES only —
 * no client id, no client name, no balance: a seller already reads their
 * clients elsewhere, and this panel must not become a second door to them.
 *
 * Three clocks, each named on the screen: the salary is the template's month,
 * the KPI is the cargo's RECEIPT month (Tashkent), the upsale is the offer's
 * day. The KPI is «taxminiy» until the month closes on the 8th — the band can
 * still move.
 */

export interface MyMonth {
  /** `YYYY-MM`, Tashkent. */
  month: string;
  salary: { amount: number; currency: string; dayOfMonth: number; state: SalaryState }[];
  /** The salary in dollars at today's rate; null when a currency has no rate yet. */
  salaryUsd: number | null;
  /** Some salary line is not in dollars — the line says it was converted. */
  salaryConverted: boolean;
  kpi: {
    m3: number;
    kg: number;
    density: number | null;
    rate: number | null;
    /** On all of the month's cargo — the figure the month is heading for. */
    earnedUsd: number | null;
    /** Of it, on the cargo already paid for; null when the read ran out of time. */
    earnedPaidUsd: number | null;
    refusal: KpiRefusal | null;
    /** Before his table's first version — outside KPI. */
    outside: boolean;
  } | null;
  upsale: { earnedUsd: number; offers: number } | null;
  /** oylik + KPI (hisoblangan) + upsale, in dollars; null when the salary could not be converted. */
  incomeUsd: number | null;
  work: { receipts: number; sealed: number; answered: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function myMonth(actor: {
  id: string;
  permissions: { has(code: string): boolean };
}): Promise<MyMonth> {
  const userId = actor.id;
  const today = tashkentDay();
  const month = today.slice(0, 7);
  const range = monthRange(month);
  const salaryCategoryId = String((await getSetting('salary_expense_category_id')) ?? '').trim();

  const [templates, cargo, versions, work] = await Promise.all([
    staffTemplates(db, { month, salaryCategoryId, userId }),
    stampedCargoByMonth(db, userId, month, month),
    kpiVersions(db),
    myWork(userId, range),
  ]);

  const salary = templates
    .filter((t) => t.salary)
    .map((t) => ({ amount: Number(t.amount), currency: t.currency, dayOfMonth: t.dayOfMonth, state: t.state }));
  let salaryUsd: number | null = 0;
  for (const line of salary) {
    const rate = await rateFor(line.currency, today);
    if (rate === null) {
      salaryUsd = null;
      break;
    }
    salaryUsd += line.amount * rate;
  }
  if (salaryUsd !== null) salaryUsd = round2(salaryUsd);

  let kpi: MyMonth['kpi'] = null;
  const line = cargo[0];
  if (line) {
    const version = versionFor(versions, month);
    const result = kpiFor(version?.cells ?? null, line);
    // The paid part is the heavy read (every covering price of every client
    // behind the cargo): budgeted, because /profile is the logout door and a
    // slow panel must never hold it (#472's morning).
    let paidM3: number | null = null;
    try {
      const paid = await withoutJit((exec) => paidM3ByMonth(exec, { sellerId: userId, ...range }), { timeoutMs: 4000 });
      paidM3 = paid.get(userId)?.get(month) ?? 0;
    } catch (err) {
      console.error('[my-month] paid read', err);
    }
    kpi = {
      m3: line.m3,
      kg: line.kg,
      density: result.ok ? result.density : null,
      rate: result.ok ? result.rate : null,
      earnedUsd: result.ok && version ? result.earnedUsd : null,
      earnedPaidUsd: result.ok && version && paidM3 !== null ? earnedOnPaid(paidM3, result.rate) : null,
      refusal: result.ok ? null : result.reason,
      outside: version === null,
    };
  }

  let upsale: MyMonth['upsale'] = null;
  if (upsaleScopeFor(actor) !== 'none') {
    const { rows } = await upsaleRows('own', userId, { from: `${month}-01`, to: today });
    upsale = { earnedUsd: round2(rows.reduce((sum, row) => sum + earnedOf(row), 0)), offers: rows.length };
  }

  const incomeUsd =
    salaryUsd === null ? null : round2(salaryUsd + (kpi?.earnedUsd ?? 0) + (upsale?.earnedUsd ?? 0));

  return {
    month,
    salary,
    salaryUsd,
    salaryConverted: salary.some((s) => s.currency !== 'USD'),
    kpi,
    upsale,
    incomeUsd,
    work,
  };
}

/**
 * The person's own work this month (his 7a — «warehouse: prixods received;
 * VED: calculations done»). A prixod counts for whoever physically RECEIVED
 * it: the named colleague on an office-entered receipt, else the presser —
 * and a receipt received by a typed name (somebody with no login) is nobody's
 * here, never the office clerk's who typed it.
 */
async function myWork(userId: string, range: { from: Date; to: Date }): Promise<MyMonth['work']> {
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const [row] = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM receipts r
        WHERE r.status = 'confirmed'
          AND coalesce(r.received_by_user_id, CASE WHEN r.received_by_name IS NULL THEN r.confirmed_by END) = ${userId}::uuid
          AND r.received_at >= ${from}::timestamptz AND r.received_at < ${to}::timestamptz) AS receipts,
      (SELECT count(*)::int FROM calc_versions v
        WHERE v.sealed_by = ${userId}::uuid
          AND v.sealed_at >= ${from}::timestamptz AND v.sealed_at < ${to}::timestamptz) AS sealed,
      (SELECT count(*)::int FROM calc_requests q
        WHERE q.completed_by = ${userId}::uuid AND q.completed_via = 'task' AND q.answer_amount IS NOT NULL
          AND q.completed_at >= ${from}::timestamptz AND q.completed_at < ${to}::timestamptz) AS answered`)) as unknown as {
    receipts: number;
    sealed: number;
    answered: number;
  }[];
  return { receipts: Number(row?.receipts ?? 0), sealed: Number(row?.sealed ?? 0), answered: Number(row?.answered ?? 0) };
}
