import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  attachments,
  clients,
  clientTransactions,
  deals,
  partners,
  partnerTransactions,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { rateFor } from '../costing/service';
import { latestTxDate } from '../finance/dates';
import { exceedsRowUsd, nativeAmount } from '../finance/money-bounds';
import { PartnerError } from './service';

/**
 * Uch tomonlama hisob — the three-cornered settlement.
 *
 * The owner's case, and it is the one that cannot be faked with two separate
 * entries: a client pays their debt to US into our transport company's
 * account in China. Nothing enters a cash box of ours, yet two balances move
 * — the client owes us less, and we owe the firm less.
 *
 * THE TWO SIDES ARE NOT THE SAME NUMBER. His words: the client sends $100 and
 * the firm then says at what rate it counted the money and how much of our
 * debt it closed. So each side is recorded in its own amount and its own
 * currency, and the difference between them (in USD) is reported rather than
 * hidden by averaging — a settlement that silently invented a rate would be
 * worse than no feature.
 *
 * Proof is mandatory (his answer 2): a file, or a written note. One or the
 * other, never neither — this is the one money entry with no bank statement
 * of ours behind it, so the only evidence it ever has is what the person
 * pastes in at the time.
 */

export const settlementSchema = z
  .object({
    /** Minted by the form so a receipt photo can be attached before saving. */
    txId: z.string().uuid(),
    clientId: z.string().uuid(),
    partnerId: z.string().uuid(),
    /** What the client actually sent. */
    clientAmount: nativeAmount(),
    clientCurrency: z.string().length(3).toUpperCase(),
    /** What the firm says it took off our debt. */
    partnerAmount: nativeAmount(),
    partnerCurrency: z.string().length(3).toUpperCase(),
    txDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(2000).optional().or(z.literal('')),
    /**
     * Which JOB the client's money answers, when the accountant says (U30).
     * Optional like the kassa form's: plenty of money arrives for no deal.
     * But for a DEFERRED deal it is the whole mechanism — the handover gate
     * nets a deferral's charges against the payments that NAME it (#251), so
     * a settlement that could name nothing paid the deferral off on paper
     * while the gate went on excusing unrelated debt: #531's hole on the one
     * money door it had not reached.
     */
    dealId: z.string().uuid().optional().or(z.literal('')),
  });
export type SettlementInput = z.infer<typeof settlementSchema>;

export interface SettlementResult {
  partnerTxId: string;
  clientTxId: string;
  clientUsd: number;
  partnerUsd: number;
  /** partnerUsd − clientUsd: what the firm's rate gained or cost us. */
  differenceUsd: number;
}

export async function recordSettlement(
  input: SettlementInput,
  ctx: AuditContext,
): Promise<SettlementResult> {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  // #995's rule (U21), before anything is written. This door writes a CLIENT
  // payment too, so without it the ledger's own guard had a way round.
  if (input.txDate > latestTxDate()) throw new PartnerError('future_date');

  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, input.clientId))
    .limit(1);
  if (!client) throw new PartnerError('client_not_found');
  const [partner] = await db
    .select({ id: partners.id, active: partners.active })
    .from(partners)
    .where(eq(partners.id, input.partnerId))
    .limit(1);
  if (!partner) throw new PartnerError('partner_not_found');
  // A named deal must be THIS client's — the ledger door's rule
  // (finance/service.ts addTransaction): a select's value is a forged post
  // until the server has checked it (#507), and a payment parked on another
  // client's deal would quietly re-open THEIR handover gate.
  const dealId = input.dealId || null;
  if (dealId) {
    const [deal] = await db
      .select({ clientId: deals.clientId })
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1);
    if (!deal || deal.clientId !== input.clientId) throw new PartnerError('deal_mismatch');
  }

  // Evidence or explanation — one of the two, checked before anything is
  // written. The file was uploaded against the id this form minted, so it is
  // already in storage waiting; it must be THIS person's upload, or a stolen
  // uuid would let one member of staff decorate another's entry.
  const proof = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'partner_transaction'),
        eq(attachments.entityId, input.txId),
        eq(attachments.uploadedBy, ctx.actorId),
      ),
    )
    .limit(1);
  if (proof.length === 0 && !input.note?.trim()) throw new PartnerError('proof_required');

  const clientRate = await rateFor(input.clientCurrency, input.txDate);
  const partnerRate = await rateFor(input.partnerCurrency, input.txDate);
  if (clientRate === null || partnerRate === null) throw new PartnerError('fx_missing');
  const clientUsd = Math.round(input.clientAmount * clientRate * 100) / 100;
  const partnerUsd = Math.round(input.partnerAmount * partnerRate * 100) / 100;
  // The typo ceiling in dollars, both halves (U44).
  if (exceedsRowUsd(clientUsd) || exceedsRowUsd(partnerUsd)) {
    throw new PartnerError('amount_too_large');
  }

  const result = await db.transaction(async (tx) => {
    const [clientRow] = await tx
      .insert(clientTransactions)
      .values({
        clientId: input.clientId,
        type: 'payment',
        amount: String(input.clientAmount),
        currency: input.clientCurrency,
        rateToUsd: String(clientRate),
        amountUsd: String(clientUsd),
        method: 'transfer',
        txDate: input.txDate,
        // No cash box of ours opened. `accountId` stays null on purpose: the
        // cash-flow report must not show money it never held.
        accountId: null,
        partnerId: input.partnerId,
        // The client half only: the job is the client's; the firm's offset
        // names no deal.
        dealId,
        note: input.note || null,
        createdBy: ctx.actorId!,
      })
      .returning();

    const [partnerRow] = await tx
      .insert(partnerTransactions)
      .values({
        id: input.txId,
        partnerId: input.partnerId,
        type: 'offset',
        amount: String(input.partnerAmount),
        currency: input.partnerCurrency,
        rateToUsd: String(partnerRate),
        amountUsd: String(partnerUsd),
        txDate: input.txDate,
        accountId: null,
        clientTxId: clientRow!.id,
        note: input.note || null,
        createdBy: ctx.actorId!,
      })
      .returning();

    return { partnerTxId: partnerRow!.id, clientTxId: clientRow!.id };
  });

  await writeAudit(db, ctx, {
    entityType: 'partner_transaction',
    entityId: result.partnerTxId,
    action: 'create',
    after: {
      kind: 'settlement',
      clientId: input.clientId,
      partnerId: input.partnerId,
      clientAmount: input.clientAmount,
      clientCurrency: input.clientCurrency,
      partnerAmount: input.partnerAmount,
      partnerCurrency: input.partnerCurrency,
      clientUsd,
      partnerUsd,
      ...(dealId ? { dealId } : {}),
    },
  });

  return {
    ...result,
    clientUsd,
    partnerUsd,
    differenceUsd: Math.round((partnerUsd - clientUsd) * 100) / 100,
  };
}
