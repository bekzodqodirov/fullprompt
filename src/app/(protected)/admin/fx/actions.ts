'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize, type Actor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_RECOMPUTE_COSTS } from '@/modules/platform/jobs/boss';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { fxRates } from '@/modules/platform/db/schema';
import { fxRateSchema, unplacedCostSince } from '@/modules/wms/costing/service';
import {
  ConfirmNeeded,
  repriceStale,
  RepriceError,
  saveFxRate,
  type RepricePlan,
} from '@/modules/wms/costing/fx-reprice';
import { isRateJump, perUsd, toRateToUsd } from '@/modules/wms/costing/fx-display';
import { logger } from '@/modules/platform/logger';

/** What the preview card draws — months only for law 4's audience (`finance.reports`). */
export type PlanView = Omit<RepricePlan, 'months'> & { months: RepricePlan['months'] | null };

export interface FxFormState {
  ok?: boolean;
  error?: string;
  /** On `rate_jump`: the standing rate, as «1 USD = N», for the question. */
  previous?: number;
  /** On `confirm_reprice`: what the save would move (Q18) — the confirm posts its hash. */
  plan?: PlanView;
  planHash?: string;
  /** The plan the person confirmed is not the one standing now. */
  changed?: boolean;
  /** After a save that moved something: how many rows were re-priced. */
  repriced?: number;
}

function toView(plan: RepricePlan, actor: Actor): PlanView {
  return { ...plan, months: actor.permissions.has('finance.reports') ? plan.months : null };
}

const count = (plan: RepricePlan) =>
  plan.costs.length +
  plan.kassaCosts.length +
  plan.costCharges.length +
  plan.manualCharges.length +
  plan.expenses.length +
  plan.expenseCharges.length +
  plan.clientCharges.length;

/** After the commit: the re-split of the re-priced costs and the screens that read them. */
async function afterReprice(plan: RepricePlan) {
  const costEntryIds = [...plan.costs, ...plan.kassaCosts].map((change) => change.id);
  if (costEntryIds.length) await enqueue(JOB_RECOMPUTE_COSTS, { costEntryIds });
  for (const path of ['/admin/fx', '/accounting', '/accounting/pnl', '/accounting/cashflow', '/finance', '/kontragentlar']) {
    revalidatePath(path);
  }
}

export async function saveFxRateAction(
  _prev: FxFormState,
  formData: FormData,
): Promise<FxFormState> {
  // The form asks the question the way people say it — "1 USD = how many
  // so'm" — and this is where it becomes the rate_to_usd the engine stores.
  const quoted = Number(String(formData.get('unitsPerUsd') ?? '').replace(/\s/g, '').replace(',', '.'));
  const rateToUsd = toRateToUsd(quoted);
  if (rateToUsd === null) return { error: 'validation' };
  const parsed = fxRateSchema.safeParse({
    currency: formData.get('currency'),
    rateToUsd,
    effectiveDate: formData.get('effectiveDate'),
  });
  if (!parsed.success) return { error: 'validation' };
  if (parsed.data.currency === 'USD') return { error: 'usd_is_base' };

  let actor;
  try {
    actor = await authorize('costs.fx.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  // A rate a fifth away from the currency's own last one is asked about, and
  // saved only once the person has said yes (audit A1). Asked here and not
  // only in the browser: the rate prices every new cost in its currency.
  const [standing] = await db
    .select({ rateToUsd: fxRates.rateToUsd })
    .from(fxRates)
    .where(eq(fxRates.currency, parsed.data.currency))
    .orderBy(desc(fxRates.effectiveDate))
    .limit(1);
  const previous = standing ? perUsd(Number(standing.rateToUsd)) : null;
  if (formData.get('confirmJump') !== '1' && isRateJump(previous, quoted)) {
    return { error: 'rate_jump', previous: previous ?? undefined };
  }

  // Q18: the save re-prices the DEBTS this rate governs and never a payment —
  // shown first, applied on the confirm of THIS plan (its hash).
  const planHash = String(formData.get('planHash') ?? '') || null;
  const since = await unplacedCostSince(); // on the pool, before the transaction (#714)
  let plan: RepricePlan;
  try {
    plan = await saveFxRate(parsed.data, { actorId: actor.id, ...meta }, { planHash, since });
  } catch (err) {
    if (err instanceof ConfirmNeeded) {
      return { error: 'confirm_reprice', plan: toView(err.plan, actor), planHash: err.plan.hash, changed: planHash !== null };
    }
    if (err instanceof RepriceError) return { error: err.code === 'busy' ? 'busy' : 'server' };
    logger.error({ err }, '[fx] rate save failed');
    return { error: 'server' };
  }
  // A rate converts the costs that were WAITING for it (R1); the re-price
  // above is the only thing that moves a converted one, and only a debt.
  await enqueue(JOB_RECOMPUTE_COSTS, { currency: parsed.data.currency, unconverted: true });
  await afterReprice(plan);
  return { ok: true, repriced: count(plan) };
}

/**
 * «Ko'rib chiqish» on a stale month (§6.6): the same plan over ONE month of
 * one currency, with no rate written — the first press shows it, the second
 * (carrying its hash) applies it.
 */
export async function repriceStaleAction(
  _prev: FxFormState,
  formData: FormData,
): Promise<FxFormState> {
  const currency = String(formData.get('currency') ?? '').toUpperCase();
  const month = String(formData.get('month') ?? '');
  if (!/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}$/.test(month)) return { error: 'validation' };
  let actor;
  try {
    actor = await authorize('costs.fx.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const planHash = String(formData.get('planHash') ?? '') || null;
  const since = await unplacedCostSince();
  let plan: RepricePlan;
  try {
    plan = await repriceStale(currency, month, { actorId: actor.id, ...(await requestMeta()) }, { planHash, since });
  } catch (err) {
    if (err instanceof ConfirmNeeded) {
      return { error: 'confirm_reprice', plan: toView(err.plan, actor), planHash: err.plan.hash, changed: planHash !== null };
    }
    if (err instanceof RepriceError) return { error: err.code === 'busy' ? 'busy' : 'server' };
    logger.error({ err }, '[fx] stale re-price failed');
    return { error: 'server' };
  }
  await afterReprice(plan);
  return { ok: true, repriced: count(plan) };
}
