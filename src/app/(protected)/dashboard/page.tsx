import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { getSetting } from '@/modules/platform/settings/service';
import {
  agingSummary,
  costMissingBatches,
  discrepancySummary,
  inTransitBatches,
  stockByWarehouse,
  unclaimedSummary,
  warehouseFill,
} from '@/modules/wms/reports/queries';
import { moneySnapshot, salesSnapshot, todaySnapshot } from '@/modules/wms/reports/overview';
import { Icon } from '@/components/ui/icon';
import { PageHeader, Stat } from '@/components/ui/page';
import { WarehouseFillRows } from '@/components/warehouse-fill';
import { stageClass } from '../crm/stage-color';

/**
 * The whole company on one screen (owner: "dashboard — butun tizim holati,
 * logistikadan moliyagacha, chiroyli va juda tushunarli").
 *
 * Read top to bottom it answers four questions in order of how often they are
 * asked: what happened today, is the money all right, is anyone working the
 * funnel, and what needs a human. Every block is permission-gated and simply
 * absent for someone who may not see it — a warehouse manager gets the
 * warehouse dashboard this page used to be, and no empty money cards.
 */
export default async function DashboardPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  const ownWh = actor.permissions.has('reports.own_warehouse');
  if (!allWh && !ownWh) {
    redirect(actor.permissions.has('reports.own_clients') ? '/pipeline' : '/');
  }
  const scope = allWh ? undefined : actor.warehouseIds;
  const seesMoney = actor.permissions.has('finance.view') || actor.permissions.has('finance.manage');
  const seesFunnel = actor.permissions.has('crm.leads');
  const seesAllLeads = actor.permissions.has('crm.leads.view_all');

  const t = await getTranslations('dashboard');
  const tf = await getTranslations('finance');
  const tcrm = await getTranslations('crm');
  const format = await getFormatter();
  const staleDays = Number(await getSetting('stale_stock_days')) || 30;
  const canEditWarehouses = actor.permissions.has('admin.warehouses.manage');

  const [fills, stock, transit, unclaimed, aging, flags, costMissing, today, cash, sales] =
    await Promise.all([
      warehouseFill(scope, staleDays),
      stockByWarehouse(scope),
      inTransitBatches(scope),
      unclaimedSummary(scope),
      agingSummary(staleDays, scope),
      discrepancySummary(scope),
      // Costing hygiene (spec 6.9): departed > 3 days with zero cost entries.
      allWh ? costMissingBatches(3) : Promise.resolve([]),
      todaySnapshot(scope),
      seesMoney ? moneySnapshot() : Promise.resolve(null),
      seesFunnel ? salesSnapshot(seesAllLeads ? undefined : actor.id) : Promise.resolve(null),
    ]);

  const totalBoxes = stock.reduce((a, row) => a + row.boxCount, 0);
  const totalM3 = Math.round(stock.reduce((a, row) => a + row.m3, 0) * 10) / 10;
  const money = (value: number) => `$${Math.round(value).toLocaleString('en-US')}`;

  return (
    <div className="mx-auto max-w-lg space-y-5 md:max-w-5xl">
      <div className="flex items-baseline gap-2">
        <PageHeader icon="chart" title={t('title')} />
        <Link href="/reports" className="ml-auto text-sm font-semibold text-brand-700">
          {t('toReports')} →
        </Link>
      </div>

      {/* The headline row: four numbers that say whether today is normal. */}
      <div data-testid="kpi-row" className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Stat href="/stock" label={t('kpiStock')} value={`${totalBoxes} 📦`} tone="brand" />
        <Stat href="/trucks" label={t('kpiOnRoad')} value={transit.length} tone={transit.length ? 'warn' : 'neutral'} />
        {cash ? (
          <Stat
            href="/finance"
            label={t('kpiReceivable')}
            value={money(cash.receivable)}
            tone={cash.receivable > 0 ? 'bad' : 'good'}
          />
        ) : (
          <Stat href="/unclaimed" label={t('unclaimed')} value={unclaimed.receipts} tone={unclaimed.receipts ? 'warn' : 'neutral'} />
        )}
        {sales ? (
          <Stat href="/crm" label={t('kpiOpenLeads')} value={sales.open} tone="brand" />
        ) : (
          <Stat label={t('kpiVolume')} value={`${totalM3} m³`} tone="neutral" />
        )}
      </div>

      {/* --- Today ------------------------------------------------------- */}
      <section data-testid="section-todayTitle" className="space-y-2">
        <p className="section-title">{t('todayTitle')}</p>
        <div className="card grid grid-cols-2 gap-3 md:grid-cols-4">
          <TodayCell icon="inbox" label={t('todayReceipts')} value={today.receipts} />
          <TodayCell icon="truck" label={t('todayDeparted')} value={today.departed} />
          <TodayCell icon="check" label={t('todayArrived')} value={today.arrived} />
          <TodayCell
            icon="alert"
            label={t('todayExpected')}
            value={today.expectedToday}
            warn={today.expectedLate > 0}
            hint={today.expectedLate > 0 ? t('lateCount', { n: today.expectedLate }) : undefined}
            href="/arrivals"
          />
        </div>
      </section>

      {/* --- Money -------------------------------------------------------- */}
      {cash && (
        <section data-testid="section-moneyTitle" className="space-y-2">
          <p className="section-title">{t('moneyTitle')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="card space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-ink-500">{t('monthCharged')}</span>
                <span className="num ml-auto text-xl font-extrabold">{money(cash.revenueMonth)}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-ink-500">{t('monthPaid')}</span>
                <span className="num ml-auto text-xl font-extrabold text-good">
                  {money(cash.paidMonth)}
                </span>
              </div>
              {/* How much of what we billed this month has actually come in.
                  Two numbers side by side hide the answer; a bar does not. */}
              <div className="h-2 overflow-hidden rounded bg-surface-sunken">
                <div
                  className="h-full bg-good"
                  style={{
                    width: `${
                      cash.revenueMonth > 0
                        ? Math.min(100, Math.round((cash.paidMonth / cash.revenueMonth) * 100))
                        : 0
                    }%`,
                  }}
                />
              </div>
              <Link href="/accounting/pnl" className="text-sm font-semibold text-brand-700">
                {t('toPnl')} →
              </Link>
            </div>

            <div className="card space-y-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-ink-500">{tf('totalDebt')}</span>
                <span className="num ml-auto text-xl font-extrabold text-bad">
                  {money(cash.receivable)}
                </span>
              </div>
              <p className="text-xs text-ink-500">
                {t('debtorCount', { n: cash.debtors })}
                {cash.receivableOld > 0 && (
                  <span className="ml-2 font-semibold text-warn">
                    ⚠️ {t('debtOld', { amount: money(cash.receivableOld) })}
                  </span>
                )}
              </p>
              {cash.topDebtors.map((debtor) => (
                <Link
                  key={debtor.clientId}
                  href={`/finance/${debtor.clientId}`}
                  className="flex items-baseline gap-2 text-sm hover:bg-surface-sunken"
                >
                  <span className="font-mono font-bold text-brand-700">{debtor.clientCode}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-700">{debtor.name}</span>
                  <span className="num font-bold text-bad">{money(debtor.balance)}</span>
                </Link>
              ))}
              {cash.topDebtors.length === 0 && (
                <p className="text-sm font-semibold text-good">✅ {t('noDebtors')}</p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* --- Sales -------------------------------------------------------- */}
      {sales && (
        <section data-testid="section-salesTitle" className="space-y-2">
          <p className="section-title">{t('salesTitle')}</p>
          <div className="card space-y-2.5">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-2xl font-extrabold text-brand-700">{sales.open}</p>
                <p className="text-xs text-ink-500">{tcrm('leads')}</p>
              </div>
              <div>
                <p className="text-2xl font-extrabold text-good">{sales.wonMonth}</p>
                <p className="text-xs text-ink-500">{t('wonThisMonth')}</p>
              </div>
              <div>
                <p className={`text-2xl font-extrabold ${sales.dueToday ? 'text-warn' : 'text-ink-400'}`}>
                  {sales.dueToday}
                </p>
                <p className="text-xs text-ink-500">{tcrm('today')}</p>
              </div>
            </div>
            {/* The funnel itself: one bar per open stage, widths in
                proportion, so a pile-up is visible without reading numbers. */}
            <div className="space-y-1">
              {sales.byStage.map((stage) => {
                const max = Math.max(1, ...sales.byStage.map((row) => row.n));
                return (
                  <div key={stage.name} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 truncate text-xs font-semibold">{stage.name}</span>
                    <div className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-surface-sunken">
                      <div
                        className={`h-full rounded ${stageClass(stage.color)}`}
                        style={{ width: `${Math.max(stage.n > 0 ? 6 : 0, (stage.n / max) * 100)}%` }}
                      />
                    </div>
                    <span className="num w-6 shrink-0 text-right text-xs font-bold">{stage.n}</span>
                  </div>
                );
              })}
            </div>
            <Link href="/crm" className="text-sm font-semibold text-brand-700">
              {tcrm('funnel')} →
            </Link>
          </div>
        </section>
      )}

      {/* --- Logistics ---------------------------------------------------- */}
      <section data-testid="section-logisticsTitle" className="space-y-2">
        <p className="section-title">{t('logisticsTitle')}</p>
        <div className="grid gap-3 md:grid-cols-2">
          {fills.length > 0 && (
            <div className="card space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{t('fill')}</p>
              {/* One component, both screens — the owner's home draws the
                  identical rows (#513: two copies of a bar disagree about
                  what a missing capacity means). */}
              <WarehouseFillRows rows={fills} staleDays={staleDays} canEditCapacity={canEditWarehouses} />
            </div>
          )}

          <div className="card space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              📦 {t('stock')}
            </p>
            {stock.map((row) => (
              <div key={row.code} className="flex items-baseline gap-2 text-sm">
                <span className="w-14 font-mono font-extrabold">{row.code}</span>
                <span className="font-semibold">{row.boxCount} 📦</span>
                <span className="num ml-auto text-xs text-ink-700">
                  {row.kg} kg · {row.m3} m³
                </span>
              </div>
            ))}
            {stock.length === 0 && <p className="text-sm text-ink-500">—</p>}
          </div>

          <div className="card space-y-1 md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              🚛 {t('inTransit')}
            </p>
            {transit.map((batch) => (
              <Link
                key={batch.id}
                href={`/batches/${batch.id}`}
                className="flex items-baseline gap-2 text-sm hover:bg-surface-sunken"
              >
                <span className="font-mono font-extrabold text-brand-700">{batch.code}</span>
                <span className="font-mono text-xs">
                  {batch.originCode}→{batch.destCode}
                </span>
                <span className="text-ink-700">{batch.boxCount} 📦</span>
                {batch.departedAt && (
                  <span className="ml-auto text-xs text-ink-500">
                    {format.dateTime(batch.departedAt, { dateStyle: 'short' })}
                  </span>
                )}
              </Link>
            ))}
            {transit.length === 0 && <p className="text-sm text-ink-500">—</p>}
          </div>
        </div>
      </section>

      {/* --- Needs a human ------------------------------------------------ */}
      <section className="space-y-2">
        <p className="section-title">⚠️ {t('attention')}</p>
        <div className="card space-y-2">
          <Link href="/unclaimed" className="flex items-baseline gap-2 text-sm">
            <span>❓ {t('unclaimed')}</span>
            <span className="ml-auto font-bold">
              {unclaimed.receipts} / {unclaimed.boxes} 📦
            </span>
          </Link>
          {aging.map((row) => (
            <div key={row.code} className="flex items-baseline gap-2 text-sm">
              <span>
                🕰 {t('aging', { days: staleDays })} · <b className="font-mono">{row.code}</b>
              </span>
              <span className="ml-auto font-bold text-warn">
                {row.n} 📦 (max {row.worstDays} {t('days')})
              </span>
            </div>
          ))}
          <Link href="/transit" className="flex items-baseline gap-2 text-sm">
            <span>🚨 {t('missingInTransit')}</span>
            <span className={`ml-auto font-bold ${flags.missing > 0 ? 'text-bad' : ''}`}>
              {flags.missing}
            </span>
          </Link>
          <div className="flex items-baseline gap-2 text-sm">
            <span>🌀 {t('undocumented')}</span>
            <span className={`ml-auto font-bold ${flags.undocumented > 0 ? 'text-warn' : ''}`}>
              {flags.undocumented}
            </span>
          </div>
          {costMissing.length > 0 && (
            <div className="space-y-1 border-t border-line pt-2 text-sm">
              <p className="font-semibold text-warn">💸 {t('costMissing')}</p>
              {costMissing.map((batch) => (
                <Link key={batch.id} href={`/batches/${batch.id}`} className="flex gap-2 text-xs">
                  <span className="font-mono font-bold text-brand-700">{batch.code}</span>
                  <span className="font-mono">
                    {batch.originCode}→{batch.destCode}
                  </span>
                  {batch.departedAt && (
                    <span className="ml-auto text-ink-500">
                      {format.dateTime(batch.departedAt, { dateStyle: 'short' })}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function TodayCell({
  icon,
  label,
  value,
  warn,
  hint,
  href,
}: {
  icon: 'inbox' | 'truck' | 'check' | 'alert';
  label: string;
  value: number;
  warn?: boolean;
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <Icon name={icon} className={`h-5 w-5 ${warn ? 'text-warn' : 'text-ink-400'}`} />
      <p className={`mt-1 text-2xl font-extrabold ${warn ? 'text-warn' : ''}`}>{value}</p>
      <p className="text-xs text-ink-500">{label}</p>
      {hint && <p className="text-xs font-semibold text-warn">{hint}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="text-center">
      {body}
    </Link>
  ) : (
    <div className="text-center">{body}</div>
  );
}
