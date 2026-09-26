'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { addPartnerTxAction, type PartnerFormState } from '../actions';

/**
 * No `charge` here (audit A31): a debt for a service is written by the cost or
 * expense form with its payer picked, so the same fact reaches the P&L too.
 * The service refuses it as well — a kind removed from a form while the door
 * still takes it is hidden, not removed.
 */
const TYPES = ['payment', 'receipt', 'adjust'] as const;
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
  staff,
  movesTills,
  mayClassify,
  accounts,
  currencies,
  today,
}: {
  partnerId: string;
  /**
   * May this person say what a correction IS (0103, `mayClassifyFx`)? The
   * accountant and the admin get the radio; the VED gets today's form, and
   * the correction waits unclassified beside the P&L (Q19 B).
   */
  mayClassify: boolean;
  /**
   * May this person move a kassa (owner's answer b)? Without it the card
   * offers the correction alone — a payment or a receipt must name the kassa
   * it moved, and the kassas are the accountant's and the admin's.
   */
  movesTills: boolean;
  /**
   * A colleague's account (0101): `payment` is a cash advance handed to them
   * and `receipt` is the rest of it handed back — the ledger's own kinds and
   * signs, said the way the accountant says them at the till (owner A1c).
   */
  staff: boolean;
  accounts: { id: string; name: string }[];
  currencies: string[];
  /** Tashkent's day from the server — the browser's clock is not the office's (R5). */
  today: string;
}) {
  const t = useTranslations('partners');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const label = (code: string) =>
    staff && (code === 'payment' || code === 'receipt')
      ? t(`staffKinds.${code}` as 'staffKinds.payment')
      : t(`kinds.${code}` as 'kinds.payment');
  const hint = (code: string) =>
    staff && (code === 'payment' || code === 'receipt')
      ? t(`staffKindHints.${code}` as 'staffKindHints.payment')
      : t(`kindHints.${code}` as 'kindHints.payment');
  const kinds = movesTills ? TYPES : TYPES.filter((code) => !CASH.has(code));
  const [type, setType] = useState<string>(kinds[0] ?? 'adjust');
  // Controlled, every one: React resets an uncontrolled form after its
  // action, so a refusal (e.g. «choose what this correction is») would eat
  // the typed amount — «a form that can be refused must hold its inputs»
  // (#463). Never a disabled control (#171).
  const [adjustKind, setAdjustKind] = useState<'' | 'fx' | 'correction'>('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD');
  const [accountId, setAccountId] = useState('');
  const [txDate, setTxDate] = useState(today);
  const [note, setNote] = useState('');
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
    if (state.ok) {
      setOpen(false);
      setAmount('');
      setNote('');
      setAdjustKind('');
    }
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

      <p className="rounded-lg bg-surface-sunken p-2 text-xs text-ink-700" data-testid="partner-charge-moved">
        ℹ️ {t('chargeMoved')}
      </p>
      <select
        name="type"
        className="input"
        aria-label={t('kind')}
        data-testid="partner-tx-type"
        value={type}
        onChange={(event) => setType(event.target.value)}
      >
        {kinds.map((code) => (
          <option key={code} value={code}>
            {label(code)}
          </option>
        ))}
      </select>
      <p className="text-xs text-ink-500">{hint(type)}</p>

      {type === 'adjust' && mayClassify && (
        <fieldset className="space-y-1 rounded-lg border border-line p-2" data-testid="partner-tx-adjust-kind">
          <legend className="px-1 text-xs font-semibold">{t('adjustKindLabel')}</legend>
          {(['fx', 'correction'] as const).map((kind) => (
            <label key={kind} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="adjustKind"
                value={kind}
                checked={adjustKind === kind}
                onChange={() => setAdjustKind(kind)}
                data-testid={`partner-tx-adjust-kind-${kind}`}
                required
              />
              <span>{kind === 'fx' ? t('adjustKinds.fx') : t('adjustKinds.correction')}</span>
            </label>
          ))}
          <p className="text-xs text-ink-500">{t('adjustFxHint')}</p>
        </fieldset>
      )}

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
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
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
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
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
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
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
        value={txDate}
        onChange={(event) => setTxDate(event.target.value)}
        max={latestTxDate()}
        required
      />
      <textarea
        name="note"
        className="input"
        rows={2}
        placeholder={t('note')}
        aria-label={t('note')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
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
          {state.error === 'fx_missing'
            ? t('fxMissing')
            : state.error === 'charge_via_cost'
              ? t('chargeMoved')
              : state.error === 'forbidden'
                ? t('staffForbidden')
                : state.error === 'till_forbidden'
                  ? t('tillForbidden')
                  : state.error === 'future_date'
                    ? tc('futureDate')
                    : state.error === 'amount_too_large'
                      ? tc('amountTooLarge')
                      : state.error === 'adjust_kind_required'
                        ? t('adjustKindRequired')
                        : state.error === 'fx_adjust_single_currency'
                          ? t('fxAdjustSingleCurrency')
                          : state.error === 'fx_adjust_legacy'
                            ? t('fxAdjustLegacy')
                            : state.error === 'fx_adjust_usd_only'
                              ? t('fxAdjustUsdOnly')
                              : tc('error')}
        </p>
      )}
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('save')}</p>}
    </form>
  );
}
