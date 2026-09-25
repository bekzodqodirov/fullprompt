/**
 * How a ledger's «kurs farqi» row reads in the P&L (0103, + = gain), said
 * once for the P&L line, the cards' «bizga foyda/zarar» and the reconciler's
 * summary. The two ledgers run opposite ways: a client row's dollars LOWER
 * what the client owes us (a negative row = we received less than we billed
 * = a loss), a partner row's dollars LOWER what we owe (a negative row = we
 * paid less than we booked = a gain). Zero imports.
 */
export const FX_PNL_SIGN = { client: 1, partner: -1 } as const;

/** The P&L effect of one kurs farqi row, + = gain to us. */
export function fxPnlEffect(ledger: keyof typeof FX_PNL_SIGN, amountUsd: number): number {
  return Math.round(FX_PNL_SIGN[ledger] * amountUsd * 100) / 100;
}
