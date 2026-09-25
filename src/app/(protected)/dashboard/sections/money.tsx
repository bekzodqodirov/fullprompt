import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { agingTotals, balanceLines, unplacedCostsTakenOff } from '@/modules/wms/accounting/balance-lines';
import {
  loadAging,
  loadBalance,
  loadCashByMonth,
  loadPnl12,
  loadTrips,
  loadUnbilled,
  loadWindows,
} from '@/modules/wms/reports/dashboard';
import { daysSince, niceTicks, tripKind, tripTotals } from '@/modules/wms/reports/dashboard-math';
import { ColumnPairs } from '@/components/charts/column-pairs';
import { DivergingRows } from '@/components/charts/diverging-rows';
import { DivergingBars } from '@/components/charts/diverging-bars';
import { StackBar } from '@/components/charts/stack-bar';
import { Legend, SERIES_BG } from '@/components/charts/legend';
import { TableTwin } from '@/components/charts/table-twin';
import { tipText } from '@/components/charts/tip-text';
import { monthLabel, monthNames } from '@/components/charts/month-names';
import { compactUsd, m3, num, pct, signedUsd, usd } from '@/components/charts/format';

/**
 * «Pul» (spec «C»): month by month, are we billing more than we spend and
 * does the cash follow; what we hold against what we owe; how old the debt
 * is; which trucks earned; and the cargo that arrived with no price on it
 * (owner 8a). Every figure is the exported function of the report its link
 * opens, over the window the link carries (#513).
 *
 * The P&L's month profit and the truck profit are printed SIDE BY SIDE with
 * a sentence each (his 3c): a truck's profit has no calendar month, so the
 * two answer different questions and neither is «the» profit.
 */
export async function MoneySection({ scopeKey, canExpenses }: { scopeKey: string; canExpenses: boolean }) {
  const t = await getTranslations('dashboard');
  const ta = await getTranslations('accounting');
  const names = await monthNames();
  const w = loadWindows();
  const [pnl, cash, balance, aging, trips, unbilled] = await Promise.all([
    loadPnl12(),
    loadCashByMonth(),
    loadBalance(),
    loadAging(),
    loadTrips(),
    loadUnbilled(scopeKey),
  ]);

  // ── C1 / C2: one grammar, one scale ─────────────────────────────────────
  const months = pnl.months;
  const last = months.length - 1;
  const bands = months.map((month, i) => ({
    key: month,
    label: monthLabel(names, month),
    sub: i === last ? t('partialMonth', { day: w.dom }) : undefined,
  }));
  const labelled = new Set(months.map((_, i) => i).filter((i) => (last - i) % 3 === 0));
  const revenue = months.map((m) => pnl.revenue.byPeriod[m] ?? 0);
  const direct = months.map((m) => pnl.directTotal.byPeriod[m] ?? 0);
  const opex = months.map((m) => pnl.opexTotal.byPeriod[m] ?? 0);
  const cost = months.map((_, i) => (direct[i] ?? 0) + (opex[i] ?? 0));
  const net = months.map((m) => pnl.netProfit.byPeriod[m] ?? 0);
  const cashRows = months.map((m) => cash.get(m));
  const inflow = cashRows.map((row) => row?.inflow ?? 0);
  const outflow = cashRows.map((row) => row?.outflow ?? 0);
  const cashNet = cashRows.map((row) => row?.net ?? 0);
  const { ticks, top } = niceTicks(Math.max(1, ...revenue, ...cost, ...inflow, ...outflow));
  const netMax = Math.max(1, ...net.map(Math.abs), ...cashNet.map(Math.abs));
  const margin = (i: number) => ((revenue[i] ?? 0) > 0.009 ? ((net[i] ?? 0) / (revenue[i] ?? 1)) * 100 : null);
  const heading = (i: number) => monthLabel(names, months[i] ?? '', true);
  const pnlTips = months.map((_, i) =>
    tipText(heading(i), [
      [usd(revenue[i] ?? 0), t('sRevenue')],
      [usd(direct[i] ?? 0), t('sDirect')],
      [usd(opex[i] ?? 0), t('sOpex')],
      [`${signedUsd(net[i] ?? 0)}${margin(i) === null ? '' : ` · ${pct(margin(i)!)}`}`, t('sNet')],
    ]),
  );
  const cashTips = months.map((_, i) => {
    const row = cashRows[i];
    return tipText(heading(i), [
      [usd(row?.clientPayments ?? 0), t('sClientPayments')],
      [usd(row?.partnerIn ?? 0), t('sPartnerIn')],
      [usd(row?.cargoCosts ?? 0), t('sCargoCosts')],
      [usd(row?.partnerOut ?? 0), t('sPartnerOut')],
      [usd(row?.clientRefunds ?? 0), t('sRefunds')],
      [usd(row?.cashOpex ?? 0), t('sCashOpex')],
      [signedUsd(row?.net ?? 0), t('sCashNet')],
    ]);
  });
  const range = `from=${w.m12Start}&to=${w.today}`;

  // ── C3: the Balans as a bridge ───────────────────────────────────────────
  const lines = balanceLines(balance, canExpenses ? '/accounting/accounts' : '/accounting/balance');
  const costsOut = unplacedCostsTakenOff(balance);
  const bridge = lines.map((line) => ({
    key: line.key,
    label: line.key === 'balCash' && line.value < 0 ? `⚠ ${t('cashNegative')}` : ta(line.key),
    value: line.value,
    href: line.href,
    testid: `dash-${line.key}`,
  }));
  // The Balans's own list (U14): an EMPTY till with no rate hides nothing.
  const unrated = balance.unratedTills.reduce((sum, row) => sum + row.count, 0);
  const byCurrency = new Map<string, { native: number; usd: number | null }>();
  for (const row of balance.cashRows) {
    const entry = byCurrency.get(row.currency) ?? { native: 0, usd: 0 };
    entry.native += row.balance;
    entry.usd = row.balanceUsd === null || entry.usd === null ? null : entry.usd + row.balanceUsd;
    byCurrency.set(row.currency, entry);
  }
  const tills = [...balance.cashRows].filter((row) => Math.abs(row.balance) > 0.004);
  const positive = tills
    .filter((row) => row.balance > 0)
    .sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0));
  const shown = positive.slice(0, 6);
  const rest = positive.slice(6);
  const negative = tills.filter((row) => row.balance < 0);
  const tillMax = Math.max(1, ...shown.map((row) => row.balanceUsd ?? 0));

  // ── C4: receivables by age ───────────────────────────────────────────────
  const agingSum = agingTotals(aging);
  const ageKeys = ['days0', 'days30', 'days60', 'days90'] as const;
  const ageSeries = ['ord1', 'ord2', 'ord3', 'ord4'] as const;
  const debtorMax = Math.max(1, ...aging.slice(0, 5).map((row) => row.balance));
  const agingDiffers = Math.abs(agingSum.balance - balance.receivableUsd) > 0.01;

  // ── C5: trucks ───────────────────────────────────────────────────────────
  const totals = tripTotals(trips);
  const recent = [...trips]
    .filter((row) => !row.internal)
    .sort((a, b) => new Date(b.departedAt ?? 0).getTime() - new Date(a.departedAt ?? 0).getTime())
    .slice(0, 12);
  const tripRows = recent.map((row) => {
    const kind = tripKind(row);
    return {
      key: row.batchId,
      code: row.code,
      href: `/batches/${row.batchId}`,
      value: kind === 'unpriced' ? null : (row.profitUsd ?? 0),
      sub: (
        <>
          {row.route}
          {row.marginPct !== null && kind !== 'unpriced' && <span> · {pct(row.marginPct)}</span>}
        </>
      ),
      chip:
        kind === 'unpriced' || row.unallocatedUsd > 0.009 ? (
          <span className="flex flex-wrap gap-1">
            {kind === 'unpriced' && (
              <span className="chip-neutral">{t('tripUnpriced', { usd: usd(row.costUsd) })}</span>
            )}
            {row.unallocatedUsd > 0.009 && (
              <span className="chip-warn">{t('tripUnallocated', { usd: usd(row.unallocatedUsd) })}</span>
            )}
          </span>
        ) : undefined,
    };
  });

  // ── 8a: arrived, not billed ──────────────────────────────────────────────
  const unbilledBoxes = unbilled.reduce((sum, row) => sum + row.boxes, 0);
  const unbilledM3 = unbilled.reduce((sum, row) => sum + row.m3, 0);
  const waited = (since: Date) => daysSince(since, w.today);

  return (
    <section data-testid="section-moneyTitle" className="space-y-3">
      <p className="section-title">💰 {t('moneyTitle')}</p>

      <div className="grid gap-3 xl:grid-cols-2">
        {/* C1 — the P&L, month by month. */}
        <div className="card min-w-0 space-y-2" data-testid="dash-pnl">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold">{t('pnlTitle')}</p>
            <Link href={`/accounting/pnl?${range}`} className="shrink-0 text-xs font-semibold text-brand-700">
              P&amp;L →
            </Link>
          </div>
          <Legend
            items={[
              { key: 'in', label: t('sRevenue') },
              { key: 'out', label: t('sCost') },
            ]}
          />
          <ColumnPairs
            months={bands}
            a={{ values: revenue }}
            b={{ values: cost }}
            net={net}
            top={top}
            ticks={ticks}
            netMax={netMax}
            tips={pnlTips}
            labelled={labelled}
            netLabel={t('sNet')}
            testid="dash-pnl-chart"
          />
          <p className="text-2xs text-ink-500">{t('pnlNote')}</p>
          <TableTwin
            summary={t('table')}
            testid="dash-pnl-table"
            head={['', t('sRevenue'), t('sDirect'), t('sOpex'), t('sNet'), t('sMargin')]}
            rows={months.map((month, i) => [
              heading(i),
              usd(revenue[i] ?? 0),
              usd(direct[i] ?? 0),
              usd(opex[i] ?? 0),
              <span key="n" className={(net[i] ?? 0) < 0 ? 'text-bad' : ''}>
                {signedUsd(net[i] ?? 0)}
              </span>,
              margin(i) === null ? '—' : pct(margin(i)!),
            ])}
          />
        </div>

        {/* C2 — the cash that actually moved, on the SAME scale. */}
        <div className="card min-w-0 space-y-2" data-testid="dash-cash">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold">{t('cashTitle')}</p>
            <Link href={`/accounting/cashflow?${range}`} className="shrink-0 text-xs font-semibold text-brand-700">
              {t('cashLink')} →
            </Link>
          </div>
          <Legend
            items={[
              { key: 'in', label: t('sInflow') },
              { key: 'out', label: t('sOutflow') },
            ]}
          />
          <ColumnPairs
            months={bands}
            a={{ values: inflow }}
            b={{ values: outflow }}
            net={cashNet}
            top={top}
            ticks={ticks}
            netMax={netMax}
            tips={cashTips}
            labelled={labelled}
            netLabel={t('sCashNet')}
            testid="dash-cash-chart"
          />
          <p className="text-2xs text-ink-500">
            {t('sameScale')} {t('cashNote')}
          </p>
          <TableTwin
            summary={t('table')}
            testid="dash-cash-table"
            head={['', t('sInflow'), t('sOutflow'), t('sCashNet')]}
            rows={months.map((month, i) => [
              heading(i),
              usd(inflow[i] ?? 0),
              usd(outflow[i] ?? 0),
              <span key="n" className={(cashNet[i] ?? 0) < 0 ? 'text-bad' : ''}>
                {signedUsd(cashNet[i] ?? 0)}
              </span>,
            ])}
          />
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* C3 — what we hold against what we owe. */}
        <div className="card min-w-0 space-y-2" data-testid="dash-balance">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold">{t('balanceTitle')}</p>
            <Link href="/accounting/balance" className="shrink-0 text-xs font-semibold text-brand-700">
              {ta('balance')} →
            </Link>
          </div>
          <Legend
            items={[
              { key: 'in', label: t('weHave') },
              { key: 'out', label: t('weOwe') },
            ]}
          />
          <DivergingRows
            rows={bridge}
            net={{ label: ta('balNet'), value: balance.netUsd, href: '/accounting/balance' }}
            testid="dash-balance-rows"
          />
          {unrated > 0 && <p className="text-2xs text-warn">⚠ {t('unratedTills', { n: unrated })}</p>}
          {costsOut.count > 0 && (
            <Link href="/accounting/xarajat-kassa" className="block text-2xs text-warn underline">
              ⚠ {ta('balUnplacedCosts', { count: costsOut.count, usd: num(costsOut.usd, 2) })}
            </Link>
          )}
          {balance.unplacedCostInCountCount > 0 && (
            <Link href="/accounting/xarajat-kassa" className="block text-2xs text-ink-500 underline">
              ℹ️{' '}
              {ta('balUnplacedCostsInCount', {
                count: balance.unplacedCostInCountCount,
                usd: num(balance.unplacedCostInCountUsd, 2),
              })}
            </Link>
          )}
          <details className="group" data-testid="dash-tills">
            <summary className="cursor-pointer text-xs font-semibold text-brand-700">
              {t('tillsFold', { n: balance.cashRows.length })}
            </summary>
            <ul className="mt-2 space-y-0.5 text-xs">
              {[...byCurrency.entries()].map(([currency, entry]) => (
                <li key={currency} className="flex justify-between gap-2 font-mono tabular-nums">
                  <span className="text-ink-500">{currency}</span>
                  <span>
                    {num(entry.native, 2)}
                    {currency !== 'USD' && (
                      <span className="text-ink-500"> ≈ {entry.usd === null ? t('noRate') : usd(entry.usd)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <ul className="mt-2 space-y-1.5">
              {shown.map((row) => (
                <li key={row.id} className="min-w-0 text-xs">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {row.name}
                      {row.retired && <span className="text-warn"> ⚠ {t('retiredWithMoney')}</span>}
                    </span>
                    <span className="whitespace-nowrap font-mono tabular-nums">
                      {num(row.balance, 2)} {row.currency}
                      {row.currency !== 'USD' && row.balanceUsd !== null && (
                        <span className="text-ink-500"> ≈ {usd(row.balanceUsd)}</span>
                      )}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1 rounded-full bg-surface-sunken">
                    <div
                      className={`h-1 rounded-full ${SERIES_BG.in}`}
                      style={{ width: `${((row.balanceUsd ?? 0) / tillMax) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
              {negative.map((row) => (
                <li key={row.id} className="flex items-baseline gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className="whitespace-nowrap font-mono tabular-nums text-bad">
                    {num(row.balance, 2)} {row.currency}
                  </span>
                </li>
              ))}
            </ul>
            {rest.length > 0 && (
              <p className="mt-1 text-2xs text-ink-500">
                {t('tillsMore', { n: rest.length, usd: usd(rest.reduce((sum, row) => sum + (row.balanceUsd ?? 0), 0)) })}
              </p>
            )}
          </details>
        </div>

        {/* C4 — how old the debt is. */}
        <div className="card min-w-0 space-y-2" data-testid="dash-aging">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold">{t('agingTitle')}</p>
            <Link href="/accounting/receivables" className="shrink-0 text-xs font-semibold text-brand-700">
              {ta('receivables')} →
            </Link>
          </div>
          <p>
            <span className="font-mono text-xl font-bold tabular-nums">{usd(balance.receivableUsd)}</span>{' '}
            <span className="text-xs text-ink-500">{t('debtors', { n: aging.length })}</span>
          </p>
          <StackBar
            testid="dash-aging-bar"
            parts={agingSum.buckets.map((value, i) => ({
              key: ageSeries[i] ?? 'ord4',
              value,
              tip: tipText(ta(ageKeys[i] ?? 'days90'), [[usd(value), '']]),
            }))}
          />
          <ul className="grid grid-cols-1 gap-x-3 gap-y-1 text-2xs sm:grid-cols-2">
            {agingSum.buckets.map((value, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-sm ${SERIES_BG[ageSeries[i] ?? 'ord4']}`} />
                <span className="min-w-0 flex-1 truncate text-ink-500">{ta(ageKeys[i] ?? 'days90')}</span>
                <span
                  className={`whitespace-nowrap font-mono tabular-nums ${
                    i === 3 && value > 0.5 ? 'font-semibold text-bad' : i === 2 && value > 0.5 ? 'text-warn' : ''
                  }`}
                >
                  {compactUsd(value)}
                  {agingSum.balance > 0 && (
                    <span className="text-ink-500"> · {pct((value / agingSum.balance) * 100)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="pt-1 text-xs font-semibold text-ink-700">{t('topDebtors')}</p>
          <ul className="space-y-1.5">
            {aging.slice(0, 5).map((row) => {
              const oldest = row.buckets[3]! > 0.009 ? 3 : row.buckets[2]! > 0.009 ? 2 : -1;
              return (
                <li key={row.clientId}>
                  <Link href={`/finance/${row.clientId}`} className="block min-w-0 rounded hover:bg-surface-sunken">
                    <div className="flex items-baseline gap-2 text-xs">
                      <span className="shrink-0 font-mono font-bold text-brand-700">{row.clientCode}</span>
                      <span className="min-w-0 flex-1 truncate text-ink-700">{row.clientName}</span>
                      {oldest === 3 && <span className="chip-bad shrink-0">{t('age90')}</span>}
                      {oldest === 2 && <span className="chip-warn shrink-0">{t('age60')}</span>}
                      <span className="whitespace-nowrap font-mono tabular-nums">{usd(row.balance)}</span>
                    </div>
                    <div className="mt-0.5 h-1 rounded-full bg-surface-sunken">
                      <div
                        className={`h-1 rounded-full ${SERIES_BG.ord3}`}
                        style={{ width: `${(row.balance / debtorMax) * 100}%` }}
                      />
                    </div>
                  </Link>
                </li>
              );
            })}
            {aging.length === 0 && <li className="text-xs text-ink-500">{t('noDebt')}</li>}
          </ul>
          {agingDiffers && <p className="text-2xs text-warn">⚠ {t('agingDiffers')}</p>}
        </div>
      </div>

      {/* C5 — which trucks earned, over twelve months of departures. */}
      <div className="card min-w-0 space-y-2" data-testid="dash-trips">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-semibold">{t('tripsTitle')}</p>
          <Link
            href={`/accounting/profit?view=batch&${range}`}
            className="shrink-0 text-xs font-semibold text-brand-700"
          >
            {t('tripsLink')} →
          </Link>
        </div>
        <dl className="grid grid-cols-3 gap-2 text-center lg:grid-cols-6" data-testid="dash-trips-strip">
          <TripStat label={t('tripCount')} value={num(totals.trips)} />
          <TripStat
            label={t('tripProfit')}
            value={compactUsd(totals.profit)}
            tone={totals.profit < 0 ? 'text-bad' : ''}
          />
          <TripStat label={t('tripMargin')} value={totals.marginPct === null ? '—' : pct(totals.marginPct)} />
          <TripStat label={t('tripPerKg')} value={totals.perKg === null ? '—' : `$${num(totals.perKg, 2)}`} />
          <TripStat label={t('tripLosses')} value={num(totals.losses)} tone={totals.losses > 0 ? 'text-bad' : ''} />
          <TripStat
            label={t('tripUnpricedCount')}
            value={num(totals.unpriced)}
            tone={totals.unpriced > 0 ? 'text-warn' : ''}
          />
        </dl>
        <p className="text-2xs text-ink-500">
          {t('tripsNote')}
          {totals.internal > 0 && <> {t('tripsInternal', { n: totals.internal })}</>}
        </p>
        {tripRows.length > 0 ? (
          <DivergingBars rows={tripRows} testid="dash-trips-bars" />
        ) : (
          <p className="text-xs text-ink-500">{t('noTrips')}</p>
        )}
        <TableTwin
          summary={t('table')}
          testid="dash-trips-table"
          head={['', t('sRevenue'), t('sCost'), t('sPrev'), t('sNet'), t('sMargin'), '$/kg']}
          rows={recent.map((row) => [
            row.code,
            usd(row.revenueUsd),
            usd(row.costUsd),
            usd(row.prevUsd),
            row.profitUsd === null ? '—' : signedUsd(row.profitUsd),
            row.marginPct === null ? '—' : pct(row.marginPct),
            row.profitPerKg === null ? '—' : num(row.profitPerKg, 2),
          ])}
        />
      </div>

      {/* 8a — cargo that reached Uzbekistan with no price covering it. */}
      <div id="narxsiz" className="card min-w-0 space-y-2 scroll-mt-20" data-testid="dash-unbilled">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <p className="font-semibold">{t('unbilledTitle')}</p>
          {unbilled.length > 0 && (
            <span className="chip-bad shrink-0">
              {t('unbilledSummary', { n: unbilled.length, boxes: num(unbilledBoxes), m3: m3(unbilledM3) })}
            </span>
          )}
        </div>
        <p className="text-2xs text-ink-500">{t('unbilledNote')}</p>
        {unbilled.length === 0 ? (
          <p className="text-xs text-ink-500">{t('unbilledNone')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {unbilled.slice(0, 15).map((row) => {
              const days = waited(row.firstArrivedAt);
              return (
                <li key={row.clientId} data-testid="unbilled-row">
                  <Link href={`/finance/${row.clientId}`} className="block py-1.5 hover:bg-surface-sunken">
                    <div className="flex items-baseline gap-2 text-sm">
                      <span className="shrink-0 font-mono font-bold text-brand-700">{row.clientCode}</span>
                      <span className="min-w-0 flex-1 truncate text-ink-700">{row.name}</span>
                      <span className={`shrink-0 ${days >= 7 ? 'chip-warn' : 'chip-neutral'}`}>{t('daysWaiting', { n: days })}</span>
                    </div>
                    <p className="mt-0.5 text-2xs text-ink-500">
                      {t('unbilledLine', { receipts: row.receipts, boxes: num(row.boxes), m3: m3(row.m3), kg: num(row.kg) })}
                      {row.issuedBoxes > 0 && (
                        <span className="font-semibold text-bad"> · {t('unbilledIssued', { n: row.issuedBoxes })}</span>
                      )}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {unbilled.length > 15 && (
          <p className="text-2xs text-ink-500">{t('moreRows', { n: unbilled.length - 15 })}</p>
        )}
      </div>
    </section>
  );
}

function TripStat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-sunken px-1.5 py-1.5">
      <dt className="truncate text-2xs text-ink-500">{label}</dt>
      <dd className={`whitespace-nowrap font-mono text-sm font-bold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}
