'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  DealError,
  canWriteDeal,
  createDeal,
  deferPayment,
  dealLineSchema,
  dealSchema,
  dealStageSchema,
  deleteDealStage,
  linkReceipt,
  moveDeal,
  reorderDealStages,
  saveDealStage,
  saveLines,
  setDealDiscount,
  updateDeal,
} from '@/modules/wms/deals/service';
import { mayEditDealTerms } from '@/modules/wms/deals/door';
import { JOB_PROCESS_EVENTS, enqueue } from '@/modules/platform/jobs/boss';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';

export interface DealFormState {
  ok?: boolean;
  error?: string;
}

/**
 * Which half of a deal an action touches (the owner's 17a, 2026-10-07):
 *   - `'work'`  — the deal's POSITIONS (TNVED codes) and its PRIXOD links. Both
 *     sides of the business do this: the seller who quoted it and the VED who
 *     recalculated it, so it asks the deal-write list (`canWriteDeal`).
 *   - `'terms'` — opening a deal, its stage, its owner, its quote and its
 *     discount. That is the seller's, so it also asks `mayEditDealTerms` — the
 *     deal-write list minus `ved.docs`.
 *
 * REQUIRED and with no default, so a new action cannot inherit the wrong half
 * by silence (`tests/unit/deal-terms-wire.test.ts` classifies every export).
 * Checked here in the action rather than only in the page: a screen guard
 * decides what renders; an action guard decides what happens (#531).
 *
 * No new permission code was minted: one would reach existing roles only
 * through the seed, and since DECISIONS #170 the seed skips any role an admin
 * has edited — leaving the feature ungrantable on the owner's own database.
 */
type DealGate = 'terms' | 'work';

async function run(
  gate: DealGate,
  work: (ctx: { actorId: string }) => Promise<unknown>,
): Promise<DealFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'forbidden' };
  if (!canWriteDeal(actor.permissions)) return { error: 'forbidden' };
  if (gate === 'terms' && !mayEditDealTerms(actor.permissions)) {
    return { error: 'deal_terms_only' };
  }
  const meta = await requestMeta();
  try {
    await work({ actorId: actor.id, ...meta });
    // Phase 7: a stage move emits an event a rule may be waiting on — kick
    // the worker so the rule fires now, not on the minute sweep. Failure to
    // kick must never fail the save.
    enqueue(JOB_PROCESS_EVENTS, {}).catch(() => {});
    revalidatePath('/bitimlar', 'layout');
    return { ok: true };
  } catch (err) {
    if (err instanceof DealError) return { error: err.code };
    throw err;
  }
}


/** Numbers arrive from a form as strings; an empty box means "not answered". */
function optionalNumber(value: FormDataEntryValue | null): number | null | undefined {
  if (value === null) return undefined;
  const text = String(value).trim().replace(',', '.');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A typed PRICE (U28): «1,200» is a thousand two hundred — #979's shared
 * reader; the old one turned the comma into a decimal point and quoted $1.20
 * — and a figure nobody can read is REFUSED (NaN, which the schema refuses),
 * never taken as «not answered», which silently cleared the quote. Measures
 * (m³, kg, a count) keep `optionalNumber`: «12,345» m³ is a decimal there.
 */
function optionalMoney(value: FormDataEntryValue | null): number | null | undefined {
  if (value === null) return undefined;
  const text = String(value).trim();
  if (!text) return null;
  return parseTypedMoney(text) ?? Number.NaN;
}

function readDeal(form: FormData) {
  return dealSchema.safeParse({
    clientId: String(form.get('clientId') ?? ''),
    stageId: form.get('stageId') ? String(form.get('stageId')) : undefined,
    ownerId: form.get('ownerId') ? String(form.get('ownerId')) : null,
    title: String(form.get('title') ?? ''),
    quotedVolumeM3: optionalNumber(form.get('quotedVolumeM3')),
    quotedWeightKg: optionalNumber(form.get('quotedWeightKg')),
    quotedAmount: optionalMoney(form.get('quotedAmount')),
    quotedCurrency: form.get('quotedCurrency') ? String(form.get('quotedCurrency')) : null,
    note: String(form.get('note') ?? ''),
  });
}

export async function createDealAction(
  _prev: DealFormState,
  form: FormData,
): Promise<DealFormState> {
  const parsed = readDeal(form);
  if (!parsed.success) return { error: 'validation' };
  let id: string | null = null;
  const state = await run('terms', async (ctx) => {
    id = await createDeal(parsed.data, ctx);
  });
  // Straight to the card: a deal that was just created is a deal somebody is
  // about to price, and the list is one more tap in the way.
  if (state.ok && id) redirect(`/bitimlar/${id}`);
  return state;
}

export async function updateDealAction(
  id: string,
  _prev: DealFormState,
  form: FormData,
): Promise<DealFormState> {
  const parsed = readDeal(form);
  if (!parsed.success) return { error: 'validation' };
  return run('terms', (ctx) => updateDeal(id, parsed.data, ctx));
}

/**
 * Move several deals at once — one authorize, one revalidate, one rules kick.
 *
 * Every deal still goes through `moveDeal`, which is the only path that
 * audits and emits `DealStageChanged`; the cargo-trigger engine and the
 * phase-7 rules both listen to it. A row that refuses is counted, not fatal.
 */
export async function bulkMoveDealsAction(
  ids: string[],
  stageId: string,
  reason: string,
): Promise<{ ok?: boolean; done?: number; failed?: number; error?: string }> {
  if (ids.length === 0) return { ok: true, done: 0, failed: 0 };
  let done = 0;
  let failed = 0;
  let error: string | undefined;
  const outcome = await run('terms', async (ctx) => {
    for (const id of ids) {
      try {
        await moveDeal(id, stageId, ctx, reason);
        done += 1;
      } catch (err) {
        failed += 1;
        if (!error) error = err instanceof DealError ? err.code : 'failed';
      }
    }
  });
  if (outcome.error) return { error: outcome.error };
  return { ok: failed === 0, done, failed, ...(error ? { error } : {}) };
}

/** `beforeId`: see `moveLeadAction` — the drag's landing place, and only its. */
export async function moveDealAction(
  id: string,
  stageId: string,
  reason: string,
  beforeId?: string | null,
): Promise<DealFormState> {
  return run('terms', (ctx) =>
    moveDeal(id, stageId, ctx, reason, beforeId === undefined ? undefined : { beforeId }),
  );
}

/**
 * Reshaping the deal funnel is the same power as reshaping the lead funnel,
 * so it wears the same gate — `crm.manage`, not the deal-write list: working
 * a deal and redefining what the columns MEAN are different jobs.
 */
export async function saveDealStageAction(
  _prev: DealFormState,
  form: FormData,
): Promise<DealFormState> {
  const actor = await getActor();
  if (!actor?.permissions.has('crm.manage')) return { error: 'forbidden' };
  const parsed = dealStageSchema.safeParse({
    name: String(form.get('name') ?? ''),
    kind: String(form.get('kind') ?? '') || 'open',
    color: String(form.get('color') ?? '') || 'gray',
    sortOrder: Number(form.get('sortOrder')) || 100,
    active: form.getAll('active').at(-1) !== 'off',
    cargoTrigger: String(form.get('cargoTrigger') ?? '') || null,
  });
  if (!parsed.success) return { error: 'validation' };
  const id = String(form.get('id') ?? '') || undefined;
  const meta = await requestMeta();
  try {
    await saveDealStage({ ...parsed.data, id }, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof DealError) return { error: err.code };
    throw err;
  }
  revalidatePath('/bitimlar', 'layout');
  return { ok: true };
}

/** The editor's other two moves (round 30), same `crm.manage` gate. */
export async function reorderDealStagesAction(ids: string[]): Promise<DealFormState> {
  const actor = await getActor();
  if (!actor?.permissions.has('crm.manage')) return { error: 'forbidden' };
  const meta = await requestMeta();
  try {
    await reorderDealStages(ids, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof DealError) return { error: err.code };
    throw err;
  }
  revalidatePath('/bitimlar', 'layout');
  return { ok: true };
}

export async function deleteDealStageAction(
  id: string,
  moveToId: string,
): Promise<DealFormState> {
  const actor = await getActor();
  if (!actor?.permissions.has('crm.manage')) return { error: 'forbidden' };
  const meta = await requestMeta();
  try {
    await deleteDealStage(id, moveToId, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof DealError) return { error: err.code };
    throw err;
  }
  revalidatePath('/bitimlar', 'layout');
  return { ok: true };
}

export async function saveLinesAction(
  dealId: string,
  _prev: DealFormState,
  form: FormData,
): Promise<DealFormState> {
  // The form posts parallel arrays, one entry per row; a row with no
  // description is an empty row the person did not fill in.
  const descriptions = form.getAll('lineDescription').map(String);
  const lines = descriptions
    .map((description, i) => ({
      description: description.trim(),
      tnvedCode: String(form.getAll('lineTnved')[i] ?? '').trim() || null,
      quantity: optionalNumber(form.getAll('lineQuantity')[i] ?? null) ?? null,
      unit: String(form.getAll('lineUnit')[i] ?? '').trim() || null,
      quotedVolumeM3: optionalNumber(form.getAll('lineVolume')[i] ?? null) ?? null,
      quotedWeightKg: optionalNumber(form.getAll('lineWeight')[i] ?? null) ?? null,
      quotedAmount: optionalMoney(form.getAll('lineAmount')[i] ?? null) ?? null,
      note: null,
    }))
    .filter((line) => line.description.length > 0);

  const parsed = dealLineSchema.array().safeParse(lines);
  if (!parsed.success) return { error: 'validation' };
  return run('work', (ctx) => saveLines(dealId, parsed.data, ctx));
}

/**
 * Damage → a discount ON THE DEAL (DEALS.md answer 3), gated like re-pricing
 * rather than like posting money: it changes what this job SHOULD cost. Since
 * 17a that number is the deal's TERMS and so the seller's — the VED works the
 * positions and the prixods, not the price (his own discount door is the
 * seal's, inside the calc workspace, and is untouched). Actually collecting
 * less still runs through finance and its own gate.
 */
export async function setDiscountAction(
  dealId: string,
  _prev: DealFormState,
  form: FormData,
): Promise<DealFormState> {
  const amount = optionalMoney(form.get('amount'));
  // NaN answers false to `< 0`, so an unreadable figure is refused by name.
  if (amount === undefined || amount === null || !Number.isFinite(amount) || amount < 0) {
    return { error: 'validation' };
  }
  return run('terms', (ctx) =>
    setDealDiscount(dealId, { amount, reason: String(form.get('reason') ?? '') }, ctx),
  );
}

export async function linkReceiptAction(
  receiptId: string,
  dealId: string | null,
): Promise<DealFormState> {
  // G1 a: the VED keeps ALL prixod linking — link, move, detach — and
  // `linkReceipt` audits each one under the presser's name.
  const state = await run('work', (ctx) => linkReceipt(receiptId, dealId, ctx));
  revalidatePath(`/receipts/${receiptId}`);
  return state;
}

/*
 * `chargeDealAction` lived here from phase 5 to round 100. The owner closed
 * the door — «sotuvchi narx qoyib qoyadi, buni adminga qoldir … yop bitimdan
 * yop buni» — so charging happens on the ledger (/finance/<client>, whose
 * deal picker covers open AND recently-decided deals) and on batch pricing.
 * Deleted, not hidden: a control removed from a screen while the action
 * still accepts posts is hidden, not removed (round 70's rule).
 */

export async function deferPaymentAction(
  dealId: string,
  _prev: DealFormState,
  form: FormData,
): Promise<DealFormState> {
  // Deliberately a different gate: granting a client more time to pay is a
  // money decision, and `finance.debt_override` already means exactly this
  // (DEALS.md answer 4). Reusing it keeps one answer to "who may let a debt
  // slide" rather than two that drift apart. WHOSE client it may be is the
  // service's question since 0114 (`mayGrantDebt`), asked with this actor.
  const actor = await getActor();
  if (!actor?.permissions.has('finance.debt_override')) return { error: 'forbidden' };
  const untilAllArrived = form.get('until') === 'all_arrived';
  return run('work', (ctx) =>
    deferPayment(
      dealId,
      {
        reason: String(form.get('reason') ?? ''),
        untilAllArrived,
        untilDate: untilAllArrived ? null : String(form.get('untilDate') ?? '') || null,
      },
      ctx,
      actor,
    ),
  );
}
