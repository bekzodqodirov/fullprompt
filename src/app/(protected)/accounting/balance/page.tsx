import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { companyBalance } from '@/modules/wms/accounting/reports';
import { toUzs } from '@/modules/wms/accounting/period';
import { balanceLines, unplacedCostsTakenOff } from '@/modules/wms/accounting/balance-lines';
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

  const lines = balanceLines(balance);
  const costsOut = unplacedCostsTakenOff(balance);
  // Money in a till whose currency has no rate is OUT of the net (U14): said
  // beside the net and the cash line, with the fix one tap away for whoever
  // may type a rate — anybody else would bounce off /admin/fx (#737).
  const unrated = balance.unratedTills.length > 0;
  const unratedSums = balance.unratedTills
    .map((row) => `${row.balance.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${row.currency}`)
    .join(', ');
  const canFx = actor.permissions.has('costs.fx.manage');

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
          {unrated && <span className="text-warn"> ⚠</span>}
        </p>
        {som(balance.netUsd) && (
          <p className="text-sm text-ink-500">≈ {som(balance.netUsd)} so‘m</p>
        )}
        <p className="pt-1 text-xs text-ink-500">{t('balHint')}</p>
        {/* Allowed, summed as it stands, and never silent (U14, answer a). */}
        {balance.negativeTills.length > 0 && (
          <p className="text-xs font-semibold text-bad" data-testid="balance-negative-tills">
            ⚠ {t('balNegativeTills', { n: balance.negativeTills.length })}
          </p>
        )}
        {unrated && (
          <p className="text-xs font-semibold text-warn" data-testid="balance-unrated">
            ⚠{' '}
            {canFx ? (
              <Link href="/admin/fx" className="underline">
                {t('balUnrated', { sums: unratedSums })}
              </Link>
            ) : (
              t('balUnrated', { sums: unratedSums })
            )}
          </p>
        )}
      </div>

      <div className="card !p-0">
        <table className="w-full text-sm">
          <tbody>
            {lines.map((line) => (
              <tr key={line.key} className="border-b border-line last:border-0">
                <td className="p-0">
                  <Link href={line.href} className="block p-3 hover:bg-surface-sunken">
                    {t(line.key)}
                    {line.key === 'balCash' && unrated && <span className="text-warn"> ⚠</span>}
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

      {/* The line above takes these costs out of the net (U02); this says the
          one case it cannot tell apart — the same money also typed as an
          expense FROM a kassa counts twice until the queue merges it. */}
      {costsOut.count > 0 && (
        <Link
          href="/accounting/xarajat-kassa"
          className="card block text-sm text-warn underline"
          data-testid="balance-unplaced-costs"
        >
          ⚠ {t('balUnplacedCosts', { count: costsOut.count, usd: usd(costsOut.usd) })}
        </Link>
      )}
      {/* The queued costs every kassa's count already holds: on the queue,
          NOT taken off again (the pair rule, #528) — said, so the queue's
          total and the line above can be told apart. */}
      {balance.unplacedCostInCountCount > 0 && (
        <Link
          href="/accounting/xarajat-kassa"
          className="card block text-sm text-ink-700 underline"
          data-testid="balance-unplaced-costs-in-count"
        >
          ℹ️{' '}
          {t('balUnplacedCostsInCount', {
            count: balance.unplacedCostInCountCount,
            usd: usd(balance.unplacedCostInCountUsd),
          })}
        </Link>
      )}

      <section className="space-y-2">
        <p className="section-title">{t('accounts')}</p>
        <div className="card !p-0">
          <table className="w-full text-sm">
            <tbody>
              {balance.cashRows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <td className={`p-3 ${row.retired ? 'text-ink-500' : ''}`}>
                    {row.name}
                    {/* Money in a RETIRED till: still the company's, still on
                        the sheet, marked so somebody moves it out. */}
                    {row.retired && ' ⚠'}
                  </td>
                  {/* The box's OWN currency first: this is the number somebody
                      counts against the notes in the drawer. */}
                  <td className={`p-3 text-right font-mono font-bold ${row.balance < -0.009 ? 'text-bad' : ''}`}>
                    {row.balance.toLocaleString('en-US', { maximumFractionDigits: 2 })} {row.currency}
                    {row.balance < -0.009 && (
                      <span className="block text-[11px] font-sans font-normal">⚠ {t('tillNegative')}</span>
                    )}
                  </td>
                  <td className="p-3 text-right font-mono text-xs text-ink-500">
                    {row.balanceUsd === null ? (
                      // Out of the net — flagged when it holds money (U14).
                      <span className={Math.abs(row.balance) > 0.009 ? 'font-semibold text-warn' : ''}>
                        {Math.abs(row.balance) > 0.009 && '⚠ '}
                        {t('noRate')}
                      </span>
                    ) : (
                      `$${usd(row.balanceUsd)}`
                    )}
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
