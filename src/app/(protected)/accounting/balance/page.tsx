import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { companyBalance } from '@/modules/wms/accounting/reports';
import { toUzs } from '@/modules/wms/accounting/period';
import { PageHeader } from '@/components/ui/page';

/**
 * Balans — what we hold against what we owe.
 *
 * Answerable only since counterparties exist (round 39): before them "we owe"
 * had no number, and a screen like this would have flattered every month by
 * showing the money coming in with none of the money going out.
 *
 * Cargo in the warehouse is deliberately NOT valued: it is the client's goods,
 * and its money side is already in what they owe us.
 */
export default async function BalancePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.reports')) redirect('/accounting');
  const t = await getTranslations('accounting');

  const balance = await companyBalance();
  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const som = (value: number) => {
    const converted = toUzs(value, balance.uzsRate);
    return converted === null ? null : converted.toLocaleString('ru-RU');
  };

  const lines = [
    { key: 'balCash', value: balance.cashUsd, tone: 'text-ink-900', href: '/accounting/accounts' },
    { key: 'balReceivable', value: balance.receivableUsd, tone: 'text-good', href: '/finance' },
    {
      key: 'balPartnerReceivable',
      value: balance.partnerReceivableUsd,
      tone: 'text-good',
      href: '/kontragentlar',
    },
    { key: 'balPayable', value: -balance.payableUsd, tone: 'text-bad', href: '/kontragentlar' },
  ] as const;

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="wallet" title={t('balance')} />

      <div className="card space-y-1">
        <p className="text-sm text-ink-700">{t('balNet')}</p>
        <p
          className={`font-mono text-3xl font-extrabold ${
            balance.netUsd >= 0 ? 'text-good' : 'text-bad'
          }`}
          data-testid="balance-net"
        >
          ${usd(balance.netUsd)}
        </p>
        {som(balance.netUsd) && (
          <p className="text-sm text-ink-500">≈ {som(balance.netUsd)} so‘m</p>
        )}
        <p className="pt-1 text-xs text-ink-500">{t('balHint')}</p>
      </div>

      <div className="card !p-0">
        <table className="w-full text-sm">
          <tbody>
            {lines.map((line) => (
              <tr key={line.key} className="border-b border-line last:border-0">
                <td className="p-0">
                  <Link href={line.href} className="block p-3 hover:bg-surface-sunken">
                    {t(line.key)}
                  </Link>
                </td>
                <td className={`p-3 text-right font-mono font-bold ${line.tone}`}>
                  {line.value < 0 ? '−' : ''}${usd(Math.abs(line.value))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="space-y-2">
        <p className="section-title">{t('accounts')}</p>
        <div className="card !p-0">
          <table className="w-full text-sm">
            <tbody>
              {balance.cashRows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <td className="p-3">{row.name}</td>
                  {/* The box's OWN currency first: this is the number somebody
                      counts against the notes in the drawer. */}
                  <td className="p-3 text-right font-mono font-bold">
                    {row.balance.toLocaleString('en-US', { maximumFractionDigits: 2 })} {row.currency}
                  </td>
                  <td className="p-3 text-right font-mono text-xs text-ink-500">
                    {row.balanceUsd === null ? t('noRate') : `$${usd(row.balanceUsd)}`}
                  </td>
                </tr>
              ))}
              {balance.cashRows.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-ink-500">
                    —
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
