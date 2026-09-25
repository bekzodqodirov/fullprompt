import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { seesCompanyMoney } from '@/modules/wms/finance/scope';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { cashFlow, companyBalance } from '@/modules/wms/accounting/reports';
import { moneySnapshot, todaySnapshot } from '@/modules/wms/reports/overview';
import { inTransitBatches, stockByWarehouse, warehouseFill } from '@/modules/wms/reports/queries';
import { cargoPipeline } from '@/modules/wms/reports/business';
import { targetsFor } from '@/modules/wms/accounting/targets';
import { dashboardWindows, planProgress } from '@/modules/wms/reports/dashboard-math';
import { PlanMeter } from '@/components/charts/plan-meter';
import { StackBar } from '@/components/charts/stack-bar';
import { getSetting } from '@/modules/platform/settings/service';
import { WarehouseFillRows } from '@/components/warehouse-fill';
import { decidedLeadCounts } from '@/modules/wms/crm/analytics';
import { openDealsSummary } from '@/modules/wms/deals/service';
import { taskPulse } from '@/modules/platform/tasks/analytics';
import { notificationProblemCount } from '@/modules/platform/notifications/service';
import { backupStatus, type BackupStatus } from '@/modules/platform/backup/objects';
import { addDays, tashkentDay, tashkentDayStart, tashkentMonth, tashkentMonthStart } from '@/modules/platform/time/tashkent';

/**
 * The owner's own morning screen (round 107, item 4: «admin uchun glavnida
 * dashboard kerak … firmani holatini bilish uchun kerak bo'lgan hamma
 * narsa», his «ha yetarli» on this exact block list). Every working role
 * wakes to its day; the admin's day is the company.
 *
 * Rendered ONLY when `buildHomeFlow` returned null and the actor carries the
 * admin/super_admin ROLE — an admin who also holds a working role keeps that
 * working home (narrowest job wins, round 15's rule; stated to the owner).
 * Every number is an existing screen's own exported function, so the cell
 * and the screen it links can never argue (#513) — and each block asks its
 * destination's PERMISSION too, because role grants are editable data and a
 * home cell must never show money behind a link that bounces (round 91).
 *
 * Reads no searchParams and exposes no action — #514 satisfied by
 * construction. The whole fetch lives inside this component, so nobody but
 * the admin pays a millisecond for it (~30 grouped statements, the
 * round-45 discipline).
 *
 * Shape (his «chroyliroq ihcham»): each block's HEADER is itself a link
 * carrying the block's headline figure — the kassa total, the stock m³, the
 * open-deals pair — pointing at the exact screen whose exported function
 * produced it, so the two rows that only restated a header are gone. Values
 * never wrap (label truncates instead — a nowrap value wider than the card
 * is #400's page rescale), money stays the only mono ink, and colour still
 * means urgency alone: the signal dots repeat the word's tone for a glance,
 * they never replace it. The open-deals other-currency count keeps its own
 * line — folding it into the hero overflows 360, dropping it un-fixes
 * round 107's «USD sum must name what it excludes».
 */

const round2 = (value: number) => Math.round(value * 100) / 100;
// Sign before the $: a drained kassa must read «−$1,875», never «$-1,875».
// Call sites that write their own +/− pass magnitudes, so no sign doubles.
const usd = (value: number) => {
  const rounded = Math.round(value);
  return `${rounded < 0 ? '−' : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
};
const num = (value: number) => Math.round(value).toLocaleString('en-US');

export async function AdminDashboard({ actor }: { actor: Actor }) {
  const t = await getTranslations('adminHome');
  const td = await getTranslations('dashboard');
  const perms = actor.permissions;
  // The dashboard's own predicate (#513) — the VED fails it (Q19).
  const money = seesCompanyMoney(actor);
  const cargo = mayReadBatches(perms);
  const sales = perms.has('crm.manage');
  // Tashkent's day and month (R5) — the same ones `salesSnapshot` and the
  // money snapshot count by, so this home and /dashboard name the same month.
  const today = tashkentDay();
  const monthStart = tashkentMonthStart();
  const nextMonthStart = `${addDays(`${tashkentMonth()}-28`, 4).slice(0, 7)}-01`;

  // «Qaysi sklad qanchalik to'lgan va yuk necha kun qolib ketgan» (owner,
  // 2026-08-25). Behind the CARGO permission the block links through, and
  // scoped like every other read — an admin whose grants were trimmed to one
  // warehouse must not read the others off the home screen.
  const staleDays = Number(await getSetting('stale_stock_days')) || 30;
  const whScope = actor.warehouseScoped ? actor.warehouseIds : undefined;

  const w = dashboardWindows(today);
  const [balance, flowToday, moneySnap, cargoToday, stock, transit, fills, deals, decided, tasks, unsent, backup, targets, pipeline] =
    await Promise.all([
      money ? companyBalance() : null,
      money ? cashFlow(today, today) : null,
      money ? moneySnapshot() : null,
      cargo ? todaySnapshot() : null,
      cargo ? stockByWarehouse() : null,
      cargo ? inTransitBatches() : null,
      cargo ? warehouseFill(whScope, staleDays) : null,
      sales ? openDealsSummary() : null,
      sales
        ? decidedLeadCounts(tashkentDayStart(monthStart), tashkentDayStart(nextMonthStart))
        : null,
      perms.has('reports.all_warehouses') ? taskPulse(new Date()) : null,
      perms.has('admin.audit.browse') ? notificationProblemCount(7) : null,
      perms.has('admin.settings.manage')
        ? backupStatus().catch((): BackupStatus | null => null)
        : null,
      // His answer 5a: the month's plan beside the month's figure.
      money ? targetsFor([w.month]) : null,
      // The journey in one bar — the /dashboard's own read (#513).
      cargo ? cargoPipeline() : null,
    ]);
  const plan = moneySnap
    ? planProgress(moneySnap.revenueMonth, targets?.get(w.month)?.revenueUsd, w.dom, w.daysInMonth)
    : null;

  // The kassa figure drops any till whose currency has no entered rate —
  // the balance screen flags those per row, a lone number cannot, so the ⚠
  // travels with it. The Balans's own list (U14), so the two screens ask one
  // predicate and an EMPTY unrated till raises nothing on either.
  const unratedTill = (balance?.unratedTills.length ?? 0) > 0;

  const stockTotals = (stock ?? []).reduce(
    (acc, row) => ({
      boxes: acc.boxes + Number(row.boxCount),
      kg: acc.kg + Number(row.kg),
      m3: acc.m3 + Number(row.m3),
    }),
    { boxes: 0, kg: 0, m3: 0 },
  );
  const transitBoxes = (transit ?? []).reduce((acc, row) => acc + Number(row.boxCount), 0);

  /*
   * Which warehouses belong on the OWNER's home, and in what order — found by
   * looking at the screen rather than by a test.
   *
   * `warehouseFill` returns every active warehouse, deliberately: /dashboard
   * is the analyst's full picture and an empty warehouse missing from it
   * cannot be told from a broken card. On the home screen that same rule
   * printed a row of «0 m³ · sig'im kiritilmagan» for every warehouse nobody
   * uses, and the two or three he actually asked about were somewhere in the
   * middle of it. So the home shows what has cargo or a capacity, fullest
   * first, then whatever is standing in the ones with no capacity typed in —
   * his question, in his order.
   */
  const fillRows = [...(fills ?? [])]
    .filter((row) => row.occupiedM3 > 0 || row.capacityM3 !== null)
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.occupiedM3 - a.occupiedM3);

  // The zaxira signal has THREE states, and day one is the third: with no
  // off-site destination configured the honest word is «sozlanmagan», not a
  // permanent red about a backup that was never switched on (the compose
  // dump still runs nightly; the panel on /admin says all of it).
  const backupState: 'off' | 'ok' | 'stale' | null = backup
    ? backup.destination === null
      ? 'off'
      : backup.lastDump && new Date().getTime() - backup.lastDump.at.getTime() < 26 * 3600_000
        ? 'ok'
        : 'stale'
    : null;

  const blocks = [money, cargo, sales].filter(Boolean).length;
  if (blocks === 0 && !tasks && unsent === null && !backupState) return null;

  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" data-testid="admin-dash">
      {money && balance && flowToday && moneySnap && (
        <section className="card min-w-0 !p-3" data-testid="adm-pul">
          <Head href="/accounting/balance" icon="💰" title={t('money')}>
            {usd(balance.cashUsd)}
            {unratedTill && <span className="text-warn"> ⚠</span>}
          </Head>
          <div className="mt-1 space-y-0.5 text-xs">
            <Row href="/accounting" label={t('todayFlow')}>
              +{usd(flowToday.inflow)} · −{usd(flowToday.outflow)}
              {/* A cost with no rate counts $0 in the day's outflow (U24). */}
              {flowToday.unconverted.count > 0 && <span className="text-warn"> ⚠</span>}
            </Row>
            <Row href="/finance" label={t('debtors')}>
              {usd(moneySnap.receivable)} · {moneySnap.debtors} {t('clientsShort')}
            </Row>
            <Row href="/kontragentlar" label={t('partnerDebt')}>
              −{usd(balance.payableUsd)} · +{usd(balance.partnerReceivableUsd)}
            </Row>
            <Row href="/accounting" label={t('monthMoney')}>
              {usd(moneySnap.revenueMonth)} / {usd(moneySnap.paidMonth)}
            </Row>
            {/* «Paid» is NET of what went back and counts what closed a debt
                in a firm's account — said beside it (U26), each part the
                figure the cash flow and the register print. */}
            <p className="pl-1 text-right text-2xs text-ink-500" data-testid="adm-paid-parts">
              {td('monthPaidParts', {
                till: usd(moneySnap.paidParts.toTill),
                partner: usd(moneySnap.paidParts.viaPartner),
                refunded: usd(moneySnap.paidParts.refunded),
              })}
            </p>
            {plan && (
              <Link
                href="/accounting/reja"
                className="-mx-1 block rounded-lg px-1 py-0.5 hover:bg-surface-sunken"
                data-testid="adm-plan"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-ink-500">{t('plan')}</span>
                  <span
                    className={`whitespace-nowrap font-mono font-semibold tabular-nums ${plan.behind ? 'text-warn' : ''}`}
                  >
                    {Math.round(plan.pct)}%
                  </span>
                </span>
                <PlanMeter progress={plan} className="mt-1" />
              </Link>
            )}
          </div>
        </section>
      )}

      {cargo && cargoToday && (
        <section className="card min-w-0 !p-3" data-testid="adm-yuk">
          <Head href="/stock" icon="📦" title={t('cargo')}>
            {round2(stockTotals.m3)} m³
          </Head>
          {pipeline && (
            <div className="mt-2" data-testid="adm-pipeline">
              <StackBar
                height="h-1.5"
                parts={[
                  { key: 'ord1', value: pipeline.cn.m3 },
                  { key: 'ord2', value: pipeline.road.m3 },
                  { key: 'ord3', value: pipeline.uz.m3 },
                  { key: 'muted', value: pipeline.other.m3 },
                ]}
              />
            </div>
          )}
          <div className="mt-1 space-y-0.5 text-xs">
            <Row href="/stock" label={t('stock')}>
              {num(stockTotals.boxes)} 📦 · {num(stockTotals.kg)} kg
            </Row>
            {/* The boxes still ON the road (the pipeline's own count), not
                what departed: a truck being unloaded drains box by box, and
                the home must agree with /dashboard and /transit meanwhile
                (#440). */}
            <Row href="/transit" label={t('onRoad')}>
              {(transit ?? []).length} {t('trucksShort')} · {num(pipeline?.road.boxes ?? transitBoxes)} 📦
            </Row>
            <Row href="/receipts" label={t('todayReceipts')}>
              {cargoToday.receipts}
            </Row>
          </div>
          {/* His own question, in one glance: how full is each warehouse, and
              how long has its oldest carton been standing there. A warehouse
              with no capacity typed in shows the m³ and says so — every one of
              them is in that state until he fills the numbers in. */}
          {fillRows.length > 0 && (
            <div className="mt-2 border-t border-line pt-2">
              <WarehouseFillRows
                rows={fillRows}
                staleDays={staleDays}
                canEditCapacity={perms.has('admin.warehouses.manage')}
              />
            </div>
          )}
        </section>
      )}

      {sales && deals && decided && (
        <section className="card min-w-0 !p-3" data-testid="adm-savdo">
          <Head href="/bitimlar" icon="🤝" title={t('sales')}>
            {deals.count} · {usd(deals.usdSum)}
          </Head>
          <div className="mt-1 space-y-0.5 text-xs">
            {deals.otherCurrency > 0 && (
              <p className="text-right text-2xs text-ink-500">
                +{deals.otherCurrency} {t('otherCurrency')}
              </p>
            )}
            <Row href="/crm/tahlil" label={t('monthDecided')}>
              <span className="text-good">{decided.won} ✓</span> ·{' '}
              <span className="text-bad">{decided.lost} ✗</span> · {usd(decided.wonUsd)}
              {decided.wonOtherCurrency > 0 && (
                <span className="text-ink-500">
                  {' '}
                  +{decided.wonOtherCurrency} {t('otherCurrency')}
                </span>
              )}
            </Row>
          </div>
        </section>
      )}

      {(perms.has('reports.all_warehouses') || perms.has('reports.own_warehouse')) && (
        <Link
          href="/dashboard"
          className="card flex min-h-11 items-center justify-between gap-2 !p-3 text-sm font-semibold text-brand-700 hover:bg-surface-sunken sm:col-span-2"
          data-testid="adm-dashboard-door"
        >
          <span>📊 {t('fullDashboard')}</span>
          <span aria-hidden>→</span>
        </Link>
      )}

      {(tasks || unsent !== null || backupState) && (
        <section className="card min-w-0 !p-3" data-testid="adm-signal">
          <Head href="/admin" icon="🔔" title={t('signals')} />
          <div className="mt-1 space-y-0.5 text-xs">
            {backupState && (
              <Row
                href="/admin"
                label={t('backup')}
                dot={backupState === 'ok' ? 'good' : backupState === 'off' ? 'warn' : 'bad'}
              >
                {backupState === 'ok' ? (
                  <span className="text-good">✓ {t('backupOk')}</span>
                ) : backupState === 'off' ? (
                  <span className="text-warn">{t('backupOff')}</span>
                ) : (
                  <span className="font-bold text-bad">⚠ {t('backupStale')}</span>
                )}
              </Row>
            )}
            {unsent !== null && (
              <Row href="/admin/notifications" label={t('unsent')} dot={unsent > 0 ? 'warn' : 'good'}>
                <span className={unsent > 0 ? 'font-bold text-warn' : 'text-good'}>{unsent}</span>
              </Row>
            )}
            {tasks && (
              <Row
                href="/reports/vazifalar"
                label={t('overdueTasks')}
                dot={tasks.overdue > 0 ? 'warn' : 'good'}
              >
                <span className={tasks.overdue > 0 ? 'font-bold text-warn' : 'text-good'}>
                  {tasks.overdue}
                </span>{' '}
                · {tasks.dueToday} {t('dueTodayShort')}
              </Row>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The block header IS the block's first fact: emoji in a muted square, the
 * `.section-title` word, and the headline figure — one link to the screen
 * that computed it. Word truncates, figure never wraps.
 */
function Head({
  href,
  icon,
  title,
  children,
}: {
  href: string;
  icon: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="-m-1 flex items-center gap-2 rounded-lg p-1 hover:bg-surface-sunken"
    >
      <span
        aria-hidden
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-base"
      >
        {icon}
      </span>
      <h2 className="section-title min-w-0 flex-1 truncate">{title}</h2>
      {children !== undefined && (
        <span className="whitespace-nowrap font-mono text-lg font-bold tabular-nums">
          {children}
        </span>
      )}
    </Link>
  );
}

// A literal map — Tailwind compiles only classes it can see.
const DOT: Record<'good' | 'warn' | 'bad', string> = {
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
};

function Row({
  href,
  label,
  dot,
  children,
}: {
  href: string;
  label: string;
  /** Repeats the value's tone for a glance down the signal list — never carries it alone. */
  dot?: 'good' | 'warn' | 'bad';
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="-mx-1 flex items-baseline justify-between gap-2 rounded-lg px-1 py-0.5 hover:bg-surface-sunken"
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        {dot && (
          <span aria-hidden className={`h-2 w-2 shrink-0 self-center rounded-full ${DOT[dot]}`} />
        )}
        <span className="min-w-0 truncate text-ink-500">{label}</span>
      </span>
      <span className="whitespace-nowrap text-right font-mono font-semibold tabular-nums">
        {children}
      </span>
    </Link>
  );
}
