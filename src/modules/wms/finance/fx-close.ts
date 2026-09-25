import { and, eq, isNull, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, type Db, type Tx } from '../../platform/db/client';
import { clientTransactions } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { fxCyclesFor, fxSettingsTx, lockOwnersTx, ownersSql, reconcileFxResidueTx } from './fx-residue';
import { isLegacyCycle } from './fx-legacy';
import { fxResidueAllowance } from './money-bounds';

/**
 * «Kurs farqi bilan yopish» (the design's open question 1, answer b — the
 * lead's default until the owner says otherwise): a client billed in dollars
 * who pays in so'm (or the reverse) never returns to zero in any ONE
 * currency, so Q14's rule cannot see it, and the few dollars the two rates
 * leave behind block the handover for ever. The accountant closes them with
 * one press — the client-side twin of the firms' two-currency «kurs farqi»
 * adjust: a DOLLAR `fx_diff`, audited, in the P&L's «Qo'lda yozilgan kurs
 * farqi» line (`fx:adjust`).
 *
 * Bounded, because a button that writes off any balance is a way to forgive
 * a debt: only a residue within the merge's own allowance (2 % of the dollars
 * the client paid, or $5 — `fxResidueAllowance`), only on an account that
 * really moves in two currencies, and never over a legacy residue Q14 has not
 * closed yet (that one is «Kurs qoldiqlari»'s). One live close per anchor
 * (the unique index): a second press supersedes the first rather than
 * stacking beside it. Its own undo door (`voidFxClose`) — the ledger's
 * generic void refuses every kurs farqi row.
 */

export class FxCloseError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

type Money = { balanceUsd: number; paidUsd: number; currencies: number };

async function accountMoney(handle: Db | Tx, clientId: string): Promise<Money> {
  const [row] = (await handle.execute(sql`
    SELECT coalesce(sum(CASE WHEN t.type = 'payment' THEN -t.amount_usd ELSE t.amount_usd END), 0) AS balance,
           coalesce(sum(t.amount_usd) FILTER (WHERE t.type = 'payment'), 0) AS paid,
           count(DISTINCT t.currency) FILTER (WHERE t.type <> 'fx_diff') AS currencies
      FROM client_transactions t
     WHERE t.client_id = ${clientId}::uuid AND t.voided_at IS NULL
  `)) as unknown as { balance: string; paid: string; currencies: string | number }[];
  return {
    balanceUsd: Math.round(Number(row?.balance ?? 0) * 100) / 100,
    paidUsd: Number(row?.paid ?? 0),
    currencies: Number(row?.currencies ?? 0),
  };
}

/**
 * The pure admission — the screen draws the button on it and the service
 * refuses on it, so the two can never disagree.
 */
export function crossCloseRefusal(money: Money): string | null {
  if (Math.abs(money.balanceUsd) < 0.005) return 'fx_close_nothing';
  if (money.currencies < 2) return 'fx_close_single_currency';
  if (Math.abs(money.balanceUsd) > fxResidueAllowance(money.paidUsd) + 0.004) return 'fx_close_too_large';
  return null;
}

/** The card's read (pool): may the button be drawn, and for how much. */
export async function crossCloseOffer(clientId: string): Promise<{ balanceUsd: number; refusal: string | null }> {
  const money = await accountMoney(db, clientId);
  return { balanceUsd: money.balanceUsd, refusal: crossCloseRefusal(money) };
}

export async function closeCrossCurrencyResidue(
  clientId: string,
  ctx: AuditContext,
  door: { mayClassify: boolean },
): Promise<{ amountUsd: number }> {
  if (!ctx.actorId) throw new FxCloseError('unauthenticated');
  if (!door.mayClassify) throw new FxCloseError('forbidden');
  return db.transaction(async (tx) => {
    await lockOwnersTx(tx, { clientIds: [clientId] });
    // Q14's own closes first (a client's history is the system's), then what
    // is still open is judged.
    await reconcileFxResidueTx(tx, { clientIds: [clientId] }, ctx);
    const { since } = await fxSettingsTx(tx);
    const cycles = await fxCyclesFor(tx, 'client', ownersSql('client', [clientId]), since);
    if (cycles.some(isLegacyCycle)) throw new FxCloseError('fx_close_legacy_first');
    const money = await accountMoney(tx, clientId);
    const refusal = crossCloseRefusal(money);
    if (refusal) throw new FxCloseError(refusal);

    const [anchor] = (await tx.execute(sql`
      SELECT t.id, t.tx_date::text AS tx_date
        FROM client_transactions t
       WHERE t.client_id = ${clientId}::uuid AND t.voided_at IS NULL AND t.type <> 'fx_diff'
       ORDER BY t.tx_date DESC, t.created_at DESC, t.id DESC
       LIMIT 1
    `)) as unknown as { id: string; tx_date: string }[];
    if (!anchor) throw new FxCloseError('fx_close_nothing');
    // One live close per anchor: a second press takes the first one's
    // dollars into the new row and voids it.
    const previous = await tx
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: 'kurs farqi qayta yopildi' })
      .where(
        and(
          eq(clientTransactions.fxAnchorId, anchor.id),
          eq(clientTransactions.type, 'fx_diff'),
          eq(clientTransactions.currency, 'USD'),
          isNull(clientTransactions.voidedAt),
        ),
      )
      .returning({ id: clientTransactions.id, amountUsd: clientTransactions.amountUsd });
    const amountUsd = Math.round((previous.reduce((sum, row) => sum + Number(row.amountUsd), 0) - money.balanceUsd) * 100) / 100;
    const id = uuidv4();
    if (Math.abs(amountUsd) >= 0.005) {
      await tx.insert(clientTransactions).values({
        id,
        clientId,
        type: 'fx_diff',
        amount: '0',
        currency: 'USD',
        rateToUsd: '1',
        amountUsd: amountUsd.toFixed(2),
        txDate: anchor.tx_date,
        fxAnchorId: anchor.id,
        createdBy: ctx.actorId!,
      });
    }
    await reconcileFxResidueTx(tx, { clientIds: [clientId] }, ctx);
    for (const row of previous) {
      await writeAudit(tx, ctx, {
        entityType: 'client_transaction',
        entityId: row.id,
        action: 'void',
        after: { from: 'fx_close', supersededBy: Math.abs(amountUsd) >= 0.005 ? id : null },
      });
    }
    if (Math.abs(amountUsd) >= 0.005) {
      await writeAudit(tx, ctx, {
        entityType: 'client_transaction',
        entityId: id,
        action: 'create',
        after: { from: 'fx_close', clientId, currency: 'USD', amountUsd, balanceBefore: money.balanceUsd },
      });
    }
    return { amountUsd };
  });
}

/** The hand close's own undo — only a DOLLAR kurs farqi row (the system's are the reconciler's). */
export async function voidFxClose(
  txId: string,
  reason: string,
  ctx: AuditContext,
  door: { mayClassify: boolean },
): Promise<void> {
  if (!ctx.actorId) throw new FxCloseError('unauthenticated');
  if (!door.mayClassify) throw new FxCloseError('forbidden');
  const row = await db.query.clientTransactions.findFirst({ where: eq(clientTransactions.id, txId) });
  if (!row) throw new FxCloseError('not_found');
  if (row.voidedAt) throw new FxCloseError('already_voided');
  if (row.type !== 'fx_diff' || row.currency !== 'USD') throw new FxCloseError('fx_system_row');
  await db.transaction(async (tx) => {
    await lockOwnersTx(tx, { clientIds: [row.clientId] });
    await tx
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(and(eq(clientTransactions.id, txId), isNull(clientTransactions.voidedAt)));
    await reconcileFxResidueTx(tx, { clientIds: [row.clientId] }, ctx);
    await writeAudit(tx, ctx, {
      entityType: 'client_transaction',
      entityId: txId,
      action: 'void',
      before: { amountUsd: Number(row.amountUsd) },
      after: { from: 'fx_close', reason },
    });
  });
}
