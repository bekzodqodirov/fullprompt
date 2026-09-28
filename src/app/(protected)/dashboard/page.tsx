import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isAnalyst } from '@/modules/platform/ai/tools';
import { getSetting } from '@/modules/platform/settings/service';
import { companyMoneySight, seesCompanyMoney } from '@/modules/wms/finance/scope';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { loadWarehouseOptions, loadWindows, scopeKeyOf } from '@/modules/wms/reports/dashboard';
import { dashPeriod } from '@/modules/wms/reports/dashboard-math';
import { reportBaseIds, reportScope } from '@/modules/wms/reports/report-scope';
import { attentionGates } from '@/modules/wms/reports/attention';
import { PageHeader } from '@/components/ui/page';
import { ChartTip } from '@/components/charts/chart-tip';
import { DashControls } from './sections/controls';
import { HeroTiles, ProfitHero } from './sections/hero';
import { AttentionSection } from './sections/attention';
import { AgingCard, CashWeeksCard, MoneySection } from './sections/money';
import { CargoSection, FillCard, IntakeDaysCard, TrucksCard } from './sections/cargo';
import { FunnelCard } from './sections/sales';
import { mayReadUnpricedList } from '@/modules/wms/finance/unpriced-door';

export const dynamic = 'force-dynamic';

/**
 * «Biznes holati» — the whole company on one screen, read top to bottom in
 * the order the questions are asked (owner, 2026-09-26: «bir korganda visual
 * tushunarli bolsin»): the period's profit, the four figures behind it, what
 * needs a person today, then the money and the cargo as pictures, and every
 * older block under «Batafsil». Every figure is the exported function of the
 * report its link opens, over the window the link carries (#513), and every
 * block is simply ABSENT for somebody who may not see it — never an empty
 * money card.
 *
 * Money is the owner's and the admin's alone (his answer 4a): the accountant
 * has the accounting screens, the logist and the warehouse keep the cargo
 * part. `seesCompanyMoney` carries round 91's `seesAllMoney` (audit A5): a seller's `finance.view`
 * must not open the company's receivable, and the role matrix is edited with
 * checkboxes. Every money card takes the `CompanyMoneySight` token as a
 * REQUIRED prop, so a card mounted outside this gate does not compile.
 *
 * `?davr=` picks the period (anything unknown reads as «Bu oy», #514) and
 * `?ombor=` one of the viewer's own warehouses: the cargo follows it, and the
 * money and the funnel — which have no per-warehouse figure — say «Butun
 * kompaniya» rather than pretend to.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ davr?: string; ombor?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const perms = actor.permissions;
  const allWh = perms.has('reports.all_warehouses');
  const ownWh = perms.has('reports.own_warehouse');
  if (!allWh && !ownWh) {
    redirect(perms.has('reports.own_clients') ? '/pipeline' : '/');
  }
  const params = await searchParams;
  const analyst = isAnalyst(actor);
  // The company's money: `finance.reports` + the whole-ledger reader, one
  // predicate with the admin home and the risk report — so the VED (Q19)
  // reads no kassa and no profit here either.
  const money = seesCompanyMoney(actor) && analyst;
  const sight = money ? companyMoneySight(actor) : null;
  const seesBatches = mayReadBatches(perms);
  const seesFunnel = perms.has('crm.leads');
  const seesOutcome = analyst && perms.has('crm.manage');

  const w = loadWindows();
  const period = dashPeriod(params.davr, w.today);
  // The scope rule the receipts journal asks too (one question, O10): an
  // all-warehouse grant on a warehouse-scoped role still reads its own
  // warehouses only, a scoped viewer with none reads nothing, and `ombor`
  // survives only when it is one of the viewer's own options.
  const options = await loadWarehouseOptions(scopeKeyOf(reportBaseIds(actor)));
  const scope = reportScope(actor, params.ombor, options);
  const scopeKey = scopeKeyOf(scope.ids);
  const company = scope.ombor !== null;
  const staleDays = Number(await getSetting('stale_stock_days')) || 30;
  // The trucks-with-no-cost list: company-wide count (costMissingCount takes
  // no scope), so only an unscoped all-warehouse viewer gets it, and not while
  // one warehouse is chosen. Said once, in the attention gates, so the list
  // and the row that jumps to it cannot disagree.
  const seesCostMissing = attentionGates(perms, { sight, scoped: scope.scoped, company }).seesCostMissing;
  const canPlan = analyst && perms.has('admin.settings.manage');

  const t = await getTranslations('dashboard');
  const format = await getFormatter();

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-6xl">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <PageHeader icon="chart" title={t('title')} />
        <Link href="/reports" className="ml-auto text-sm font-semibold text-brand-700">
          {t('toReports')} →
        </Link>
        <p className="w-full text-2xs text-ink-500" data-testid="dash-asof">
          {t('asOf', {
            when: format.dateTime(new Date(), {
              timeZone: 'Asia/Tashkent',
              day: 'numeric',
              month: 'numeric',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
          })}{' '}
          · {t('clickHint')}
        </p>
      </div>

      <DashControls period={period.key} ombor={scope.ombor} options={options} />

      {sight && (
        <Suspense fallback={<Skeleton className="h-72" />}>
          <ProfitHero sight={sight} period={period} company={company} canPlan={canPlan} today={w.today} />
        </Suspense>
      )}

      <Suspense fallback={<Skeleton className="h-36" />}>
        <HeroTiles
          sight={sight}
          cargo={seesBatches}
          scopeKey={scopeKey}
          period={period}
          ombor={scope.ombor}
          company={company}
          canPlan={canPlan}
          today={w.today}
        />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-28" />}>
        <AttentionSection
          sight={sight}
          scoped={scope.scoped}
          company={company}
          scopeKey={scopeKey}
          perms={perms}
          viewerId={actor.id}
        />
      </Suspense>

      <div className={`grid gap-4 ${sight ? 'lg:grid-cols-2' : ''}`}>
        {sight && (
          <Suspense fallback={<Skeleton className="h-80" />}>
            <CashWeeksCard sight={sight} company={company} />
          </Suspense>
        )}
        <Suspense fallback={<Skeleton className="h-80" />}>
          <IntakeDaysCard scopeKey={scopeKey} ombor={scope.ombor} />
        </Suspense>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Suspense fallback={<Skeleton className="h-64" />}>
          <FillCard scopeKey={scopeKey} staleDays={staleDays} canEditCapacity={perms.has('admin.warehouses.manage')} />
        </Suspense>
        {seesBatches && (
          <Suspense fallback={<Skeleton className="h-64" />}>
            <TrucksCard scopeKey={scopeKey} />
          </Suspense>
        )}
        {(seesFunnel || sight) && (
          <div className="grid content-start gap-4 lg:col-span-2 lg:grid-cols-2 xl:col-span-1 xl:grid-cols-1">
            {seesFunnel && (
              <Suspense fallback={<Skeleton className="h-64" />}>
                <FunnelCard
                  ownerId={perms.has('crm.leads.view_all') ? '' : actor.id}
                  seesOutcome={seesOutcome}
                  period={period}
                  company={company}
                />
              </Suspense>
            )}
            {sight && (
              <Suspense fallback={<Skeleton className="h-48" />}>
                <AgingCard sight={sight} company={company} />
              </Suspense>
            )}
          </div>
        )}
      </div>

      {/* «Batafsil»: every block the page had before the redesign, unchanged —
          the twelve-month charts, the Balans bridge, the trucks' profit, the
          unbilled cargo, the day's counts and the journey bar. */}
      <p className="section-title pt-2" data-testid="dash-details">
        {t('detailsTitle')}
      </p>

      {money && sight && (
        <Suspense fallback={<Skeleton className="h-96" />}>
          <MoneySection
            sight={sight}
            scopeKey={scopeKey}
            canExpenses={perms.has('finance.expenses')}
            canUnpricedList={mayReadUnpricedList(perms)}
          />
        </Suspense>
      )}

      <Suspense fallback={<Skeleton className="h-56" />}>
        <CargoSection scopeKey={scopeKey} seesBatches={seesBatches} seesCostMissing={seesCostMissing} />
      </Suspense>

      {/* ONE tooltip for every chart on the page (delegated, textContent only). */}
      <ChartTip />
    </div>
  );
}

/** A fixed-height placeholder, so a card streaming in does not shove the page. */
function Skeleton({ className }: { className: 'h-28' | 'h-36' | 'h-48' | 'h-56' | 'h-64' | 'h-72' | 'h-80' | 'h-96' }) {
  return <div aria-hidden className={`card animate-pulse bg-surface-sunken ${className}`} />;
}
