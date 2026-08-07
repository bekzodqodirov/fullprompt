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
import { FinanceError, addTransaction } from '@/modules/wms/finance/service';
import { JOB_PROCESS_EVENTS, enqueue } from '@/modules/platform/jobs/boss';

export interface DealFormState {
  ok?: boolean;
  error?: string;
}

/**
 * Both sides of the business work a deal — the sales manager who quoted it and
 * the VED manager who recalculated it (DEALS.md answer 2) — so the gate is a
 * LIST of codes rather than one, and it is checked here in the action rather
 * than only in the page. A screen guard decides what renders; an action guard
 * decides what happens.
 *
 * No new permission code was minted: one would reach existing roles only
 * through the seed, and since DECISIONS #170 the seed skips any role an admin
 * has edited — leaving the feature ungrantable on the owner's own database.
 */
async function run(work: (ctx: { actorId: string }) => Promise<unknown>): Promise<DealFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'forbidden' };
  if (!canWriteDeal(actor.permissions)) return { error: 'forbidden' };
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

function readDeal(form: FormData) {
  return dealSchema.safeParse({
    clientId: String(form.get('clientId') ?? ''),
    stageId: form.get('stageId') ? String(form.get('stageId')) : undefined,
    ownerId: form.get('ownerId') ? String(form.get('ownerId')) : null,
    title: String(form.get('title') ?? ''),
    quotedVolumeM3: optionalNumber(form.get('quotedVolumeM3')),
    quotedWeightKg: optionalNumber(form.get('quotedWeightKg')),
    quotedAmount: optionalNumber(form.get('quotedAmount')),
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
  const state = await run(async (ctx) => {
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
  return run((ctx) => updateDeal(id, parsed.data, ctx));
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
  const outcome = await run(async (ctx) => {
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

export async function moveDealAction(
  id: string,
  stageId: string,
  reason: string,
): Promise<DealFormState> {
  return run((ctx) => moveDeal(id, stageId, ctx, reason));
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
      quotedAmount: optionalNumber(form.getAll('lineAmount')[i] ?? null) ?? null,
      note: null,
    }))
    .filter((line) => line.description.length > 0);

  const parsed = dealLineSchema.array().safeParse(lines);
  if (!parsed.success) return { error: 'validation' };
  return run((ctx) => saveLines(dealId, parsed.data, ctx));
}

/**
 * Damage → a discount ON THE DEAL (DEALS.md answer 3), gated like re-pricing
 * rather than like posting money: it changes what this job SHOULD cost, and
 * both sides of the business that set that number (sales, VED) may record it.
 * Actually collecting less still runs through finance and its own gate.
 */
export async function setDiscountAction(
  dealId: string,
  _prev: DealFormState,
  form: FormData,
): Promise<DealFormState> {
  const amount = optionalNumber(form.get('amount'));
  if (amount === undefined || amount === null || amount < 0) return { error: 'validation' };
  return run((ctx) =>
    setDealDiscount(dealId, { amount, reason: String(form.get('reason') ?? '') }, ctx),
  );
}

export async function linkReceiptAction(
  receiptId: string,
  dealId: string | null,
): Promise<DealFormState> {
  const state = await run((ctx) => linkReceipt(receiptId, dealId, ctx));
  revalidatePath(`/receipts/${receiptId}`);
  return state;
}

/**
 * Post the agreed price of this job to the client's account.
 *
 * The deal is where the number was negotiated, so this is where it should be
 * raised — and only a charge that carries its deal can ever be covered by that
 * deal's payment deferral. A charge posted from batch pricing has no deal and
 * keeps blocking the handover exactly as it should.
 *
 * Gated on `finance.manage`, not on the deal-write list: agreeing a price and
 * putting money on a client's account are different powers, and the second one
 * already has a permission that means exactly this.
 */
export async function chargeDealAction(
  dealId: string,
  clientId: string,
  _prev: DealFormState,
  form: FormData,
): Promise<DealFormState> {
  const actor = await getActor();
  if (!actor?.permissions.has('finance.manage')) return { error: 'forbidden' };
  const amount = optionalNumber(form.get('amount'));
  if (!amount || amount <= 0) return { error: 'validation' };
  const meta = await requestMeta();
  try {
    await addTransaction(
      {
        clientId,
        dealId,
        type: 'charge',
        amount,
        currency: String(form.get('currency') ?? 'USD'),
        txDate: new Date().toISOString().slice(0, 10),
        note: String(form.get('note') ?? ''),
      },
      { actorId: actor.id, ...meta },
    );
  } catch (err) {
    if (err instanceof FinanceError) return { error: err.code };
    throw err;
  }
  revalidatePath(`/bitimlar/${dealId}`);
  revalidatePath(`/finance/${clientId}`);
  return { ok: true };
}

export async function deferPaymentAction(
  dealId: string,
  _prev: DealFormState,
  form: FormData,
): Promise<DealFormState> {
  // Deliberately a different gate: granting a client more time to pay is a
  // money decision, and `finance.debt_override` already means exactly this
  // (DEALS.md answer 4). Reusing it keeps one answer to "who may let a debt
  // slide" rather than two that drift apart.
  const actor = await getActor();
  if (!actor?.permissions.has('finance.debt_override')) return { error: 'forbidden' };
  const untilAllArrived = form.get('until') === 'all_arrived';
  return run((ctx) =>
    deferPayment(
      dealId,
      {
        reason: String(form.get('reason') ?? ''),
        untilAllArrived,
        untilDate: untilAllArrived ? null : String(form.get('untilDate') ?? '') || null,
      },
      ctx,
    ),
  );
}
