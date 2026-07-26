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
  linkReceipt,
  moveDeal,
  saveLines,
  updateDeal,
} from '@/modules/wms/deals/service';
import { FinanceError, addTransaction } from '@/modules/wms/finance/service';

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

export async function moveDealAction(
  id: string,
  stageId: string,
  reason: string,
): Promise<DealFormState> {
  return run((ctx) => moveDeal(id, stageId, ctx, reason));
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
