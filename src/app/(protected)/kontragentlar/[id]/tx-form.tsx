'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { addPartnerTxAction, type PartnerFormState } from '../actions';

const TYPES = ['charge', 'receipt', 'payment', 'adjust'] as const;
/** Types that moved real money and so must name the cash box that moved. */
const CASH = new Set<string>(['receipt', 'payment']);

/**
 * One row on the account.
 *
 * `offset` is deliberately NOT offered here: a three-cornered settlement
 * always has a client on the other end, so it has its own screen where that
 * client must be named. A free-standing offset would be a debt written off
 * with nobody to ask about it.
 *
 * The cash-box picker appears exactly for the two kinds that move money and
 * disappears for the two that do not, which is the same rule the database
 * enforces — the form simply stops a person reaching a refusal.
 */
export function PartnerTxForm({
  partnerId,
  accounts,
  currencies,
}: {
  partnerId: string;
  accounts: { id: string; name: string }[];
  currencies: string[];
}) {
  const t = useTranslations('partners');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>('charge');
  const [state, formAction, pending] = useActionState<PartnerFormState, FormData>(
    addPartnerTxAction,
    {},
  );

  // Fold away once it has landed: leaving the form open over a saved row is
  // how a second, identical entry gets typed. Adjusted during render rather
  // than in an effect — React's own pattern for reacting to a changed value,
  // and the one the lint rule here insists on.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state.ok) setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn-secondary w-full"
        data-testid="partner-tx-new"
        onClick={() => setOpen(true)}
      >
        ➕ {t('newRow')}
      </button>
    );
  }

  return (
    <form action={formAction} className="card space-y-2">
      <input type="hidden" name="partnerId" value={partnerId} />
      <p className="section-title">{t('newRow')}</p>

      <select
        name="type"
        className="input"
        aria-label={t('kind')}
        data-testid="partner-tx-type"
        value={type}
        onChange={(event) => setType(event.target.value)}
      >
        {TYPES.map((code) => (
          <option key={code} value={code}>
            {t(`kinds.${code}` as 'kinds.charge')}
          </option>
        ))}
      </select>
      <p className="text-xs text-ink-500">{t(`kindHints.${type}` as 'kindHints.charge')}</p>

      {/* The sum is the point of the form, so it gets the room: its own line,
          typed big enough to read back at a glance. Sharing a row with the
          currency box left it a third of a phone screen wide (owner). */}
      <label className="label" htmlFor="tx-amount">
        {t('amount')}
      </label>
      <div className="flex gap-2">
        <input
          id="tx-amount"
          name="amount"
          className="input min-w-0 flex-1 !py-3 text-right font-mono text-2xl font-extrabold"
          inputMode="decimal"
          placeholder="0"
          aria-label={t('amount')}
          data-testid="partner-tx-amount"
          required
        />
        <select
          name="currency"
          // `!w-24`, not `w-24`: `.input` carries w-full and wins on source
          // order, so without the important the box claims the whole row — and
          // `shrink-0` then forbids it to give any of it back, which is how the
          // amount field ended up a sliver (owner's screenshot).
          className="input !w-24 shrink-0 font-bold"
          aria-label={t('currency')}
          data-testid="partner-tx-currency"
        >
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>

      {CASH.has(type) && (
        <select
          name="accountId"
          className="input"
          aria-label={t('account')}
          data-testid="partner-tx-account"
          required
        >
          <option value="">— {t('account')}</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      )}

      <input
        type="date"
        name="txDate"
        className="input"
        aria-label={t('date')}
        data-testid="partner-tx-date"
        defaultValue={new Date().toISOString().slice(0, 10)}
        required
      />
      <textarea
        name="note"
        className="input"
        rows={2}
        placeholder={t('note')}
        aria-label={t('note')}
      />

      <div className="flex gap-2">
        <button
          type="submit"
          className="btn-primary flex-1"
          data-testid="partner-tx-save"
          disabled={pending}
        >
          {pending ? tc('loading') : tc('save')}
        </button>
        <button type="button" className="btn-secondary flex-1" onClick={() => setOpen(false)}>
          {tc('cancel')}
        </button>
      </div>
      {state.error && (
        <p className="text-sm font-semibold text-bad">
          {state.error === 'fx_missing' ? t('fxMissing') : tc('error')}
        </p>
      )}
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('save')}</p>}
    </form>
  );
}
