/**
 * Every code the four recurring doors (accounting/recurring.ts),
 * `updateRecurring` and `saveRecurring` can answer, in WORDS (#163). Full
 * keys — some are wc's common ones — so `recurring-wire.test.ts` can both
 * read the codes out of the services and resolve every value in all four
 * bundles. Zero imports: the client folds and the unit fence both read it.
 */
export const RECURRING_ERRORS: Record<string, string> = {
  future_date: 'common.futureDate',
  amount_too_large: 'common.amountTooLarge',
  fx_missing: 'accounting.fxMissing',
  account_or_payer_required: 'accounting.accountOrPayerRequired',
  non_cash_category: 'accounting.nonCashCategory',
  account_currency_mismatch: 'accounting.accountCurrencyMismatch',
  account_not_found: 'accounting.recurringErrTill',
  partner_not_found: 'accounting.recurringErrPartner',
  recurring_not_due: 'accounting.recurringErrNotDue',
  recurring_already_paid: 'accounting.recurringErrAlreadyPaid',
  recurring_skipped: 'accounting.recurringErrSkipped',
  recurring_has_arrears: 'accounting.recurringErrArrears',
  recurring_has_arrears_edit: 'accounting.recurringErrArrearsEdit',
  recurring_candidate_exists: 'accounting.recurringErrCandidate',
  recurring_partial_unclear: 'accounting.recurringErrPartialUnclear',
  recurring_not_candidate: 'accounting.recurringErrNotCandidate',
  recurring_duplicate_press: 'accounting.recurringErrDuplicate',
  reason_required: 'accounting.recurringErrReason',
  // Hidden fields the server wrote, a forged post, or a session gone: the
  // honest general sentence.
  unauthenticated: 'common.error',
  bad_month: 'common.error',
  not_found: 'common.error',
  validation: 'common.error',
  forbidden: 'common.error',
};
