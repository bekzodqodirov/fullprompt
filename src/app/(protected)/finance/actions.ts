'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { moneyAccounts } from '@/modules/platform/db/schema';
import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  FinanceError,
  addTransaction,
  moveCharge,
  moveChargeSchema,
  placePayment,
  transactionSchema,
  voidTransaction,
} from '@/modules/wms/finance/service';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { amountRefusal } from '@/modules/wms/finance/money-bounds';
import { mayClassifyFx } from '@/modules/wms/finance/fx-door';
import { closeCrossCurrencyResidue, FxCloseError, voidFxClose } from '@/modules/wms/finance/fx-close';
import { addCompensation, CompensationError } from '@/modules/wms/finance/compensation';
import { isClientPayout } from '@/modules/wms/finance/ledger-kinds';

export interface TxFormState {
  ok?: boolean;
  error?: string;
}

export async function addTransactionAction(
  _prev: TxFormState,
  formData: FormData,
): Promise<TxFormState> {
  const parsed = transactionSchema.safeParse({
    clientId: formData.get('clientId'),
    type: formData.get('type'),
    // «1,200» is a thousand two hundred, not $1.20, and «1 200» is not NaN —
    // the calc screen's reader, now at every price and payment door (the
    // truck pricing form posts here).
    amount: parseTypedMoney(String(formData.get('amount') ?? '')) ?? Number.NaN,
    currency: formData.get('currency'),
    method: formData.get('method') || undefined,
    txDate: formData.get('txDate'),
    batchId: formData.get('batchId') || undefined,
    // The deal this money answers, when the accountant said. Load-bearing for
    // deferrals: the #251 netting joins payments to the deferred deal BY THIS
    // COLUMN, and until the form could send it, no payment ever carried one —
    // so a paid-off deferral went on excusing unrelated debt at the handover
    // gate, exactly what #251 was written to stop.
    dealId: formData.get('dealId') || undefined,
    accountId: formData.get('accountId') || undefined,
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) return { error: amountRefusal(parsed.error) ?? 'validation' };

  // Who is asking comes FIRST: a refusal about the kassa must never be the
  // first thing a person who may not name one reads (Q19 review).
  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  // Handing cash back opens a till, and tills are the accountant's and the
  // admin's (`finance.expenses`, the kassa screens' own door) — the VED holds
  // finance.manage and prices jobs, but does not pay money out of a drawer.
  // The one predicate the void below asks too (U33, #513).
  if (isClientPayout(parsed.data.type) && !mayPickTill(actor.permissions)) {
    return { error: 'forbidden' };
  }
  // The kassa is named by its holders (owner's Q19: «VED kassani umuman
  // ko'rmasin»; his Q6: the person responsible for the drawer). A non-holder
  // — the VED — still records the client's payment, and it lands UNPLACED:
  // the accountant names the box through «Kassaga joylash», the queue that
  // exists for exactly this state (`unplacedPaymentSql` — her home counter,
  // the Balans line, the register's view). A kassa posted by a non-holder is
  // a forged post: the form never draws the picker for him.
  if (!mayPickTill(actor.permissions) && parsed.data.accountId) return { error: 'forbidden' };
  // …and only in money a kassa can hold: the register's «Joylash» lists the
  // tills of the row's currency, so a VED payment in a currency with no
  // active till was unplaceable for ever and sat on the Balans line and the
  // accountant's counter with no door out (review of the VED unit). A holder
  // cannot reach that state at all — her payment must name a till of its own
  // currency.
  if (!mayPickTill(actor.permissions) && parsed.data.type === 'payment') {
    const [till] = await db
      .select({ id: moneyAccounts.id })
      .from(moneyAccounts)
      .where(and(eq(moneyAccounts.currency, parsed.data.currency), eq(moneyAccounts.active, true)))
      .limit(1);
    if (!till) return { error: 'no_till_currency' };
  }
  if (mayPickTill(actor.permissions)) {
    // A HOLDER's payment names the cash box it landed in (audit A2). One
    // saved with none took its amount off the Balans receivable and put it
    // in no kassa, so the net fell by the payment while the cash flow said it
    // came in. The rule lives at this door, the only one that takes a typed
    // payment: rows entered before cash boxes existed have none, and the
    // service still reads them (#171's history rule).
    if (parsed.data.type === 'payment' && !parsed.data.accountId) return { error: 'account_required' };
    // A refund is money LEAVING a kassa (R6a) — the same door as every other
    // kassa outflow, and never a row without the box it left.
    if (parsed.data.type === 'refund' && !parsed.data.accountId) return { error: 'account_required' };
  }
  const meta = await requestMeta();
  let row;
  try {
    row = await addTransaction(parsed.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof FinanceError) return { error: err.code };
    throw err;
  }
  revalidatePath('/finance');
  revalidatePath(`/finance/${parsed.data.clientId}`);
  if (parsed.data.batchId) revalidatePath(`/batches/${parsed.data.batchId}/pricing`);
  // A truck price can land on a deal the form never named (R3a) — the deal
  // card's money is what it now says.
  if (row.dealId) revalidatePath(`/bitimlar/${row.dealId}`);
  return { ok: true };
}

/**
 * «Yo'qolgan yuk: narx va kompensatsiya» (0105, owner's Q15). Money given to
 * a client is the kassa holders' act — the refund's own pair — asked in
 * order: the grant, then the kassa predicate, then the service with the same
 * answer as its REQUIRED door. A separate action from the ledger form's: it
 * names a prixod and may lower prices in the same press, and it returns its
 * answer instead of resetting the form, so a refusal keeps every typed figure.
 * The typed amounts are read like every money door's («1 200», «1,200»).
 */
export async function addCompensationAction(input: {
  clientId: string;
  receiptId: string;
  amount: string;
  currency: string;
  txDate: string;
  note: string;
  reprices: { chargeId: string; newAmount: string }[];
}): Promise<{ ok: boolean; error?: string }> {
  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  if (!mayPickTill(actor.permissions)) return { ok: false, error: 'forbidden' };
  const typed = String(input?.amount ?? '').trim();
  const amount = typed ? parseTypedMoney(typed) : undefined;
  if (typed && (amount === null || amount === undefined)) return { ok: false, error: 'validation' };
  const reprices: { chargeId: string; newAmount: number }[] = [];
  for (const change of Array.isArray(input?.reprices) ? input.reprices : []) {
    const text = String(change?.newAmount ?? '').trim();
    // An empty box is «leave this price», never «make it 0».
    if (!text) continue;
    const value = text === '0' ? 0 : parseTypedMoney(text);
    if (value === null || value === undefined) return { ok: false, error: 'validation' };
    reprices.push({ chargeId: String(change.chargeId), newAmount: value });
  }
  const meta = await requestMeta();
  let result;
  try {
    result = await addCompensation(
      {
        clientId: String(input?.clientId ?? ''),
        receiptId: String(input?.receiptId ?? ''),
        amount: amount ?? undefined,
        currency: String(input?.currency ?? 'USD'),
        txDate: String(input?.txDate ?? ''),
        note: String(input?.note ?? ''),
        reprices,
      },
      { actorId: actor.id, ...meta },
      { mayPayClient: mayPickTill(actor.permissions) },
    );
  } catch (err) {
    if (err instanceof CompensationError) return { ok: false, error: err.code };
    throw err;
  }
  revalidatePath('/finance');
  revalidatePath(`/finance/${input.clientId}`);
  if (result.dealId) revalidatePath(`/bitimlar/${result.dealId}`);
  for (const batchId of result.batchIds) revalidatePath(`/batches/${batchId}/pricing`);
  return { ok: true };
}

const voidSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  reason: z.string().trim().min(2).max(500),
});

export async function voidTransactionAction(formData: FormData): Promise<TxFormState> {
  const parsed = voidSchema.safeParse({
    id: formData.get('id'),
    clientId: formData.get('clientId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { error: 'validation' };
  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    // A void that puts money back into a drawer or takes it out (a placed
    // payment, a refund) is a kassa movement (U33, Q19): the service judges
    // the ROW, inside its own UPDATE, against the grant that moves tills.
    await voidTransaction(
      parsed.data.id,
      parsed.data.reason,
      { actorId: actor.id, ...meta },
      { mayMoveTill: mayPickTill(actor.permissions) },
    );
  } catch (err) {
    // Said in words on the button (#420) — it used to be swallowed, and a
    // refused ✖ looked exactly like one that worked until the page reloaded.
    if (err instanceof FinanceError) return { error: err.code };
    throw err;
  }
  revalidatePath('/finance');
  revalidatePath(`/finance/${parsed.data.clientId}`);
  return { ok: true };
}

/**
 * «🚚 Ko'chirish» (0104) — see `moveCharge`. It admits exactly who
 * `addTransactionAction` admits for a CHARGE, the same `authorize` call and
 * nothing else: the two doors write the same kind of row and must never
 * disagree about who may (a charge needs no kassa, so no till clause either).
 * The amounts arrive as typed text and go through the price door's reader.
 */
export async function moveChargeAction(input: {
  txId: string;
  clientId: string;
  parts: { batchId: string; amount: string }[];
}): Promise<TxFormState> {
  const parsed = moveChargeSchema.safeParse({
    txId: input.txId,
    parts: input.parts.map((part) => ({
      batchId: part.batchId,
      amount: parseTypedMoney(part.amount) ?? Number.NaN,
    })),
  });
  if (!parsed.success) return { error: amountRefusal(parsed.error) ?? 'validation' };
  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await moveCharge(parsed.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof FinanceError) return { error: err.code };
    throw err;
  }
  revalidatePath('/finance');
  revalidatePath('/finance/narxsiz');
  revalidatePath(`/finance/${input.clientId}`);
  for (const part of parsed.data.parts) revalidatePath(`/batches/${part.batchId}/pricing`);
  revalidatePath('/batches/[id]/pricing', 'page');
  return { ok: true };
}

/** The register's «kassaga joylash» — see `placePayment` (audit A2). */
export async function placePaymentAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  const accountId = z.string().uuid().safeParse(formData.get('accountId'));
  if (!id.success || !accountId.success) return;
  const actor = await authorize('finance.manage');
  // Naming the drawer the money landed in is the kassa holders' act (Q19) —
  // the register offers the form to nobody else, and this refuses a post.
  if (!mayPickTill(actor.permissions)) return;
  const meta = await requestMeta();
  try {
    await placePayment(id.data, accountId.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof FinanceError) return;
    throw err;
  }
  revalidatePath('/finance/reestr');
  revalidatePath('/accounting/balance');
  revalidatePath('/accounting');
}

const fxCloseSchema = z.object({ clientId: z.string().uuid() });

/**
 * «Kurs farqi bilan yopish» (Q24 b): the accountant and the admin only
 * (`mayClassifyFx` — a kurs farqi row moves the P&L, and the VED holds
 * finance.manage without the P&L), every admission re-derived by the service.
 */
export async function closeFxResidueAction(input: unknown): Promise<TxFormState> {
  const parsed = fxCloseSchema.safeParse(input);
  if (!parsed.success) return { error: 'validation' };
  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  try {
    await closeCrossCurrencyResidue(
      parsed.data.clientId,
      { actorId: actor.id, ...(await requestMeta()) },
      { mayClassify: mayClassifyFx(actor.permissions) },
    );
  } catch (err) {
    if (err instanceof FxCloseError) return { error: err.code };
    throw err;
  }
  revalidatePath('/finance');
  revalidatePath(`/finance/${parsed.data.clientId}`);
  revalidatePath('/accounting/pnl');
  return { ok: true };
}

const fxUndoSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  reason: z.string().trim().min(2).max(500),
});

/** The hand close's own undo (the ledger's void refuses every kurs farqi row). */
export async function voidFxCloseAction(input: unknown): Promise<TxFormState> {
  const parsed = fxUndoSchema.safeParse(input);
  if (!parsed.success) return { error: 'validation' };
  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  try {
    await voidFxClose(
      parsed.data.id,
      parsed.data.reason,
      { actorId: actor.id, ...(await requestMeta()) },
      { mayClassify: mayClassifyFx(actor.permissions) },
    );
  } catch (err) {
    if (err instanceof FxCloseError) return { error: err.code };
    throw err;
  }
  revalidatePath('/finance');
  revalidatePath(`/finance/${parsed.data.clientId}`);
  revalidatePath('/accounting/pnl');
  return { ok: true };
}
