import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isAnalyst } from '@/modules/platform/ai/tools';
import { getSetting } from '@/modules/platform/settings/service';
import { seesCompanyMoney } from '@/modules/wms/finance/scope';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { scopeKeyOf } from '@/modules/wms/reports/dashboard';
import { PageHeader } from '@/components/ui/page';
import { ChartTip } from '@/components/charts/chart-tip';
import { HeroTiles } from './sections/hero';
import { AttentionSection } from './sections/attention';
import { MoneySection } from './sections/money';
import { CargoSection } from './sections/cargo';
import { SalesSection } from './sections/sales';

export const dynamic = 'force-dynamic';

/**
 * «Biznes pulti» — the whole company on one screen (owner, 2026-09-25:
 * «dashboardni profesional butun bisnessni moliyasidan tortib ahvoli visual
 * korinib turadgan qilib»), read top to bottom in the order the questions are
 * asked: six morning figures, what needs a person today, then money, cargo
 * and sales. Every figure is the exported function of the report its link
 * opens (#513), and every block is simply ABSENT for somebody who may not see
 * it — never an empty money card.
 *
 * Money is the owner's and the admin's alone (his answer 4a): the accountant
 * has the accounting screens, the logist and the warehouse keep the cargo
 * part. `seesCompanyMoney` carries round 91's `seesAllMoney` (audit A5): a seller's `finance.view`
 * must not open the company's receivable, and the role matrix is edited with
 * checkboxes.
 */
export default async function DashboardPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const perms = actor.permissions;
  const allWh = perms.has('reports.all_warehouses');
  const ownWh = perms.has('reports.own_warehouse');
  if (!allWh && !ownWh) {
    redirect(perms.has('reports.own_clients') ? '/pipeline' : '/');
  }
  const analyst = isAnalyst(actor);
  // The company's money: `finance.reports` + the whole-ledger reader, one
  // predicate with the admin home and the risk report — so the VED (Q19)
  // reads no kassa and no profit here either.
  const money = seesCompanyMoney(actor) && analyst;
  const seesBatches = mayReadBatches(perms);
  const seesFunnel = perms.has('crm.leads');
  const seesOutcome = analyst && perms.has('crm.manage');
  // The two scope rules the page's destinations use, intersected: an
  // all-warehouse grant on a warehouse-scoped role still reads its own
  // warehouses only, and a scoped viewer with none reads nothing.
  const scoped = !allWh || actor.warehouseScoped;
  const scopeKey = scopeKeyOf(scoped ? actor.warehouseIds : undefined);
  const staleDays = Number(await getSetting('stale_stock_days')) || 30;
  // The trucks-with-no-cost list: company-wide count (costMissingCount takes
  // no scope), so only an unscoped all-warehouse viewer gets it.
  const seesCostMissing = allWh && !scoped && seesBatches;

  const t = await getTranslations('dashboard');
  const format = await getFormatter();

  return (
    <div className="mx-auto max-w-lg space-y-5 md:max-w-6xl">
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
          })}
        </p>
      </div>

      <Suspense fallback={<Skeleton rows={2} />}>
        <HeroTiles
          money={money}
          sales={seesOutcome}
          cargo={seesBatches}
          scopeKey={scopeKey}
          canPlan={analyst && perms.has('admin.settings.manage')}
        />
      </Suspense>

      <Suspense fallback={<Skeleton rows={1} />}>
        <AttentionSection
          money={money}
          cargo={seesBatches}
          scopeKey={scopeKey}
          perms={perms}
          seesCostMissing={seesCostMissing}
        />
      </Suspense>

      {money && (
        <Suspense fallback={<Skeleton rows={3} />}>
          <MoneySection
            scopeKey={scopeKey}
            canExpenses={perms.has('finance.expenses')}
            canUnpricedList={perms.has('finance.view') || perms.has('finance.manage')}
          />
        </Suspense>
      )}

      <Suspense fallback={<Skeleton rows={2} />}>
        <CargoSection
          scopeKey={scopeKey}
          staleDays={staleDays}
          seesBatches={seesBatches}
          seesCostMissing={seesCostMissing}
          canEditCapacity={perms.has('admin.warehouses.manage')}
        />
      </Suspense>

      {seesFunnel && (
        <Suspense fallback={<Skeleton rows={1} />}>
          <SalesSection
            ownerId={perms.has('crm.leads.view_all') ? '' : actor.id}
            seesOutcome={seesOutcome}
          />
        </Suspense>
      )}

      {/* ONE tooltip for every chart on the page (delegated, textContent only). */}
      <ChartTip />
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card h-28 animate-pulse bg-surface-sunken" />
      ))}
    </div>
  );
}
