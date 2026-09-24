import { getFormatter, getTranslations } from 'next-intl/server';
import type { StaffAccountView } from '@/modules/wms/partners/staff-account';

const usd = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const native = (value: number) =>
  value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * «Kompaniya bilan hisob-kitobim» (owner A2a): a staff member's OWN account,
 * in their words and nobody else's — no link to /kontragentlar, which is the
 * accountant's screen and M3a keeps staff accounts off it for everybody else.
 *
 * The own-pocket reports nobody has entered yet are listed apart and SAID to
 * be not yet a debt: a person who reads «$40 taxi» under «the company owes
 * you $0» would otherwise conclude the money was lost.
 */
export async function StaffAccountPanel({ view }: { view: StaffAccountView }) {
  const t = await getTranslations('profile');
  const format = await getFormatter();
  // Literal maps — the i18n tripwire cannot see a key built at runtime.
  const headline =
    view.headline === 'company_owes'
      ? t('staffOwes', { amount: usd(view.amountUsd) })
      : view.headline === 'advance_left'
        ? t('staffAdvance', { amount: usd(view.amountUsd) })
        : t('staffSettled');
  const kind: Record<string, string> = {
    charge: t('staffKindCharge'),
    payment: t('staffKindPayment'),
    receipt: t('staffKindReceipt'),
    adjust: t('staffKindAdjust'),
    offset: t('staffKindOffset'),
  };

  return (
    <section className="space-y-2" data-testid="profile-staff-account">
      <h2 className="text-lg font-bold">💼 {t('staffAccountTitle')}</h2>
      <div className="card space-y-2 !p-3 text-sm">
        <p
          className={`text-base font-bold ${
            view.headline === 'company_owes'
              ? 'text-good'
              : view.headline === 'advance_left'
                ? 'text-warn'
                : 'text-ink-700'
          }`}
          data-testid="staff-account-headline"
        >
          {headline}
        </p>
        {view.perCurrency.length > 1 && (
          <p className="text-xs text-ink-500">
            {view.perCurrency.map((row) => `${native(row.amount)} ${row.currency}`).join(' · ')}
          </p>
        )}
        {view.rows.length > 0 && (
          <ul className="space-y-0.5 border-t border-line pt-2 text-xs">
            {view.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-ink-500">{row.txDate}</span>
                <span className="min-w-0 flex-1 text-ink-700">{kind[row.kind] ?? row.kind}</span>
                <span className={`font-mono font-semibold ${row.raises ? 'text-good' : 'text-ink-700'}`}>
                  {row.raises ? '+' : '−'}
                  {native(Math.abs(row.amount))} {row.currency}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {view.pending.length > 0 && (
        <div className="card space-y-1 !p-3 text-xs" data-testid="staff-account-pending">
          <p className="font-semibold">⏳ {t('staffPendingTitle')}</p>
          <p className="text-ink-500">{t('staffPendingHint')}</p>
          <ul className="space-y-0.5">
            {view.pending.map((row) => (
              <li key={row.id} className="[overflow-wrap:anywhere]">
                {format.dateTime(row.createdAt, { dateStyle: 'short' })} ·{' '}
                <span className="font-mono">
                  {native(Number(row.amount))} {row.currency}
                </span>{' '}
                — {row.note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
