import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { companyBalance } from '@/modules/wms/accounting/reports';
import { toUzs } from '@/modules/wms/accounting/period';
import {
  balanceLines,
  unplacedCostsTakenOff,
  unpricedNotesDrawn,
} from '@/modules/wms/accounting/balance-lines';
import { mayReadUnpricedList } from '@/modules/wms/finance/unpriced-door';
import { tashkentMinute } from '@/modules/platform/time/tashkent';
import { PageHeader } from '@/components/ui/page';

/**
 * Balans — what we hold against what we owe.
 *
 * Answerable only since counterparties exist (round 39): before them "we owe"
 * had no number, and a screen like this would have flattered every month by
 * showing the money coming in with none of the money going out.
 *
 * The cargo itself is deliberately NOT valued: it is the client's goods. What
 * IS on the sheet (U03, the owner's Q16 A) is the money WE already spent
 * carrying cargo whose price is not written yet — it is in no receivable
 * until the price is posted after customs, and it comes back as the price.
 * Its notes card below prints the arithmetic, so the one figure the line
 * adds can be checked on this page and not on a list that holds only landed
 * cargo.
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

  const lines = balanceLines(balance, { cash: '/accounting/accounts', cargo: '#balance-unpriced' });
  const costsOut = unplacedCostsTakenOff(balance);
  const cargo = balance.unpricedCargo;
  const showCargo = unpricedNotesDrawn(cargo);
  const canList = mayReadUnpricedList(actor.permissions);
  // Money in a till whose currency has no rate is OUT of the net (U14): said
  // beside the net and the cash line, with the fix one tap away for whoever
  // may type a rate — anybody else would bounce off /admin/fx (#737).
  const unrated = balance.unratedTills.length > 0;
  const unratedSums = balance.unratedTills
    .map((row) => `${row.balance.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${row.currency}`)
    .join(', ');
  const canFx = actor.permissions.has('costs.fx.manage');
  // The kassa screen is `finance.expenses`'s; a report reader without it
  // reads the old-costs sentence as text instead of a door that bounces.
  const canAccounts = actor.permissions.has('finance.expenses');

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

      {/* U03: the line «narxi hali yozilmagan yukka sarflangan», top-down —
          what was spent, minus what a price elsewhere already holds, equals
          what the net added — then everything left out, one line each with
          its own door. Each line only when its figure is there. The row's
          link lands here, never on /finance/narxsiz: that list holds only
          landed cargo and prints no money, so it cannot confirm the figure. */}
      {showCargo && (
        <section
          id="balance-unpriced"
          className="card scroll-mt-20 space-y-2 text-sm"
          data-testid="balance-unpriced-notes"
        >
          <p className="font-semibold">{t('balUnpricedCargo')}</p>
          {cargo.grossUsd > 0.004 && (
            <p data-testid="balance-unpriced-gross">
              {t('balUnpricedGross', {
                gross: usd(cargo.grossUsd),
                away: usd(cargo.awayUsd),
                stock: usd(cargo.stockUsd),
              })}
              {/* The money at risk: out of the counter with no price. */}
              {cargo.issuedUsd > 0.004 && (
                <span className="font-semibold text-warn">
                  {' '}
                  {t('balUnpricedIssued', { issued: usd(cargo.issuedUsd) })}
                </span>
              )}
            </p>
          )}
          {cargo.cardUsd > 0.004 && (
            <p className="text-ink-700" data-testid="balance-unpriced-card">
              {t('balUnpricedCard', { usd: usd(cargo.cardUsd), clients: cargo.cardClients })}
            </p>
          )}
          {cargo.elsewhereUsd > 0.004 && (
            <p className="text-ink-700" data-testid="balance-unpriced-elsewhere">
              {t('balUnpricedElsewhere', { usd: usd(cargo.elsewhereUsd) })}
            </p>
          )}
          {cargo.grossUsd > 0.004 && (
            <p className="font-mono font-bold text-good" data-testid="balance-unpriced-result">
              {t('balUnpricedResult', { usd: usd(balance.unpricedCargoUsd) })}
            </p>
          )}
          {/* Kassa-less costs are COUNTED here (the owner's decision 2, «told,
              not asked»): the queue line below takes the same money off, so
              naming the kassa later moves neither figure — said, because two
              lines holding one cost read like a double count otherwise. */}
          {costsOut.count > 0 && cargo.grossUsd > 0.004 && (
            <p className="text-xs text-ink-500" data-testid="balance-unpriced-queue">
              {t('balUnpricedQueueIn')}
            </p>
          )}
          {canList && (
            <div>
              <Link
                href="/finance/narxsiz"
                className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline"
                data-testid="balance-unpriced-list"
              >
                {t('balUnpricedList')}
              </Link>
              <p className="text-xs text-ink-500">{t('balUnpricedListHint')}</p>
            </div>
          )}
          <ul className="space-y-1 border-t border-line pt-2 text-xs text-ink-700" data-testid="balance-unpriced-left-out">
            {cargo.unclaimed.usd > 0.004 && (
              <li>
                <Link href="/unclaimed" className="inline-flex min-h-11 items-center underline">
                  {t('balUnpricedUnclaimed', { usd: usd(cargo.unclaimed.usd), prixods: cargo.unclaimed.prixods })}
                </Link>
              </li>
            )}
            {cargo.oldNoKassa.count > 0 && (
              <li>
                {canAccounts ? (
                  <Link href="/accounting/accounts" className="inline-flex min-h-11 items-center underline">
                    {t('balUnpricedOldCosts', { count: cargo.oldNoKassa.count, usd: usd(cargo.oldNoKassa.usd) })}
                  </Link>
                ) : (
                  t('balUnpricedOldCosts', { count: cargo.oldNoKassa.count, usd: usd(cargo.oldNoKassa.usd) })
                )}
              </li>
            )}
            {cargo.tillUnrated.count > 0 && (
              <li className="text-warn">
                {canFx ? (
                  <Link href="/admin/fx" className="inline-flex min-h-11 items-center underline">
                    {t('balUnpricedTillUnrated', { count: cargo.tillUnrated.count, usd: usd(cargo.tillUnrated.usd) })}
                  </Link>
                ) : (
                  t('balUnpricedTillUnrated', { count: cargo.tillUnrated.count, usd: usd(cargo.tillUnrated.usd) })
                )}
              </li>
            )}
            {cargo.noDebt.count > 0 && (
              <li>{t('balUnpricedNoDebt', { count: cargo.noDebt.count, usd: usd(cargo.noDebt.usd) })}</li>
            )}
            {cargo.pickupNoBox.count > 0 && (
              <li>{t('balUnpricedPickup', { count: cargo.pickupNoBox.count, usd: usd(cargo.pickupNoBox.usd) })}</li>
            )}
            {cargo.noBox.count > 0 && (
              <li>{t('balUnpricedNoBox', { count: cargo.noBox.count, usd: usd(cargo.noBox.usd) })}</li>
            )}
            {cargo.unconverted > 0 && <li>{t('balUnpricedUnconverted', { count: cargo.unconverted })}</li>}
            {/* Handed over before the ban: out of the read altogether (a
                scope, not a filter), so there is no figure to print here —
                `pnpm balans-hisobot` prints it on deploy morning. */}
            {cargo.gate === 'on' && cargo.gateSince ? (
              <li className="text-ink-500" data-testid="balance-unpriced-before-gate">
                {canList ? (
                  <Link href="/finance/narxsiz" className="inline-flex min-h-11 items-center underline">
                    {t('balUnpricedBeforeGate', { date: tashkentMinute(new Date(cargo.gateSince)) })}
                  </Link>
                ) : (
                  t('balUnpricedBeforeGate', { date: tashkentMinute(new Date(cargo.gateSince)) })
                )}
              </li>
            ) : (
              <li className="font-semibold text-warn" data-testid="balance-unpriced-gate-off">
                {t('balUnpricedGateOff')}
              </li>
            )}
          </ul>
        </section>
      )}

      {/* A due rent or salary in a currency with no rate is OUT of the
          arrears line — named in its own money, never counted as $0 (U14). */}
      {balance.recurringArrearsUnrated.length > 0 && (
        <p className="text-xs font-semibold text-warn" data-testid="balance-recurring-unrated">
          ⚠{' '}
          {t('balRecurringUnrated', {
            sums: balance.recurringArrearsUnrated
              .map((row) => `${row.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${row.currency}`)
              .join(', '),
          })}
        </p>
      )}

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
