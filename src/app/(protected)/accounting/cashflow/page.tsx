import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { cashReconciliation, type ReconLineKey } from '@/modules/wms/accounting/reports';
import { resolvePeriod, toUzs, uzsRate } from '@/modules/wms/accounting/period';
import { PeriodForm } from '../period-form';
import { PageHeader } from '@/components/ui/page';

/**
 * Money that actually moved, and how the kassas got from where they stood on
 * the first day to where they stand on the last (audit U13). The kassa block
 * used to print today's all-time balances beside a period's movements — no
 * opening, no closing, no date — so «boshida + kirim − chiqim = oxirida» could
 * be done nowhere. Now it is the period's own table, and every dollar the
 * cash flow and the kassas disagree about is a named line.
 */
export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.reports')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const { from, to } = resolvePeriod(await searchParams);
  const [recon, rate] = await Promise.all([cashReconciliation(from, to), uzsRate()]);
  const flow = recon.flow;

  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (value: number) => `${value < 0 ? '−' : '+'}${usd(Math.abs(value))}`;
  const native = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  // Known keys are translated; an expense CATEGORY name comes through as its
  // own text, because the owner named it and it needs no second name.
  const KNOWN = ['clientPayments', 'cargoCosts', 'partnerIn', 'partnerOut', 'clientRefunds'];
  const label = (key: string) => (KNOWN.includes(key) ? t(key as 'clientPayments') : key);
  // A literal map, never a key built at runtime: a missing key throws at
  // render, and only literal keys are fenced by the bundle tripwire (#163).
  const LINE_LABEL: Record<ReconLineKey, string> = {
    countedInPeriod: t('reconCountedInPeriod'),
    noKassaPayments: t('reconNoKassaPayments'),
    queuedCosts: t('reconQueuedCosts'),
    historyCosts: t('reconHistoryCosts'),
    noKassaExpenses: t('reconNoKassaExpenses'),
    beforeOpening: t('reconBeforeOpening'),
    tillOnly: t('reconTillOnly'),
    oneSidedTransfers: t('reconOneSidedTransfers'),
    unratedTills: t('reconUnratedTills'),
    fx: t('reconFx'),
  };
  const canFx = actor.permissions.has('costs.fx.manage');

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="exchange" title={t('cashflow')} />
      <PeriodForm from={from} to={to} exportHref="/api/accounting/cashflow" />

      <div className="card !p-0">
        <table className="w-full text-sm">
          <tbody>
            {flow.rows.map((row, index) => (
              <tr key={`${row.label}-${index}`} className="border-b border-line">
                <td className="p-2">
                  {row.kind === 'in' ? '⬅️' : '➡️'} {label(row.label)}
                  {/* The accountant's queue (0101) — the SAME predicate the
                      queue, the home counter and the Balans read (U23), so
                      this figure can be worked off to zero from the screen
                      it links to. */}
                  {row.label === 'cargoCosts' && flow.cargoQueuedUsd > 0 && (
                    <Link
                      href="/accounting/xarajat-kassa"
                      className="block text-xs text-warn underline"
                      data-testid="cashflow-cargo-unplaced"
                    >
                      ⚠ {t('cargoUnplaced', { usd: usd(flow.cargoQueuedUsd) })}
                    </Link>
                  )}
                  {/* The kassa-less rest nobody will be asked about: history
                      from before kassas were asked for, and duplicates merged
                      with an expense that named none. Said, not linked — no
                      screen can place it. */}
                  {row.label === 'cargoCosts' && flow.cargoKassaUnknownUsd > 0 && (
                    <span className="block text-xs text-ink-500" data-testid="cashflow-cargo-unknown">
                      {t('cargoKassaUnknown', { usd: usd(flow.cargoKassaUnknownUsd) })}
                    </span>
                  )}
                  {/* A cost whose currency has no rate adds $0 above (U24).
                      Named in its own money, never guessed. */}
                  {row.label === 'cargoCosts' && flow.unconverted.count > 0 && (
                    <span className="block text-xs text-warn" data-testid="cashflow-unconverted">
                      ⚠{' '}
                      {t('gapUnconverted', {
                        count: flow.unconverted.count,
                        sums: flow.unconverted.byCurrency
                          .map((entry) => `${native(entry.amount)} ${entry.currency}`)
                          .join(', '),
                      })}{' '}
                      {canFx ? (
                        <Link href="/admin/fx" className="underline">
                          {t('gapUnconvertedHint')}
                        </Link>
                      ) : (
                        t('gapUnconvertedHint')
                      )}
                    </span>
                  )}
                </td>
                <td
                  className={`p-2 text-right font-mono ${
                    row.kind === 'in' ? 'text-good' : 'text-bad'
                  }`}
                >
                  {row.kind === 'in' ? '+' : '−'}
                  {usd(row.amountUsd)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-line-strong font-bold">
              <td className="p-2">{t('net')}</td>
              <td
                className={`p-2 text-right font-mono ${
                  flow.net >= 0 ? 'text-good' : 'text-bad'
                }`}
              >
                {usd(flow.net)}
                {rate && (
                  <span className="ml-2 text-xs font-normal text-ink-500">
                    {toUzs(flow.net, rate)?.toLocaleString('en-US')} UZS
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Overheads saved with no kassa and no payer (U13, the owner's answer
          A): counted in the outflow above — they were spent — and moved no
          drawer. New ones are refused at the door; these are named. */}
      {flow.cashOpexNoKassaCount > 0 && (
        <p className="text-xs font-semibold text-warn" data-testid="cashflow-opex-no-kassa">
          ⚠ {t('cashOpexNoKassa', { count: flow.cashOpexNoKassaCount, usd: `$${usd(flow.cashOpexNoKassaUsd)}` })}
        </p>
      )}

      {flow.transferCount > 0 && (
        <p className="text-xs text-ink-500">
          ℹ️ {t('transfersExcluded', { n: flow.transferCount })}
        </p>
      )}

      <section className="space-y-2" data-testid="cashflow-recon">
        <p className="section-title">🏦 {t('reconTitle')}</p>
        <div className="card !p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                  <th className="p-2">{t('account')}</th>
                  <th className="p-2 text-right">{t('reconOpen')}</th>
                  <th className="p-2 text-right">{t('inflow')}</th>
                  <th className="p-2 text-right">{t('outflow')}</th>
                  <th className="p-2 text-right">{t('reconClose')}</th>
                </tr>
              </thead>
              <tbody>
                {recon.kassas.map((kassa) => (
                  <tr key={kassa.id} className="border-b border-line last:border-0" data-testid="recon-kassa">
                    <td className={`p-2 ${kassa.active ? '' : 'text-ink-500'}`}>
                      <span className="font-semibold">{kassa.name}</span>
                      {/* Retired and still holding money: counted by the
                          Balans, so listed here too (#428, U13). */}
                      {!kassa.active && (
                        <span className="ml-1 text-xs text-warn">⚠ {t('retiredTill')}</span>
                      )}
                      {kassa.countedInPeriod !== 0 && kassa.openingDate && (
                        <span className="block text-[11px] text-ink-500">
                          {t('reconCounted', { date: kassa.openingDate, amount: native(kassa.countedInPeriod) })}
                        </span>
                      )}
                      {kassa.beforeOpeningInPeriod > 0 && (
                        <span className="block text-[11px] text-warn">
                          ⚠ {t('beforeOpening', { count: kassa.beforeOpeningInPeriod })}
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-right font-mono text-ink-700">{native(kassa.opening)}</td>
                    <td className="p-2 text-right font-mono text-good">+{native(kassa.inflow)}</td>
                    <td className="p-2 text-right font-mono text-bad">−{native(kassa.outflow)}</td>
                    {/* The box's OWN money: the figure somebody counts in the drawer. */}
                    <td className={`p-2 text-right font-mono font-bold ${kassa.closing < -0.009 ? 'text-bad' : ''}`}>
                      {native(kassa.closing)} {kassa.currency}
                      {kassa.closing < -0.009 && (
                        <span className="block text-[11px] font-normal">⚠ {t('tillNegative')}</span>
                      )}
                      {kassa.closingUsd === null && (
                        <span className="block text-[11px] font-normal text-warn">⚠ {t('noRate')}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {recon.kassas.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-3 text-center text-ink-500">
                      —
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card !p-0">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-line font-semibold">
                <td className="p-2">{t('reconOpeningUsd')}</td>
                <td className="p-2 text-right font-mono" data-testid="recon-opening">
                  ${usd(recon.openingUsd)}
                </td>
              </tr>
              <tr className="border-b border-line">
                <td className="p-2">{t('reconNetFlow')}</td>
                <td className="p-2 text-right font-mono">{signed(recon.netFlowUsd)}</td>
              </tr>
              {recon.lines.map((line) => (
                <tr key={line.key} className="border-b border-line" data-testid={`recon-${line.key}`}>
                  <td className="p-2 text-ink-700">{LINE_LABEL[line.key]}</td>
                  <td className="p-2 text-right font-mono text-ink-700">{signed(line.usd)}</td>
                </tr>
              ))}
              {Math.abs(recon.unexplained) > 0.004 && (
                <tr className="border-b border-line text-bad" data-testid="recon-unexplained">
                  <td className="p-2">⚠ {t('reconUnexplained')}</td>
                  <td className="p-2 text-right font-mono">{signed(recon.unexplained)}</td>
                </tr>
              )}
              <tr className="border-t-2 border-line-strong font-bold">
                <td className="p-2">{t('reconClosingUsd')}</td>
                <td className="p-2 text-right font-mono" data-testid="recon-closing">
                  ${usd(recon.closingUsd)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {recon.unratedTills.length > 0 && (
          <p className="text-xs text-warn">
            ⚠{' '}
            {t('reconUnrated', {
              sums: recon.unratedTills.map((row) => `${native(row.closing)} ${row.currency}`).join(', '),
            })}
          </p>
        )}
        <p className="text-xs text-ink-500">{t('reconHint')}</p>
      </section>
    </div>
  );
}
